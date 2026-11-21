//! Takes and probes the cross-process lock from a Rust process, so test/lock-cross-process.test.mjs
//! can hold it against Node in both directions. Test-only; never shipped.
//!
//!   lock-probe hold <lockfile> <ms>      wait for the lock, print `held <pid>`, keep it <ms>,
//!                                        release, print `released`
//!   lock-probe try <lockfile>            one try in fail mode: `got` (released at once) or
//!                                        `busy <lockHolder>` (a pid, -1, or null)
//!   lock-probe holder <lockfile>         lockHolder's answer: a pid, -1, or `free`
//!   lock-probe count <lockfile> <counterfile> <n>
//!                                        n times under the lock: read the integer, write it + 1

use std::io::Write;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use spawnloft_lib::lock::{self, Attempt, Options};

// long enough for a contended count on a slow CI machine
const WAIT_MS: u64 = 60_000;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match run(&args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!(
                "usage: lock-probe hold <lockfile> <ms> | try <lockfile> | holder <lockfile> | count <lockfile> <counterfile> <n>"
            );
            ExitCode::from(2)
        }
        Err(e) => {
            eprintln!("lock-probe: {e}");
            ExitCode::FAILURE
        }
    }
}

// Each line is flushed, since the test reads them while the probe still runs.
fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn run(args: &[&str]) -> Result<bool, Box<dyn std::error::Error>> {
    match *args {
        ["hold", file, ms] => {
            let ms: u64 = ms.parse()?;
            let held =
                lock::acquire(Path::new(file), Options::wait(WAIT_MS))?.ok_or("no lock in wait mode")?;
            say(&format!("held {}", std::process::id()));
            std::thread::sleep(Duration::from_millis(ms));
            held.release()?;
            say("released");
        }
        ["try", file] => match lock::try_lock(Path::new(file))? {
            Attempt::Got(held) => {
                held.release()?;
                say("got");
            }
            // named as lockHolder names it, like the Node twin (test/fixtures/lock-node-probe.mjs)
            Attempt::Held(_) => say(&format!(
                "busy {}",
                lock::holder(Path::new(file)).map_or("null".to_string(), |p| p.to_string())
            )),
        },
        ["holder", file] => match lock::holder(Path::new(file)) {
            Some(pid) => say(&pid.to_string()),
            None => say("free"),
        },
        ["count", file, counter, n] => {
            let n: u32 = n.parse()?;
            for _ in 0..n {
                lock::with_lock(Path::new(file), Options::wait(WAIT_MS), || {
                    bump(Path::new(counter))
                })??;
            }
            say("done");
        }
        _ => return Ok(false),
    }
    Ok(true)
}

// A read and a write with a gap between, so a missing exclusion loses updates.
fn bump(counter: &Path) -> std::io::Result<()> {
    let text = std::fs::read_to_string(counter)?;
    let n: u64 = text.trim().parse().map_err(std::io::Error::other)?;
    std::thread::sleep(Duration::from_millis(1));
    std::fs::write(counter, (n + 1).to_string())
}
