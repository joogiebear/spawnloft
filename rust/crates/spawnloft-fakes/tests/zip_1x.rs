//! Archives the 1.x writer made (src/zip.mjs of v1.6.0-beta.413, the same as 1.5.0's), frozen in
//! rust/fuzz/seeds/zip_read: the Rust reader must still list and extract a 1.x backup or export
//! byte for byte. They also seed the zip_read fuzz target (rust-internal.yml zip-fuzz).
//!
//! Made on Linux with Node 22 from a tree of: w/level.dat ("level " x 500), w/d/ü.txt ("hi\n"),
//! w/empty (0 bytes), w/region/r.0.0.mca (4096 bytes of an LCG: x = (x * 1103515245 + 12345) & 0x7fffffff in 32 bits, from 1, low byte), w/session.lock ("lock"); as
//! 1x.zip, 1x-zip64.zip (forceZip64) and 1x-exclude.zip (exclude session.lock).

use spawnloft_fakes::{TempDir, run};
use std::path::{Path, PathBuf};

const BIN: &str = env!("CARGO_BIN_EXE_zip-probe");

fn seeds() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fuzz/seeds/zip_read")
}

fn region() -> Vec<u8> {
    let mut x: u32 = 1;
    (0..4096)
        .map(|_| {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345) & 0x7fff_ffff;
            (x & 0xff) as u8
        })
        .collect()
}

fn expected(lock: bool) -> Vec<(&'static str, Vec<u8>)> {
    let mut files = vec![
        ("w/d/ü.txt", b"hi\n".to_vec()),
        ("w/empty", Vec::new()),
        ("w/level.dat", "level ".repeat(500).into_bytes()),
        ("w/region/r.0.0.mca", region()),
    ];
    if lock {
        files.push(("w/session.lock", b"lock".to_vec()));
    }
    files
}

fn check(zip: &str, lock: bool) {
    let file = seeds().join(zip);
    let dest = TempDir::new("zip-1x");
    let out = run(
        BIN,
        &["extract", &file.to_string_lossy(), &dest.path().to_string_lossy()],
    );
    assert_eq!(out.code, Some(0), "{zip}: {out:?}");
    let want = expected(lock);
    assert_eq!(
        out.stdout.trim(),
        format!("{{\"files\":{}}}", want.len()),
        "{zip}"
    );
    for (name, bytes) in want {
        let got = std::fs::read(dest.path().join(name)).unwrap_or_else(|e| panic!("{zip}: {name}: {e}"));
        assert_eq!(got, bytes, "{zip}: {name}");
    }
    let listed = run(BIN, &["list", &file.to_string_lossy()]);
    assert_eq!(listed.code, Some(0), "{zip}: {listed:?}");
    // directories too, each entry UTF-8 flagged as 1.x wrote them
    assert!(
        listed.stdout.contains("\"name\":\"w/d/\""),
        "{zip}: {}",
        listed.stdout
    );
    assert!(
        listed
            .stdout
            .contains("\"name\":\"w/d/ü.txt\",\"madeBy\":3,\"flags\":2048"),
        "{zip}: {}",
        listed.stdout
    );
}

#[test]
fn a_1x_zip_extracts_byte_for_byte() {
    check("1x.zip", true);
}

#[test]
fn a_1x_zip64_zip_extracts_byte_for_byte() {
    check("1x-zip64.zip", true);
}

#[test]
fn a_1x_zip_made_with_an_exclusion_extracts_byte_for_byte() {
    check("1x-exclude.zip", false);
}
