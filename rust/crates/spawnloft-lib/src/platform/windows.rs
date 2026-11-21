#![allow(unsafe_code)]
//! Windows: the server is held in a Job Object so a force kill takes its whole tree (not
//! kill-on-close: a daemon that dies leaves the server running and `orphaned`, still stoppable);
//! `taskkill /T` is the fallback when the job cannot be made. The control pipe is created with an
//! owner-only DACL and rejects remote clients. Process figures come from the process handle.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_PIPE_CONNECTED, FILETIME, GENERIC_WRITE, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    LocalFree, STILL_ACTIVE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
    OpenProcessToken, OpenThread, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW, ResumeThread, THREAD_SUSPEND_RESUME,
};

use super::Probe;

/// `fs.accessSync(path, fs.constants.W_OK)` succeeding, as libuv answers it on Windows: the path
/// exists, and it is a folder or a file without the read-only attribute.
pub fn writable(path: &std::path::Path) -> bool {
    match std::fs::metadata(path) {
        Ok(m) => m.is_dir() || !m.permissions().readonly(),
        Err(_) => false,
    }
}

/// No console window for a program the daemon starts (the daemon itself has no console).
pub fn hide_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// An ordinary child with no window (`detached` would give the server a console of its own),
/// started suspended so [`Tree::attach`] puts it in the job before it can run, let alone fork:
/// a process it started first would be outside the job and survive a force kill.
/// `Tree::attach` must follow every spawn made with this, since it is what resumes the child.
pub fn prepare_server(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
}

/// Ends `child` when this process ends, however it ends (a kill included): the child goes into a
/// kill-on-close job whose only handle this process holds, on purpose, until it exits. Silent
/// breakaway is set, so nothing the child starts is in the job: the Node panel's server daemons
/// must outlive the panel, the window and this process. Used for the window's core and the core's
/// Node panel (P0-F review M3/L4); `false` when the job could not be made, which only loses the
/// belt: both children also end when the pipe to their stdin closes.
pub fn end_with_this_process(child: &Child) -> bool {
    // SAFETY: default security, no name; the result is checked.
    let Some(job) = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) }) else {
        return false;
    };
    // SAFETY: a zeroed limit structure is valid; only LimitFlags is set.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    // SAFETY: a valid job handle, and the structure and size the information class documents.
    let set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as HANDLE,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return false;
    }
    // SAFETY: both handles are valid for the duration of the call.
    let assigned =
        unsafe { AssignProcessToJobObject(job.as_raw_handle() as HANDLE, child.as_raw_handle() as HANDLE) };
    if assigned == 0 {
        return false;
    }
    // held until this process exits; closing it is what ends the child
    std::mem::forget(job);
    true
}

/// Resumes every thread of a process started with CREATE_SUSPENDED (it has just the one).
fn resume(pid: u32) -> std::io::Result<()> {
    // SAFETY: a thread snapshot of the system; the handle is checked and owned below.
    let snap = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }).ok_or_else(last_error)?;
    let snap_h = snap.as_raw_handle() as HANDLE;
    // SAFETY: a zeroed THREADENTRY32 with dwSize set is the documented input.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0;
    // SAFETY: a valid snapshot handle and a correctly sized entry.
    let mut more = unsafe { Thread32First(snap_h, &mut entry) } != 0;
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: the result is checked and owned (closed on drop).
            if let Some(t) = owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) }) {
                // SAFETY: a valid thread handle opened with THREAD_SUSPEND_RESUME.
                if unsafe { ResumeThread(t.as_raw_handle() as HANDLE) } != u32::MAX {
                    resumed += 1;
                }
            }
        }
        // SAFETY: as above.
        more = unsafe { Thread32Next(snap_h, &mut entry) } != 0;
    }
    if resumed == 0 {
        return Err(std::io::Error::other("no thread of the server could be resumed"));
    }
    Ok(())
}

/// Ctrl+C and Ctrl+Break are left to the program this process forwards to (it shares the console
/// and gets them itself); a console close still ends this process. A handler, not
/// `SetConsoleCtrlHandler(NULL, TRUE)`, because the latter is inherited by children.
pub fn ignore_ctrl_c() {
    unsafe extern "system" fn handler(kind: u32) -> i32 {
        use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT};
        i32::from(kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT)
    }
    // SAFETY: registers a function with the documented signature that lives for the process.
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(handler), 1);
    }
}

/// Runs `cmd` to its end inside a job object that kills it when this process ends, however it
/// ends (the forwarder of `spawnloft-core <command>` and of the shell's argv compatibility form,
/// PLAN-2.0-REMAINING.md A6). Only that child is in the job: its own children break away
/// silently, so a server daemon a `start` spawns outlives the command, as it must. Started
/// suspended so it is in the job before it runs. Returns its exit code.
pub fn run_in_kill_job(cmd: Command) -> std::io::Result<i32> {
    run_in_kill_job_with(cmd, CREATE_SUSPENDED)
}

/// [`run_in_kill_job`] for a caller that may have no console of its own: the windowed
/// `SpawnLoft.exe` forwarding its argv compatibility form (`SpawnLoft.exe ...\mcctl.mjs mcp`, what a
/// 1.x MCP config in Claude Desktop runs at every sign-in). A console program started from a
/// process with no console gets a new console, and so a visible terminal window, unless it is
/// started with `CREATE_NO_WINDOW`. A caller that does have a console (a debug build run from a
/// terminal) keeps sharing it, so its output still shows there. Standard handles are inherited
/// either way, so an MCP client's pipes are untouched.
pub fn run_in_kill_job_no_new_window(cmd: Command) -> std::io::Result<i32> {
    run_in_kill_job_with(cmd, CREATE_SUSPENDED | no_new_window_flag(has_console()))
}

/// `CREATE_NO_WINDOW` when the caller has no console to share, nothing otherwise.
pub fn no_new_window_flag(has_console: bool) -> u32 {
    if has_console { 0 } else { CREATE_NO_WINDOW }
}

fn has_console() -> bool {
    // SAFETY: no arguments; returns this process's console window or null.
    !unsafe { windows_sys::Win32::System::Console::GetConsoleWindow() }.is_null()
}

fn run_in_kill_job_with(mut cmd: Command, flags: u32) -> std::io::Result<i32> {
    cmd.creation_flags(flags);
    let mut child = cmd.spawn()?;
    let job = kill_on_close_job();
    if let Some(job) = &job {
        // SAFETY: both handles are valid for the duration of the call.
        let _ = unsafe {
            AssignProcessToJobObject(job.as_raw_handle() as HANDLE, child.as_raw_handle() as HANDLE)
        };
    }
    if let Err(e) = resume(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    let status = child.wait()?;
    drop(job);
    Ok(status.code().unwrap_or(1))
}

fn kill_on_close_job() -> Option<OwnedHandle> {
    // SAFETY: default security, no name; the result is checked.
    let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
    // SAFETY: a zeroed limit structure is the documented "no limits" starting point.
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    // SAFETY: a valid job handle and a correctly sized structure of the class named.
    let set = unsafe {
        SetInformationJobObject(
            job.as_raw_handle() as HANDLE,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    (set != 0).then_some(job)
}

/// Windows has no SIGTERM; a stop always comes over the control pipe.
pub fn install_signal_handlers() {}

static INTERRUPT_CODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// For a command that follows until stopped (`metrics --follow`): Ctrl+C and Ctrl+Break are
/// caught and remembered as exit code 130, what Node's emulated SIGINT ends the CLI with.
/// Ctrl+Break is left to the default handler: the Node core has no SIGBREAK listener.
pub fn watch_interrupts() {
    unsafe extern "system" fn handler(kind: u32) -> i32 {
        use windows_sys::Win32::System::Console::CTRL_C_EVENT;
        if kind == CTRL_C_EVENT {
            let _ = INTERRUPT_CODE.compare_exchange(
                0,
                130,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            );
            return 1;
        }
        0
    }
    // SAFETY: registers a function with the documented signature that lives for the process.
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(Some(handler), 1);
    }
}

/// The exit code of an interrupt [`watch_interrupts`] caught, if one came.
pub fn interrupted() -> Option<u8> {
    match INTERRUPT_CODE.load(std::sync::atomic::Ordering::SeqCst) {
        0 => None,
        c => Some(c),
    }
}

/// `os.release()`: `major.minor.build` as RtlGetVersion reports it (GetVersionEx would answer
/// 6.2 to a process without a compatibility manifest).
pub fn os_release() -> String {
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
    }
    // SAFETY: a zeroed OSVERSIONINFOW with its size set is what RtlGetVersion fills in.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: info is a valid, writable OSVERSIONINFOW.
    if unsafe { RtlGetVersion(&mut info) } != 0 {
        return String::new();
    }
    format!(
        "{}.{}.{}",
        info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber
    )
}

/// The interrupt [`watch_interrupts`] caught, cleared so the next one is seen too.
pub fn take_interrupt() -> Option<u8> {
    match INTERRUPT_CODE.swap(0, std::sync::atomic::Ordering::SeqCst) {
        0 => None,
        c => Some(c),
    }
}

pub fn take_sigterm() -> bool {
    false
}

fn last_error() -> std::io::Error {
    std::io::Error::last_os_error()
}

fn owned(handle: HANDLE) -> Option<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        None
    } else {
        // SAFETY: a fresh handle this process just opened and nothing else owns.
        Some(unsafe { OwnedHandle::from_raw_handle(handle as _) })
    }
}

/// The server's process tree: a Job Object holding it, or the pid for `taskkill /T`.
#[derive(Debug)]
pub struct Tree {
    pid: u32,
    job: Option<OwnedHandle>,
    /// Why the job could not be used, so the daemon log says the fallback is in force.
    pub fallback_reason: Option<String>,
}

impl Tree {
    /// Puts a child started by [`prepare_server`] (suspended) in a job, then lets it run. A
    /// child that cannot be resumed is terminated, so it is seen to exit rather than hang.
    pub fn attach(child: &Child) -> Tree {
        let tree = Self::join(child);
        if let Err(e) = resume(child.id()) {
            // SAFETY: the child's own handle, valid while `child` lives.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(child.as_raw_handle() as HANDLE, 1)
            };
            return Tree {
                fallback_reason: Some(format!("the server could not be started from suspended ({e})")),
                ..tree
            };
        }
        tree
    }

    fn join(child: &Child) -> Tree {
        let pid = child.id();
        // SAFETY: default security, no name; the result is checked.
        let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        let Some(job) = job else {
            return Tree {
                pid,
                job: None,
                fallback_reason: Some(format!("no job object ({})", last_error())),
            };
        };
        // SAFETY: both handles are valid for the duration of the call.
        let assigned = unsafe {
            AssignProcessToJobObject(job.as_raw_handle() as HANDLE, child.as_raw_handle() as HANDLE)
        };
        if assigned == 0 {
            return Tree {
                pid,
                job: None,
                fallback_reason: Some(format!(
                    "the server could not join a job object ({})",
                    last_error()
                )),
            };
        }
        Tree {
            pid,
            job: Some(job),
            fallback_reason: None,
        }
    }

    pub fn kill(&self) {
        if let Some(job) = &self.job {
            // SAFETY: a valid job handle we own.
            if unsafe { TerminateJobObject(job.as_raw_handle() as HANDLE, 1) } != 0 {
                return;
            }
        }
        taskkill(self.pid);
    }
}

fn taskkill(pid: u32) {
    // by full path: a bare name is searched for in the daemon's directory and cwd first
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let exe = std::path::Path::new(&root).join("System32").join("taskkill.exe");
    let mut cmd = Command::new(exe);
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let _ = cmd.spawn();
}

/// `os.uptime()`: whole seconds since the machine started.
pub fn uptime_secs() -> u64 {
    // SAFETY: plain call with no arguments.
    unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() / 1000 }
}

/// `taskkill /PID <pid> /T` without `/F`, waited for: Windows sends the game's window WM_CLOSE,
/// which it takes as its window closing. Whether taskkill said it did.
pub fn ask_to_close(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    cmd.status().is_ok_and(|s| s.code() == Some(0))
}

/// `taskkill /PID <pid> /T /F`, started and not waited for, as supervisor.mjs `killTree` does.
pub fn kill_tree_pid(pid: u32) {
    taskkill(pid);
}

/// Node's `spawn(..., { detached: true, windowsHide: true })`: libuv's `DETACHED_PROCESS` and
/// `CREATE_NEW_PROCESS_GROUP`, so the child has no console and Ctrl+C in the caller's never
/// reaches it.
///
/// `CreateProcess` here always inherits every inheritable handle, and this process's own standard
/// handles usually are (a pipe the caller reads to its end, say): a daemon holding them would keep
/// that reader waiting until the server stops. libuv clears the flag at startup
/// (`uv_disable_stdio_inheritance`); this clears it before a detached start. A child that is
/// meant to share them still gets them: `Stdio::inherit` passes a duplicate.
pub fn detach(cmd: &mut Command) {
    use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle takes a constant; SetHandleInformation only changes the flag of a
        // handle this process owns, and fails harmlessly on a null or invalid one.
        unsafe {
            let h = GetStdHandle(which);
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// TerminateProcess, which is what Node's `child.kill('SIGTERM')` does on Windows.
pub fn terminate(child: &mut Child) {
    let _ = child.kill();
}

static KILL_PID: AtomicU32 = AtomicU32::new(0);
static KILL_JOB: AtomicUsize = AtomicUsize::new(0);

/// What the panic path kills. The job handle stays owned by the `Tree`, which outlives this.
pub fn set_kill_target(tree: Option<&Tree>) {
    KILL_PID.store(tree.map(|t| t.pid).unwrap_or(0), Ordering::SeqCst);
    let job = tree
        .and_then(|t| t.job.as_ref())
        .map(|j| j.as_raw_handle() as usize)
        .unwrap_or(0);
    KILL_JOB.store(job, Ordering::SeqCst);
}

pub fn kill_target_now() -> Option<u32> {
    let pid = KILL_PID.swap(0, Ordering::SeqCst);
    let job = KILL_JOB.swap(0, Ordering::SeqCst);
    if pid == 0 {
        return None;
    }
    // SAFETY: the handle is still owned by the live Tree (the panic hook runs before any drop).
    if job == 0 || unsafe { TerminateJobObject(job as HANDLE, 1) } == 0 {
        taskkill(pid);
    }
    Some(pid)
}

/// Measurements through a handle of our own, which also pins the process: a reused pid cannot
/// continue the graph.
#[derive(Debug)]
pub struct ProcessProbe {
    handle: OwnedHandle,
}

fn filetime_secs(t: &FILETIME) -> f64 {
    (((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64) as f64 / 1e7
}

impl ProcessProbe {
    pub fn open(pid: u32) -> Result<ProcessProbe, String> {
        // SAFETY: plain call; the result is checked.
        let handle = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
            .ok_or_else(|| format!("cannot open process {pid}: {}", last_error()))?;
        Ok(ProcessProbe { handle })
    }

    pub fn sample(&mut self) -> Result<Probe, String> {
        let h = self.handle.as_raw_handle() as HANDLE;
        let mut code = 0u32;
        // SAFETY: valid handle and out-pointer.
        if unsafe { GetExitCodeProcess(h, &mut code) } == 0 {
            return Err(format!("process measurement failed: {}", last_error()));
        }
        if code != STILL_ACTIVE as u32 {
            return Ok(Probe::Gone);
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: valid handle and four out-pointers.
        if unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
            return Err(format!("process measurement failed: {}", last_error()));
        }
        // SAFETY: zeroed is a valid PROCESS_MEMORY_COUNTERS; cb says its size.
        let mut mem: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if unsafe { K32GetProcessMemoryInfo(h, &mut mem, mem.cb) } == 0 {
            return Err(format!("process measurement failed: {}", last_error()));
        }
        Ok(Probe::Alive {
            seconds: filetime_secs(&kernel) + filetime_secs(&user),
            bytes: mem.WorkingSetSize as u64,
            identity: None,
        })
    }
}

/// `TerminateProcess` on the process `pid` names (cancel.rs, when taskkill could not end it).
/// Whether it was ended.
pub fn terminate_pid(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: plain call; the result is checked and owned.
    let Some(handle) =
        owned(unsafe { OpenProcess(windows_sys::Win32::System::Threading::PROCESS_TERMINATE, 0, pid) })
    else {
        return false;
    };
    // SAFETY: a valid process handle that this function owns.
    unsafe {
        windows_sys::Win32::System::Threading::TerminateProcess(handle.as_raw_handle() as HANDLE, 1) != 0
    }
}

fn open_query(pid: u32) -> Option<OwnedHandle> {
    if pid == 0 {
        return None;
    }
    // SAFETY: plain call; the result is checked and owned.
    owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
}

/// Whether `pid` names a process that has not exited. A process this user may not open (another
/// user's, a protected one) counts as alive: the pid is taken, which is all a caller can know.
/// `process.kill(pid, 0)` for any whole pid: libuv opens the pid as a DWORD, so a negative one
/// names no process.
pub fn signal_zero(pid: i32) -> bool {
    pid_alive(pid as u32)
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let Some(h) = open_query(pid) else {
        // ERROR_ACCESS_DENIED (5): exists but not ours; anything else (87, invalid parameter): gone
        return std::io::Error::last_os_error().raw_os_error() == Some(5);
    };
    let mut code = 0u32;
    // SAFETY: valid handle and out-pointer.
    if unsafe { GetExitCodeProcess(h.as_raw_handle() as HANDLE, &mut code) } == 0 {
        return true;
    }
    code == STILL_ACTIVE as u32
}

/// The kernel's creation time of `pid` (FILETIME, 100 ns since 1601), the half of a process
/// identity that a reused pid cannot repeat. `None` when the process cannot be opened.
pub fn process_start_time(pid: u32) -> Option<u64> {
    let h = open_query(pid)?;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: valid handle and four out-pointers.
    if unsafe {
        GetProcessTimes(
            h.as_raw_handle() as HANDLE,
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return None;
    }
    Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// `QueryFullProcessImageNameW`: the image path as the file object names it now (it follows a
/// rename of the running file, unlike the path WMI and tasklist report; design section 4).
pub fn process_image(pid: u32) -> Option<String> {
    let h = open_query(pid)?;
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: valid handle; buf holds len UTF-16 units and len is updated to the length written.
    if unsafe {
        QueryFullProcessImageNameW(
            h.as_raw_handle() as HANDLE,
            PROCESS_NAME_WIN32,
            buf.as_mut_ptr(),
            &mut len,
        )
    } == 0
    {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// The process id of the server end of a pipe this process has open as a client.
pub fn pipe_server_pid(pipe: &std::fs::File) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: a valid pipe handle owned by `pipe`, and an out-pointer.
    if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
        return None;
    }
    Some(pid)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// # Safety
/// `p` must point at a NUL-terminated UTF-16 string.
unsafe fn from_wide(p: *const u16) -> String {
    let mut len = 0;
    // SAFETY: the caller promises a terminator.
    while unsafe { *p.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: len elements were just read.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, len) })
}

/// This process's user as a SID string (`S-1-5-21-...`).
pub fn user_sid() -> Result<String, String> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the pseudo-handle needs no closing; out-pointer valid.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!("cannot read this process's token: {}", last_error()));
    }
    let token = owned(token).ok_or("no token")?;
    let mut len = 0u32;
    // SAFETY: a size query with no buffer; it fails with the needed length.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &mut len,
        )
    };
    // u64 storage keeps TOKEN_USER aligned
    let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
    // SAFETY: the buffer holds len bytes.
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle() as HANDLE,
            TokenUser,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        )
    } == 0
    {
        return Err(format!("cannot read this process's user: {}", last_error()));
    }
    // SAFETY: the call above filled a TOKEN_USER at the start of the buffer.
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: the SID points into buf, alive here; text is freed with LocalFree below.
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err(format!("cannot name this process's user: {}", last_error()));
    }
    // SAFETY: a NUL-terminated string allocated by the call above.
    let sid = unsafe { from_wide(text) };
    unsafe { LocalFree(text as _) };
    Ok(sid)
}

/// The SDDL of the control pipe: protected (no inherited entries), full access for this user
/// alone. Not SYSTEM, not Administrators, not other sessions of other users.
pub fn pipe_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

/// The SDDL of a private file: protected (nothing inherited from the folder), full access for
/// this user alone. What `src/private-files.mjs` makes with icacls, here from the first moment.
pub fn private_file_sddl(sid: &str) -> String {
    format!("D:P(A;;FA;;;{sid})")
}

/// A new file only this user can open, failing when the name exists. The ACL is on the file
/// when it is created, so it is never there under its folder's permissions.
pub fn create_private_new(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let sddl = wide(&private_file_sddl(&user_sid().map_err(std::io::Error::other)?));
    let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated string and out-pointer; the descriptor is freed below.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let name = path_wide(path);
    // SAFETY: a NUL-terminated path and attributes that live through the call; the result is
    // checked, and CREATE_NEW never opens a file that exists.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_WRITE,
            0,
            &attrs,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    let made = owned(handle).ok_or_else(last_error);
    // SAFETY: allocated by the conversion above and not used after this.
    unsafe { LocalFree(sd as _) };
    made.map(std::fs::File::from)
}

/// One access entry on a file, as `inspect` reads it: who it names (`DOMAIN\\name` as icacls prints
/// it, or `*S-1-...` when the SID has no name here), its SID, and whether it came from the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessEntry {
    pub principal: String,
    pub sid: Option<String>,
    pub inherited: bool,
}

/// A path for the wide API calls. A long absolute one gets the verbatim prefix (`\\\\?\\`), as
/// std's own file calls give it, so a data root past MAX_PATH is protected like any other.
fn path_wide(path: &std::path::Path) -> Vec<u16> {
    let text = path.to_string_lossy();
    let shown = if text.len() < 240 || text.starts_with("\\\\?\\") {
        text.into_owned()
    } else if let Some(rest) = text.strip_prefix("\\\\").or_else(|| text.strip_prefix("//")) {
        format!("\\\\?\\UNC\\{}", rest.replace('/', "\\"))
    } else if text.as_bytes().get(1) == Some(&b':') {
        format!("\\\\?\\{}", text.replace('/', "\\"))
    } else {
        text.into_owned()
    };
    shown.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Replaces the file's access list with the private one: inheritance cut and one full-access
/// entry for this user, what `icacls <file> /inheritance:r /grant:r *<sid>:F` leaves.
pub fn protect_private(path: &std::path::Path) -> std::io::Result<()> {
    use windows_sys::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, PROTECTED_DACL_SECURITY_INFORMATION,
    };
    let sddl = wide(&private_file_sddl(&user_sid().map_err(std::io::Error::other)?));
    let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated string and out-pointer; the descriptor is freed below.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(last_error());
    }
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    // SAFETY: sd is the descriptor just made; the out-pointers are valid.
    let got = unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) };
    let result = if got == 0 || present == 0 {
        Err(last_error())
    } else {
        let mut name = path_wide(path);
        // SAFETY: a NUL-terminated path; the ACL lives in sd, alive until LocalFree below.
        let code = unsafe {
            SetNamedSecurityInfoW(
                name.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                dacl,
                std::ptr::null(),
            )
        };
        if code == 0 {
            Ok(())
        } else {
            Err(std::io::Error::from_raw_os_error(code as i32))
        }
    };
    // SAFETY: allocated by the conversion above and not used after this.
    unsafe { LocalFree(sd as _) };
    result
}

/// The name icacls prints for a SID: `DOMAIN\\name`, the bare name for one with no domain
/// (`Everyone`), or `*S-1-...` when it does not resolve.
fn sid_principal(sid: *mut core::ffi::c_void, text: &Option<String>) -> String {
    use windows_sys::Win32::Security::{LookupAccountSidW, SID_NAME_USE};
    let mut name = [0u16; 256];
    let mut domain = [0u16; 256];
    let mut name_len = name.len() as u32;
    let mut domain_len = domain.len() as u32;
    let mut kind: SID_NAME_USE = 0;
    // SAFETY: the SID is valid while its ACL is; both buffers hold their stated lengths.
    let ok = unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid,
            name.as_mut_ptr(),
            &mut name_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut kind,
        )
    };
    if ok == 0 {
        return format!("*{}", text.clone().unwrap_or_else(|| "unknown".into()));
    }
    let name = String::from_utf16_lossy(&name[..name_len as usize]);
    let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
    if domain.is_empty() {
        name
    } else {
        format!("{domain}\\{name}")
    }
}

/// Every entry of the file's access list, in order. `None` for a file with no list at all, which
/// Windows reads as open to everyone.
pub fn access_entries(path: &std::path::Path) -> std::io::Result<Option<Vec<AccessEntry>>> {
    use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, GetAce,
        GetAclInformation, INHERITED_ACE,
    };
    let name = path_wide(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: a NUL-terminated path and valid out-pointers; sd is freed below.
    let code = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if code != 0 {
        return Err(std::io::Error::from_raw_os_error(code as i32));
    }
    let read = || -> std::io::Result<Option<Vec<AccessEntry>>> {
        if dacl.is_null() {
            return Ok(None);
        }
        // SAFETY: a zeroed size structure is valid output space.
        let mut size: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: dacl points into sd; the structure and its size match the class.
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(last_error());
        }
        let mut out = Vec::new();
        for i in 0..size.AceCount {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            // SAFETY: i is below the ACL's count; ace receives a pointer into the ACL.
            if unsafe { GetAce(dacl, i, &mut ace) } == 0 {
                return Err(last_error());
            }
            // SAFETY: every ACE starts with its header.
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            // access allowed/denied and their audit/alarm kin (types 0 to 3) keep the SID after
            // the 4-byte header and the 4-byte mask; the object kinds a file never carries do not
            let sid = if header.AceType <= 3 {
                // SAFETY: the SID of such an ACE starts 8 bytes in, within AceSize.
                let p = unsafe { (ace as *mut u8).add(8) } as *mut core::ffi::c_void;
                let mut text: *mut u16 = std::ptr::null_mut();
                // SAFETY: a SID inside the ACL; text is freed below.
                let s = if unsafe { ConvertSidToStringSidW(p, &mut text) } != 0 {
                    // SAFETY: a NUL-terminated string allocated by the call above.
                    let s = unsafe { from_wide(text) };
                    unsafe { LocalFree(text as _) };
                    Some(s)
                } else {
                    None
                };
                let principal = sid_principal(p, &s);
                (s, principal)
            } else {
                (None, format!("an entry of type {}", header.AceType))
            };
            out.push(AccessEntry {
                principal: sid.1,
                sid: sid.0,
                inherited: u32::from(header.AceFlags) & INHERITED_ACE != 0,
            });
        }
        Ok(Some(out))
    };
    let result = read();
    // SAFETY: allocated by GetNamedSecurityInfoW and not used after this.
    unsafe { LocalFree(sd as _) };
    result
}

/// The file's access list as SDDL (`D:P(A;;FA;;;S-1-...)`), for the tests that compare it with
/// what icacls leaves.
pub fn dacl_sddl(path: &std::path::Path) -> std::io::Result<String> {
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{ACL, DACL_SECURITY_INFORMATION};
    let name = path_wide(path);
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: as in access_entries.
    let code = unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if code != 0 {
        return Err(std::io::Error::from_raw_os_error(code as i32));
    }
    let mut text: *mut u16 = std::ptr::null_mut();
    // SAFETY: sd is the descriptor just read; text is freed below.
    let ok = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            sd,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut text,
            std::ptr::null_mut(),
        )
    };
    let result = if ok == 0 {
        Err(last_error())
    } else {
        // SAFETY: a NUL-terminated string allocated by the call above.
        let s = unsafe { from_wide(text) };
        unsafe { LocalFree(text as _) };
        Ok(s)
    };
    // SAFETY: allocated by GetNamedSecurityInfoW.
    unsafe { LocalFree(sd as _) };
    result
}

/// A server end of a named pipe, waiting for its client.
#[derive(Debug)]
pub struct PipeServer {
    name: Vec<u16>,
    // a security descriptor built once and kept for the life of the process
    descriptor: usize,
}

impl PipeServer {
    pub fn new(name: &str) -> Result<PipeServer, String> {
        let sddl = wide(&pipe_sddl(&user_sid()?));
        let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: valid NUL-terminated string and out-pointer; the descriptor is never freed.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(format!(
                "cannot build the control pipe's permissions: {}",
                last_error()
            ));
        }
        Ok(PipeServer {
            name: wide(name),
            descriptor: sd as usize,
        })
    }

    /// One pipe instance. `first` claims the name: it fails (access denied) while another
    /// process holds an instance of the same name, as libuv's EADDRINUSE does.
    pub fn instance(&self, first: bool) -> std::io::Result<OwnedHandle> {
        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor as _,
            bInheritHandle: 0,
        };
        let open = PIPE_ACCESS_DUPLEX | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
        // SAFETY: valid name, attributes alive for the call; the result is checked.
        let h = unsafe {
            CreateNamedPipeW(
                self.name.as_ptr(),
                open,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                65536,
                65536,
                0,
                &attrs,
            )
        };
        owned(h).ok_or_else(last_error)
    }
}

/// Blocks until a client connects to `pipe`.
pub fn wait_for_client(pipe: &OwnedHandle) -> std::io::Result<()> {
    // SAFETY: a valid pipe handle, synchronous mode (no OVERLAPPED).
    if unsafe { ConnectNamedPipe(pipe.as_raw_handle() as HANDLE, std::ptr::null_mut()) } != 0 {
        return Ok(());
    }
    // SAFETY: plain call.
    let code = unsafe { GetLastError() };
    if code == ERROR_PIPE_CONNECTED {
        Ok(()) // the client was quicker than the call
    } else {
        Err(std::io::Error::from_raw_os_error(code as i32))
    }
}

#[allow(dead_code)]
fn close(h: HANDLE) {
    // SAFETY: only called with handles this module opened.
    unsafe { CloseHandle(h) };
}

/// The user's `Path` as stored under `HKCU\Environment`: its text and whether it is
/// `REG_EXPAND_SZ`. `Ok(None)` when the user has no `Path` value of their own.
pub fn read_user_path() -> std::io::Result<Option<(String, bool)>> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, RegCloseKey, RegOpenKeyExW,
    };
    let sub = wide("Environment");
    let name = wide("Path");
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: NUL-terminated strings and an out-pointer.
    let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_QUERY_VALUE, &mut key) };
    if r == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    let result = query_path(key, &name);
    // SAFETY: the key opened above.
    unsafe { RegCloseKey(key) };
    result
}

fn query_path(
    key: windows_sys::Win32::System::Registry::HKEY,
    name: &[u16],
) -> std::io::Result<Option<(String, bool)>> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{REG_EXPAND_SZ, REG_SZ, RegQueryValueExW};
    let mut kind = 0u32;
    let mut bytes = 0u32;
    // SAFETY: an open key, a NUL-terminated name, and out-pointers; a null data pointer asks
    // for the size only.
    let r = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    if r == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return Err(std::io::Error::other(format!(
            "HKCU\\Environment\\Path has type {kind}"
        )));
    }
    let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `size` bytes.
    let r = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    buf.truncate((size as usize) / 2);
    // the value ends at its first NUL; anything after one is not part of the PATH
    if let Some(end) = buf.iter().position(|&c| c == 0) {
        buf.truncate(end);
    }
    // never lossy: a PATH that is written back must be the user's, character for character
    let text = String::from_utf16(&buf)
        .map_err(|_| std::io::Error::other("HKCU\\Environment\\Path is not valid UTF-16; left as it is"))?;
    Ok(Some((text, kind == REG_EXPAND_SZ)))
}

/// Writes the user's `Path` (`REG_EXPAND_SZ` when `expand`), then tells running programs, the
/// shell among them, that the environment changed, so a terminal opened next sees it.
pub fn write_user_path(value: &str, expand: bool) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ, RegCloseKey, RegOpenKeyExW,
        RegSetValueExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };
    let sub = wide("Environment");
    let name = wide("Path");
    let data = wide(value);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: NUL-terminated strings and an out-pointer.
    let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_SET_VALUE, &mut key) };
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    let kind = if expand { REG_EXPAND_SZ } else { REG_SZ };
    // SAFETY: an open key; `data` is NUL-terminated and its byte length includes the terminator.
    let r = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            kind,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    // SAFETY: the key opened above.
    unsafe { RegCloseKey(key) };
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    let what = wide("Environment");
    let mut ignored = 0usize;
    // SAFETY: a broadcast with a NUL-terminated string that outlives the call (the call returns
    // after every window answered or the timeout passed); a window that hangs is skipped.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            what.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut ignored,
        )
    };
    Ok(())
}

/// `%NAME%` references in `s` expanded from this process's environment.
pub fn expand_env(s: &str) -> String {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    if !s.contains('%') {
        return s.to_string();
    }
    let src = wide(s);
    let mut buf = vec![0u16; 1024];
    loop {
        // SAFETY: a NUL-terminated source and a destination of `buf.len()` characters.
        let n =
            unsafe { ExpandEnvironmentStringsW(src.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
        if n == 0 {
            return s.to_string();
        }
        if n <= buf.len() {
            buf.truncate(n.saturating_sub(1));
            return String::from_utf16_lossy(&buf);
        }
        buf.resize(n, 0);
    }
}

const RUN_ONCE: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";

/// The longest command line Windows runs from a `Run` or `RunOnce` value.
pub const RUN_ONCE_MAX: usize = 260;

/// Renames over `to` and does not return before the change is on the disk, so the new name
/// survives a power cut (`MOVEFILE_WRITE_THROUGH`).
pub fn rename_durable(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let w = |p: &std::path::Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (w(from), w(to));
    // SAFETY: two NUL-terminated paths.
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// A command Windows runs once at this user's next sign-in (`HKCU\...\RunOnce`, removed by
/// Windows as it runs it). Setting the same name again replaces the command.
pub fn run_once_set(name: &str, command: &str) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegSetValueExW,
    };
    if command.encode_utf16().count() > RUN_ONCE_MAX {
        return Err(std::io::Error::other("the command is too long for RunOnce"));
    }
    let sub = wide(RUN_ONCE);
    let name = wide(name);
    let data = wide(command);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: NUL-terminated strings and out-pointers; no class, no security attributes.
    let r = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    // SAFETY: an open key; `data` is NUL-terminated and its byte length includes the terminator.
    let r = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            REG_SZ,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    // SAFETY: the key opened above.
    unsafe { RegCloseKey(key) };
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    Ok(())
}

/// Removes a [`run_once_set`] command; fine when it is not there (Windows ran it, or none was set).
pub fn run_once_remove(name: &str) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, RegCloseKey, RegDeleteValueW, RegOpenKeyExW,
    };
    let sub = wide(RUN_ONCE);
    let name = wide(name);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: NUL-terminated strings and an out-pointer.
    let r = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_SET_VALUE, &mut key) };
    if r == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if r != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    // SAFETY: an open key and a NUL-terminated name.
    let r = unsafe { RegDeleteValueW(key, name.as_ptr()) };
    // SAFETY: the key opened above.
    unsafe { RegCloseKey(key) };
    if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
        return Err(std::io::Error::from_raw_os_error(r as i32));
    }
    Ok(())
}

/// Whether this session is ending (shutdown, restart or sign-out under way): a program started
/// now is ended a moment later.
pub fn session_ending() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SHUTTINGDOWN};
    // SAFETY: no arguments beyond the metric's index.
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

/// Lets go of this process's console. A console program Windows starts at sign-in is given a
/// window of its own; this closes it (the programs it starts are started without one).
pub fn detach_console() {
    use windows_sys::Win32::System::Console::FreeConsole;
    // SAFETY: no arguments; failing (no console) changes nothing.
    unsafe { FreeConsole() };
}

/// How far local time is ahead of UTC at `utc_secs`, in seconds, by the system's zone with its
/// rules for that year. 0 outside the years Windows can convert (1601 to 30827).
pub fn local_offset_secs(utc_secs: i64) -> i64 {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::Time::{
        DYNAMIC_TIME_ZONE_INFORMATION, GetDynamicTimeZoneInformation, SystemTimeToTzSpecificLocalTimeEx,
    };
    let days = utc_secs.div_euclid(86_400);
    let sod = utc_secs.rem_euclid(86_400);
    let (y, m, d) = crate::time::civil_from_days(days);
    if !(1601..=30827).contains(&y) {
        return 0;
    }
    let utc = SYSTEMTIME {
        wYear: y as u16,
        wMonth: m as u16,
        wDayOfWeek: 0,
        wDay: d as u16,
        wHour: (sod / 3600) as u16,
        wMinute: (sod % 3600 / 60) as u16,
        wSecond: (sod % 60) as u16,
        wMilliseconds: 0,
    };
    // SAFETY: zeroed structures are valid output space; the pointers live through the calls.
    let mut zone: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    unsafe { GetDynamicTimeZoneInformation(&mut zone) };
    let mut local = SYSTEMTIME::default();
    if unsafe { SystemTimeToTzSpecificLocalTimeEx(&zone, &utc, &mut local) } == 0 {
        return 0;
    }
    let local_days = crate::time::days_from_civil(
        i64::from(local.wYear),
        u32::from(local.wMonth),
        u32::from(local.wDay),
    );
    let local_secs = local_days * 86_400
        + i64::from(local.wHour) * 3600
        + i64::from(local.wMinute) * 60
        + i64::from(local.wSecond);
    local_secs - utc_secs
}

/// `os.networkInterfaces()`: each adapter that is up, by its friendly name ("Ethernet",
/// "vEthernet (WSL)"), with its unicast addresses, as libuv lists them.
pub fn network_interfaces() -> Vec<(String, Vec<super::InterfaceAddress>)> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, GetAdaptersAddresses,
        IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, AF_UNSPEC};
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u64>;
    loop {
        // u64 storage keeps the structures aligned
        buf = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: the buffer holds `size` bytes; the call says how many it needs if not.
        let code = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC),
                flags,
                std::ptr::null(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match code {
            0 => break,
            // ERROR_BUFFER_OVERFLOW: size now holds what is needed
            111 => continue,
            _ => return Vec::new(),
        }
    }
    let mut out: Vec<(String, Vec<super::InterfaceAddress>)> = Vec::new();
    let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !cur.is_null() {
        // SAFETY: a node of the list the call wrote into buf, alive here.
        let a = unsafe { &*cur };
        cur = a.Next;
        if a.OperStatus != IfOperStatusUp || a.FriendlyName.is_null() {
            continue;
        }
        // SAFETY: a NUL-terminated name in buf.
        let name = unsafe { from_wide(a.FriendlyName) };
        let internal = a.IfType == IF_TYPE_SOFTWARE_LOOPBACK;
        let mut addrs = Vec::new();
        let mut u = a.FirstUnicastAddress;
        while !u.is_null() {
            // SAFETY: a unicast entry in buf.
            let ua = unsafe { &*u };
            u = ua.Next;
            let sa = ua.Address.lpSockaddr as *const u8;
            if sa.is_null() {
                continue;
            }
            // SAFETY: a sockaddr whose family is its first u16.
            let fam = unsafe { *(sa as *const u16) };
            let address = if fam == AF_INET {
                // SAFETY: a SOCKADDR_IN: family, port, then the address.
                let b = unsafe { std::slice::from_raw_parts(sa.add(4), 4) };
                std::net::IpAddr::from([b[0], b[1], b[2], b[3]])
            } else if fam == AF_INET6 {
                // SAFETY: a SOCKADDR_IN6: family, port, flow info, then the address.
                let b = unsafe { std::slice::from_raw_parts(sa.add(8), 16) };
                let mut x = [0u8; 16];
                x.copy_from_slice(b);
                std::net::IpAddr::from(x)
            } else {
                continue;
            };
            addrs.push(super::InterfaceAddress {
                address: address.to_string(),
                ipv4: address.is_ipv4(),
                internal,
            });
        }
        if addrs.is_empty() {
            continue;
        }
        match out.iter_mut().find(|(n, _)| *n == name) {
            Some((_, list)) => list.extend(addrs),
            None => out.push((name, addrs)),
        }
    }
    out
}

/// Whether two names are one file (the volume and the file index), as libuv's copyfile checks
/// before copying: copying a file onto itself would empty it.
pub fn same_file(a: &std::path::Path, b: &std::path::Path) -> bool {
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let id = |p: &std::path::Path| -> Option<(u32, u32, u32)> {
        let f = std::fs::File::open(p).ok()?;
        // SAFETY: a plain-data struct the call fills, for a handle that stays open meanwhile
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
        (ok != 0).then_some((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
    };
    matches!((id(a), id(b)), (Some(x), Some(y)) if x == y)
}

/// `sameEntry(a, b)` (manage.mjs): two names for one file or folder (the volume and the file
/// index, as Node's `statSync` reports `dev` and `ino`); a folder is opened with backup
/// semantics, which a plain open refuses.
pub fn same_entry(a: &std::path::Path, b: &std::path::Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, GetFileInformationByHandle,
    };
    let id = |p: &std::path::Path| -> Option<(u32, u32, u32)> {
        let f = std::fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(p)
            .ok()?;
        // SAFETY: a plain-data struct the call fills, for a handle that stays open meanwhile
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle() as _, &mut info) };
        (ok != 0).then_some((info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
    };
    matches!((id(a), id(b)), (Some(x), Some(y)) if x == y && (x.1, x.2) != (0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

    #[test]
    fn a_forwarder_with_no_console_starts_its_child_without_a_window() {
        assert_eq!(no_new_window_flag(false), CREATE_NO_WINDOW);
        // one with a console (a terminal, this test runner) lets the child share it
        assert_eq!(no_new_window_flag(true), 0);
    }

    #[test]
    fn the_no_window_forwarder_still_passes_the_exit_code_back() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/d", "/c", "exit 7"]);
        assert_eq!(run_in_kill_job_no_new_window(cmd).unwrap(), 7);
    }

    #[test]
    fn the_pipe_admits_this_user_alone() {
        let sid = user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        let name = format!(r"\\.\pipe\spawnloft-dacl-test-{}", std::process::id());
        let server = PipeServer::new(&name).unwrap();
        let pipe = server.instance(true).unwrap();
        // a second claim of the same name is refused while this one is held
        assert!(server.instance(true).is_err());
        let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
        let rc = unsafe {
            GetSecurityInfo(
                pipe.as_raw_handle() as HANDLE,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut sd,
            )
        };
        assert_eq!(rc, 0);
        let mut text: *mut u16 = std::ptr::null_mut();
        let ok = unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(ok, 0);
        let sddl = unsafe { from_wide(text) };
        unsafe {
            LocalFree(text as _);
            LocalFree(sd as _);
        }
        assert!(sddl.starts_with("D:P"), "{sddl}");
        assert_eq!(sddl.matches("(A;").count(), 1, "{sddl}");
        // SDDL prints a well-known account by its alias: the built-in Administrator (RID 500,
        // which the CI runners use) as LA
        let trustee = if sid.ends_with("-500") {
            "LA".to_string()
        } else {
            sid.clone()
        };
        assert!(sddl.ends_with(&format!(";;;{trustee})")), "{sddl} for {sid}");
    }

    #[test]
    fn a_job_kill_takes_the_tree() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        prepare_server(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let tree = Tree::attach(&child);
        assert!(tree.fallback_reason.is_none(), "{:?}", tree.fallback_reason);
        tree.kill();
        let status = child.wait().unwrap();
        assert_eq!(status.code(), Some(1));
    }

    #[test]
    fn a_suspended_server_runs_once_attached() {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "exit 7"]);
        prepare_server(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let tree = Tree::attach(&child);
        assert!(tree.fallback_reason.is_none(), "{:?}", tree.fallback_reason);
        assert_eq!(child.wait().unwrap().code(), Some(7));
    }

    #[test]
    fn probes_this_process() {
        let mut p = ProcessProbe::open(std::process::id()).unwrap();
        match p.sample().unwrap() {
            Probe::Alive { bytes, .. } => assert!(bytes > 0),
            Probe::Gone => panic!("this process is alive"),
        }
    }
}
