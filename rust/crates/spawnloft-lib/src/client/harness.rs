//! The harness mod's side of `client-harness.mjs`: the file the mod writes in the game folder
//! (`spawnloft-harness.json`, its port and pid) and the line-delimited JSON channel to it on
//! 127.0.0.1, opened with the launch's token; and which build of the mod a version takes, put in
//! a profile's mods folder before a launch.

use serde_json::{Map, Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use super::paths::Paths;
use super::prop;
use crate::failure::Failure;
use crate::jspath;

pub const HARNESS_FILE: &str = "spawnloft-harness.json";

pub fn harness_file(paths: &Paths, profile: &str) -> String {
    jspath::join(&[&paths.profile_dir(profile), HARNESS_FILE])
}

/// `readHarnessFile(name, { pid })`. With `pid`, a file left by an earlier run (a crash skips
/// the mod's cleanup) reads as absent. A file being deleted or written on Windows (EPERM, EBUSY,
/// EACCES) is no harness right now; one that is not JSON fails.
pub fn read_file(paths: &Paths, profile: &str, pid: Option<&Value>) -> Result<Option<Value>, Failure> {
    let file = harness_file(paths, profile);
    let data = match std::fs::read(&file) {
        Ok(b) => crate::jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax)?,
        Err(e) if jspath::is_enoent(&e) => return Ok(None),
        Err(e) => {
            if matches!(jspath::error_code(&e).0, "EPERM" | "EBUSY" | "EACCES") {
                return Ok(None);
            }
            return Err(Failure::read(&e, std::path::Path::new(&file)));
        }
    };
    if !matches!(prop(Some(&data), "port"), Some(Value::Number(_))) {
        return Ok(None);
    }
    if let Some(pid) = pid
        && !super::strict_eq(prop(Some(&data), "pid"), Some(pid))
    {
        return Ok(None);
    }
    Ok(Some(data))
}

/// `removeHarnessFile(name)`.
pub fn remove_file(paths: &Paths, profile: &str) -> Result<(), Failure> {
    super::rm_force(&harness_file(paths, profile))
}

// ---- the builds ------------------------------------------------------------------------------

/// A build this SpawnLoft ships knowing, in the signed list's row shape (`HARNESS_RELEASES`).
/// More arrive through that list without a release; these win on a conflict, so the list can add
/// a version but never swap the jar of one listed here.
#[derive(Debug)]
pub struct Release {
    pub minecraft: &'static [&'static str],
    pub version: &'static str,
    pub tag: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
}

pub const HARNESS_RELEASES: &[Release] = &[Release {
    minecraft: &["1.21.11"],
    version: "0.1.0",
    tag: "v0.1.0-mc1.21.11",
    file: "spawnloft-harness-0.1.0+1.21.11.jar",
    sha256: "6e97b92cfde87bbd948f8ef4733979ba556337be79ed334b02c6942f2dae0d63",
}];

impl Release {
    fn row(&self) -> super::harness_index::Row {
        super::harness_index::Row {
            minecraft: self.minecraft.iter().map(|s| s.to_string()).collect(),
            version: self.version.into(),
            tag: self.tag.into(),
            file: self.file.into(),
            sha256: self.sha256.into(),
        }
    }
}

/// `harnessFor(mc)`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
    pub minecraft: String,
    pub version: String,
    pub url: String,
    pub sha256: String,
}

fn listed(paths: &Paths) -> Vec<super::harness_index::Row> {
    let dir = paths.cache_dir();
    super::harness_index::index_rows(super::harness_index::Opts::new(&dir))
}

/// `harnessFor(mc)`: the build for one Minecraft id, or None. Never waits for the network: the
/// signed list is the copy already verified and cached.
pub fn harness_for(paths: &Paths, mc: &str) -> Option<Build> {
    // `listed = indexRows()` is a default parameter in Node, so the cached list is loaded (and a
    // copy that no longer verifies dropped, with its status written) on every call
    let listed = listed(paths);
    let row = HARNESS_RELEASES
        .iter()
        .find(|r| r.minecraft.contains(&mc))
        .map(Release::row)
        .or_else(|| listed.into_iter().find(|r| r.minecraft.iter().any(|m| m == mc)))?;
    Some(Build {
        minecraft: mc.to_string(),
        version: row.version.clone(),
        url: super::harness_index::jar_url(&row),
        sha256: row.sha256,
    })
}

/// `publishedHarnessIds()`: every id a build is published for, built-in and listed.
pub fn published_ids(paths: &Paths) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let rows: Vec<super::harness_index::Row> = HARNESS_RELEASES
        .iter()
        .map(Release::row)
        .chain(listed(paths))
        .collect();
    for r in rows {
        for m in r.minecraft {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}

/// `harnessNotPublished(mc)`: the refusal for a harness profile on a version with no build, with
/// why the published list may not have been read.
pub fn not_published(paths: &Paths, mc: &str) -> String {
    let ids = published_ids(paths);
    let (outcome, reason) = super::harness_index::last_outcome(paths);
    let unread = match outcome.as_str() {
        Some("accepted" | "unchanged") => String::new(),
        _ if crate::js::truthy(Some(&outcome)) => {
            format!(
                " (the published list could not be read: {})",
                crate::js::string(Some(&reason))
            )
        }
        _ => String::new(),
    };
    let which = if ids.len() == 1 {
        ids[0].clone()
    } else {
        "one of those versions".into()
    };
    format!(
        "The harness mod is not published for Minecraft {mc} yet (published: {}){unread}. Turn the harness off on this profile to play (harness=false), or use {which} for harness work.",
        ids.join(", ")
    )
}

/// How the jar is fetched: `downloadFile(url, dest, { hash: 'sha256', expected, label })`.
pub type Download<'a> = &'a (dyn Fn(&str, &std::path::Path, &str, &str) -> Result<(), Failure> + Sync);

pub fn default_download(url: &str, dest: &std::path::Path, sha256: &str, label: &str) -> Result<(), Failure> {
    crate::download::download_file(
        url,
        dest,
        crate::download::Options {
            hash: Some(crate::download::Hash::Sha256),
            expected: Some(sha256.to_string()),
            label: Some(label.to_string()),
            ..crate::download::Options::default()
        },
    )
    .map(|_| ())
}

/// `ensureHarnessJar(name, mc)`: this version's build in the profile's mods folder, any other
/// build of the mod taken out.
pub fn ensure_harness_jar(
    paths: &Paths,
    profile: &str,
    mc: &str,
    on_progress: super::install::OnProgress<'_>,
    download: Download<'_>,
) -> Result<(), Failure> {
    let Some(row) = harness_for(paths, mc) else {
        return Err(Failure::user(format!(
            "no harness mod is published for Minecraft {mc}; the profile can still launch without the harness"
        )));
    };
    let mods_dir = jspath::join(&[&paths.profile_dir(profile), "mods"]);
    let base = format!("spawnloft-harness-{}+{}.jar", row.version, row.minecraft);
    let dest = jspath::join(&[&mods_dir, &base]);
    let dest_path = std::path::Path::new(&dest);
    if dest_path.exists() {
        use sha2::Digest;
        let buf = std::fs::read(dest_path).map_err(|e| Failure::read(&e, dest_path))?;
        let hash = sha2::Sha256::digest(&buf);
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        if hex == row.sha256 {
            return Ok(());
        }
    }
    std::fs::create_dir_all(&mods_dir)
        .map_err(|e| Failure::io(&e, "mkdir", Some(std::path::Path::new(&mods_dir))))?;
    let entries = std::fs::read_dir(&mods_dir)
        .map_err(|e| Failure::io(&e, "scandir", Some(std::path::Path::new(&mods_dir))))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == base {
            continue;
        }
        // /^spawnloft-harness-.*\.jar$/i
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("spawnloft-harness-") && lower.ends_with(".jar") && !lower.contains('\n') {
            super::rm_force(&jspath::join(&[&mods_dir, &name]))?;
        }
    }
    download(
        &row.url,
        dest_path,
        &row.sha256,
        &format!("harness mod {}", row.version),
    )?;
    let size = std::fs::metadata(dest_path)
        .map_err(|e| Failure::read(&e, dest_path))?
        .len();
    on_progress(&super::install::Progress {
        phase: "harness mod",
        done: 1,
        total: 1,
        bytes: size as f64,
        fetching: false,
    });
    Ok(())
}

const GONE: &str = "the client's harness went away";

/// An open channel to the harness (`connectHarness`'s `{ call, close }`).
#[derive(Debug)]
pub struct Channel {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    next_id: u64,
    closed: bool,
    /// A line read in part when a wait ran out.
    pending: Vec<u8>,
    pub hello: Value,
}

impl Channel {
    fn send(&mut self, id: u64, op: &str, args: &Map<String, Value>) -> Result<(), ()> {
        let mut msg = Map::new();
        msg.insert("id".into(), json!(id));
        msg.insert("op".into(), json!(op));
        for (k, v) in args {
            msg.insert(k.clone(), v.clone());
        }
        let line = format!("{}\n", crate::jsjson::stringify(&Value::Object(msg)));
        self.stream.write_all(line.as_bytes()).map_err(|_| ())
    }

    /// Reads replies until the one for `id`, or the wait runs out (`Ok(None)`).
    fn reply(&mut self, id: u64, wait: Duration) -> Result<Option<Map<String, Value>>, Failure> {
        let deadline = Instant::now() + wait;
        loop {
            if self.closed {
                return Err(Failure::user(GONE));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            let _ = self.stream.set_read_timeout(Some(left));
            match self.reader.read_until(b'\n', &mut self.pending) {
                Ok(0) => {
                    self.closed = true;
                    return Err(Failure::user(GONE));
                }
                Ok(_) if self.pending.last() == Some(&b'\n') => {}
                Ok(_) => continue,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue;
                }
                Err(_) => {
                    self.closed = true;
                    return Err(Failure::user(GONE));
                }
            }
            let line = std::mem::take(&mut self.pending);
            let text = String::from_utf8_lossy(&line);
            let Ok(Value::Object(reply)) = crate::jsjson::parse(text.trim_end_matches(['\n', '\r'])) else {
                continue;
            };
            let Some(got) = reply.get("id").and_then(Value::as_f64) else {
                continue;
            };
            if got.fract() != 0.0 || got != id as f64 {
                continue;
            }
            if reply.get("ok") == Some(&Value::Bool(false)) {
                return Err(Failure::user(crate::js::string(reply.get("error"))));
            }
            let mut result = reply;
            result.shift_remove("id");
            result.shift_remove("ok");
            return Ok(Some(result));
        }
    }

    /// `call(op, args, { timeout })`.
    pub fn call(&mut self, op: &str, args: Map<String, Value>, timeout_ms: u64) -> Result<Value, Failure> {
        if self.closed {
            return Err(Failure::user(GONE));
        }
        let id = self.next_id;
        self.next_id += 1;
        if self.send(id, op, &args).is_err() {
            self.closed = true;
            return Err(Failure::user(GONE));
        }
        match self.reply(id, Duration::from_millis(timeout_ms))? {
            Some(r) => Ok(Value::Object(r)),
            None => Err(Failure::user(format!(
                "the harness did not answer {op} within {timeout_ms} ms"
            ))),
        }
    }

    pub fn close(self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// `connectHarness(name, token, { timeout, pid })`.
pub fn connect(
    paths: &Paths,
    profile: &str,
    token: Option<&Value>,
    timeout_ms: u64,
    pid: Option<&Value>,
) -> Result<Channel, Failure> {
    let Some(info) = read_file(paths, profile, pid)? else {
        return Err(Failure::user(format!(
            "profile \"{profile}\" has no running harness"
        )));
    };
    let port = crate::js::number(prop(Some(&info), "port"));
    let addr = format!("127.0.0.1:{}", crate::js::number_to_string(port));
    let stream = match port_of(port).map(|p| TcpStream::connect(("127.0.0.1", p))) {
        Some(Ok(s)) => s,
        Some(Err(e)) => {
            let (code, _) = jspath::error_code(&e);
            if code == "ECONNREFUSED" {
                return Err(Failure::user(format!(
                    "connection to the harness was refused: connect ECONNREFUSED {addr}"
                )));
            }
            return Err(Failure::Internal {
                head: "Error".into(),
                message: format!("connect {code} {addr}"),
                code: Some(code.to_string()),
            });
        }
        None => {
            return Err(Failure::Internal {
                head: "RangeError [ERR_SOCKET_BAD_PORT]".into(),
                message: format!(
                    "Port should be >= 0 and < 65536. Received type number ({}).",
                    crate::js::number_to_string(port)
                ),
                code: Some("ERR_SOCKET_BAD_PORT".into()),
            });
        }
    };
    let reader = BufReader::new(stream.try_clone().map_err(|e| Failure::io(&e, "dup", None))?);
    let mut channel = Channel {
        stream,
        reader,
        next_id: 1,
        closed: false,
        pending: Vec::new(),
        hello: Value::Null,
    };
    let mut args = Map::new();
    if let Some(t) = token {
        args.insert("token".into(), t.clone());
    }
    let id = channel.next_id;
    channel.next_id += 1;
    if channel.send(id, "hello", &args).is_err() {
        return Err(Failure::user("the harness refused the token"));
    }
    match channel.reply(id, Duration::from_millis(timeout_ms)) {
        Ok(Some(r)) => {
            channel.hello = Value::Object(r);
            Ok(channel)
        }
        Ok(None) => {
            channel.close();
            Err(Failure::user(format!(
                "the harness did not answer hello within {timeout_ms} ms"
            )))
        }
        Err(Failure::User { message, .. }) if message.contains("went away") => {
            Err(Failure::user("the harness refused the token"))
        }
        Err(e) => {
            channel.close();
            Err(e)
        }
    }
}

/// A TCP port Node's `net.connect` takes: a whole number from 0 to 65535 (0 never connects).
fn port_of(port: f64) -> Option<u16> {
    (port.fract() == 0.0 && (0.0..65536.0).contains(&port)).then_some(port as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_call_waits_for_its_own_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let d = std::env::temp_dir().join(format!("sl-harness-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d.to_string_lossy());
        std::fs::create_dir_all(paths.profile_dir("p")).unwrap();
        std::fs::write(
            harness_file(&paths, "p"),
            format!("{{\"port\":{port},\"pid\":7}}"),
        )
        .unwrap();
        let server = std::thread::spawn(move || {
            let (s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut w = s;
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, "{\"id\":1,\"op\":\"hello\",\"token\":\"t\"}\n");
            w.write_all(b"{\"id\":1,\"ok\":true,\"mod\":\"0.1.0\"}\n")
                .unwrap();
            line.clear();
            r.read_line(&mut line).unwrap();
            assert_eq!(line, "{\"id\":2,\"op\":\"quit\"}\n");
            w.write_all(b"not json\n{\"id\":9}\n{\"id\":2,\"ok\":false,\"error\":\"no\"}\n")
                .unwrap();
        });
        assert!(read_file(&paths, "p", Some(&json!(8))).unwrap().is_none());
        let mut ch = connect(&paths, "p", Some(&json!("t")), 2000, Some(&json!(7))).unwrap();
        assert_eq!(ch.hello, json!({ "mod": "0.1.0" }));
        assert_eq!(ch.call("quit", Map::new(), 2000).unwrap_err().message(), "no");
        server.join().unwrap();
        assert_eq!(ch.call("x", Map::new(), 200).unwrap_err().message(), GONE);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_jar_for_the_version_replaces_other_builds() {
        let d = std::env::temp_dir().join(format!("sl-harness-jar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let paths = Paths::under(&d.to_string_lossy());
        let mods = std::path::Path::new(&paths.profile_dir("p")).join("mods");
        std::fs::create_dir_all(&mods).unwrap();
        std::fs::write(mods.join("spawnloft-harness-0.0.9+1.21.10.JAR"), "old").unwrap();
        std::fs::write(mods.join("spawnloft-harness-0.1.0+1.21.11.jar"), "damaged").unwrap();
        std::fs::write(mods.join("sodium.jar"), "kept").unwrap();
        let got = std::sync::Mutex::new(Vec::<String>::new());
        let download = |url: &str, dest: &std::path::Path, sum: &str, label: &str| -> Result<(), Failure> {
            got.lock().unwrap().push(format!("{url} {sum} {label}"));
            std::fs::write(dest, "jar").unwrap();
            Ok(())
        };
        let seen = std::sync::Mutex::new(Vec::new());
        let progress = |p: &super::super::install::Progress| {
            seen.lock().unwrap().push((p.phase, p.done, p.total, p.bytes))
        };
        ensure_harness_jar(&paths, "p", "1.21.11", &progress, &download).unwrap();
        assert_eq!(
            *got.lock().unwrap(),
            [format!(
                "https://github.com/joogiebear/spawnloft-harness-mod/releases/download/v0.1.0-mc1.21.11/spawnloft-harness-0.1.0%2B1.21.11.jar {} harness mod 0.1.0",
                HARNESS_RELEASES[0].sha256
            )]
        );
        assert_eq!(*seen.lock().unwrap(), [("harness mod", 1, 1, 3.0)]);
        let mut left: Vec<String> = std::fs::read_dir(&mods)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["sodium.jar", "spawnloft-harness-0.1.0+1.21.11.jar"]);

        let e = ensure_harness_jar(&paths, "p", "1.20.1", &progress, &download).unwrap_err();
        assert!(
            e.message()
                .starts_with("no harness mod is published for Minecraft 1.20.1")
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
