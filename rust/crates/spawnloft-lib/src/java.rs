//! `java.mjs`, the server side: asking a Java its version (`probe`), finding every Java on the
//! machine (`discover`), and the Java a Minecraft version needs (`requiredMajor`). The game
//! client's choice (`pickClientJava`) moves with C7, `pickJava` with C4.

use regex::Regex;
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::time::Duration;

/// Minecraft 26.x needs 25, 1.21.x 21 and older versions 17, which is why 17 is the floor.
pub const RECOMMENDED_MAJOR: u32 = 25;
pub const MINIMUM_MAJOR: u32 = 17;
pub const DOWNLOAD_URL: &str = "https://adoptium.net/temurin/releases/?version=25";

const PROBE_TIMEOUT_MS: u64 = 8000;

/// What `probe` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub ok: bool,
    pub found: bool,
    pub major: Option<u32>,
    pub version: Option<String>,
    pub arch: Option<String>,
    pub reason: &'static str,
    pub message: String,
}

/// A Java found by [`discover`]: where, how it was found, and its probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub path: String,
    pub source: String,
    pub probe: Probe,
}

/// `parseMajor(text)`: `openjdk version "21.0.5"`, and the pre-9 `java version "1.8.0_401"`
/// whose major is the second number.
pub fn parse_major(text: &str) -> Option<u32> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"version "([0-9]+)(?:\.([0-9]+))?[^"]*""#).expect("valid"));
    let m = RE.captures(text)?;
    let first: f64 = m[1].parse().ok()?;
    let as_u32 = |f: f64| (f.is_finite() && f <= f64::from(u32::MAX)).then_some(f as u32);
    if first == 1.0 {
        return m
            .get(2)
            .and_then(|s| s.as_str().parse::<f64>().ok())
            .and_then(as_u32);
    }
    as_u32(first)
}

/// `parseArch(text)`: the `os.arch` line of `-XshowSettings:properties` in the client's names.
pub fn parse_arch(text: &str) -> Option<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*os\.arch[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*=[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]*([^\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+)")
            .expect("valid")
    });
    let raw = RE.captures(text)?[1].to_lowercase();
    static X86: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^i[3-6]86$").expect("valid"));
    Some(match raw.as_str() {
        "amd64" | "x86_64" => "x64".into(),
        "aarch64" | "arm64" => "arm64".into(),
        "x86" => "x86".into(),
        r if X86.is_match(r) => "x86".into(),
        _ => raw,
    })
}

/// How one run of the JVM ended, as `execFile` reports it.
enum Run {
    Done {
        stdout: String,
        stderr: String,
    },
    Missing,
    TimedOut,
    Exit(i32),
    /// spawned but could not run, or ended by a signal: `error.message`
    Error(String),
}

fn run(bin: &str, args: &[&str]) -> Run {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::hide_window(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let (code, _) = crate::jspath::error_code(&e);
            return if code == "ENOENT" {
                Run::Missing
            } else {
                Run::Error(format!("spawn {bin} {code}"))
            };
        }
    };
    // execFile's timeout covers the streams too: a wrapper that leaves a grandchild holding the
    // pipes must not hold the probe past its deadline, so the readers report on a channel
    let (tx, rx) = std::sync::mpsc::channel::<(usize, String)>();
    let take = |i: usize, r: Option<Box<dyn std::io::Read + Send>>| {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            let _ = tx.send((i, String::from_utf8_lossy(&buf).into_owned()));
        });
    };
    take(
        0,
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    );
    take(
        1,
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    );
    drop(tx);
    let deadline = std::time::Instant::now() + Duration::from_millis(PROBE_TIMEOUT_MS);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break None,
        }
    };
    let mut streams = [None, None];
    if status.is_some() {
        while streams.iter().any(Option::is_none) {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok((i, text)) => streams[i] = Some(text),
                Err(_) => return Run::TimedOut,
            }
        }
    }
    let [stdout, stderr] = streams.map(Option::unwrap_or_default);
    let Some(status) = status else {
        return Run::TimedOut;
    };
    match status.code() {
        Some(0) => Run::Done { stdout, stderr },
        Some(n) => Run::Exit(n),
        None => Run::Error(format!("Command failed: {bin} {}\n{stderr}", args.join(" "))),
    }
}

fn not_found(reason: &'static str, message: String) -> Probe {
    Probe {
        ok: false,
        found: false,
        major: None,
        version: None,
        arch: None,
        reason,
        message,
    }
}

/// `probe(bin)`: whether a Java runs there, its major version and arch. Never fails: the answer
/// says what is wrong.
pub fn probe(bin: &str) -> Probe {
    let full = ["-XshowSettings:properties", "-version"];
    let mut res = run(bin, &full);
    // a slow JVM is not a missing one: retry a timeout once
    if matches!(res, Run::TimedOut) {
        res = run(bin, &full);
    }
    // a JVM that refuses the option is still a Java: ask the plain question
    if matches!(res, Run::Exit(_) | Run::Error(_)) {
        res = run(bin, &["-version"]);
    }
    let (stdout, stderr) = match res {
        Run::Done { stdout, stderr } => (stdout, stderr),
        Run::Missing => {
            return not_found("not-installed", "Java is not installed, or not on PATH.".into());
        }
        Run::TimedOut => {
            return not_found(
                "unusable",
                format!(
                    "Java did not answer within {} seconds, twice.",
                    PROBE_TIMEOUT_MS / 1000
                ),
            );
        }
        Run::Exit(n) => return not_found("unusable", format!("Java could not be run: exit {n}")),
        Run::Error(m) => return not_found("unusable", format!("Java could not be run: {m}")),
    };
    // java -version writes to stderr
    let text = format!("{stderr}{stdout}");
    let version = text
        .split('\n')
        .find(|l| l.contains("version \""))
        .unwrap_or_else(|| text.split('\n').next().unwrap_or(""));
    let version = crate::js::trim(version).to_string();
    let major = parse_major(&text);
    let arch = parse_arch(&text);
    let mut p = Probe {
        ok: true,
        found: true,
        major,
        version: Some(version.clone()),
        arch,
        reason: "ok",
        message: String::new(),
    };
    match major {
        None => {
            p.reason = "unknown-version";
            p.message = format!("Found {version}.");
        }
        Some(m) if m < MINIMUM_MAJOR => {
            p.ok = false;
            p.reason = "too-old";
            p.message = format!(
                "Java {m} is too old to run a modern Minecraft server. Version {RECOMMENDED_MAJOR} is what current Paper needs."
            );
        }
        Some(m) if m < RECOMMENDED_MAJOR => {
            p.reason = "old";
            p.message = format!(
                "Java {m} will run older Minecraft versions, but current Paper needs {RECOMMENDED_MAJOR}."
            );
        }
        Some(m) => p.message = format!("Java {m} is installed."),
    }
    p
}

const WINDOWS_VENDOR_DIRS: &[&str] = &[
    "Java",
    "Eclipse Adoptium",
    "Eclipse Foundation",
    "AdoptOpenJDK",
    "Temurin",
    "Microsoft",
    "Zulu",
    "Amazon Corretto",
    "BellSoft",
    "Semeru",
    "OpenJDK",
    "Azul",
    "Oracle",
];

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// `candidatePaths()`: JAVA_HOME and the usual install folders, one entry per real path, in the
/// order they were found.
pub fn candidate_paths() -> Vec<(String, String)> {
    let mut found: Vec<(std::path::PathBuf, String, String)> = Vec::new();
    let mut add = |p: String, source: &str| {
        let Ok(real) = std::fs::canonicalize(&p) else {
            return;
        };
        if !found.iter().any(|(r, _, _)| *r == real) {
            found.push((real, p, source.to_string()));
        }
    };
    let bin = if cfg!(windows) { "java.exe" } else { "java" };
    if let Some(home) = env("JAVA_HOME") {
        add(crate::jspath::join(&[&home, "bin", bin]), "JAVA_HOME");
    }
    let scan = |root: &str, source: &str, add: &mut dyn FnMut(String, &str)| {
        let Ok(entries) = std::fs::read_dir(root) else {
            return;
        };
        // readdir order is the system's; Node's is the same call
        let mut names: Vec<(String, bool)> = entries
            .flatten()
            .map(|e| {
                let dir = e.file_type().is_ok_and(|t| t.is_dir());
                (e.file_name().to_string_lossy().into_owned(), dir)
            })
            .collect();
        if cfg!(not(windows)) {
            // libuv's scandir sorts on Unix
            names.sort();
        }
        for (name, dir) in names {
            if !dir {
                continue;
            }
            let base = crate::jspath::join(&[root, &name]);
            add(crate::jspath::join(&[&base, "bin", bin]), source);
            add(
                crate::jspath::join(&[&base, "Contents", "Home", "bin", bin]),
                source,
            );
        }
    };
    if cfg!(windows) {
        let mut roots: Vec<String> = Vec::new();
        for r in [
            env("ProgramFiles"),
            env("ProgramFiles(x86)"),
            env("ProgramW6432"),
            env("LOCALAPPDATA").map(|l| crate::jspath::join(&[&l, "Programs"])),
        ]
        .into_iter()
        .flatten()
        {
            if !roots.contains(&r) {
                roots.push(r);
            }
        }
        for root in &roots {
            for vendor in WINDOWS_VENDOR_DIRS {
                scan(&crate::jspath::join(&[root, vendor]), vendor, &mut add);
            }
        }
    } else if cfg!(target_os = "macos") {
        scan(
            "/Library/Java/JavaVirtualMachines",
            "JavaVirtualMachines",
            &mut add,
        );
        let home = env("HOME").unwrap_or_default();
        scan(
            &crate::jspath::join(&[&home, "Library", "Java", "JavaVirtualMachines"]),
            "JavaVirtualMachines",
            &mut add,
        );
    } else {
        scan("/usr/lib/jvm", "/usr/lib/jvm", &mut add);
    }
    found.into_iter().map(|(_, p, s)| (p, s)).collect()
}

/// What `discover()` answers: the newest usable Java, the one on PATH, and every one found,
/// newest first.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub best: Option<Found>,
    pub on_path: Probe,
    pub all: Vec<Found>,
}

/// `discover()`: PATH and every candidate, probed at once.
pub fn discover() -> Discovered {
    let candidates = candidate_paths();
    let on_path = std::thread::spawn(|| probe("java"));
    let probes: Vec<_> = candidates
        .into_iter()
        .map(|(p, s)| std::thread::spawn(move || (p.clone(), s, probe(&p))))
        .collect();
    let on_path = on_path
        .join()
        .unwrap_or_else(|_| not_found("unusable", String::new()));
    let mut all: Vec<Found> = probes
        .into_iter()
        .filter_map(|h| h.join().ok())
        .filter(|(_, _, p)| p.found && p.major.is_some())
        .map(|(path, source, probe)| Found { path, source, probe })
        .collect();
    all.sort_by_key(|f| std::cmp::Reverse(f.probe.major));
    if on_path.found && on_path.major.is_some() {
        all.insert(
            0,
            Found {
                path: "java".into(),
                source: "PATH".into(),
                probe: on_path.clone(),
            },
        );
    }
    let mut seen: Vec<String> = Vec::new();
    let mut unique: Vec<Found> = all
        .into_iter()
        .filter(|r| {
            let key = format!(
                "{} {}",
                r.probe.version.as_deref().unwrap_or("undefined"),
                r.probe.arch.as_deref().unwrap_or("")
            );
            if seen.contains(&key) {
                return false;
            }
            seen.push(key);
            true
        })
        .collect();
    unique.sort_by_key(|f| std::cmp::Reverse(f.probe.major));
    let best = unique
        .iter()
        .find(|r| r.probe.major.is_some_and(|m| m >= MINIMUM_MAJOR))
        .cloned();
    Discovered {
        best,
        on_path,
        all: unique,
    }
}

/// `defaultJava()`: `java` by name when PATH has the best one, else its path; `None` when there
/// is no usable Java.
pub fn default_java() -> Option<String> {
    let d = discover();
    let best = d.best?;
    if d.on_path.found && d.on_path.major == best.probe.major {
        return Some("java".into());
    }
    Some(best.path)
}

/// `javaFor(needs)`: the newest Java found that is `needs` or newer.
pub fn java_for(needs: u32) -> Option<Found> {
    discover()
        .all
        .into_iter()
        .find(|j| j.probe.major.is_some_and(|m| m >= needs))
}

/// `requiredMajor(mc)`: Mojang's floor for a release version; `None` (no check) for anything
/// else, snapshots included.
pub fn required_major(mc: Option<&str>) -> Option<u32> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?$").expect("valid"));
    let text = crate::js::trim(mc.unwrap_or(""));
    let m = RE.captures(text)?;
    let num = |i: usize| {
        m.get(i)
            .map_or(0.0, |s| s.as_str().parse::<f64>().unwrap_or(f64::INFINITY))
    };
    let (a, b, c) = (num(1), num(2), num(3));
    if a >= 25.0 {
        return Some(25);
    }
    if a != 1.0 {
        return None;
    }
    Some(if b >= 21.0 {
        21
    } else if b == 20.0 {
        if c >= 5.0 { 21 } else { 17 }
    } else if b >= 18.0 {
        17
    } else if b == 17.0 {
        16
    } else {
        8
    })
}

/// Whether a server's Java is a script standing in for the JVM (the lifecycle tests), which is
/// run on Node and never asked its version (`/\.m?js$/i`).
pub fn is_script(bin: &str) -> bool {
    let lower = bin.to_ascii_lowercase();
    lower.ends_with(".js") || lower.ends_with(".mjs")
}

/// `pickJava({ explicit, needs, force, what })`: which Java a new server gets, decided before
/// anything is downloaded. An explicit Java is probed and refused only when certainly too old
/// (unless `force`); otherwise the newest installed Java that fits wins. None new enough is
/// refused with the code `java-too-old` (the panel offers to override), or with `force` the best
/// is used. No Java at all is not refused here: start says so.
pub fn pick_java(
    explicit: Option<&str>,
    needs: Option<u32>,
    force: bool,
    what: &str,
) -> Result<String, crate::failure::Failure> {
    use crate::failure::Failure;
    let too_old = |message: String| Failure::User {
        message,
        code: Some("java-too-old".into()),
    };
    if let Some(explicit) = explicit.filter(|e| !e.is_empty()) {
        let state = probe(explicit);
        if !state.found {
            return Err(Failure::user(format!(
                "{explicit} could not be run: {}",
                state.message
            )));
        }
        if let (Some(needs), Some(have)) = (needs, state.major)
            && have < needs
            && !force
        {
            return Err(too_old(format!(
                "{what} needs Java {needs}, and {explicit} is Java {have}. Pick a newer Java, or pass --force to use it anyway."
            )));
        }
        return Ok(explicit.to_string());
    }
    let Some(needs) = needs.filter(|n| *n != 0) else {
        return Ok(default_java().unwrap_or_else(|| "java".into()));
    };
    if let Some(fit) = java_for(needs) {
        return Ok(fit.path);
    }
    let Some(best) = discover().best else {
        return Ok("java".into());
    };
    if force {
        return Ok(best.path);
    }
    let have = best
        .probe
        .major
        .map_or("undefined".to_string(), |m| m.to_string());
    let at = if best.path == "java" {
        String::new()
    } else {
        format!(" ({})", best.path)
    };
    Err(too_old(format!(
        "{what} needs Java {needs}. The newest Java on this machine is {have}{at}. Install Java {needs} from {DOWNLOAD_URL}, or create it anyway and point it at a Java of your own afterwards."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn majors_and_arches_parse_like_java_mjs() {
        assert_eq!(parse_major("openjdk version \"21.0.5\" 2024"), Some(21));
        assert_eq!(parse_major("java version \"1.8.0_401\""), Some(8));
        assert_eq!(parse_major("java version \"1\""), None);
        assert_eq!(parse_major("Picked up X\nopenjdk version \"25\""), Some(25));
        assert_eq!(parse_major("nothing"), None);
        assert_eq!(parse_arch("    os.arch = amd64\n").as_deref(), Some("x64"));
        assert_eq!(parse_arch("os.arch=aarch64").as_deref(), Some("arm64"));
        assert_eq!(parse_arch(" os.arch = i686").as_deref(), Some("x86"));
        assert_eq!(parse_arch(" os.arch = PPC64LE").as_deref(), Some("ppc64le"));
        assert_eq!(parse_arch("os.name = Linux"), None);
    }

    #[test]
    fn required_majors_follow_mojang() {
        let r = |v: &str| required_major(Some(v));
        assert_eq!(r("26.1"), Some(25));
        assert_eq!(r("1.21.4"), Some(21));
        assert_eq!(r("1.20.5"), Some(21));
        assert_eq!(r("1.20.4"), Some(17));
        assert_eq!(r("1.18"), Some(17));
        assert_eq!(r("1.17.1"), Some(16));
        assert_eq!(r("1.16.5"), Some(8));
        assert_eq!(r(" 1.21 "), Some(21));
        assert_eq!(r("25w14a"), None);
        assert_eq!(r("2.0"), None);
        assert_eq!(required_major(None), None);
    }

    #[cfg(unix)]
    #[test]
    fn probes_a_stand_in_java() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("sl-java-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("java");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho '    os.arch = amd64' >&2\necho 'openjdk version \"21.0.2\" 2024-01-16' >&2\n",
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = probe(&bin.to_string_lossy());
        assert_eq!(p.major, Some(21));
        assert_eq!(p.reason, "old");
        assert_eq!(p.arch.as_deref(), Some("x64"));
        assert_eq!(
            p.version.as_deref(),
            Some("openjdk version \"21.0.2\" 2024-01-16")
        );
        let failing = dir.join("bad");
        std::fs::write(&failing, "#!/bin/sh\nexit 3\n").unwrap();
        std::fs::set_permissions(&failing, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            probe(&failing.to_string_lossy()).message,
            "Java could not be run: exit 3"
        );
        assert_eq!(probe(&dir.join("none").to_string_lossy()).reason, "not-installed");
        // a wrapper whose child keeps the pipes open: the deadline still ends the probe
        let wrapper = dir.join("wrapper");
        std::fs::write(
            &wrapper,
            "#!/bin/sh\nsleep 60 &\necho 'openjdk version \"21\"' >&2\n",
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let started = std::time::Instant::now();
        let p = probe(&wrapper.to_string_lossy());
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(p.message, "Java did not answer within 8 seconds, twice.");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
