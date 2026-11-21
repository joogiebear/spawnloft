//! `log-timeline.mjs`: console, daemon and client logs read into one timeline.
//!
//! Minecraft and Paper stamp lines with a local time of day and no date, so entries are dated
//! from an anchor (the process's start, else the file's mtime) in local time, and the timeline
//! prints local time too: what a person reads here must match the raw log beside it.

use std::sync::LazyLock;

use regex::Regex;

use crate::jsdate;

pub const SOURCES: [&str; 4] = ["server", "daemon", "client", "client-process"];

// The patterns as JavaScript reads them: `\d` and `\w` are ASCII there, and `.` stops at \r,
// U+2028 and U+2029 as well as \n.
fn js(re: &str) -> Regex {
    let re = re
        .replace(r"\d", "[0-9]")
        .replace(r"\w", "[A-Za-z0-9_]")
        .replace(".*", "[^\n\r\u{2028}\u{2029}]*");
    Regex::new(&re).expect("a timeline pattern")
}

static PAPER_RE: LazyLock<Regex> = LazyLock::new(|| js(r"^\[(\d{2}:\d{2}:\d{2}) (\w+)\]: (.*)$"));
static FABRIC_RE: LazyLock<Regex> =
    LazyLock::new(|| js(r"^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)/(\w+)\]: (.*)$"));
static FABRIC_MOD_RE: LazyLock<Regex> =
    LazyLock::new(|| js(r"^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]*)/(\w+)\] \(([^)]+)\) (.*)$"));
static DAEMON_RE: LazyLock<Regex> = LazyLock::new(|| {
    js(r"^\[(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\] (.*)$")
});
// log4j before Paper configures logging: `2026-08-31T05:42:27.5Z ServerMain WARN Advanced...`
static LOG4J_ISO_RE: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+(\S+)\s+(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\s+(.*)$",
    )
});

/// One line read on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub time: Option<String>,
    pub iso: Option<String>,
    pub level: Option<String>,
    pub thread: Option<String>,
    pub text: String,
}

/// One entry of the timeline. `at` is an ISO time, or a stamp JavaScript could not read, kept
/// as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub at: String,
    pub source: String,
    pub level: Option<String>,
    pub thread: Option<String>,
    pub text: String,
    pub raw: String,
}

impl Entry {
    /// `{ at, source, level, thread, text, raw }`, the keys in Node's order.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "at": self.at,
            "source": self.source,
            "level": self.level,
            "thread": self.thread,
            "text": self.text,
            "raw": self.raw,
        })
    }
}

fn normalize_level(level: &str) -> String {
    let upper = level.to_uppercase();
    if upper == "SEVERE" { "ERROR".into() } else { upper }
}

fn captures<'a>(re: &Regex, line: &'a str) -> Option<regex::Captures<'a>> {
    re.captures(line)
}

/// `parseLine`.
pub fn parse_line(raw: &str) -> Parsed {
    let line = raw.strip_suffix('\r').unwrap_or(raw);
    let s = |c: &regex::Captures, i: usize| c.get(i).map(|m| m.as_str().to_string());
    if let Some(m) = captures(&FABRIC_MOD_RE, line) {
        return Parsed {
            time: s(&m, 1),
            iso: None,
            level: Some(normalize_level(&m[3])),
            thread: s(&m, 2),
            text: m[5].into(),
        };
    }
    if let Some(m) = captures(&FABRIC_RE, line) {
        return Parsed {
            time: s(&m, 1),
            iso: None,
            level: Some(normalize_level(&m[3])),
            thread: s(&m, 2),
            text: m[4].into(),
        };
    }
    if let Some(m) = captures(&PAPER_RE, line) {
        return Parsed {
            time: s(&m, 1),
            iso: None,
            level: Some(normalize_level(&m[2])),
            thread: None,
            text: m[3].into(),
        };
    }
    if let Some(m) = captures(&DAEMON_RE, line) {
        return Parsed {
            time: None,
            iso: s(&m, 1),
            level: None,
            thread: None,
            text: m[2].into(),
        };
    }
    if let Some(m) = captures(&LOG4J_ISO_RE, line) {
        return Parsed {
            time: None,
            iso: s(&m, 1),
            level: Some(normalize_level(&m[3])),
            thread: s(&m, 2),
            text: m[4].into(),
        };
    }
    Parsed {
        time: None,
        iso: None,
        level: None,
        thread: None,
        text: line.into(),
    }
}

fn hms_to_ms(hms: &str) -> f64 {
    let mut parts = hms.split(':').map(|p| p.parse::<f64>().unwrap_or(f64::NAN));
    let (h, m, s) = (
        parts.next().unwrap_or(0.0),
        parts.next().unwrap_or(0.0),
        parts.next().unwrap_or(0.0),
    );
    h * 3_600_000.0 + m * 60_000.0 + s * 1000.0
}

fn ms_of_day(t: f64) -> f64 {
    jsdate::local_fields(t).map_or(f64::NAN, |f| {
        f64::from(f.hour) * 3_600_000.0 + f64::from(f.minute) * 60_000.0 + f64::from(f.second) * 1000.0
    })
}

fn local_date(t: f64) -> f64 {
    jsdate::local_fields(t).map_or(f64::NAN, |f| f64::from(f.day))
}

fn date_at(base: f64, day_offset: u32, hms: &str) -> String {
    let d = jsdate::set_date(base, local_date(base) + f64::from(day_offset));
    let mut parts = hms.split(':').map(|p| p.parse::<f64>().unwrap_or(f64::NAN));
    let (h, m, s) = (
        parts.next().unwrap_or(0.0),
        parts.next().unwrap_or(0.0),
        parts.next().unwrap_or(0.0),
    );
    iso_or_invalid(jsdate::set_hours(d, h, m, s, 0.0))
}

// toISOString throws for an invalid date; the timeline has no use for one, so it says so
fn iso_or_invalid(t: f64) -> String {
    jsdate::to_iso(t).unwrap_or_else(|| "Invalid Date".into())
}

fn iso_of(text: &str) -> String {
    jsdate::to_iso(jsdate::parse(text)).unwrap_or_else(|| text.to_string())
}

struct Pending {
    at: Option<String>,
    day: Option<u32>,
    time: Option<String>,
    entry: Entry,
}

/// `parseLog(lines, { source, anchor, mtime })`, `anchor` and `mtime` in milliseconds. Lines
/// carry a time of day only, so each gets a day offset from the first (a line more than an hour
/// earlier than the one before it crossed midnight), and the offsets are pinned to a date by
/// `mtime` (the last line was written then), else `anchor` (the first line is after it), else
/// `now`.
pub fn parse_log(
    lines: &[&str],
    source: &str,
    anchor: Option<f64>,
    mtime: Option<f64>,
    now: f64,
) -> Vec<Entry> {
    let mut entries: Vec<Pending> = Vec::new();
    let mut day_offset = 0u32;
    let mut prev: Option<f64> = None;
    for raw in lines {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let p = parse_line(line);
        let entry = |text: String| Entry {
            at: String::new(),
            source: source.into(),
            level: p.level.clone(),
            thread: p.thread.clone(),
            text,
            raw: line.into(),
        };
        if p.time.is_none() && p.iso.is_none() {
            if let Some(last) = entries.last_mut() {
                last.entry.text.push('\n');
                last.entry.text.push_str(&p.text);
                last.entry.raw.push('\n');
                last.entry.raw.push_str(line);
            } else {
                entries.push(Pending {
                    at: None,
                    day: None,
                    time: None,
                    entry: entry(p.text.clone()),
                });
            }
            continue;
        }
        if let Some(iso) = &p.iso {
            entries.push(Pending {
                at: Some(iso_of(iso)),
                day: None,
                time: None,
                entry: entry(p.text.clone()),
            });
            continue;
        }
        let time = p.time.clone().unwrap_or_default();
        let ms = hms_to_ms(&time);
        if prev.is_some_and(|prev| prev - ms > 3_600_000.0) {
            day_offset += 1;
        }
        prev = Some(ms);
        entries.push(Pending {
            at: None,
            day: Some(day_offset),
            time: Some(time),
            entry: entry(p.text.clone()),
        });
    }

    let timed: Vec<&Pending> = entries.iter().filter(|e| e.day.is_some()).collect();
    let base = match (mtime, anchor) {
        (Some(mtime), _) if !timed.is_empty() => {
            let last = timed[timed.len() - 1];
            let mut base = mtime;
            if hms_to_ms(last.time.as_deref().unwrap_or("")) > ms_of_day(base) + 1000.0 {
                base = jsdate::set_date(base, local_date(base) - 1.0);
            }
            jsdate::set_date(base, local_date(base) - f64::from(last.day.unwrap_or(0)))
        }
        (_, Some(anchor)) => {
            let mut base = anchor;
            if let Some(first) = timed.first()
                && hms_to_ms(first.time.as_deref().unwrap_or("")) + 1000.0 < ms_of_day(base)
            {
                base = jsdate::set_date(base, local_date(base) + 1.0);
            }
            base
        }
        (mtime, None) => mtime.unwrap_or(now),
    };

    let dated: Vec<(Option<String>, Entry)> = entries
        .into_iter()
        .map(|p| {
            let at = p.at.or_else(|| {
                p.day
                    .map(|day| date_at(base, day, p.time.as_deref().unwrap_or("")))
            });
            (at, p.entry)
        })
        .collect();
    // Lines before the first stamped one (later ones joined the line above them) were written
    // just before it, not at the file's mtime.
    let first = dated
        .iter()
        .find_map(|(at, _)| at.clone())
        .unwrap_or_else(|| iso_or_invalid(base));
    dated
        .into_iter()
        .map(|(at, e)| Entry {
            at: at.unwrap_or_else(|| first.clone()),
            ..e
        })
        .collect()
}

/// `mergeTimelines`: every list's entries in time order, entries with an unreadable time first
/// (as time 0), ties kept in order.
pub fn merge_timelines(lists: Vec<Vec<Entry>>) -> Vec<Entry> {
    let mut all: Vec<Entry> = lists.into_iter().flatten().collect();
    // `Date.parse(e.at) || 0`
    let ms = |e: &Entry| {
        let t = jsdate::parse(&e.at);
        if t.is_nan() { 0.0 } else { t }
    };
    all.sort_by(|a, b| ms(a).total_cmp(&ms(b)));
    all
}

fn local_time(iso: &str) -> String {
    let t = jsdate::parse(iso);
    let Some(f) = jsdate::local_fields(t) else {
        return iso.to_string();
    };
    format!("{:02}:{:02}:{:02}.{:03}", f.hour, f.minute, f.second, f.ms)
}

/// `formatTimeline`: one line per entry, `<local time> <source>  <level>  <text>`, a text's own
/// lines indented under it; `width` pads the source column.
pub fn format_timeline(entries: &[Entry], width: usize) -> String {
    entries
        .iter()
        .map(|e| {
            let time = local_time(&e.at);
            let src = if width > 0 {
                let len = e.source.encode_utf16().count();
                format!("{}{}", e.source, " ".repeat(width.saturating_sub(len)))
            } else {
                e.source.clone()
            };
            let level = e.level.as_deref().unwrap_or("");
            let text = e.text.replace('\n', "\n  ");
            format!("{time} {src}  {level}  {text}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn library() -> serde_json::Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/c1-library.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    fn opt(v: &Option<String>) -> Value {
        v.as_ref().map_or(Value::Null, |s| json!(s))
    }

    #[test]
    fn lines_agree_with_node() {
        for c in library()["lines"].as_array().unwrap() {
            let p = parse_line(c["line"].as_str().unwrap());
            let got = json!({
                "time": opt(&p.time), "iso": opt(&p.iso), "level": opt(&p.level),
                "thread": opt(&p.thread), "text": p.text,
            });
            assert_eq!(got, c["parsed"], "{c}");
        }
    }

    fn ms(v: &Value) -> Option<f64> {
        v.as_f64()
    }

    /// The fixture's timeline for one zone, checked in this process (whose zone the caller set).
    fn check_zone(zone: &Value) {
        let tz = zone["tz"].as_str().unwrap();
        for d in zone["dates"].as_array().unwrap() {
            let t = jsdate::parse(d["text"].as_str().unwrap());
            assert_eq!(if t.is_nan() { None } else { Some(t) }, ms(&d["ms"]), "{tz} {d}");
        }
        for c in zone["logs"].as_array().unwrap() {
            let lines: Vec<&str> = c["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap())
                .collect();
            let entries = parse_log(&lines, "server", ms(&c["anchor"]), ms(&c["mtime"]), 0.0);
            let got: Vec<Value> = entries.iter().map(Entry::to_json).collect();
            assert_eq!(json!(got), c["entries"], "{tz} {}", c["lines"]);
            assert_eq!(format_timeline(&entries, 8), c["text"].as_str().unwrap(), "{tz}");
        }
        let logs = zone["logs"].as_array().unwrap();
        let lists = logs[..3]
            .iter()
            .zip(["server", "daemon", "client"])
            .map(|(c, source)| {
                let lines: Vec<&str> = c["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| l.as_str().unwrap())
                    .collect();
                parse_log(&lines, source, ms(&c["anchor"]), ms(&c["mtime"]), 0.0)
            })
            .collect();
        let merged = merge_timelines(lists);
        let got: Vec<Value> = merged.iter().map(Entry::to_json).collect();
        assert_eq!(json!(got), zone["merged"]["entries"], "{tz} merged");
        assert_eq!(
            format_timeline(&merged, 0),
            zone["merged"]["text"].as_str().unwrap(),
            "{tz}"
        );
    }

    // Run by timelines_agree_with_node in a child process with TZ set; a no-op otherwise.
    #[test]
    fn timeline_in_zone() {
        let Ok(tz) = std::env::var("SPAWNLOFT_TEST_FIXTURE_TZ") else {
            return;
        };
        let fx = library();
        let zone = fx["timelines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|z| z["tz"] == tz.as_str())
            .unwrap();
        check_zone(zone);
    }

    #[cfg(unix)]
    #[test]
    fn timelines_agree_with_node() {
        for tz in ["America/New_York", "UTC"] {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "log_timeline::tests::timeline_in_zone",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("TZ", tz)
                .env("SPAWNLOFT_TEST_FIXTURE_TZ", tz)
                .output()
                .unwrap();
            assert!(
                out.status.success() && String::from_utf8_lossy(&out.stdout).contains("1 passed"),
                "{tz}: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    // Windows takes the zone from the system, not TZ: the UTC half runs where the system is UTC
    // (as on the CI runners).
    #[cfg(windows)]
    #[test]
    fn timelines_agree_with_node_in_utc() {
        if [0i64, 1_773_000_000, 1_788_000_000]
            .iter()
            .any(|&t| crate::platform::local_offset_secs(t) != 0)
        {
            return;
        }
        let fx = library();
        check_zone(&fx["timelines"][1]);
    }
}
