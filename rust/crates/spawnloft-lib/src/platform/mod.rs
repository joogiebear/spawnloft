//! What differs by operating system, behind one interface: how a server is spawned and killed as
//! a tree, signals, process measurements, and (Windows) the control pipe. `unsafe` lives here and
//! nowhere else in the crate.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub use self::windows::*;

/// One process measurement.
#[derive(Debug, Clone, PartialEq)]
pub enum Probe {
    /// Cumulative CPU seconds, resident bytes, and what identifies the process (its start time)
    /// where the pid alone could be reused.
    Alive {
        seconds: f64,
        bytes: u64,
        identity: Option<String>,
    },
    /// The process has exited.
    Gone,
}

/// Signal names as Node reports them in `exitSignal`.
pub fn signal_name(n: i32) -> String {
    let name = match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("SIG{n}"),
    };
    name.to_string()
}

/// Logical processors, as Node's `os.cpus().length` counts them (the whole machine, not this
/// process's share), so a CPU figure means the same from either daemon.
pub fn cpu_count() -> usize {
    #[cfg(target_os = "linux")]
    if let Ok(stat) = std::fs::read_to_string("/proc/stat") {
        let n = stat
            .lines()
            .filter(|l| l.starts_with("cpu") && l.as_bytes().get(3).is_some_and(u8::is_ascii_digit))
            .count();
        if n > 0 {
            return n;
        }
    }
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}
