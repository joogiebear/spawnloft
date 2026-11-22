//! `spawnloft-core`: the console binary. A console-subsystem program on Windows on purpose, so it
//! works in a terminal and over pipes (MCP); the window is a separate binary. It is the only
//! entry point of an install: its own commands (`cli`) and the SpawnLoft CLI (`port`).

use std::io::Write;
use std::process::ExitCode;

mod cli;
mod handover_cmd;
mod port;
mod update_cmd;

fn main() -> ExitCode {
    let mut raw: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // a 1.x shim or MCP config names the Node entry script first: drop it, never run it
    if raw.first().is_some_and(|a| cli::is_old_entry(a)) {
        raw.remove(0);
    }
    // args_os: an argument that is not valid UTF-8 is a usage error, not a panic (and with
    // panic = "abort", not a crash)
    // The ported commands read their arguments as Node does, with each invalid byte sequence
    // (an unpaired UTF-16 half on Windows) as U+FFFD.
    let lossy: Vec<String> = raw.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    if cli::is_cli(&lossy) {
        let mut out = port::Out::stdio();
        return ExitCode::from(port::run(&lossy, &mut out));
    }
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
