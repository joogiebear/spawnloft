//! File writes the Node core's readers rely on: JSON replaced atomically by temp file and rename
//! (`writeJson`), with the Windows retry for a file a virus scanner or indexer is holding.

use std::path::Path;
use std::time::Duration;

/// How many times a held file is retried, with growing waits (about 1.5 s in total).
pub const RENAME_RETRIES: u32 = 5;

/// Renames over `to`, retrying while another program holds it.
pub fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied || is_busy(&e) => {
                if attempt >= RENAME_RETRIES {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(50 * 2u64.pow(attempt)));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

fn is_busy(e: &std::io::Error) -> bool {
    // ERROR_SHARING_VIOLATION (32) and ERROR_LOCK_VIOLATION (33) on Windows, EBUSY (16) elsewhere
    match e.raw_os_error() {
        Some(32) | Some(33) if cfg!(windows) => true,
        Some(16) if cfg!(unix) => true,
        _ => false,
    }
}

/// `JSON.stringify(data, null, 2)` plus a newline, written through `<file>.tmp` and a rename so a
/// reader never sees half a file.
pub fn write_json(file: &Path, data: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
    text.push('\n');
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    rename_over(&tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_pretty_json_like_node() {
        let dir = std::env::temp_dir().join(format!("sl-fsx-{}", std::process::id()));
        let file = dir.join("state.json");
        write_json(
            &file,
            &serde_json::json!({ "name": "a", "running": true, "list": [] }),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\n  \"name\": \"a\",\n  \"running\": true,\n  \"list\": []\n}\n"
        );
        assert!(!dir.join("state.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
