#![allow(unsafe_code)]
//! Unix: the server gets its own process group so a force kill reaches what it forked; SIGTERM
//! asks the daemon for a graceful stop and SIGINT is ignored.

use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use super::Probe;

const SIGINT: i32 = 2;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;

unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn getuid() -> u32;
    fn umask(mask: ModeT) -> ModeT;
    fn signal(sig: i32, handler: usize) -> usize;
    #[cfg(target_os = "linux")]
    fn sysconf(name: i32) -> i64;
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
type ModeT = u16;
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd")))]
type ModeT = u32;

/// Runs `f` with a 077 umask, so a file it creates (the control socket) is never reachable by
/// anyone else, not even for the moment before a chmod.
pub fn with_private_umask<T>(f: impl FnOnce() -> T) -> T {
    // SAFETY: umask has no preconditions and cannot fail; it is restored right after.
    let old = unsafe { umask(0o077) };
    let out = f();
    // SAFETY: as above.
    unsafe { umask(old) };
    out
}

/// This process's user id.
pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { getuid() }
}

/// Unix programs have no console window to hide.
pub fn hide_window(_cmd: &mut Command) {}

/// Windows only (a kill-on-close job, see platform/windows.rs). Here the children this is used
/// for end when the pipe to their stdin closes, which a kill of this process closes too.
pub fn end_with_this_process(_child: &Child) -> bool {
    false
}

/// Puts the server in a process group of its own, led by it, so `kill(-pid)` reaches its forks.
pub fn prepare_server(cmd: &mut Command) {
    cmd.process_group(0);
}

static SIGTERM_SEEN: AtomicBool = AtomicBool::new(false);

extern "C" fn on_sigterm(_: i32) {
    SIGTERM_SEEN.store(true, Ordering::SeqCst);
}

extern "C" fn on_sigint(_: i32) {}

/// SIGTERM is remembered for the main loop; SIGINT is caught and dropped (a handler, not
/// SIG_IGN, so the server does not inherit an ignored SIGINT through exec).
pub fn install_signal_handlers() {
    // SAFETY: both handlers only touch an atomic, which is async-signal-safe; signal() with a
    // function pointer is the documented use.
    unsafe {
        signal(SIGTERM, on_sigterm as extern "C" fn(i32) as usize);
        signal(SIGINT, on_sigint as extern "C" fn(i32) as usize);
    }
}

/// Whether a SIGTERM arrived since the last call.
pub fn take_sigterm() -> bool {
    SIGTERM_SEEN.swap(false, Ordering::SeqCst)
}

fn send(pid: i32, sig: i32) -> bool {
    // SAFETY: kill() with any pid and a valid signal number has no memory-safety preconditions.
    unsafe { kill(pid, sig) == 0 }
}

/// Whether `pid` names a live process (EPERM counts: the pid is taken, just not ours).
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    send(pid, 0) || std::io::Error::last_os_error().raw_os_error() == Some(1)
}

/// The process start time in clock ticks since boot (`/proc/<pid>/stat` field 22) on Linux; the
/// identity half a reused pid cannot repeat. `None` elsewhere (the file-name rule applies).
pub fn process_start_time(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let close = stat.rfind(')')?;
        stat.get(close + 2..)?.split_whitespace().nth(19)?.parse().ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The running image's path, where the system says (Linux `/proc/<pid>/exe`).
pub fn process_image(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// The server's process tree, for killing it. Unix needs no handle beyond the group id.
#[derive(Debug)]
pub struct Tree {
    pid: i32,
    /// Why the tree is reached some weaker way; never set on Unix, where the group is made at spawn.
    pub fallback_reason: Option<String>,
}

impl Tree {
    pub fn attach(child: &Child) -> Tree {
        Tree {
            pid: child.id() as i32,
            fallback_reason: None,
        }
    }
    /// SIGKILL to the whole group, or to the process when it is not a group leader.
    pub fn kill(&self) {
        kill_group(self.pid);
    }
}

/// `killProcessGroup`: the group first, then the process alone.
pub fn kill_group(pid: i32) {
    if pid <= 1 {
        return;
    }
    if !send(-pid, SIGKILL) {
        send(pid, SIGKILL);
    }
}

/// SIGTERM to the process alone (Garnet's stop after its checkpoint).
pub fn terminate(child: &mut Child) {
    send(child.id() as i32, SIGTERM);
}

// What the panic hook kills: the group of the server running now, 0 for none.
static KILL_TARGET: AtomicI32 = AtomicI32::new(0);

pub fn set_kill_target(tree: Option<&Tree>) {
    KILL_TARGET.store(tree.map(|t| t.pid).unwrap_or(0), Ordering::SeqCst);
}

/// For the panic path: kills the current server's tree, if any, and returns its pid.
pub fn kill_target_now() -> Option<u32> {
    let pid = KILL_TARGET.swap(0, Ordering::SeqCst);
    if pid > 1 {
        kill_group(pid);
        Some(pid as u32)
    } else {
        None
    }
}

/// Measurements of one process.
#[derive(Debug)]
pub struct ProcessProbe {
    pid: u32,
    #[cfg(target_os = "linux")]
    ticks: f64,
}

impl ProcessProbe {
    pub fn open(pid: u32) -> Result<ProcessProbe, String> {
        if pid == 0 {
            return Err("Cannot measure a process without a valid PID".into());
        }
        Ok(ProcessProbe {
            pid,
            #[cfg(target_os = "linux")]
            // SAFETY: sysconf has no preconditions; 2 is _SC_CLK_TCK on glibc and musl.
            ticks: match unsafe { sysconf(2) } {
                n if n > 0 => n as f64,
                _ => 100.0,
            },
        })
    }

    #[cfg(target_os = "linux")]
    pub fn sample(&mut self) -> Result<Probe, String> {
        let read = |what: &str| std::fs::read_to_string(format!("/proc/{}/{what}", self.pid));
        let (stat, status) = match (read("stat"), read("status")) {
            (Ok(a), Ok(b)) => (a, b),
            // the process exited, possibly between the two reads
            (Err(e), _) | (_, Err(e))
                if matches!(e.kind(), std::io::ErrorKind::NotFound) || e.raw_os_error() == Some(3) =>
            {
                return Ok(Probe::Gone);
            }
            (Err(e), _) | (_, Err(e)) => return Err(e.to_string()),
        };
        let (seconds, bytes, identity) = crate::metrics::parse_proc_sample(&stat, &status, self.ticks)?;
        Ok(Probe::Alive {
            seconds,
            bytes,
            identity: Some(identity),
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn sample(&mut self) -> Result<Probe, String> {
        let out = Command::new("/bin/ps")
            .args(["-p", &self.pid.to_string(), "-o", "pid=,time=,rss=,lstart="])
            .env("LC_ALL", "C")
            .output()
            .map_err(|e| format!("macOS process measurement failed: {e}"))?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        // ps exits 1 with no output when the process is gone
        if out.status.code() == Some(1) && stdout.trim().is_empty() && out.stderr.is_empty() {
            return Ok(Probe::Gone);
        }
        if !out.status.success() {
            return Err(format!(
                "macOS process measurement failed: ps exited with {}",
                out.status
            ));
        }
        let (seconds, bytes, identity) = crate::metrics::parse_ps_sample(&stdout, self.pid)?;
        Ok(Probe::Alive {
            seconds,
            bytes,
            identity: Some(identity),
        })
    }
}

/// The longest command Windows runs from RunOnce.
pub const RUN_ONCE_MAX: usize = 260;

/// Renames over `to` and flushes the folder, so the new name survives a power cut.
pub fn rename_durable(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(from, to)?;
    if let Some(dir) = to.parent()
        && let Ok(d) = std::fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Windows only: a command for the next sign-in (`HKCU\...\RunOnce`). Nothing elsewhere.
pub fn run_once_set(_name: &str, _command: &str) -> std::io::Result<()> {
    Ok(())
}

/// Windows only.
pub fn run_once_remove(_name: &str) -> std::io::Result<()> {
    Ok(())
}

/// Windows only: whether the session is ending (shutdown, restart, sign-out).
pub fn session_ending() -> bool {
    false
}

/// Windows only: lets go of the console window a program started at sign-in is given.
pub fn detach_console() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_kill_reaches_a_fork() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        use std::io::BufRead;
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let helper: i32 = line.trim().parse().unwrap();
        Tree::attach(&child).kill();
        child.wait().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while send(helper, 0) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(!send(helper, 0), "the forked helper outlived the group kill");
    }
}
