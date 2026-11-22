//! The native MariaDB stand-in (src/bin/fake-mariadb.rs) behaves as the installer scenarios
//! expect: install-db, the server's console, the client, dump and a graceful shutdown.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use spawnloft_fakes::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_fake-mariadb");

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn tool(name: &str, args: &[&str]) -> std::process::Output {
    Command::new(BIN)
        .arg(name)
        .args(args)
        .env("MYSQL_PWD", "pw")
        .output()
        .unwrap()
}

#[test]
fn installs_serves_dumps_and_shuts_down() {
    let dir = TempDir::new("fake-mariadb");
    let data = dir.path().join("data");
    let port = free_port().to_string();
    let datadir = format!("--datadir={}", data.display());
    let out = tool(
        "mariadb-install-db",
        &[&datadir, "--password=pw", &format!("--port={port}")],
    );
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(std::fs::read_to_string(data.join("root.txt")).unwrap(), "pw");
    assert!(data.join("mysql").is_dir());

    let ini = dir.path().join("my.ini");
    std::fs::write(
        &ini,
        format!("[mysqld]\nport={port}\ndatadir={}\n", data.display()),
    )
    .unwrap();
    let mut server = Command::new(BIN)
        .args([
            "mariadbd",
            &format!("--defaults-file={}", ini.display()),
            "--console",
        ])
        .env_remove("FAKE_MARIADB_FAIL")
        .env("FAKE_MARIADB_STABLE_DUMP", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut err = BufReader::new(server.stderr.take().unwrap()).lines();
    assert!(
        err.next()
            .unwrap()
            .unwrap()
            .contains("[Note] mariadbd: Starting fake MariaDB")
    );
    assert!(
        err.next()
            .unwrap()
            .unwrap()
            .ends_with("[Note] mariadbd: ready for connections.")
    );

    let p = format!("--port={port}");
    let out = tool("mariadb", &[&p, "--execute", "CREATE TABLE t (x INT);"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        std::fs::read_to_string(data.join("sql.log")).unwrap(),
        "CREATE TABLE t (x INT);\n"
    );
    let out = tool("mariadb-dump", &[&p, "--databases", "shop"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "-- MariaDB dump (fake) of shop\nCREATE DATABASE IF NOT EXISTS `shop`;\nUSE `shop`;\n"
    );
    // no password, no entry
    let refused = Command::new(BIN)
        .args(["mariadb-admin", &p, "shutdown"])
        .env_remove("MYSQL_PWD")
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1));

    let out = tool("mariadb-admin", &[&p, "shutdown"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(server.wait().unwrap().code(), Some(0));
    assert!(
        err.next()
            .unwrap()
            .unwrap()
            .ends_with("mariadbd: Normal shutdown")
    );
    let log = std::fs::read_to_string(data.join("fake-shutdowns.log")).unwrap();
    assert!(log.starts_with(&format!("{{\"pid\":{},", server.id())), "{log}");
}

#[test]
fn plays_the_tool_it_is_named_after() {
    let dir = TempDir::new("fake-mariadb");
    let exe = dir
        .path()
        .join(format!("mariadb-install-db{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(BIN, &exe).unwrap();
    let data = dir.path().join("d");
    let out = Command::new(&exe)
        .arg(format!("--datadir={}", data.display()))
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), "fake install-db: done\n");
    assert_eq!(std::fs::read_to_string(data.join("root.txt")).unwrap(), "");
}

#[test]
fn fails_at_start_when_asked() {
    let out = Command::new(BIN)
        .arg("mariadbd")
        .env("FAKE_MARIADB_FAIL", "start")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("[ERROR] Aborting"));
}
