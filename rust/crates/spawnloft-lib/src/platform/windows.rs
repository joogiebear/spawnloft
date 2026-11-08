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
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
    OpenProcessToken, OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, ResumeThread, THREAD_SUSPEND_RESUME,
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
