//! The SpawnLoft command line in Rust: every command the Node core's `mcctl.mjs` answered,
//! answered as it answered them (it left in C10). `run` is `main()` of mcctl.mjs: the same
//! settings warning, the same order of checks, the same `--json` envelope and exit codes (0, 1
//! for a failed operation, 2 for a usage error).
//!
//! C1 (rust/PLAN-CORE-PORT.md section 4) moved the read-only group: `help`, `list`, `status`,
//! `logs`, `why` and `metrics`, with their aliases. C2 moved the server lifecycle: `start`,
//! `stop`, `restart`, `kill`, `cmd`, `send`, `console`, `players`, `set` and `props`, and the
//! databases: `db`. C3 moved the backups: `backup`, `snapshots`, `restore`, `prune` and
//! `verify`, with their aliases, `config` and `worlds`. C4 moves making servers: `new` (but
//! `--modpack`, C5), `clone`, `adopt`, `templates`, `jars`, `launchers`, `reveal` and `rebuild`. C5
//! moves plugins and modpacks: `plugins`, then `pack` and `new --modpack`. C6 moves the scheduled
//! tasks and what moves or drops a server with them: `task`, `rm` (and `remove`) and `rename`. C7
//! moves the client launcher, `client`, whole. C6b moves the diagnostics: `doctor` and `diag`. C8
//! moves the panel: `ui` and `panel`.
//! C9 moves the bot harness, `bot` (the Mineflayer host it drives stays JavaScript).
//! C9 also moves the MCP server, `mcp`.

pub mod args;
mod backup;
mod bot;
mod client;
mod config;
mod configure;
mod create;
mod data;
mod db;
mod doctor;
mod fetch;
mod lifecycle;
mod list;
mod logs;
mod maintenance;
mod mcp;
mod metrics;
mod output;
mod pack;
mod plugins;
mod status;
mod tasks;
mod ui;
mod why;
mod worlds;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::settings::{self, Layout};

use args::{Flag, Parsed};
pub use output::Out;

/// `cmdHelp()`'s text, captured from the Node core (frozen until it leaves in C10); the parity
/// rig's `basics` scenario holds the two equal.
pub const HELP: &str = include_str!("help.txt");

/// What a command needs: the layout, its flags and where to print.
pub struct Ctx<'a> {
    pub layout: &'a Layout,
    pub args: &'a Parsed,
    pub out: &'a mut Out,
}

/// `QUERY_ALIASES` in cli-query.mjs: the commands whose `--json` is a query.
fn query_alias(command: &str) -> Option<&'static str> {
    Some(match command {
        "list" | "ls" => "list",
        "status" => "status",
        "plugins" => "plugins",
        "snapshots" | "backups" => "backups",
        "why" | "diagnostics" => "diagnostics",
        _ => return None,
    })
}

/// Every name `COMMANDS` in mcctl.mjs answers.
const COMMANDS: &[&str] = &[
    "list",
    "ls",
    "status",
    "start",
    "stop",
    "restart",
    "kill",
    "logs",
    "log",
    "cmd",
    "rcon",
    "send",
    "console",
    "attach",
    "players",
    "new",
    "clone",
    "adopt",
    "rm",
    "remove",
    "set",
    "props",
    "backup",
    "snapshot",
    "snapshots",
    "backups",
    "restore",
    "prune",
    "verify",
    "templates",
    "template",
    "jars",
    "paper",
    "config",
    "data",
    "rename",
    "rebuild",
    "reveal",
    "open",
    "plugins",
    "upgrade",
    "pack",
    "worlds",
    "why",
    "diagnostics",
    "diag",
    "metrics",
    "launchers",
    "ui",
    "panel",
    "task",
    "doctor",
    "repair",
    "db",
    "mcp",
    "bot",
    "client",
    "uninstall",
    "help",
];

/// The commands whose own handler takes `--json` (mcctl.mjs main).
const JSON_HANDLERS: &[&str] = &[
    "backup", "snapshot", "doctor", "repair", "metrics", "data", "bot", "diag", "client",
];

/// Runs one ported command line; returns the exit code. Output goes to `out` as it is produced,
/// so `logs -f` and `metrics --follow` stream.
pub fn run(argv: &[String], out: &mut Out) -> u8 {
    // paths.mjs resolves the layout when it is first imported, before any command runs, and
    // warns then about an unusable settings file
    let (loaded, warning) = settings::load();
    let command = argv.first().map(String::as_str);
    let parsed = args::parse(argv.get(1..).unwrap_or(&[]));
    if let Some(w) = warning {
        out.err(&w);
    }
    // a setting of the wrong type crashes the Node core at import: no envelope, even for --json
    let layout = match Layout::resolve(&loaded) {
        Ok(l) => l,
        Err(crash) => {
            out.err(&crash.stderr_text());
            return 1;
        }
    };
    let cli_command = match command {
        Some(c) => query_alias(c)
            .unwrap_or(if c == "snapshot" { "backup" } else { c })
            .to_string(),
        None => "undefined".to_string(),
    };
    let json = parsed.get("json").is_some_and(|f| *f != Flag::Bool(false));
    let result = dispatch(command, &parsed, json, &layout, out);
    match result {
        Ok(()) => out.code(),
        Err(failure) => {
            if json {
                out.print(&output::json_line(&cli_command, None, Some(&failure)));
            } else {
                out.err(&failure.stderr_text());
            }
            failure.exit_code()
        }
    }
}

fn dispatch(
    command: Option<&str>,
    parsed: &Parsed,
    json: bool,
    layout: &Layout,
    out: &mut Out,
) -> Result<(), Failure> {
    if json && parsed.get("json") != Some(&Flag::Bool(true)) {
        return Err(Failure::usage("--json does not take a value"));
    }
    let command = match command {
        None | Some("--help") | Some("-h") => {
            if json {
                return Err(Failure::usage("Use help without --json"));
            }
            out.print(HELP);
            return Ok(());
        }
        Some(c) => c,
    };
    // mcctl.mjs looks the handler up first: an unknown command is that, with or without --json
    if !COMMANDS.contains(&command) {
        return Err(Failure::usage(format!(
            "Unknown command \"{command}\". Run \"spawnloft help\" for usage."
        )));
    }
    if parsed.get("csv").is_some() && command != "metrics" {
        return Err(Failure::usage("--csv is supported only for metrics"));
    }
    let mut ctx = Ctx {
        layout,
        args: parsed,
        out,
    };
    if json && let Some(alias) = query_alias(command) {
        let data = output::query(&mut ctx, alias)?;
        ctx.out.print(&output::json_line(alias, Some(&data), None));
        return Ok(());
    }
    if json && !JSON_HANDLERS.contains(&command) {
        return Err(Failure::usage(format!(
            "--json is not supported for {command}; no action was performed"
        )));
    }
    // not for `data`: it is what puts things right after a move was interrupted, when the data
    // folder is not there, and making its folders again - empty - is the very thing in its way
    if command != "data"
        && let Err(e) = layout.ensure_dirs()
    {
        // the installer's `repair --quiet` shows nothing: its failure goes to handover.log
        if command == "repair" && parsed.get("quiet").is_some_and(Flag::truthy) {
            maintenance::quiet_log(e.message());
            ctx.out.set_code(1);
            return Ok(());
        }
        return Err(e);
    }
    // design section 8, item 1: the first command after an install or update records the version
    // and marks the data folder (the window's `ui` is one). Not `uninstall`, which would leave a
    // marker in the data root it is emptying, nor `help`; and not this crate's own unit tests,
    // which would write to the real config folder.
    // The panel (`ui`) does it itself as it starts, so its panel.log says so.
    if !cfg!(test) && !matches!(command, "data" | "uninstall" | "help" | "ui" | "panel") {
        spawnloft_lib::data_format::mark_version(
            &spawnloft_lib::paths::config_dir(),
            std::path::Path::new(&layout.data_root),
            spawnloft_lib::data_format::release_version(),
        );
    }
    match command {
        "help" => {
            ctx.out.print(HELP);
            Ok(())
        }
        "list" | "ls" => list::list(&mut ctx),
        "status" => status::status(&mut ctx),
        "logs" | "log" => logs::logs(&mut ctx),
        "why" | "diagnostics" => why::why(&mut ctx),
        "metrics" => metrics::metrics(&mut ctx),
        "start" => lifecycle::start(&mut ctx),
        "stop" => lifecycle::stop(&mut ctx),
        "restart" => lifecycle::restart(&mut ctx),
        "kill" => lifecycle::kill(&mut ctx),
        "cmd" | "rcon" => lifecycle::cmd(&mut ctx),
        "send" => lifecycle::send(&mut ctx),
        "console" | "attach" => lifecycle::console(&mut ctx),
        "players" => lifecycle::players(&mut ctx),
        "set" => configure::set(&mut ctx),
        "props" => configure::props(&mut ctx),
        "db" => db::db(&mut ctx),
        "backup" | "snapshot" => backup::backup(&mut ctx),
        "snapshots" | "backups" => backup::snapshots(&mut ctx),
        "restore" => backup::restore(&mut ctx),
        "prune" => backup::prune(&mut ctx),
        "verify" => backup::verify(&mut ctx),
        "config" => config::config(&mut ctx),
        "worlds" => worlds::worlds(&mut ctx),
        "new" => create::new(&mut ctx),
        "clone" => create::clone(&mut ctx),
        "adopt" => create::adopt(&mut ctx),
        "templates" | "template" => create::templates(&mut ctx),
        "jars" => create::jars(&mut ctx),
        "launchers" => create::launchers(&mut ctx),
        "reveal" | "open" => create::reveal(&mut ctx),
        "rebuild" => create::rebuild(&mut ctx),
        "paper" => fetch::paper(&mut ctx),
        "upgrade" => fetch::upgrade(&mut ctx),
        "plugins" => plugins::plugins(&mut ctx),
        "pack" => pack::pack(&mut ctx),
        "client" => client::client(&mut ctx),
        "task" => tasks::task(&mut ctx),
        "rm" | "remove" => tasks::remove(&mut ctx),
        "rename" => tasks::rename(&mut ctx),
        "repair" => maintenance::repair(&mut ctx),
        "uninstall" => maintenance::uninstall(&mut ctx),
        "data" => data::data(&mut ctx),
        "doctor" => doctor::doctor(&mut ctx),
        "diag" => doctor::diag(&mut ctx),
        "bot" => bot::bot(&mut ctx),
        "mcp" => mcp::mcp(&mut ctx),
        "ui" | "panel" => ui::ui(&mut ctx),
        other => Err(Failure::usage(format!(
            "Unknown command \"{other}\". Run \"spawnloft help\" for usage."
        ))),
    }
}

/// `requireName(positional, command)`.
pub fn require_name<'a>(positional: &'a [String], command: &str) -> Result<&'a str, Failure> {
    match positional.first() {
        Some(n) if !n.is_empty() => Ok(n),
        _ => Err(Failure::user(format!(
            "{command} requires an instance name. See: spawnloft list"
        ))),
    }
}

/// `checkFlags(flags, allowed)`.
pub fn check_flags(parsed: &Parsed, allowed: &[&str]) -> Result<(), Failure> {
    for key in parsed.keys() {
        if !allowed.contains(&key) {
            return Err(Failure::usage(format!("Unknown option --{key}")));
        }
    }
    Ok(())
}

/// `instanceName(positional, command)`.
pub fn instance_name<'a>(positional: &'a [String], command: &str) -> Result<&'a str, Failure> {
    match positional {
        [one] => Ok(one),
        _ => Err(Failure::usage(format!("Usage: spawnloft {command} <instance>"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_in(root: &std::path::Path, argv: &[&str]) -> (u8, String, String) {
        // the data root comes from the environment in these tests, as in the parity rig
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        let layout = Layout::resolve(&serde_json::Map::from_iter([(
            "dataRoot".to_string(),
            serde_json::json!(root.to_string_lossy()),
        )]))
        .expect("a string data root");
        let mut out = Out::captured();
        let command = argv.first().map(String::as_str);
        let parsed = args::parse(argv.get(1..).unwrap_or(&[]));
        let json = parsed.get("json").is_some_and(|f| *f != Flag::Bool(false));
        let code = match dispatch(command, &parsed, json, &layout, &mut out) {
            Ok(()) => out.code(),
            Err(f) => {
                if json {
                    let cmd = command
                        .and_then(query_alias)
                        .unwrap_or(command.unwrap_or("undefined"));
                    out.print(&output::json_line(cmd, None, Some(&f)));
                } else {
                    out.err(&f.stderr_text());
                }
                f.exit_code()
            }
        };
        (code, out.stdout_text(), out.stderr_text())
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sl-port-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn the_checks_of_main_come_in_the_node_order() {
        let root = scratch("order");
        assert_eq!(run_in(&root, &["list", "--json=1"]).0, 2);
        let (code, out, _) = run_in(&root, &["list", "--json=1"]);
        assert_eq!(code, 2);
        assert_eq!(
            out,
            "{\"schemaVersion\":1,\"command\":\"list\",\"ok\":false,\"type\":\"error\",\"error\":{\"code\":\"INVALID_USAGE\",\"message\":\"--json does not take a value\"}}\n"
        );
        assert_eq!(run_in(&root, &["--help", "--json"]).0, 2);
        assert_eq!(
            run_in(&root, &["list", "--csv"]).2,
            "error: --csv is supported only for metrics\n"
        );
        assert_eq!(
            run_in(&root, &["logs", "x", "--json"]).1,
            "{\"schemaVersion\":1,\"command\":\"logs\",\"ok\":false,\"type\":\"error\",\"error\":{\"code\":\"INVALID_USAGE\",\"message\":\"--json is not supported for logs; no action was performed\"}}\n"
        );
        // a query answers before the folders are made; a command makes them first
        let (code, out, _) = run_in(&root, &["ls", "--json"]);
        assert_eq!(
            (code, out.as_str()),
            (
                0,
                "{\"schemaVersion\":1,\"command\":\"list\",\"ok\":true,\"data\":{\"instances\":[],\"databases\":[]}}\n"
            )
        );
        assert!(!root.join("instances").exists());
        assert_eq!(run_in(&root, &["help"]).1, HELP);
        assert!(root.join("instances").is_dir() && root.join("services").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn status_list_and_failures() {
        let root = scratch("status");
        std::fs::write(
            root.join("instances.json"),
            r#"{"version":1,"instances":{"b":{"dir":"/x/b","port":2,"memory":"1G"},"a":{"dir":"/x/a","port":1,"memory":"2G","rcon":{"port":3}}}}"#,
        )
        .unwrap();
        let (code, out, _) = run_in(&root, &["list"]);
        assert_eq!(code, 0);
        assert_eq!(
            out,
            "NAME  STATUS   PORT  RCON  MEM  UPTIME  DIR\na     stopped  1     3     2G   -       /x/a\nb     stopped  2     -     1G   -       /x/b\n"
        );
        let (code, _, err) = run_in(&root, &["status", "c"]);
        assert_eq!(
            (code, err.as_str()),
            (1, "error: no instance named \"c\". Known instances: b, a\n")
        );
        assert_eq!(run_in(&root, &["status", "a", "b", "--json"]).0, 2);
        assert_eq!(
            run_in(&root, &["logs"]).2,
            "error: logs requires an instance name. See: spawnloft list\n"
        );
        assert_eq!(run_in(&root, &["metrics", "a", "--json", "--csv"]).0, 2);
        std::fs::write(root.join("instances.json"), "{").unwrap();
        let (code, _, err) = run_in(&root, &["list"]);
        assert_eq!(code, 1);
        assert!(err.starts_with("SyntaxError: JSON parse error: "), "{err}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
