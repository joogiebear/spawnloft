//! `spawnloft-core`: the console binary. A console-subsystem program on Windows on purpose, so it
//! works in a terminal and over pipes (MCP); the window is a separate binary.

use std::io::Write;
use std::process::ExitCode;

mod cli;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = cli::run(&args);
    // a closed stdout (`spawnloft-core --version | head -c1`) is not worth a panic
    let _ = std::io::stdout().write_all(outcome.stdout.as_bytes());
    let _ = std::io::stderr().write_all(outcome.stderr.as_bytes());
    ExitCode::from(outcome.code)
}
