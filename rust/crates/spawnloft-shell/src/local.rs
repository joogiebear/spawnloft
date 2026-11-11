//! Small things the window needs from the machine: the shell log, the config folder files carried
//! over from Electron, and a JSON GET to the panel the window is showing.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

/// `<data root>/run`, where the panel keeps `panel.log`; the shell's log sits beside it so
/// `doctor` and a diagnostics bundle find both in one place.
pub fn run_dir() -> PathBuf {
    spawnloft_lib::paths::resolve_data_root().join("run")
}

/// `<config>` (installer design section 7): `%APPDATA%\spawnloft`, `~/.config/spawnloft`.
pub fn config_dir() -> PathBuf {
    spawnloft_lib::paths::config_dir()
}

const LOG_LIMIT: u64 = 1024 * 1024;

/// One line in `run/shell.log` (and in `SPAWNLOFT_SPIKE_LOG` when CI names one). Kept to about a
/// megabyte: past it the file moves to `shell.log.1` and starts again.
pub fn log(msg: &str) {
    let line = format!("[{}] {msg}\n", spawnloft_lib::time::iso_now());
    if let Some(path) = std::env::var_os("SPAWNLOFT_SPIKE_LOG") {
        append(Path::new(&path), &line);
    }
    let dir = run_dir();
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("shell.log");
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > LOG_LIMIT) {
        let _ = std::fs::rename(&file, dir.join("shell.log.1"));
    }
    append(&file, &line);
}

fn append(path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// `run/panel.log`, opened for appending, for the core's stderr (and the Node panel's under it):
/// what used to be thrown away is where `doctor` and the panel already look.
pub fn panel_log() -> Option<std::fs::File> {
    let dir = run_dir();
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("panel.log"))
        .ok()
}

/// macOS and Linux: Electron kept its window files in its own folder (`~/Library/Application
/// Support/SpawnLoft`, `~/.config/SpawnLoft`); copy them once into `<config>` (installer design
/// section 7). On Windows the two are one NTFS folder already, so there is nothing to do.
pub fn carry_over_electron_files() {
    if cfg!(windows) {
        return;
    }
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let electron = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/SpawnLoft")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .filter(|p| !p.is_empty())
            .map_or_else(|| home.join(".config"), PathBuf::from)
            .join("SpawnLoft")
    };
    let to = config_dir();
    if electron == to {
        return;
    }
    for name in ["window-state.json", "launcher-window-state.json", "ui-zoom.json"] {
        let (src, dst) = (electron.join(name), to.join(name));
        if src.is_file() && !dst.exists() {
            let _ = std::fs::create_dir_all(&to);
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

/// GET `path` from the panel at `addr` and parse the JSON body. Addressed by Host as the window
/// is (`127.0.0.1:<port>`), so the panel's own localhost rule lets it through.
pub fn panel_get(addr: SocketAddr, path: &str) -> Result<Value, String> {
    let mut conn =
        TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("connect: {e}"))?;
    conn.set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|e| e.to_string())?;
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        addr.port()
    );
    conn.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    conn.take(16 * 1024 * 1024)
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no response head")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status")?;
    let mut body = raw[split + 4..].to_vec();
    if head
        .lines()
        .any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"))
    {
        body = dechunk(&body).ok_or("bad chunked body")?;
    }
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    serde_json::from_slice(&body).map_err(|e| format!("not JSON: {e}"))
}

fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let eol = b.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&b[..eol]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        b = &b[eol + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(b.get(..size)?);
        b = b.get(size + 2..)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dechunks() {
        assert_eq!(
            dechunk(b"4\r\nWiki\r\n5;x=1\r\npedia\r\n0\r\n\r\n").unwrap(),
            b"Wikipedia"
        );
        assert!(dechunk(b"9\r\nshort\r\n").is_none());
    }

    #[test]
    fn gets_json_from_a_local_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = c.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("GET /api/setup HTTP/1.1\r\n"));
            assert!(req.contains(&format!("Host: 127.0.0.1:{}\r\n", addr.port())));
            c.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nb\r\n{\"needed\":1\r\n1\r\n}\r\n0\r\n\r\n")
                .unwrap();
        });
        let v = panel_get(addr, "/api/setup").unwrap();
        assert_eq!(v["needed"], 1);
    }
}
