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
    fn setsid() -> i32;
    fn umask(mask: ModeT) -> ModeT;
    fn signal(sig: i32, handler: usize) -> usize;
    fn access(path: *const std::ffi::c_char, mode: i32) -> i32;
    #[cfg(target_os = "linux")]
    fn sysconf(name: i32) -> i64;
    #[cfg(target_os = "macos")]
    fn sysctlbyname(
        name: *const std::ffi::c_char,
        oldp: *mut std::ffi::c_void,
        oldlenp: *mut usize,
        newp: *mut std::ffi::c_void,
        newlen: usize,
    ) -> i32;
}

/// `os.release()`: the kernel's release (Linux `6.8.0-45-generic`, the Darwin version on a
/// Mac), or `""` when it cannot be read.
pub fn os_release() -> String {
    #[cfg(target_os = "macos")]
    {
        let mut buf = [0u8; 256];
        let mut len = buf.len();
        // SAFETY: the name is NUL-terminated and buf/len describe a writable buffer.
        let rc = unsafe {
            sysctlbyname(
                c"kern.osrelease".as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 {
            return String::new();
        }
        let end = buf[..len.min(buf.len())]
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(len.min(buf.len()));
        String::from_utf8_lossy(&buf[..end]).into_owned()
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|s| s.trim_end().to_string())
            .unwrap_or_default()
    }
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

/// A new file only this user can open (mode 0600 from the start), failing when the name exists.
pub fn create_private_new(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// `fs.accessSync(path, fs.constants.W_OK)` succeeding: whether this process may write there.
pub fn writable(path: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    const W_OK: i32 = 2;
    // SAFETY: `c` is a NUL-terminated string that outlives the call; access only reads it.
    unsafe { access(c.as_ptr(), W_OK) == 0 }
}

/// `sameEntry(a, b)` (manage.mjs): two names for one file or folder, by device and inode.
pub fn same_entry(a: &std::path::Path, b: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!(
        (std::fs::metadata(a), std::fs::metadata(b)),
        (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino() && x.ino() != 0
    )
}

/// This process's user id.
pub fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { getuid() }
}

/// `os.userInfo().username`: the account's name from the system's user database (`getpwuid_r`,
/// so LDAP, sssd and systemd-homed accounts are found as Node finds them).
#[cfg(target_os = "linux")]
pub fn user_name(uid: u32) -> Option<String> {
    use std::ffi::{CStr, c_char, c_int};
    // `struct passwd`, the same in glibc and musl
    #[repr(C)]
    struct Passwd {
        pw_name: *mut c_char,
        pw_passwd: *mut c_char,
        pw_uid: u32,
        pw_gid: u32,
        pw_gecos: *mut c_char,
        pw_dir: *mut c_char,
        pw_shell: *mut c_char,
    }
    unsafe extern "C" {
        fn getpwuid_r(
            uid: u32,
            pwd: *mut Passwd,
            buf: *mut c_char,
            len: usize,
            result: *mut *mut Passwd,
        ) -> c_int;
    }
    let mut buf = vec![0 as c_char; 16 * 1024];
    let mut pwd = std::mem::MaybeUninit::<Passwd>::uninit();
    let mut result: *mut Passwd = std::ptr::null_mut();
    // SAFETY: every pointer is to memory this frame owns, `len` is the buffer's real length, and
    // the name is read only when the call reports a record, whose strings live in `buf`.
    unsafe {
        let rc = getpwuid_r(uid, pwd.as_mut_ptr(), buf.as_mut_ptr(), buf.len(), &mut result);
        if rc != 0 || result.is_null() || (*result).pw_name.is_null() {
            return None;
        }
        Some(CStr::from_ptr((*result).pw_name).to_string_lossy().into_owned())
    }
}

/// Unix programs have no console window to hide.
pub fn hide_window(_cmd: &mut Command) {}

/// Windows only (a kill-on-close job, see platform/windows.rs). Here the children this is used
/// for end when the pipe to their stdin closes, which a kill of this process closes too.
pub fn end_with_this_process(_child: &Child) -> bool {
    false
}

/// Node's `spawn(..., { detached: true })`: the child leads a new session, so it outlives the
/// terminal and the process group of whoever started it.
pub fn detach(cmd: &mut Command) {
    // SAFETY: setsid is async-signal-safe and touches nothing but the child's own session.
    unsafe {
        cmd.pre_exec(|| {
            if setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
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

static INTERRUPT_CODE: AtomicI32 = AtomicI32::new(0);

extern "C" fn on_interrupt(sig: i32) {
    // the first signal decides, as process.once does for each in cli-metrics.mjs
    let code = if sig == SIGINT { 130 } else { 143 };
    let _ = INTERRUPT_CODE.compare_exchange(0, code, Ordering::SeqCst, Ordering::SeqCst);
}

/// For a command that follows until stopped (`metrics --follow`): SIGINT and SIGTERM are caught
/// and remembered as the exit codes 130 and 143 the Node CLI ends with.
pub fn watch_interrupts() {
    // SAFETY: the handler only touches an atomic, which is async-signal-safe.
    unsafe {
        signal(SIGINT, on_interrupt as extern "C" fn(i32) as usize);
        signal(SIGTERM, on_interrupt as extern "C" fn(i32) as usize);
    }
}

/// The exit code of an interrupt [`watch_interrupts`] caught, if one came.
pub fn interrupted() -> Option<u8> {
    match INTERRUPT_CODE.load(Ordering::SeqCst) {
        0 => None,
        c => u8::try_from(c).ok(),
    }
}

/// The interrupt [`watch_interrupts`] caught, cleared so the next one is seen too (a second
/// Ctrl-C after the first was taken as a cancel).
pub fn take_interrupt() -> Option<u8> {
    match INTERRUPT_CODE.swap(0, Ordering::SeqCst) {
        0 => None,
        c => u8::try_from(c).ok(),
    }
}

/// Whether a SIGTERM arrived since the last call.
pub fn take_sigterm() -> bool {
    SIGTERM_SEEN.swap(false, Ordering::SeqCst)
}

#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: std::ffi::c_long,
}

unsafe extern "C" {
    fn clock_gettime(clock: i32, out: *mut Timespec) -> i32;
}

/// `os.uptime()`: whole seconds since the machine started (libuv reads `CLOCK_BOOTTIME` on
/// Linux; macOS's `CLOCK_MONOTONIC` also runs on through sleep). 0 when the clock cannot be read.
pub fn uptime_secs() -> u64 {
    #[cfg(target_os = "linux")]
    const CLOCK: i32 = 7; // CLOCK_BOOTTIME
    #[cfg(not(target_os = "linux"))]
    const CLOCK: i32 = 6; // CLOCK_MONOTONIC on macOS
    let mut t = Timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: clock_gettime writes one timespec into memory this function owns.
    if unsafe { clock_gettime(CLOCK, &mut t) } != 0 {
        return 0;
    }
    u64::try_from(t.tv_sec).unwrap_or(0)
}

/// `process.kill(-pid, 'SIGTERM')`, else `process.kill(pid, 'SIGTERM')`: whether either was sent
/// (the client's polite stop, which the game takes as its window closing).
pub fn ask_to_close(pid: i32) -> bool {
    if pid <= 1 {
        return false;
    }
    send(-pid, SIGTERM) || send(pid, SIGTERM)
}

fn send(pid: i32, sig: i32) -> bool {
    // SAFETY: kill() with any pid and a valid signal number has no memory-safety preconditions.
    unsafe { kill(pid, sig) == 0 }
}

/// `process.kill(pid, 0)` for any whole pid, negative ones (process groups, -1 for all) included;
/// EPERM counts as alive, as in `pidAlive`.
pub fn signal_zero(pid: i32) -> bool {
    send(pid, 0) || std::io::Error::last_os_error().raw_os_error() == Some(1)
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
            .map(|p| without_deleted(&p.to_string_lossy()).to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        None
    }
}

/// Linux names a replaced binary `<path> (deleted)`: a 1.x daemon that outlived a package upgrade
/// still runs from that image, and its name is the path without the suffix (as `src/util.mjs`
/// reads it).
#[cfg(any(target_os = "linux", test))]
fn without_deleted(image: &str) -> &str {
    image.strip_suffix(" (deleted)").unwrap_or(image)
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

/// `sig` (SIGTERM or SIGKILL by name) to the group `pid` leads when `group`, else, or when there
/// is no such group, to the process alone (cancel.mjs `killTree`).
pub fn signal_tree(pid: i32, hard: bool, group: bool) {
    if pid <= 1 {
        return;
    }
    let sig = if hard { SIGKILL } else { SIGTERM };
    if group && send(-pid, sig) {
        return;
    }
    send(pid, sig);
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
    fn a_replaced_binary_keeps_its_name() {
        let image = without_deleted("/opt/SpawnLoft/spawnloft-desktop (deleted)");
        assert_eq!(image, "/opt/SpawnLoft/spawnloft-desktop");
        assert!(crate::procid::same_image(image, "spawnloft-desktop"));
        assert_eq!(without_deleted("/usr/bin/java"), "/usr/bin/java");
    }

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

#[repr(C)]
#[allow(dead_code)]
struct Tm {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    // glibc, musl and macOS all follow the nine ints with these two
    tm_gmtoff: std::ffi::c_long,
    tm_zone: *const std::ffi::c_char,
}

unsafe extern "C" {
    fn localtime_r(time: *const i64, out: *mut Tm) -> *mut Tm;
    fn tzset();
}

/// How far local time is ahead of UTC at `utc_secs`, in seconds, by the C library's zone rules
/// (`TZ`, else `/etc/localtime`), the same rules Node's ICU reads. 0 when the time is out of the
/// library's range.
pub fn local_offset_secs(utc_secs: i64) -> i64 {
    static TZSET: std::sync::Once = std::sync::Once::new();
    // SAFETY: tzset only reads the environment and the zone files.
    TZSET.call_once(|| unsafe { tzset() });
    // SAFETY: a zeroed tm is valid output space; the pointers live through the call.
    let mut tm: Tm = unsafe { std::mem::zeroed() };
    let got = unsafe { localtime_r(&utc_secs, &mut tm) };
    // c_long is i64 on every 64-bit target this builds for, i32 elsewhere
    #[allow(clippy::useless_conversion)]
    let offset = i64::from(tm.tm_gmtoff);
    if got.is_null() { 0 } else { offset }
}

#[repr(C)]
struct IfAddrs {
    ifa_next: *mut IfAddrs,
    ifa_name: *const std::ffi::c_char,
    ifa_flags: std::ffi::c_uint,
    ifa_addr: *const u8,
    ifa_netmask: *const u8,
    ifa_ifu: *const u8,
    ifa_data: *const u8,
}

unsafe extern "C" {
    fn getifaddrs(out: *mut *mut IfAddrs) -> i32;
    fn freeifaddrs(list: *mut IfAddrs);
}

const IFF_UP: u32 = 0x1;
const IFF_LOOPBACK: u32 = 0x8;
const IFF_RUNNING: u32 = 0x40;
const AF_INET: u8 = 2;
#[cfg(target_os = "linux")]
const AF_INET6: u8 = 10;
#[cfg(not(target_os = "linux"))]
const AF_INET6: u8 = 30;

/// The address family of a sockaddr: a u16 on Linux, the second byte after `sa_len` on the BSDs.
///
/// # Safety
/// `sa` must point at a sockaddr.
unsafe fn family(sa: *const u8) -> u8 {
    // SAFETY: the caller promises a sockaddr, which is at least two bytes.
    unsafe {
        if cfg!(target_os = "linux") {
            u16::from_ne_bytes([*sa, *sa.add(1)]) as u8
        } else {
            *sa.add(1)
        }
    }
}

/// `os.networkInterfaces()`: each interface that is up and running with its addresses, in the
/// order the system lists them (libuv's rule), and whether it is the loopback (`internal`).
pub fn network_interfaces() -> Vec<(String, Vec<super::InterfaceAddress>)> {
    let mut list: *mut IfAddrs = std::ptr::null_mut();
    // SAFETY: an out-pointer; the list is freed below.
    if unsafe { getifaddrs(&mut list) } != 0 {
        return Vec::new();
    }
    let mut out: Vec<(String, Vec<super::InterfaceAddress>)> = Vec::new();
    let mut cur = list;
    while !cur.is_null() {
        // SAFETY: a node of the list getifaddrs made, alive until freeifaddrs.
        let ent = unsafe { &*cur };
        cur = ent.ifa_next;
        let flags = ent.ifa_flags;
        if flags & IFF_UP == 0 || flags & IFF_RUNNING == 0 || ent.ifa_addr.is_null() || ent.ifa_name.is_null()
        {
            continue;
        }
        // SAFETY: a non-null sockaddr from the list.
        let fam = unsafe { family(ent.ifa_addr) };
        let address = if fam == AF_INET {
            // sin_addr follows the family and the port
            // SAFETY: an AF_INET sockaddr holds sockaddr_in, 16 bytes.
            let b = unsafe { std::slice::from_raw_parts(ent.ifa_addr.add(4), 4) };
            std::net::IpAddr::from([b[0], b[1], b[2], b[3]])
        } else if fam == AF_INET6 {
            // sin6_addr follows the family, the port and the flow info
            // SAFETY: an AF_INET6 sockaddr holds sockaddr_in6, 28 bytes.
            let b = unsafe { std::slice::from_raw_parts(ent.ifa_addr.add(8), 16) };
            let mut a = [0u8; 16];
            a.copy_from_slice(b);
            std::net::IpAddr::from(a)
        } else {
            continue;
        };
        // SAFETY: a NUL-terminated name from the list.
        let name = unsafe { std::ffi::CStr::from_ptr(ent.ifa_name) }
            .to_string_lossy()
            .into_owned();
        let entry = super::InterfaceAddress {
            address: address.to_string(),
            ipv4: address.is_ipv4(),
            internal: flags & IFF_LOOPBACK != 0,
        };
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some((_, addrs)) => addrs.push(entry),
            None => out.push((name, vec![entry])),
        }
    }
    // SAFETY: the list from getifaddrs, freed once.
    unsafe { freeifaddrs(list) };
    out
}

#[cfg(all(test, target_os = "linux"))]
mod user_name_tests {
    #[test]
    fn this_account_has_a_name() {
        let name = super::user_name(super::uid()).expect("a passwd record for this process");
        assert!(!name.is_empty());
    }
}
