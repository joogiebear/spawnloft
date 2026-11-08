//! The restart decision of `crashguard.mjs`, free of I/O. A requested stop stays stopped, so does a
//! clean exit; a crash restarts after a delay, and three crashes inside ten minutes give up.

pub const CRASH_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const CRASH_LIMIT: usize = 3;

/// Long enough for the port and world locks to be released; the environment override is for tests.
pub fn restart_delay_ms() -> u64 {
    crate::js::positive_env(&["SPAWNLOFT_RESTART_DELAY_MS", "MCCTL_RESTART_DELAY_MS"])
        .map(|n| n as u64)
        .unwrap_or(10_000)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    StayDown(&'static str),
    GiveUp { recent: usize },
    Restart { delay_ms: u64, recent: usize },
}

/// `crashes` includes the one being decided about: the caller records first, then asks.
pub fn verdict(
    enabled: bool,
    stopping: bool,
    code: Option<i64>,
    signal: Option<&str>,
    crashes: &[i64],
    now: i64,
    delay_ms: u64,
) -> Verdict {
    if stopping {
        return Verdict::StayDown("stop was requested");
    }
    if code == Some(0) && signal.is_none() {
        return Verdict::StayDown("clean exit");
    }
    if !enabled {
        return Verdict::StayDown("auto-restart is off");
    }
    let recent = crashes.iter().filter(|t| now - **t <= CRASH_WINDOW_MS).count();
    if recent >= CRASH_LIMIT {
        Verdict::GiveUp { recent }
    } else {
        Verdict::Restart { delay_ms, recent }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const NOW: i64 = 1_000_000_000;

    // the same cases as test/crashguard.test.mjs
    #[test]
    fn verdicts() {
        assert!(matches!(
            verdict(true, true, Some(137), None, &[NOW], NOW, 10),
            Verdict::StayDown(_)
        ));
        assert!(matches!(
            verdict(true, false, Some(0), None, &[], NOW, 10),
            Verdict::StayDown(_)
        ));
        assert!(matches!(
            verdict(false, false, Some(1), None, &[NOW], NOW, 10),
            Verdict::StayDown(_)
        ));
        assert_eq!(
            verdict(true, false, Some(1), None, &[NOW], NOW, 10),
            Verdict::Restart {
                delay_ms: 10,
                recent: 1
            }
        );
        assert!(matches!(
            verdict(true, false, None, Some("SIGKILL"), &[NOW], NOW, 10),
            Verdict::Restart { .. }
        ));
        let inside: Vec<i64> = (0..CRASH_LIMIT as i64).map(|i| NOW - i * 1000).collect();
        assert_eq!(
            verdict(true, false, Some(1), None, &inside, NOW, 10),
            Verdict::GiveUp { recent: CRASH_LIMIT }
        );
        let spread = [NOW - CRASH_WINDOW_MS - 1000, NOW - 5000, NOW];
        assert_eq!(
            verdict(true, false, Some(1), None, &spread, NOW, 10),
            Verdict::Restart {
                delay_ms: 10,
                recent: CRASH_LIMIT - 1
            }
        );
    }
}
