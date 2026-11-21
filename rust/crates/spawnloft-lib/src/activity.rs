//! The activity history (`activity.mjs`): one JSON line per event in the shared `activity.jsonl`,
//! appended by the panel, the command line, tasks, the MCP server and daemons, and rotated to
//! `activity.1.jsonl` past 2 MiB, so history is about twice that. Writing never fails: logging is
//! best-effort. The daemon has no person behind it, so its entries are by `{ kind: "spawnloft" }`;
//! other callers name their actor ([`Actor`]).

use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crate::paths::Roots;

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Who did something: panel and cli are a person, the rest automation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub kind: String,
    pub name: Option<String>,
}

pub const ACTOR_KINDS: [&str; 5] = ["panel", "cli", "assistant", "schedule", "spawnloft"];

impl Actor {
    /// `cleanActor`: an unknown kind is `spawnloft`; a name is free text from outside (an
    /// assistant app, a task), so its tabs and line ends become one space and it is cut at 80.
    pub fn new(kind: &str, name: Option<&str>) -> Actor {
        Actor {
            kind: if ACTOR_KINDS.contains(&kind) {
                kind
            } else {
                "spawnloft"
            }
            .into(),
            name: name
                .filter(|n| !n.is_empty())
                .map(|n| cut16(&squash(n, &['\r', '\n', '\t']), 80)),
        }
    }

    pub fn spawnloft() -> Actor {
        Actor::new("spawnloft", None)
    }

    fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!(self.kind));
        if let Some(n) = &self.name {
            m.insert("name".into(), json!(n));
        }
        Value::Object(m)
    }
}

/// Each run of the given characters as one space (`replace(/[\r\n]+/g, ' ')`).
fn squash(text: &str, chars: &[char]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if chars.contains(&c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `slice(0, n)` in UTF-16 units (a pair cut in half leaves U+FFFD, as Node writes it to a file).
fn cut16(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// The entry as written, for tests: by the daemon.
pub fn entry(server: &str, action: &str, detail: Option<&str>, ok: bool, at: &str) -> Value {
    entry_by(&Actor::spawnloft(), server, action, detail, None, ok, at)
}

/// The entry `record` writes. `snapshot` is the snapshot taken first, what an undo restores.
pub fn entry_by(
    by: &Actor,
    server: &str,
    action: &str,
    detail: Option<&str>,
    snapshot: Option<&str>,
    ok: bool,
    at: &str,
) -> Value {
    let mut e = Map::new();
    e.insert("at".into(), json!(at));
    e.insert("server".into(), json!(server));
    e.insert("action".into(), json!(action));
    e.insert("by".into(), by.to_json());
    if let Some(d) = detail.filter(|d| !d.is_empty()) {
        e.insert("detail".into(), json!(cut16(&squash(d, &['\r', '\n']), 500)));
    }
    if let Some(snap) = snapshot.filter(|s| !s.is_empty()) {
        e.insert("snapshot".into(), json!(snap));
    }
    if !ok {
        e.insert("ok".into(), json!(false));
    }
    Value::Object(e)
}

/// The daemon's `record`.
pub fn record(roots: &Roots, server: &str, action: &str, detail: Option<&str>, ok: bool) {
    record_by(roots, &Actor::spawnloft(), server, action, detail, None, ok);
}

/// `record`, by `by`. Returns the entry, written or not.
pub fn record_by(
    roots: &Roots,
    by: &Actor,
    server: &str,
    action: &str,
    detail: Option<&str>,
    snapshot: Option<&str>,
    ok: bool,
) -> Value {
    let entry = entry_by(by, server, action, detail, snapshot, ok, &crate::time::iso_now());
    let line = crate::jsjson::stringify(&entry);
    let _ = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&roots.data_root)?;
        let file = roots.activity_file();
        if std::fs::metadata(&file)
            .map(|m| m.len() >= MAX_BYTES)
            .unwrap_or(false)
        {
            // another process may have rotated it first
            let _ = std::fs::rename(&file, roots.activity_previous());
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&file)?;
        // a writer that died mid-line left no newline; without one this line would be glued on
        let len = f.metadata()?.len();
        let mut prefix = "";
        if len > 0 {
            let mut last = [0u8; 1];
            f.seek(SeekFrom::Start(len - 1))?;
            f.read_exact(&mut last)?;
            if last[0] != b'\n' {
                prefix = "\n";
            }
        }
        f.write_all(format!("{prefix}{line}\n").as_bytes())
    })();
    entry
}

/// Every entry of one file that parses; a line cut short by a crash mid-write is skipped.
fn read_lines(file: &Path) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(file) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .split('\n')
        .filter(|line| !crate::js::trim(line).is_empty())
        .filter_map(|line| crate::jsjson::parse(line).ok())
        .collect()
}

/// Both files, oldest entry first.
fn read_all(roots: &Roots) -> Vec<Value> {
    let mut all = read_lines(&roots.activity_previous());
    all.extend(read_lines(&roots.activity_file()));
    all
}

/// `e.at` as a string comparison sees it, `None` where JavaScript compares it as a number (and
/// every such comparison with an ISO time is false). A line holding a string or an array has
/// `at` too: their `at` method, which prints as its source.
fn at_text(e: &Value) -> Option<String> {
    match e {
        Value::Object(m) => match m.get("at") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v @ (Value::Object(_) | Value::Array(_))) => Some(crate::js::string(Some(v))),
            _ => None,
        },
        Value::String(_) | Value::Array(_) => Some("function at() { [native code] }".into()),
        _ => None,
    }
}

/// `e.at < than`, by UTF-16 units.
fn at_before(e: &Value, than: &str) -> Option<bool> {
    at_text(e).map(|at| at.encode_utf16().lt(than.encode_utf16()))
}

fn kind_of(e: &Value) -> Option<&str> {
    e.get("by").and_then(|b| b.get("kind")).and_then(Value::as_str)
}

fn nonempty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

/// What `readActivity` is asked for. `by` is an actor kind, or `you` for panel and cli.
#[derive(Debug, Clone, Default)]
pub struct Query<'a> {
    pub server: Option<&'a str>,
    pub since: Option<&'a str>,
    pub before: Option<&'a str>,
    pub by: Option<&'a str>,
    pub limit: usize,
}

/// `readActivity`: the matching entries newest first, at most `limit`, and whether older ones
/// matched beyond it.
pub fn read_activity(roots: &Roots, q: &Query) -> (Vec<Value>, bool) {
    let all = read_all(roots);
    let mut matched = Vec::new();
    for e in all.iter().rev() {
        if let Some(server) = nonempty(q.server)
            && e.get("server").and_then(Value::as_str) != Some(server)
        {
            continue;
        }
        if let Some(since) = nonempty(q.since)
            && at_before(e, since) == Some(true)
        {
            break;
        }
        if let Some(before) = nonempty(q.before)
            && at_before(e, before) == Some(false)
        {
            continue;
        }
        if let Some(by) = nonempty(q.by) {
            let kind = kind_of(e);
            let fits = if by == "you" {
                matches!(kind, Some("panel" | "cli"))
            } else {
                kind == Some(by)
            };
            if !fits {
                continue;
            }
        }
        matched.push(e.clone());
        if matched.len() > q.limit {
            break;
        }
    }
    let more = matched.len() > q.limit;
    matched.truncate(q.limit);
    (matched, more)
}

/// What the log says about one server's backups (`backupTrails`), times in milliseconds (NaN for
/// an `at` that does not read as a date, as in Node).
#[derive(Debug, Clone, PartialEq)]
pub struct Trail {
    pub last_made_at: Option<f64>,
    pub deleted: f64,
    pub last_deleted_at: Option<f64>,
    pub schedule_off_at: Option<f64>,
}

impl Trail {
    pub fn to_json(&self) -> Value {
        let t = |v: Option<f64>| v.map_or(Value::Null, crate::jsjson::num);
        json!({
            "lastMadeAt": t(self.last_made_at),
            "deleted": crate::jsjson::num(self.deleted),
            "lastDeletedAt": t(self.last_deleted_at),
            "scheduleOffAt": t(self.schedule_off_at),
        })
    }
}

/// `Number.parseInt(text, 10)`: leading white space, a sign, then digits; NaN without digits.
fn parse_int(text: &str) -> f64 {
    let t = crate::js::trim(text);
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * digits.parse::<f64>().unwrap_or(f64::NAN)
}

/// `backupTrails(names)`: for servers with no backup on disk, whether one was ever made, and
/// what removed them, from one read of the log. `deleted` counts the backups deleted or pruned
/// since the newest one was made; `schedule_off_at` is when its automatic backup was last
/// removed or paused. A create, adopt or delete ends a name's trail: before it the name belonged
/// to another server.
pub fn backup_trails(roots: &Roots, names: &[&str]) -> Vec<(String, Trail)> {
    let mut out: Vec<(String, Trail)> = Vec::new();
    for n in names {
        if !out.iter().any(|(k, _)| k == n) {
            out.push((
                (*n).to_string(),
                Trail {
                    last_made_at: None,
                    deleted: 0.0,
                    last_deleted_at: None,
                    schedule_off_at: None,
                },
            ));
        }
    }
    let all = read_all(roots);
    let mut done: Vec<String> = Vec::new();
    for e in all.iter().rev() {
        if done.len() >= out.len() {
            break;
        }
        let server = crate::js::string(e.get("server"));
        let Some((_, t)) = out.iter_mut().find(|(k, _)| *k == server) else {
            continue;
        };
        if done.contains(&server) || e.get("ok") == Some(&Value::Bool(false)) {
            continue;
        }
        let at = match e.get("at") {
            Some(Value::String(s)) => crate::jsdate::parse(s),
            _ => f64::NAN,
        };
        let action = e.get("action").and_then(Value::as_str).unwrap_or("");
        let detail = e.get("detail");
        match action {
            "backup" => {
                t.last_made_at = Some(at);
                done.push(server);
            }
            "create" | "adopt" | "delete" => done.push(server),
            "backup-delete" => {
                t.deleted += 1.0;
                t.last_deleted_at.get_or_insert(at);
            }
            "backup-prune" => {
                let n = match detail {
                    None | Some(Value::Null) => f64::NAN,
                    d => parse_int(&crate::js::string(d)),
                };
                t.deleted += if n.is_nan() || n == 0.0 { 1.0 } else { n };
                t.last_deleted_at.get_or_insert(at);
            }
            "schedule-remove" | "schedule-disable"
                if detail.and_then(Value::as_str) == Some("Automatic backup") =>
            {
                t.schedule_off_at.get_or_insert(at);
            }
            _ => {}
        }
    }
    out
}

/// `renameServer(from, to)`: every entry of `from` is rewritten as `to`, in both files, each
/// replaced whole through a temp file. A file that cannot be rewritten keeps the old name.
pub fn rename_server(roots: &Roots, from: &str, to: &str) {
    for file in [roots.activity_previous(), roots.activity_file()] {
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<String> = text
            .split('\n')
            .map(|line| {
                if crate::js::trim(line).is_empty() {
                    return line.to_string();
                }
                match crate::jsjson::parse(line) {
                    Ok(Value::Object(mut e)) if e.get("server").and_then(Value::as_str) == Some(from) => {
                        e.insert("server".into(), json!(to));
                        crate::jsjson::stringify(&Value::Object(e))
                    }
                    _ => line.to_string(),
                }
            })
            .collect();
        let mut tmp = file.as_os_str().to_owned();
        tmp.push(format!(".{}.tmp", std::process::id()));
        let tmp = std::path::PathBuf::from(tmp);
        if std::fs::write(&tmp, lines.join("\n")).is_ok() && std::fs::rename(&tmp, &file).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> serde_json::Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/c1-library.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    #[test]
    fn reads_as_node_does() {
        let fx = library();
        let fx = &fx["activity"];
        let dir = std::env::temp_dir().join(format!("sl-act-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let roots = Roots::new(&dir);
        std::fs::write(roots.activity_previous(), fx["previous"].as_str().unwrap()).unwrap();
        std::fs::write(roots.activity_file(), fx["current"].as_str().unwrap()).unwrap();
        for c in fx["reads"].as_array().unwrap() {
            let q = &c["query"];
            let query = Query {
                server: q["server"].as_str(),
                since: q["since"].as_str(),
                before: q["before"].as_str(),
                by: q["by"].as_str(),
                limit: q["limit"].as_u64().unwrap_or(100) as usize,
            };
            let (entries, more) = read_activity(&roots, &query);
            assert_eq!(Value::Array(entries), c["entries"], "{q}");
            assert_eq!(Value::Bool(more), c["more"], "{q}");
        }
        let trails = backup_trails(&roots, &["smp", "old", "new", "gone", "none", "smp"]);
        let got: Map<String, Value> = trails.iter().map(|(k, t)| (k.clone(), t.to_json())).collect();
        // numbers as JSON writes them, so 5.0 and 5 are the same
        assert_eq!(
            crate::jsjson::stringify(&Value::Object(got)),
            crate::jsjson::stringify(&fx["trails"])
        );

        rename_server(&roots, "smp", "survival");
        let after = read_activity(
            &roots,
            &Query {
                server: Some("survival"),
                limit: 100,
                ..Query::default()
            },
        )
        .0;
        let before = fx["reads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["query"] == json!({ "server": "smp" }))
            .unwrap();
        assert_eq!(after.len(), before["entries"].as_array().unwrap().len());
        // the torn line and the others stay as they were
        assert!(
            std::fs::read_to_string(roots.activity_file())
                .unwrap()
                .contains("{\"truncated\":\n")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn actors_are_cleaned() {
        assert_eq!(Actor::new("robot", None), Actor::spawnloft());
        let a = Actor::new(
            "assistant",
            Some(&format!("Claude\r\n\tDesktop{}", "x".repeat(100))),
        );
        assert_eq!(a.name.as_deref().unwrap().encode_utf16().count(), 80);
        assert!(a.name.as_deref().unwrap().starts_with("Claude Desktop"));
        let e = entry_by(
            &a,
            "smp",
            "start",
            Some("\nline\r\none"),
            Some("snap-1"),
            true,
            "t",
        );
        assert_eq!(e["detail"], " line one");
        assert_eq!(e["snapshot"], "snap-1");
        assert_eq!(e["by"]["kind"], "assistant");
    }

    #[test]
    fn shape_matches_activity_mjs() {
        let e = entry(
            "srv",
            "crash",
            Some("crashed (exit 3).\nRestarting"),
            false,
            "2026-01-01T00:00:00.000Z",
        );
        assert_eq!(
            e.to_string(),
            r#"{"at":"2026-01-01T00:00:00.000Z","server":"srv","action":"crash","by":{"kind":"spawnloft"},"detail":"crashed (exit 3). Restarting","ok":false}"#
        );
    }

    #[test]
    fn appends_after_a_torn_line() {
        let dir = std::env::temp_dir().join(format!("sl-act-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let roots = Roots::new(&dir);
        std::fs::write(roots.activity_file(), "{\"torn\":").unwrap();
        record(&roots, "srv", "crash", Some("x"), false);
        let text = std::fs::read_to_string(roots.activity_file()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[1].contains("\"action\":\"crash\""));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
