//! TPS and player counts, read over RCON every ten seconds for the metrics history (`tick.mjs`).
//! One standing connection: every connection the server accepts logs two console lines, which at
//! one reading per ten seconds would flood the console.

use regex::Regex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::rcon::{Rcon, RconError, strip_colors};

/// Paper answers `tps` and `mspt`; vanilla and Fabric answer `tick query`.
pub const TICK_COMMANDS: [&str; 3] = ["tps", "mspt", "tick query"];

static REFUSED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)unknown|incorrect argument|<--\[HERE\]").expect("pattern"));
static PAPER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)TPS from last[^:]*:\s*\*?([0-9]+(?:\.[0-9]+)?)").expect("pattern"));
static FROZEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)frozen").expect("pattern"));
static RATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Target tick rate:\s*([0-9]+(?:\.[0-9]+)?)").expect("pattern"));
static AVG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Average time per tick:\s*([0-9]+(?:\.[0-9]+)?)\s*ms").expect("pattern")
});
static LIST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)There (?:are|is) ([0-9]+)\s*(?:/\s*|of a max(?:imum)? of |out of (?:a )?maximum(?: of)? )([0-9]+)").expect("pattern")
});

fn round2(n: f64) -> f64 {
    // Math.round rounds halves up, f64::round away from zero; the same for positive figures
    (n * 100.0).round() / 100.0
}

/// Asks the tick commands in order, stopping at the first family that answers.
pub fn read_tick(mut send: impl FnMut(&str) -> Result<String, RconError>) -> Option<f64> {
    let mut tps_reply: Option<String> = None;
    let mut query_reply: Option<String> = None;
    for cmd in TICK_COMMANDS {
        if let Ok(raw) = send(cmd) {
            let text = strip_colors(&raw).trim().to_string();
            if !text.is_empty() && !REFUSED.is_match(&text) {
                match cmd {
                    "tps" => tps_reply = Some(text),
                    "tick query" => query_reply = Some(text),
                    _ => {}
                }
            }
        }
        if cmd == "mspt" && tps_reply.is_some() {
            break;
        }
    }
    parse_tps(tps_reply.as_deref(), query_reply.as_deref())
}

/// Paper's one-minute figure, or vanilla's `min(target, 1000 / ms)`; frozen is 0.
pub fn parse_tps(tps: Option<&str>, query: Option<&str>) -> Option<f64> {
    if let Some(m) = tps.and_then(|t| PAPER.captures(t)) {
        return m[1].parse::<f64>().ok().map(round2);
    }
    let query = query.filter(|q| !q.is_empty())?;
    if FROZEN.is_match(query) {
        return Some(0.0);
    }
    let target: f64 = RATE.captures(query)?[1].parse().ok()?;
    let ms: f64 = AVG.captures(query)?[1].parse().ok()?;
    if target <= 0.0 {
        return None;
    }
    Some(round2(if ms > 0.0 { target.min(1000.0 / ms) } else { target }))
}

/// `There are 2 of a max of 20 players online` and Essentials' wording, as (online, max).
pub fn parse_list(text: &str) -> Option<(u64, u64)> {
    let clean = strip_colors(text);
    let m = LIST.captures(&clean)?;
    Some((m[1].parse().ok()?, m[2].parse().ok()?))
}

/// One reading of the server's own figures.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reading {
    pub at: Instant,
    pub tps: Option<f64>,
    pub online: Option<u64>,
    pub max: Option<u64>,
}

/// The running sampler; dropping it does not stop it, [`TickSampler::stop`] does.
#[derive(Debug, Clone)]
pub struct TickSampler {
    latest: Arc<Mutex<Option<Reading>>>,
    stopped: Arc<AtomicBool>,
    interval: Duration,
}

impl TickSampler {
    /// A sampler with nothing to read (no RCON, or a database).
    pub fn none() -> TickSampler {
        let s = TickSampler {
            latest: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(true)),
            interval: Duration::from_secs(10),
        };
        s.stop();
        s
    }

    pub fn start(
        port: Option<u16>,
        password: Option<String>,
        interval: Duration,
        timeout: Duration,
        on_error: impl Fn(String) + Send + 'static,
    ) -> TickSampler {
        let (Some(port), Some(password)) = (port, password) else {
            return TickSampler::none();
        };
        let sampler = TickSampler {
            latest: Arc::new(Mutex::new(None)),
            stopped: Arc::new(AtomicBool::new(false)),
            interval,
        };
        let latest = sampler.latest.clone();
        let stopped = sampler.stopped.clone();
        let spawned = std::thread::Builder::new().name("tick".into()).spawn(move || {
            let mut rcon: Option<Rcon> = None;
            let mut failures = 0u32;
            let mut answered = false;
            while !stopped.load(Ordering::SeqCst) {
                let began = Instant::now();
                let result = (|| -> Result<Reading, RconError> {
                    if rcon.is_none() {
                        rcon = Some(Rcon::connect(port, &password, timeout)?);
                    }
                    let conn = rcon.as_mut().expect("connected above");
                    let tps = read_tick(|cmd| conn.send(cmd));
                    let players = parse_list(&conn.send("list")?);
                    Ok(Reading {
                        at: Instant::now(),
                        tps,
                        online: players.map(|p| p.0),
                        max: players.map(|p| p.1),
                    })
                })();
                match result {
                    Ok(reading) => {
                        if let Ok(mut slot) = latest.lock() {
                            *slot = Some(reading);
                        }
                        answered = true;
                        failures = 0;
                    }
                    Err(e) => {
                        rcon = None;
                        // refused connections are normal while the server starts; only repeated
                        // failures after it has answered once are worth a line
                        if answered {
                            failures += 1;
                            if failures == 3 {
                                on_error(e.message);
                            }
                        }
                    }
                }
                let next = began + interval;
                while !stopped.load(Ordering::SeqCst) && Instant::now() < next {
                    std::thread::sleep(
                        Duration::from_millis(100).min(next.saturating_duration_since(Instant::now())),
                    );
                }
            }
        });
        if spawned.is_err() {
            sampler.stop();
        }
        sampler
    }

    /// The newest reading, or None once it is older than three intervals.
    pub fn latest(&self) -> Option<Reading> {
        let reading = (*self.latest.lock().ok()?)?;
        (reading.at.elapsed() <= self.interval * 3).then_some(reading)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tps_from_paper_and_vanilla() {
        assert_eq!(
            parse_tps(Some("TPS from last 1m, 5m, 15m: *20.0, 19.98, 20.0"), None),
            Some(20.0)
        );
        assert_eq!(
            parse_tps(Some("TPS from last 1m, 5m, 15m: 17.456, 19, 20"), None),
            Some(17.46)
        );
        assert_eq!(
            parse_tps(
                None,
                Some("Target tick rate: 20.0 per second.\nAverage time per tick: 62.5ms (Target: 50.0ms)")
            ),
            Some(16.0)
        );
        assert_eq!(parse_tps(None, Some("The game is frozen")), Some(0.0));
        assert_eq!(parse_tps(None, None), None);
    }

    #[test]
    fn read_tick_stops_at_paper() {
        let mut asked = Vec::new();
        let tps = read_tick(|cmd| {
            asked.push(cmd.to_string());
            Ok(match cmd {
                "tps" => "\u{a7}6TPS from last 1m, 5m, 15m: \u{a7}a*20.0".to_string(),
                _ => "2.1/1.0/9.9".to_string(),
            })
        });
        assert_eq!(tps, Some(20.0));
        assert_eq!(asked, ["tps", "mspt"]);
    }

    #[test]
    fn player_lists() {
        assert_eq!(
            parse_list("There are 2 of a max of 20 players online: A, B"),
            Some((2, 20))
        );
        assert_eq!(
            parse_list("There are 3 out of maximum 50 players online."),
            Some((3, 50))
        );
        assert_eq!(parse_list("There are 1/10 players online"), Some((1, 10)));
        assert_eq!(parse_list("nobody"), None);
    }
}
