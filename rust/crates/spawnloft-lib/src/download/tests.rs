use super::*;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// One scripted answer of the test server.
#[derive(Clone)]
enum Reply {
    /// status, body
    Full(u16, Vec<u8>),
    /// headers announcing `len`, then `sent` bytes of the body, then silence for `hold`
    Stall {
        len: usize,
        sent: Vec<u8>,
        hold: Duration,
    },
    /// a redirect to a path on the same server
    Redirect(&'static str),
}

/// A plain-HTTP server on loopback that answers requests in order from `script` (the last
/// answer repeats) and records each request line and User-Agent.
struct Server {
    base: String,
    hits: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<String>>>,
}

fn serve(script: Vec<Reply>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (h, s) = (hits.clone(), seen.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let n = h.fetch_add(1, Ordering::SeqCst);
            let reply = script[n.min(script.len() - 1)].clone();
            let s = s.clone();
            std::thread::spawn(move || answer(stream, reply, &s));
        }
    });
    Server { base, hits, seen }
}

fn answer(mut stream: TcpStream, reply: Reply, seen: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
            break;
        }
        head.push_str(&line);
    }
    seen.lock().unwrap().push(head);
    let reason = |s: u16| if s == 200 { "OK" } else { "X" };
    match reply {
        Reply::Full(status, body) => {
            let _ = write!(
                stream,
                "HTTP/1.1 {status} {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reason(status),
                body.len()
            );
            let _ = stream.write_all(&body);
        }
        Reply::Stall { len, sent, hold } => {
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(&sent);
            let _ = stream.flush();
            std::thread::sleep(hold);
        }
        Reply::Redirect(to) => {
            let _ = write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("spawnloft-dl-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn leftovers(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".part"))
        .collect()
}

const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

#[test]
fn a_download_is_hashed_named_and_reported() {
    let srv = serve(vec![
        Reply::Redirect("/real"),
        Reply::Full(200, b"hello".to_vec()),
    ]);
    let dir = scratch("ok");
    let dest = dir.join("server.jar");
    let mut progress = Vec::new();
    let mut on = |r, t| progress.push((r, t));
    let done = download_file(
        &format!("{}/start", srv.base),
        &dest,
        Options {
            hash: Some(Hash::Sha256),
            expected: Some(HELLO_SHA256.to_uppercase()),
            on_progress: Some(&mut on),
            ..Options::default()
        },
    )
    .unwrap();
    assert_eq!(
        done,
        Downloaded {
            size: 5,
            size_human: "5 B".into()
        }
    );
    assert_eq!(std::fs::read(&dest).unwrap(), b"hello");
    assert_eq!(progress.last(), Some(&(5, 5)));
    assert!(leftovers(&dir).is_empty());
    let seen = srv.seen.lock().unwrap().join("");
    assert!(seen.contains("GET /real "), "{seen}");
    assert!(
        seen.to_ascii_lowercase()
            .contains(&format!("user-agent: {}", UA.to_ascii_lowercase())),
        "{seen}"
    );
}

#[test]
fn a_wrong_checksum_or_a_short_body_leaves_nothing() {
    let srv = serve(vec![Reply::Full(200, b"hellp".to_vec())]);
    let dir = scratch("sum");
    let dest = dir.join("a.jar");
    let err = download_file(
        &format!("{}/a", srv.base),
        &dest,
        Options {
            hash: Some(Hash::Sha256),
            expected: Some(HELLO_SHA256.into()),
            label: Some("Paper 1.21".into()),
            ..Options::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.json_code(), "checksum-mismatch");
    assert!(
        err.message().starts_with(&format!(
            "checksum mismatch for Paper 1.21\n  expected {HELLO_SHA256}\n  got      "
        )),
        "{err:?}"
    );
    assert_eq!(
        srv.hits.load(Ordering::SeqCst),
        1,
        "a wrong checksum is not asked again"
    );
    let err = download_file(
        &format!("{}/a", srv.base),
        &dest,
        Options {
            min_bytes: 1024,
            label: Some("x".into()),
            ..Options::default()
        },
    )
    .unwrap_err();
    assert_eq!(
        err.stderr_text(),
        "error: x came back 5 B, which is not a server jar\n"
    );
    assert!(!dest.exists());
    assert!(leftovers(&dir).is_empty());
}

#[test]
fn a_refusal_is_reported_at_once_and_a_busy_server_asked_again() {
    let srv = serve(vec![Reply::Full(404, Vec::new())]);
    let dir = scratch("404");
    let url = format!("{}/gone", srv.base);
    let err = download_file(
        &url,
        &dir.join("g"),
        Options {
            label: Some("g".into()),
            ..Options::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.message(), format!("download of g failed (404) from {url}"));
    assert_eq!(err.json_code(), "download-failed");
    assert_eq!(srv.hits.load(Ordering::SeqCst), 1);

    let srv = serve(vec![
        Reply::Full(503, Vec::new()),
        Reply::Full(200, b"ok".to_vec()),
    ]);
    let dest = dir.join("busy");
    download_file(&format!("{}/b", srv.base), &dest, Options::default()).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"ok");
    assert_eq!(srv.hits.load(Ordering::SeqCst), 2);
}

#[test]
fn a_stalled_download_is_asked_again_then_given_up() {
    let srv = serve(vec![Reply::Stall {
        len: 100,
        sent: b"part".to_vec(),
        hold: Duration::from_secs(5),
    }]);
    let dir = scratch("stall");
    let err = download_file(
        &format!("{}/s", srv.base),
        &dir.join("s"),
        Options {
            label: Some("s".into()),
            stall: Duration::from_millis(600),
            attempts: 2,
            retry_delay: Duration::from_millis(10),
            ..Options::default()
        },
    )
    .unwrap_err();
    assert_eq!(
        err.message(),
        "download of s failed: nothing arrived for 1 seconds"
    );
    assert_eq!(err.json_code(), "download-failed");
    assert_eq!(srv.hits.load(Ordering::SeqCst), 2);
    assert!(leftovers(&dir).is_empty());
}

#[test]
fn a_cancelled_job_stops_the_download_and_clears_its_part() {
    let srv = serve(vec![Reply::Stall {
        len: 1 << 20,
        sent: vec![b'x'; 70_000],
        hold: Duration::from_secs(3),
    }]);
    let dir = scratch("cancel");
    let token = cancel::Token::new();
    let t = token.clone();
    let mut on = move |r: u64, _| {
        if r > 0 {
            t.cancel();
        }
    };
    let err = cancel::with_cancel(Some(token), || {
        download_file(
            &format!("{}/c", srv.base),
            &dir.join("c"),
            Options {
                on_progress: Some(&mut on),
                ..Options::default()
            },
        )
    })
    .unwrap_err();
    assert!(cancel::is_cancelled(&err), "{err:?}");
    assert!(leftovers(&dir).is_empty());
    // a job cancelled before it starts asks nothing
    let token = cancel::Token::new();
    token.cancel();
    let before = srv.hits.load(Ordering::SeqCst);
    let err = cancel::with_cancel(Some(token), || {
        download_file(&format!("{}/c", srv.base), &dir.join("c"), Options::default())
    })
    .unwrap_err();
    assert!(cancel::is_cancelled(&err));
    assert_eq!(srv.hits.load(Ordering::SeqCst), before);
}

#[test]
fn capped_fetches_stop_at_the_cap() {
    let srv = serve(vec![Reply::Full(200, vec![7u8; 2048])]);
    let url = format!("{}/list", srv.base);
    let quick = Duration::from_millis(10);
    let got = fetch_capped(&url, 4096, Duration::from_secs(10), 2, quick, "the list").unwrap();
    assert_eq!(got.len(), 2048);
    let err = fetch_capped(&url, 1000, Duration::from_secs(10), 2, quick, "the list").unwrap_err();
    assert_eq!(err.message(), "the list is larger than 1000 B");
    assert_eq!(err.json_code(), "too-large");

    let srv = serve(vec![Reply::Full(503, Vec::new())]);
    let err = fetch_capped(
        &format!("{}/l", srv.base),
        10,
        Duration::from_secs(10),
        2,
        quick,
        "L",
    )
    .unwrap_err();
    assert_eq!(err.message(), "L answered 503");
    assert_eq!(srv.hits.load(Ordering::SeqCst), 2);

    let srv = serve(vec![Reply::Stall {
        len: 10,
        sent: Vec::new(),
        hold: Duration::from_secs(5),
    }]);
    let err = fetch_capped(
        &format!("{}/t", srv.base),
        100,
        Duration::from_millis(500),
        1,
        quick,
        "T",
    )
    .unwrap_err();
    assert_eq!(err.message(), "could not read T: timed out after 0.5 s");
}

#[test]
fn json_is_read_or_refused() {
    let srv = serve(vec![Reply::Full(200, br#"{"b":1,"a":[2]}"#.to_vec())]);
    let v = fetch_json(&format!("{}/j", srv.base), "the index").unwrap();
    assert_eq!(crate::jsjson::stringify(&v), r#"{"b":1,"a":[2]}"#);
    let srv = serve(vec![Reply::Full(500, Vec::new())]);
    assert_eq!(
        fetch_json(&format!("{}/j", srv.base), "the index")
            .unwrap_err()
            .stderr_text(),
        "error: the index answered 500\n"
    );
    let srv = serve(vec![Reply::Full(200, b"<html>".to_vec())]);
    let err = fetch_json(&format!("{}/j", srv.base), "x").unwrap_err();
    assert!(err.stderr_text().starts_with("SyntaxError: "), "{err:?}");
}

#[test]
fn part_names_are_per_attempt() {
    let a = part_path(Path::new("/x/server.jar"));
    let b = part_path(Path::new("/x/server.jar"));
    assert_ne!(a, b);
    let name = a.file_name().unwrap().to_string_lossy().into_owned();
    let pid = std::process::id().to_string();
    let rest = name.strip_prefix(&format!("server.jar.{pid}-")).unwrap();
    let hex = rest.strip_suffix(".part").unwrap();
    assert_eq!(hex.len(), 8);
    assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
}

/// The C1 proxy check (plan section 7): with every proxy variable pointing at a port that
/// refuses, a default `ureq` agent would go to that proxy, and the download agent goes straight
/// to the server, as Node's `fetch` does. Run in a child process, so the variables are set for it
/// alone; a no-op unless SPAWNLOFT_TEST_PROXY_CHILD is set.
#[test]
fn proxy_check_child() {
    if std::env::var_os("SPAWNLOFT_TEST_PROXY_CHILD").is_none() {
        return;
    }
    assert!(
        ureq::Agent::new_with_defaults().config().proxy().is_some(),
        "a default ureq agent reads the proxy variables"
    );
    assert!(agent(|b| b).config().proxy().is_none());
    let srv = serve(vec![Reply::Full(200, b"direct".to_vec())]);
    let dir = scratch("proxy");
    let dest = dir.join("d");
    download_file(&format!("{}/d", srv.base), &dest, Options::default()).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"direct");
    assert_eq!(
        fetch_capped(
            &format!("{}/d", srv.base),
            100,
            Duration::from_secs(5),
            1,
            Duration::ZERO,
            "d"
        )
        .unwrap(),
        b"direct"
    );
}

#[test]
fn proxy_variables_are_ignored_as_node_ignores_them() {
    let refusing = TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy = format!("http://{}", refusing.local_addr().unwrap());
    drop(refusing);
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args([
        "--exact",
        "download::tests::proxy_check_child",
        "--nocapture",
        "--test-threads=1",
    ])
    .env("SPAWNLOFT_TEST_PROXY_CHILD", "1")
    .env_remove("NO_PROXY")
    .env_remove("no_proxy");
    for var in [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        cmd.env(var, &proxy);
    }
    let out = cmd.output().unwrap();
    assert!(
        out.status.success() && String::from_utf8_lossy(&out.stdout).contains("1 passed"),
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
