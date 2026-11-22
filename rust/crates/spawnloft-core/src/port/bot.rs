//! `bot setup | check | run` (C9): `cmdBot` in mcctl.mjs, over spawnloft-lib's `bots`.

use std::cell::RefCell;

use serde_json::{Value, json};

use spawnloft_lib::bots;
use spawnloft_lib::failure::Failure;

use super::args::Flag;
use super::output::json_line;
use super::{Ctx, check_flags};

const USAGE: &str = "Usage: spawnloft bot setup | bot check <server> | bot run <scenario.json> [--instance <server>] [--json]";

/// `jsonLine('bot', data, { error })`: the envelope of a command that ran and has data to show
/// beside its refusal.
fn envelope_with_error(data: &Value, code: &str, message: Value) -> String {
    let env = json!({
        "schemaVersion": 1,
        "command": "bot",
        "ok": false,
        "data": data,
        "error": { "code": code, "message": message },
    });
    format!("{}\n", spawnloft_lib::jsjson::stringify(&env))
}

pub fn bot(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let positional = ctx.args.positional.clone();
    let sub = positional.first().map(String::as_str);
    let rest = positional.get(1..).unwrap_or(&[]);
    let is_true = |f: Option<&Flag>| f == Some(&Flag::Bool(true));
    match sub {
        Some("setup") => {
            check_flags(ctx.args, &["force"])?;
            if !rest.is_empty() {
                return Err(Failure::usage(USAGE));
            }
            let force = is_true(ctx.args.get("force"));
            let have = bots::host_install(ctx.layout);
            let pinned = bots::host_is_pinned(ctx.layout);
            if let Some(have) = &have {
                if pinned && !force {
                    ctx.out.line(&format!(
                        "mineflayer {} is installed in {}. Reinstall with --force.",
                        have.version, have.dir
                    ));
                    return Ok(());
                }
                if !pinned {
                    ctx.out.line(&format!(
                        "The mineflayer in {} is not a finished install of this SpawnLoft's lockfile; replacing it.",
                        have.dir
                    ));
                }
            }
            let out = RefCell::new(&mut *ctx.out);
            let installed = bots::ensure_host(ctx.layout, force, &|m| out.borrow_mut().line(m))?;
            out.borrow_mut().line(&format!(
                "mineflayer {} is installed in {}.",
                installed.version, installed.dir
            ));
            Ok(())
        }
        Some("check") => {
            check_flags(ctx.args, &["json"])?;
            let [name] = rest else {
                return Err(Failure::usage(USAGE));
            };
            let res = bots::check_instance(ctx.layout, name)?;
            let have = bots::host_install(ctx.layout);
            let mut problems = res.problems.clone();
            if have.is_none() {
                problems.push(
                    "mineflayer is not installed yet: run \"spawnloft bot setup\" (about 500 MB)".to_string(),
                );
            }
            if let Some(p) = bots::host_node_problem() {
                problems.push(p);
            }
            if is_true(ctx.args.get("json")) {
                let data = json!({
                    "name": name,
                    "ok": problems.is_empty(),
                    "problems": problems,
                    "warnings": res.warnings,
                    "minecraftVersion": res.version,
                    "mineflayer": have.as_ref().map(|h| h.version.clone()),
                    "maxBots": bots::MAX_BOTS,
                });
                let line = match problems.first() {
                    None => json_line("bot", Some(&data), None),
                    Some(first) => envelope_with_error(&data, "BOTS_REFUSED", json!(first)),
                };
                ctx.out.print(&line);
            } else {
                for w in &res.warnings {
                    ctx.out.line(&format!("warning: {w}"));
                }
                for p in &problems {
                    ctx.out.line(p);
                }
                if let (true, Some(have)) = (problems.is_empty(), &have) {
                    let version = res
                        .version
                        .as_deref()
                        .filter(|v| !v.is_empty())
                        .map_or(String::new(), |v| format!(" (Minecraft {v})"));
                    ctx.out.line(&format!(
                        "\"{name}\" will take up to {} bots{version}. mineflayer {} is installed.",
                        bots::MAX_BOTS,
                        have.version
                    ));
                }
            }
            if !problems.is_empty() {
                ctx.out.set_code(1);
            }
            Ok(())
        }
        Some("run") => {
            check_flags(ctx.args, &["instance", "json"])?;
            let [file] = rest else {
                return Err(Failure::usage(USAGE));
            };
            let scenario = bots::load_scenario(file)?;
            let quiet = is_true(ctx.args.get("json"));
            // `flags.instance ?? null`: a bare --instance is true, --no-instance false
            let instance = match ctx.args.get("instance") {
                None => None,
                Some(Flag::Text(s)) => Some(s.clone()),
                Some(Flag::Bool(true)) => Some("true".to_string()),
                Some(Flag::Bool(false)) => Some(String::new()),
            };
            let out = RefCell::new(&mut *ctx.out);
            let report = bots::run_scenario(ctx.layout, &scenario, instance.as_deref(), &|m| {
                if !quiet {
                    out.borrow_mut().err(&format!("{m}\n"));
                }
            })?;
            let out = out.into_inner();
            let ok = spawnloft_lib::js::truthy(report.get("ok"));
            if quiet {
                let line = if ok {
                    json_line("bot", Some(&report), None)
                } else {
                    let message = match report.get("error") {
                        None | Some(Value::Null) => json!("a step failed"),
                        Some(e) => e.clone(),
                    };
                    envelope_with_error(&report, "SCENARIO_FAILED", message)
                };
                out.print(&line);
            } else {
                out.line(&bots::format_report(&report));
            }
            if !ok {
                out.set_code(1);
            }
            Ok(())
        }
        _ => Err(Failure::usage(USAGE)),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Out, args};
    use super::*;
    use spawnloft_lib::settings::Layout;

    /// `bot <argv...>` as main() runs it: the envelope for a failure under --json.
    fn run_bot(layout: &Layout, argv: &[&str]) -> (u8, String, String) {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let parsed = args::parse(&argv);
        let json = parsed.get("json").is_some_and(Flag::truthy);
        let mut out = Out::captured();
        let result = bot(&mut Ctx {
            layout,
            args: &parsed,
            out: &mut out,
        });
        let code = match result {
            Ok(()) => out.code(),
            Err(f) => {
                if json {
                    out.print(&json_line("bot", None, Some(&f)));
                } else {
                    out.err(&f.stderr_text());
                }
                f.exit_code()
            }
        };
        (code, out.stdout_text(), out.stderr_text())
    }

    #[test]
    fn usage_check_and_run_as_the_node_cli_answers() {
        let root = std::env::temp_dir().join(format!("sl-port-bot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let offline = root.join("instances").join("offline");
        std::fs::create_dir_all(&offline).unwrap();
        std::fs::write(
            offline.join("server.properties"),
            "online-mode=false\nserver-ip=127.0.0.1\n",
        )
        .unwrap();
        let reg = json!({ "version": 1, "instances": {
            "offline": { "dir": offline.to_string_lossy(), "jar": "paper-1.21.4-100.jar", "memory": "1G", "port": 45623 },
        } });
        std::fs::write(root.join("instances.json"), reg.to_string()).unwrap();
        let mut s = serde_json::Map::new();
        s.insert("dataRoot".into(), json!(root.to_string_lossy()));
        let layout = Layout::resolve(&s).unwrap();

        for argv in [
            &["dance"][..],
            &[],
            &["check"],
            &["setup", "x"],
            &["run"],
            &["check", "offline", "--x"],
        ] {
            assert_eq!(run_bot(&layout, argv).0, 2, "{argv:?}");
        }
        assert_eq!(run_bot(&layout, &["dance"]).2, format!("error: {USAGE}\n"));

        let (code, out, _) = run_bot(&layout, &["check", "offline"]);
        assert_eq!(code, 1);
        assert_eq!(
            out,
            "\"offline\" is not running. Start it first: spawnloft start offline\nmineflayer is not installed yet: run \"spawnloft bot setup\" (about 500 MB)\n"
        );
        let (code, out, _) = run_bot(&layout, &["check", "offline", "--json"]);
        assert_eq!(code, 1);
        assert_eq!(
            out,
            "{\"schemaVersion\":1,\"command\":\"bot\",\"ok\":false,\"data\":{\"name\":\"offline\",\"ok\":false,\"problems\":[\"\\\"offline\\\" is not running. Start it first: spawnloft start offline\",\"mineflayer is not installed yet: run \\\"spawnloft bot setup\\\" (about 500 MB)\"],\"warnings\":[],\"minecraftVersion\":\"1.21.4\",\"mineflayer\":null,\"maxBots\":5},\"error\":{\"code\":\"BOTS_REFUSED\",\"message\":\"\\\"offline\\\" is not running. Start it first: spawnloft start offline\"}}\n"
        );

        // a scenario that cannot be read: one envelope, exit 1, before any server is touched
        let broken = root.join("broken.json");
        std::fs::write(&broken, "{ not json").unwrap();
        let file = broken.to_string_lossy().into_owned();
        let (code, _, err) = run_bot(&layout, &["run", &file]);
        assert_eq!(code, 1);
        assert!(
            err.starts_with(&format!("error: {file} is not valid JSON: ")),
            "{err}"
        );
        let (code, out, _) = run_bot(&layout, &["run", &file, "--json"]);
        assert_eq!(code, 1);
        assert_eq!(out.lines().count(), 1);
        let env: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            (env["ok"].clone(), env["error"]["code"].clone()),
            (json!(false), json!("COMMAND_FAILED"))
        );
        assert!(
            env["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not valid JSON")
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
