//! `client-install.mjs`: what `client install` and a launch download and unpack for a version,
//! and the vanilla half of `prepareVersion` (the version JSON from Mojang's list).
//!
//! The checked-files list (`cache/verified.json`) is shared with the Node core: a file hashed by
//! one is taken as checked by the other while its size and modification time still match, so
//! `mtimeMs` is worked out as Node does (seconds × 1000 + nanoseconds / 10⁶, in doubles).

use std::collections::{BTreeSet, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use serde_json::{Map, Value, json};

use super::library::{self, AssetLayout, Row};
use super::paths::Paths;
use super::rules::Os;
use super::{nullish, prop};
use crate::cancel;
use crate::download::{self, Hash, Hasher};
use crate::failure::Failure;
use crate::{js, jsjson, jspath};

/// How many files download at once.
pub const PARALLEL: usize = 8;
const VERIFIED_FORMAT: f64 = 1.0;

// ---- small pieces ---------------------------------------------------------------------------

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

/// `err.code`.
fn code_of(f: &Failure) -> Option<String> {
    match f {
        Failure::Usage(_) => None,
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.clone(),
    }
}

/// `fail(`${what}: ${err.message}`, err.code ?? 'download-failed')`, a cancel passed on as it is.
fn download_failed(err: Failure, what: String) -> Failure {
    if cancel::is_cancelled(&err) {
        return err;
    }
    let code = code_of(&err).unwrap_or_else(|| "download-failed".into());
    Failure::User {
        message: format!("{what}: {}", err.message()),
        code: Some(code),
    }
}

/// A checksum is 40 hex characters; anything else in a version file (an empty string) is none.
fn is_sha1(v: &Value) -> bool {
    matches!(v, Value::String(s) if s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `x ?? 0` for a size.
fn size_or_zero(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// `stat.mtimeMs` as Node computes it.
pub fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    let Ok(t) = meta.modified() else { return 0.0 };
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6,
        Err(before) => {
            // a timespec before 1970 keeps its nanoseconds positive under a negative second
            let d = before.duration();
            let (secs, nanos) = (d.as_secs() as f64, d.subsec_nanos());
            if nanos == 0 {
                -secs * 1000.0
            } else {
                (-secs - 1.0) * 1000.0 + f64::from(1_000_000_000 - nanos) / 1e6
            }
        }
    }
}

/// `sha1OfFile(file)`.
pub(crate) fn sha1_of_file(file: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(file)?;
    let mut h = Hasher::new(Hash::Sha1);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.hex())
}

/// `fs.rmSync(p, { recursive: true, force: true })`.
fn rm_force(p: &Path) -> Result<(), Failure> {
    let res = match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p),
        Ok(_) => return remove_entry(p),
    };
    match res {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Failure::io(&e, "rm", Some(p))),
        _ => Ok(()),
    }
}

/// Removes one entry that is not a folder: a file, or a link (on Windows a link to a folder, a
/// junction included, goes as a folder does).
fn remove_entry(p: &Path) -> Result<(), Failure> {
    let res = match std::fs::remove_file(p) {
        Err(e) if cfg!(windows) && std::fs::metadata(p).is_ok_and(|m| m.is_dir()) => {
            std::fs::remove_dir(p).map_err(|_| e)
        }
        other => other,
    };
    match res {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Failure::io(&e, "rm", Some(p))),
        _ => Ok(()),
    }
}

fn mkdir_parent(file: &str) -> Result<(), Failure> {
    crate::fsx::mkdir_all(Path::new(&jspath::dirname(file)))
}

/// `JSON.parse(fs.readFileSync(file, 'utf8'))`.
fn read_json_file(file: &str) -> Result<Value, Failure> {
    let path = Path::new(file);
    let bytes = std::fs::read(path).map_err(|e| Failure::read(&e, path))?;
    jsjson::parse(&String::from_utf8_lossy(&bytes)).map_err(Failure::syntax)
}

fn write_text(file: &str, text: &str) -> Result<(), Failure> {
    let path = Path::new(file);
    std::fs::write(path, text).map_err(|e| Failure::io(&e, "open", Some(path)))
}

/// `linkOrCopy(from, to)`.
pub(crate) fn link_or_copy(from: &str, to: &str) -> Result<(), Failure> {
    // `fs.rmSync(to, { force: true })`: not recursive, so a folder in the way is refused
    match std::fs::symlink_metadata(to) {
        Ok(m) if m.is_dir() => {
            return Err(Failure::Internal {
                head: "SystemError [ERR_FS_EISDIR]".into(),
                message: format!("Path is a directory: rm returned EISDIR (is a directory) {to}"),
                code: Some("ERR_FS_EISDIR".into()),
            });
        }
        Ok(_) => remove_entry(Path::new(to))?,
        Err(_) => {}
    }
    if std::fs::hard_link(from, to).is_err() {
        std::fs::copy(from, to).map_err(|e| Failure::io(&e, "copyfile", Some(Path::new(from))))?;
    }
    Ok(())
}

// ---- the checked-files list ------------------------------------------------------------------

/// The list of files already hashed (`openLedger`): what was read, what this run added, and
/// what it found changed.
#[derive(Debug, Default)]
pub struct Ledger {
    files: Map<String, Value>,
    added: Map<String, Value>,
    dropped: BTreeSet<String>,
}

fn verified_file(paths: &Paths) -> String {
    jspath::join(&[&paths.cache_dir(), "verified.json"])
}

fn read_ledger_file(paths: &Paths) -> Map<String, Value> {
    let Ok(bytes) = std::fs::read(verified_file(paths)) else {
        return Map::new();
    };
    match jsjson::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(mut data))
            if data.get("format").and_then(Value::as_f64) == Some(VERIFIED_FORMAT) =>
        {
            match data.remove("files") {
                Some(Value::Object(files)) => files,
                _ => Map::new(),
            }
        }
        _ => Map::new(),
    }
}

impl Ledger {
    /// `openLedger({ verify })`: `verify` starts from nothing, so every file is hashed again.
    pub fn open(paths: &Paths, verify: bool) -> Ledger {
        Ledger {
            files: if verify {
                Map::new()
            } else {
                read_ledger_file(paths)
            },
            ..Ledger::default()
        }
    }

    fn put(&mut self, key: String, line: Value) {
        self.files.insert(key.clone(), line.clone());
        self.added.insert(key.clone(), line);
        self.dropped.remove(&key);
    }

    /// `saveLedger(ledger)`: this run's lines on top of the file as it is now. A cache: a failure
    /// costs the next launch a slow check, nothing more.
    pub fn save(&mut self, paths: &Paths) {
        if self.added.is_empty() && self.dropped.is_empty() {
            return;
        }
        let mut files = read_ledger_file(paths);
        for key in &self.dropped {
            files.shift_remove(key);
        }
        for (k, v) in &self.added {
            files.insert(k.clone(), v.clone());
        }
        let dest = verified_file(paths);
        let saved = (|| -> Option<()> {
            std::fs::create_dir_all(jspath::dirname(&dest)).ok()?;
            let mut b = [0u8; 4];
            getrandom::fill(&mut b).ok()?;
            let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
            let tmp = format!("{dest}.{}-{hex}.tmp", std::process::id());
            let body = json!({ "format": 1, "files": Value::Object(files) });
            std::fs::write(&tmp, jsjson::stringify(&body)).ok()?;
            if crate::fsx::rename_over(Path::new(&tmp), Path::new(&dest)).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return None;
            }
            Some(())
        })();
        if saved.is_some() {
            self.added = Map::new();
            self.dropped = BTreeSet::new();
        }
    }
}

pub(crate) fn ledger_key(paths: &Paths, file: &str) -> String {
    let rel = jspath::relative(&paths.root, file);
    if cfg!(windows) {
        rel.replace('\\', "/")
    } else {
        rel
    }
}

/// `noteChecked(ledger, file, sha1)`: the file was just downloaded against this hash.
pub(crate) fn note_checked(paths: &Paths, ledger: &Mutex<Ledger>, file: &str, sha1: &Value) {
    if !is_sha1(sha1) {
        return;
    }
    let Ok(meta) = std::fs::metadata(file) else { return };
    let line = json!([
        meta.len(),
        jsjson::num(mtime_ms(&meta)),
        js::string(Some(sha1)).to_lowercase()
    ]);
    lock(ledger).put(ledger_key(paths, file), line);
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `needsFetch(file, { sha1, size }, ledger)`: missing, the wrong size, or not matching its hash;
/// a file whose line in the list still fits it is not read again.
pub(crate) fn needs_fetch(
    paths: &Paths,
    file: &str,
    sha1: &Value,
    size: &Value,
    ledger: &Mutex<Ledger>,
) -> bool {
    let Ok(meta) = std::fs::metadata(file) else {
        return true;
    };
    if !nullish(Some(size)) && size.as_f64() != Some(meta.len() as f64) {
        return true;
    }
    if !is_sha1(sha1) {
        return false;
    }
    let want = js::string(Some(sha1)).to_lowercase();
    let key = ledger_key(paths, file);
    let mtime = mtime_ms(&meta);
    let line = lock(ledger).files.get(&key).cloned();
    if let Some(Value::Array(l)) = &line
        && l.first().and_then(Value::as_f64) == Some(meta.len() as f64)
        && l.get(1).and_then(Value::as_f64) == Some(mtime)
        && l.get(2).and_then(Value::as_str) == Some(want.as_str())
    {
        return false;
    }
    let Ok(actual) = sha1_of_file(Path::new(file)) else {
        return true;
    };
    if actual != want {
        if line.is_some() {
            let mut l = lock(ledger);
            l.files.shift_remove(&key);
            l.added.shift_remove(&key);
            l.dropped.insert(key);
        }
        return true;
    }
    lock(ledger).put(key, json!([meta.len(), jsjson::num(mtime), want]));
    false
}

// ---- downloads -------------------------------------------------------------------------------

/// How a file is fetched: `downloadFile(url, dest, { hash: 'sha1', expected, label })`.
pub type Fetch<'a> = &'a (dyn Fn(&str, &Path, Option<&str>, &str) -> Result<(), Failure> + Sync);

pub fn default_fetch(url: &str, dest: &Path, expected: Option<&str>, label: &str) -> Result<(), Failure> {
    download::download_file(
        url,
        dest,
        download::Options {
            hash: Some(Hash::Sha1),
            expected: expected.map(String::from),
            label: Some(label.to_string()),
            ..download::Options::default()
        },
    )
    .map(|_| ())
}

/// `expected` as `downloadFile` reads it: a falsy one checks nothing.
fn expected_of(v: &Value) -> Option<String> {
    js::truthy(Some(v)).then(|| js::string(Some(v)))
}

/// `inBatches(items, limit, worker)`: `limit` workers take the next item until none is left. The
/// first failure is the answer; the other workers finish the item they hold and stop.
fn in_batches<T: Sync>(
    items: &[T],
    limit: usize,
    worker: &(dyn Fn(&T) -> Result<(), Failure> + Sync),
) -> Result<(), Failure> {
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let first: Mutex<Option<Failure>> = Mutex::new(None);
    let job = cancel::current();
    std::thread::scope(|s| {
        for _ in 0..limit.min(items.len()) {
            let job = job.clone();
            s.spawn(|| {
                cancel::with_cancel(job, || {
                    // every worker takes its first item before any can fail, as Node's start
                    // them all before the first await settles
                    let mut first_turn = true;
                    while first_turn || !failed.load(Ordering::SeqCst) {
                        first_turn = false;
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        let Some(item) = items.get(i) else { break };
                        if let Err(e) = worker(item) {
                            failed.store(true, Ordering::SeqCst);
                            lock(&first).get_or_insert(e);
                            break;
                        }
                    }
                });
            });
        }
    });
    match first.into_inner().unwrap_or_else(|p| p.into_inner()) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ---- natives -----------------------------------------------------------------------------------

/// A jar's central directory as `zipEntries` in plugins.mjs reads it: no Zip64, names as UTF-8.
struct ZipEntry {
    name: String,
    method: u16,
    compressed: u32,
    size: u32,
    local_offset: u32,
}

/// `fs.readSync(fd, buf, 0, len, pos)`: as much as the file holds there, the rest left zero.
fn read_at(f: &mut std::fs::File, buf: &mut [u8], pos: u64) -> std::io::Result<()> {
    f.seek(SeekFrom::Start(pos))?;
    let mut at = 0;
    while at < buf.len() {
        let n = f.read(&mut buf[at..])?;
        if n == 0 {
            break;
        }
        at += n;
    }
    Ok(())
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn zip_entries(f: &mut std::fs::File, size: u64) -> std::io::Result<Vec<ZipEntry>> {
    let tail_size = size.min(22 + 65535) as usize;
    let mut tail = vec![0u8; tail_size];
    read_at(f, &mut tail, size - tail_size as u64)?;
    let mut eocd = None;
    if tail_size >= 22 {
        for i in (0..=tail_size - 22).rev() {
            if le32(&tail, i) == 0x0605_4b50 {
                eocd = Some((le16(&tail, i + 10), le32(&tail, i + 12), le32(&tail, i + 16)));
                break;
            }
        }
    }
    let Some((count, cd_size, cd_offset)) = eocd else {
        return Ok(Vec::new());
    };
    if cd_offset == u32::MAX {
        return Ok(Vec::new());
    }
    let mut cd = vec![0u8; cd_size as usize];
    read_at(f, &mut cd, u64::from(cd_offset))?;
    let mut out = Vec::new();
    let mut at = 0usize;
    for _ in 0..count {
        if at + 46 > cd.len() || le32(&cd, at) != 0x0201_4b50 {
            break;
        }
        let name_len = usize::from(le16(&cd, at + 28));
        let extra_len = usize::from(le16(&cd, at + 30));
        let comment_len = usize::from(le16(&cd, at + 32));
        let end = (at + 46 + name_len).min(cd.len());
        out.push(ZipEntry {
            name: String::from_utf8_lossy(&cd[at + 46..end]).into_owned(),
            method: le16(&cd, at + 10),
            compressed: le32(&cd, at + 20),
            size: le32(&cd, at + 24),
            local_offset: le32(&cd, at + 42),
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// `readEntryData(fd, entry, size)`: `None` for what it declines (Zip64, a stored entry that is
/// not where the index says, an unknown method, more out than the entry declares).
fn read_entry_data(f: &mut std::fs::File, e: &ZipEntry, size: u64) -> Result<Option<Vec<u8>>, Failure> {
    if e.compressed == u32::MAX || e.local_offset == u32::MAX {
        return Ok(None);
    }
    let io = |err: std::io::Error| Failure::io(&err, "read", None);
    let mut local = [0u8; 30];
    read_at(f, &mut local, u64::from(e.local_offset)).map_err(io)?;
    if le32(&local, 0) != 0x0403_4b50 {
        return Ok(None);
    }
    let data_at = u64::from(e.local_offset) + 30 + u64::from(le16(&local, 26)) + u64::from(le16(&local, 28));
    let len = u64::from(e.compressed).min(size.saturating_sub(data_at));
    let mut data = vec![0u8; len as usize];
    read_at(f, &mut data, data_at).map_err(io)?;
    match e.method {
        0 => Ok(Some(data)),
        8 => {
            // `inflateRawSync(data, { maxOutputLength: max })`: grown as it fills, so a size the
            // entry only claims is never allocated up front
            let max = (e.size as usize).max(1);
            let mut z = flate2::Decompress::new(false);
            let mut out: Vec<u8> = Vec::with_capacity(max.min(1 << 16));
            loop {
                let before = (z.total_in(), z.total_out());
                let input = &data[z.total_in() as usize..];
                let status = z.decompress_vec(input, &mut out, flate2::FlushDecompress::None);
                match status {
                    Ok(flate2::Status::StreamEnd) => return Ok(Some(out)),
                    Err(err) => {
                        return Err(Failure::Internal {
                            head: "Error".into(),
                            message: err.to_string(),
                            code: Some("Z_DATA_ERROR".into()),
                        });
                    }
                    Ok(_) => {}
                }
                if out.len() > max {
                    return Ok(None);
                }
                if out.len() == max {
                    // full: more to come is too large, nothing more is a stream cut short
                    let mut probe = [0u8; 1];
                    let more = z.decompress(
                        &data[z.total_in() as usize..],
                        &mut probe,
                        flate2::FlushDecompress::None,
                    );
                    if z.total_out() as usize > max {
                        return Ok(None);
                    }
                    return match more {
                        Ok(flate2::Status::StreamEnd) => Ok(Some(out)),
                        Ok(_) if z.total_out() as usize > max => Ok(None),
                        Err(err) => Err(Failure::Internal {
                            head: "Error".into(),
                            message: err.to_string(),
                            code: Some("Z_DATA_ERROR".into()),
                        }),
                        Ok(_) => Err(Failure::Internal {
                            head: "Error".into(),
                            message: "unexpected end of file".into(),
                            code: Some("Z_BUF_ERROR".into()),
                        }),
                    };
                }
                if out.len() == out.capacity() {
                    out.reserve_exact((max - out.len()).min(out.capacity().max(1 << 16)));
                } else if (z.total_in(), z.total_out()) == before {
                    // nothing moved with room to spare: the input ran out
                    return Err(Failure::Internal {
                        head: "Error".into(),
                        message: "unexpected end of file".into(),
                        code: Some("Z_BUF_ERROR".into()),
                    });
                }
            }
        }
        _ => Ok(None),
    }
}

/// `startsWith` for each prefix of a natives row's `extract.exclude` (`for...of`: a list, or the
/// characters of a text).
fn excluded(name: &str, exclude: &Value) -> Result<bool, Failure> {
    match exclude {
        Value::Array(list) => Ok(list.iter().any(|p| name.starts_with(&js::string(Some(p))))),
        Value::String(s) => Ok(s.chars().any(|c| name.starts_with(c))),
        _ => Err(Failure::type_error("exclude is not iterable")),
    }
}

/// `util.inspect(text)` for a path: quoted, with the escapes a path can need.
fn inspect_string(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(quote);
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `path.resolve(root, name)`: an absolute name stands alone, and on Windows a name with a
/// drive (`D:x`) resolves on that drive, inside the root only when it is the root's own drive.
fn resolve_entry(root: &str, name: &str) -> String {
    if jspath::is_absolute(name) {
        return jspath::resolve(name);
    }
    let b = name.as_bytes();
    if cfg!(windows) && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        let same = root
            .as_bytes()
            .first()
            .is_some_and(|r| r.eq_ignore_ascii_case(&b[0]))
            && root.as_bytes().get(1) == Some(&b':');
        // another drive's folder is never under the root
        return if same {
            jspath::resolve(&jspath::join(&[root, &name[2..]]))
        } else {
            jspath::resolve(name)
        };
    }
    jspath::resolve(&jspath::join(&[root, name]))
}

/// `extractZip(file, dest, { mapPath })` of plugins.mjs, with the natives' mapPath: META-INF and
/// the row's excludes left out. The number of files written.
fn extract_natives_jar(file: &str, dest: &str, exclude: &Value) -> Result<usize, Failure> {
    let path = Path::new(file);
    let mut f = std::fs::File::open(path).map_err(|e| Failure::io(&e, "open", Some(path)))?;
    let size = f.metadata().map_err(|e| Failure::io(&e, "fstat", None))?.len();
    let root = jspath::resolve(dest);
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let base = jspath::basename(file);
    let mut written = 0;
    for entry in zip_entries(&mut f, size).map_err(|e| Failure::io(&e, "read", None))? {
        if entry.name.ends_with('/') || entry.name.starts_with("META-INF/") || excluded(&entry.name, exclude)?
        {
            continue;
        }
        let target = resolve_entry(&root, &entry.name);
        if target != root && !target.starts_with(&format!("{root}{sep}")) {
            return Err(Failure::user(format!(
                "the archive tried to write outside its folder (\"{}\"); nothing more was extracted",
                entry.name
            )));
        }
        let Some(data) = read_entry_data(&mut f, &entry, size)? else {
            return Err(Failure::user(format!(
                "could not read \"{}\" out of {base}",
                entry.name
            )));
        };
        if target.contains('\0') {
            return Err(Failure::Internal {
                head: "TypeError [ERR_INVALID_ARG_VALUE]".into(),
                message: format!(
                    "The argument 'path' must be a string, Uint8Array, or URL without null bytes. Received {}",
                    inspect_string(&target)
                ),
                code: Some("ERR_INVALID_ARG_VALUE".into()),
            });
        }
        mkdir_parent(&target)?;
        let t = Path::new(&target);
        std::fs::write(t, &data).map_err(|e| Failure::io(&e, "open", Some(t)))?;
        written += 1;
    }
    Ok(written)
}

/// `extractNatives(id, nativeRows, { stamp, subdir, extraDirs })`: the folder made again from
/// the jars, then stamped with whose natives they are.
pub fn extract_natives(
    paths: &Paths,
    id: &str,
    rows: &[Row],
    stamp: &str,
    subdir: &str,
    extra_dirs: &[String],
) -> Result<usize, Failure> {
    let root = paths.natives_dir(id);
    rm_force(Path::new(&root))?;
    let dir = jspath::join(&[&root, subdir]);
    crate::fsx::mkdir_all(Path::new(&dir))?;
    for extra in extra_dirs {
        crate::fsx::mkdir_all(Path::new(&jspath::join(&[&root, extra])))?;
    }
    let mut seen = HashSet::new();
    let mut files = 0;
    for row in rows {
        if !seen.insert(row.path.clone()) {
            continue;
        }
        let exclude = row.native.clone().unwrap_or(Value::Array(Vec::new()));
        files += extract_natives_jar(
            &jspath::join(&[&paths.libraries_dir(), &row.path]),
            &dir,
            &exclude,
        )?;
    }
    write_text(&jspath::join(&[&root, ".complete"]), stamp)?;
    Ok(files)
}

// ---- the plan ----------------------------------------------------------------------------------

/// `planInstall(version, { os })`: what a version needs on this machine, decided without the
/// disk or the network.
#[derive(Debug, Clone)]
pub struct Plan {
    pub libraries: Vec<Row>,
    pub natives: Vec<Row>,
    pub natives_subdir: String,
    pub natives_extra_dirs: Vec<String>,
    pub natives_stamp: String,
    pub asset_index: Value,
    /// Every library row, duplicates included.
    pub library_rows: usize,
}

pub fn plan_install(version: &Value, os: &Os) -> Result<Plan, Failure> {
    let rows = library::libraries(version, os)?;
    let mut seen = HashSet::new();
    let libraries: Vec<Row> = rows
        .iter()
        .filter(|r| seen.insert(r.path.clone()))
        .cloned()
        .collect();
    // the remaining fields are read in planInstall's order, so the first failure is Node's
    let _ = library::logging_config(version)?;
    let natives: Vec<Row> = rows.iter().filter(|r| r.native.is_some()).cloned().collect();
    Ok(Plan {
        libraries,
        natives,
        natives_subdir: super::rules::natives_library_subdir(version, os)?,
        natives_extra_dirs: super::rules::natives_extra_dirs(version, os)?,
        natives_stamp: super::version::natives_stamp(version, os)?,
        asset_index: library::asset_index(version)?,
        library_rows: rows.len(),
    })
}

/// `Object.entries(index.objects ?? {})`.
fn index_entries(index: &Value) -> Vec<(String, Value)> {
    match prop(Some(index), "objects") {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Some(Value::String(s)) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, u)| (i.to_string(), json!(String::from_utf16_lossy(&[u]))))
            .collect(),
        _ => Vec::new(),
    }
}

/// `assetTreeRows(index)`: an index's files under their real names, each path checked to stay in
/// its tree.
pub fn asset_tree_rows(index: &Value) -> Result<Vec<(String, String)>, Failure> {
    let mut rows = Vec::new();
    for (name, entry) in index_entries(index) {
        let Some(rel) = crate::util::safe_relative_path(&name) else {
            return Err(Failure::user(format!(
                "the asset index names the file \"{}\", which would land outside its folder",
                library::cut(&name, 80)
            )));
        };
        if rel.split('/').next().unwrap_or("").to_lowercase() == ".complete" {
            return Err(Failure::user(format!(
                "the asset index names the file \"{}\", which SpawnLoft keeps for itself",
                library::cut(&rel, 80)
            )));
        }
        let hash = js::string(prop(Some(&entry), "hash"));
        if !(hash.len() == 40
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        {
            return Err(Failure::user(format!(
                "the asset index names \"{rel}\" with a malformed hash"
            )));
        }
        rows.push((rel, format!("objects/{}/{hash}", &hash[..2])));
    }
    Ok(rows)
}

fn layout_name(l: AssetLayout) -> &'static str {
    match l {
        AssetLayout::Objects => "objects",
        AssetLayout::Virtual => "virtual",
        AssetLayout::Resources => "resources",
    }
}

// ---- ensureVersion -----------------------------------------------------------------------------

/// One `onProgress({ phase, done, total, bytes })`.
#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub phase: &'static str,
    pub done: usize,
    pub total: usize,
    pub bytes: f64,
}

pub type OnProgress<'a> = &'a (dyn Fn(&Progress) + Sync);

/// `ensureVersion(id, opts)`'s options.
pub struct Ensure<'a> {
    pub os: Os,
    pub on_progress: OnProgress<'a>,
    pub fetch: Fetch<'a>,
    /// The ids whose natives a running game has loaded: an extracted folder is left as it is.
    pub keep_natives: &'a [String],
    /// Hash every file again, whatever the checked-files list says (a repair).
    pub verify: bool,
}

impl std::fmt::Debug for Ensure<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ensure")
            .field("os", &self.os)
            .field("verify", &self.verify)
            .finish_non_exhaustive()
    }
}

/// What progress has been told and counted so far; one lock, so lines come out whole and in
/// the order the counts moved.
struct Tally<'a> {
    on_progress: OnProgress<'a>,
    last_emit: std::collections::HashMap<&'static str, Instant>,
    downloaded: u64,
    total_bytes: f64,
    lib_bytes: f64,
    lib_done: usize,
    native_downloaded: bool,
    asset_done: usize,
    asset_bytes: f64,
}

impl Tally<'_> {
    fn emit(&mut self, phase: &'static str, done: usize, total: usize, bytes: f64) {
        let now = Instant::now();
        let due = self
            .last_emit
            .get(phase)
            .is_none_or(|t| now.duration_since(*t).as_millis() >= 250);
        if due {
            self.last_emit.insert(phase, now);
            (self.on_progress)(&Progress {
                phase,
                done,
                total,
                bytes,
            });
        }
    }
    fn emit_end(&mut self, phase: &'static str, done: usize, total: usize, bytes: f64) {
        self.last_emit.insert(phase, Instant::now());
        (self.on_progress)(&Progress {
            phase,
            done,
            total,
            bytes,
        });
    }
}

/// `ensureVersion(id, opts)`: everything the version needs, fetched and checked; the parent of
/// an inheriting version first. One checked-files list for both, saved however it ends.
pub fn ensure_version(paths: &Paths, id: &str, o: &Ensure<'_>) -> Result<Value, Failure> {
    let ledger = Mutex::new(Ledger::open(paths, o.verify));
    let res = ensure_with(paths, id, o, &ledger);
    lock(&ledger).save(paths);
    res
}

fn ensure_with(paths: &Paths, id: &str, o: &Ensure<'_>, ledger: &Mutex<Ledger>) -> Result<Value, Failure> {
    let began = crate::util::now();
    let json_file = paths.version_json(id);
    let raw = match std::fs::read(&json_file) {
        Ok(b) => jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax)?,
        Err(e) if crate::jspath::is_enoent(&e) => {
            return Err(Failure::user(format!(
                "version \"{id}\" is not installed; run spawnloft client install first"
            )));
        }
        Err(e) => return Err(Failure::read(&e, Path::new(&json_file))),
    };
    let parent_id = prop(Some(&raw), "inheritsFrom")
        .filter(|v| js::truthy(Some(v)))
        .map(|v| js::string(Some(v)));
    let version = match &parent_id {
        Some(parent) => {
            ensure_with(paths, parent, o, ledger)?;
            let parent_json = read_json_file(&paths.version_json(parent))?;
            library::merge_inherited(&raw, &parent_json)?
        }
        None => raw.clone(),
    };
    // before the first download: natives this machine cannot load are not worth fetching
    if let Some(refusal) = library::platform_refusal(Some(&version), &o.os, None)? {
        return Err(Failure::user(refusal));
    }

    // the asset index first: a layout this SpawnLoft does not set up is refused before the jar
    // and the libraries download
    let plan = plan_install(&version, &o.os)?;
    let ai = &plan.asset_index;
    let ai_id = js::string(prop(Some(ai), "id"));
    let ai_sha1 = prop(Some(ai), "sha1").cloned().unwrap_or(Value::Null);
    let ai_size = prop(Some(ai), "size").cloned().unwrap_or(Value::Null);
    let ai_url = js::string(prop(Some(ai), "url"));
    let index_dest = jspath::join(&[&paths.assets_dir(), "indexes", &format!("{ai_id}.json")]);
    let mut index_bytes = 0.0;
    if needs_fetch(paths, &index_dest, &ai_sha1, &ai_size, ledger) {
        mkdir_parent(&index_dest)?;
        (o.fetch)(
            &ai_url,
            Path::new(&index_dest),
            expected_of(&ai_sha1).as_deref(),
            &format!("asset index {ai_id}"),
        )
        .map_err(|e| download_failed(e, format!("could not download asset index {ai_id} from {ai_url}")))?;
        note_checked(paths, ledger, &index_dest, &ai_sha1);
        index_bytes = size_or_zero(&ai_size);
    }
    let index_json = read_json_file(&index_dest)?;
    let Some(layout) = library::asset_layout(&index_json) else {
        return Err(coded(
            format!(
                "Minecraft {id}'s asset index ({ai_id}) is laid out in a way SpawnLoft does not know. Update SpawnLoft."
            ),
            "unknown-asset-layout",
        ));
    };
    if layout != AssetLayout::Objects {
        asset_tree_rows(&index_json)?;
    }

    let jar_path = paths.version_jar(id);
    let tally = Mutex::new(Tally {
        on_progress: o.on_progress,
        last_emit: std::collections::HashMap::new(),
        downloaded: 0,
        total_bytes: 0.0,
        lib_bytes: 0.0,
        lib_done: 0,
        native_downloaded: false,
        asset_done: 1,
        asset_bytes: index_bytes,
    });

    let dl = prop(Some(&version), "downloads").and_then(|d| prop(Some(d), "client"));
    if let Some(dl) = dl.filter(|d| js::truthy(Some(d))) {
        let sha1 = prop(Some(dl), "sha1").cloned().unwrap_or(Value::Null);
        let size = prop(Some(dl), "size").cloned().unwrap_or(Value::Null);
        let needs = needs_fetch(paths, &jar_path, &sha1, &size, ledger);
        if needs {
            mkdir_parent(&jar_path)?;
            let own = prop(Some(&raw), "downloads").and_then(|d| prop(Some(d), "client"));
            if js::truthy(own) {
                let url = js::string(prop(Some(dl), "url"));
                (o.fetch)(
                    &url,
                    Path::new(&jar_path),
                    expected_of(&sha1).as_deref(),
                    &format!("the client jar for {id}"),
                )
                .map_err(|e| {
                    download_failed(
                        e,
                        format!("could not download the client jar for {id} from {url}"),
                    )
                })?;
                note_checked(paths, ledger, &jar_path, &sha1);
                let mut t = lock(&tally);
                t.downloaded += 1;
                t.total_bytes += size_or_zero(&size);
            } else {
                // a loader profile inherits the parent's jar, linked under its own id
                let parent = parent_id.clone().unwrap_or_else(|| "undefined".into());
                link_or_copy(&paths.version_jar(&parent), &jar_path)?;
            }
        }
        lock(&tally).emit_end("client", 1, 1, if needs { size_or_zero(&size) } else { 0.0 });
    } else {
        lock(&tally).emit_end("client", 0, 0, 0.0);
    }

    // before the libraries, so a version that cannot be made safe is refused early: without this
    // file 1.7 to 1.18.0 would run open to Log4Shell
    let log_cfg = library::logging_config(&version)?;
    if let Some(cfg) = &log_cfg {
        let dest = paths.log_config_path(&cfg.id);
        let sha1 = json!(cfg.sha1);
        let size = cfg.size.map_or(Value::Null, jsjson::num);
        let needs = needs_fetch(paths, &dest, &sha1, &size, ledger);
        if needs {
            mkdir_parent(&dest)?;
            (o.fetch)(&cfg.url, Path::new(&dest), expected_of(&sha1).as_deref(), &format!("the log config {}", cfg.id))
                .map_err(|e| {
                    let e = download_failed(e, format!("could not download the log config {} from {}", cfg.id, cfg.url));
                    match e {
                        Failure::User { message, code } if code.as_deref() != Some("cancelled") => Failure::User {
                            message: format!("{message}; without it {id} would run open to Log4Shell, so it is not launched"),
                            code,
                        },
                        other => other,
                    }
                })?;
            note_checked(paths, ledger, &dest, &sha1);
            let mut t = lock(&tally);
            t.downloaded += 1;
            t.total_bytes += cfg.size.unwrap_or(0.0);
        }
        lock(&tally).emit_end(
            "log config",
            1,
            1,
            if needs { cfg.size.unwrap_or(0.0) } else { 0.0 },
        );
    }

    if index_bytes != 0.0 {
        let mut t = lock(&tally);
        t.downloaded += 1;
        t.total_bytes += index_bytes;
    }

    let native_paths: HashSet<&str> = plan.natives.iter().map(|r| r.path.as_str()).collect();
    let lib_total = plan.libraries.len();
    in_batches(&plan.libraries, PARALLEL, &|row: &Row| {
        let dest = jspath::join(&[&paths.libraries_dir(), &row.path]);
        let needs = needs_fetch(paths, &dest, &row.sha1, &row.size, ledger);
        // made by the loader's installer, not downloaded: missing or damaged means setting the
        // loader up again
        if needs && row.url.is_none() {
            return Err(coded(
                format!(
                    "library {} is made when the mod loader is set up, and it is missing or damaged; set the loader up again",
                    row.name
                ),
                "loader-install-needed",
            ));
        }
        if needs {
            mkdir_parent(&dest)?;
            let url = js::string(row.url.as_ref());
            let expected = if nullish(Some(&row.sha1)) {
                None
            } else {
                expected_of(&row.sha1)
            };
            (o.fetch)(
                &url,
                Path::new(&dest),
                expected.as_deref(),
                &format!("library {}", row.name),
            )
            .map_err(|e| download_failed(e, format!("could not download library {} from {url}", row.name)))?;
            note_checked(paths, ledger, &dest, &row.sha1);
        }
        let mut t = lock(&tally);
        if needs {
            let size = size_or_zero(&row.size);
            t.lib_bytes += size;
            t.downloaded += 1;
            t.total_bytes += size;
            if native_paths.contains(row.path.as_str()) {
                t.native_downloaded = true;
            }
        }
        t.lib_done += 1;
        let (done, bytes) = (t.lib_done, t.lib_bytes);
        t.emit("libraries", done, lib_total, bytes);
        Ok(())
    })?;
    {
        let mut t = lock(&tally);
        let (done, bytes) = (t.lib_done, t.lib_bytes);
        t.emit_end("libraries", done, lib_total, bytes);
    }

    // two index entries can share a hash, so the queue is keyed by destination
    let objects = library::asset_objects(&index_json)?;
    let mut seen = HashSet::new();
    let assets: Vec<&library::Asset> = objects.iter().filter(|a| seen.insert(a.path.clone())).collect();
    let asset_total = 1 + assets.len();
    in_batches(&assets, PARALLEL, &|row: &&library::Asset| {
        let dest = jspath::join(&[&paths.assets_dir(), &row.path]);
        let hash = json!(row.hash);
        let needs = needs_fetch(paths, &dest, &hash, &row.size, ledger);
        if needs {
            mkdir_parent(&dest)?;
            (o.fetch)(
                &row.url,
                Path::new(&dest),
                Some(&row.hash),
                &format!("asset {}", row.hash),
            )
            .map_err(|e| {
                download_failed(
                    e,
                    format!("could not download asset {} from {}", row.hash, row.url),
                )
            })?;
            note_checked(paths, ledger, &dest, &hash);
        }
        let mut t = lock(&tally);
        if needs {
            let size = size_or_zero(&row.size);
            t.asset_bytes += size;
            t.downloaded += 1;
            t.total_bytes += size;
        }
        t.asset_done += 1;
        let (done, bytes) = (t.asset_done, t.asset_bytes);
        t.emit("assets", done, asset_total, bytes);
        Ok(())
    })?;
    {
        let mut t = lock(&tally);
        let (done, bytes) = (t.asset_done, t.asset_bytes);
        t.emit_end("assets", done, asset_total, bytes);
    }

    let natives_dir = paths.natives_dir(id);
    let complete = jspath::join(&[&natives_dir, ".complete"]);
    let read_stamp = || {
        std::fs::read(&complete)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    // `existsSync && readFileSync`: a stamp that is there but cannot be read fails the install
    let stamped = match std::fs::read(&complete) {
        Ok(b) => String::from_utf8_lossy(&b) == plan.natives_stamp.as_str(),
        Err(e) if crate::jspath::is_enoent(&e) => false,
        Err(e) => return Err(Failure::read(&e, Path::new(&complete))),
    };
    let keep = o.keep_natives.iter().any(|k| k == id) && Path::new(&complete).exists();
    let native_downloaded = lock(&tally).native_downloaded;
    if !plan.natives.is_empty() && !keep && (native_downloaded || !stamped) {
        // two setups of one version wait for each other; a stamp written since this call began
        // is the first one's work from the same checked jars
        mkdir_parent(&natives_dir)?;
        let lock_file = PathBuf::from(format!("{natives_dir}.lock"));
        let held = crate::lock::acquire(&lock_file, crate::lock::Options::wait(60_000))
            .map_err(|e| super::profiles::lock_failure(&e))?;
        let res = (|| {
            let done = read_stamp().as_deref() == Some(plan.natives_stamp.as_str())
                && (!native_downloaded || std::fs::metadata(&complete).is_ok_and(|m| mtime_ms(&m) >= began));
            if !done {
                extract_natives(
                    paths,
                    id,
                    &plan.natives,
                    &plan.natives_stamp,
                    &plan.natives_subdir,
                    &plan.natives_extra_dirs,
                )?;
            }
            Ok(())
        })();
        drop(held);
        res?;
    }
    let n = plan.natives.len();
    lock(&tally).emit_end("natives", n, n, 0.0);

    let t = tally.into_inner().unwrap_or_else(|p| p.into_inner());
    Ok(super::object(vec![
        ("id", Some(json!(id))),
        ("jar", Some(json!(jar_path))),
        ("logConfig", Some(log_cfg.map_or(Value::Null, |c| json!(c.id)))),
        ("assetsLayout", Some(json!(layout_name(layout)))),
        (
            "assetIndex",
            Some(super::object(vec![
                ("id", prop(Some(ai), "id").cloned()),
                ("sha1", Some(ai_sha1)),
                ("file", Some(json!(index_dest))),
            ])),
        ),
        ("libraries", Some(json!(plan.library_rows))),
        ("natives", Some(json!(n))),
        ("assets", Some(json!(objects.len()))),
        ("downloaded", Some(json!(t.downloaded))),
        ("bytes", Some(jsjson::num(t.total_bytes))),
    ]))
}

// ---- prepareVersion (vanilla) ----------------------------------------------------------------

/// `fetchVersionJson(id, { manifest })`: the version JSON Mojang's list names, kept while its
/// sha1 still matches.
pub fn fetch_version_json(
    paths: &Paths,
    id: &str,
    manifest: &Value,
    fetch: Fetch<'_>,
) -> Result<(), Failure> {
    let rows = match prop(Some(manifest), "versions") {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Null) => {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'find')",
            ));
        }
        None => {
            return Err(Failure::type_error(
                "Cannot read properties of undefined (reading 'find')",
            ));
        }
        Some(_) => return Err(Failure::type_error("manifest.versions.find is not a function")),
    };
    let Some(entry) = rows.iter().find(|v| prop(Some(v), "id") == Some(&json!(id))) else {
        return Err(Failure::user(format!("unknown Minecraft version \"{id}\"")));
    };
    let sha1 = prop(Some(entry), "sha1").cloned().unwrap_or(Value::Null);
    let dest = paths.version_json(id);
    match std::fs::read(&dest) {
        Ok(bytes) => {
            if Value::String(crate::sha1::hex(&bytes)) == sha1 {
                return jsjson::parse(&String::from_utf8_lossy(&bytes))
                    .map(|_| ())
                    .map_err(Failure::syntax);
            }
        }
        Err(e) if crate::jspath::is_enoent(&e) => {}
        Err(e) => return Err(Failure::read(&e, Path::new(&dest))),
    }
    crate::fsx::mkdir_all(Path::new(&paths.version_dir(id)))?;
    let url = js::string(prop(Some(entry), "url"));
    fetch(
        &url,
        Path::new(&dest),
        expected_of(&sha1).as_deref(),
        &format!("the version JSON for {id}"),
    )?;
    read_json_file(&dest).map(|_| ())
}

/// The vanilla half of `prepareVersion(name, { onStage })`: the version JSON fetched when it is
/// not on disk. The version id to install.
pub fn prepare_vanilla(
    paths: &Paths,
    mc: &str,
    on_stage: &mut dyn FnMut(&str),
    fetch_json: super::meta::FetchJson<'_>,
    fetch: Fetch<'_>,
) -> Result<String, Failure> {
    if !Path::new(&paths.version_json(mc)).exists() {
        on_stage("Reading the Minecraft version list");
        let known = super::versions::assert_version_id(paths, &json!(mc), fetch_json)?;
        on_stage(&format!("Downloading the version file for Minecraft {mc}"));
        let manifest = known.manifest.unwrap_or(Value::Null);
        if manifest.is_null() {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'versions')",
            ));
        }
        fetch_version_json(paths, mc, &manifest, fetch)?;
    }
    Ok(mc.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> (PathBuf, Paths) {
        let d = std::env::temp_dir().join(format!("sl-client-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = Paths::under(&d.to_string_lossy());
        (d, p)
    }

    #[test]
    fn mtime_is_node_s_double() {
        let (d, _) = scratch("mtime");
        let f = d.join("a");
        std::fs::write(&f, "x").unwrap();
        let m = std::fs::metadata(&f).unwrap();
        let d2 = m
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        assert_eq!(
            mtime_ms(&m),
            d2.as_secs() as f64 * 1000.0 + f64::from(d2.subsec_nanos()) / 1e6
        );
    }

    #[test]
    fn the_ledger_skips_a_file_it_has_checked_and_drops_a_changed_one() {
        let (d, p) = scratch("ledger");
        let lib = d.join("client/libraries/a.jar");
        std::fs::create_dir_all(lib.parent().unwrap()).unwrap();
        std::fs::write(&lib, "abc").unwrap();
        let file = lib.to_string_lossy().into_owned();
        let good = json!(crate::sha1::hex(b"abc"));
        let ledger = Mutex::new(Ledger::open(&p, false));
        assert!(!needs_fetch(&p, &file, &good, &json!(3), &ledger));
        assert!(lock(&ledger).added.contains_key("libraries/a.jar"));
        lock(&ledger).save(&p);
        let saved = read_ledger_file(&p);
        assert_eq!(saved["libraries/a.jar"][2], good);
        // a wrong size needs no hashing; a wrong hash drops the line
        let ledger = Mutex::new(Ledger::open(&p, false));
        assert!(needs_fetch(&p, &file, &good, &json!(4), &ledger));
        assert!(lock(&ledger).dropped.is_empty());
        // a file that fails its hash loses its line, as Node's needsFetch drops it
        std::fs::write(&lib, "abd").unwrap();
        // the same size written in the same clock tick (Windows' is coarse) would match the line,
        // as it would in Node: the change is dated a minute on
        let later = std::fs::metadata(&lib).unwrap().modified().unwrap() + std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&lib)
            .unwrap()
            .set_modified(later)
            .unwrap();
        assert!(needs_fetch(&p, &file, &good, &json!(3), &ledger));
        assert!(lock(&ledger).dropped.contains("libraries/a.jar"));
        lock(&ledger).save(&p);
        assert!(!read_ledger_file(&p).contains_key("libraries/a.jar"));
        // no checksum: present is enough
        assert!(!needs_fetch(&p, &file, &json!(""), &Value::Null, &ledger));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn natives_extract_without_meta_inf_and_excludes() {
        let (d, p) = scratch("natives");
        let jar = d.join("client/libraries/n.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        let src = d.join("src");
        std::fs::create_dir_all(src.join("META-INF")).unwrap();
        std::fs::create_dir_all(src.join("skip")).unwrap();
        std::fs::write(src.join("META-INF/MANIFEST.MF"), "m").unwrap();
        std::fs::write(src.join("skip/x"), "s").unwrap();
        std::fs::write(src.join("liblwjgl.so"), vec![7u8; 5000]).unwrap();
        let ok = std::process::Command::new("zip")
            .current_dir(&src)
            .args(["-qr", &jar.to_string_lossy(), "."])
            .status();
        if !ok.is_ok_and(|s| s.success()) {
            return; // no zip tool here
        }
        let row = Row {
            name: "n".into(),
            path: "n.jar".into(),
            url: None,
            sha1: Value::Null,
            size: Value::Null,
            native: Some(json!(["skip/"])),
        };
        let n = extract_natives(&p, "1.0", &[row.clone(), row], "stamp", "", &["x".into()]).unwrap();
        assert_eq!(n, 1);
        let dir = d.join("client/natives/1.0");
        assert_eq!(std::fs::read(dir.join("liblwjgl.so")).unwrap(), vec![7u8; 5000]);
        assert!(!dir.join("META-INF").exists() && !dir.join("skip").exists());
        assert!(dir.join("x").is_dir());
        assert_eq!(std::fs::read_to_string(dir.join(".complete")).unwrap(), "stamp");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn asset_tree_rows_refuse_escapes_and_the_stamp() {
        let rows =
            asset_tree_rows(&json!({ "objects": { "a/b.png": { "hash": "ab".repeat(20) } } })).unwrap();
        assert_eq!(
            rows,
            vec![("a/b.png".to_string(), format!("objects/ab/{}", "ab".repeat(20)))]
        );
        assert!(asset_tree_rows(&json!({ "objects": { "../x": { "hash": "ab".repeat(20) } } })).is_err());
        assert!(
            asset_tree_rows(&json!({ "objects": { ".COMPLETE/x": { "hash": "ab".repeat(20) } } })).is_err()
        );
        assert!(asset_tree_rows(&json!({ "objects": { "x": { "hash": "AB".repeat(20) } } })).is_err());
    }
}
