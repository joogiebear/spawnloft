//! `client-diagnose.mjs`: the client's known failure shapes, read over latest.log and the client
//! process's output. The rules of the scan (newest evidence first, each shape once, at most
//! three findings, returned in log order) and the Java-release table are `diagnose.rs`'s; the
//! patterns are client-diagnose.mjs's own source, compiled as JavaScript reads it.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::diagnose::{Finding, class_version_to_java};
use crate::js;

/// What the advice can mention. The diag bundle passes only `memory` and `profile`; `mc` and
/// `crash_dir` stay for a caller that knows them, as in the Node core.
#[derive(Debug, Default, Clone)]
pub struct Context {
    pub memory: Option<String>,
    pub profile: Option<String>,
    pub mc: Option<String>,
    pub crash_dir: Option<String>,
}

type Advice = fn(&Captures, &Context) -> String;

struct Shape {
    id: &'static str,
    test: Regex,
    title: &'static str,
    advice: Advice,
}

fn shape(id: &'static str, source: &str, ignore_case: bool, title: &'static str, advice: Advice) -> Shape {
    Shape {
        id,
        test: crate::jsregex::compile(source, ignore_case).expect("client diagnose pattern"),
        title,
        advice,
    }
}

fn or<'a>(v: &'a Option<String>, default: &'a str) -> &'a str {
    v.as_deref().unwrap_or(default)
}

static SHAPES: LazyLock<Vec<Shape>> = LazyLock::new(|| {
    vec![
        shape(
            "client-out-of-memory",
            r"java\.lang\.OutOfMemoryError",
            false,
            "The client ran out of memory",
            |_, c| {
                format!(
                    "It has {} and wants more. Raise it with \"spawnloft client set {} memory=4G\", and make sure the machine has that to give.",
                    or(&c.memory, "its configured memory"),
                    or(&c.profile, "the profile")
                )
            },
        ),
        shape(
            "opengl",
            // not /i: Sodium and the driver print "OpenGL Version: 4.6" on every healthy start
            r"Failed to create window|GLFW error|Could not create (?:the )?OpenGL context|OpenGL (?:version|context) .*not supported|No OpenGL context",
            false,
            "The graphics subsystem could not start",
            |_, _| {
                "The graphics driver could not create a window or an OpenGL context. Update the GPU driver; a headless machine with no display cannot run the client, and bots (\"spawnloft bot\") are the way to test there.".into()
            },
        ),
        shape(
            "mod-dependency",
            r"requires (?:any version|version [^ ]+) of ([\w-]+), which is missing",
            true,
            "A mod is missing a dependency",
            |m, _| {
                format!(
                    "A mod needs \"{}\", which is not installed. Install it into the profile's mods/ folder.",
                    &m[1]
                )
            },
        ),
        shape(
            "mod-wrong-version",
            r"Mod '[^']+' \([\w-]+\) [^ ]+ requires|Incompatible mods found",
            true,
            "A mod is built for a different Minecraft version",
            |_, c| {
                format!(
                    "A mod is built for a different Minecraft version than {}. Re-download it for the right version, or switch the profile to the version it wants.",
                    or(&c.mc, "this version")
                )
            },
        ),
        shape(
            // Forge and NeoForge (1.13+) list each missing or mismatched dependency like this
            "mod-dependency-forge",
            r"Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)', Expected range: '([^']*)'",
            false,
            "A mod is missing a dependency, or has the wrong version of it",
            |m, c| {
                if &m[1] == "minecraft" {
                    format!(
                        "The mod \"{}\" is made for Minecraft {}, not {}. Get its build for this version.",
                        &m[2],
                        &m[3],
                        or(&c.mc, "this version")
                    )
                } else if &m[1] == "forge" || &m[1] == "neoforge" {
                    format!(
                        "The mod \"{}\" needs another {} build ({}). Set it with \"spawnloft client set {} loaderVersion=<build>\".",
                        &m[2],
                        if &m[1] == "forge" { "Forge" } else { "NeoForge" },
                        &m[3],
                        or(&c.profile, "<profile>")
                    )
                } else {
                    format!(
                        "The mod \"{}\" needs \"{}\" {}. Put the right build of it into the profile's mods/ folder.",
                        &m[2], &m[1], &m[3]
                    )
                }
            },
        ),
        shape(
            // Forge for 1.12.2 and older, started on Java 9 or newer
            "forge-needs-java-8",
            r"AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader",
            false,
            "This Forge needs Java 8",
            |_, c| {
                format!(
                    "Forge for this Minecraft version runs on Java 8 only. Clear the profile's Java with \"spawnloft client set {} java=\" so SpawnLoft picks it.",
                    or(&c.profile, "<profile>")
                )
            },
        ),
        shape(
            "connection-refused",
            r"Connection refused|Failed to connect to the server|io\.netty\.channel\.AbortedException",
            true,
            "The client could not reach the server",
            |_, _| {
                "The server is not running or the address is wrong. \"spawnloft list\" shows which servers are up.".into()
            },
        ),
        shape(
            "kicked-outdated",
            r"Outdated (client|server)|Incompatible client",
            true,
            "The client version does not match the server",
            |_, c| {
                format!(
                    "The profile's Minecraft version ({}) differs from the server's. Set it with \"spawnloft client set {} mc=<version>\".",
                    or(&c.mc, "this version"),
                    or(&c.profile, "the profile")
                )
            },
        ),
        shape(
            "auth-failed",
            r"Failed to verify username|Invalid session|Authentication servers are down",
            true,
            "Authentication failed",
            |_, _| {
                "An offline profile can only join a server with online-mode=false; for any other server, the Microsoft sign-in has expired: sign in again with \"spawnloft client login\".".into()
            },
        ),
        shape(
            "resource-pack",
            r"Failed to (download|apply) resource pack|Couldn't load pack",
            true,
            "A resource pack could not be loaded",
            |_, _| {
                "The resource pack could not be downloaded or applied. Check resource-pack and resource-pack-sha1 in the server's server.properties: the URL must be reachable from this machine and the hash must match the file.".into()
            },
        ),
        shape(
            "crash-report",
            r"#@!@# Game crashed!|---- Minecraft Crash Report ----",
            false,
            "The game crashed",
            |_, c| {
                format!(
                    "The game crashed. See the crash report in {} for the full stack trace.",
                    or(&c.crash_dir, "crash-reports/")
                )
            },
        ),
        shape(
            "wrong-java",
            r"UnsupportedClassVersionError.*class file version (\d+)",
            true,
            "Java is too old for this client",
            |m, _| {
                let needs = class_version_to_java(js::string_to_number(&m[1]));
                format!(
                    "The client is built for Java {needs} or newer, and the Java that launched it is older. Install Java {needs}+ and, if several are installed, point the profile at it with \"spawnloft client set <profile> java=<path>\"."
                )
            },
        ),
    ]
});

/// `clientDiagnose(lines, ctx)`: `scanShapes` over the client's shapes.
pub fn client_diagnose<S: AsRef<str>>(lines: &[S], ctx: &Context) -> Vec<Finding> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> Context {
        Context {
            memory: Some("2G".into()),
            profile: Some("p".into()),
            ..Context::default()
        }
    }

    #[test]
    fn names_the_shapes_with_the_bundle_context() {
        let lines = [
            "[12:00:00] [Render thread/INFO]: OpenGL Version: 4.6",
            "Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space",
            "Mod ID: 'forge', Requested by: 'jei', Expected range: '[47.2,)'",
            "java.lang.UnsupportedClassVersionError: x has been compiled by a more recent version (class file version 65.0)",
        ];
        let found = client_diagnose(&lines, &ctx());
        let ids: Vec<&str> = found.iter().map(|f| f.id).collect();
        assert_eq!(
            ids,
            ["client-out-of-memory", "mod-dependency-forge", "wrong-java"]
        );
        assert_eq!(
            found[0].advice,
            "It has 2G and wants more. Raise it with \"spawnloft client set p memory=4G\", and make sure the machine has that to give."
        );
        assert_eq!(
            found[1].advice,
            "The mod \"jei\" needs another Forge build ([47.2,)). Set it with \"spawnloft client set p loaderVersion=<build>\"."
        );
        assert!(
            found[2]
                .advice
                .starts_with("The client is built for Java 21 or newer")
        );
        assert_eq!(found[1].at, 2);
    }

    #[test]
    fn opengl_is_case_sensitive_and_the_crash_dir_has_a_default() {
        assert!(client_diagnose(&["failed to create window"], &ctx()).is_empty());
        let f = client_diagnose(
            &["#@!@# Game crashed! Crash report saved to: x"],
            &Context::default(),
        );
        assert_eq!(
            f[0].advice,
            "The game crashed. See the crash report in crash-reports/ for the full stack trace."
        );
        let f = client_diagnose(&["outdated SERVER! I'm still on 1.20"], &Context::default());
        assert_eq!(f[0].id, "kicked-outdated");
        assert!(f[0].advice.contains("(this version)") && f[0].advice.contains("set the profile mc="));
    }
}
