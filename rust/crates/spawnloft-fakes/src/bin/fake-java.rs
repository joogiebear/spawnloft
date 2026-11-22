//! Test-only: the JVM stand-in for the installer scenarios (installer.yml, installer-linux.yml),
//! in place of the installer/ci/fake-java.mjs it was ported from. A native program, so 1.x's
//! daemon and 2.0's both run it as they run a real `java`, and a 2.0 core needs no test-hooks
//! build and no Node to start it. The JVM arguments are ignored.
//!
//! In the server folder (its cwd) it keeps evidence a CI step can read after the fact:
//!   fake-starts.log   one JSON line per start: pid, the runtime that ran it (this program), time
//!   fake-exit.json    written on a graceful `stop`, never on a kill: a JVM that was terminated
//!                     leaves no such file (removed again by the next start)
//!   fake-stops.log    one JSON line per graceful stop, by pid; never removed, so it survives a
//!                     restart that rotates the console log
//! and obeys:
//!   stop   exits 0 after writing fake-exit.json; held (with a console line) while a file
//!          `ignore-stop` exists in its folder, the server that refuses to stop, and carried
//!          out once that file is removed
//!   anything else is echoed as `fake got: <line>`
//!
//! FAKE_JAVA_FAIL=start makes it die during startup the way a taken port does. Asked
//! `-version` (as both cores probe a Java that is not a script), it answers as a Java 21 of this
//! machine's architecture and exits. It keeps running when its console input closes.

use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "[00:00:00 INFO]: {line}");
    let _ = out.flush();
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// A JSON string literal, as JSON.stringify writes one.
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn append(file: &str, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{line}");
    }
}

fn stop() -> ! {
    say("Stopping server");
    say("Saving worlds");
    let pid = std::process::id();
    append(
        "fake-stops.log",
        &format!("{{\"pid\":{pid},\"at\":{}}}", now_ms()),
    );
    let _ = std::fs::write(
        "fake-exit.json",
        format!("{{\"pid\":{pid},\"graceful\":true,\"at\":{}}}", now_ms()),
    );
    std::process::exit(0)
}

/// What `java -XshowSettings:properties -version` prints, on stderr as a JVM does.
fn version() -> ! {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "x86" => "x86",
        other => other,
    };
    eprintln!("Property settings:\n    os.arch = {arch}\n");
    eprintln!("openjdk version \"21.0.2\" 2024-01-16");
    eprintln!("OpenJDK Runtime Environment (fake)");
    std::process::exit(0)
}

fn main() {
    if std::env::args()
        .skip(1)
        .any(|a| a == "-version" || a == "--version")
    {
        version();
    }

    let runtime = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    append(
        "fake-starts.log",
        &format!(
            "{{\"pid\":{},\"runtime\":{},\"at\":{}}}",
            std::process::id(),
            json_str(&runtime),
            now_ms()
        ),
    );
    // a later stop writes it again
    let _ = std::fs::remove_file("fake-exit.json");

    say("Starting minecraft server (fake)");
    if std::env::var("FAKE_JAVA_FAIL").as_deref() == Ok("start") {
        say("Failed to start the minecraft server");
        std::process::exit(1);
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(150));
        say("Done (0.042s)! For help, type \"help\"");
    });

    static PENDING: AtomicBool = AtomicBool::new(false);
    let stdin = std::io::stdin();
    for raw in stdin.lock().lines() {
        let Ok(raw) = raw else { break };
        let line = raw.trim();
        if line == "stop" {
            if Path::new("ignore-stop").exists() {
                // a save that takes as long as the file stays: the stop finishes once it is
                // removed (a daemon that already sent stop does not send it again)
                say("fake: holding the stop (ignore-stop is present)");
                if !PENDING.swap(true, Ordering::SeqCst) {
                    std::thread::spawn(|| {
                        loop {
                            std::thread::sleep(Duration::from_millis(250));
                            if !Path::new("ignore-stop").exists() {
                                stop();
                            }
                        }
                    });
                }
                continue;
            }
            stop();
        }
        say(&format!("fake got: {line}"));
    }
    // the console closed: a server keeps running until it is told to stop or is killed
    loop {
        std::thread::park();
    }
}
