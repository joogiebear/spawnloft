//! The `\mcctl` Task Scheduler folder 1.x and 2.0 keep their scheduled tasks in.

use std::process::{Command, Stdio};

use super::Tasks;

/// The folder (1.x `schedule.mjs` TASK_FOLDER; 2.0 keeps it).
pub const FOLDER: &str = "mcctl";

/// Task Scheduler through PowerShell (to read the state as a number, not localized text) and
/// `schtasks` (to change it).
#[derive(Debug, Default)]
pub struct WindowsTasks;

/// Runs one PowerShell command and returns its output.
pub fn powershell(script: &str) -> Result<String, String> {
    let exe = std::env::var_os("SystemRoot")
        .map(|r| {
            std::path::PathBuf::from(r)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .filter(|p| p.is_file())
        .unwrap_or_else(|| "powershell.exe".into());
    let mut cmd = Command::new(exe);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .stdin(Stdio::null());
    hide(&mut cmd);
    let out = cmd.output().map_err(|e| format!("powershell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell exited {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn hide(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide(_cmd: &mut Command) {}

/// `name|state` lines; state 1 is Disabled (MSFT_ScheduledTask's TaskState).
pub fn parse_states(text: &str) -> Vec<(String, bool)> {
    text.lines()
        .filter_map(|l| {
            let (name, state) = l.trim().rsplit_once('|')?;
            let state: u32 = state.trim().parse().ok()?;
            (!name.is_empty()).then(|| (name.to_string(), state != 1))
        })
        .collect()
}

impl Tasks for WindowsTasks {
    fn enabled(&self) -> Result<Vec<String>, String> {
        if !cfg!(windows) {
            return Ok(Vec::new());
        }
        let out = powershell(&format!(
            "Get-ScheduledTask -TaskPath '\\{FOLDER}\\' -ErrorAction SilentlyContinue | \
             ForEach-Object {{ \"$($_.TaskName)|$([int]$_.State)\" }}"
        ))?;
        Ok(parse_states(&out)
            .into_iter()
            .filter(|(_, on)| *on)
            .map(|(n, _)| n)
            .collect())
    }

    fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
        let mut cmd = Command::new("schtasks");
        cmd.args([
            "/Change",
            "/TN",
            &format!("\\{FOLDER}\\{name}"),
            if enabled { "/ENABLE" } else { "/DISABLE" },
        ])
        .stdin(Stdio::null());
        hide(&mut cmd);
        let out = cmd.output().map_err(|e| format!("schtasks: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "schtasks exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states() {
        assert_eq!(
            parse_states("backup-a|3\r\nrestart-b|1\n\njunk\nx|y\n"),
            vec![("backup-a".to_string(), true), ("restart-b".to_string(), false)]
        );
    }
}
