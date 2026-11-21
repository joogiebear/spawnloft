//! Running a helper program to completion within a time limit, its output read on threads so a
//! chatty child never blocks on a full pipe: what `spawnSync`, `execFile` and the engines'
//! `execute` and `runToFile` do in the Node core (C2's databases).

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How a program ended.
#[derive(Debug, Clone)]
pub struct Finished {
    /// exited 0, and within the time
    pub ok: bool,
    /// the exit code, `None` when a signal ended it
    pub code: Option<i32>,
    /// the time ran out and the program was killed
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn reader<R: Read + Send + 'static>(mut r: R, cap: Option<usize>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    // keep the tail, as `(stdout + c).slice(-32768)` does
                    if let Some(c) = cap
                        && out.len() > c * 2
                    {
                        out.drain(..out.len() - c);
                    }
                }
            }
        }
        if let Some(c) = cap
            && out.len() > c
        {
            out.drain(..out.len() - c);
        }
        let _ = tx.send(out);
    });
    rx
}

fn wait_within(child: &mut Child, timeout: Duration) -> (Option<ExitStatus>, bool) {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return (Some(s), false),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                return (child.wait().ok(), true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return (None, false),
        }
    }
}

fn finished(status: Option<ExitStatus>, timed_out: bool, stdout: Vec<u8>, stderr: Vec<u8>) -> Finished {
    let code = status.and_then(|s| s.code());
    Finished {
        ok: !timed_out && code == Some(0),
        code,
        timed_out,
        stdout,
        stderr,
    }
}

/// Runs `command` with no input, both outputs captured (the last `cap` bytes of each when
/// given), killed when `timeout` passes. An error is a program that could not start.
pub fn output_within_capped(
    mut command: Command,
    timeout: Duration,
    cap: Option<usize>,
) -> std::io::Result<Finished> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::platform::hide_window(&mut command);
    let mut child = command.spawn()?;
    let out = reader(child.stdout.take().expect("piped"), cap);
    let err = reader(child.stderr.take().expect("piped"), cap);
    let (status, timed_out) = wait_within(&mut child, timeout);
    // a grandchild holding the pipes is not waited for past a moment
    let grace = Duration::from_millis(if timed_out { 200 } else { 2000 });
    let stdout = out.recv_timeout(grace).unwrap_or_default();
    let stderr = err.recv_timeout(grace).unwrap_or_default();
    Ok(finished(status, timed_out, stdout, stderr))
}

/// [`output_within_capped`] with everything kept.
pub fn output_within(command: Command, timeout: Duration) -> std::io::Result<Finished> {
    output_within_capped(command, timeout, None)
}

/// `runToFile`'s plumbing: stdout into `stdout` (when given), stdin from `stdin` (when given),
/// stderr kept. Settles when the program has exited and its output has been handed over. An
/// error writing the output ends the program and is reported as `Err(Write(..))`.
#[derive(Debug)]
pub enum ToFileError {
    Spawn(std::io::Error),
    Write(std::io::Error),
    Read(std::io::Error),
}

pub fn run_to_file(
    mut command: Command,
    stdout: Option<&mut dyn Write>,
    stdin: Option<std::fs::File>,
) -> Result<Finished, ToFileError> {
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if stdout.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped());
    crate::platform::hide_window(&mut command);
    let mut child = command.spawn().map_err(ToFileError::Spawn)?;
    let err = reader(child.stderr.take().expect("piped"), None);
    // a client that rejects the login exits while its input is still being fed (EPIPE): its
    // exit code reports that, so a write error here is not a second failure
    let feeder = match (stdin, child.stdin.take()) {
        (Some(mut file), Some(mut pipe)) => {
            let (tx, rx) = mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 64 * 1024];
                loop {
                    match file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if pipe.write_all(&buf[..n]).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(e);
                            break;
                        }
                    }
                }
            });
            Some(rx)
        }
        _ => None,
    };
    if let (Some(sink), Some(mut out)) = (stdout, child.stdout.take()) {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match out.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(e) = sink.write_all(&buf[..n]) {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(ToFileError::Write(e));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    }
    let status = child.wait().ok();
    if let Some(rx) = feeder
        && let Ok(e) = rx.try_recv()
    {
        return Err(ToFileError::Read(e));
    }
    let stderr = err.recv().unwrap_or_default();
    Ok(finished(status, false, Vec::new(), stderr))
}

/// A command for `cmd` with `args`, the overrides `env` on top of this process's environment
/// (a `None` value removes a variable), in `cwd` when given.
pub fn command(cmd: &str, args: &[String], env: &[(String, String)], cwd: Option<&Path>) -> Command {
    let mut c = Command::new(cmd);
    c.args(args);
    for (k, v) in env {
        c.env(k, v);
    }
    for k in ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"] {
        if !env.iter().any(|(n, _)| n == k) {
            c.env_remove(k);
        }
    }
    if let Some(d) = cwd {
        c.current_dir(d);
    }
    c
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn output_is_captured_and_the_time_is_kept() {
        let mut c = Command::new("sh");
        c.args(["-c", "echo out; echo err >&2; exit 3"]);
        let f = output_within(c, Duration::from_secs(5)).unwrap();
        assert_eq!((f.ok, f.code, f.timed_out), (false, Some(3), false));
        assert_eq!(f.stdout, b"out\n");
        assert_eq!(f.stderr, b"err\n");
        let mut slow = Command::new("sleep");
        slow.arg("5");
        let t = output_within(slow, Duration::from_millis(100)).unwrap();
        assert!(t.timed_out && !t.ok);
        let mut big = Command::new("sh");
        big.args(["-c", "head -c 100000 /dev/zero"]);
        let b = output_within_capped(big, Duration::from_secs(5), Some(1000)).unwrap();
        assert_eq!(b.stdout.len(), 1000);
    }

    #[test]
    fn a_file_goes_through() {
        let dir = std::env::temp_dir().join(format!("sl-procx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("in.txt");
        std::fs::write(&input, "hello\n").unwrap();
        let mut c = Command::new("cat");
        c.arg("-");
        let mut sink: Vec<u8> = Vec::new();
        let f = run_to_file(c, Some(&mut sink), Some(std::fs::File::open(&input).unwrap()))
            .ok()
            .unwrap();
        assert!(f.ok);
        assert_eq!(sink, b"hello\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
