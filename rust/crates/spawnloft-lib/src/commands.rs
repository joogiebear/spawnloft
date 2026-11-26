//! The names a command line can start with: the SpawnLoft CLI's commands (mcctl.mjs `COMMANDS`,
//! answered by `spawnloft-core`'s port) and `spawnloft-core`'s own. Here rather than in the core
//! so that the window (`SpawnLoft.exe update --help`) knows a command line it should hand to the
//! core instead of opening a window.

/// Every name `COMMANDS` in mcctl.mjs answers.
pub const CLI_COMMANDS: &[&str] = &[
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

/// `spawnloft-core`'s own commands, which the CLI never had (`cli::CORE_OWN` there).
pub const CORE_COMMANDS: &[&str] = &[
    "--version",
    "-V",
    "version",
    "--core-help",
    "daemon",
    "probe-process",
    "handover",
    "update",
    "user-path",
];

/// Whether `first` (the first argument) starts a command line for the core: a CLI command, one of
/// the core's own, or a request for help (`--help`, `-h`).
pub fn is_command(first: &str) -> bool {
    first == "--help" || first == "-h" || CLI_COMMANDS.contains(&first) || CORE_COMMANDS.contains(&first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_and_what_is_not_one() {
        for c in ["update", "list", "help", "--help", "-h", "--version", "mcp", "ui"] {
            assert!(is_command(c), "{c}");
        }
        // what an installer, macOS or a 1.x relaunch may hand the window
        for c in [
            "",
            "/ARGS",
            "/ROLLBACK",
            "-psn_0_12345",
            "--updated",
            "--no-sandbox",
            "Update",
            "C:\\x",
        ] {
            assert!(!is_command(c), "{c}");
        }
    }
}
