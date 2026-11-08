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
/// Exit code for a command that exists but is not built yet in this internal build.
pub const EXIT_NOT_BUILT: u8 = 69;

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
           {name} daemon <name>        supervise one server (not built yet: the Rust daemon is P0-D)\n  \
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

/// The Node supervisor spawns `<binary> daemon <name>`. Until P0-D lands this refuses clearly, with
/// its own exit code, so a supervisor that is pointed here by mistake fails loudly, not silently.
fn daemon(rest: &[String]) -> Outcome {
    match rest {
        [] => usage_error("daemon needs the server name: daemon <name>"),
        [name] if name.starts_with('-') => usage_error(&format!("`{name}` is not a server name")),
        [name] => Outcome {
            stdout: String::new(),
            stderr: format!(
                "{}: the Rust daemon is not built yet, so `{name}` was not started.\n\
                 This internal build only carries the binary; servers still run on the Node daemon \
                 (SPAWNLOFT_DAEMON=node, the default).\n",
                build::NAME
            ),
            code: EXIT_NOT_BUILT,
        },
        [_, extra, ..] => usage_error(&format!("unexpected argument `{extra}` after the server name")),
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
    fn daemon_stub_refuses_with_its_own_code() {
        let out = run(&args(&["daemon", "survival"]));
        assert_eq!(out.code, EXIT_NOT_BUILT);
        assert!(out.stderr.contains("`survival` was not started"));
        assert!(out.stdout.is_empty());
    }

    #[test]
    fn daemon_needs_exactly_one_name() {
        assert_eq!(run(&args(&["daemon"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["daemon", "--force"])).code, EXIT_USAGE);
        assert_eq!(run(&args(&["daemon", "a", "b"])).code, EXIT_USAGE);
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
