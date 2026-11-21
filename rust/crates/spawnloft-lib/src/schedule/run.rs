//! `spawnSync` and `execFile` of the scheduler's programs, as the Node core runs them: a time
//! limit, both outputs as text, and a failure to start reported as Node words it.

use std::time::Duration;

/// What `spawnSync` answers.
#[derive(Debug, Clone, Default)]
pub struct Ran {
    /// `res.error`: the program could not start, or ran out of time (`code`, `message`)
    pub error: Option<(String, String)>,
    /// `res.status`
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    pub fn ok(&self) -> bool {
        self.error.is_none() && self.status == Some(0)
    }
    pub fn error_message(&self) -> Option<&str> {
        self.error.as_ref().map(|(_, m)| m.as_str())
    }
    pub fn error_code(&self) -> Option<&str> {
        self.error.as_ref().map(|(c, _)| c.as_str())
    }
}

/// Runs `program args` (through the parity rig's stand-in in a test build) with `env` added.
pub fn run(program: &str, args: &[String], timeout_ms: u64, env: &[(&str, &str)]) -> Ran {
    let mut cmd = crate::test_origins::scheduler_command(program);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    crate::platform::hide_window(&mut cmd);
    let shown = program.to_string();
    match crate::procx::output_within(cmd, Duration::from_millis(timeout_ms)) {
        Err(e) => {
            let code = crate::jspath::error_code(&e).0.to_string();
            Ran {
                error: Some((code.clone(), format!("spawnSync {shown} {code}"))),
                ..Ran::default()
            }
        }
        Ok(f) => Ran {
            error: f
                .timed_out
                .then(|| ("ETIMEDOUT".to_string(), format!("spawnSync {shown} ETIMEDOUT"))),
            status: if f.timed_out { None } else { f.code },
            stdout: String::from_utf8_lossy(&f.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&f.stderr).into_owned(),
        },
    }
}

/// `execFile(program, args, cb)` read as the Node core reads it: the output when the program
/// exited 0 in time, else nothing.
pub fn exec_file(program: &str, args: &[String], timeout_ms: u64, env: &[(&str, &str)]) -> Option<String> {
    let r = run(program, args, timeout_ms, env);
    r.ok().then_some(r.stdout)
}
