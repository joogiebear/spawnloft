//! Argument handling, by hand: the port parses flags the way `src/args.mjs` does, because flag
//! handling is part of the CLI's contract (rust/PLAN-CORE-PORT.md rule 8).
//!
//! `spawnloft-core` is the one entry point of an install (PLAN-2.0-REMAINING.md section 4): the
//! commands below are its own, and every other command line is the SpawnLoft CLI, answered by
//! `crate::port` as `mcctl.mjs` answered it before the Node core left (rust/PLAN-CORE-PORT.md,
//! C10). The `spawnloft` and `mcctl` launchers, task shims, server launchers and MCP configs all
//! run this binary.

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

/// This binary's own commands, which the SpawnLoft CLI never had.
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
/// the CLI's `ui`. It keeps its own exit codes, signs
/// nobody in, and still listens when the data cannot be found, so that the window can say why
/// and the updater still answers.
pub const WINDOW_FORMS: &[Row] = &[Row {
    names: &["ui"],
    when: When::AnyFlag(&["--exit-with-stdin"]),
}];

fn row_matches(row: &Row, command: &str, rest: &[String]) -> bool {
    row.names.contains(&command)
        && match row.when {
            When::Always => true,
            When::AnyFlag(flags) => flags.iter().any(|f| rest.iter().any(|a| a == f)),
        }
}

/// Whether a command line is the SpawnLoft CLI's (`crate::port`, which also answers an unknown
/// command and no command at all) rather than one of this binary's own.
pub fn is_cli(args: &[String]) -> bool {
    match args.split_first() {
        None => true,
        Some((command, rest)) => {
            !CORE_OWN.iter().any(|r| row_matches(r, command, rest))
                && !WINDOW_FORMS.iter().any(|r| row_matches(r, command, rest))
        }
    }
}

/// Whether `arg` is the Node entry script a 1.x shim or MCP config still names before the command
/// (`.../mcctl.mjs list`): dropped, never run (plan section 5.2).
pub fn is_old_entry(arg: &std::ffi::OsStr) -> bool {
    let name = std::path::Path::new(arg)
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // a Windows path seen on another system still counts
    let name = name.rsplit('\\').next().unwrap_or_default();
    name == "mcctl.mjs" || name == "spawnloft.mjs"
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
    // `handover --help`, `daemon -h`...: this binary's help, never the command (`update` has its own)
    if matches!(
        command.as_str(),
        "daemon" | "ui" | "probe-process" | "handover" | "user-path"
    ) && rest.iter().any(|a| a == "--help" || a == "-h")
    {
        return ok(help());
    }
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
    fn the_library_knows_the_cores_own_commands() {
        let mut own: Vec<&str> = CORE_OWN.iter().flat_map(|r| r.names.iter().copied()).collect();
        let mut lib = spawnloft_lib::commands::CORE_COMMANDS.to_vec();
        own.sort_unstable();
        lib.sort_unstable();
        assert_eq!(own, lib, "spawnloft_lib::commands::CORE_COMMANDS is out of date");
    }

    #[test]
    fn the_cores_own_commands_answer_help() {
        for line in [
            &["daemon", "--help"][..],
            &["daemon", "survival", "-h"],
            &["probe-process", "--help"],
            &["handover", "--help"],
            &["user-path", "-h"],
            &["ui", "--exit-with-stdin", "--help"],
        ] {
            let out = run(&args(line));
            assert_eq!(out.code, 0, "{line:?}: {}", out.stderr);
            assert!(out.stdout.contains("Usage:"), "{line:?}");
        }
        let out = run(&args(&["update", "--help"]));
        assert_eq!(out.code, 0);
        assert!(out.stdout.contains("update check"));
    }

    #[test]
    fn unknown_command() {
        let out = run(&args(&["frobnicate"]));
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("unknown command `frobnicate`"));
    }

    #[test]
    fn the_cores_own_commands_and_the_cli() {
        for line in [
            &["--version"][..],
            &["-V"],
            &["daemon", "s"],
            &["update", "check"],
            &["handover", "stop"],
            &["user-path", "add"],
            &["probe-process", "1"],
            &["--core-help"],
            &["ui", "--exit-with-stdin"],
        ] {
            assert!(!is_cli(&args(line)), "{line:?}");
        }
        for line in [
            &[][..],
            &["help"],
            &["list", "--json"],
            &["ui"],
            &["ui", "--port", "8080"],
            &["repair", "--quiet"],
            &["uninstall", "--yes"],
            &["mcp"],
            &["frobnicate"],
        ] {
            assert!(is_cli(&args(line)), "{line:?}");
        }
    }

    #[test]
    fn the_old_entry_script_is_recognised() {
        for arg in [
            "/opt/spawnloft-cli/core/mcctl.mjs",
            "C:\\Program Files\\SpawnLoft\\resources\\core\\mcctl.mjs",
            "spawnloft.mjs",
            "MCCTL.MJS",
        ] {
            assert!(is_old_entry(std::ffi::OsStr::new(arg)), "{arg}");
        }
        for arg in ["list", "mcctl", "mcctl.mjs.bak", "/x/other.mjs", ""] {
            assert!(!is_old_entry(std::ffi::OsStr::new(arg)), "{arg}");
        }
    }
}
