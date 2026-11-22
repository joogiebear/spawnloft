//! `metrics <name> [--json | --csv [--output <file>]] [--seconds <n>] [--follow]`:
//! cli-metrics.mjs.

use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::{js, jsjson, metrics, platform, supervisor, time};

use super::Ctx;
use super::args::Flag;
use super::output::json_line_typed;

const CSV_HEADER: &str = "instance,run_id,timestamp,cpu_percent,rss_mib,cores\n";

/// One measurement as `readMetrics` gives it.
#[derive(Debug, Clone)]
pub(crate) struct Sample {
    timestamp: String,
    at: f64,
    pub(crate) cpu: f64,
    pub(crate) rss: f64,
}

impl Sample {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "timestamp": self.timestamp, "at": jsjson::num(self.at), "cpuPercent": jsjson::num(self.cpu), "rssMiB": jsjson::num(self.rss) })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Data {
    instance: String,
    run_id: Value,
    started_at: Value,
    pub(crate) running: bool,
    pub(crate) cores: usize,
    pub(crate) samples: Vec<Sample>,
}

impl Data {
    fn to_json(&self, samples: &[Sample]) -> Value {
        json!({
            "instance": self.instance,
            "runId": self.run_id,
            "startedAt": self.started_at,
            "running": self.running,
            "samplingAvailable": cfg!(any(windows, target_os = "macos", target_os = "linux")),
            "sampleSeconds": metrics::INTERVAL_SEC,
            "cores": self.cores,
            "cpuScale": "whole-machine",
            "samples": samples.iter().map(Sample::to_json).collect::<Vec<_>>(),
        })
    }
}

/// `new Date(seconds * 1000).toISOString()`, which refuses a time outside JavaScript's range.
fn iso_of(at: f64) -> Result<String, Failure> {
    let ms = (at * 1000.0).trunc();
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return Err(Failure::Internal {
            head: "RangeError".into(),
            message: "Invalid time value".into(),
            code: None,
        });
    }
    Ok(time::iso(ms as i64))
}

/// `readMetrics(name, seconds)`.
fn read(ctx: &Ctx<'_>, name: &str, seconds: Option<f64>) -> Result<Data, Failure> {
    read_metrics(ctx.layout, name, seconds)
}

/// `readMetrics(name, seconds)`, for the MCP `performance` tool too.
pub(crate) fn read_metrics(
    layout: &spawnloft_lib::settings::Layout,
    name: &str,
    seconds: Option<f64>,
) -> Result<Data, Failure> {
    let (st, status) = supervisor::status_of(layout, name)?;
    let started = st.get("startedAt").cloned().unwrap_or(Value::Null);
    let cutoff = seconds.map_or(0.0, |s| time::now_ms() as f64 / 1000.0 - s);
    let mut samples = Vec::new();
    for row in metrics::read_samples(Path::new(&layout.metrics_file(name)), true)? {
        if row.at >= cutoff {
            samples.push(Sample {
                timestamp: iso_of(row.at)?,
                at: row.at,
                cpu: row.cpu,
                rss: row.rss,
            });
        }
    }
    Ok(Data {
        instance: name.to_string(),
        run_id: if started.is_null() {
            Value::Null
        } else {
            json!(format!("{name}:{}", js::string(Some(&started))))
        },
        started_at: started,
        running: status == spawnloft_lib::control::Status::Running,
        cores: platform::cpu_count().max(1),
        samples,
    })
}

/// `'"' + String(value ?? '').replaceAll('"', '""') + '"'`.
fn csv_field(v: &Value) -> String {
    let text = if v.is_null() {
        String::new()
    } else {
        js::string(Some(v))
    };
    format!("\"{}\"", text.replace('"', "\"\""))
}

fn csv_rows(data: &Data, samples: &[Sample], header: bool) -> String {
    let mut out = if header {
        CSV_HEADER.to_string()
    } else {
        String::new()
    };
    for row in samples {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            csv_field(&json!(data.instance)),
            csv_field(&data.run_id),
            row.timestamp,
            js::number_to_string(row.cpu),
            js::number_to_string(row.rss),
            data.cores
        ));
    }
    out
}

fn text_rows(samples: &[Sample]) -> String {
    samples
        .iter()
        .map(|r| {
            format!(
                "{}  CPU {}%  Memory {} MiB\n",
                r.timestamp,
                js::to_fixed(r.cpu, 1),
                js::number_to_string(r.rss)
            )
        })
        .collect()
}

pub fn metrics(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    super::check_flags(ctx.args, &["json", "csv", "follow", "seconds", "output"])?;
    let name = super::instance_name(&ctx.args.positional, "metrics")?.to_string();
    for key in ["json", "csv", "follow"] {
        if matches!(ctx.args.get(key), Some(Flag::Text(_))) {
            return Err(Failure::usage(format!("--{key} does not take a value")));
        }
    }
    let on = |k: &str| ctx.args.get(k) == Some(&Flag::Bool(true));
    let (json, csv, follow) = (on("json"), on("csv"), on("follow"));
    if json && csv {
        return Err(Failure::usage("Choose --json or --csv, not both"));
    }
    let seconds = match ctx.args.get("seconds") {
        None => None,
        Some(f) => {
            let n = f.number();
            if *f == Flag::Bool(true) || !n.is_finite() || n <= 0.0 {
                return Err(Failure::usage("--seconds must be a positive number"));
            }
            Some(n)
        }
    };
    let output = ctx.args.get("output").cloned();
    if let Some(o) = &output
        && (!csv || follow || !matches!(o, Flag::Text(t) if !t.is_empty()))
    {
        return Err(Failure::usage("--output <file> requires --csv without --follow"));
    }
    let first = read(ctx, &name, seconds)?;
    if let Some(Flag::Text(file)) = output {
        use std::io::Write;
        let path = Path::new(&file);
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| Failure::io(&e, "open", Some(path)))?;
        f.write_all(csv_rows(&first, &first.samples, true).as_bytes())
            .map_err(|e| Failure::io(&e, "write", None))?;
        ctx.out.err(&format!(
            "Exported {} measurements to {file}\n",
            first.samples.len()
        ));
        return Ok(());
    }
    if !follow {
        let text = if json {
            json_line_typed("metrics", Some(&first.to_json(&first.samples)), None, None)
        } else if csv {
            csv_rows(&first, &first.samples, true)
        } else {
            format!(
                "Performance: {name} ({} cores; CPU is a share of the whole machine)\n{}",
                first.cores,
                if first.samples.is_empty() {
                    "No measurements in this range.\n".to_string()
                } else {
                    text_rows(&first.samples)
                }
            )
        };
        ctx.out.print(&text);
        return Ok(());
    }

    platform::watch_interrupts();
    let mut cursor = Cursor::default();
    cursor.next(&first);
    ctx.out.print(&if json {
        json_line_typed(
            "metrics",
            Some(&first.to_json(&first.samples)),
            None,
            Some("snapshot"),
        )
    } else if csv {
        csv_rows(&first, &first.samples, true)
    } else {
        text_rows(&first.samples)
    });
    loop {
        // a second in small steps, so an interrupt ends the wait at once
        for _ in 0..20 {
            if let Some(code) = platform::interrupted() {
                ctx.out.set_code(code);
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if let Some(code) = platform::interrupted() {
            ctx.out.set_code(code);
            return Ok(());
        }
        let data = read(ctx, &name, seconds)?;
        let (reset, rows) = cursor.next(&data);
        if reset && json {
            ctx.out.print(&json_line_typed(
                "metrics",
                Some(&data.to_json(&[])),
                None,
                Some("reset"),
            ));
        } else if reset && !csv {
            ctx.out.print("Server run changed; starting a fresh series.\n");
        }
        for row in rows {
            let text = if json {
                let mut v = json!({ "instance": name, "runId": data.run_id, "cores": data.cores });
                if let (Value::Object(m), Value::Object(r)) = (&mut v, row.to_json()) {
                    m.extend(r);
                }
                json_line_typed("metrics", Some(&v), None, Some("sample"))
            } else if csv {
                csv_rows(&data, std::slice::from_ref(&row), false)
            } else {
                text_rows(std::slice::from_ref(&row))
            };
            ctx.out.print(&text);
        }
    }
}

/// `metricCursor()`: which rows are new, and whether the run changed. Timestamps are unique at
/// the sampler's cadence; a clock moving backwards also counts as a reset.
#[derive(Debug, Default)]
struct Cursor {
    run_id: Option<Value>,
    last_at: Option<f64>,
    seen: HashSet<u64>,
}

impl Cursor {
    fn next(&mut self, data: &Data) -> (bool, Vec<Sample>) {
        let newest = data.samples.last().map(|r| r.at);
        let reset = self.run_id.as_ref().is_some_and(|id| {
            *id != data.run_id || matches!((newest, self.last_at), (Some(n), Some(l)) if n < l)
        });
        if self.run_id.is_none() || reset {
            self.seen.clear();
            self.last_at = None;
        }
        let rows: Vec<Sample> = data
            .samples
            .iter()
            .filter(|r| !self.seen.contains(&r.at.to_bits()))
            .cloned()
            .collect();
        // a trim briefly truncates the file; an empty read must not make every old row look new
        if !data.samples.is_empty() {
            self.seen = data.samples.iter().map(|r| r.at.to_bits()).collect();
        }
        self.run_id = Some(data.run_id.clone());
        if newest.is_some() {
            self.last_at = newest;
        }
        (reset, rows)
    }
}
