//! `spawnloft-core update ...`: the updater from the command line (INSTALLER-UPDATER-DESIGN.md
//! 5.1). The window shell runs `update check --json` and `update rollback <v> --json` and reads
//! the pinned record from stdout; a headless install runs `update check` then `update apply`.

use semver::Version;
use spawnloft_lib::update::fetch::Https;
use spawnloft_lib::update::store::Store;
use spawnloft_lib::update::{Context, Outcome, api, envelope::Channel};

use crate::cli::{EXIT_USAGE, Outcome as Out};

pub const HELP: &str = "\
  update check [--json] [--channel stable|beta]   look for a newer release and verify its feed
  update status [--json]                          what the last check found, the channel and the hold
  update apply [--json] [--no-run]                headless: download, verify and (Windows) install the pending update
  update list [--json]                            releases below this one that can be rolled back to
  update rollback <version> [--force-data-format] [--json]   plan a rollback (writes the hold); then `update apply`
  update hold [clear] [--json]                    show or clear the hold a rollback left
  update channel [stable|beta] [--json]           show or choose the channel
  update log [-n <lines>]                         the last lines of update.log";

/// Exit codes: 0 answered (an update being available is 0 too), 1 the feed could not be read or
/// the action failed, 3 a newer release exists but is blocked, 64 usage.
pub const EXIT_FAILED: u8 = 1;
pub const EXIT_BLOCKED: u8 = 3;

struct Flags {
    json: bool,
    rest: Vec<String>,
}

fn flags(args: &[String]) -> Flags {
    let json = args.iter().any(|a| a == "--json");
    Flags {
        json,
        rest: args.iter().filter(|a| *a != "--json").cloned().collect(),
    }
}

fn usage(message: &str) -> Out {
    Out {
        stdout: String::new(),
        stderr: format!("spawnloft-core update: {message}\n\nUsage:\n{HELP}\n"),
        code: EXIT_USAGE,
    }
}

fn failed(message: &str, json: bool) -> Out {
    if json {
        return Out {
            stdout: format!("{}\n", serde_json::json!({ "ok": false, "error": message })),
            stderr: String::new(),
            code: EXIT_FAILED,
        };
    }
    Out {
        stdout: String::new(),
        stderr: format!("spawnloft-core update: {message}\n"),
        code: EXIT_FAILED,
    }
}

fn print(value: serde_json::Value, plain: String, json: bool, code: u8) -> Out {
    Out {
        stdout: if json {
            format!("{value}\n")
        } else {
            format!("{plain}\n")
        },
        stderr: String::new(),
        code,
    }
}

pub fn run(args: &[String]) -> Out {
    let Some((sub, args)) = args.split_first() else {
        return usage("which update command?");
    };
    let f = flags(args);
    let store = Store::default_location();
    let fetch = Https::default();
    match sub.as_str() {
        "check" => {
            let mut channel = None;
            let mut it = f.rest.iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--channel" => match it.next().map(String::as_str).and_then(Channel::parse) {
                        Some(c) => channel = Some(c),
                        None => return usage("--channel takes stable or beta"),
                    },
                    other => return usage(&format!("unexpected argument `{other}`")),
                }
            }
            let ctx = match Context::current(&store, &fetch, channel) {
                Ok(c) => c,
                Err(e) => return failed(&e, f.json),
            };
            let report = ctx.check();
            let code = match &report.outcome {
                Outcome::Update(_) | Outcome::UpToDate => 0,
                Outcome::Blocked(_) => EXIT_BLOCKED,
                Outcome::Unreachable(_) => EXIT_FAILED,
            };
            print(report.to_json(), api::describe(&report), f.json, code)
        }
        "status" => {
            if !f.rest.is_empty() {
                return usage("status takes no arguments");
            }
            let ctx = match Context::current(&store, &fetch, None) {
                Ok(c) => c,
                Err(e) => return failed(&e, f.json),
            };
            let status = ctx.status();
            let plain = format!(
                "installed {} ({} channel); last check {}: {}{}{}",
                status["installed"].as_str().unwrap_or("?"),
                status["channel"].as_str().unwrap_or("?"),
                status["lastCheckAt"].as_str().unwrap_or("never"),
                status["lastResult"].as_str().unwrap_or("-"),
                status["hold"]
                    .as_str()
                    .map(|h| format!("; hold below {h}"))
                    .unwrap_or_default(),
                if status["staleFeed"].as_bool() == Some(true) {
                    "; the update feed is older than expected"
                } else {
                    ""
                },
            );
            print(status, plain, f.json, 0)
        }
        "apply" => {
            let mut run_installer = true;
            for a in &f.rest {
                match a.as_str() {
                    "--no-run" => run_installer = false,
                    other => return usage(&format!("unexpected argument `{other}`")),
                }
            }
            let ctx = match Context::current(&store, &fetch, None) {
                Ok(c) => c,
                Err(e) => return failed(&e, f.json),
            };
            let Some(pending) = store.state().pending else {
                return failed(
                    "nothing to apply: run `update check` (or `update rollback <version>`) first",
                    f.json,
                );
            };
            match spawnloft_lib::update::apply(&ctx, &pending, run_installer) {
                Ok(done) => print(
                    serde_json::json!({ "ok": true, "version": pending.version, "rollback": pending.rollback, "done": done }),
                    done,
                    f.json,
                    0,
                ),
                Err(e) => failed(&e, f.json),
            }
        }
        "list" => {
            if !f.rest.is_empty() {
                return usage("list takes no arguments");
            }
            let ctx = match Context::current(&store, &fetch, None) {
                Ok(c) => c,
                Err(e) => return failed(&e, f.json),
            };
            match ctx.rollback_candidates() {
                Ok(list) => {
                    let plain = if list.is_empty() {
                        "no earlier release to roll back to".to_string()
                    } else {
                        list.iter()
                            .map(|e| match &e.reason {
                                None => format!("{}  (data format {})", e.version, e.data_format),
                                Some(why) => format!("{}  not available: {why}", e.version),
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    print(
                        serde_json::json!({ "ok": true, "installed": ctx.installed.to_string(), "releases": list.iter().map(|e| e.to_json()).collect::<Vec<_>>() }),
                        plain,
                        f.json,
                        0,
                    )
                }
                Err(e) => failed(&e, f.json),
            }
        }
        "rollback" => {
            let mut version = None;
            let mut force = false;
            for a in &f.rest {
                match a.as_str() {
                    "--force-data-format" => force = true,
                    v if version.is_none() && !v.starts_with('-') => version = Some(v.to_string()),
                    other => return usage(&format!("unexpected argument `{other}`")),
                }
            }
            let Some(version) = version else {
                return usage("rollback needs the version to go back to");
            };
            let Ok(version) = Version::parse(version.trim_start_matches('v')) else {
                return usage(&format!("`{version}` is not a version"));
            };
            let ctx = match Context::current(&store, &fetch, None) {
                Ok(c) => c,
                Err(e) => return failed(&e, f.json),
            };
            match ctx.plan_rollback(&version, force) {
                Ok(pinned) => print(
                    serde_json::json!({ "ok": true, "update": pinned.to_json() }),
                    format!(
                        "rollback to {} verified; updates to {} and below are held. Run `update apply` to install it.",
                        pinned.version, ctx.installed
                    ),
                    f.json,
                    0,
                ),
                Err(e) => failed(&e, f.json),
            }
        }
        "hold" => match f.rest.as_slice() {
            [] => {
                let hold = store.hold();
                print(
                    serde_json::json!({ "hold": hold.as_ref().map(ToString::to_string) }),
                    hold.map_or("no hold".to_string(), |h| format!("updates up to {h} are held")),
                    f.json,
                    0,
                )
            }
            [clear] if clear == "clear" => match store.clear_hold() {
                Ok(()) => {
                    store.log("hold-cleared", &[("by", "cli")]);
                    print(
                        serde_json::json!({ "ok": true }),
                        "hold cleared".to_string(),
                        f.json,
                        0,
                    )
                }
                Err(e) => failed(&format!("could not clear the hold: {e}"), f.json),
            },
            _ => usage("hold takes `clear` or nothing"),
        },
        "channel" => {
            let installed = Version::parse(spawnloft_lib::build::current().version).ok();
            match f.rest.as_slice() {
                [] => {
                    let choice = installed.as_ref().map(|v| store.channel(v));
                    let beta = choice.as_ref().is_some_and(|c| c.beta);
                    print(
                        serde_json::json!({ "channel": if beta { "beta" } else { "stable" }, "chosen": choice.as_ref().is_some_and(|c| c.chosen) }),
                        format!("{} channel", if beta { "beta" } else { "stable" }),
                        f.json,
                        0,
                    )
                }
                [c] if c == "stable" || c == "beta" => match store.set_channel(c == "beta") {
                    Ok(()) => {
                        store.log("channel", &[("beta", if c == "beta" { "true" } else { "false" })]);
                        print(
                            serde_json::json!({ "ok": true, "channel": c }),
                            format!("{c} channel"),
                            f.json,
                            0,
                        )
                    }
                    Err(e) => failed(&format!("could not save the channel: {e}"), f.json),
                },
                _ => usage("channel takes stable, beta or nothing"),
            }
        }
        "log" => {
            let mut n = 50;
            let mut it = f.rest.iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "-n" => match it.next().and_then(|v| v.parse().ok()) {
                        Some(v) => n = v,
                        None => return usage("-n needs a number"),
                    },
                    other => return usage(&format!("unexpected argument `{other}`")),
                }
            }
            let lines = store.log_tail(n);
            print(serde_json::json!({ "lines": lines }), lines.join("\n"), f.json, 0)
        }
        other => usage(&format!("unknown update command `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn usage_errors_need_no_network() {
        assert_eq!(run(&[]).code, EXIT_USAGE);
        assert_eq!(run(&args(&["frob"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["check", "--channel", "nightly"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["rollback"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["rollback", "not-a-version"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["hold", "please"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["channel", "nightly"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["log", "-n", "x"])).code, EXIT_USAGE);
    }
}
