//! `diag-bundle.mjs`: one zip for a bug report. A server's console and daemon log, its
//! server.properties (secrets out) and crash reports; a client profile's latest.log, process
//! output, options.txt and crash reports; one timeline across all of them, the known failure
//! shapes of each, and the facts around them. `spawnloft diag`, the panel's diagnostics and the
//! MCP server's `diag` tool all build it here.
//!
//! Everything that leaves goes through one cleaning: the MCP scrubber (secrets SpawnLoft holds,
//! player IPs), the account folder in paths, the signed-in Microsoft accounts' names and uuids,
//! the harness and access tokens, and panel sign-in tokens.
//!
//! One declared difference (tools/parity/declared-differences.mjs, `doctor-node-line`): the facts
//! carry no `node` version; `spawnloft` is the core's own version.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::client::diagnose::{Context as ClientContext, client_diagnose};
use crate::client::paths::Paths as ClientPaths;
use crate::client::{accounts, harness_index, log as client_log, profiles, state as client_state};
use crate::diagnose::{self, Finding};
use crate::failure::Failure;
use crate::log_timeline::{self, Entry};
use crate::settings::Layout;
use crate::{java, js, jsdate, jsjson, jspath, mclogs, plugins, registry, supervisor, text, util, zip};

pub const TAIL_LINES: usize = 5000;

/// `MICROSOFT_PLACEHOLDER`: what a signed-in account's name and uuid become.
pub const MICROSOFT_PLACEHOLDER: &str = "[microsoft account]";

/// An object whose keys keep their order and may be `undefined` (`None`): JSON leaves those
/// out, `String()` prints them as `undefined`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Facts(pub Vec<(String, Option<Value>)>);

impl Facts {
    fn put(&mut self, key: &str, v: Option<Value>) {
        self.0.push((key.into(), v));
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.as_ref())
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut Option<Value>> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        for (k, v) in &self.0 {
            if let Some(v) = v {
                m.insert(k.clone(), v.clone());
            }
        }
        Value::Object(m)
    }
}

/// One file of the bundle, by its name inside the zip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub name: String,
    pub text: String,
}

/// `buildBundle`'s answer.
#[derive(Debug, Clone)]
pub struct Bundle {
    pub spawnloft: String,
    pub os: String,
    pub arch: String,
    pub server: Option<Facts>,
    pub client: Option<Facts>,
    pub timeline: Vec<Entry>,
    /// each `{ id, title, advice, line, at }`
    pub findings_server: Vec<Value>,
    pub findings_client: Vec<Value>,
    pub files: Vec<File>,
}

struct Collected {
    facts: Facts,
    timeline: Vec<Entry>,
    findings: Vec<Finding>,
    files: Vec<File>,
}

fn read_text(file: &str) -> Option<String> {
    std::fs::read(file)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// A file's mtime in whole milliseconds, as `new Date(stat.mtimeMs)` holds it.
fn mtime_ms(file: &str) -> Option<f64> {
    let m = std::fs::metadata(file).ok()?.modified().ok()?;
    Some(match m.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as f64,
        Err(e) => -(e.duration().as_millis() as f64),
    })
}

/// `state.startedAt ?? null` as `new Date()` reads it: a time in milliseconds, NaN for text that
/// is no date.
fn anchor_of(state: Option<&Value>) -> Option<f64> {
    match state.and_then(|s| s.get("startedAt")) {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(n.as_f64().unwrap_or(f64::NAN).trunc()),
        Some(Value::String(s)) => Some(jsdate::parse(s)),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(_) => Some(f64::NAN),
    }
}

/// A state file read as `JSON.parse(await readFile(...))` inside a `try`: `None` for no file,
/// no JSON, or `null`.
fn read_state(file: &str) -> Option<Value> {
    let text = read_text(file)?;
    match jsjson::parse(&text) {
        Ok(Value::Null) | Err(_) => None,
        Ok(v) => Some(v),
    }
}

fn lines_of(file: &str, count: usize) -> Result<Vec<String>, Failure> {
    supervisor::tail_log(Path::new(file), count as f64)
}

fn refs(lines: &[String]) -> Vec<&str> {
    lines.iter().map(String::as_str).collect()
}

/// `os.platform()`.
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// `os.arch()`.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// `line.replace(/=.*/, '=[redacted]')`: from the first `=` to the end of the line (JavaScript's
/// `.` stops at a carriage return, so a CRLF line keeps it).
fn redact_value(line: &str) -> String {
    let Some(eq) = line.find('=') else {
        return line.to_string();
    };
    let rest = &line[eq..];
    let end = rest
        .find(['\n', '\r', '\u{2028}', '\u{2029}'])
        .unwrap_or(rest.len());
    format!("{}=[redacted]{}", &line[..eq], &rest[end..])
}

/// `collectServer(name, { lines })`.
fn collect_server(layout: &Layout, name: &str, lines: usize, now: f64) -> Result<Collected, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    if inst.is_database() {
        return Err(Failure::user(format!(
            "\"{name}\" is a database, not a server - there is nothing to diagnose"
        )));
    }
    let (row, _) = supervisor::status_of(layout, name)?;
    let field = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    let external = js::truthy(row.get("external"));

    let software = inst
        .jar()
        .filter(|j| !j.is_empty())
        .map(|j| json!(j.split('-').next().unwrap_or("")))
        .unwrap_or(Value::Null);
    let version = plugins::mc_version_of(&inst).map_or(Value::Null, Value::String);

    let mut status = if external {
        json!("external")
    } else {
        field("status")
    };
    let mut console_lines = Vec::new();
    let mut daemon_lines = Vec::new();
    let mut timeline = Vec::new();

    let console_file = layout.console_log(name);
    if !Path::new(&console_file).exists() {
        status = json!("never started");
    } else {
        console_lines = lines_of(&console_file, lines)?;
        daemon_lines = lines_of(&jspath::join(&[&layout.run_dir_of(name), "daemon.log"]), lines)?;
        let state = read_state(&layout.state_file(name));
        let anchor = anchor_of(state.as_ref());
        let mtime = mtime_ms(&console_file);
        let server = log_timeline::parse_log(&refs(&console_lines), "server", anchor, mtime, now);
        let daemon = log_timeline::parse_log(&refs(&daemon_lines), "daemon", None, None, now);
        timeline = log_timeline::merge_timelines(vec![server, daemon]);
    }

    let findings = diagnose::diagnose(&console_lines, &diagnose::Context::of(&inst));
    let dir = js::string(inst.get("dir"));
    let (_, crashes) = diagnose::crash_reports(&dir, 3)?;

    let health = java::health();
    let java = health.found.then(|| {
        json!({
            "major": health.major,
            "version": health.version,
            "path": health.path,
        })
    });

    let mut names = Vec::new();
    for p in plugins::list_plugins(&inst)? {
        names.push(p.get("name").cloned().unwrap_or(Value::Null));
    }
    static MODS: LazyLock<Regex> =
        LazyLock::new(|| crate::jsregex::compile("fabric|neoforge", true).expect("mods pattern"));
    let plugin_key = if MODS.is_match(inst.jar().unwrap_or("")) {
        "mods"
    } else {
        "plugins"
    };

    let mut facts = Facts::default();
    facts.put("name", Some(json!(name)));
    facts.put("software", Some(software));
    facts.put("version", Some(version));
    facts.put("status", Some(status));
    facts.put("startedAt", Some(field("startedAt")));
    facts.put("memory", Some(field("memory")));
    facts.put("java", Some(java.unwrap_or(Value::Null)));
    facts.put(plugin_key, Some(Value::Array(names)));

    let mut files = vec![
        File {
            name: "server-console.log".into(),
            text: console_lines.join("\n"),
        },
        File {
            name: "server-daemon.log".into(),
            text: daemon_lines.join("\n"),
        },
    ];
    let sp = jspath::join(&[&dir, "server.properties"]);
    if Path::new(&sp).exists()
        && let Some(text) = read_text(&sp)
    {
        let text = text
            .split('\n')
            .map(|line| {
                let lower = line.to_ascii_lowercase();
                if lower.contains("password") || lower.contains("secret") || lower.contains("token") {
                    redact_value(line)
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        files.push(File {
            name: "server.properties".into(),
            text,
        });
    }
    for r in &crashes {
        let cp = jspath::join(&[&dir, "crash-reports", &r.file]);
        if let Some(text) = read_text(&cp) {
            files.push(File {
                name: format!("crash-reports/{}", r.file),
                text,
            });
        }
    }
    Ok(Collected {
        facts,
        timeline,
        findings,
        files,
    })
}

/// `collectClient(name, { lines })`.
fn collect_client(layout: &Layout, name: &str, lines: usize, now: f64) -> Result<Collected, Failure> {
    let paths = ClientPaths::new(layout);
    let profile = profiles::get(&paths, name)?;
    let st = client_state::status(&paths, name)?;

    let latest_path = client_log::latest_path(&paths, name);
    let latest_lines = lines_of(&latest_path, lines)?;
    // The game prints to stdout what it writes to latest.log (as log4j XML events, read back into
    // latest.log's lines here), so the process capture is kept for what only it has: JVM errors,
    // launcher output, lines after the logger died. An event is several raw lines, hence the window.
    let process_file = paths.log(name);
    let raw = lines_of(&process_file, lines * 4)?;
    let plain = client_log::split_lines(&client_log::plain(&raw.join("\n")));
    let in_latest: std::collections::HashSet<&str> = latest_lines.iter().map(String::as_str).collect();
    let process_lines: Vec<String> = client_log::last(plain, lines as f64)
        .into_iter()
        .filter(|l| !in_latest.contains(l.as_str()))
        .collect();

    let state = read_state(&paths.state_file(name));
    let anchor = anchor_of(state.as_ref());
    // the Java, arch and folders this run was launched with
    let launch = match state.as_ref().and_then(|s| s.get("launch")) {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    };

    // each log is dated by its own mtime: the process log keeps growing after latest.log stops
    let client = log_timeline::parse_log(
        &refs(&latest_lines),
        "client",
        anchor,
        mtime_ms(&latest_path),
        now,
    );
    let process = log_timeline::parse_log(
        &refs(&process_lines),
        "client-process",
        anchor,
        mtime_ms(&process_file),
        now,
    );
    let timeline = log_timeline::merge_timelines(vec![client, process]);

    let text_or_none = |v: Option<&Value>| match v {
        None | Some(Value::Null) => None,
        v => Some(js::string(v)),
    };
    let all: Vec<&String> = latest_lines.iter().chain(process_lines.iter()).collect();
    let findings = client_diagnose(
        &all,
        &ClientContext {
            memory: text_or_none(profile.get("memory")),
            profile: Some(name.to_string()),
            ..ClientContext::default()
        },
    );

    let profile_dir = paths.profile_dir(name);
    let (_, crashes) = diagnose::crash_reports(&profile_dir, 3)?;

    let mut mods: Vec<String> = crate::fsx::readdir_names(Path::new(&jspath::join(&[&profile_dir, "mods"])))
        .map(|names| names.into_iter().filter(|f| f.ends_with(".jar")).collect())
        .unwrap_or_default();
    mods.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    let status = |k: &str| st.json.get(k).cloned().unwrap_or(Value::Null);
    let mut facts = Facts::default();
    facts.put("name", Some(json!(name)));
    for k in ["mc", "loader", "loaderVersion", "memory", "java"] {
        facts.put(k, profile.get(k).cloned());
    }
    facts.put("mods", Some(json!(mods)));
    facts.put("running", Some(json!(st.running)));
    facts.put("startedAt", Some(status("startedAt")));
    facts.put("account", Some(status("account")));
    facts.put("launch", Some(launch));
    facts.put("harnessList", Some(harness_index::status(&paths)));

    let mut files = vec![
        File {
            name: "client-latest.log".into(),
            text: latest_lines.join("\n"),
        },
        File {
            name: "client-process.log".into(),
            text: process_lines.join("\n"),
        },
    ];
    let options = jspath::join(&[&profile_dir, "options.txt"]);
    if Path::new(&options).exists()
        && let Some(text) = read_text(&options)
    {
        files.push(File {
            name: "options.txt".into(),
            text,
        });
    }
    for r in &crashes {
        let cp = jspath::join(&[&profile_dir, "crash-reports", &r.file]);
        if let Some(text) = read_text(&cp) {
            files.push(File {
                name: format!("client-crash-reports/{}", r.file),
                text,
            });
        }
    }
    Ok(Collected {
        facts,
        timeline,
        findings,
        files,
    })
}

/// `PANEL_TOKEN`: a panel sign-in token (panel-auth.mjs) that ended up in a log, made
/// `v1.<kind>.[redacted]`. `(?![\w-])` after the 43-character tail is read as "the tail, taken
/// whole, is 43 long": nothing before it can hold a dot, so no other split could match.
fn redact_panel_tokens(s: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?-u:\b)v1\.(login|api)\.[0-9]+\.[0-9]+\.[A-Za-z0-9_-]*\.([A-Za-z0-9_-]+)")
            .expect("panel token pattern")
    });
    RE.replace_all(s, |c: &regex::Captures| {
        if c[2].len() == 43 {
            format!("v1.{}.[redacted]", &c[1])
        } else {
            c[0].to_string()
        }
    })
    .into_owned()
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `redactIdentities(identities)`: each identity of three or more characters, wherever it stands
/// on its own (no letter, digit or `_` either side), case-blind, longest first so a bare uuid is
/// not left half-replaced by its dashed form.
pub fn redact_identities(identities: &[String]) -> impl Fn(&str) -> String + use<> {
    let mut list: Vec<String> = Vec::new();
    for s in identities {
        if text::js_len(s) >= 3 && !list.contains(s) {
            list.push(s.clone());
        }
    }
    list.sort_by_key(|s| std::cmp::Reverse(text::js_len(s)));
    move |s: &str| {
        if list.is_empty() {
            return s.to_string();
        }
        let mut out = String::with_capacity(s.len());
        let mut i = 0;
        let mut prev: Option<char> = None;
        'outer: while i < s.len() {
            let rest = &s[i..];
            if !prev.is_some_and(is_word) {
                for id in &list {
                    let Some(head) = rest.get(..id.len()) else {
                        continue;
                    };
                    if !fold_eq(head, id) {
                        continue;
                    }
                    if rest[id.len()..].chars().next().is_some_and(is_word) {
                        continue;
                    }
                    out.push_str(MICROSOFT_PLACEHOLDER);
                    prev = head.chars().last();
                    i += id.len();
                    continue 'outer;
                }
            }
            let c = rest.chars().next().expect("a character");
            out.push(c);
            prev = Some(c);
            i += c.len_utf8();
        }
        out
    }
}

/// JavaScript's `/i` without `u` on the names and uuids it is given: ASCII letters fold, every
/// other character matches only itself.
fn fold_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.chars().zip(b.chars()).all(|(x, y)| x.eq_ignore_ascii_case(&y))
}

/// `buildBundle({ server, client, lines, scrub })`.
pub fn build_bundle(
    layout: &Layout,
    server: Option<&str>,
    client: Option<&str>,
    lines: usize,
    scrub: &dyn Fn(&str) -> String,
) -> Result<Bundle, Failure> {
    if server.is_none() && client.is_none() {
        return Err(Failure::user("diag needs a server or a client profile"));
    }
    let now = util::now();
    let mut bundle = Bundle {
        spawnloft: crate::data_format::release_version().to_string(),
        os: platform().into(),
        arch: arch().into(),
        server: None,
        client: None,
        timeline: Vec::new(),
        findings_server: Vec::new(),
        findings_client: Vec::new(),
        files: Vec::new(),
    };
    let mut server_findings = Vec::new();
    let mut client_findings = Vec::new();
    if let Some(name) = server {
        let r = collect_server(layout, name, lines, now)?;
        bundle.server = Some(r.facts);
        bundle.timeline = r.timeline;
        server_findings = r.findings;
        bundle.files = r.files;
    }
    if let Some(name) = client {
        let r = collect_client(layout, name, lines, now)?;
        bundle.client = Some(r.facts);
        let before = std::mem::take(&mut bundle.timeline);
        bundle.timeline = log_timeline::merge_timelines(vec![before, r.timeline]);
        client_findings = r.findings;
        bundle.files.extend(r.files);
    }

    // the timeline and findings reach summarise() and timeline.txt, not only files, so every text
    // field is cleaned. Minecraft's crash reports list every JVM flag, the harness token among
    // them, and the command line with the access token; both die with the game, but a bug report
    // should not carry them anyway. The signed-in Microsoft accounts' names and uuids go too: who
    // plays is not part of the bug. Offline player names stay; they are not identities.
    let paths = ClientPaths::new(layout);
    let mut identities = accounts::load(&paths)
        .map(|list| accounts::microsoft_identities(&list))
        .unwrap_or_default();
    let microsoft_account = bundle
        .client
        .as_ref()
        .and_then(|c| c.get("account"))
        .filter(|a| a.get("type") == Some(&json!("microsoft")))
        .cloned();
    if let Some(a) = &microsoft_account
        && js::truthy(a.get("name"))
    {
        // a name that is not text cannot match anything in a log
        if let Some(Value::String(n)) = a.get("name") {
            identities.push(n.clone());
        }
    }
    let hide = redact_identities(&identities);
    let clean = |s: &str| -> String {
        let s = hide(&scrub(&mclogs::redact_account_name(s)));
        redact_panel_tokens(&client_log::redact_line(&s))
    };
    let clean_value = |v: &Value| -> Value {
        match v {
            Value::String(s) => Value::String(clean(s)),
            other => other.clone(),
        }
    };
    if microsoft_account.is_some()
        && let Some(c) = bundle.client.as_mut()
        && let Some(slot) = c.get_mut("account")
    {
        *slot = Some(json!({ "type": "microsoft", "name": MICROSOFT_PLACEHOLDER }));
    }
    for f in &mut bundle.files {
        f.text = clean(&f.text);
    }
    let finding = |f: &Finding| json!({ "id": f.id, "title": clean(f.title), "advice": clean(&f.advice), "line": f.line, "at": f.at });
    bundle.findings_server = server_findings.iter().map(finding).collect();
    bundle.findings_client = client_findings.iter().map(finding).collect();
    for e in &mut bundle.timeline {
        e.text = clean(&e.text);
        e.raw = clean(&e.raw);
        e.thread = e.thread.as_deref().map(clean);
    }
    if let Some(s) = bundle.server.as_mut()
        && let Some(Some(Value::Object(java))) = s.get_mut("java")
        && let Some(p) = java.get("path").cloned()
    {
        java.insert("path".into(), clean_value(&p));
    }
    if let Some(c) = bundle.client.as_mut()
        && let Some(Some(j)) = c.get_mut("java")
    {
        *j = clean_value(j);
    }
    Ok(bundle)
}

impl Bundle {
    /// `bundle.facts`.
    pub fn facts_json(&self) -> Value {
        json!({
            "spawnloft": self.spawnloft,
            "os": self.os,
            "arch": self.arch,
            "server": self.server.as_ref().map_or(Value::Null, Facts::to_json),
            "client": self.client.as_ref().map_or(Value::Null, Facts::to_json),
        })
    }

    /// `summarySection(bundle)`: the bundle without the timeline and without the files' text:
    /// the logs are in the zip as themselves, so summary.json (and `diag --json`) names them
    /// with their size instead.
    pub fn summary_section(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("facts".into(), self.facts_json());
        m.insert(
            "findings".into(),
            json!({ "server": self.findings_server, "client": self.findings_client }),
        );
        m.insert(
            "files".into(),
            Value::Array(
                self.files
                    .iter()
                    .map(|f| json!({ "name": f.name, "bytes": f.text.len() }))
                    .collect(),
            ),
        );
        m
    }

    /// `summarise(bundle)`: the text `spawnloft diag` prints.
    pub fn summarise(&self) -> String {
        let mut parts = vec![
            format!("spawnloft: {}", self.spawnloft),
            format!("os: {}", self.os),
            format!("arch: {}", self.arch),
        ];
        let shown = |v: &Option<Value>| match v {
            Some(Value::Array(items)) => items
                .iter()
                .map(|i| match i {
                    Value::Null => String::new(),
                    other => js::string(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(", "),
            other => js::string(other.as_ref()),
        };
        if let Some(server) = &self.server {
            for (k, v) in &server.0 {
                if v == &Some(Value::Null) {
                    continue;
                }
                let val = match v {
                    Some(Value::Object(j)) if k == "java" => format!(
                        "{} (major {}) at {}",
                        js::string(j.get("version")),
                        js::string(j.get("major")),
                        js::string(j.get("path"))
                    ),
                    other => shown(other),
                };
                parts.push(format!("server {k}: {val}"));
            }
        }
        if let Some(client) = &self.client {
            for (k, v) in &client.0 {
                if v == &Some(Value::Null) {
                    continue;
                }
                parts.push(format!("client {k}: {}", shown(v)));
            }
        }
        let findings = |parts: &mut Vec<String>, list: &[Value]| {
            if list.is_empty() {
                parts.push("- no known failure shapes".into());
            }
            for f in list {
                parts.push(format!(
                    "- {}. {}",
                    js::string(f.get("title")),
                    js::string(f.get("advice"))
                ));
            }
        };
        if self.server.is_some() {
            parts.push("Server:".into());
            findings(&mut parts, &self.findings_server);
        }
        if self.client.is_some() {
            parts.push("Client:".into());
            findings(&mut parts, &self.findings_client);
        }
        let start = self.timeline.len().saturating_sub(40);
        let last40 = &self.timeline[start..];
        if !last40.is_empty() {
            parts.push(log_timeline::format_timeline(last40, 0));
        }
        parts.join("\n")
    }
}

/// What [`write_bundle`] wrote.
#[derive(Debug, Clone)]
pub struct Written {
    pub file: String,
    pub size: u64,
    pub entries: Vec<String>,
}

/// `writeBundle(bundle, { outDir })`: `<outDir>/<name>_diag_<stamp>.zip`, holding summary.json,
/// timeline.txt and the files, made from a scratch folder that is removed afterwards.
pub fn write_bundle(bundle: &Bundle, out_dir: &str) -> Result<Written, Failure> {
    let base = bundle
        .server
        .as_ref()
        .or(bundle.client.as_ref())
        .and_then(|f| f.get("name"))
        .map_or_else(|| "diag".to_string(), |n| js::string(Some(n)));
    std::fs::create_dir_all(out_dir).map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(out_dir))))?;
    let file = jspath::join(&[out_dir, &format!("{base}_diag_{}.zip", util::stamp())]);

    let tmp = crate::engines::mkdtemp(&jspath::join(&[&util::os_tmpdir(), "sl-diag-"]))?;
    let made = (|| -> Result<(), Failure> {
        let write = |name: &str, text: &str| -> Result<(), Failure> {
            let p = tmp.join(name);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).map_err(|e| Failure::io(&e, "mkdir", Some(parent)))?;
            }
            std::fs::write(&p, text).map_err(|e| Failure::io(&e, "open", Some(&p)))
        };
        let mut members: Vec<String> = Vec::new();
        write(
            "summary.json",
            &jsjson::stringify_pretty(&Value::Object(bundle.summary_section())),
        )?;
        members.push("summary.json".into());
        write(
            "timeline.txt",
            &log_timeline::format_timeline(&bundle.timeline, 0),
        )?;
        members.push("timeline.txt".into());
        for f in &bundle.files {
            write(&f.name, &f.text)?;
            members.push(f.name.clone());
        }
        let refs: Vec<&str> = members.iter().map(String::as_str).collect();
        zip::create(Path::new(&file), &tmp.to_string_lossy(), &refs, &[], false)?;
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    made?;

    let size = std::fs::metadata(&file)
        .map_err(|e| Failure::io(&e, "stat", Some(Path::new(&file))))?
        .len();
    let mut src = std::fs::File::open(&file).map_err(|e| Failure::io(&e, "open", Some(Path::new(&file))))?;
    let mut entries = Vec::new();
    for entry in zip::entries(&mut src)? {
        entries.push(entry?.name);
    }
    Ok(Written { file, size, entries })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_are_hidden_where_they_stand_alone() {
        let hide = redact_identities(&[
            "Wunga_".into(),
            "0123456789abcdef0123456789abcdef".into(),
            "ab".into(),
        ]);
        assert_eq!(
            hide("Setting user: wunga_ joined; xWunga_ stays; UUID 0123456789ABCDEF0123456789abcdef."),
            "Setting user: [microsoft account] joined; xWunga_ stays; UUID [microsoft account]."
        );
        assert_eq!(hide("ab cd"), "ab cd");
        assert_eq!(redact_identities(&[])("Wunga_"), "Wunga_");
    }

    #[test]
    fn panel_tokens_need_the_whole_tail() {
        let tail = "A".repeat(43);
        assert_eq!(
            redact_panel_tokens(&format!("t=v1.api.1.2.abc.{tail} x")),
            "t=v1.api.[redacted] x"
        );
        assert_eq!(
            redact_panel_tokens(&format!("v1.login.1.2..{tail}")),
            "v1.login.[redacted]"
        );
        let long = format!("v1.api.1.2.abc.{tail}B");
        assert_eq!(redact_panel_tokens(&long), long);
        let word = format!("xv1.api.1.2.abc.{tail}");
        assert_eq!(redact_panel_tokens(&word), word);
    }

    #[test]
    fn a_secret_line_keeps_its_carriage_return() {
        assert_eq!(
            redact_value("rcon.password=hunter2\r"),
            "rcon.password=[redacted]\r"
        );
        assert_eq!(redact_value("token"), "token");
        assert_eq!(redact_value("a=b=c"), "a=[redacted]");
    }
}
