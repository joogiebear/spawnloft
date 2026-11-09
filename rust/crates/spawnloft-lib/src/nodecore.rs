//! The Node core the 2.0 package still carries in `resources/core/` until the core port (R4, R6)
//! lands: the seam through which `handover resume`, `repair` and `uninstall` reach the business
//! core today. When R4 lands these calls become in-process and this module goes.
//!
//! It runs on the system Node (found as the panel finds it); the shell has no Node of its own.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::handover::resume::Starter;
use crate::handover::{Kind, Log};

/// How long one `start` may take before it counts as failed (resume waits for ready: 180 s).
pub const START_TIMEOUT: Duration = Duration::from_secs(200);

#[derive(Debug, Clone)]
pub struct NodeCore {
    pub node: PathBuf,
    /// the folder holding spawnloft.mjs
    pub dir: PathBuf,
    /// for the registry check
    pub data_root: PathBuf,
}

/// `SPAWNLOFT_CORE_DIR`, else `<this binary's folder>/../core` (resources\bin -> resources\core).
pub fn core_dir() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("SPAWNLOFT_CORE_DIR").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.parent()?.join("core"))
}

impl NodeCore {
    pub fn find(data_root: &Path) -> Result<NodeCore, String> {
        let dir = core_dir().ok_or("the Node core folder could not be worked out")?;
        if !dir.join("spawnloft.mjs").is_file() {
            return Err(format!("{} is missing", dir.join("spawnloft.mjs").display()));
        }
        let node = crate::panel::find_node(None)
            .ok_or("Node.js was not found (needed until the Rust core port lands; install it, or set SPAWNLOFT_NODE)")?;
        Ok(NodeCore {
            node,
            dir,
            data_root: data_root.to_path_buf(),
        })
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.node);
        cmd.arg(self.dir.join("spawnloft.mjs"))
            .args(args)
            .current_dir(&self.dir)
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd
    }

    /// Runs one command with its output in the log (through a file: a daemon it starts inherits
    /// handles and would hold a pipe open). Returns the exit code and the output.
    pub fn run_logged(&self, args: &[&str], timeout: Duration, log: &Log) -> Result<(i32, String), String> {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let out_file = std::env::temp_dir().join(format!("spawnloft-core-{}-{n}.out", std::process::id()));
        let file = std::fs::File::create(&out_file).map_err(|e| e.to_string())?;
        let err = file.try_clone().map_err(|e| e.to_string())?;
        log.line(&format!("2.0: spawnloft {}", args.join(" ")));
        let mut child = self
            .command(args)
            .stdout(file)
            .stderr(err)
            .spawn()
            .map_err(|e| format!("{}: {e}", self.node.display()))?;
        let until = Instant::now() + timeout;
        let code = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s.code().unwrap_or(1)),
                Ok(None) if Instant::now() >= until => break None,
                Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                Err(_) => break Some(1),
            }
        };
        if code.is_none() {
            // the CLI process only; a daemon it started is a separate, detached process
            let _ = child.kill();
            let _ = child.wait();
        }
        let output = std::fs::read_to_string(&out_file).unwrap_or_default();
        let _ = std::fs::remove_file(&out_file);
        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            log.line(&format!("2.0| {line}"));
        }
        match code {
            Some(c) => Ok((c, output)),
            None => Err(format!("did not finish within {} s", timeout.as_secs())),
        }
    }

    /// Runs one command attached to this process's own stdio.
    pub fn run_inherit(&self, args: &[&str]) -> Result<i32, String> {
        let status = self
            .command(args)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| format!("{}: {e}", self.node.display()))?;
        Ok(status.code().unwrap_or(1))
    }
}

impl Starter for NodeCore {
    fn start(&self, name: &str, _kind: Kind, log: &Log) -> Result<(), String> {
        match self.run_logged(&["start", name, "--timeout", "180"], START_TIMEOUT, log)? {
            (0, _) => Ok(()),
            (code, out) => Err(format!(
                "exit {code}: {}",
                out.trim().lines().last().unwrap_or("")
            )),
        }
    }

    fn registered(&self) -> Option<BTreeSet<String>> {
        let text = std::fs::read_to_string(self.data_root.join("instances.json")).ok()?;
        let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
        Some(v.get("instances")?.as_object()?.keys().cloned().collect())
    }
}
