//! Argument handling, by hand: the port parses flags the way `src/args.mjs` does, because flag
//! handling is part of the CLI's contract (rust/PLAN-CORE-PORT.md rule 8).
//!
//! `spawnloft-core` is the one entry point of an install (PLAN-2.0-REMAINING.md section 4): the
//! commands below are its own, and every other command line is the SpawnLoft CLI, forwarded to
//! the Node core on the bundled Node ([`forwards`], `spawnloft_lib::runtime::forward`) until the
//! core port moves it here ([`PORTED`]). The `spawnloft` and `mcctl` launchers, task shims,
//! server launchers and MCP configs all run this binary.

use spawnloft_lib::build;

/// What a command printed and how it exited, so the dispatcher is testable without a process.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub stdout: String,
    pub stderr: String,
    pub code: u8,
}

/// Exit code for a command line that could not be understood (BSD `EX_USAGE`).
pub const EXIT_USAGE: u8 = 64;

fn ok(stdout: String) -> Outcome {
    Outcome {
        stdout,
        stderr: String::new(),
        code: 0,
    }
}

pub fn usage_error(message: &str) -> Outcome {
    Outcome {
        stdout: String::new(),
        stderr: format!(
            "{}: {message}\nRun `{} --core-help` for this binary's commands.\n",
            build::NAME,
            build::NAME
        ),
        code: EXIT_USAGE,
    }
}

/// An argument that is not valid UTF-8: nothing this binary takes can contain one yet.
pub fn not_utf8() -> Outcome {
    usage_error("an argument is not valid UTF-8")
}

/// When a row of the ownership table applies to a command line.
#[derive(Debug, Clone, Copy)]
pub enum When {
    /// Whatever follows the command.
    Always,
    /// Only with one of these flags: the forms only the installer and the window use.
    AnyFlag(&'static [&'static str]),
    /// Unless one of these flags is truthy once the line is parsed as `args.mjs` parses it
    /// (`new --modpack` stays with the Node core until C5).
    NoneTruthy(&'static [&'static str]),
}

/// One row of the ownership table: a command, its aliases, and when this binary answers it.
#[derive(Debug, Clone, Copy)]
pub struct Row {
    pub names: &'static [&'static str],
    pub when: When,
}

/// This binary's own commands, which the Node core has no twin for (or, for `ui`, `repair` and
/// `uninstall`, only the installer's and the window's forms, which keep their own exit codes).
/// They are answered here whatever `SPAWNLOFT_CORE_IMPL` says. `uninstall --yes` is here because
/// its fallback removes the scheduled tasks when the Node core cannot run, so it must never be
/// reached by a person asking what `uninstall` does.
pub const CORE_OWN: &[Row] = &[
    Row {
        names: &["--version", "-V", "version"],
        when: When::Always,
    },
    Row {
        names: &["--core-help"],
        when: When::Always,
    },
    Row {
        names: &["daemon"],
        when: When::Always,
    },
    Row {
        names: &["probe-process"],
        when: When::Always,
    },
    Row {
        names: &["handover"],
        when: When::Always,
    },
    Row {
        names: &["update"],
        when: When::Always,
    },
    Row {
        names: &["user-path"],
        when: When::Always,
    },
    Row {
        names: &["ui"],
        when: When::AnyFlag(&["--exit-with-stdin", "--core-dir", "--upstream", "--node"]),
    },
    Row {
        names: &["repair"],
        when: When::AnyFlag(&["--quiet"]),
    },
    Row {
        names: &["uninstall"],
        when: When::AnyFlag(&["--yes"]),
    },
];

/// SpawnLoft CLI commands the core port has moved from the Node core to this binary
/// (rust/PLAN-CORE-PORT.md section 4), answered by `crate::port`. A phase adds its commands here
/// only once their parity scenarios (tools/parity/) are green on every platform. A command line
/// with no command at all is the CLI's usage, which is `help`'s and moved with it.
pub const PORTED: &[Row] = &[
    // C1: foundation and status
    Row {
        names: &["help", "--help", "-h"],
        when: When::Always,
    },
    Row {
        names: &["list", "ls"],
        when: When::Always,
    },
    Row {
        names: &["status"],
        when: When::Always,
    },
    Row {
        names: &["logs", "log"],
        when: When::Always,
    },
    Row {
        names: &["why", "diagnostics"],
        when: When::Always,
    },
    Row {
        names: &["metrics"],
        when: When::Always,
    },
    // C2: the server lifecycle
    Row {
        names: &["start"],
        when: When::Always,
    },
    Row {
        names: &["stop"],
        when: When::Always,
    },
    Row {
        names: &["restart"],
        when: When::Always,
    },
    Row {
        names: &["kill"],
        when: When::Always,
    },
    Row {
        names: &["cmd", "rcon"],
        when: When::Always,
    },
    Row {
        names: &["send"],
        when: When::Always,
    },
    Row {
        names: &["console", "attach"],
        when: When::Always,
    },
    Row {
        names: &["players"],
        when: When::Always,
    },
    Row {
        names: &["set"],
        when: When::Always,
    },
    Row {
        names: &["props"],
        when: When::Always,
    },
    Row {
        names: &["db"],
        when: When::Always,
    },
    // C3: backups, and where the data lives
    Row {
        names: &["backup", "snapshot"],
        when: When::Always,
    },
    Row {
        names: &["snapshots", "backups"],
        when: When::Always,
    },
    Row {
        names: &["restore"],
        when: When::Always,
    },
    Row {
        names: &["prune"],
        when: When::Always,
    },
    Row {
        names: &["verify"],
        when: When::Always,
    },
    Row {
        names: &["config"],
        when: When::Always,
    },
    Row {
        names: &["worlds"],
        when: When::Always,
    },
    // C4: making servers. `new` with a software flag fetches or builds its jar (C4 part 2);
    // `new --modpack` is C5's
    Row {
        names: &["new"],
        when: When::NoneTruthy(&[
            "modpack",
            "paper",
            "folia",
            "purpur",
            "asp",
            "vanilla",
            "spigot",
            "craftbukkit",
            "fabric",
            "neoforge",
        ]),
    },
    Row {
        names: &["clone"],
        when: When::Always,
    },
    Row {
        names: &["adopt"],
        when: When::Always,
    },
    Row {
        names: &["templates", "template"],
        when: When::Always,
    },
    Row {
        names: &["jars"],
        when: When::Always,
    },
    Row {
        names: &["launchers"],
        when: When::Always,
    },
    Row {
        names: &["reveal", "open"],
        when: When::Always,
    },
    Row {
        names: &["rebuild"],
        when: When::Always,
    },
];

/// The CI and support switch (plan section 3.1): `SPAWNLOFT_CORE_IMPL=node` forwards every
/// ported command to the Node core again, so the parity rig can run one scenario on both sides.
/// Never written into a shim; removed when the Node core leaves (C10).
pub const IMPL_ENV: &str = "SPAWNLOFT_CORE_IMPL";

fn row_matches(row: &Row, command: &str, rest: &[std::ffi::OsString]) -> bool {
    row.names.contains(&command)
        && match row.when {
            When::Always => true,
            When::AnyFlag(flags) => flags.iter().any(|f| rest.iter().any(|a| a == f)),
            When::NoneTruthy(flags) => {
                // a line that is not UTF-8 is not one the ported side can read: Node keeps it
                let Some(rest) = rest
                    .iter()
                    .map(|a| a.to_str().map(String::from))
                    .collect::<Option<Vec<String>>>()
                else {
                    return false;
                };
                let parsed = crate::port::args::parse(&rest);
                !flags.iter().any(|f| parsed.get(f).is_some_and(|v| v.truthy()))
            }
        }
}

/// Whether this command line belongs to the SpawnLoft CLI on the Node core rather than to this
/// binary, by the ownership table and the process's `SPAWNLOFT_CORE_IMPL`.
pub fn forwards(args: &[std::ffi::OsString]) -> bool {
    let force_node = std::env::var_os(IMPL_ENV).is_some_and(|v| v == "node");
    forwards_with(args, force_node, PORTED)
}

/// Whether a command line this binary answers is a ported SpawnLoft command (`crate::port`)
/// rather than one of its own.
pub fn is_ported(args: &[String]) -> bool {
    match args.split_first() {
        None => true,
        Some((command, rest)) => {
            let rest: Vec<std::ffi::OsString> = rest.iter().map(Into::into).collect();
            !CORE_OWN.iter().any(|r| row_matches(r, command, &rest))
                && PORTED.iter().any(|r| row_matches(r, command, &rest))
        }
    }
}

/// [`forwards`] with the switch and the ported table given, for tests.
pub fn forwards_with(args: &[std::ffi::OsString], force_node: bool, ported: &[Row]) -> bool {
    let Some((command, rest)) = args.split_first() else {
        // no arguments: the CLI's own usage, which moves with `help`
        return force_node || !ported.iter().any(|r| r.names.contains(&"help"));
    };
    let Some(command) = command.to_str() else {
        return true;
    };
    if CORE_OWN.iter().any(|r| row_matches(r, command, rest)) {
        return false;
    }
    force_node || !ported.iter().any(|r| row_matches(r, command, rest))
}

pub fn help() -> String {
    let info = build::current();
    format!(
        "{line}\n\
         \n\
         This binary's own commands; every other command is the SpawnLoft command line\n\
         (`{name} help` lists those).\n\
         \n\
         Usage:\n  \
           {name} --version [--json]   print this build's version, commit and target\n  \
           {name} daemon <name>        supervise one server (spawned by the supervisor)\n  \
           {name} ui --exit-with-stdin [--port n] [--core-dir d]  the window's panel on 127.0.0.1\n  \
           {name} handover stop|resume  the 1.x to 2.0 handover (run by the installer)\n  \
           {name} repair --quiet        rewrite task shims and server launchers (run by the installer)\n  \
           {name} uninstall --yes [--data]  stop servers and remove tasks (run by the uninstaller)\n  \
           {name} user-path add|remove  resources\\bin on the user PATH (run by the installer)\n  \
           {name} update <command>     the updater (check, status, apply, list, rollback, hold, channel, log)\n  \
           {name} --core-help          this text\n\
         \n\
         Update commands:\n{update}\n",
        line = info.line(),
        name = build::NAME,
        update = crate::update_cmd::HELP,
    )
}

fn version(rest: &[String]) -> Outcome {
    let info = build::current();
    match rest {
        [] => ok(format!("{}\n", info.line())),
        [flag] if flag == "--json" => ok(format!("{}\n", info.json())),
        [other, ..] => usage_error(&format!("unexpected argument `{other}` after --version")),
    }
}

/// What `daemon` was asked to do, before anything is started.
#[derive(Debug, PartialEq, Eq)]
pub struct DaemonArgs {
    pub name: String,
    pub data_root: Option<String>,
    pub node: Option<String>,
    pub spec_on_stdin: bool,
}

/// `daemon <name> [--data-root <dir>] [--node <path>] [--spec -]`, as the Node supervisor spawns it.
pub fn parse_daemon(rest: &[String]) -> Result<DaemonArgs, Outcome> {
    let Some((name, flags)) = rest.split_first() else {
        return Err(usage_error("daemon needs the server name: daemon <name>"));
    };
    if name.starts_with('-') {
        return Err(usage_error(&format!("`{name}` is not a server name")));
    }
    let mut out = DaemonArgs {
        name: name.clone(),
        data_root: None,
        node: None,
        spec_on_stdin: false,
    };
    let mut it = flags.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| usage_error(&format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--data-root" => out.data_root = Some(value()?),
            "--node" => out.node = Some(value()?),
            "--spec" => {
                let v = value()?;
                if v != "-" {
                    return Err(usage_error("--spec only reads stdin: --spec -"));
                }
                out.spec_on_stdin = true;
            }
            other => {
                return Err(usage_error(&format!(
                    "unexpected argument `{other}` after the server name"
                )));
            }
        }
    }
    Ok(out)
}

/// Runs the daemon; returns only when it could not start (the daemon ends the process itself).
fn daemon(rest: &[String]) -> Outcome {
    let args = match parse_daemon(rest) {
        Ok(a) => a,
        Err(outcome) => return outcome,
    };
    let spec = if args.spec_on_stdin {
        use std::io::Read;
        let mut text = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut text) {
            return usage_error(&format!("could not read the launch spec from stdin: {e}"));
        }
        match spawnloft_lib::serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => return usage_error(&format!("the launch spec on stdin is not JSON: {e}")),
        }
    } else {
        None
    };
    let code = spawnloft_lib::daemon::run(spawnloft_lib::daemon::Options {
        name: args.name,
        data_root: args.data_root.map(Into::into),
        node: args.node.map(Into::into),
        spec,
    });
    Outcome {
        stdout: String::new(),
        stderr: String::new(),
        code: u8::try_from(code).unwrap_or(1),
    }
}

/// `ui [--port <n>] [--core-dir <dir>] [--node <path>] [--upstream <url>] [--exit-with-stdin]`.
pub fn parse_ui(rest: &[String]) -> Result<spawnloft_lib::panel::Options, Outcome> {
    let mut out = spawnloft_lib::panel::Options::default();
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| usage_error(&format!("{flag} needs a value")))
        };
        match flag.as_str() {
            "--port" => {
                let v = value()?;
                out.port = v
                    .parse()
                    .map_err(|_| usage_error(&format!("`{v}` is not a port")))?;
            }
            "--core-dir" => out.core_dir = Some(value()?.into()),
            "--node" => out.node = Some(value()?.into()),
            "--upstream" => out.upstream = Some(value()?),
            "--exit-with-stdin" => out.exit_with_stdin = true,
            // what `spawnloft ui` takes today; this binary never opens a browser itself
            "--no-open" => {}
            other => return Err(usage_error(&format!("unexpected argument `{other}`"))),
        }
    }
    Ok(out)
}

fn ui(rest: &[String]) -> Outcome {
    match parse_ui(rest) {
        Ok(opts) => Outcome {
            code: u8::try_from(spawnloft_lib::panel::run(opts)).unwrap_or(1),
            ..Outcome::default()
        },
        Err(outcome) => outcome,
    }
}

/// `probe-process <pid>`: what this binary sees of a process (installer tests, the image-name
/// probe of design section 4). Not in `help`: a diagnostic, not a command people need.
fn probe_process(rest: &[String]) -> Outcome {
    let [pid] = rest else {
        return usage_error("probe-process needs one pid");
    };
    let Ok(pid) = pid.parse::<u32>() else {
        return usage_error(&format!("`{pid}` is not a pid"));
    };
    use spawnloft_lib::procid;
    let out = spawnloft_lib::serde_json::json!({
        "pid": pid,
        "alive": procid::alive(pid),
        "startTime": procid::start_time(pid).map(|t| t.to_string()),
        "image": procid::image(pid),
    });
    ok(format!("{out}\n"))
}

pub fn run(args: &[String]) -> Outcome {
    let Some((command, rest)) = args.split_first() else {
        return Outcome {
            stdout: help(),
            stderr: String::new(),
            code: EXIT_USAGE,
        };
    };
    match command.as_str() {
        "--version" | "-V" | "version" => version(rest),
        "--core-help" => ok(help()),
        "daemon" => daemon(rest),
        "ui" => ui(rest),
        "probe-process" => probe_process(rest),
        "handover" => crate::handover_cmd::handover(rest),
        "repair" => crate::handover_cmd::repair(rest),
        "uninstall" => crate::handover_cmd::uninstall(rest),
        "update" => crate::update_cmd::run(rest),
        "user-path" => crate::handover_cmd::user_path(rest),
        other => usage_error(&format!("unknown command `{other}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_prints_one_line() {
        let out = run(&args(&["--version"]));
        assert_eq!(out.code, 0);
        assert!(out.stdout.starts_with("spawnloft-core "));
        assert_eq!(out.stdout.lines().count(), 1);
        assert_eq!(run(&args(&["-V"])), out);
        assert_eq!(run(&args(&["version"])), out);
    }

    #[test]
    fn version_json() {
        let out = run(&args(&["--version", "--json"]));
        assert_eq!(out.code, 0);
        assert!(out.stdout.starts_with("{\"name\":\"spawnloft-core\""));
    }

    #[test]
    fn version_rejects_extra_arguments() {
        assert_eq!(run(&args(&["--version", "--yaml"])).code, EXIT_USAGE);
    }

    #[test]
    fn daemon_arguments() {
        let a = parse_daemon(&args(&[
            "survival",
            "--data-root",
            "/d",
            "--node",
            "/n",
            "--spec",
            "-",
        ]))
        .unwrap();
        assert_eq!(
            a,
            DaemonArgs {
                name: "survival".into(),
                data_root: Some("/d".into()),
                node: Some("/n".into()),
                spec_on_stdin: true
            }
        );
        assert_eq!(parse_daemon(&args(&["survival"])).unwrap().data_root, None);
        assert_eq!(
            parse_daemon(&args(&["s", "--spec", "file.json"]))
                .unwrap_err()
                .code,
            EXIT_USAGE
        );
        assert_eq!(
            parse_daemon(&args(&["s", "--node"])).unwrap_err().code,
            EXIT_USAGE
        );
    }

    #[test]
    fn ui_arguments() {
        let o = parse_ui(&args(&["--port", "0", "--core-dir", "/c", "--exit-with-stdin"])).unwrap();
        assert_eq!(o.port, 0);
        assert_eq!(o.core_dir, Some("/c".into()));
        assert!(o.exit_with_stdin);
        assert_eq!(parse_ui(&args(&["--port", "x"])).unwrap_err().code, EXIT_USAGE);
        assert_eq!(parse_ui(&args(&["--bogus"])).unwrap_err().code, EXIT_USAGE);
    }

    #[test]
    fn no_arguments_prints_help_as_a_usage_error() {
        let out = run(&[]);
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stdout.contains("Usage:"));
    }

    #[test]
    fn core_help_has_no_internal_wording() {
        let out = run(&args(&["--core-help"]));
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("Usage:"));
        // past the version line, which carries a dev build's `-internal.0`
        let lower = out.stdout.split_once('\n').unwrap().1.to_ascii_lowercase();
        assert!(
            !lower.contains("internal") && !lower.contains("spike"),
            "{}",
            out.stdout
        );
    }

    #[test]
    fn unknown_command() {
        let out = run(&args(&["frobnicate"]));
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("unknown command `frobnicate`"));
    }

    fn os(list: &[&str]) -> Vec<std::ffi::OsString> {
        list.iter().map(|s| s.into()).collect()
    }

    #[test]
    fn the_impl_switch_forwards_ported_commands_only() {
        let ported = [Row {
            names: &["list", "ls"],
            when: When::Always,
        }];
        // ported: answered here, unless the switch asks for the Node core
        assert!(!forwards_with(&os(&["list", "--json"]), false, &ported));
        assert!(!forwards_with(&os(&["ls"]), false, &ported));
        assert!(forwards_with(&os(&["list", "--json"]), true, &ported));
        // not ported: the Node core either way
        assert!(forwards_with(&os(&["start", "s"]), false, &ported));
        assert!(forwards_with(&os(&["start", "s"]), true, &ported));
        // the core's own commands never move, switch or not
        for line in [
            &["--version"][..],
            &["daemon", "s"],
            &["repair", "--quiet"],
            &["update", "check"],
        ] {
            assert!(!forwards_with(&os(line), true, &ported), "{line:?}");
        }
    }

    #[test]
    fn c1_commands_are_answered_here_unless_the_switch_says_node() {
        for line in [
            &[][..],
            &["help"],
            &["--help"],
            &["-h"],
            &["list", "--json"],
            &["ls"],
            &["status", "alpha"],
            &["logs", "alpha", "-f"],
            &["log", "alpha"],
            &["why", "alpha"],
            &["diagnostics", "alpha", "--json"],
            &["metrics", "alpha", "--csv"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
            let strings: Vec<String> = line.iter().map(|s| s.to_string()).collect();
            assert!(is_ported(&strings), "{line:?}");
        }
        assert!(!is_ported(&["--version".to_string()]));
        assert!(!is_ported(&["plugins".to_string()]));
    }

    #[test]
    fn new_is_answered_here_unless_it_fetches_a_jar_or_a_modpack() {
        for line in [
            &["new", "a", "--jar", "x.jar"][..],
            &["new", "a", "--template", "t"],
            &["new", "a", "--from", "b", "--with-worlds"],
            &["new", "a", "--modpack="],
            &["new", "a", "--no-paper", "--jar", "x.jar"],
            &["new", "a", "--", "--paper", "1.21"],
            &["clone", "a", "b"],
            &["adopt", "a", "/x"],
            &["templates"],
            &["template", "save", "a", "t"],
            &["jars", "import", "x"],
            &["launchers"],
            &["reveal", "a"],
            &["open", "a"],
            &["rebuild", "a", "--yes"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
        }
        for line in [
            &["new", "a", "--modpack", "pack.mrpack"][..],
            &["new", "a", "--modpack=x"],
            &["new", "a", "--paper", "1.21.4"],
            &["new", "a", "--paper"],
            &["new", "a", "--neoforge=21.1"],
            &["new", "a", "--fabric", "1.21", "--jar", "x.jar"],
            &["new", "a", "--spigot", "1.21"],
        ] {
            assert!(
                forwards_with(&os(line), false, PORTED),
                "{line:?} stays with Node"
            );
        }
    }

    #[test]
    fn no_command_is_both_the_cores_own_and_ported() {
        for row in PORTED {
            for name in row.names {
                assert!(
                    !CORE_OWN.iter().any(|own| own.names.contains(name)),
                    "{name} is in both tables"
                );
            }
        }
    }

    #[test]
    fn what_is_forwarded_to_the_node_core() {
        for line in [
            &["mcp"][..],
            &["task", "run", "abc"],
            &["plugins", "survival"],
            &["ui"],
            &["ui", "--port", "8080"],
            &["repair"],
            &["repair", "--json"],
            &["uninstall"],
            &["uninstall", "--data"],
            &["frobnicate"],
        ] {
            assert!(
                forwards_with(&os(line), false, PORTED),
                "{line:?} should be forwarded"
            );
        }
        for line in [
            &["--version"][..],
            &["-V"],
            &["version", "--json"],
            &["--core-help"],
            &["daemon", "s"],
            &["probe-process", "1"],
            &["handover", "stop"],
            &["uninstall", "--yes"],
            &["update", "check"],
            &["ui", "--port", "0", "--exit-with-stdin", "--core-dir", "/c"],
            &["ui", "--upstream", "http://127.0.0.1:1/"],
            &["repair", "--quiet"],
            &["user-path", "add"],
            &["start", "survival"],
            &["console", "survival"],
            &["db", "list"],
            &["backup", "survival", "--json"],
            &["snapshot", "survival"],
            &["snapshots", "survival"],
            &["backups", "survival", "--json"],
            &["restore", "survival", "latest", "--yes"],
            &["prune", "survival"],
            &["verify", "survival", "--all"],
            &["config", "show"],
            &["worlds", "survival", "list"],
        ] {
            assert!(
                !forwards_with(&os(line), false, PORTED),
                "{line:?} is this binary's own"
            );
        }
    }
}
