//! `entry.mjs`: how anything written to disk runs this command line again (task shims, server
//! launchers, the launchd and systemd units, `runtime.json`, the MCP config the panel shows).
//! In a 2.0 install that is `spawnloft-core`, the install's one entry point: the Node core it
//! forwards to is told the binary's path in `SPAWNLOFT_ENTRY`. A command answered here names the
//! same binary, the one running.

pub const ENTRY_ENV: &str = "SPAWNLOFT_ENTRY";

/// `entryBinary`: `SPAWNLOFT_ENTRY` when it names an absolute path to a file.
pub fn entry_binary(value: Option<&str>) -> Option<String> {
    let entry = value.filter(|v| !v.is_empty())?;
    if !crate::jspath::is_absolute(entry) {
        return None;
    }
    std::fs::metadata(entry)
        .ok()?
        .is_file()
        .then(|| entry.to_string())
}

/// `{ exe, args, env, viaEntry }`: run `exe ...args <command...>` with `env` added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cli {
    pub exe: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub via_entry: bool,
}

/// `cliCommand`: the entry binary named by the environment, else this executable. Either way it
/// is the entry point itself, with no script argument and nothing added to the environment.
pub fn cli_command(entry_env: Option<&str>) -> Cli {
    let exe = entry_binary(entry_env).unwrap_or_else(|| {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| crate::build::NAME.into())
    });
    Cli {
        exe,
        args: Vec::new(),
        env: Vec::new(),
        via_entry: true,
    }
}

/// `windowsRun`: the lines of a `.cmd` that run `<cli> <rest>`: any environment the runner needs,
/// then the command. `%` is doubled (a single one starts a variable in a batch file, so a folder
/// named `100%` would break the line). A plain Node checkout keeps the bare `node`.
pub fn windows_run(cli: &Cli, rest: &str) -> Vec<String> {
    let batch = |t: &str| t.replace('%', "%%");
    let lower = cli.exe.to_lowercase();
    let node = ["/node", "\\node", "/node.exe", "\\node.exe"]
        .iter()
        .any(|end| lower.ends_with(end));
    let runner = if !cli.via_entry && node {
        "node".to_string()
    } else {
        format!("\"{}\"", batch(&cli.exe))
    };
    let mut lines: Vec<String> = cli
        .env
        .iter()
        .map(|(k, v)| format!("set {k}={}", batch(v)))
        .collect();
    let mut command = vec![runner];
    command.extend(cli.args.iter().map(|a| format!("\"{}\"", batch(a))));
    command.push(rest.to_string());
    lines.push(command.join(" "));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_lines() {
        let entry = Cli {
            exe: r"C:\Program Files\SpawnLoft 100%\spawnloft-core.exe".into(),
            args: vec![],
            env: vec![],
            via_entry: true,
        };
        assert_eq!(
            windows_run(&entry, "start smp"),
            [r#""C:\Program Files\SpawnLoft 100%%\spawnloft-core.exe" start smp"#]
        );
        let checkout = Cli {
            exe: r"C:\nodejs\node.exe".into(),
            args: vec![r"C:\src\mcctl.mjs".into()],
            env: vec![("ELECTRON_RUN_AS_NODE".into(), "1".into())],
            via_entry: false,
        };
        assert_eq!(
            windows_run(&checkout, "start smp"),
            [
                "set ELECTRON_RUN_AS_NODE=1",
                r#"node "C:\src\mcctl.mjs" start smp"#
            ]
        );
        // a runner merely named like node, with no folder, is quoted
        let bare = Cli {
            exe: "node.exe".into(),
            ..checkout.clone()
        };
        assert_eq!(windows_run(&bare, "x")[1], r#""node.exe" "C:\src\mcctl.mjs" x"#);
    }

    #[test]
    fn entry_needs_an_absolute_file() {
        let here = std::env::current_exe().unwrap();
        let here = here.to_string_lossy();
        assert_eq!(entry_binary(Some(&here)).as_deref(), Some(&*here));
        assert_eq!(entry_binary(Some("spawnloft-core")), None);
        assert_eq!(entry_binary(Some("")), None);
        assert_eq!(entry_binary(None), None);
        let dir = std::env::temp_dir();
        assert_eq!(entry_binary(Some(&dir.to_string_lossy())), None);
        assert!(cli_command(None).via_entry);
    }
}
