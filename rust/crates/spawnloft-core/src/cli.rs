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
}

/// One row of the ownership table: a command, its aliases, and when this binary answers it.
#[derive(Debug, Clone, Copy)]
pub struct Row {
    pub names: &'static [&'static str],
    pub when: When,
}

/// This binary's own commands, which the Node core has no twin for. They are answered here whatever
/// `SPAWNLOFT_CORE_IMPL` says. `repair` and `uninstall`, the installer's and uninstaller's
/// commands, moved to [`PORTED`] in C6; their installer forms stay native
/// through [`INSTALLER_FORMS`].
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
];

/// The window's form of `ui`, which the desktop shell starts: answered by [`run`] rather than as
/// the ported command, whatever `SPAWNLOFT_CORE_IMPL` says. It keeps its own exit codes, signs
/// nobody in, and still listens when the data cannot be found, so that the window can say why
/// and the updater still answers.
pub const WINDOW_FORMS: &[Row] = &[Row {
    names: &["ui"],
    when: When::AnyFlag(&["--exit-with-stdin"]),
}];

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
    // C4: making servers and fetching their software (`new --modpack` came with C5)
    Row {
        names: &["new"],
        when: When::Always,
    },
    Row {
        names: &["paper"],
        when: When::Always,
    },
    Row {
        names: &["upgrade"],
        when: When::Always,
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
    // C5: plugins and modpacks
    Row {
        names: &["plugins"],
        when: When::Always,
    },
    Row {
        names: &["pack"],
        when: When::Always,
    },
    // C6: scheduled tasks, and what moves or drops a server with its tasks
    Row {
        names: &["task"],
        when: When::Always,
    },
    Row {
        names: &["rm", "remove"],
        when: When::Always,
    },
    Row {
        names: &["rename"],
        when: When::Always,
    },
    Row {
        names: &["repair"],
        when: When::Always,
    },
    Row {
        names: &["uninstall"],
        when: When::Always,
    },
    Row {
        names: &["data"],
        when: When::Always,
    },
    // C7: the client launcher
    Row {
        names: &["client"],
        when: When::Always,
    },
    // C6b: the diagnostics, once both tracks have met
    Row {
        names: &["doctor"],
        when: When::Always,
    },
    Row {
        names: &["diag"],
        when: When::Always,
    },
    // C8: the panel, from a terminal (the window's form is this binary's own, above)
    Row {
        names: &["ui", "panel"],
        when: When::Always,
    },
    // C9: the bot harness (the Mineflayer host it drives stays JavaScript)
    Row {
        names: &["bot"],
        when: When::Always,
    },
    // C9: the MCP server an AI client launches
    Row {
        names: &["mcp"],
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
                && !WINDOW_FORMS.iter().any(|r| row_matches(r, command, &rest))
                && PORTED.iter().any(|r| row_matches(r, command, &rest))
        }
    }
}

/// The installer's and uninstaller's forms of ported commands: answered here even when
/// `SPAWNLOFT_CORE_IMPL=node`, since Node's `repair` has no `--quiet`, the installer ignores the
/// exit code, and with no usable Node nothing at all would be done.
pub const INSTALLER_FORMS: &[Row] = &[
    Row {
        names: &["repair"],
        when: When::AnyFlag(&["--quiet"]),
    },
    Row {
        names: &["uninstall"],
        when: When::AnyFlag(&["--yes"]),
    },
];

/// [`forwards`] with the switch and the ported table given, for tests.
pub fn forwards_with(args: &[std::ffi::OsString], force_node: bool, ported: &[Row]) -> bool {
    let Some((command, rest)) = args.split_first() else {
        // no arguments: the CLI's own usage, which moves with `help`
        return force_node || !ported.iter().any(|r| r.names.contains(&"help"));
    };
    let Some(command) = command.to_str() else {
        return true;
    };
    if CORE_OWN.iter().any(|r| row_matches(r, command, rest))
        || INSTALLER_FORMS.iter().any(|r| row_matches(r, command, rest))
        || WINDOW_FORMS.iter().any(|r| row_matches(r, command, rest))
    {
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
           {name} ui --exit-with-stdin [--port n]  the window's panel on 127.0.0.1\n  \
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

/// `ui --exit-with-stdin [--port <n>]`: the window's form. `--core-dir` and `--node` named the
/// Node core while it answered part of the panel; a window that still passes them is not refused.
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
            "--core-dir" | "--node" => {
                value()?;
            }
            "--exit-with-stdin" => out.exit_with_stdin = true,
            // this form never opens a browser itself
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
        for line in [&["--version"][..], &["daemon", "s"], &["update", "check"]] {
            assert!(!forwards_with(&os(line), true, &ported), "{line:?}");
        }
        // the installer's forms of ported commands stay here under the switch; the rest goes
        for line in [&["repair", "--quiet"][..], &["uninstall", "--yes", "--data"]] {
            assert!(!forwards_with(&os(line), true, PORTED), "{line:?}");
        }
        assert!(forwards_with(&os(&["repair", "--json"]), true, PORTED));
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
        assert!(is_ported(&["mcp".to_string()]));
    }

    #[test]
    fn new_is_answered_here_with_or_without_a_modpack() {
        for line in [
            &["new", "a", "--jar", "x.jar"][..],
            &["new", "a", "--template", "t"],
            &["new", "a", "--from", "b", "--with-worlds"],
            &["new", "a", "--modpack="],
            &["new", "a", "--no-paper", "--jar", "x.jar"],
            &["new", "a", "--", "--paper", "1.21"],
            &["new", "a", "--paper", "1.21.4"],
            &["new", "a", "--paper"],
            &["new", "a", "--neoforge=21.1"],
            &["new", "a", "--fabric", "1.21", "--jar", "x.jar"],
            &["new", "a", "--spigot", "1.21"],
            &["new", "a", "--no-modpack", "--paper", "1.21"],
            &["paper", "fetch", "1.21.4"],
            &["upgrade", "a", "--check"],
            &["clone", "a", "b"],
            &["adopt", "a", "/x"],
            &["templates"],
            &["template", "save", "a", "t"],
            &["jars", "import", "x"],
            &["launchers"],
            &["reveal", "a"],
            &["open", "a"],
            &["rebuild", "a", "--yes"],
            &["new", "a", "--modpack", "pack.mrpack"],
            &["new", "a", "--modpack=x"],
            &["new", "a", "--paper", "1.21", "--modpack", "x"],
            &["pack", "a", "update", "--yes"],
            &["plugins", "a"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
        }
    }

    #[test]
    fn client_is_ported_whole() {
        for line in [
            &["client", "list"][..],
            &["client", "list", "--json"],
            &["client", "status", "p"],
            &["client", "logs", "p", "-n", "5"],
            &["client", "--json", "accounts"],
            &["client", "logout", "Steve"],
            &["client", "remove", "p", "--purge"],
            &["client", "stop", "p"],
            &["client", "new", "p", "--mc", "1.21.11"],
            &["client", "set", "p", "memory=4G"],
            &["client", "versions", "--all"],
            &["client", "login", "--json"],
            &["client", "install", "p", "--verify"],
            &["client", "launch", "p", "--wait"],
            &["client"],
            &["client", "doctor"],
            &["client", "--json"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
        }
    }

    #[test]
    fn doctor_and_diag_are_ported() {
        for line in [
            &["doctor"][..],
            &["doctor", "--json"],
            &["diag", "alpha"],
            &["diag", "--client", "p", "--json"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
        }
    }

    #[test]
    fn bot_and_mcp_are_ported() {
        for line in [
            &["bot"][..],
            &["bot", "check"],
            &["bot", "check", "alpha", "--json"],
            &["bot", "setup", "--force"],
            &["bot", "run", "s.json", "--instance", "alpha"],
            &["mcp"],
            &["mcp", "--allow-destructive", "--show-ips"],
        ] {
            assert!(!forwards_with(&os(line), false, PORTED), "{line:?} is ported");
            assert!(forwards_with(&os(line), true, PORTED), "{line:?} with the switch");
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
        for line in [&["frobnicate"][..], &["frobnicate", "--json"]] {
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
            &["ui"],
            &["panel", "--port", "8080", "--no-open"],
            &["ui", "--port", "0", "--exit-with-stdin", "--core-dir", "/c"],
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
            &["task", "run", "abc"],
            &["rm", "survival"],
            &["rename", "a", "b"],
            &["repair"],
            &["repair", "--json"],
            &["uninstall"],
            &["uninstall", "--data"],
            &["data", "status"],
        ] {
            assert!(
                !forwards_with(&os(line), false, PORTED),
                "{line:?} is this binary's own"
            );
        }
    }
}
