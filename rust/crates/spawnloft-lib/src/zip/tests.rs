use super::*;

/// One entry of a hand-made archive.
#[derive(Clone)]
pub(crate) struct Raw {
    pub name: Vec<u8>,
    pub flags: u16,
    pub method: u16,
    pub data: Vec<u8>,
    pub crc: u32,
    pub size: u32,
    pub made_by: u16,
    pub attributes: u32,
}

pub(crate) fn raw_entry(name: &str, content: &[u8]) -> Raw {
    let mut crc = Crc::new();
    crc.update(content);
    Raw {
        name: name.as_bytes().to_vec(),
        flags: UTF8_NAMES,
        method: 0,
        data: content.to_vec(),
        crc: crc.sum(),
        size: content.len() as u32,
        made_by: 3,
        attributes: 0o100644 << 16,
    }
}

/// A zip of stored or pre-packed entries, written field by field.
pub(crate) fn raw_zip(entries: &[Raw]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offsets = Vec::new();
    for e in entries {
        offsets.push(out.len() as u32);
        out.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&e.flags.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&e.name);
        out.extend_from_slice(&e.data);
    }
    let cd_at = out.len() as u32;
    for (e, off) in entries.iter().zip(&offsets) {
        out.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
        out.extend_from_slice(&((e.made_by << 8) | 20).to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&e.flags.to_le_bytes());
        out.extend_from_slice(&e.method.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0; 8]);
        out.extend_from_slice(&e.attributes.to_le_bytes());
        out.extend_from_slice(&off.to_le_bytes());
        out.extend_from_slice(&e.name);
    }
    let cd_size = out.len() as u32 - cd_at;
    out.extend_from_slice(&EOCD_SIG.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("spawnloft-zip-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn names(data: &[u8]) -> Vec<String> {
    let mut src: &[u8] = data;
    entries(&mut src).unwrap().map(|e| e.unwrap().name).collect()
}

#[test]
fn names_decode_as_node_decodes_them() {
    assert_eq!(decode_name(b"caf\x82", 0), "café");
    assert_eq!(decode_name(b"\xe2\x96\x91x", 0), "░x");
    assert_eq!(decode_name("café".as_bytes(), 0), "café");
    assert_eq!(decode_name(b"\xef\xbb\xbfa", 0), "a");
    assert_eq!(decode_name(b"\xef\xbb\xbfa", UTF8_NAMES), "\u{feff}a");
    assert_eq!(decode_name(b"a\xffb", UTF8_NAMES), "a\u{fffd}b");
    assert_eq!(decode_name(b"\xff", 0), "\u{a0}");
}

#[test]
fn a_tree_goes_round_and_comes_back() {
    let dir = scratch("round");
    let world = dir.join("src/world");
    std::fs::create_dir_all(world.join("région/日本")).unwrap();
    std::fs::create_dir_all(world.join("session.lock.d")).unwrap();
    std::fs::write(world.join("level.dat"), vec![42u8; 300_000]).unwrap();
    std::fs::write(world.join("empty"), b"").unwrap();
    std::fs::write(world.join("région/日本/r.0.0.mca"), b"chunk").unwrap();
    std::fs::write(world.join("\u{ff5e}"), b"wide").unwrap();
    std::fs::write(world.join("😀"), b"astral").unwrap();
    std::fs::write(world.join("session.lock"), b"x").unwrap();
    let cwd = dir.join("src").to_string_lossy().into_owned();
    for zip64 in [false, true] {
        let file = dir.join(format!("w{zip64}.zip"));
        let made = create(&file, &cwd, &["world"], &["session.lock"], zip64).unwrap();
        let data = std::fs::read(&file).unwrap();
        assert_eq!(made.bytes, data.len() as u64);
        assert!(is_zip(&file).unwrap());
        // directories first, then names in UTF-16 order (😀 before ～), the excluded one left out
        assert_eq!(
            names(&data),
            [
                "world/",
                "world/empty",
                "world/level.dat",
                "world/région/",
                "world/région/日本/",
                "world/région/日本/r.0.0.mca",
                "world/session.lock.d/",
                "world/😀",
                "world/\u{ff5e}",
            ]
        );
        assert_eq!(made.entries, 9);
        let out = dir.join(format!("out{zip64}"));
        assert_eq!(extract(&file, &out).unwrap(), 5);
        assert_eq!(
            std::fs::read(out.join("world/level.dat")).unwrap(),
            vec![42u8; 300_000]
        );
        assert_eq!(
            std::fs::read(out.join("world/région/日本/r.0.0.mca")).unwrap(),
            b"chunk"
        );
        assert_eq!(std::fs::read(out.join("world/😀")).unwrap(), b"astral");
        assert!(out.join("world/session.lock.d").is_dir());
        assert!(!out.join("world/session.lock").exists());
        // the jar readers see the same entries in a small archive (zip64 they decline)
        let listed = jar::entry_list(&file).unwrap();
        if zip64 {
            assert!(listed.is_empty());
        } else {
            assert_eq!(listed.len(), 9);
            assert_eq!(
                jar::read_entry(&file, "world/région/日本/r.0.0.mca")
                    .unwrap()
                    .as_deref(),
                Some(&b"chunk"[..])
            );
            assert_eq!(
                jar::read_entry(&file, "world/level.dat").unwrap().unwrap(),
                vec![42u8; 300_000]
            );
            assert_eq!(jar::read_entry(&file, "nope").unwrap(), None);
        }
    }
}

#[test]
fn hostile_names_are_refused_before_anything_is_written() {
    let dir = scratch("hostile");
    for name in ["../evil", "/abs", "C:x", "a\\..\\..\\x", "", "a/../../b"] {
        let file = dir.join("h.zip");
        std::fs::write(&file, raw_zip(&[raw_entry("fine", b"1"), raw_entry(name, b"2")])).unwrap();
        let out = dir.join("out");
        let err = extract(&file, &out).unwrap_err();
        assert_eq!(
            err.message(),
            format!("the archive tried to write outside its folder (\"{name}\"); nothing more was extracted")
        );
        // the jar extraction confines what the mapping gives
        if !name.is_empty() {
            let err = jar::extract(&file, &dir.join("jar"), |n| Some(n.to_string()));
            if name.contains("../") || name.starts_with('/') || (cfg!(windows) && name.contains("..\\")) {
                assert!(err.is_err(), "{name}");
            }
        }
        let _ = std::fs::remove_dir_all(&out);
    }
}

#[test]
fn damage_is_named_as_node_names_it() {
    let dir = scratch("damage");
    let file = dir.join("d.zip");
    let check = |bytes: Vec<u8>, want: &str| {
        std::fs::write(&file, bytes).unwrap();
        let out = dir.join("o");
        let _ = std::fs::remove_dir_all(&out);
        assert_eq!(
            extract(&file, &out).unwrap_err().stderr_text(),
            format!("{want}\n")
        );
    };
    check(b"short".to_vec(), "error: that file is too small to be a zip");
    check(vec![0u8; 100], "error: that file is not a zip archive");
    let mut e = raw_entry("secret", b"x");
    e.flags |= 1;
    check(
        raw_zip(&[e]),
        "error: \"secret\" is encrypted; password-protected zips cannot be imported",
    );
    let mut e = raw_entry("lzma", b"x");
    e.method = 14;
    check(
        raw_zip(&[e]),
        "error: \"lzma\" uses a compression this cannot read (method 14)",
    );
    let mut e = raw_entry("bad", b"hello");
    e.crc ^= 1;
    check(
        raw_zip(&[e]),
        "error: \"bad\" did not match its checksum; the archive is damaged and nothing more was extracted",
    );
    assert!(!dir.join("o/bad").exists());
    let mut e = raw_entry("junk", b"\xff\xff\xff");
    e.method = 8;
    check(
        raw_zip(&[e]),
        "error: \"junk\" did not match its checksum; the archive is damaged and nothing more was extracted",
    );
    // the index claims more than the file holds
    let mut bytes = raw_zip(&[raw_entry("a", b"1")]);
    let n = bytes.len();
    bytes[n - 6..n - 2].copy_from_slice(&1000u32.to_le_bytes());
    check(
        bytes,
        "error: the zip index points past the end of the file; the archive is cut short",
    );
    // an extra field that runs past the index: Node's Buffer throws
    let mut bytes = raw_zip(&[raw_entry("a", b"1")]);
    let cd_at = u32::from_le_bytes(bytes[bytes.len() - 6..bytes.len() - 2].try_into().unwrap()) as usize;
    bytes[cd_at + 30..cd_at + 32].copy_from_slice(&8u16.to_le_bytes());
    check(
        bytes,
        "RangeError [ERR_OUT_OF_RANGE]: The value of \"offset\" is out of range. It must be >= 0 and <= 45. Received 47",
    );
    // a link is not recreated
    let mut e = raw_entry("link", b"/etc/passwd");
    e.attributes = 0o120777 << 16;
    std::fs::write(&file, raw_zip(&[e, raw_entry("f", b"1")])).unwrap();
    let out = dir.join("links");
    assert_eq!(extract(&file, &out).unwrap(), 1);
    assert!(std::fs::symlink_metadata(out.join("link")).is_err());
}

#[test]
fn the_jar_extraction_maps_and_reports() {
    let dir = scratch("jar");
    let file = dir.join("j.jar");
    std::fs::write(
        &file,
        raw_zip(&[
            raw_entry("data/", b""),
            raw_entry("data/a.txt", b"A"),
            raw_entry("meta", b"M"),
            raw_entry("data/sub\\b.txt", b"B"),
        ]),
    )
    .unwrap();
    let out = dir.join("out");
    let written = jar::extract(&file, &out, |n| n.strip_prefix("data/").map(str::to_string)).unwrap();
    assert_eq!(written, ["a.txt", "sub/b.txt"]);
    assert_eq!(std::fs::read(out.join("a.txt")).unwrap(), b"A");
    let mut e = raw_entry("odd", b"x");
    e.method = 12;
    std::fs::write(&file, raw_zip(&[e])).unwrap();
    assert_eq!(
        jar::extract(&file, &out, |n| Some(n.to_string()))
            .unwrap_err()
            .message(),
        "could not read \"odd\" out of j.jar"
    );
    assert_eq!(jar::read_entry(&file, "odd").unwrap(), None);
    let mut e = raw_entry("cut", b"\x01");
    e.method = 8;
    std::fs::write(&file, raw_zip(&[e])).unwrap();
    assert_eq!(
        jar::read_entry(&file, "cut").unwrap_err().stderr_text(),
        "Error: unexpected end of file\n"
    );
}

/// The fuzz targets' body, run over mutations of a few archives on the stable toolchain: no
/// reader may panic, loop or allocate without bound, whatever the bytes.
#[test]
fn mutated_archives_never_panic() {
    let dir = scratch("fuzz");
    std::fs::create_dir_all(dir.join("w/d")).unwrap();
    std::fs::write(dir.join("w/d/f"), vec![b'z'; 5000]).unwrap();
    std::fs::write(dir.join("w/g"), b"small").unwrap();
    let cwd = dir.to_string_lossy().into_owned();
    let mut seeds = vec![raw_zip(&[raw_entry("a", b"1"), raw_entry("b/", b"")])];
    for zip64 in [false, true] {
        let file = dir.join("s.zip");
        create(&file, &cwd, &["w"], &[], zip64).unwrap();
        seeds.push(std::fs::read(&file).unwrap());
    }
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for round in 0..4000 {
        let mut data = seeds[round % seeds.len()].clone();
        for _ in 0..(1 + next() % 8) {
            let at = (next() as usize) % data.len();
            match next() % 4 {
                0 => data[at] = next() as u8,
                1 => data[at] = 0xff,
                2 => data.truncate(at.max(1)),
                _ => data.insert(at, next() as u8),
            }
        }
        fuzz_read(&data, 1 << 20);
    }
}
