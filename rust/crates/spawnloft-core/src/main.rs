//! `spawnloft-core`: the console binary. A console-subsystem program on Windows on purpose, so it
//! works in a terminal and over pipes (MCP); the window is a separate binary.

use std::io::Write;
use std::process::ExitCode;

mod cli;
mod handover_cmd;
mod update_cmd;

fn main() -> ExitCode {
    // args_os: an argument that is not valid UTF-8 is a usage error, not a panic (and with
    // panic = "abort", not a crash)
    let args: Option<Vec<String>> = std::env::args_os()
        .skip(1)
        .map(|a| a.into_string().ok())
        .collect();
    let outcome = match args {
        Some(args) => cli::run(&args),
        None => cli::not_utf8(),
    };
    // a closed stdout (`spawnloft-core --version | head -c1`) is not worth a panic
    let _ = std::io::stdout().write_all(outcome.stdout.as_bytes());
    let _ = std::io::stderr().write_all(outcome.stderr.as_bytes());
    ExitCode::from(outcome.code)
}
