//! Which process a state file's pid names (design section 4, D4).
//!
//! Windows reuses pids within minutes, so a pid alone proves nothing. 1.x and the Node core
//! compare the image's file name with the `daemonExe` basename the state file recorded; that rule
//! depends on which API reports the name of a running image that an update renamed. 2.0's daemon
//! also records `daemonStartTime`, the kernel's creation time of its own process, and readers
//! here check (pid, creation time) first, falling back to the file-name rule for records without
//! the field (1.x, older 2.0 internal builds).

use crate::platform;

/// Whether `pid` is alive.
pub fn alive(pid: u32) -> bool {
    platform::pid_alive(pid)
}

/// The kernel creation time of `pid` as an opaque integer (Windows FILETIME, Linux clock ticks
/// since boot), `None` where the system does not say or the process cannot be opened.
pub fn start_time(pid: u32) -> Option<u64> {
    platform::process_start_time(pid)
}

/// This process's own creation time, for the state file.
pub fn own_start_time() -> Option<u64> {
    start_time(std::process::id())
}

/// The running image's full path, as the system reports it now.
pub fn image(pid: u32) -> Option<String> {
    platform::process_image(pid)
}

/// File names compare case-insensitively and without `.exe`, as `sameImage` in util.mjs does.
pub fn same_image(actual: &str, expected: &str) -> bool {
    let strip = |s: &str| {
        let base = s.rsplit(['/', '\\']).next().unwrap_or(s).to_ascii_lowercase();
        base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
    };
    strip(actual) == strip(expected)
}

/// `daemonStartTime` as written (a decimal string; a number from a hand-made file also reads).
pub fn parse_start_time(v: Option<&serde_json::Value>) -> Option<u64> {
    match v? {
        serde_json::Value::String(s) => s.parse().ok(),
        serde_json::Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

/// What a state file says about one process.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recorded<'a> {
    pub pid: u32,
    /// `daemonExe` (a basename), if recorded.
    pub exe: Option<&'a str>,
    /// `daemonStartTime`, if recorded.
    pub start_time: Option<u64>,
}

/// The decision, separated from the system calls so it can be tested anywhere.
pub fn matches(rec: &Recorded<'_>, alive: bool, start: Option<u64>, image: Option<&str>) -> bool {
    if rec.pid == 0 || !alive {
        return false;
    }
    if let (Some(want), Some(got)) = (rec.start_time, start) {
        return want == got;
    }
    match (rec.exe, image) {
        (Some(want), Some(got)) => same_image(got, want),
        // nothing to compare against: trust the live pid, as util.mjs does
        _ => true,
    }
}

/// Whether the recorded process is the one running under that pid now.
pub fn same_process(rec: &Recorded<'_>) -> bool {
    if rec.pid == 0 {
        return false;
    }
    let live = alive(rec.pid);
    let start = if rec.start_time.is_some() {
        start_time(rec.pid)
    } else {
        None
    };
    let img = if rec.start_time.is_none() || start.is_none() {
        image(rec.pid)
    } else {
        None
    };
    matches(rec, live, start, img.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(exe: Option<&str>, start: Option<u64>) -> Recorded<'_> {
        Recorded {
            pid: 42,
            exe,
            start_time: start,
        }
    }

    #[test]
    fn creation_time_decides_when_both_sides_have_it() {
        // the renamed image is irrelevant once the creation time matches
        assert!(matches(
            &rec(Some("spawnloft-core.exe"), Some(7)),
            true,
            Some(7),
            Some(r"C:\x\old-1\spawnloft-core.old-9.exe")
        ));
        // a reused pid with the right file name is still another process
        assert!(!matches(
            &rec(Some("spawnloft-core.exe"), Some(7)),
            true,
            Some(8),
            Some(r"C:\x\spawnloft-core.exe")
        ));
    }

    #[test]
    fn file_name_rule_for_records_without_the_field() {
        assert!(matches(
            &rec(Some("SpawnLoft.exe"), None),
            true,
            None,
            Some(r"C:\Users\u\AppData\Local\Programs\SpawnLoft\SpawnLoft.exe")
        ));
        assert!(matches(
            &rec(Some("spawnloft-core"), None),
            true,
            None,
            Some("/opt/x/spawnloft-core")
        ));
        assert!(!matches(
            &rec(Some("SpawnLoft.exe"), None),
            true,
            None,
            Some(r"C:\Windows\notepad.exe")
        ));
        // start time recorded but the process cannot be opened: fall back to the name
        assert!(matches(
            &rec(Some("a.exe"), Some(1)),
            true,
            None,
            Some(r"D:\A.EXE")
        ));
    }

    #[test]
    fn start_time_field() {
        use serde_json::json;
        assert_eq!(
            parse_start_time(Some(&json!("133456789012345678"))),
            Some(133456789012345678)
        );
        assert_eq!(parse_start_time(Some(&json!(5))), Some(5));
        assert_eq!(parse_start_time(Some(&json!("x"))), None);
        assert_eq!(parse_start_time(None), None);
    }

    #[test]
    fn dead_or_unknown() {
        assert!(!matches(&rec(Some("a"), None), false, None, Some("a")));
        assert!(!matches(&Recorded::default(), true, None, None));
        assert!(matches(&rec(None, None), true, None, None));
    }

    #[test]
    fn this_process_matches_itself() {
        let me = std::process::id();
        assert!(alive(me));
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_string_lossy().into_owned();
        let start = own_start_time();
        if cfg!(any(windows, target_os = "linux")) {
            assert!(start.is_some(), "no creation time for this process");
        }
        assert!(same_process(&Recorded {
            pid: me,
            exe: Some(&name),
            start_time: start
        }));
        if let Some(s) = start {
            assert!(!same_process(&Recorded {
                pid: me,
                exe: Some(&name),
                start_time: Some(s + 1)
            }));
        }
    }
}
