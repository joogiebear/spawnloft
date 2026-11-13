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
    CloseHandle, ERROR_PIPE_CONNECTED, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    STILL_ACTIVE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
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
pub fn run_in_kill_job(mut cmd: Command) -> std::io::Result<i32> {
    cmd.creation_flags(CREATE_SUSPENDED);
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

fn open_query(pid: u32) -> Option<OwnedHandle> {
    if pid == 0 {
        return None;
    }
    // SAFETY: plain call; the result is checked and owned.
    owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
}

/// Whether `pid` names a process that has not exited. A process this user may not open (another
/// user's, a protected one) counts as alive: the pid is taken, which is all a caller can know.
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

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;

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
