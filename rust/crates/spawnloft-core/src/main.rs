//! `spawnloft-core`: the console binary. A console-subsystem program on Windows on purpose, so it
//! works in a terminal and over pipes (MCP); the window is a separate binary. It is the only
//! entry point of an install: commands it does not own go to the Node core (`cli::forwards`).

use std::io::Write;
use std::process::ExitCode;

mod cli;
mod handover_cmd;
mod update_cmd;

fn main() -> ExitCode {
    let raw: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // the SpawnLoft CLI (list, start, mcp, task run, ...) runs on the Node core until 2.1; its
    // arguments pass through as they came
    if cli::forwards(&raw) {
        return ExitCode::from(spawnloft_lib::runtime::forward(&raw));
    }
    // args_os: an argument that is not valid UTF-8 is a usage error, not a panic (and with
    // panic = "abort", not a crash)
    let args: Option<Vec<String>> = raw.into_iter().map(|a| a.into_string().ok()).collect();
    let outcome = match args {
        Some(args) => cli::run(&args),
        None => cli::not_utf8(),
    };
    // a closed stdout (`spawnloft-core --version | head -c1`) is not worth a panic
    let _ = std::io::stdout().write_all(outcome.stdout.as_bytes());
    let _ = std::io::stderr().write_all(outcome.stderr.as_bytes());
    ExitCode::from(outcome.code)
}
