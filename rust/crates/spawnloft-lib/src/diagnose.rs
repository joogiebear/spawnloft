//! Known failure shapes in a server's console (`diagnose.mjs`), so a crash message can name the
//! likely cause. Pure over lines.

use regex::{Captures, Regex};
use std::sync::LazyLock;

/// What the advice can mention about the server.
#[derive(Debug, Default, Clone)]
pub struct Context {
    pub port: Option<String>,
    pub memory: Option<String>,
    pub dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub id: &'static str,
    pub title: &'static str,
    pub advice: String,
    pub line: String,
    pub at: usize,
}

type Advice = fn(&Captures, &Context) -> String;

struct Shape {
    id: &'static str,
    test: Regex,
    title: &'static str,
    advice: Advice,
}

fn shape(id: &'static str, pattern: &str, title: &'static str, advice: Advice) -> Shape {
    Shape {
        id,
        test: Regex::new(pattern).expect("diagnose pattern"),
        title,
        advice,
    }
}

// the class-file major version to the Java release
fn class_version_to_java(major: i64) -> i64 {
    major - 44
}

// ordered from more specific and actionable to less, as in diagnose.mjs
static SHAPES: LazyLock<Vec<Shape>> = LazyLock::new(|| {
    vec![
        shape(
            "port-in-use",
            r"(?i)FAILED TO BIND TO PORT|Address already in use|Failed to bind to address",
            "The port is already taken",
            |_, c| {
                format!(
                    "Something else is listening on port {} - usually another server, or another copy of this one. \"spawnloft list\" shows who; change the port under Manage if both should run at once.",
                    c.port.as_deref().unwrap_or("this server\u{2019}s port")
                )
            },
        ),
        shape(
            "eula",
            r"(?i)You need to agree to the EULA",
            "The EULA is not accepted",
            |_, c| {
                let file = match &c.dir {
                    Some(d) => format!("{d}\\eula.txt"),
                    None => "eula.txt".to_string(),
                };
                format!("Set eula=true in {file} (see https://aka.ms/MinecraftEULA) and start again.")
            },
        ),
        shape(
            "wrong-java",
            r"(?i)UnsupportedClassVersionError.*class file version (\d+)",
            "Java is too old for this server",
            |m, _| {
                let needs = class_version_to_java(m[1].parse().unwrap_or(0));
                format!(
                    "This server is built for Java {needs} or newer, and the Java that launched it is older. Install Java {needs}+ and, if several are installed, point this server at it with \"spawnloft set <name> java=<path-to-java.exe>\"."
                )
            },
        ),
        shape(
            "out-of-memory",
            r"java\.lang\.OutOfMemoryError",
            "The server ran out of memory",
            |_, c| {
                format!(
                    "It has {} and wants more. Raise it under Manage (modded servers usually want 4G or more), and make sure the machine has that to give.",
                    c.memory.as_deref().unwrap_or("its configured memory")
                )
            },
        ),
        shape(
            "out-of-disk",
            r"(?i)No space left on device|There is not enough space on the disk",
            "The disk is full",
            |_, _| {
                "The drive this server lives on has no room left - saves and logs are failing. Free space, or move the server with \"spawnloft config set-instances\" onto a drive that has some. \"spawnloft prune\" can thin old snapshots.".to_string()
            },
        ),
        shape(
            "missing-plugin-dependency",
            r"UnknownDependencyException:?\s*(?:Unknown[/ ]dependenc\w+)?:?\s*([\w-]+)?",
            "A plugin is missing a dependency",
            |m, _| {
                match m.get(1) {
                Some(dep) => format!(
                    "A plugin needs \"{}\", which is not installed. Install it from the Plugins tab, or disable the plugin that wants it.",
                    dep.as_str()
                ),
                None => "A plugin depends on another plugin that is not installed - the lines above name it. Install the missing one from the Plugins tab, or disable the one that wants it.".to_string(),
            }
            },
        ),
        shape(
            "missing-mod-dependency",
            r"(?i)requires (?:any version|version [^ ]+) of ([\w-]+), which is missing",
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
            r"(?i)Exception reading .*level\.dat|Failed to load level|ChunkIoErrorReport|Corrupted chunk",
            "The world failed to load",
            |_, _| {
                "Part of the world data would not read back - usually a hard power-off mid-save. Restore the latest snapshot from the Backups tab; \"spawnloft verify\" proves which ones are whole.".to_string()
            },
        ),
        shape(
            "ticking-crash",
            r"(?i)Exception ticking world|Ticking (entity|block entity)",
            "Something in the world crashed the server",
            |_, _| {
                "An entity or block crashed the server mid-tick. The crash report names the exact thing and where it stands - see crash-reports in the server folder. If it repeats, that report is what the responsible plugin or mod\u{2019}s author needs.".to_string()
            },
        ),
        shape(
            "watchdog",
            r"(?i)A single server tick took \d+|Considering it to be crashed, server will forcibly shut down",
            "The server stalled and the watchdog stopped it",
            |_, _| {
                "A tick took so long the server declared itself stuck - heavy world generation, a plugin doing too much at once, or the machine out of breath. The thread dump above the shutdown names what it was doing; more memory or fewer chunks loaded usually helps.".to_string()
            },
        ),
        shape(
            "missing-jar",
            r"(?i)Unable to access jarfile (.+)",
            "The server jar is missing",
            |m, _| {
                let what = match m.get(1) {
                    Some(j) => format!("\"{}\"", j.as_str().trim()),
                    None => "the server jar".to_string(),
                };
                format!(
                    "Java could not find {what}. Re-download it (\"spawnloft upgrade\" for Paper, or re-choose a jar with \"spawnloft set <name> jar=...\"), or restore the folder from a snapshot."
                )
            },
        ),
    ]
});

/// Scans from the end so the newest evidence wins; each shape reports once, at most three
/// findings, returned in log order so cause reads before consequence.
pub fn diagnose(lines: &[&str], ctx: &Context) -> Vec<Finding> {
    let mut findings: Vec<Finding> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate().rev() {
        if findings.len() >= 3 {
            break;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

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
