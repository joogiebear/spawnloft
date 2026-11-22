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

/// One address of a network interface, as `os.networkInterfaces()` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceAddress {
    pub address: String,
    pub ipv4: bool,
    pub internal: bool,
}

/// Signal names as Node reports them in `exitSignal` (the numbers differ between Linux and macOS
/// past the classic few).
pub fn signal_name(n: i32) -> String {
    let common = match n {
        1 => Some("SIGHUP"),
        2 => Some("SIGINT"),
        3 => Some("SIGQUIT"),
        4 => Some("SIGILL"),
        5 => Some("SIGTRAP"),
        6 => Some("SIGABRT"),
        8 => Some("SIGFPE"),
        9 => Some("SIGKILL"),
        11 => Some("SIGSEGV"),
        13 => Some("SIGPIPE"),
        14 => Some("SIGALRM"),
        15 => Some("SIGTERM"),
        _ => None,
    };
    let bsd = cfg!(any(target_os = "macos", target_os = "freebsd"));
    let other = if bsd {
        match n {
            7 => Some("SIGEMT"),
            10 => Some("SIGBUS"),
            12 => Some("SIGSYS"),
            16 => Some("SIGURG"),
            17 => Some("SIGSTOP"),
            18 => Some("SIGTSTP"),
            19 => Some("SIGCONT"),
            20 => Some("SIGCHLD"),
            21 => Some("SIGTTIN"),
            22 => Some("SIGTTOU"),
            23 => Some("SIGIO"),
            24 => Some("SIGXCPU"),
            25 => Some("SIGXFSZ"),
            26 => Some("SIGVTALRM"),
            27 => Some("SIGPROF"),
            28 => Some("SIGWINCH"),
            29 => Some("SIGINFO"),
            30 => Some("SIGUSR1"),
            31 => Some("SIGUSR2"),
            _ => None,
        }
    } else {
        match n {
            7 => Some("SIGBUS"),
            10 => Some("SIGUSR1"),
            12 => Some("SIGUSR2"),
            16 => Some("SIGSTKFLT"),
            17 => Some("SIGCHLD"),
            18 => Some("SIGCONT"),
            19 => Some("SIGSTOP"),
            20 => Some("SIGTSTP"),
            21 => Some("SIGTTIN"),
            22 => Some("SIGTTOU"),
            23 => Some("SIGURG"),
            24 => Some("SIGXCPU"),
            25 => Some("SIGXFSZ"),
            26 => Some("SIGVTALRM"),
            27 => Some("SIGPROF"),
            28 => Some("SIGWINCH"),
            29 => Some("SIGIO"),
            30 => Some("SIGPWR"),
            31 => Some("SIGSYS"),
            _ => None,
        }
    };
    match common.or(other) {
        Some(name) => name.to_string(),
        None => format!("SIG{n}"),
    }
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

/// `process.platform`: the names the Node core records (engine markers, archive tables).
pub fn node_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// `process.arch`.
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        "arm" => "arm",
        other => other,
    }
}

/// `platformCapabilities()`: what this build can do here. Every platform SpawnLoft is built for
/// has all three; the table is kept because the panel's pages ask it.
pub fn capabilities() -> serde_json::Value {
    serde_json::json!({ "scheduler": true, "performance": true, "managedDatabases": true })
}

/// `PREVIEW_LIMITS`: what a page says where a capability is missing.
pub mod preview_limits {
    pub const SCHEDULER: &str = "Scheduled tasks and automatic backups are not available in this preview on this platform. You can still start, stop, and back up servers manually.";
    pub const PERFORMANCE: &str = "CPU and memory charts are not available in this preview on this platform. Server controls and the live console still work.";
    pub const MANAGED_DATABASES: &str = "Automatic database installation is not available in this preview on this platform. Connect to an existing MySQL or Redis database instead.";
}
