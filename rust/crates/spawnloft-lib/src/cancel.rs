//! `cancel.mjs`: stopping a long job part way (a create that is downloading or building, a game
//! launch that is installing).
//!
//! A job runs inside [`with_cancel`]. The slow steps underneath it (a download, a child process,
//! the gap between two stages) ask this module whether their job has been cancelled; they are not
//! each handed the token. Node carries the job's signal across awaits (AsyncLocalStorage); the
//! Rust core has no async runtime, so the job is the thread's: code under `with_cancel` on the
//! same thread finds it, code on another thread finds none unless it is handed [`current`] and
//! runs its own `with_cancel`. Code run outside any job finds none and behaves as it always has.
//!
//! A cancelled step fails with [`cancelled`] (`Cancelled`, code `cancelled`). What it had made so
//! far is its own to clear away (a `.part` file, a child process); what the job had made is the
//! job's.

use std::cell::RefCell;
use std::process::{Child, Command};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::failure::Failure;

/// A job's cancel signal (`AbortSignal`). Clones are the same signal.
#[derive(Debug, Clone, Default)]
pub struct Token(Arc<(Mutex<bool>, Condvar)>);

impl Token {
    pub fn new() -> Token {
        Token::default()
    }
    /// `controller.abort()`: every step waiting on this token wakes.
    pub fn cancel(&self) {
        let (lock, wake) = &*self.0;
        *lock.lock().unwrap_or_else(|p| p.into_inner()) = true;
        wake.notify_all();
    }
    /// `signal.aborted`.
    pub fn is_cancelled(&self) -> bool {
        *self.0.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// Sleeps for `wait` or until cancelled, whichever is first; whether it was cancelled.
    pub fn sleep(&self, wait: Duration) -> bool {
        let (lock, wake) = &*self.0;
        let deadline = Instant::now() + wait;
        let mut cancelled = lock.lock().unwrap_or_else(|p| p.into_inner());
        while !*cancelled {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            cancelled = wake
                .wait_timeout(cancelled, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        true
    }
}

thread_local! {
    static JOB: RefCell<Option<Token>> = const { RefCell::new(None) };
}

/// `new Cancelled()`.
pub fn cancelled() -> Failure {
    Failure::User {
        message: "Cancelled".into(),
        code: Some("cancelled".into()),
    }
}

/// `isCancelled(err)`.
pub fn is_cancelled(f: &Failure) -> bool {
    matches!(f, Failure::User { code: Some(c), .. } | Failure::Internal { code: Some(c), .. } if c == "cancelled")
}

/// `withCancel(signal, fn)`: runs `f` as a job that `token` can cancel (none: a job that cannot
/// be). The job before it is back in force when `f` returns or panics.
pub fn with_cancel<T>(token: Option<Token>, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<Token>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let before = self.0.take();
            JOB.with(|j| *j.borrow_mut() = before);
        }
    }
    let before = JOB.with(|j| j.replace(token));
    let _restore = Restore(before);
    f()
}

/// `cancelSignal()`: the token of the job this code is running in, or `None` outside one.
pub fn current() -> Option<Token> {
    JOB.with(|j| j.borrow().clone())
}

/// `checkCancelled()`: between two steps, stop here if the job has been cancelled.
pub fn check_cancelled() -> Result<(), Failure> {
    if current().is_some_and(|t| t.is_cancelled()) {
        return Err(cancelled());
    }
    Ok(())
}

/// A pause between two attempts that cancelling ends early, with `Cancelled`.
pub fn sleep(wait: Duration) -> Result<(), Failure> {
    match current() {
        Some(t) if t.sleep(wait) => Err(cancelled()),
        Some(_) => Ok(()),
        None => {
            std::thread::sleep(wait);
            Ok(())
        }
    }
}

/// `orCancelled(promise)`: what `answer` delivers, or `Cancelled`, whichever is first. The work
/// behind it is not stopped by this; use it where leaving that work to finish is fine. `None`
/// when the sender went away without an answer.
pub fn or_cancelled<T>(answer: &Receiver<T>) -> Result<Option<T>, Failure> {
    let Some(token) = current() else {
        return Ok(answer.recv().ok());
    };
    loop {
        if token.is_cancelled() {
            return Err(cancelled());
        }
        match answer.recv_timeout(Duration::from_millis(50)) {
            Ok(v) => return Ok(Some(v)),
            Err(RecvTimeoutError::Disconnected) => return Ok(None),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

/// `OWN_GROUP`: a child that a cancel must be able to end together with what it starts. Off
/// Windows it gets a process group of its own, which the signal is then sent to (Node's
/// `detached` also starts a session; the group is what the signal needs). On Windows taskkill
/// walks the tree by itself.
pub fn own_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// How long the tree has between being asked to end and being made to.
const HARD_AFTER: Duration = Duration::from_secs(4);

#[derive(Debug, Default)]
struct WatchState {
    finished: bool,
    stopped: bool,
}

/// What [`stop_on_cancel`] returns: call [`Stopper::finish`] once the child has been waited for.
#[derive(Debug)]
pub struct Stopper {
    shared: Option<Arc<(Mutex<WatchState>, Condvar)>>,
    watcher: Option<std::thread::JoinHandle<()>>,
}

impl Stopper {
    /// The child has exited and been waited for: the watch ends. Whether a cancel ended it, for
    /// the caller to tell a cancel from a failure.
    pub fn finish(mut self) -> bool {
        let Some(shared) = self.shared.take() else {
            return false;
        };
        let stopped = {
            let mut state = shared.0.lock().unwrap_or_else(|p| p.into_inner());
            state.finished = true;
            shared.1.notify_all();
            state.stopped
        };
        if let Some(w) = self.watcher.take() {
            let _ = w.join();
        }
        stopped
    }
}

impl Drop for Stopper {
    fn drop(&mut self) {
        if let Some(shared) = self.shared.take() {
            shared.0.lock().unwrap_or_else(|p| p.into_inner()).finished = true;
            shared.1.notify_all();
        }
    }
}

/// `stopOnCancel(child)`: ends `child`, and what it started, when the job is cancelled. `group`:
/// the child was started with [`own_group`], so its pid is its group's id (`inOwnGroup`). The
/// tree is asked first and told [`HARD_AFTER`] on, on every system: SIGTERM then SIGKILL to the
/// group off Windows; `taskkill /T /F` on Windows, with the child itself ended if taskkill is
/// missing or refuses.
pub fn stop_on_cancel(child: &Child, group: bool) -> Stopper {
    let Some(token) = current() else {
        return Stopper {
            shared: None,
            watcher: None,
        };
    };
    let pid = child.id();
    let shared = Arc::new((Mutex::new(WatchState::default()), Condvar::new()));
    let state = shared.clone();
    let watcher = std::thread::spawn(move || {
        let (lock, wake) = &*state;
        // wait for the cancel, or for the child to be done with
        loop {
            let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            if guard.finished {
                return;
            }
            if token.is_cancelled() {
                break;
            }
            let _ = wake.wait_timeout(guard, Duration::from_millis(50));
        }
        lock.lock().unwrap_or_else(|p| p.into_inner()).stopped = true;
        end_tree(pid, group, false);
        let deadline = Instant::now() + HARD_AFTER;
        let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        while !guard.finished {
            let now = Instant::now();
            if now >= deadline {
                drop(guard);
                end_tree(pid, group, true);
                return;
            }
            guard = wake
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    });
    Stopper {
        shared: Some(shared),
        watcher: Some(watcher),
    }
}

#[cfg(unix)]
fn end_tree(pid: u32, group: bool, hard: bool) {
    crate::platform::signal_tree(pid as i32, hard, group);
}

#[cfg(windows)]
fn end_tree(pid: u32, _group: bool, hard: bool) {
    if hard {
        crate::platform::terminate_pid(pid);
        return;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    crate::platform::hide_window(&mut cmd);
    // taskkill missing, or refusing: the child at least is ended
    match cmd.status() {
        Ok(s) if s.success() => {}
        _ => {
            crate::platform::terminate_pid(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_is_the_threads_and_ends_with_its_closure() {
        assert!(current().is_none());
        assert!(check_cancelled().is_ok());
        let token = Token::new();
        with_cancel(Some(token.clone()), || {
            assert!(check_cancelled().is_ok());
            // another thread is outside the job
            std::thread::spawn(|| assert!(current().is_none()))
                .join()
                .unwrap();
            token.cancel();
            let err = check_cancelled().unwrap_err();
            assert!(is_cancelled(&err));
            assert_eq!(err.stderr_text(), "error: Cancelled\n");
            assert_eq!(err.json_code(), "cancelled");
            // an inner job that cannot be cancelled
            with_cancel(None, || assert!(check_cancelled().is_ok()));
            assert!(check_cancelled().is_err());
        });
        assert!(current().is_none());
    }

    #[test]
    fn sleeping_ends_at_the_cancel() {
        let token = Token::new();
        let t = token.clone();
        let started = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            t.cancel();
        });
        let r = with_cancel(Some(token), || sleep(Duration::from_secs(20)));
        assert!(r.is_err_and(|e| is_cancelled(&e)));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn or_cancelled_answers_or_stops() {
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(5).unwrap();
        let token = Token::new();
        assert_eq!(
            with_cancel(Some(token.clone()), || or_cancelled(&rx)).unwrap(),
            Some(5)
        );
        token.cancel();
        assert!(with_cancel(Some(token), || or_cancelled(&rx)).is_err());
        drop(tx);
        assert_eq!(or_cancelled(&rx).unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_ends_the_childs_whole_group() {
        // the shell starts a grandchild in its group; ending the group ends both
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(std::process::Stdio::piped());
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(child.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        let token = Token::new();
        let stopper = with_cancel(Some(token.clone()), || stop_on_cancel(&child, true));
        let started = Instant::now();
        token.cancel();
        child.wait().unwrap();
        assert!(stopper.finish());
        assert!(started.elapsed() < Duration::from_secs(10));
        // the grandchild is gone too (its parent was the shell, so init reaps it)
        // (a zombie counts as gone: a container's first process may never reap it)
        let alive = || {
            crate::platform::pid_alive(grandchild)
                && !std::fs::read_to_string(format!("/proc/{grandchild}/stat")).is_ok_and(|s| {
                    s.rsplit(')')
                        .next()
                        .is_some_and(|r| r.trim_start().starts_with('Z'))
                })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(), "grandchild {grandchild} survived");
    }

    #[test]
    fn a_child_that_ends_by_itself_was_not_stopped() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit 0"]);
            c
        } else {
            Command::new("true")
        };
        own_group(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let stopper = with_cancel(Some(Token::new()), || stop_on_cancel(&child, true));
        child.wait().unwrap();
        assert!(!stopper.finish());
        // outside a job there is nothing to watch
        let mut child = cmd.spawn().unwrap();
        let stopper = stop_on_cancel(&child, true);
        child.wait().unwrap();
        assert!(!stopper.finish());
    }
}
