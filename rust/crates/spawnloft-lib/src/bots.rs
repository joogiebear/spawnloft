//! `bots.mjs`: scripted test players for plugin testing, behind `spawnloft bot ...` and the
//! `bot_*` MCP tools (C9, rust/PLAN-CORE-PORT.md section 5.4).
//!
//! A scenario is a JSON file naming a server, some bots and an ordered list of steps. The core
//! does the part that needs SpawnLoft - find the server, refuse one that is not safe to join, run
//! the setup commands over RCON, know where the console log is - and hands everything else to the
//! bot host (`src/bot-host.cjs`), the one process that loads mineflayer. The host stays
//! JavaScript: mineflayer is npm packages that `bot setup` installs into the data folder.
//!
//! Before C10 the host still runs on a Node.js: the bundled runtime's when this install has one,
//! else the one on PATH (`runtime::node`), with `NODE_OPTIONS` and `NODE_PATH` removed. The core
//! carries the host script and the pinned `package.json` and lockfile inside itself and writes
//! the script into the host folder before a run (the declared difference `bot-host-script`).
//! TODO(C10): the `bot.node` setting and the minimum-version check of plan section 5.4.

use serde_json::{Map, Value, json};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;

use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{exposure, js, jsjson, jspath, jsregex, plugins, props, rcon, supervisor};

/// `src/bot-host.cjs`, written into the host folder before a run.
pub const HOST_SCRIPT: &str = include_str!("../../../../src/bot-host.cjs");
/// The name the host script is written under in the host folder.
pub const HOST_SCRIPT_NAME: &str = "bot-host.cjs";
/// What `bot setup` installs (`src/bot-host/`): an exact mineflayer and a lockfile for its tree.
const PINNED_FILES: [(&str, &str); 2] = [
    (
        "package.json",
        include_str!("../../../../src/bot-host/package.json"),
    ),
    (
        "package-lock.json",
        include_str!("../../../../src/bot-host/package-lock.json"),
    ),
];
/// Written into the host folder only after npm ci has finished, so an install cut short is not
/// taken for a good one.
const PINNED_MARKER: &str = ".spawnloft-pinned";
pub const MAX_BOTS: usize = 5;
const STEP_KEYS: [&str; 10] = [
    "chat",
    "command",
    "expectMessage",
    "waitWindow",
    "click",
    "closeWindow",
    "expectItem",
    "expectState",
    "expectLog",
    "leave",
];
const STEP_EXTRAS: [&str; 3] = ["bot", "timeout", "button"];
/// Commands that would take the server down behind the supervisor's back, or run Bukkit's
/// reload. The run_command MCP tool refuses them, and so does a scenario, as setup or as a bot.
pub const REFUSED_CONSOLE: &[&str] = &["stop", "restart", "reload", "rl"];
/// What the core and the host say to each other; see [`run_host`].
const JOINED_LINE: &str = "{\"event\":\"joined\"}";

static BOT_NAME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_]{3,16}$").expect("bot name pattern"));
/// What the console answers when a setup command did nothing. Paper's words, with vanilla's.
static SETUP_FAILED_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    jsregex::compile(
        "No player was found|Unknown or incomplete command|Unknown command|Incorrect argument|Expected whitespace|You do not have permission",
        true,
    )
    .expect("setup failure pattern")
});

/// `MINEFLAYER_VERSION`: the pinned mineflayer, from the embedded package.json.
pub fn mineflayer_version() -> String {
    jsjson::parse(PINNED_FILES[0].1)
        .ok()
        .and_then(|v| v.pointer("/dependencies/mineflayer").map(|m| js::string(Some(m))))
        .unwrap_or_default()
}

/// `REFUSED_CONSOLE.has(verb)`.
pub fn is_refused(verb: &str) -> bool {
    REFUSED_CONSOLE.contains(&verb)
}

/// `commandVerb(line)`: the command word of a console or chat line, "/minecraft:stop now" is
/// "stop".
pub fn command_verb(line: &str) -> String {
    let t = js::trim(line);
    let t = t.strip_prefix('/').unwrap_or(t);
    let first = t.split(js::is_js_space).next().unwrap_or("");
    let lower = first.to_lowercase();
    match lower.find(':') {
        Some(i)
            if i > 0
                && lower[..i]
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b)) =>
        {
            lower[i + 1..].to_string()
        }
        _ => lower,
    }
}

/// `HOST_DIR`: where mineflayer is installed, under the data root.
pub fn host_dir(layout: &Layout) -> String {
    jspath::join(&[&layout.data_root, "bot-host"])
}

/// Where mineflayer is, and its version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInstall {
    pub dir: String,
    pub version: String,
}

/// `hostInstall()`: where mineflayer is, or `None` when `bot setup` has not run on this machine.
/// A half-written or unreadable package.json is "not installed" too: `setup --force` puts it
/// right.
pub fn host_install(layout: &Layout) -> Option<HostInstall> {
    let dir = host_dir(layout);
    let pkg = jspath::join(&[&dir, "node_modules", "mineflayer", "package.json"]);
    let bytes = std::fs::read(pkg).ok()?;
    let meta = jsjson::parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let version = match &meta {
        Value::Object(m) => m.get("version"),
        _ => None,
    };
    js::truthy(version).then(|| HostInstall {
        dir,
        version: js::string(version),
    })
}

/// `pinnedStamp()`: the shipped pin as one string, line endings evened out (a Windows checkout
/// ships CRLF, a Linux one LF), the files joined by NUL.
pub fn pinned_stamp() -> String {
    PINNED_FILES
        .iter()
        .map(|(_, text)| text.replace("\r\n", "\n"))
        .collect::<Vec<_>>()
        .join("\0")
}

/// `hostIsPinned()`: whether the install is a finished install of the lockfile this SpawnLoft
/// ships.
pub fn host_is_pinned(layout: &Layout) -> bool {
    std::fs::read(jspath::join(&[&host_dir(layout), PINNED_MARKER]))
        .is_ok_and(|b| String::from_utf8_lossy(&b) == pinned_stamp())
}

fn npm_command() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// `ensureHost({ force, onProgress })`: install mineflayer into the data root, once, with
/// `npm ci` against the pinned lockfile (`--ignore-scripts`: nothing in the tree has an install
/// script, so one that grew later would run code nobody reviewed).
pub fn ensure_host(layout: &Layout, force: bool, on_progress: &dyn Fn(&str)) -> Result<HostInstall, Failure> {
    if let Some(have) = host_install(layout)
        && host_is_pinned(layout)
        && !force
    {
        return Ok(have);
    }
    let dir = host_dir(layout);
    crate::fsx::mkdir_all(Path::new(&dir))?;
    let marker = jspath::join(&[&dir, PINNED_MARKER]);
    match std::fs::remove_file(&marker) {
        Err(e) if !jspath::is_enoent(&e) => return Err(Failure::io(&e, "rm", Some(Path::new(&marker)))),
        _ => {}
    }
    for (name, text) in PINNED_FILES {
        let dest = jspath::join(&[&dir, name]);
        std::fs::write(&dest, text).map_err(|e| Failure::io(&e, "copyfile", Some(Path::new(&dest))))?;
    }
    let npm = npm_command();
    let mut probe = Command::new(npm);
    probe.arg("--version").stdin(Stdio::null());
    hide_window(&mut probe);
    let probed = probe.output().ok().filter(|o| o.status.code() == Some(0));
    let Some(probed) = probed else {
        return Err(Failure::user(
            [
                "npm was not found, and it is what installs mineflayer.".to_string(),
                "  Install Node.js from https://nodejs.org (npm comes with it), open a new terminal, and run: spawnloft bot setup".to_string(),
                format!("  The install goes into {dir} and is about 500 MB."),
            ]
            .join("\n"),
        ));
    };
    on_progress(&format!(
        "Installing mineflayer {} and its locked dependencies into {dir} with npm {} (about 500 MB, a few minutes)",
        mineflayer_version(),
        js::trim(&String::from_utf8_lossy(&probed.stdout))
    ));
    let mut ci = Command::new(npm);
    ci.args([
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
    ])
    .current_dir(&dir)
    .stdin(Stdio::null());
    hide_window(&mut ci);
    let res = ci.output();
    let ok = res.as_ref().is_ok_and(|o| o.status.code() == Some(0));
    if !ok {
        let (code, text) = match &res {
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr).into_owned();
                let text = if stderr.is_empty() {
                    String::from_utf8_lossy(&o.stdout).into_owned()
                } else {
                    stderr
                };
                (
                    o.status.code().map_or("null".to_string(), |c| c.to_string()),
                    text,
                )
            }
            Err(_) => ("null".to_string(), String::new()),
        };
        let lines: Vec<&str> = js::trim(&text).split('\n').collect();
        let tail = lines[lines.len().saturating_sub(15)..].join("\n");
        return Err(Failure::user(format!(
            "npm ci failed (exit {code}) in {dir}:\n{tail}"
        )));
    }
    let Some(installed) = host_install(layout) else {
        return Err(Failure::user(format!(
            "npm ci finished but mineflayer is not in {dir}/node_modules"
        )));
    };
    std::fs::write(&marker, pinned_stamp()).map_err(|e| Failure::io(&e, "open", Some(Path::new(&marker))))?;
    Ok(installed)
}

/// What [`check_instance`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub inst: Instance,
    pub ok: bool,
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
    /// `mcVersionOf(inst) ?? null`
    pub version: Option<String>,
    /// Where the bots connect: the bound address, or loopback when the server listens everywhere.
    pub host: String,
}

impl Check {
    /// The version when JavaScript would print it (`res.version ? ... : ''`).
    fn shown_version(&self) -> Option<&str> {
        self.version.as_deref().filter(|v| !v.is_empty())
    }
}

/// `checkInstance(name)`: whether bots may join this server, and why not. Offline mode is
/// required (a bot has no account); loopback is advised, with a warning that names the risk.
pub fn check_instance(layout: &Layout, name: &str) -> Result<Check, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    if inst.is_database() {
        return Err(Failure::user(format!(
            "\"{name}\" is a database, not a Minecraft server"
        )));
    }
    let dir = registry::dir_text(&inst)?;
    let props_file = jspath::join(&[&dir, "server.properties"]);
    let props = props::read(Path::new(&props_file))?;
    let mut problems = Vec::new();
    let mut warnings = Vec::new();
    if props::get(&props, "online-mode") != Some("false") {
        problems.push(format!(
            "\"{name}\" runs in online mode, and bots have no account to log in with. Set online-mode=false in {props_file} on a server kept for testing, then restart it."
        ));
    }
    if !supervisor::is_running(layout, name)? {
        problems.push(format!(
            "\"{name}\" is not running. Start it first: spawnloft start {name}"
        ));
    }
    let bound = exposure::bound_address(&dir);
    let everywhere = ["", "0.0.0.0", "::"].contains(&bound.as_str());
    if everywhere || !["127.0.0.1", "localhost", "::1"].contains(&bound.as_str()) {
        warnings.push(format!(
            "\"{name}\" listens on {} in offline mode, so anyone who can reach port {} can join under any name. For a test server, set server-ip=127.0.0.1.",
            if everywhere { "every interface" } else { &bound },
            js::string(inst.get("port"))
        ));
    }
    let version = plugins::mc_version_of(&inst);
    Ok(Check {
        ok: problems.is_empty(),
        problems,
        warnings,
        version,
        host: if everywhere {
            "127.0.0.1".to_string()
        } else {
            bound
        },
        inst,
    })
}

/// A checked scenario. The values a scenario file may give in any shape stay JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct Scenario {
    /// `data.name ?? name ?? 'scenario'`
    pub name: Value,
    /// `data.instance ?? null`
    pub instance: Value,
    pub bots: Vec<String>,
    pub setup: Vec<String>,
    pub steps: Vec<Value>,
}

/// `path.basename(file, '.json')`.
fn basename_json(file: &str) -> String {
    let base = jspath::basename(file);
    if base == ".json" {
        // Node keeps a lone ".json" after a folder, and gives "" for the bare name
        let bare = file.trim_end_matches(['/', std::path::MAIN_SEPARATOR]);
        return if bare == ".json" { String::new() } else { base };
    }
    base.strip_suffix(".json").map_or(base.clone(), str::to_string)
}

/// `loadScenario(file)`: the scenario as a checked object, with the file's name as a fallback for
/// its own.
pub fn load_scenario(file: &str) -> Result<Scenario, Failure> {
    let raw = std::fs::read(file).map_err(|e| {
        Failure::user(format!(
            "cannot read scenario {file}: {}",
            jspath::read_error(&e, Path::new(file))
        ))
    })?;
    let data = jsjson::parse(&String::from_utf8_lossy(&raw))
        .map_err(|e| Failure::user(format!("{file} is not valid JSON: {e}")))?;
    validate_scenario(&data, Some(&basename_json(file)))
}

fn fail<T>(message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure::user(message))
}

/// `Number.isInteger(v)`.
fn is_integer(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f.is_finite() && f.fract() == 0.0),
        _ => false,
    }
}

/// `v && typeof v === 'object' && !Array.isArray(v)`
fn is_plain_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

/// `typeof v === 'object'` for a truthy value: objects and arrays.
fn is_object_like(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `/^\/(.+)\/([a-z]*)$/s`: the source and flags of a `/regex/flags` pattern.
fn split_pattern(pattern: &str) -> Option<(&str, &str)> {
    let rest = pattern.strip_prefix('/')?;
    let slash = rest.rfind('/')?;
    let (source, flags) = (&rest[..slash], &rest[slash + 1..]);
    (!source.is_empty() && flags.bytes().all(|b| b.is_ascii_lowercase())).then_some((source, flags))
}

/// `new RegExp(source, flags)`'s refusal, if it refuses. The host that runs the scenario
/// matches in JavaScript on Node, so the same Node decides: V8 itself checks the pattern, with
/// its own dialects (`u`, `v`, the syntax of that Node's version) and its own words. Without a
/// Node to ask (the host could not run either), `jsregex` checks it in JavaScript's non-Unicode
/// dialect, and what it cannot run (lookaround, a backreference) is left to the host.
fn regexp_error(source: &str, flags: &str) -> Option<String> {
    if let Some(answer) = v8_check(source, flags) {
        return answer;
    }
    let mut seen = String::new();
    for c in flags.chars() {
        if !"dgimsuvy".contains(c) || seen.contains(c) {
            return Some(format!("Invalid flags supplied to RegExp constructor '{flags}'"));
        }
        seen.push(c);
    }
    if seen.contains('u') && seen.contains('v') {
        return Some(format!("Invalid flags supplied to RegExp constructor '{flags}'"));
    }
    match jsregex::compile(source, flags.contains('i')) {
        Ok(_) => None,
        Err(jsregex::PatternError::Invalid(why)) => Some(format!(
            "Invalid regular expression: /{source}/{flags}: regex parse error: {why}"
        )),
        Err(jsregex::PatternError::Unsupported(_)) => None,
    }
}

/// Answers `[source, flags]` lines with V8's refusal (or null), one JSON line each.
const CHECKER: &str = "require('readline').createInterface({ input: process.stdin }).on('line', (l) => { let r = null; try { const [s, f] = JSON.parse(l); new RegExp(s, f) } catch (e) { r = String(e && e.message) } process.stdout.write(JSON.stringify(r) + '\\n') })";

struct Checker {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
}

impl Drop for Checker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One Node, started on the first pattern and kept for the process.
static CHECKER_NODE: std::sync::Mutex<Option<Checker>> = std::sync::Mutex::new(None);

/// V8's answer for one pattern: `Some(None)` valid, `Some(Some(why))` refused, `None` when no
/// Node could be asked.
fn v8_check(source: &str, flags: &str) -> Option<Option<String>> {
    use std::io::{BufRead, Write};
    let mut slot = CHECKER_NODE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for _ in 0..2 {
        if slot.is_none() {
            let node = crate::runtime::node().ok()?;
            let mut cmd = Command::new(node);
            cmd.args(["-e", CHECKER])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            crate::runtime::prepare(&mut cmd);
            hide_window(&mut cmd);
            let mut child = cmd.spawn().ok()?;
            let stdin = child.stdin.take()?;
            let stdout = std::io::BufReader::new(child.stdout.take()?);
            *slot = Some(Checker { child, stdin, stdout });
        }
        let c = slot.as_mut()?;
        let line = format!(
            "{}\n",
            serde_json::Value::Array(vec![source.into(), flags.into()])
        );
        let mut reply = String::new();
        let asked = c.stdin.write_all(line.as_bytes()).and_then(|()| c.stdin.flush());
        if asked.is_ok() && c.stdout.read_line(&mut reply).is_ok_and(|n| n > 0) {
            return match serde_json::from_str::<Value>(&reply) {
                Ok(Value::String(why)) => Some(Some(why)),
                Ok(Value::Null) => Some(None),
                _ => None,
            };
        }
        // a Node that went away is started again, once
        *slot = None;
    }
    None
}

/// `checkPattern(where, field, pattern)`: plain text, or `/.../flags` for a regular expression;
/// the g and y flags are refused because they make `test()` stateful.
fn check_pattern(at: &str, field: &str, pattern: Option<&Value>) -> Result<(), Failure> {
    let text = match pattern {
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => {
            return fail(format!(
                "{at}: \"{field}\" must be text or /a regular expression/"
            ));
        }
    };
    let Some((source, flags)) = split_pattern(text) else {
        return Ok(());
    };
    if flags.contains(['g', 'y']) {
        let which = if flags.contains('g') { 'g' } else { 'y' };
        return fail(format!(
            "{at}: \"{field}\" uses the {which} flag, which has no meaning for a match here; drop it"
        ));
    }
    match regexp_error(source, flags) {
        Some(why) => fail(format!(
            "{at}: \"{field}\" is not a valid regular expression: {why}"
        )),
        None => Ok(()),
    }
}

/// `validateScenario(data, { name })`: every refusal names the step and what is wrong with it.
pub fn validate_scenario(data: &Value, name: Option<&str>) -> Result<Scenario, Failure> {
    let Value::Object(d) = data else {
        return fail("a scenario is a JSON object");
    };
    let nullish = |k: &str| d.get(k).filter(|v| !v.is_null());
    let scenario_name = nullish("name")
        .cloned()
        .or_else(|| name.map(|n| json!(n)))
        .unwrap_or_else(|| json!("scenario"));
    let instance = nullish("instance").cloned().unwrap_or(Value::Null);
    let bots_value = match d.get("bots") {
        Some(Value::Array(b)) if !b.is_empty() => b,
        _ => return fail("\"bots\" must list at least one bot name"),
    };
    if bots_value.len() > MAX_BOTS {
        return fail(format!(
            "\"bots\" lists {} bots; the limit is {MAX_BOTS}",
            bots_value.len()
        ));
    }
    let mut bots = Vec::new();
    for b in bots_value {
        match b {
            Value::String(s) if BOT_NAME_RE.is_match(s) => bots.push(s.clone()),
            _ => {
                return fail(format!(
                    "bot name {} is not a Minecraft name (3 to 16 letters, digits or underscores)",
                    jsjson::stringify(b)
                ));
            }
        }
    }
    let mut lower: Vec<String> = bots.iter().map(|b| b.to_lowercase()).collect();
    lower.sort();
    lower.dedup();
    if lower.len() != bots.len() {
        return fail("bot names must differ");
    }
    let setup = match nullish("setup") {
        None => Vec::new(),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => items
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(_) => return fail("\"setup\" must be a list of console commands"),
    };
    for cmd in &setup {
        let verb = command_verb(cmd);
        if is_refused(&verb) {
            return fail(format!(
                "setup command \"{verb}\" would take the server down or half-reload it; a scenario cannot run it"
            ));
        }
    }
    let steps = match d.get("steps") {
        Some(Value::Array(s)) if !s.is_empty() => s.clone(),
        _ => return fail("\"steps\" must list at least one step"),
    };
    for (i, step) in steps.iter().enumerate() {
        check_step(&format!("step {}", i + 1), step, &bots)?;
    }
    Ok(Scenario {
        name: scenario_name,
        instance,
        bots,
        setup,
        steps,
    })
}

fn check_step(at: &str, step: &Value, bots: &[String]) -> Result<(), Failure> {
    let Value::Object(s) = step else {
        return fail(format!("{at} is not an object"));
    };
    // Object.keys: integer-like keys first, then the rest in insertion order
    let mut ordered = step.clone();
    jsjson::js_order(&mut ordered);
    let all: Vec<&str> = ordered
        .as_object()
        .map(|m| m.keys().map(String::as_str).collect())
        .unwrap_or_default();
    let all: Vec<String> = all.into_iter().map(str::to_string).collect();
    let keys: Vec<&str> = all
        .iter()
        .map(String::as_str)
        .filter(|k| STEP_KEYS.contains(k))
        .collect();
    if keys.len() != 1 {
        return fail(format!(
            "{at} must have exactly one of {}; it has {}",
            STEP_KEYS.join(", "),
            if keys.is_empty() {
                "none".to_string()
            } else {
                keys.join(", ")
            }
        ));
    }
    let unknown: Vec<String> = all
        .iter()
        .filter(|k| !STEP_KEYS.contains(&k.as_str()) && !STEP_EXTRAS.contains(&k.as_str()))
        .map(|k| jsjson::quote(k))
        .collect();
    if !unknown.is_empty() {
        let every: Vec<&str> = STEP_KEYS.iter().chain(STEP_EXTRAS.iter()).copied().collect();
        return fail(format!(
            "{at} has {}, which is not a step key; the keys are {}",
            unknown.join(", "),
            every.join(", ")
        ));
    }
    let kind = keys[0];
    let bot = s.get("bot");
    let known_bot = matches!(bot, Some(Value::String(b)) if bots.contains(b));
    if kind != "expectLog" && !known_bot {
        let named = bot.filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
        return fail(format!(
            "{at} ({kind}) names bot {}, which is not in \"bots\"",
            jsjson::stringify(&named)
        ));
    }
    if let Some(t) = s.get("timeout") {
        let f = t.as_f64().unwrap_or(f64::NAN);
        if !(is_integer(Some(t)) && f > 0.0 && f <= 300_000.0) {
            return fail(format!("{at}: \"timeout\" is milliseconds, 1 to 300000"));
        }
    }
    let value = s.get(kind);
    match kind {
        "chat" | "command" => {
            let text = match value {
                Some(Value::String(t)) if !js::trim(t).is_empty() => t,
                _ => return fail(format!("{at}: \"{kind}\" must be text")),
            };
            // a chat line starting with "/" is a command too: the server does not know the difference
            let is_command = kind == "command" || text.trim_start_matches(js::is_js_space).starts_with('/');
            if is_command {
                let verb = command_verb(text);
                if is_refused(&verb) {
                    return fail(format!(
                        "{at}: \"{verb}\" would take the server down or half-reload it; a bot cannot run it"
                    ));
                }
            }
        }
        "expectMessage" | "waitWindow" => check_pattern(at, kind, value)?,
        "expectLog" => {
            let want = value.filter(|v| is_object_like(Some(v)));
            let get = |k: &str| want.and_then(|w| w.get(k));
            let (present, absent) = (get("present"), get("absent"));
            if want.is_none() || present.is_none() == absent.is_none() {
                return fail(format!(
                    "{at}: expectLog takes {{\"present\": pattern}} or {{\"absent\": pattern}}"
                ));
            }
            let field = if present.is_some() { "present" } else { "absent" };
            check_pattern(at, field, present.filter(|v| !v.is_null()).or(absent))?;
        }
        "click" if !is_integer(value) => {
            return fail(format!("{at}: \"click\" is a slot number"));
        }
        "expectItem" => {
            let ok = match value {
                Some(Value::String(t)) => !t.is_empty(),
                Some(Value::Object(w)) => {
                    w.get("name").is_some_and(Value::is_string)
                        && (w.get("count").is_none() || is_integer(w.get("count")))
                }
                _ => false,
            };
            if !ok {
                return fail(format!(
                    "{at}: expectItem is an item name such as \"minecraft:diamond\", or {{\"name\": ..., \"count\": n}}"
                ));
            }
        }
        "expectState" if !is_plain_object(value) => {
            return fail(format!(
                "{at}: expectState is an object of what to wait for (gameMode, minHealth, maxHealth, dimension, near, nearBot, seesPlayer)"
            ));
        }
        _ => {}
    }
    Ok(())
}

/// The Node.js the bot host runs on until C10: the bundled runtime's, else `node` on PATH.
fn host_node() -> Result<PathBuf, Failure> {
    crate::runtime::node()
        .map_err(|e| Failure::user(format!("the bot host runs on Node.js, and none was found: {e}")))
}

/// `runScenario(scenario, { instance, onProgress })`: run one scenario end to end and return its
/// report, as the Node core shapes it. `instance` beats the file's, so one scenario file serves
/// several test servers. The bots join first; then setup runs as the console, and its replies
/// are in the report.
pub fn run_scenario(
    layout: &Layout,
    scenario: &Scenario,
    instance: Option<&str>,
    on_progress: &dyn Fn(&str),
) -> Result<Value, Failure> {
    let script = PathBuf::from(jspath::join(&[&host_dir(layout), HOST_SCRIPT_NAME]));
    run_scenario_with(layout, scenario, instance, on_progress, &|| {
        let node = host_node()?;
        // the core's own copy, so the host always matches the core that drives it; written
        // only when it differs, and by rename, so a run starting beside this one never reads
        // half a script
        if std::fs::read(&script).ok().as_deref() != Some(HOST_SCRIPT.as_bytes()) {
            let tmp = script.with_extension(format!("cjs.{}.tmp", std::process::id()));
            std::fs::write(&tmp, HOST_SCRIPT).map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
            std::fs::rename(&tmp, &script).map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                Failure::io(&e, "rename", Some(&script))
            })?;
        }
        Ok((node, script.clone()))
    })
}

type HostFn<'a> = &'a dyn Fn() -> Result<(PathBuf, PathBuf), Failure>;

fn run_scenario_with(
    layout: &Layout,
    scenario: &Scenario,
    instance: Option<&str>,
    on_progress: &dyn Fn(&str),
    host_program: HostFn<'_>,
) -> Result<Value, Failure> {
    let name_value = match instance {
        Some(i) => json!(i),
        None => scenario.instance.clone(),
    };
    if !js::truthy(Some(&name_value)) {
        return fail("no server named: put \"instance\" in the scenario or pass --instance <name>");
    }
    let name = js::string(Some(&name_value));
    let check = check_instance(layout, &name)?;
    if !check.ok {
        return fail(check.problems.join("\n"));
    }
    for w in &check.warnings {
        on_progress(&format!("warning: {w}"));
    }
    let dir = host_dir(layout);
    let Some(host) = host_install(layout) else {
        return fail(format!(
            "mineflayer is not installed. Run once: spawnloft bot setup (about 500 MB into {dir})"
        ));
    };
    let inst = &check.inst;
    let log = layout.console_log(&name);
    let log_offset = std::fs::metadata(&log).map_or(0, |m| m.len());

    let mut setup: Vec<Value> = Vec::new();
    let mut run_setup = || -> Result<Option<String>, Failure> {
        if scenario.setup.is_empty() {
            return Ok(None);
        }
        on_progress(&format!(
            "running {} setup command(s) as the console",
            scenario.setup.len()
        ));
        let commands: Vec<&str> = scenario
            .setup
            .iter()
            .map(|c| c.strip_prefix('/').unwrap_or(c))
            .collect();
        let replies = rcon::exec(inst, &commands, rcon::ExecOptions::default())
            .map_err(|e| Failure::user(e.message))?;
        for (i, command) in scenario.setup.iter().enumerate() {
            let reply = rcon::strip_colors(replies.get(i).map_or("", String::as_str));
            let reply = js::trim(&reply).to_string();
            let ok = !SETUP_FAILED_RE.is_match(&reply);
            setup.push(json!({ "command": command, "reply": reply, "ok": ok }));
        }
        Ok(setup.iter().find(|s| s["ok"] == json!(false)).map(|bad| {
            format!(
                "setup command \"{}\" failed: {}",
                js::string(bad.get("command")),
                js::string(bad.get("reply"))
            )
        }))
    };

    let mut job = json!({
        "name": scenario.name,
        "hostDir": host.dir,
        "host": check.host,
        "port": inst.get("port").cloned().unwrap_or(Value::Null),
        "version": check.version,
        "bots": scenario.bots,
        "steps": scenario.steps,
        "consoleLog": log,
        "logOffset": log_offset,
        "waitForSetup": true,
    });
    // `port: inst.port` is left out of the file when the record has none
    if inst.get("port").is_none()
        && let Value::Object(m) = &mut job
    {
        m.shift_remove("port");
    }
    let job_file = jspath::join(&[
        &dir,
        &format!(
            "job-{}-{}.json",
            std::process::id(),
            js::number_to_string(crate::util::now())
        ),
    ]);
    std::fs::write(&job_file, jsjson::stringify(&job))
        .map_err(|e| Failure::io(&e, "open", Some(Path::new(&job_file))))?;
    let (node, script) = match host_program() {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&job_file);
            return Err(e);
        }
    };
    on_progress(&format!(
        "{} bot(s) joining {name} on {}:{}{}",
        scenario.bots.len(),
        check.host,
        js::string(inst.get("port")),
        check
            .shown_version()
            .map_or(String::new(), |v| format!(" (Minecraft {v})"))
    ));
    let report = run_host(&node, &script, Path::new(&job_file), on_progress, &mut run_setup);
    let _ = std::fs::remove_file(&job_file);
    let report = report?;
    let mut out = match report {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("instance".into(), name_value);
    out.insert("setup".into(), Value::Array(setup));
    out.insert("mineflayer".into(), json!(host.version));
    out.insert("warnings".into(), json!(check.warnings));
    Ok(Value::Object(out))
}

enum HostEvent {
    Stdout(Vec<u8>),
    StderrLine(Vec<u8>),
    Closed,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// `runHost(jobFile, { onProgress, onJoined, script })`: start the host and wait for its report.
///
/// The host speaks JSON lines on stdout: `{"event":"joined"}` once the bots are in, then the
/// report as its last line. The one word it takes back on stdin is whether to go on after setup:
/// `{"go":true}`, or `{"abort":...}` when `on_joined` names a problem or fails. The host can die
/// at any point, so a write to it that fails is ignored, "joined" is acted on once even when it
/// arrives split across reads, and the report is whichever stdout line parses as one.
pub fn run_host(
    node: &Path,
    script: &Path,
    job_file: &Path,
    on_progress: &dyn Fn(&str),
    on_joined: &mut dyn FnMut() -> Result<Option<String>, Failure>,
) -> Result<Value, Failure> {
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .arg(job_file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::runtime::prepare(&mut cmd);
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Failure::Internal {
        head: "Error".into(),
        message: format!("spawn {} {}", node.display(), jspath::error_code(&e).0),
        code: Some(jspath::error_code(&e).0.to_string()),
    })?;
    let mut stdin = child.stdin.take();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut readers = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(HostEvent::Stdout(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(HostEvent::Closed);
        }));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(err);
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(HostEvent::StderrLine(line)).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(HostEvent::Closed);
        }));
    }
    drop(tx);
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr = String::new();
    let mut signalled = false;
    let mut open = readers.len();
    while open > 0 {
        let Ok(event) = rx.recv() else { break };
        match event {
            HostEvent::Closed => open -= 1,
            HostEvent::StderrLine(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                for line in text.split('\n') {
                    let line = line.strip_suffix('\r').unwrap_or(line);
                    if !js::trim(line).is_empty() {
                        on_progress(js::trim(line));
                    }
                }
                stderr.push_str(&text);
            }
            HostEvent::Stdout(bytes) => {
                stdout.extend_from_slice(&bytes);
                if signalled {
                    continue;
                }
                let Some(at) = find(&stdout, JOINED_LINE.as_bytes()) else {
                    continue;
                };
                signalled = true;
                stdout.drain(at..at + JOINED_LINE.len());
                let word = match on_joined() {
                    Ok(None) => json!({ "go": true }),
                    Ok(Some(problem)) => json!({ "abort": problem }),
                    Err(e) => json!({ "abort": e.message() }),
                };
                if let Some(pipe) = stdin.as_mut() {
                    // the host may be gone: its exit code says so below
                    let _ = pipe.write_all(format!("{}\n", jsjson::stringify(&word)).as_bytes());
                    let _ = pipe.flush();
                }
            }
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child.wait();
    drop(stdin);
    if let Some(report) = parse_report(&String::from_utf8_lossy(&stdout)) {
        return Ok(report);
    }
    let code = match status {
        Ok(s) => s.code().map_or("null".to_string(), |c| c.to_string()),
        Err(_) => "null".to_string(),
    };
    let lines: Vec<&str> = js::trim(&stderr).split('\n').filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(10)..].join("\n");
    Err(Failure::user(format!(
        "the bot host exited with code {code} and no report{}\nIf this keeps happening, reinstall it: spawnloft bot setup --force",
        if tail.is_empty() {
            String::new()
        } else {
            format!(":\n{tail}")
        }
    )))
}

/// `parseReport(stdout)`: the last stdout line that is a report, searching from the end past
/// anything printed after it.
pub fn parse_report(stdout: &str) -> Option<Value> {
    for line in stdout.split('\n').rev() {
        let line = js::trim(line);
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(obj) = jsjson::parse(line)
            && matches!(obj.get("steps"), Some(Value::Array(_)))
        {
            return Some(obj);
        }
    }
    None
}

/// `report.x ?? []` for a list the report holds.
fn list_of<'a>(report: &'a Value, key: &str) -> &'a [Value] {
    match report.get(key) {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

/// `String(s.index + 1).padStart(2)`.
fn step_number(index: Option<&Value>) -> String {
    let n = match index {
        Some(Value::String(s)) => format!("{s}1"),
        other => js::number_to_string(js::number(other) + 1.0),
    };
    format!("{n:>2}")
}

/// `formatReport(report)`: one line per step, for a terminal.
pub fn format_report(report: &Value) -> String {
    let mut out = Vec::new();
    if js::truthy(report.get("error")) {
        out.push(format!("error: {}", js::string(report.get("error"))));
    }
    for s in list_of(report, "setup") {
        let mark = if s.get("ok") == Some(&Value::Bool(false)) {
            "FAIL "
        } else {
            "setup"
        };
        let reply = s.get("reply");
        let shown = if js::truthy(reply) {
            let text = js::string(reply);
            format!("  -> {}", text.split('\n').next().unwrap_or(""))
        } else {
            String::new()
        };
        out.push(format!("{mark}  {}{shown}", js::string(s.get("command"))));
    }
    let steps = list_of(report, "steps");
    for s in steps {
        let step = s.get("step");
        let bot = step.and_then(|v| v.get("bot"));
        let mut rest = Map::new();
        if let Some(Value::Object(m)) = step {
            let mut ordered = Value::Object(m.clone());
            jsjson::js_order(&mut ordered);
            if let Value::Object(m) = ordered {
                for (k, v) in m {
                    if k != "bot" && k != "timeout" {
                        rest.insert(k, v);
                    }
                }
            }
        }
        let what = format!(
            "{}{}",
            if js::truthy(bot) {
                format!("{} ", js::string(bot))
            } else {
                String::new()
            },
            jsjson::stringify(&Value::Object(rest))
        );
        let mark = match s.get("status").and_then(Value::as_str) {
            Some("passed") => "ok   ",
            Some("failed") => "FAIL ",
            _ => "skip ",
        };
        let took = match s.get("durationMs") {
            None | Some(Value::Null) => String::new(),
            d => format!("  ({} ms)", js::string(d)),
        };
        out.push(format!("{mark} {}. {what}{took}", step_number(s.get("index"))));
        if js::truthy(s.get("error")) {
            out.push(format!(
                "       {}",
                js::string(s.get("error"))
                    .split('\n')
                    .collect::<Vec<_>>()
                    .join("\n       ")
            ));
        }
    }
    let passed = steps
        .iter()
        .filter(|s| s.get("status").and_then(Value::as_str) == Some("passed"))
        .count();
    let duration = match report.get("durationMs") {
        None | Some(Value::Null) => "0".to_string(),
        d => js::string(d),
    };
    out.push(format!(
        "{}: {passed} of {} steps passed in {duration} ms",
        if js::truthy(report.get("ok")) {
            "PASSED"
        } else {
            "FAILED"
        },
        steps.len()
    ));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-bots-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn layout_at(root: &Path) -> Layout {
        let mut s = Map::new();
        s.insert("dataRoot".into(), json!(root.to_string_lossy()));
        Layout::resolve(&s).unwrap()
    }

    /// The registry of test/bots.test.mjs: an online and an offline server and a database.
    fn data_root(tag: &str) -> (PathBuf, Layout) {
        let root = scratch(tag);
        let online = root.join("instances").join("online");
        let offline = root.join("instances").join("offline");
        for d in [&online, &offline, &root.join("run")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let reg = json!({ "version": 1, "instances": {
            "online": { "dir": online.to_string_lossy(), "jar": "paper-1.21.4-100.jar", "memory": "1G", "port": 45621, "rcon": { "port": 45622, "password": "x" } },
            "offline": { "dir": offline.to_string_lossy(), "jar": "paper-1.21.4-100.jar", "memory": "1G", "port": 45623, "rcon": { "port": 45624, "password": "x" } },
            "db": { "kind": "database", "engine": "mariadb", "external": true, "port": 45625, "root": { "password": "x" } },
        } });
        std::fs::write(root.join("instances.json"), reg.to_string()).unwrap();
        std::fs::write(online.join("server.properties"), "online-mode=true\nserver-ip=\n").unwrap();
        std::fs::write(
            offline.join("server.properties"),
            "online-mode=false\nserver-ip=127.0.0.1\n",
        )
        .unwrap();
        let layout = layout_at(&root);
        (root, layout)
    }

    fn good() -> Value {
        json!({ "instance": "offline", "bots": ["alice", "bob"], "setup": ["op alice"], "steps": [
            { "bot": "alice", "command": "/tp bob" },
            { "bot": "bob", "expectMessage": "teleported", "timeout": 2000 },
            { "expectLog": { "absent": "Exception" } },
        ] })
    }

    /// `{ ...good, ...patch }`, a null in the patch leaving the key out.
    fn with(patch: Value) -> Value {
        let mut g = good();
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() {
                g.as_object_mut().unwrap().remove(k);
            } else {
                g[k] = v.clone();
            }
        }
        g
    }

    fn refusal(data: Value) -> String {
        match validate_scenario(&data, None) {
            Err(Failure::User { message, .. }) => message,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    fn step_refusal(steps: Value) -> String {
        refusal(with(json!({ "steps": steps })))
    }

    #[test]
    fn a_well_formed_scenario_keeps_its_parts() {
        let s = validate_scenario(&good(), Some("from-file")).unwrap();
        assert_eq!(s.name, json!("from-file"));
        assert_eq!(s.instance, json!("offline"));
        assert_eq!(s.bots, ["alice", "bob"]);
        assert_eq!(s.setup, ["op alice"]);
        assert_eq!(s.steps.len(), 3);
        let s = validate_scenario(&with(json!({ "setup": null, "instance": null })), None).unwrap();
        assert_eq!(
            (s.name, s.instance, s.setup.len()),
            (json!("scenario"), Value::Null, 0)
        );
    }

    #[test]
    fn validation_names_the_step_and_what_is_wrong_with_it() {
        let six: Vec<String> = (0..6).map(|i| format!("bot{i}")).collect();
        for (data, want) in [
            (
                with(json!({ "bots": [] })),
                "\"bots\" must list at least one bot name",
            ),
            (
                with(json!({ "bots": six })),
                "\"bots\" lists 6 bots; the limit is 5",
            ),
            (
                with(json!({ "bots": ["al"] })),
                "bot name \"al\" is not a Minecraft name (3 to 16 letters, digits or underscores)",
            ),
            (
                with(json!({ "bots": ["Alice", "alice"] })),
                "bot names must differ",
            ),
            (
                with(json!({ "setup": ["stop"] })),
                "setup command \"stop\" would take the server down or half-reload it; a scenario cannot run it",
            ),
            (
                with(json!({ "setup": ["/minecraft:reload confirm"] })),
                "setup command \"reload\" would take the server down or half-reload it; a scenario cannot run it",
            ),
            (
                with(json!({ "setup": ["op", 1] })),
                "\"setup\" must be a list of console commands",
            ),
            (
                with(json!({ "steps": [] })),
                "\"steps\" must list at least one step",
            ),
            (json!([]), "a scenario is a JSON object"),
        ] {
            assert_eq!(refusal(data), want);
        }
        let one_of = "chat, command, expectMessage, waitWindow, click, closeWindow, expectItem, expectState, expectLog, leave";
        for (steps, want) in [
            (
                json!([{ "bot": "alice" }]),
                format!("step 1 must have exactly one of {one_of}; it has none"),
            ),
            (
                json!([{ "bot": "alice", "chat": "hi", "command": "/x" }]),
                format!("step 1 must have exactly one of {one_of}; it has chat, command"),
            ),
            (
                json!([{ "bot": "carol", "chat": "hi" }]),
                "step 1 (chat) names bot \"carol\", which is not in \"bots\"".to_string(),
            ),
            (
                json!([{ "chat": "hi" }]),
                "step 1 (chat) names bot null, which is not in \"bots\"".to_string(),
            ),
            (
                json!([{ "bot": "alice", "chat": "hi", "timeout": 0 }]),
                "step 1: \"timeout\" is milliseconds, 1 to 300000".to_string(),
            ),
            (
                json!([{ "expectLog": { "present": "a", "absent": "b" } }]),
                "step 1: expectLog takes {\"present\": pattern} or {\"absent\": pattern}".to_string(),
            ),
            (
                json!([{ "expectLog": {} }]),
                "step 1: expectLog takes {\"present\": pattern} or {\"absent\": pattern}".to_string(),
            ),
            (
                json!([{ "bot": "alice", "click": "eleven" }]),
                "step 1: \"click\" is a slot number".to_string(),
            ),
            (json!([null]), "step 1 is not an object".to_string()),
        ] {
            assert_eq!(step_refusal(steps), want);
        }
    }

    #[test]
    fn a_bot_cannot_stop_or_reload_the_server() {
        let refused = |verb: &str| {
            format!("step 1: \"{verb}\" would take the server down or half-reload it; a bot cannot run it")
        };
        assert_eq!(
            step_refusal(json!([{ "bot": "alice", "command": "/stop" }])),
            refused("stop")
        );
        assert_eq!(
            step_refusal(json!([{ "bot": "alice", "command": "minecraft:reload confirm" }])),
            refused("reload")
        );
        assert_eq!(
            step_refusal(json!([{ "bot": "alice", "chat": "/rl" }])),
            refused("rl")
        );
        assert_eq!(
            step_refusal(json!([{ "bot": "alice", "chat": "" }])),
            "step 1: \"chat\" must be text"
        );
        let polite = with(json!({ "steps": [{ "bot": "alice", "chat": "please do not stop" }] }));
        assert!(validate_scenario(&polite, None).is_ok());
        assert_eq!(command_verb("  /Minecraft:Stop now"), "stop");
        assert_eq!(command_verb("/ stop"), "");
        assert_eq!(command_verb("a:b:c"), "b:c");
        assert_eq!(command_verb("plug\u{e9}:stop"), "plug\u{e9}:stop");
        assert!(is_refused("restart") && !is_refused("say"));
        assert_eq!(REFUSED_CONSOLE, ["stop", "restart", "reload", "rl"]);
    }

    #[test]
    fn patterns_and_shapes_are_checked_before_any_bot_joins() {
        let msg = step_refusal(json!([{ "bot": "alice", "expectMessage": "/(unclosed/" }]));
        assert!(
            msg.starts_with(
                "step 1: \"expectMessage\" is not a valid regular expression: Invalid regular expression: /(unclosed/: "
            ),
            "{msg}"
        );
        let not_valid = "step 1: \"expectMessage\" is not a valid regular expression";
        for (steps, want) in [
            (
                json!([{ "bot": "alice", "expectMessage": "/hello/g" }]),
                "step 1: \"expectMessage\" uses the g flag, which has no meaning for a match here; drop it".to_string(),
            ),
            (
                json!([{ "bot": "alice", "expectMessage": "/hello/iy" }]),
                "step 1: \"expectMessage\" uses the y flag, which has no meaning for a match here; drop it".to_string(),
            ),
            (
                json!([{ "bot": "alice", "expectMessage": "/hello/q" }]),
                format!("{not_valid}: Invalid flags supplied to RegExp constructor 'q'"),
            ),
            (
                json!([{ "bot": "alice", "expectMessage": "/hello/ii" }]),
                format!("{not_valid}: Invalid flags supplied to RegExp constructor 'ii'"),
            ),
            (
                json!([{ "bot": "alice", "expectMessage": "/hello/uv" }]),
                format!("{not_valid}: Invalid flags supplied to RegExp constructor 'uv'"),
            ),
            (
                json!([{ "bot": "alice", "expectMessage": 42 }]),
                "step 1: \"expectMessage\" must be text or /a regular expression/".to_string(),
            ),
            (
                json!([{ "bot": "alice", "waitWindow": "" }]),
                "step 1: \"waitWindow\" must be text or /a regular expression/".to_string(),
            ),
            (
                json!([{ "expectLog": { "present": null } }]),
                "step 1: \"present\" must be text or /a regular expression/".to_string(),
            ),
            (
                json!([{ "bot": "alice", "expectItem": { "count": 2 } }]),
                "step 1: expectItem is an item name such as \"minecraft:diamond\", or {\"name\": ..., \"count\": n}"
                    .to_string(),
            ),
            (
                json!([{ "bot": "alice", "expectState": "creative" }]),
                "step 1: expectState is an object of what to wait for (gameMode, minHealth, maxHealth, dimension, near, nearBot, seesPlayer)".to_string(),
            ),
            (
                json!([{ "bot": "alice", "chat": "hi", "timeuot": 100 }]),
                "step 1 has \"timeuot\", which is not a step key; the keys are chat, command, expectMessage, waitWindow, click, closeWindow, expectItem, expectState, expectLog, leave, bot, timeout, button".to_string(),
            ),
        ] {
            assert_eq!(step_refusal(steps), want);
        }
        assert!(
            step_refusal(json!([{ "expectLog": { "present": "/[/" } }])).starts_with(
                "step 1: \"present\" is not a valid regular expression: Invalid regular expression: /[/: "
            )
        );
        // with a Node to ask, V8 decides, in its own dialects (review of C9)
        if crate::runtime::node().is_ok() {
            for bad in [
                "/(?=a)(/",
                "/(a)\\1**/",
                "/(?<=x)*/",
                "/(?<a>x)\\k<b>/",
                "/a(/u",
                "/\\a/u",
            ] {
                assert!(
                    step_refusal(json!([{ "bot": "alice", "expectMessage": bad }]))
                        .contains("is not a valid regular expression: Invalid regular expression:"),
                    "{bad}"
                );
            }
            for good in ["/[\\u{1F600}-\\u{1F64F}]/u", "/[\\p{L}--\\p{N}]/v"] {
                assert!(
                    validate_scenario(
                        &with(json!({ "steps": [{ "bot": "alice", "expectMessage": good }] })),
                        None
                    )
                    .is_ok(),
                    "{good}"
                );
            }
        }
        // lookaround and backreferences pass the check: the host matches in JavaScript
        for pattern in ["/a(?=b)/", "/(?<!x)y/", "/(a)\\1/"] {
            assert!(
                validate_scenario(
                    &with(json!({ "steps": [{ "bot": "alice", "expectMessage": pattern }] })),
                    None
                )
                .is_ok(),
                "{pattern}"
            );
        }
        let ok = with(json!({ "steps": [
            { "bot": "alice", "expectMessage": "/hello/i" },
            { "bot": "alice", "expectMessage": "/a/b/dimsu" },
            { "bot": "alice", "expectMessage": "/plain" },
            { "bot": "alice", "expectItem": "minecraft:diamond" },
            { "bot": "alice", "expectItem": { "name": "diamond", "count": 2 } },
        ] }));
        assert!(validate_scenario(&ok, None).is_ok());
        assert_eq!(split_pattern("/a/b/i"), Some(("a/b", "i")));
        assert_eq!(split_pattern("//i"), None);
        assert_eq!(split_pattern("/a/B"), None);
    }

    #[test]
    fn a_scenario_file_that_cannot_be_read_is_refused_first() {
        let root = scratch("load");
        let broken = root.join("broken.json");
        std::fs::write(&broken, "{ not json").unwrap();
        let f = broken.to_string_lossy().into_owned();
        let msg = load_scenario(&f).unwrap_err().message().to_string();
        assert!(msg.starts_with(&format!("{f} is not valid JSON: ")), "{msg}");
        let missing = root.join("missing.json").to_string_lossy().into_owned();
        assert_eq!(
            load_scenario(&missing).unwrap_err().message(),
            format!("cannot read scenario {missing}: ENOENT: no such file or directory, open '{missing}'")
        );
        let named = root.join("smoke.json");
        std::fs::write(&named, good().to_string()).unwrap();
        assert_eq!(
            load_scenario(&named.to_string_lossy()).unwrap().name,
            json!("smoke")
        );
        assert_eq!(basename_json("a/b.json.json"), "b.json");
        assert_eq!(basename_json("a/.json"), ".json");
        assert_eq!(basename_json(".json"), "");
        assert_eq!(basename_json("x.JSON"), "x.JSON");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn servers_bots_may_not_join_and_where_they_connect() {
        let (root, layout) = data_root("check");
        let res = check_instance(&layout, "online").unwrap();
        assert!(!res.ok);
        let props = jspath::join(&[
            &root.join("instances").join("online").to_string_lossy(),
            "server.properties",
        ]);
        assert_eq!(
            res.problems,
            [
                format!(
                    "\"online\" runs in online mode, and bots have no account to log in with. Set online-mode=false in {props} on a server kept for testing, then restart it."
                ),
                "\"online\" is not running. Start it first: spawnloft start online".to_string(),
            ]
        );
        assert_eq!(
            res.warnings,
            [
                "\"online\" listens on every interface in offline mode, so anyone who can reach port 45621 can join under any name. For a test server, set server-ip=127.0.0.1."
            ]
        );
        assert_eq!(res.version.as_deref(), Some("1.21.4"));
        assert_eq!(res.host, "127.0.0.1");

        let res = check_instance(&layout, "offline").unwrap();
        assert_eq!(
            res.problems,
            ["\"offline\" is not running. Start it first: spawnloft start offline"]
        );
        assert!(res.warnings.is_empty());
        assert_eq!(res.host, "127.0.0.1");

        assert_eq!(
            check_instance(&layout, "db").unwrap_err().message(),
            "\"db\" is a database, not a Minecraft server"
        );

        let lan = root.join("instances").join("lan");
        std::fs::create_dir_all(&lan).unwrap();
        std::fs::write(
            lan.join("server.properties"),
            "online-mode=false\nserver-ip=192.168.1.5\n",
        )
        .unwrap();
        let text = std::fs::read_to_string(root.join("instances.json")).unwrap();
        let mut reg: Value = serde_json::from_str(&text).unwrap();
        reg["instances"]["lan"] = json!({ "dir": lan.to_string_lossy(), "jar": "paper-1.21.4-100.jar", "memory": "1G", "port": 45627 });
        std::fs::write(root.join("instances.json"), reg.to_string()).unwrap();
        let res = check_instance(&layout, "lan").unwrap();
        assert_eq!(res.host, "192.168.1.5");
        assert!(
            res.warnings[0].contains("listens on 192.168.1.5"),
            "{:?}",
            res.warnings
        );

        // no install means no host; a run checks the server first, then the install
        assert_eq!(host_install(&layout), None);
        let scenario = validate_scenario(&good(), None).unwrap();
        let err = run_scenario(&layout, &scenario, Some("online"), &|_| {}).unwrap_err();
        let problems = check_instance(&layout, "online").unwrap().problems.join("\n");
        assert_eq!(err.message(), problems);
        let no_name = validate_scenario(&with(json!({ "instance": null })), None).unwrap();
        assert_eq!(
            run_scenario(&layout, &no_name, None, &|_| {})
                .unwrap_err()
                .message(),
            "no server named: put \"instance\" in the scenario or pass --instance <name>"
        );
        assert!(run_scenario(&layout, &scenario, Some(""), &|_| {}).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn setup_installs_a_pinned_tree_and_trusts_only_a_finished_install() {
        let pkg = jsjson::parse(PINNED_FILES[0].1).unwrap();
        let lock = jsjson::parse(PINNED_FILES[1].1).unwrap();
        let version = mineflayer_version();
        assert!(
            regex::Regex::new(r"^\d+\.\d+\.\d+$").unwrap().is_match(&version),
            "{version}"
        );
        let deps = pkg["dependencies"].as_object().unwrap();
        assert_eq!(deps.keys().collect::<Vec<_>>(), ["mineflayer"]);
        assert_eq!(lock["packages"][""]["dependencies"], pkg["dependencies"]);
        assert_eq!(
            lock["packages"]["node_modules/mineflayer"]["version"],
            json!(version)
        );
        let installed: Vec<(&String, &Value)> = lock["packages"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, _)| !k.is_empty())
            .collect();
        assert!(installed.len() > 10);
        for (name, entry) in installed {
            assert!(
                js::string(entry.get("resolved")).starts_with("https://registry.npmjs.org/"),
                "{name}"
            );
            assert!(
                js::string(entry.get("integrity")).starts_with("sha512-"),
                "{name}"
            );
            assert_ne!(entry.get("hasInstallScript"), Some(&json!(true)), "{name}");
        }
        // the stamp: both files, CRLF evened out, joined by NUL (bots.mjs pinnedStamp)
        let stamp = pinned_stamp();
        assert_eq!(stamp.matches('\0').count(), 1);
        assert!(!stamp.contains("\r\n"));
        assert!(stamp.starts_with(&PINNED_FILES[0].1.replace("\r\n", "\n")));

        let root = scratch("pinned");
        let layout = layout_at(&root);
        assert!(!host_is_pinned(&layout));
        let host = PathBuf::from(host_dir(&layout));
        let module = host.join("node_modules").join("mineflayer");
        std::fs::create_dir_all(&module).unwrap();
        for (name, text) in PINNED_FILES {
            std::fs::write(host.join(name), text).unwrap();
        }
        std::fs::write(
            module.join("package.json"),
            json!({ "version": version }).to_string(),
        )
        .unwrap();
        // the pinned files without npm having finished (setup cut short) are not an install to trust
        assert!(!host_is_pinned(&layout));
        let want = HostInstall {
            dir: host_dir(&layout),
            version: version.clone(),
        };
        assert_eq!(host_install(&layout), Some(want));
        std::fs::write(host.join(PINNED_MARKER), stamp.replace('\n', "\r\n")).unwrap();
        assert!(!host_is_pinned(&layout));
        std::fs::write(host.join(PINNED_MARKER), &stamp).unwrap();
        assert!(host_is_pinned(&layout));
        // installed and pinned: setup has nothing to do and runs no npm
        let said = RefCell::new(Vec::new());
        let have = ensure_host(&layout, false, &|m| said.borrow_mut().push(m.to_string())).unwrap();
        assert_eq!(have.version, version);
        assert!(said.borrow().is_empty());
        std::fs::write(module.join("package.json"), "{ half").unwrap();
        assert_eq!(host_install(&layout), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_report_reads_one_line_per_step() {
        let report = json!({ "ok": false, "durationMs": 42, "setup": [
            { "command": "op alice", "reply": "Made alice a server operator\nsecond line", "ok": true },
            { "command": "gamemode survival nobody", "reply": "No player was found", "ok": false },
            { "command": "say quiet", "reply": "", "ok": true },
        ], "steps": [
            { "index": 0, "step": { "bot": "alice", "command": "/tp bob" }, "status": "passed", "durationMs": 1 },
            { "index": 1, "step": { "bot": "bob", "expectMessage": "teleported", "timeout": 2000 }, "status": "failed", "durationMs": 2000, "error": "timed out\n  seen: x" },
            { "index": 2, "step": { "expectLog": { "absent": "Exception" } }, "status": "skipped" },
            { "index": 9, "step": { "bot": "", "leave": true }, "status": "skipped", "durationMs": null },
        ] });
        assert_eq!(
            format_report(&report),
            [
                "setup  op alice  -> Made alice a server operator",
                "FAIL   gamemode survival nobody  -> No player was found",
                "setup  say quiet",
                "ok     1. alice {\"command\":\"/tp bob\"}  (1 ms)",
                "FAIL   2. bob {\"expectMessage\":\"teleported\"}  (2000 ms)",
                "       timed out",
                "         seen: x",
                "skip   3. {\"expectLog\":{\"absent\":\"Exception\"}}",
                "skip  10. {\"leave\":true}",
                "FAILED: 1 of 4 steps passed in 42 ms",
            ]
            .join("\n")
        );
        assert_eq!(
            format_report(&json!({ "ok": true, "error": "the host died", "steps": [] })),
            "error: the host died\nPASSED: 0 of 0 steps passed in 0 ms"
        );
    }

    #[test]
    fn the_report_is_the_last_line_that_is_one() {
        let out =
            "{\"event\":\"joined\"}\nnoise\n{\"ok\":true,\"steps\":[1]}\n{\"ok\":false}\nlate warning\n";
        assert_eq!(parse_report(out), Some(json!({ "ok": true, "steps": [1] })));
        assert_eq!(parse_report("  {\"steps\":[]}  \r"), Some(json!({ "steps": [] })));
        assert_eq!(parse_report("{\"steps\":{}}\n{broken"), None);
        assert_eq!(parse_report(""), None);
    }

    // ---- the core/host handshake, with the stand-in host of the Node tests

    fn stub() -> Option<(PathBuf, PathBuf)> {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/bot-host-stub.cjs");
        Some((crate::panel::path_node()?, script))
    }

    struct Job {
        file: PathBuf,
        word: PathBuf,
    }

    fn stub_job(root: &Path, mode: &str) -> Job {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let file = root.join(format!("job-{n}.json"));
        let word = root.join(format!("job-{n}.json.word"));
        let job = json!({ "name": mode, "mode": mode, "wordFile": word.to_string_lossy() });
        std::fs::write(&file, job.to_string()).unwrap();
        Job { file, word }
    }

    fn word(job: &Job) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&job.word).unwrap()).unwrap()
    }

    #[test]
    fn the_host_hears_go_or_abort_once_setup_has_run() {
        let Some((node, script)) = stub() else {
            eprintln!("no node on PATH: skipped");
            return;
        };
        let root = scratch("host");
        let quiet = |_: &str| {};

        let job = stub_job(&root, "plain");
        let mut ran = 0;
        let report = run_host(&node, &script, &job.file, &quiet, &mut || {
            ran += 1;
            Ok(None)
        })
        .unwrap();
        assert_eq!(report["ok"], json!(true));
        assert_eq!(ran, 1);
        assert_eq!(word(&job), json!({ "go": true }));

        // a failed setup aborts the host, which reports the reason
        let job = stub_job(&root, "plain");
        let problem = "setup command \"op nobody\" failed";
        let report = run_host(&node, &script, &job.file, &quiet, &mut || {
            Ok(Some(problem.to_string()))
        })
        .unwrap();
        assert_eq!(report["ok"], json!(false));
        assert_eq!(report["error"], json!(problem));
        assert_eq!(word(&job), json!({ "abort": problem }));

        // setup that fails outright aborts the host too, rather than leaving it waiting
        let job = stub_job(&root, "plain");
        let report = run_host(&node, &script, &job.file, &quiet, &mut || {
            Err(Failure::user("RCON refused the connection"))
        })
        .unwrap();
        assert_eq!(report["ok"], json!(false));
        assert!(js::string(report.get("error")).contains("RCON refused"));

        // "joined" split across two reads is acted on once
        let job = stub_job(&root, "split");
        let mut ran = 0;
        let report = run_host(&node, &script, &job.file, &quiet, &mut || {
            ran += 1;
            Ok(None)
        })
        .unwrap();
        assert_eq!((report["ok"].clone(), ran), (json!(true), 1));

        // a line printed after the report does not hide it
        let job = stub_job(&root, "stray");
        let report = run_host(&node, &script, &job.file, &quiet, &mut || Ok(None)).unwrap();
        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["steps"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_host_that_dies_mid_setup_is_an_error_naming_its_exit() {
        let Some((node, script)) = stub() else {
            eprintln!("no node on PATH: skipped");
            return;
        };
        let root = scratch("dies");
        let job = stub_job(&root, "dies-after-joined");
        let seen = RefCell::new(Vec::new());
        // setup takes long enough for the host to be gone by the time the core answers it
        let progress = |m: &str| seen.borrow_mut().push(m.to_string());
        let err = run_host(&node, &script, &job.file, &progress, &mut || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            Ok(None)
        })
        .unwrap_err();
        assert!(matches!(err, Failure::User { .. }));
        assert_eq!(
            err.message(),
            "the bot host exited with code 3 and no report:\nmineflayer blew up\nIf this keeps happening, reinstall it: spawnloft bot setup --force"
        );
        assert_eq!(*seen.borrow(), ["mineflayer blew up"]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
