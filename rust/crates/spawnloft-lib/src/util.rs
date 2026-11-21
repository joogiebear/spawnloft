//! The parts of `util.mjs` the lifecycle and database commands need (C2): labels, passwords,
//! free ports, timers with JavaScript's `setTimeout` arithmetic, and killing a process tree.

use std::time::Duration;

use crate::failure::Failure;
use crate::js;

/// `cleanLabel(raw)`: whitespace runs as one space, control characters dropped, trimmed, at most
/// 48 UTF-16 units and trimmed again; `None` when nothing is left.
pub fn clean_label(raw: &str) -> Option<String> {
    let mut squashed = String::with_capacity(raw.len());
    let mut in_space = false;
    for c in raw.chars() {
        if js::is_js_space(c) {
            if !in_space {
                squashed.push(' ');
            }
            in_space = true;
        } else {
            squashed.push(c);
            in_space = false;
        }
    }
    let no_controls: String = squashed
        .chars()
        .filter(|&c| !(c <= '\u{1f}' || c == '\u{7f}'))
        .collect();
    let trimmed = js::trim(&no_controls);
    let units: Vec<u16> = trimmed.encode_utf16().take(48).collect();
    let cut = String::from_utf16_lossy(&units);
    let label = js::trim(&cut).to_string();
    (!label.is_empty()).then_some(label)
}

const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/// `randomPassword(len)`: each random byte modulo the 57-letter alphabet, as util.mjs does.
pub fn random_password(len: usize) -> Result<String, Failure> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|e| Failure::Internal {
        head: "Error".into(),
        message: format!("the system gave no random bytes: {e}"),
        code: None,
    })?;
    Ok(bytes
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect())
}

/// `isPortFree(port, host)`: whether a listener can be opened there now.
pub fn is_port_free(port: u16, host: &str) -> bool {
    std::net::TcpListener::bind((host, port)).is_ok()
}

/// `findFreePort(start, taken)`: the first port from `start` (500 tried) that no record takes and
/// nothing listens on.
pub fn find_free_port(start: f64, taken: &[f64]) -> Result<u16, Failure> {
    let mut port = start;
    while port < start + 500.0 {
        if !taken.contains(&port)
            && port.fract() == 0.0
            && (0.0..=65535.0).contains(&port)
            && is_port_free(port as u16, "127.0.0.1")
        {
            return Ok(port as u16);
        }
        port += 1.0;
    }
    Err(Failure::user(format!(
        "no free port found in range {}-{}",
        js::number_to_string(start),
        js::number_to_string(start + 500.0)
    )))
}

/// The delay `setTimeout(fn, ms)` really waits: Node treats anything not a number from 1 to
/// 2^31-1 (NaN, 0, negative, too large) as 1 ms.
pub fn timer(ms: f64) -> Duration {
    if ms.is_finite() && (1.0..=2_147_483_647.0).contains(&ms) {
        Duration::from_micros((ms.trunc() * 1000.0) as u64)
    } else {
        Duration::from_millis(1)
    }
}

/// `sleep(ms)`.
pub fn sleep(ms: f64) {
    std::thread::sleep(timer(ms));
}

/// `Date.now()` as a JavaScript number.
pub fn now() -> f64 {
    crate::time::now_ms() as f64
}

/// supervisor.mjs `killTree`'s kill: `killProcessGroup(pid)` on Unix (the group, else the
/// process); `taskkill /PID <pid> /T /F`, not waited for, on Windows.
pub fn kill_tree(pid: i32) {
    #[cfg(unix)]
    {
        crate::platform::kill_group(pid);
    }
    #[cfg(windows)]
    {
        if pid > 0 {
            crate::platform::kill_tree_pid(pid as u32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_clean_as_util_mjs_does() {
        assert_eq!(clean_label("  a\t\n b  "), Some("a b".into()));
        assert_eq!(clean_label("\u{1}\u{7f}"), None);
        assert_eq!(clean_label(""), None);
        let long = "x".repeat(60);
        assert_eq!(clean_label(&long).unwrap().len(), 48);
        // trimmed after the cut
        let edge = format!("{} y", "x".repeat(47));
        assert_eq!(clean_label(&edge), Some("x".repeat(47)));
        // a pair cut in half
        let emoji = format!("{}😀", "x".repeat(47));
        assert_eq!(clean_label(&emoji), Some(format!("{}\u{fffd}", "x".repeat(47))));
    }

    #[test]
    fn passwords_use_the_alphabet() {
        let p = random_password(24).unwrap();
        assert_eq!(p.len(), 24);
        assert!(p.bytes().all(|b| ALPHABET.contains(&b)));
    }

    #[test]
    fn timers_follow_set_timeout() {
        assert_eq!(timer(f64::NAN), Duration::from_millis(1));
        assert_eq!(timer(0.0), Duration::from_millis(1));
        assert_eq!(timer(-5.0), Duration::from_millis(1));
        assert_eq!(timer(3e9), Duration::from_millis(1));
        assert_eq!(timer(150.7), Duration::from_millis(150));
    }

    #[test]
    fn a_free_port_is_found_past_the_taken_ones() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = l.local_addr().unwrap().port();
        let got = find_free_port(f64::from(busy), &[]).unwrap();
        assert_ne!(got, busy);
        let skip = find_free_port(f64::from(busy) + 1.0, &[f64::from(busy) + 1.0]).unwrap();
        assert_ne!(skip, busy + 1);
    }
}
