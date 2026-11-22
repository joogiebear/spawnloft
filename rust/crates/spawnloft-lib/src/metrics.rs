//! CPU and memory history of the server process (`metrics.mjs`): a sample every ten seconds to
//! `metrics.log` in the run folder, where the panel reads it from another process. Linux reads
//! `/proc`, macOS asks `/bin/ps`, Windows asks the process handle (`GetProcessTimes`,
//! `GetProcessMemoryInfo`), which retires the PowerShell loop the Node daemon runs.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::platform::{Probe, ProcessProbe};
use crate::tick::Reading;

pub const INTERVAL_SEC: u64 = 10;
/// Five hours, so the four-hour view is always full.
pub const KEEP: usize = 1800;
/// Trimmed in batches rather than rewriting the file every sample.
pub const TRIM_AT: usize = KEEP + 600;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub at: i64,
    pub cpu: f64,
    pub rss: i64,
}

/// Turns cumulative CPU seconds and resident bytes into shares of the whole machine. A reset
/// counter, clock adjustment or long sleep starts a new baseline instead of producing a spike.
#[derive(Debug, Clone)]
pub struct Recorder {
    previous: Option<(f64, f64)>,
    cores: f64,
}

impl Recorder {
    pub fn new(cores: usize) -> Recorder {
        Recorder {
            previous: None,
            cores: cores.max(1) as f64,
        }
    }

    pub fn record(&mut self, at: f64, seconds: f64, bytes: f64) -> Option<Sample> {
        if ![at, seconds, bytes].iter().all(|v| v.is_finite()) || at <= 0.0 || seconds < 0.0 || bytes < 0.0 {
            return None;
        }
        let prior = self.previous.replace((at, seconds))?;
        let wall = at - prior.0;
        if wall <= 0.0 || wall > (INTERVAL_SEC * 3) as f64 || seconds < prior.1 {
            return None;
        }
        let cpu = ((seconds - prior.1) / (wall * self.cores) * 100.0).clamp(0.0, 100.0);
        Some(Sample {
            at: at.floor() as i64,
            cpu,
            rss: (bytes / 1_048_576.0).round() as i64,
        })
    }
}

fn figure_f(v: Option<f64>) -> String {
    match v {
        Some(n) if n.is_finite() => format!("{n}"),
        _ => "-".into(),
    }
}

fn figure_u(v: Option<u64>) -> String {
    v.map(|n| n.to_string()).unwrap_or_else(|| "-".into())
}

/// `time cpu rss`, then `tps online max` when the server answered RCON ("-" for an unknown).
pub fn sample_line(sample: &Sample, server: Option<&Reading>) -> String {
    // toFixed(1): halves round up, which f64 formatting does not promise
    let cpu = (sample.cpu * 10.0 + 1e-9).round() / 10.0;
    let base = format!("{} {cpu:.1} {}", sample.at, sample.rss);
    match server {
        None => format!("{base}\n"),
        Some(r) => format!(
            "{base} {} {} {}\n",
            figure_f(r.tps),
            figure_u(r.online),
            figure_u(r.max)
        ),
    }
}

/// Keeps the newest [`KEEP`] lines once the file passes [`TRIM_AT`].
pub fn trim(file: &Path) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return;
    };
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    if lines.len() <= TRIM_AT {
        return;
    }
    let keep = &lines[lines.len() - KEEP..];
    let _ = std::fs::write(file, format!("{}\n", keep.join("\n")));
}

/// A running sampler; [`Sampler::stop`] ends it.
#[derive(Debug, Clone)]
pub struct Sampler {
    stopped: Arc<AtomicBool>,
}

impl Sampler {
    /// A sampler that is not running, as a placeholder.
    pub fn default_stopped() -> Sampler {
        Sampler {
            stopped: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

/// Starts sampling `pid` into `file`. A sampler that cannot start, or fails later, reports once
/// and stops; a process that is gone or a reused pid ends it quietly.
pub fn start(
    pid: u32,
    file: PathBuf,
    extra: impl Fn() -> Option<Reading> + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Sampler {
    start_with(
        pid,
        file,
        Duration::from_secs(INTERVAL_SEC),
        crate::platform::cpu_count(),
        extra,
        on_error,
    )
}

pub fn start_with(
    pid: u32,
    file: PathBuf,
    interval: Duration,
    cores: usize,
    extra: impl Fn() -> Option<Reading> + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Sampler {
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let spawned = std::thread::Builder::new().name("metrics".into()).spawn(move || {
        let mut probe = match ProcessProbe::open(pid) {
            Ok(p) => p,
            Err(e) => {
                if !flag.load(Ordering::SeqCst) {
                    on_error(e);
                }
                return;
            }
        };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut recorder = Recorder::new(cores);
        let mut written = 0u64;
        let mut identity: Option<String> = None;
        while !flag.load(Ordering::SeqCst) {
            let began = Instant::now();
            match probe.sample() {
                Ok(Probe::Gone) => return,
                Ok(Probe::Alive {
                    seconds,
                    bytes,
                    identity: id,
                }) => {
                    if flag.load(Ordering::SeqCst) {
                        return;
                    }
                    if identity.is_some() && identity != id {
                        return; // the pid now belongs to another process
                    }
                    identity = id;
                    if let Some(sample) = recorder.record(crate::time::now_secs(), seconds, bytes as f64) {
                        let line = sample_line(&sample, extra().as_ref());
                        let wrote = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&file)
                            .and_then(|mut f| f.write_all(line.as_bytes()));
                        if let Err(e) = wrote {
                            on_error(format!("{e}"));
                            return;
                        }
                        written += 1;
                        if written.is_multiple_of(60) {
                            trim(&file);
                        }
                    }
                }
                Err(e) => {
                    if !flag.load(Ordering::SeqCst) {
                        on_error(e);
                    }
                    return;
                }
            }
            let next = began + interval;
            while !flag.load(Ordering::SeqCst) && Instant::now() < next {
                std::thread::sleep(
                    Duration::from_millis(100).min(next.saturating_duration_since(Instant::now())),
                );
            }
        }
    });
    if spawned.is_err() {
        stopped.store(true, Ordering::SeqCst);
    }
    Sampler { stopped }
}

/// The Linux reading of `/proc/<pid>/stat` and `status` (`parseProcSample`): cumulative CPU from
/// utime and stime, resident bytes from VmRSS, and the start time that identifies the process.
pub fn parse_proc_sample(
    stat: &str,
    status: &str,
    ticks_per_second: f64,
) -> Result<(f64, u64, String), String> {
    let unreadable = || "Linux returned an unreadable process measurement".to_string();
    let close = stat.rfind(')').ok_or_else(unreadable)?;
    let fields: Vec<&str> = stat.get(close + 2..).unwrap_or("").split_whitespace().collect();
    let digits = |s: Option<&&str>| {
        s.filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .map(|v| v.to_string())
    };
    let (Some(utime), Some(stime), Some(identity)) = (
        digits(fields.get(11)),
        digits(fields.get(12)),
        digits(fields.get(19)),
    ) else {
        return Err(unreadable());
    };
    // zombies and kernel threads have no VmRSS line
    let bytes = status
        .lines()
        .find_map(|l| {
            let rest = l.strip_prefix("VmRSS:")?.trim();
            rest.strip_suffix("kB")?.trim().parse::<u64>().ok()
        })
        .map(|kb| kb * 1024)
        .unwrap_or(0);
    let seconds = (utime.parse::<f64>().map_err(|_| unreadable())?
        + stime.parse::<f64>().map_err(|_| unreadable())?)
        / ticks_per_second;
    Ok((seconds, bytes, identity))
}

/// The macOS reading of `ps -o pid=,time=,rss=,lstart=` (`parsePsSample`).
pub fn parse_ps_sample(text: &str, pid: u32) -> Result<(f64, u64, String), String> {
    let bad = || "macOS returned an unreadable process measurement".to_string();
    let line = text.trim();
    let mut parts = line.splitn(4, char::is_whitespace).filter(|s| !s.is_empty());
    let got_pid: u32 = parts.next().and_then(|p| p.parse().ok()).ok_or_else(bad)?;
    if got_pid != pid {
        return Err(bad());
    }
    let rest = line[line.find(char::is_whitespace).ok_or_else(bad)?..].trim_start();
    let (time, rest) = rest.split_once(char::is_whitespace).ok_or_else(bad)?;
    let rest = rest.trim_start();
    let (rss, lstart) = rest.split_once(char::is_whitespace).ok_or_else(bad)?;
    let (min, sec) = time.split_once(':').ok_or_else(bad)?;
    let minutes: f64 = min.parse().map_err(|_| bad())?;
    let secs: f64 = sec.parse().map_err(|_| bad())?;
    if !(0.0..60.0).contains(&secs) || !min.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let kb: u64 = rss.parse().map_err(|_| bad())?;
    let identity = lstart.trim();
    if identity.is_empty() {
        return Err(bad());
    }
    Ok((minutes * 60.0 + secs, kb * 1024, identity.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_for_the_panel() {
        let dir = std::env::temp_dir().join(format!("sl-metrics-rows-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("metrics.log");
        assert!(read_rows(&file).is_empty());
        assert_eq!(latest_sample(&file, 0.0), None);
        std::fs::write(
            &file,
            "100 12.5 2048 19.9 2 20\nnot a sample\n0 1 1\n110 101 1\n120 3.0 4096 - - -\n\n130 0.4 8192\n",
        )
        .unwrap();
        let rows: Vec<String> = read_rows(&file)
            .into_iter()
            .map(|r| crate::jsjson::stringify(&serde_json::Value::Object(r)))
            .collect();
        assert_eq!(
            rows,
            [
                r#"{"at":100,"cpu":12.5,"rss":2048,"tps":19.9,"players":2,"maxPlayers":20}"#,
                r#"{"at":120,"cpu":3,"rss":4096}"#,
                r#"{"at":130,"cpu":0.4,"rss":8192}"#,
            ]
        );
        // the newest line, while it is no older than three intervals
        let fresh = (130 + INTERVAL_SEC * 3) as f64 * 1000.0;
        assert_eq!(
            latest_sample(&file, fresh).map(|r| crate::jsjson::stringify(&serde_json::Value::Object(r))),
            Some(r#"{"at":130,"cpu":0.4,"rss":8192}"#.to_string())
        );
        assert_eq!(latest_sample(&file, fresh + 1000.0), None);
        std::fs::write(&file, "\n").unwrap();
        assert_eq!(latest_sample(&file, fresh), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_like_sample_recorder() {
        let mut r = Recorder::new(4);
        assert_eq!(r.record(100.0, 10.0, 1048576.0 * 512.0), None);
        let s = r.record(110.0, 30.0, 1048576.0 * 512.0).unwrap();
        assert_eq!(
            s,
            Sample {
                at: 110,
                cpu: 50.0,
                rss: 512
            }
        );
        // a long gap starts a new baseline
        assert_eq!(r.record(200.0, 40.0, 1.0), None);
        // a reset counter too
        assert_eq!(r.record(210.0, 1.0, 1.0), None);
        assert_eq!(r.record(f64::NAN, 1.0, 1.0), None);
    }

    #[test]
    fn lines() {
        let s = Sample {
            at: 1700000000,
            cpu: 12.25,
            rss: 900,
        };
        assert_eq!(sample_line(&s, None), "1700000000 12.3 900\n");
        let r = Reading {
            at: Instant::now(),
            tps: Some(19.98),
            online: Some(2),
            max: None,
        };
        assert_eq!(sample_line(&s, Some(&r)), "1700000000 12.3 900 19.98 2 -\n");
        let full = Reading {
            at: Instant::now(),
            tps: Some(20.0),
            online: Some(0),
            max: Some(20),
        };
        assert_eq!(sample_line(&s, Some(&full)), "1700000000 12.3 900 20 0 20\n");
    }

    #[test]
    fn proc_and_ps() {
        let stat = "1234 (java (x) y) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0 20 0 30 0 987654 0";
        let (secs, bytes, id) = parse_proc_sample(stat, "Name:\tjava\nVmRSS:\t  2048 kB\n", 100.0).unwrap();
        assert_eq!((secs, bytes, id.as_str()), (3.0, 2 * 1024 * 1024, "987654"));
        assert!(parse_proc_sample("garbage", "", 100.0).is_err());
        let (secs, bytes, id) =
            parse_ps_sample("  321 125:03.50 4096 Mon Nov  8 10:00:00 2026\n", 321).unwrap();
        assert_eq!(secs, 125.0 * 60.0 + 3.5);
        assert_eq!(bytes, 4096 * 1024);
        assert_eq!(id, "Mon Nov  8 10:00:00 2026");
        assert!(parse_ps_sample("322 0:01.00 1 x", 321).is_err());
    }

    #[test]
    fn trims_in_batches() {
        let dir = std::env::temp_dir().join(format!("sl-met-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("metrics.log");
        let lines: String = (0..TRIM_AT + 1).map(|i| format!("{i} 1.0 1\n")).collect();
        std::fs::write(&file, lines).unwrap();
        trim(&file);
        let kept = std::fs::read_to_string(&file).unwrap();
        assert_eq!(kept.lines().count(), KEEP);
        assert!(kept.ends_with(&format!("{} 1.0 1\n", TRIM_AT)));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn samples_this_process() {
        let dir = std::env::temp_dir().join(format!("sl-met2-{}", std::process::id()));
        let file = dir.join("metrics.log");
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = errors.clone();
        let s = start_with(
            std::process::id(),
            file.clone(),
            Duration::from_millis(200),
            1,
            || None,
            move |e| seen.lock().unwrap().push(e),
        );
        // the file appears before its first line is written: wait for a whole line, not the file
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline
            && std::fs::read_to_string(&file)
                .map(|t| !t.contains('\n'))
                .unwrap_or(true)
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        s.stop();
        assert!(errors.lock().unwrap().is_empty(), "{:?}", errors.lock().unwrap());
        let text = std::fs::read_to_string(&file).unwrap();
        let cols: Vec<&str> = text.lines().next().unwrap().split(' ').collect();
        assert_eq!(cols.len(), 3);
        assert!(cols[2].parse::<i64>().unwrap() > 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// One row of `metrics.log` as `readSamples` keeps it: seconds since the epoch, CPU as a share
/// of the whole machine, resident memory in MiB.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Row {
    pub at: f64,
    pub cpu: f64,
    pub rss: f64,
}

/// `figure(text)`: a column the server answered, or nothing for `-`, a blank or a non-number.
fn figure(text: Option<&str>) -> Option<f64> {
    let text = text.filter(|t| !t.is_empty() && *t != "-")?;
    let n = crate::js::string_to_number(text);
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// One line of `metrics.log` as the panel sends it: `at`, `cpu` and `rss`, then `tps`, `players`
/// and `maxPlayers` where the server answered. `None` for a line that is not whole; `ranged`
/// also refuses one out of range (`readSamples` does, `latestSample` does not).
fn row_json(line: &str, ranged: bool) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut parts = line.split(' ');
    let mut number = || parts.next().map_or(f64::NAN, crate::js::string_to_number);
    let (at, cpu, rss) = (number(), number(), number());
    if !(at.is_finite() && cpu.is_finite() && rss.is_finite()) {
        return None;
    }
    if ranged && (at <= 0.0 || !(0.0..=100.0).contains(&cpu) || rss < 0.0) {
        return None;
    }
    let mut row = serde_json::Map::new();
    for (key, value) in [("at", at), ("cpu", cpu), ("rss", rss)] {
        row.insert(key.into(), crate::jsjson::num(value));
    }
    for key in ["tps", "players", "maxPlayers"] {
        if let Some(n) = figure(parts.next()) {
            row.insert(key.into(), crate::jsjson::num(n));
        }
    }
    Some(row)
}

/// `readSamples(name)` as the rows the panel's chart gets, oldest first and unfiltered: the
/// caller windows it, and needs to tell "nothing recorded" from "nothing in this range".
pub fn read_rows(file: &Path) -> Vec<serde_json::Map<String, serde_json::Value>> {
    let Ok(bytes) = std::fs::read(file) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .split('\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| row_json(l, true))
        .collect()
}

/// `latestSample(name, { now })`: the newest sample, read from the end of the file (the panel
/// asks for every running server every few seconds). Nothing when it is older than three
/// intervals.
pub fn latest_sample(file: &Path, now_ms: f64) -> Option<serde_json::Map<String, serde_json::Value>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).ok()?;
    let size = f.metadata().ok()?.len();
    let length = size.min(512);
    if length == 0 {
        return None;
    }
    f.seek(SeekFrom::Start(size - length)).ok()?;
    let mut buf = Vec::with_capacity(length as usize);
    f.take(length).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let last = text.split('\n').rfind(|l| !l.is_empty())?;
    // judged on the time alone first, as Node does: a stale line is nothing whatever else it holds
    let at = last
        .split(' ')
        .next()
        .map_or(f64::NAN, crate::js::string_to_number);
    if !at.is_finite() || now_ms / 1000.0 - at > (INTERVAL_SEC * 3) as f64 {
        return None;
    }
    row_json(last, false)
}

/// `readSamples(name, { strict })`: rows that are whole and in range, in file order. `strict`
/// fails on a file that cannot be read (anything but missing).
pub fn read_samples(file: &Path, strict: bool) -> Result<Vec<Row>, crate::failure::Failure> {
    let text = match std::fs::read(file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) => {
            if strict && !crate::jspath::is_enoent(&e) {
                return Err(crate::failure::Failure::read(&e, file));
            }
            return Ok(Vec::new());
        }
    };
    let mut rows = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split(' ');
        let mut field = || parts.next().map_or(f64::NAN, crate::js::string_to_number);
        let (at, cpu, rss) = (field(), field(), field());
        if !(at.is_finite() && cpu.is_finite() && rss.is_finite())
            || at <= 0.0
            || !(0.0..=100.0).contains(&cpu)
            || rss < 0.0
        {
            continue;
        }
        rows.push(Row { at, cpu, rss });
    }
    Ok(rows)
}
