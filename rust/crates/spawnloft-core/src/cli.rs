//! Argument handling. Hand-written while there are three commands; `clap` replaces it when the
//! command table grows (R6).

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

fn usage_error(message: &str) -> Outcome {
    Outcome {
        stdout: String::new(),
        stderr: format!(
            "{}: {message}\nRun `{} help` for the commands.\n",
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

pub fn help() -> String {
    let info = build::current();
    format!(
        "{line}\n\
         \n\
         Internal build: not for release.\n\
         \n\
         Usage:\n  \
           {name} --version [--json]   print this build's version, commit and target\n  \
           {name} daemon <name>        supervise one server (spawned by the supervisor)\n  \
           {name} help                 this text\n",
        line = info.line(),
        name = build::NAME,
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
        "help" | "--help" | "-h" => ok(help()),
        "daemon" => daemon(rest),
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
    fn no_arguments_prints_help_as_a_usage_error() {
        let out = run(&[]);
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stdout.contains("Usage:"));
    }

    #[test]
    fn unknown_command() {
        let out = run(&args(&["frobnicate"]));
        assert_eq!(out.code, EXIT_USAGE);
        assert!(out.stderr.contains("unknown command `frobnicate`"));
    }
}
