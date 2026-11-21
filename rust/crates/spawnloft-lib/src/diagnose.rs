//! Known failure shapes in a server's console (`diagnose.mjs`), so a crash message, `why` and
//! the panel can name the likely cause; and the crash reports Minecraft writes
//! (`crashReports`). The shapes, titles and advice are diagnose.mjs's, word for word; the
//! patterns are its patterns in this crate's syntax with JavaScript's meanings kept (`\d`, `\w`
//! and `\b` are ASCII there, `.` stops at any line terminator, `\s` is JavaScript's set).

use regex::{Captures, Regex};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

use crate::failure::Failure;
use crate::{js, jspath, text, time};

/// What the advice can mention about the server. `panel` is the page, where the fix is a place
/// to click; everything else (the terminal, the daemon's console line, a webhook) gets the
/// command.
#[derive(Debug, Default, Clone)]
pub struct Context {
    pub port: Option<String>,
    pub memory: Option<String>,
    pub dir: Option<String>,
    pub crash_dir: Option<String>,
    pub panel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub id: &'static str,
    pub title: &'static str,
    pub advice: String,
    pub line: String,
    pub at: usize,
}

impl Finding {
    /// The finding as `diagnose()` returns it, for `--json`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "title": self.title, "advice": self.advice, "line": self.line, "at": self.at })
    }
}

type Advice = fn(&Captures, &Context) -> String;

struct Shape {
    id: &'static str,
    test: Regex,
    title: &'static str,
    advice: Advice,
}

/// JavaScript's `.` (no line terminator) and `\s`.
pub const JS_DOT: &str = r"[^\n\r\x{2028}\x{2029}]";
pub const JS_SPACE: &str =
    r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
const JS_WORD: &str = "0-9A-Za-z_";

fn shape(id: &'static str, pattern: &str, title: &'static str, advice: Advice) -> Shape {
    let pattern = pattern
        .replace("{dot}", JS_DOT)
        .replace("{s}", JS_SPACE)
        .replace("{w}", JS_WORD);
    Shape {
        id,
        test: Regex::new(&pattern).expect("diagnose pattern"),
        title,
        advice,
    }
}

fn class_version_to_java(major: f64) -> String {
    js::number_to_string(major - 44.0)
}

static NOT_A_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(unknown|missing|null)$").expect("name filter"));

// ordered from more specific and actionable to less, as in diagnose.mjs
static SHAPES: LazyLock<Vec<Shape>> = LazyLock::new(|| {
    vec![
        shape(
            "port-in-use",
            r"(?i)FAILED TO BIND TO PORT|Address already in use|Failed to bind to address",
            "The port is already taken",
            |_, c| {
                format!(
                    "Something else is listening on port {} - usually another server, or another copy of this one. {}",
                    c.port.as_deref().unwrap_or("this server\u{2019}s port"),
                    if c.panel {
                        "Stop the other one, or give this server a port of its own: the menu beside Stop, then \"Rename, memory and port\"."
                    } else {
                        "\"spawnloft list\" shows who; change the port under Manage if both should run at once."
                    }
                )
            },
        ),
        shape(
            "eula",
            r"(?i)You need to agree to the EULA",
            "The EULA is not accepted",
            |_, c| {
                let start = if c.panel {
                    "Open eula.txt in Files, change eula=false to eula=true ".to_string()
                } else {
                    let file = match c.dir.as_deref().filter(|d| !d.is_empty()) {
                        Some(d) => jspath::join(&[d, "eula.txt"]),
                        None => "eula.txt".to_string(),
                    };
                    format!("Set eula=true in {file} ")
                };
                format!("{start}(see https://aka.ms/MinecraftEULA) and start again.")
            },
        ),
        shape(
            "wrong-java",
            r"(?i)UnsupportedClassVersionError{dot}*class file version ([0-9]+)",
            "Java is too old for this server",
            |m, c| {
                let needs = class_version_to_java(js::string_to_number(&m[1]));
                format!(
                    "This server is built for Java {needs} or newer, and the Java that launched it is older. Install Java {needs}+ and, if several are installed, {}",
                    if c.panel {
                        "choose it for this server under Settings, Java and memory."
                    } else {
                        "point this server at it with \"spawnloft set <name> java=<path-to-java.exe>\"."
                    }
                )
            },
        ),
        shape(
            "out-of-memory",
            r"java\.lang\.OutOfMemoryError",
            "The server ran out of memory",
            |_, c| {
                format!(
                    "It has {} and wants more. Raise it under {} (modded servers usually want 4G or more), and make sure the machine has that to give.",
                    c.memory.as_deref().unwrap_or("its configured memory"),
                    if c.panel {
                        "Settings, Java and memory"
                    } else {
                        "Manage"
                    }
                )
            },
        ),
        shape(
            "out-of-disk",
            r"(?i)No space left on device|There is not enough space on the disk",
            "The disk is full",
            |_, c| {
                format!(
                    "The drive this server lives on has no room left - saves and logs are failing. {}",
                    if c.panel {
                        "Free space on that drive. Old backups are the usual place to find some: delete the ones you no longer need in Backups."
                    } else {
                        "Free space, or move the server with \"spawnloft config set-instances\" onto a drive that has some. \"spawnloft prune\" can thin old snapshots."
                    }
                )
            },
        ),
        shape(
            "missing-plugin-dependency",
            r"UnknownDependencyException(?-u:\b):?{s}*(?:Unknown(?:/missing)?[/ ]dependenc[{w}]+(?:{s}+plugins?)?:?{s}*)?(?:\[([^\]]+)\]|([{w}-]+(?:\.[{w}-]+)*))?",
            "A plugin is missing a dependency",
            |m, _| {
                let names: Vec<String> = match (m.get(1), m.get(2)) {
                    (Some(list), _) => list.as_str().split(',').map(String::from).collect(),
                    (None, Some(one)) => vec![one.as_str().to_string()],
                    _ => Vec::new(),
                };
                let names: Vec<String> = names
                    .iter()
                    .map(|n| js::trim(n).to_string())
                    .filter(|n| !n.is_empty() && !NOT_A_NAME.is_match(n))
                    .collect();
                if names.is_empty() {
                    return "A plugin depends on another plugin that is not installed - the lines above name it. Install the missing one from the Plugins tab, or disable the one that wants it.".to_string();
                }
                let quoted = names
                    .iter()
                    .map(|n| format!("\"{n}\""))
                    .collect::<Vec<_>>()
                    .join(" and ");
                let one = names.len() == 1;
                format!(
                    "A plugin needs {quoted}, which {} not installed. Install {} from the Plugins tab, or disable the plugin that wants {}.",
                    if one { "is" } else { "are" },
                    if one { "it" } else { "them" },
                    if one { "it" } else { "them" }
                )
            },
        ),
        shape(
            "missing-mod-dependency",
            r"(?i)requires (?:any version|version [^ ]+) of ([{w}-]+), which is missing",
            "A mod is missing a dependency",
            |m, _| {
                format!(
                    "A mod needs \"{}\", which is not installed. Install it from the Mods tab - for most mods that means Fabric API first.",
                    &m[1]
                )
            },
        ),
        shape(
            "duplicate-plugin",
            r"(?i)Ambiguous plugin name",
            "Two plugins claim the same name",
            |_, _| {
                "Two jars in the plugins folder provide the same plugin - usually an old copy beside a new one, or WorldEdit installed beside FAWE, which already provides it. Disable one of them in the Plugins tab.".to_string()
            },
        ),
        shape(
            "corrupt-world",
            r"(?i)Exception reading {dot}*level\.dat|Failed to load level|ChunkIoErrorReport|Corrupted chunk",
            "The world failed to load",
            |_, c| {
                format!(
                    "Part of the world data would not read back - usually a hard power-off mid-save. {}",
                    if c.panel {
                        "Restore the latest backup from Backups."
                    } else {
                        "Restore the latest snapshot from the Backups tab; \"spawnloft verify\" proves which ones are whole."
                    }
                )
            },
        ),
        shape(
            "ticking-crash",
            r"(?i)Exception ticking world|Ticking (entity|block entity)",
            "Something in the world crashed the server",
            |_, c| {
                let where_ = match c.crash_dir.as_deref().filter(|d| !d.is_empty()) {
                    Some(d) => format!(" - see {d}"),
                    None => " - see crash-reports in the server folder".to_string(),
                };
                format!(
                    "An entity or block crashed the server mid-tick. The crash report names the exact thing and where it stands{where_}. If it repeats, that report is what the responsible plugin or mod\u{2019}s author needs."
                )
            },
        ),
        shape(
            "watchdog",
            r"(?i)A single server tick took [0-9]+|Considering it to be crashed, server will forcibly shut down",
            "The server stalled and the watchdog stopped it",
            |_, _| {
                "A tick took so long the server declared itself stuck - heavy world generation, a plugin doing too much at once, or the machine out of breath. The thread dump above the shutdown names what it was doing; more memory or fewer chunks loaded usually helps.".to_string()
            },
        ),
        shape(
            "missing-jar",
            r"(?i)Unable to access jarfile ({dot}+)",
            "The server jar is missing",
            |m, c| {
                let what = match m.get(1) {
                    Some(j) => format!("\"{}\"", js::trim(j.as_str())),
                    None => "the server jar".to_string(),
                };
                format!(
                    "Java could not find {what}. {}",
                    if c.panel {
                        "Download it again under Settings, Server software, or restore the folder from a backup."
                    } else {
                        "Re-download it (\"spawnloft upgrade\" for Paper, or re-choose a jar with \"spawnloft set <name> jar=...\"), or restore the folder from a snapshot."
                    }
                )
            },
        ),
    ]
});

/// Scans from the end so the newest evidence wins; each shape reports once, at most three
/// findings, returned in log order so cause reads before consequence.
pub fn diagnose<S: AsRef<str>>(lines: &[S], ctx: &Context) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate().rev() {
        if findings.len() >= 3 {
            break;
        }
        let line = line.as_ref();
        for shape in SHAPES.iter() {
            if seen.contains(&shape.id) {
                continue;
            }
            let Some(m) = shape.test.captures(line) else {
                continue;
            };
            seen.push(shape.id);
            findings.push(Finding {
                id: shape.id,
                title: shape.title,
                advice: (shape.advice)(&m, ctx),
                line: line.to_string(),
                at: i,
            });
        }
    }
    findings.sort_by_key(|f| f.at);
    findings
}

/// One of Minecraft's own crash reports.
#[derive(Debug, Clone, PartialEq)]
pub struct CrashReport {
    pub file: String,
    pub mtime_ms: f64,
    pub size: u64,
    pub description: Option<String>,
}

impl CrashReport {
    pub fn to_json(&self) -> Value {
        json!({
            "file": self.file,
            "mtime": time::iso(self.mtime_ms as i64),
            "size": self.size,
            "sizeHuman": text::human_bytes(Some(self.size as f64)),
            "description": self.description,
        })
    }
}

static DESCRIPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[\n\r\x{{2028}}\x{{2029}}])Description:{JS_SPACE}*({JS_DOT}+)"
    ))
    .expect("description")
});

fn modified_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `crashReports(inst, { limit })`: `<dir>/crash-reports/*.txt`, newest first, each with the
/// Description line from its first 2 KB.
pub fn crash_reports(inst_dir: &str, limit: usize) -> Result<(String, Vec<CrashReport>), Failure> {
    use std::io::Read;
    let dir = jspath::join(&[inst_dir, "crash-reports"]);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok((dir, Vec::new()));
    };
    let mut reports = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if !file.ends_with(".txt") {
            continue;
        }
        let full = Path::new(&dir).join(&file);
        let meta = std::fs::metadata(&full).map_err(|e| Failure::io(&e, "stat", Some(&full)))?;
        let description = std::fs::File::open(&full).ok().and_then(|mut f| {
            let mut buf = vec![0u8; 2048];
            let mut n = 0;
            while n < buf.len() {
                match f.read(&mut buf[n..]) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => n += k,
                }
            }
            let head = String::from_utf8_lossy(&buf[..n]).into_owned();
            DESCRIPTION.captures(&head).map(|m| js::trim(&m[1]).to_string())
        });
        reports.push(CrashReport {
            file,
            mtime_ms: modified_ms(&meta),
            size: meta.len(),
            description,
        });
    }
    reports.sort_by(|a, b| {
        b.mtime_ms
            .partial_cmp(&a.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    reports.truncate(limit);
    Ok((dir, reports))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(&file).expect("fixture")).expect("fixture JSON")
    }

    fn context(v: &Value) -> Context {
        let text = |k: &str| v.get(k).map(|x| js::string(Some(x)));
        Context {
            port: text("port"),
            memory: text("memory"),
            dir: text("dir"),
            crash_dir: text("crashDir"),
            panel: js::truthy(v.get("panel")),
        }
    }

    #[test]
    fn agrees_with_node_on_every_case_of_the_fixture() {
        let fx = fixture("diagnose.json");
        let cases = fx["cases"].as_array().expect("cases");
        assert!(cases.len() > 100);
        for case in cases {
            let ctx = context(&fx["contexts"][case["ctx"].as_str().unwrap()]);
            let lines: Vec<&str> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap())
                .collect();
            let got: Vec<Value> = diagnose(&lines, &ctx).iter().map(Finding::to_json).collect();
            // the EULA advice joins the folder with path.join, so Windows has backslashes
            let want = crate::jsjson::stringify(&case["findings"]).replace(
                "/srv/smp/eula.txt",
                &jspath::join(&["/srv/smp", "eula.txt"]).replace('\\', "\\\\"),
            );
            assert_eq!(
                crate::jsjson::stringify(&Value::Array(got)),
                want,
                "{lines:?} in {}",
                case["ctx"]
            );
        }
    }

    #[test]
    fn names_the_ticking_crash() {
        let lines = [
            "[00:00:00 INFO]: Starting",
            "[00:00:00 INFO]: Exception ticking world",
            "",
        ];
        let found = diagnose(&lines, &Context::default());
        assert_eq!(found[0].id, "ticking-crash");
        assert_eq!(found[0].title, "Something in the world crashed the server");
    }

    #[test]
    fn wrong_java_names_the_release() {
        let lines = [
            "java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version (class file version 65.0)",
        ];
        let found = diagnose(&lines, &Context::default());
        assert!(
            found[0].advice.contains("Java 21 or newer"),
            "{}",
            found[0].advice
        );
    }

    #[test]
    fn plugin_dependencies_in_both_wordings() {
        let found = diagnose(
            &[
                "org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [ProtocolLib, Vault]. Please download",
            ],
            &Context::default(),
        );
        assert_eq!(
            found[0].advice,
            "A plugin needs \"ProtocolLib\" and \"Vault\", which are not installed. Install them from the Plugins tab, or disable the plugin that wants them."
        );
        let found = diagnose(
            &["UnknownDependencyException: Unknown dependency Vault."],
            &Context::default(),
        );
        assert!(
            found[0].advice.starts_with("A plugin needs \"Vault\", which is"),
            "{}",
            found[0].advice
        );
        let found = diagnose(
            &["UnknownDependencyException: Unknown dependency"],
            &Context::default(),
        );
        assert!(
            found[0].advice.starts_with("A plugin depends on another"),
            "{}",
            found[0].advice
        );
    }

    #[test]
    fn javascript_dot_stops_at_a_carriage_return() {
        // `.` in JavaScript does not cross \r, so the class file version on the far side is not read
        assert!(
            diagnose(
                &["UnsupportedClassVersionError\rclass file version 65"],
                &Context::default()
            )
            .is_empty()
        );
    }

    #[test]
    fn at_most_three_in_log_order() {
        let lines = [
            "java.lang.OutOfMemoryError",
            "No space left on device",
            "Ambiguous plugin name",
            "Corrupted chunk",
        ];
        let found = diagnose(
            &lines,
            &Context {
                memory: Some("2G".into()),
                ..Default::default()
            },
        );
        let ids: Vec<_> = found.iter().map(|f| f.id).collect();
        assert_eq!(ids, ["out-of-disk", "duplicate-plugin", "corrupt-world"]);
    }
}
