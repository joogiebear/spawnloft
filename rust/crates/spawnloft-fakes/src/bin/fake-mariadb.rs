//! Test-only: the MariaDB tools for the installer scenarios (installer.yml), a native port of
//! test/fixtures/fake-mariadb/bin/*.mjs. One program, copied under each tool's name into an
//! engine's `bin/` (`mariadbd`, `mariadb`, `mariadb-admin`, `mariadb-dump`, `mariadb-install-db`,
//! `.exe` on Windows): both cores look there for `<name>.exe`, then `<name>`, then `<name>.mjs`,
//! and a release 2.0 core runs no `.mjs`. Run as `fake-mariadb <tool> <args...>` it plays that
//! tool, which is how its tests run it.
//!
//! mariadbd --console reads the port and data folder from the ini, listens on loopback, says
//! "ready for connections" on stderr the way the real one does, takes no stdin, and speaks a
//! one-line protocol the fake admin, client and dump use:
//!
//!   shutdown          exit 0 after saying so (and a line in <datadir>/fake-shutdowns.log, which
//!                     outlives the console log a restart starts again)
//!   sql <base64>      append the statements to <datadir>/sql.log, answer "ok"
//!   dump <base64 db>  answer "ok <base64 dump text>" and close, the way a dump streams
//!
//! FAKE_MARIADB_FAIL=start makes it die during startup the way a taken port does.
//! FAKE_MARIADB_STABLE_DUMP=1 leaves the time out of a dump, so two runs dump the same bytes.
//! The admin, client and dump refuse without a password in MYSQL_PWD.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::exit;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Lenient, as Node's Buffer.from(s, 'base64') is: what is not base64 is skipped.
fn b64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let Some(v) = B64.iter().position(|&b| b == c) else {
            continue;
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The value of `--<key>=` among the arguments.
fn arg<'a>(args: &'a [String], key: &str) -> Option<&'a str> {
    let prefix = format!("--{key}=");
    args.iter().find_map(|a| a.strip_prefix(prefix.as_str()))
}

fn port_of(args: &[String]) -> u16 {
    arg(args, "port").and_then(|p| p.parse().ok()).unwrap_or(0)
}

fn connect(args: &[String], who: &str, prefix: &str) -> TcpStream {
    match TcpStream::connect(("127.0.0.1", port_of(args))) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{who}: {prefix}{e}");
            exit(1)
        }
    }
}

fn note(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "2026-09-05 12:00:00 0 [Note] mariadbd: {line}");
    let _ = err.flush();
}

fn mariadbd(args: &[String]) -> ! {
    let text = arg(args, "defaults-file")
        .and_then(|ini| std::fs::read_to_string(ini).ok())
        .unwrap_or_default();
    let value = |key: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(key))
            .map(|v| v.trim_end_matches('\r').to_string())
    };
    let port: u16 = value("port=")
        .and_then(|v| {
            let digits: String = v.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .unwrap_or(0);
    let datadir = value("datadir=")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();

    note(&format!("Starting fake MariaDB {}", args.join(" ")));
    if std::env::var("FAKE_MARIADB_FAIL").as_deref() == Ok("start") {
        eprintln!("2026-09-05 12:00:00 0 [ERROR] Can't start server: Bind on TCP/IP port. Got error: 10048");
        eprintln!("2026-09-05 12:00:00 0 [ERROR] Aborting");
        exit(1);
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("2026-09-05 12:00:00 0 [ERROR] Can't start server: {e}");
            exit(1)
        }
    };
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(150));
        note("ready for connections.");
    });
    for socket in listener.incoming().flatten() {
        let datadir = datadir.clone();
        std::thread::spawn(move || serve(socket, &datadir));
    }
    exit(1)
}

fn serve(socket: TcpStream, datadir: &str) {
    let Ok(mut out) = socket.try_clone() else {
        return;
    };
    let dir = Path::new(datadir);
    for line in BufReader::new(socket).lines() {
        let Ok(line) = line else { return };
        let line = line.trim();
        if line == "shutdown" {
            note("Normal shutdown");
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("fake-shutdowns.log"))
            {
                // otherwise the console line is the evidence
                let _ = writeln!(f, "{{\"pid\":{},\"at\":{}}}", std::process::id(), now_ms());
            }
            let _ = out.write_all(b"ok\n");
            let _ = out.shutdown(std::net::Shutdown::Write);
            std::thread::sleep(Duration::from_millis(50));
            exit(0);
        } else if let Some(sql) = line.strip_prefix("sql ") {
            let sql = String::from_utf8_lossy(&b64_decode(sql)).into_owned();
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("sql.log"))
            {
                let _ = writeln!(f, "{sql}");
            }
            let _ = out.write_all(b"ok\n");
        } else if let Some(db) = line.strip_prefix("dump ") {
            let db = String::from_utf8_lossy(&b64_decode(db)).into_owned();
            let stamp = if std::env::var("FAKE_MARIADB_STABLE_DUMP").as_deref() == Ok("1") {
                String::new()
            } else {
                format!("-- dumped at {}\n", now_ms())
            };
            let text = format!(
                "-- MariaDB dump (fake) of {db}\nCREATE DATABASE IF NOT EXISTS `{db}`;\nUSE `{db}`;\n{stamp}"
            );
            let _ = out.write_all(format!("ok {}\n", b64_encode(text.as_bytes())).as_bytes());
            let _ = out.shutdown(std::net::Shutdown::Both);
            return;
        } else {
            let _ = out.write_all(b"error unknown\n");
        }
    }
}

fn admin(args: &[String]) -> ! {
    if std::env::var_os("MYSQL_PWD").is_none_or(|p| p.is_empty()) {
        eprintln!("fake admin: Access denied (no password)");
        exit(1);
    }
    if args.last().map(String::as_str) != Some("shutdown") {
        exit(2);
    }
    let mut s = connect(args, "fake admin", "");
    let _ = s.write_all(b"shutdown\n");
    let mut b = [0u8; 64];
    match s.read(&mut b) {
        Ok(n) if n > 0 => exit(0),
        Ok(_) => exit(1),
        Err(e) => {
            eprintln!("fake admin: {e}");
            exit(1)
        }
    }
}

fn client(args: &[String]) -> ! {
    if std::env::var_os("MYSQL_PWD").is_none_or(|p| p.is_empty()) {
        eprintln!("fake client: ERROR 1045 (28000): Access denied for user 'root'@'localhost'");
        exit(1);
    }
    // --execute carries the statements; without it they arrive on stdin, the way an import does
    let text = match args.iter().position(|a| a == "--execute") {
        Some(i) => args.get(i + 1).cloned().unwrap_or_default(),
        None => {
            let mut b = String::new();
            let _ = std::io::stdin().read_to_string(&mut b);
            b
        }
    };
    let mut s = connect(args, "fake client", "ERROR 2002: Can't connect ");
    let _ = s.write_all(format!("sql {}\n", b64_encode(text.as_bytes())).as_bytes());
    let mut b = [0u8; 64];
    match s.read(&mut b) {
        Ok(n) if b[..n].starts_with(b"ok") => exit(0),
        _ => exit(1),
    }
}

fn dump(args: &[String]) -> ! {
    if std::env::var_os("MYSQL_PWD").is_none_or(|p| p.is_empty()) {
        eprintln!("fake dump: Access denied for user 'root'@'localhost'");
        exit(1);
    }
    let Some(db) = args
        .iter()
        .position(|a| a == "--databases")
        .and_then(|i| args.get(i + 1))
    else {
        exit(2)
    };
    let mut s = connect(args, "fake dump", "");
    let _ = s.write_all(format!("dump {}\n", b64_encode(db.as_bytes())).as_bytes());
    let mut buf = String::new();
    if let Err(e) = s.read_to_string(&mut buf) {
        eprintln!("fake dump: {e}");
        exit(1);
    }
    let Some(body) = buf.trim().strip_prefix("ok ") else {
        eprintln!("fake dump: server refused");
        exit(1)
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&b64_decode(body));
    let _ = out.flush();
    exit(0)
}

fn install_db(args: &[String]) -> ! {
    let Some(datadir) = arg(args, "datadir") else {
        eprintln!("fake install-db: --datadir is required");
        exit(2)
    };
    let dir = Path::new(datadir);
    let _ = std::fs::create_dir_all(dir.join("mysql"));
    let _ = std::fs::write(dir.join("root.txt"), arg(args, "password").unwrap_or(""));
    let _ = std::fs::write(dir.join("port.txt"), arg(args, "port").unwrap_or(""));
    println!("fake install-db: done");
    exit(0)
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut tool = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if tool == "fake-mariadb" && !args.is_empty() {
        tool = args.remove(0);
    }
    match tool.as_str() {
        "mariadbd" | "mysqld" => mariadbd(&args),
        "mariadb-admin" | "mysqladmin" => admin(&args),
        "mariadb" | "mysql" => client(&args),
        "mariadb-dump" | "mysqldump" => dump(&args),
        "mariadb-install-db" | "mysql_install_db" => install_db(&args),
        other => {
            eprintln!("fake-mariadb: no tool named {other:?}");
            exit(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{b64_decode, b64_encode};

    #[test]
    fn base64_round_trips() {
        for s in ["", "a", "ab", "abc", "abcd", "CREATE DATABASE `x`;\n"] {
            assert_eq!(b64_decode(&b64_encode(s.as_bytes())), s.as_bytes());
        }
        assert_eq!(b64_encode(b"ab"), "YWI=");
        assert_eq!(b64_decode("YWI=\n"), b"ab");
    }
}
