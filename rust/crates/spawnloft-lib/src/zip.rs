//! Zip archives: `zip.mjs` (the writer, the strict reader and the extraction that world imports
//! and exports use) and the three readers `plugins.mjs` keeps for jars (`readZipEntry`,
//! `zipEntryList` and `extractZip` with `mapPath`), in one module.
//!
//! The two readers are not merged into one behaviour, because they do not behave alike in Node:
//! - the strict one ([`entries`], [`extract`]) looks for the end record whose comment runs to the
//!   end of the file, reads zip64, decodes names by the UTF-8 flag (CP437 otherwise, unless the
//!   bytes are valid UTF-8), and fails with a sentence on anything damaged;
//! - the jar one ([`jar`]) takes the first end record from the back, declines zip64, reads names
//!   as UTF-8 always, and stops quietly at the first damaged record.
//!
//! Every failure is the text Node gives, down to the `RangeError` a damaged extra field makes
//! `Buffer.readUInt16LE` throw. Two declared differences (rust/PLAN-CORE-PORT.md 6.1): the
//! compressed bytes [`create`] writes are miniz_oxide's, not zlib's (the same entries, names,
//! times and contents; the archive is not byte-identical), and a jar entry whose compressed data
//! is damaged in the middle fails as `invalid compressed data` rather than in zlib's words for
//! that kind of damage (data cut short is zlib's `unexpected end of file` on both).

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use flate2::{Compression, Crc, Decompress, FlushDecompress, Status};

use crate::failure::Failure;
use crate::jspath;

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const EOCD64_SIG: u32 = 0x0606_4b50;
const LOCATOR64_SIG: u32 = 0x0706_4b50;
const MAX32: u64 = 0xffff_ffff;
const MAX16: u64 = 0xffff;
const UTF8_NAMES: u16 = 0x0800;
/// deflate can grow incompressible data, so files this close to 4 GiB reserve zip64 fields up front
const NEAR_4G: u64 = 0xffff_0000;
/// `Number.MAX_SAFE_INTEGER`: a file position past it is refused by `fs.readSync`
const MAX_SAFE: u64 = (1 << 53) - 1;
const CHUNK: usize = 64 * 1024;

/// The upper half of code page 437, the default zip name encoding.
const CP437: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ', 'Æ', 'ô', 'ö',
    'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐',
    '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛',
    '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙',
    '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ',
    'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²',
    '■', '\u{a0}',
];

/// `decodeName`: without the UTF-8 flag the format means CP437, but macOS writes UTF-8 and leaves
/// the flag off, so unflagged bytes that are valid UTF-8 are read as UTF-8 (437 text with accents
/// never is), the rest as 437. Valid unflagged UTF-8 loses a leading byte-order mark, as Node's
/// `TextDecoder` drops it; flagged bytes are read as `Buffer.toString('utf8')` reads them.
pub fn decode_name(bytes: &[u8], flags: u16) -> String {
    if flags & UTF8_NAMES == 0 {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return s.strip_prefix('\u{feff}').unwrap_or(s).to_string();
        }
        return bytes
            .iter()
            .map(|&b| {
                if b < 0x80 {
                    b as char
                } else {
                    CP437[usize::from(b - 0x80)]
                }
            })
            .collect();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn fail(message: impl Into<String>) -> Failure {
    Failure::user(message)
}

/// `ERR_OUT_OF_RANGE`'s rendering of a number: an integer past 2^32 gets `_` every three digits.
fn received(n: u64) -> String {
    let text = if n > MAX_SAFE {
        crate::js::number_to_string(n as f64)
    } else {
        n.to_string()
    };
    if n <= 1 << 32 {
        return text;
    }
    let mut i = text.len();
    let mut res = String::new();
    while i >= 4 {
        res = format!("_{}{res}", &text[i - 3..i]);
        i -= 3;
    }
    format!("{}{res}", &text[..i])
}

fn out_of_range(what: &str, range: &str, value: u64) -> Failure {
    Failure::Internal {
        head: "RangeError [ERR_OUT_OF_RANGE]".into(),
        message: format!(
            "The value of \"{what}\" is out of range. It must be {range}. Received {}",
            received(value)
        ),
        code: Some("ERR_OUT_OF_RANGE".into()),
    }
}

/// `buf.readUInt16LE(o)`, with the `RangeError` Node throws past the end.
fn rd16(b: &[u8], o: usize) -> Result<u16, Failure> {
    match b.get(o..o + 2) {
        Some(s) => Ok(u16::from_le_bytes([s[0], s[1]])),
        None => Err(bounds(b.len(), 2, o)),
    }
}

fn rd64(b: &[u8], o: usize) -> Result<u64, Failure> {
    match b.get(o..o + 8) {
        Some(s) => Ok(u64::from_le_bytes(s.try_into().unwrap_or([0; 8]))),
        None => Err(bounds(b.len(), 8, o)),
    }
}

fn bounds(len: usize, width: usize, at: usize) -> Failure {
    if len < width {
        return Failure::Internal {
            head: "RangeError [ERR_BUFFER_OUT_OF_BOUNDS]".into(),
            message: "Attempt to access memory outside buffer bounds".into(),
            code: Some("ERR_BUFFER_OUT_OF_BOUNDS".into()),
        };
    }
    out_of_range("offset", &format!(">= 0 and <= {}", len - width), at as u64)
}

/// Little-endian reads of fields that are known to be inside the buffer.
fn le16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn le32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

/// What an archive is read from: a file, or bytes in memory (the fuzz targets and tests).
pub trait Source {
    fn size(&mut self) -> io::Result<u64>;
    /// One read at `pos`, as `fs.readSync` does it: fewer bytes than asked at the end, 0 past it.
    fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize>;
}

impl Source for File {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }
    fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        self.seek(SeekFrom::Start(pos))?;
        loop {
            match self.read(buf) {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                r => return r,
            }
        }
    }
}

impl Source for &[u8] {
    fn size(&mut self) -> io::Result<u64> {
        Ok(self.len() as u64)
    }
    fn read_at(&mut self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        let Ok(start) = usize::try_from(pos) else {
            return Ok(0);
        };
        let Some(rest) = self.get(start..) else {
            return Ok(0);
        };
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        Ok(n)
    }
}

fn read_failed(e: &io::Error) -> Failure {
    Failure::io(e, "read", None)
}

fn check_position(pos: u64) -> Result<(), Failure> {
    if pos > MAX_SAFE {
        return Err(out_of_range("position", ">= -1 && <= 9007199254740991", pos));
    }
    Ok(())
}

/// `readAt`: exactly `length` bytes at `position`, or the sentence for an archive cut short.
fn read_exact_at<S: Source + ?Sized>(src: &mut S, length: u64, position: u64) -> Result<Vec<u8>, Failure> {
    check_position(position)?;
    let length = usize::try_from(length).map_err(|_| fail(CUT_SHORT))?;
    let mut buf = vec![0u8; length];
    let mut done = 0;
    while done < length {
        check_position(position + done as u64)?;
        let got = src
            .read_at(&mut buf[done..], position + done as u64)
            .map_err(|e| read_failed(&e))?;
        if got == 0 {
            return Err(fail(CUT_SHORT));
        }
        done += got;
    }
    Ok(buf)
}

const CUT_SHORT: &str = "the zip ends before its own index says it should; the file is cut short or damaged";

/// One read that may come back short, the rest left zero (`fs.readSync` into `Buffer.alloc`).
fn read_once_at<S: Source + ?Sized>(src: &mut S, length: usize, position: u64) -> Result<Vec<u8>, Failure> {
    let mut buf = vec![0u8; length];
    let mut done = 0;
    // a file can hand back less than asked in one call without being at its end; Node's one
    // readSync of a regular file reads up to the end, so this reads until then
    while done < length {
        let got = src
            .read_at(&mut buf[done..], position + done as u64)
            .map_err(|e| read_failed(&e))?;
        if got == 0 {
            break;
        }
        done += got;
    }
    Ok(buf)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Directory {
    entries: u64,
    size: u64,
    offset: u64,
}

/// `findDirectory`.
fn find_directory<S: Source + ?Sized>(src: &mut S, size: u64) -> Result<Directory, Failure> {
    if size < 22 {
        return Err(fail("that file is too small to be a zip"));
    }
    // the end record is at the end, behind a comment of at most 64 KiB
    let tail_size = size.min(22 + MAX16);
    let tail = read_exact_at(src, tail_size, size - tail_size)?;
    let tail_len = tail.len();
    // The signature bytes can appear inside a zip's comment, and scanning backwards meets those
    // first. A real record has a comment running exactly to end of file and sits directly after
    // the directory it describes (or the zip64 locator); one that passes only the first test is
    // kept as a fallback for archives with data prepended.
    let mut fallback = None;
    for i in (0..=tail_len - 22).rev() {
        if le32(&tail, i) != EOCD_SIG {
            continue;
        }
        if i + 22 + usize::from(le16(&tail, i + 20)) != tail_len {
            continue;
        }
        let at = size - tail_size + i as u64;
        let found = Directory {
            entries: u64::from(le16(&tail, i + 10)),
            size: u64::from(le32(&tail, i + 12)),
            offset: u64::from(le32(&tail, i + 16)),
        };
        let wide = found.entries == MAX16 || found.size == MAX32 || found.offset == MAX32;
        if wide {
            if at < 20 {
                continue;
            }
            let locator = read_exact_at(src, 20, at - 20)?;
            if le32(&locator, 0) != LOCATOR64_SIG {
                continue;
            }
            let end64 = read_exact_at(src, 56, rd64(&locator, 8)?)?;
            if le32(&end64, 0) != EOCD64_SIG {
                return Err(fail("the zip64 index of that archive is damaged"));
            }
            return Ok(Directory {
                entries: rd64(&end64, 32)?,
                size: rd64(&end64, 40)?,
                offset: rd64(&end64, 48)?,
            });
        }
        if found.offset + found.size == at {
            return Ok(found);
        }
        fallback.get_or_insert(found);
    }
    fallback.ok_or_else(|| fail("that file is not a zip archive"))
}

/// One record of the central directory, as the strict reader sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The system that made it (the high byte of "version made by"; 3 is Unix).
    pub made_by: u16,
    pub flags: u16,
    pub method: u16,
    pub crc: u32,
    pub packed: u64,
    pub size: u64,
    pub attributes: u32,
    pub offset: u64,
    pub name: String,
}

/// `zipEntries`: the records of the archive, read one at a time, so that a damaged record fails
/// only once the ones before it have been handed out.
#[derive(Debug)]
pub struct Entries {
    cd: Vec<u8>,
    at: usize,
    left: u64,
    failed: bool,
}

/// Opens the index of the archive in `src`.
pub fn entries<S: Source + ?Sized>(src: &mut S) -> Result<Entries, Failure> {
    let size = src.size().map_err(|e| Failure::io(&e, "fstat", None))?;
    let directory = find_directory(src, size)?;
    if directory.offset.saturating_add(directory.size) > size {
        return Err(fail(
            "the zip index points past the end of the file; the archive is cut short",
        ));
    }
    let cd = read_exact_at(src, directory.size, directory.offset)?;
    Ok(Entries {
        cd,
        at: 0,
        left: directory.entries,
        failed: false,
    })
}

impl Entries {
    fn next_entry(&mut self) -> Result<Entry, Failure> {
        let cd = &self.cd;
        let at = self.at;
        if at + 46 > cd.len() || le32(cd, at) != CENTRAL_SIG {
            return Err(fail("the zip index is damaged"));
        }
        let name_length = usize::from(le16(cd, at + 28));
        let extra_length = usize::from(le16(cd, at + 30));
        let flags = le16(cd, at + 8);
        let mut entry = Entry {
            made_by: le16(cd, at + 4) >> 8,
            flags,
            method: le16(cd, at + 10),
            crc: le32(cd, at + 16),
            packed: u64::from(le32(cd, at + 20)),
            size: u64::from(le32(cd, at + 24)),
            attributes: le32(cd, at + 38),
            offset: u64::from(le32(cd, at + 42)),
            name: String::new(),
        };
        let name_end = (at + 46 + name_length).min(cd.len());
        entry.name = decode_name(&cd[at + 46..name_end], flags);
        // the zip64 field holds only the values that overflowed, in this fixed order
        let mut p = at + 46 + name_length;
        let extra_end = p + extra_length;
        while p + 4 <= extra_end {
            let id = rd16(cd, p)?;
            let length = usize::from(rd16(cd, p + 2)?);
            if id == 0x0001 {
                let mut q = p + 4;
                for field in [&mut entry.size, &mut entry.packed, &mut entry.offset] {
                    if *field == MAX32 && q + 8 <= p + 4 + length {
                        *field = rd64(cd, q)?;
                        q += 8;
                    }
                }
            }
            p += 4 + length;
        }
        self.at = extra_end + usize::from(le16(cd, at + 32));
        Ok(entry)
    }
}

impl Iterator for Entries {
    type Item = Result<Entry, Failure>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.left == 0 {
            return None;
        }
        self.left -= 1;
        let r = self.next_entry();
        self.failed = r.is_err();
        Some(r)
    }
}

/// `isZip`: checks the bytes, not the extension.
pub fn is_zip(file: &Path) -> Result<bool, Failure> {
    let mut f = File::open(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    let mut head = [0u8; 4];
    let got = f.read_at(&mut head, 0).map_err(|e| read_failed(&e))?;
    if got < 4 {
        return Ok(false);
    }
    // a zip with entries starts with a local header; an empty one is only its end record
    let sig = le32(&head, 0);
    Ok(sig == LOCAL_SIG || sig == EOCD_SIG)
}

fn sep() -> &'static str {
    if cfg!(windows) { "\\" } else { "/" }
}

/// `path.resolve(base, p)` for an absolute `base`: `p` itself when it is absolute, else `p` under
/// `base` (on Windows a rooted `\x` takes `base`'s drive, and a drive-relative `D:x` on `base`'s
/// drive goes under `base`).
pub fn resolve_from(base: &str, p: &str) -> String {
    if cfg!(windows) {
        let b = p.as_bytes();
        let drive_relative =
            b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() && !jspath::is_absolute(p);
        if drive_relative {
            if base.get(..2).is_some_and(|d| d.eq_ignore_ascii_case(&p[..2])) {
                return jspath::resolve(&format!("{base}\\{}", &p[2..]));
            }
            return jspath::resolve(p);
        }
        if matches!(b.first(), Some(b'/' | b'\\')) && !matches!(b.get(1), Some(b'/' | b'\\')) {
            let drive = base.get(..2).unwrap_or("");
            return jspath::resolve(&format!("{drive}{p}"));
        }
    }
    if jspath::is_absolute(p) {
        return jspath::resolve(p);
    }
    jspath::resolve(&format!("{base}{}{p}", sep()))
}

fn inside(target: &str, root: &str) -> bool {
    target == root || target.starts_with(&format!("{root}{}", sep()))
}

fn outside(name: &str) -> Failure {
    fail(format!(
        "the archive tried to write outside its folder (\"{name}\"); nothing more was extracted"
    ))
}

/// A file that could not be opened for writing, as Node words it: Windows refuses a folder as
/// access denied, where libuv says EISDIR.
fn create_failed(e: &io::Error, target: &Path) -> Failure {
    if cfg!(windows) && target.is_dir() {
        return Failure::Internal {
            head: "Error".into(),
            message: format!(
                "EISDIR: illegal operation on a directory, open '{}'",
                target.display()
            ),
            code: Some("EISDIR".into()),
        };
    }
    Failure::io(e, "open", Some(target))
}

fn write_failed(e: &io::Error) -> Failure {
    Failure::io(e, "write", None)
}

/// Where a stream of entry data stopped: whole, or compressed data that does not inflate.
enum Copied {
    Done { crc: u32, written: u64 },
    Damaged,
}

/// The entry's bytes from `data_at`, inflated when `method` is 8, into `out`.
fn copy_entry<S: Source + ?Sized, W: Write>(
    src: &mut S,
    data_at: u64,
    packed: u64,
    method: u16,
    out: &mut W,
) -> Result<Copied, Failure> {
    let mut crc = Crc::new();
    let mut written = 0u64;
    let mut inflater = Decompress::new(false);
    let mut input = vec![0u8; CHUNK];
    let mut output = vec![0u8; CHUNK];
    let mut at = data_at;
    let end = data_at + packed;
    let mut ended = false;
    while at < end && !ended {
        let want = usize::try_from((end - at).min(CHUNK as u64)).unwrap_or(CHUNK);
        check_position(at)?;
        let got = src.read_at(&mut input[..want], at).map_err(|e| read_failed(&e))?;
        if got == 0 {
            return Err(fail(CUT_SHORT));
        }
        at += got as u64;
        let chunk = &input[..got];
        if method == 0 {
            crc.update(chunk);
            written += got as u64;
            out.write_all(chunk).map_err(|e| write_failed(&e))?;
            continue;
        }
        let mut used = 0;
        loop {
            let before_in = inflater.total_in();
            let before_out = inflater.total_out();
            let status = inflater.decompress(&chunk[used..], &mut output, FlushDecompress::None);
            let took = (inflater.total_in() - before_in) as usize;
            let made = (inflater.total_out() - before_out) as usize;
            used += took;
            if made > 0 {
                crc.update(&output[..made]);
                written += made as u64;
                out.write_all(&output[..made]).map_err(|e| write_failed(&e))?;
            }
            match status {
                Err(_) => return Ok(Copied::Damaged),
                Ok(Status::StreamEnd) => {
                    // what follows the end of the deflate stream is not read, as zlib stops there
                    ended = true;
                    break;
                }
                Ok(_) if took == 0 && made == 0 => {
                    if used < chunk.len() {
                        // input left and room to write, yet nothing moved
                        return Ok(Copied::Damaged);
                    }
                    break;
                }
                Ok(_) => {}
            }
        }
    }
    if method == 8 && !ended {
        // the data ran out before the deflate stream ended (zlib's "unexpected end of file")
        return Ok(Copied::Damaged);
    }
    Ok(Copied::Done {
        crc: crc.sum(),
        written,
    })
}

/// `extractZip(file, dest)`: every name is confined to `dest` before anything is written (a
/// `../` or a drive letter would otherwise write anywhere), links are not recreated, and checksums
/// are verified as files are written, so a damaged download fails here. The number of files
/// written.
pub fn extract(file: &Path, dest: &Path) -> Result<u64, Failure> {
    let root = jspath::resolve(&dest.to_string_lossy());
    let mut src = File::open(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    let size = src.size().map_err(|e| Failure::io(&e, "fstat", None))?;
    let mut files = 0;
    for entry in entries(&mut src)? {
        let entry = entry?;
        // some Windows tools write backslashes, which the format forbids
        let name = entry.name.replace('\\', "/");
        let b = name.as_bytes();
        let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        if name.is_empty() || name.starts_with('/') || drive || name.split('/').any(|s| s == "..") {
            return Err(outside(&entry.name));
        }
        let target = resolve_from(&root, &name);
        if !inside(&target, &root) {
            return Err(outside(&entry.name));
        }
        if entry.flags & 1 != 0 {
            return Err(fail(format!(
                "\"{}\" is encrypted; password-protected zips cannot be imported",
                entry.name
            )));
        }
        let target = PathBuf::from(target);
        if name.ends_with('/') {
            crate::fsx::mkdir_all(&target)?;
            continue;
        }
        if entry.made_by == 3 && (entry.attributes >> 16) & 0o170000 == 0o120000 {
            continue;
        }
        if entry.method != 0 && entry.method != 8 {
            return Err(fail(format!(
                "\"{}\" uses a compression this cannot read (method {})",
                entry.name, entry.method
            )));
        }
        let local = read_exact_at(&mut src, 30, entry.offset)?;
        if le32(&local, 0) != LOCAL_SIG {
            return Err(fail(format!(
                "\"{}\" is not where the zip index says it is; the archive is damaged",
                entry.name
            )));
        }
        // the local extra field can differ in length from the central one, so read it
        let data_at = entry.offset + 30 + u64::from(le16(&local, 26)) + u64::from(le16(&local, 28));
        if u128::from(data_at) + u128::from(entry.packed) > u128::from(size) {
            return Err(fail(format!(
                "\"{}\" runs past the end of the file; the archive is cut short",
                entry.name
            )));
        }
        if let Some(parent) = target.parent() {
            crate::fsx::mkdir_all(parent)?;
        }
        let mut out = File::create(&target).map_err(|e| create_failed(&e, &target))?;
        let copied = if entry.packed == 0 {
            Copied::Done { crc: 0, written: 0 }
        } else {
            let mut buffered = io::BufWriter::with_capacity(CHUNK, &mut out);
            let copied = copy_entry(&mut src, data_at, entry.packed, entry.method, &mut buffered)?;
            buffered.flush().map_err(|e| write_failed(&e))?;
            copied
        };
        drop(out);
        let whole =
            matches!(copied, Copied::Done { crc, written } if crc == entry.crc && written == entry.size);
        if !whole {
            let _ = std::fs::remove_file(&target);
            return Err(fail(format!(
                "\"{}\" did not match its checksum; the archive is damaged and nothing more was extracted",
                entry.name
            )));
        }
        files += 1;
    }
    Ok(files)
}

/// What [`create`] wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Made {
    pub entries: usize,
    pub bytes: u64,
}

/// `path.basename(p)`.
fn basename(p: &str) -> &str {
    let is_sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let trimmed = p.trim_end_matches(is_sep);
    match trimmed.rfind(is_sep) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

/// `a < b` as JavaScript's default sort compares strings: by UTF-16 code units.
fn utf16_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

struct Walked {
    rel: String,
    dir: bool,
    size: u64,
    mtime_ms: f64,
    mode: u32,
}

/// `stat.mode` as Node reports it: the system's on Unix; on Windows libuv's 0o666 (0o444 when
/// read-only) with the type bits.
fn node_mode(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(not(unix))]
    {
        let kind = if meta.is_dir() { 0o040000 } else { 0o100000 };
        kind | if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let Ok(t) = meta.modified() else {
        return 0.0;
    };
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => (d.as_secs_f64() * 1000.0).trunc(),
        Err(e) => -(e.duration().as_secs_f64() * 1000.0).trunc(),
    }
}

/// `walk`: directories before their contents, in a stable order; links, sockets and devices are
/// skipped (a link could point outside the world).
fn walk(
    cwd: &str,
    members: &[&str],
    excluded: &[&str],
    mut each: impl FnMut(Walked) -> Result<(), Failure>,
) -> Result<(), Failure> {
    for member in members {
        let mut stack = vec![member.to_string()];
        while let Some(rel) = stack.pop() {
            if excluded.contains(&basename(&rel)) {
                continue;
            }
            let full = jspath::join(&[cwd, &rel]);
            let meta = std::fs::symlink_metadata(&full)
                .map_err(|e| Failure::io(&e, "lstat", Some(Path::new(&full))))?;
            let kind = meta.file_type();
            if kind.is_dir() {
                each(Walked {
                    rel: rel.clone(),
                    dir: true,
                    size: 0,
                    mtime_ms: mtime_ms(&meta),
                    mode: node_mode(&meta),
                })?;
                let scandir = |e: &io::Error| Failure::io(e, "scandir", Some(Path::new(&full)));
                let mut names = Vec::new();
                for item in std::fs::read_dir(&full).map_err(|e| scandir(&e))? {
                    let item = item.map_err(|e| scandir(&e))?;
                    names.push(item.file_name().to_string_lossy().into_owned());
                }
                names.sort_by(|a, b| utf16_order(a, b));
                for name in names.iter().rev() {
                    stack.push(jspath::join(&[&rel, name]));
                }
            } else if kind.is_file() {
                each(Walked {
                    rel,
                    dir: false,
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                    mode: node_mode(&meta),
                })?;
            }
        }
    }
    Ok(())
}

/// `dosTime`: the format has no year before 1980 and no time zone; unzip assumes local time.
fn dos_time(ms: f64) -> (u16, u16) {
    let Some(f) = crate::jsdate::local_fields(ms) else {
        return (0, 0);
    };
    let year = f.year.clamp(1980, 2107) as u32;
    let time = (f.hour << 11) | (f.minute << 5) | (f.second >> 1);
    let date = ((year - 1980) << 9) | (f.month << 5) | f.day;
    (time as u16, date as u16)
}

/// The zip being written: buffered, with patches written in place.
struct Out {
    file: File,
    buf: Vec<u8>,
    at: u64,
}

impl Out {
    fn flush_buf(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            self.file.write_all(&self.buf)?;
            self.buf.clear();
        }
        Ok(())
    }
    fn put(&mut self, data: &[u8]) -> Result<(), Failure> {
        self.buf.extend_from_slice(data);
        self.at += data.len() as u64;
        if self.buf.len() >= 1 << 20 {
            self.flush_buf().map_err(|e| write_failed(&e))?;
        }
        Ok(())
    }
    fn patch(&mut self, data: &[u8], position: u64) -> Result<(), Failure> {
        let mut run = || -> io::Result<()> {
            self.flush_buf()?;
            self.file.seek(SeekFrom::Start(position))?;
            self.file.write_all(data)?;
            self.file.seek(SeekFrom::Start(self.at))?;
            Ok(())
        };
        run().map_err(|e| write_failed(&e))
    }
}

/// The compressed side of one entry: counts what it is handed and passes it to the zip.
struct Packed<'a> {
    out: &'a mut Out,
    packed: u64,
    error: Option<Failure>,
}

impl Write for Packed<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if let Err(f) = self.out.put(data) {
            self.error = Some(f);
            return Err(io::Error::other("write failed"));
        }
        self.packed += data.len() as u64;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Written {
    name: Vec<u8>,
    dir: bool,
    wide: bool,
    time: u16,
    date: u16,
    mode: u32,
    offset: u64,
    crc: u32,
    size: u64,
    packed: u64,
    method: u16,
}

/// `createZip(file, cwd, members, { exclude, forceZip64 })`: writes `members` (relative to `cwd`)
/// into a new zip. Each local header is patched after its data is written, which avoids trailing
/// data descriptors that readers disagree about; zip64 is written only when a size or offset
/// needs it (or `force_zip64`, for tests), so small exports stay readable by old unzip tools.
/// `exclude`: basenames to skip anywhere.
pub fn create(
    file: &Path,
    cwd: &str,
    members: &[&str],
    exclude: &[&str],
    force_zip64: bool,
) -> Result<Made, Failure> {
    let handle = File::create(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    let mut out = Out {
        file: handle,
        buf: Vec::with_capacity(1 << 20),
        at: 0,
    };
    let mut entries: Vec<Written> = Vec::new();
    walk(cwd, members, exclude, |w| {
        let sep = if cfg!(windows) { '\\' } else { '/' };
        let mut text: String = w.rel.split(sep).collect::<Vec<_>>().join("/");
        if w.dir {
            text.push('/');
        }
        let name = text.into_bytes();
        if name.len() as u64 > MAX16 {
            return Err(fail(format!("\"{}\" has a path too long to put in a zip", w.rel)));
        }
        let wide = force_zip64 || (!w.dir && w.size >= NEAR_4G);
        let (time, date) = dos_time(w.mtime_ms);
        let mut entry = Written {
            name,
            dir: w.dir,
            wide,
            time,
            date,
            mode: w.mode,
            offset: out.at,
            crc: 0,
            size: 0,
            packed: 0,
            method: if w.dir || w.size == 0 { 0 } else { 8 },
        };
        let n = entry.name.len();
        let mut header = vec![0u8; 30 + n + if wide { 20 } else { 0 }];
        header[0..4].copy_from_slice(&LOCAL_SIG.to_le_bytes());
        header[4..6].copy_from_slice(&(if wide { 45u16 } else { 20 }).to_le_bytes());
        header[6..8].copy_from_slice(&UTF8_NAMES.to_le_bytes());
        header[8..10].copy_from_slice(&entry.method.to_le_bytes());
        header[10..12].copy_from_slice(&time.to_le_bytes());
        header[12..14].copy_from_slice(&date.to_le_bytes());
        header[26..28].copy_from_slice(&(n as u16).to_le_bytes());
        header[28..30].copy_from_slice(&(if wide { 20u16 } else { 0 }).to_le_bytes());
        header[30..30 + n].copy_from_slice(&entry.name);
        if wide {
            header[30 + n..32 + n].copy_from_slice(&1u16.to_le_bytes());
            header[32 + n..34 + n].copy_from_slice(&16u16.to_le_bytes());
        }
        out.put(&header)?;

        if !w.dir && w.size > 0 {
            let path = jspath::join(&[cwd, &w.rel]);
            let mut source =
                File::open(&path).map_err(|e| Failure::io(&e, "open", Some(Path::new(&path))))?;
            let mut crc = Crc::new();
            let mut size = 0u64;
            let mut encoder = flate2::write::DeflateEncoder::new(
                Packed {
                    out: &mut out,
                    packed: 0,
                    error: None,
                },
                Compression::new(6),
            );
            let mut chunk = vec![0u8; CHUNK];
            let sink_error = |encoder: &mut flate2::write::DeflateEncoder<Packed>, e: &io::Error| {
                encoder.get_mut().error.take().unwrap_or_else(|| write_failed(e))
            };
            loop {
                let got = match source.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(got) => got,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(read_failed(&e)),
                };
                crc.update(&chunk[..got]);
                size += got as u64;
                if let Err(e) = encoder.write_all(&chunk[..got]) {
                    return Err(sink_error(&mut encoder, &e));
                }
            }
            if let Err(e) = encoder.try_finish() {
                return Err(sink_error(&mut encoder, &e));
            }
            let packed = encoder.get_ref().packed;
            drop(encoder);
            entry.crc = crc.sum();
            entry.size = size;
            entry.packed = packed;
            if !wide && (entry.size > MAX32 || entry.packed > MAX32) {
                return Err(fail(format!(
                    "\"{}\" grew past four gigabytes while it was being read; stop whatever is writing it and try again",
                    w.rel
                )));
            }
        }
        // sizes are what was actually written: a file emptied between stat and read is still
        // declared deflated, and deflate of nothing is two bytes
        header[14..18].copy_from_slice(&entry.crc.to_le_bytes());
        header[18..22].copy_from_slice(&(if wide { MAX32 } else { entry.packed } as u32).to_le_bytes());
        header[22..26].copy_from_slice(&(if wide { MAX32 } else { entry.size } as u32).to_le_bytes());
        if wide {
            header[34 + n..42 + n].copy_from_slice(&entry.size.to_le_bytes());
            header[42 + n..50 + n].copy_from_slice(&entry.packed.to_le_bytes());
        }
        out.patch(&header, entry.offset)?;
        entries.push(entry);
        Ok(())
    })?;

    let directory_at = out.at;
    for entry in &entries {
        let far_offset = force_zip64 || entry.offset >= MAX32;
        let mut extra: Vec<u64> = Vec::new();
        if entry.wide {
            extra.extend([entry.size, entry.packed]);
        }
        if far_offset {
            extra.push(entry.offset);
        }
        let n = entry.name.len();
        let extra_len = if extra.is_empty() { 0 } else { 4 + extra.len() * 8 };
        let mut record = vec![0u8; 46 + n + extra_len];
        record[0..4].copy_from_slice(&CENTRAL_SIG.to_le_bytes());
        // made by Unix (3), so the mode in the external attributes is honoured
        record[4..6].copy_from_slice(&((3u16 << 8) | 45).to_le_bytes());
        record[6..8].copy_from_slice(&(if extra.is_empty() { 20u16 } else { 45 }).to_le_bytes());
        record[8..10].copy_from_slice(&UTF8_NAMES.to_le_bytes());
        record[10..12].copy_from_slice(&entry.method.to_le_bytes());
        record[12..14].copy_from_slice(&entry.time.to_le_bytes());
        record[14..16].copy_from_slice(&entry.date.to_le_bytes());
        record[16..20].copy_from_slice(&entry.crc.to_le_bytes());
        record[20..24].copy_from_slice(&(if entry.wide { MAX32 } else { entry.packed } as u32).to_le_bytes());
        record[24..28].copy_from_slice(&(if entry.wide { MAX32 } else { entry.size } as u32).to_le_bytes());
        record[28..30].copy_from_slice(&(n as u16).to_le_bytes());
        record[30..32].copy_from_slice(&(extra_len as u16).to_le_bytes());
        let attributes = ((entry.mode & 0xffff) << 16) | if entry.dir { 0x10 } else { 0 };
        record[38..42].copy_from_slice(&attributes.to_le_bytes());
        record[42..46].copy_from_slice(&(if far_offset { MAX32 } else { entry.offset } as u32).to_le_bytes());
        record[46..46 + n].copy_from_slice(&entry.name);
        if !extra.is_empty() {
            let mut p = 46 + n;
            record[p..p + 2].copy_from_slice(&1u16.to_le_bytes());
            record[p + 2..p + 4].copy_from_slice(&((extra.len() * 8) as u16).to_le_bytes());
            for value in extra {
                record[p + 4..p + 12].copy_from_slice(&value.to_le_bytes());
                p += 8;
            }
        }
        out.put(&record)?;
    }
    let directory_size = out.at - directory_at;

    let count = entries.len() as u64;
    let wide_end = force_zip64 || count >= MAX16 || directory_size >= MAX32 || directory_at >= MAX32;
    if wide_end {
        let mut end64 = vec![0u8; 56 + 20];
        end64[0..4].copy_from_slice(&EOCD64_SIG.to_le_bytes());
        end64[4..12].copy_from_slice(&44u64.to_le_bytes());
        end64[12..14].copy_from_slice(&((3u16 << 8) | 45).to_le_bytes());
        end64[14..16].copy_from_slice(&45u16.to_le_bytes());
        end64[24..32].copy_from_slice(&count.to_le_bytes());
        end64[32..40].copy_from_slice(&count.to_le_bytes());
        end64[40..48].copy_from_slice(&directory_size.to_le_bytes());
        end64[48..56].copy_from_slice(&directory_at.to_le_bytes());
        end64[56..60].copy_from_slice(&LOCATOR64_SIG.to_le_bytes());
        end64[60..64].copy_from_slice(&0u32.to_le_bytes());
        end64[64..72].copy_from_slice(&out.at.to_le_bytes());
        end64[72..76].copy_from_slice(&1u32.to_le_bytes());
        out.put(&end64)?;
    }
    let mut end = vec![0u8; 22];
    end[0..4].copy_from_slice(&EOCD_SIG.to_le_bytes());
    let short_count = if wide_end { MAX16 } else { count } as u16;
    end[8..10].copy_from_slice(&short_count.to_le_bytes());
    end[10..12].copy_from_slice(&short_count.to_le_bytes());
    end[12..16].copy_from_slice(&(if wide_end { MAX32 } else { directory_size } as u32).to_le_bytes());
    end[16..20].copy_from_slice(&(if wide_end { MAX32 } else { directory_at } as u32).to_le_bytes());
    out.put(&end)?;
    out.flush_buf().map_err(|e| write_failed(&e))?;
    out.file.sync_all().map_err(|e| Failure::io(&e, "fsync", None))?;
    Ok(Made {
        entries: entries.len(),
        bytes: out.at,
    })
}

/// The jar readers of `plugins.mjs`: manifests read straight out of a jar, reading only the
/// central directory and the one entry wanted. Laxer than the strict reader, as Node's are: the
/// first end record from the back is taken, zip64 archives are declined (no entries), names are
/// UTF-8 whatever the flag says, and a damaged record ends the list without a word.
pub mod jar {
    use super::*;

    /// One record as `plugins.mjs` reads it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct JarEntry {
        pub name: String,
        pub method: u16,
        pub compressed: u32,
        pub size: u32,
        pub local_offset: u32,
    }

    /// `zipEntries` of `plugins.mjs`.
    pub fn entries<S: Source + ?Sized>(src: &mut S) -> Result<Vec<JarEntry>, Failure> {
        let size = src.size().map_err(|e| Failure::io(&e, "fstat", None))?;
        // the end record is at the end of the file, behind an optional comment of up to 64 KiB
        let tail_size = size.min(22 + MAX16) as usize;
        let tail = read_once_at(src, tail_size, size - tail_size as u64)?;
        let mut eocd = None;
        if tail_size >= 22 {
            for i in (0..=tail_size - 22).rev() {
                if le32(&tail, i) == EOCD_SIG {
                    eocd = Some((le16(&tail, i + 10), le32(&tail, i + 12), le32(&tail, i + 16)));
                    break;
                }
            }
        }
        let Some((count, cd_size, cd_offset)) = eocd else {
            return Ok(Vec::new());
        };
        if u64::from(cd_offset) == MAX32 {
            return Ok(Vec::new());
        }
        // Node allocates the whole size and leaves what the file does not hold zero; past the
        // file's end plus the longest record nothing can read anything but zeros, so the buffer
        // stops there (a damaged size cannot ask for 4 GiB)
        let room = size.saturating_sub(u64::from(cd_offset)) + 46 + 3 * MAX16;
        let cd = read_once_at(src, u64::from(cd_size).min(room) as usize, u64::from(cd_offset))?;
        let mut out = Vec::new();
        let mut at = 0usize;
        let mut n = 0;
        while n < count && at + 46 <= cd.len() {
            if le32(&cd, at) != CENTRAL_SIG {
                break;
            }
            let name_len = usize::from(le16(&cd, at + 28));
            let extra_len = usize::from(le16(&cd, at + 30));
            let comment_len = usize::from(le16(&cd, at + 32));
            let name_end = (at + 46 + name_len).min(cd.len());
            out.push(JarEntry {
                name: String::from_utf8_lossy(&cd[at + 46..name_end]).into_owned(),
                method: le16(&cd, at + 10),
                compressed: le32(&cd, at + 20),
                size: le32(&cd, at + 24),
                local_offset: le32(&cd, at + 42),
            });
            at += 46 + name_len + extra_len + comment_len;
            n += 1;
        }
        Ok(out)
    }

    /// `readEntryData`: the entry's bytes, or `None` where Node gives `null` (zip64 fields, a
    /// local header that is not one, a method other than stored or deflate). Compressed data
    /// that does not inflate fails, as `inflateRawSync` throws.
    pub fn entry_data<S: Source + ?Sized>(src: &mut S, entry: &JarEntry) -> Result<Option<Vec<u8>>, Failure> {
        if u64::from(entry.compressed) == MAX32 || u64::from(entry.local_offset) == MAX32 {
            return Ok(None);
        }
        let local = read_once_at(src, 30, u64::from(entry.local_offset))?;
        if le32(&local, 0) != LOCAL_SIG {
            return Ok(None);
        }
        let data_at =
            u64::from(entry.local_offset) + 30 + u64::from(le16(&local, 26)) + u64::from(le16(&local, 28));
        let data = read_once_at(src, entry.compressed as usize, data_at)?;
        match entry.method {
            0 => Ok(Some(data)),
            8 => inflate_raw(&data).map(Some),
            _ => Ok(None),
        }
    }

    /// `zlib.inflateRawSync(data)`.
    pub fn inflate_raw(data: &[u8]) -> Result<Vec<u8>, Failure> {
        let mut inflater = Decompress::new(false);
        let mut out = Vec::with_capacity(data.len().saturating_mul(3).min(1 << 24));
        loop {
            if out.capacity() - out.len() < CHUNK {
                out.reserve(CHUNK.max(out.len()));
            }
            let used = inflater.total_in() as usize;
            let before = inflater.total_out();
            match inflater.decompress_vec(&data[used..], &mut out, FlushDecompress::None) {
                Ok(Status::StreamEnd) => return Ok(out),
                Ok(_) => {
                    let moved = inflater.total_out() != before || inflater.total_in() as usize != used;
                    if !moved {
                        // the input ran out before the stream ended (with room left to write,
                        // nothing else stops it)
                        return Err(if inflater.total_in() as usize >= data.len() {
                            zlib_error("unexpected end of file", "Z_BUF_ERROR")
                        } else {
                            zlib_error("invalid compressed data", "Z_DATA_ERROR")
                        });
                    }
                }
                Err(_) => return Err(zlib_error("invalid compressed data", "Z_DATA_ERROR")),
            }
        }
    }

    fn zlib_error(message: &str, code: &str) -> Failure {
        Failure::Internal {
            head: "Error".into(),
            message: message.into(),
            code: Some(code.into()),
        }
    }

    fn open(file: &Path) -> Result<File, Failure> {
        File::open(file).map_err(|e| Failure::io(&e, "open", Some(file)))
    }

    /// `readZipEntry(file, wanted)`: the bytes of the entry named `wanted`, or `None`.
    pub fn read_entry(file: &Path, wanted: &str) -> Result<Option<Vec<u8>>, Failure> {
        let mut src = open(file)?;
        for entry in entries(&mut src)? {
            if entry.name == wanted {
                return entry_data(&mut src, &entry);
            }
        }
        Ok(None)
    }

    /// `zipEntryList(file)`: every entry's name and unpacked size, in the archive's order.
    pub fn entry_list(file: &Path) -> Result<Vec<(String, u32)>, Failure> {
        let mut src = open(file)?;
        Ok(entries(&mut src)?.into_iter().map(|e| (e.name, e.size)).collect())
    }

    /// `extractZip(file, dest, { mapPath })`: `map_path(name)` gives the destination relative to
    /// `dest`, or `None` to skip the entry; every path is confined to `dest` before writing.
    /// Folders are skipped. The destinations written, with `/` separators.
    pub fn extract(
        file: &Path,
        dest: &Path,
        mut map_path: impl FnMut(&str) -> Option<String>,
    ) -> Result<Vec<String>, Failure> {
        let mut src = open(file)?;
        let root = jspath::resolve(&dest.to_string_lossy());
        let mut written = Vec::new();
        for entry in entries(&mut src)? {
            if entry.name.ends_with('/') {
                continue;
            }
            let Some(mapped) = map_path(&entry.name) else {
                continue;
            };
            let target = resolve_from(&root, &mapped);
            if !inside(&target, &root) {
                return Err(outside(&entry.name));
            }
            let Some(data) = entry_data(&mut src, &entry)? else {
                let base = basename(&file.to_string_lossy()).to_string();
                return Err(fail(format!("could not read \"{}\" out of {base}", entry.name)));
            };
            let target = PathBuf::from(target);
            if let Some(parent) = target.parent() {
                crate::fsx::mkdir_all(parent)?;
            }
            std::fs::write(&target, &data).map_err(|e| create_failed(&e, &target))?;
            written.push(mapped.replace('\\', "/"));
        }
        Ok(written)
    }
}

/// For the fuzz targets: every reader over `data`, which must never panic or run away, whatever
/// the bytes. Entry data is inflated in memory, at most `cap` bytes of it per entry.
pub fn fuzz_read(data: &[u8], cap: u64) {
    let mut src: &[u8] = data;
    if let Ok(list) = entries(&mut src) {
        for entry in list.take(4096) {
            let Ok(entry) = entry else { break };
            let mut local_src: &[u8] = data;
            let Ok(local) = read_exact_at(&mut local_src, 30, entry.offset) else {
                continue;
            };
            let data_at = entry.offset + 30 + u64::from(le16(&local, 26)) + u64::from(le16(&local, 28));
            if entry.method > 8 || u128::from(data_at) + u128::from(entry.packed) > data.len() as u128 {
                continue;
            }
            let mut sink = Capped { left: cap };
            let _ = copy_entry(&mut local_src, data_at, entry.packed, entry.method, &mut sink);
        }
    }
    let mut src: &[u8] = data;
    if let Ok(list) = jar::entries(&mut src) {
        for entry in list.iter().take(4096) {
            if u64::from(entry.compressed) > cap {
                continue;
            }
            let _ = jar::entry_data(&mut src, entry);
        }
    }
}

/// A sink that refuses past its cap, so a zip bomb ends the fuzz case instead of the memory.
struct Capped {
    left: u64,
}

impl Write for Capped {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() as u64 > self.left {
            return Err(io::Error::other("cap"));
        }
        self.left -= data.len() as u64;
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
