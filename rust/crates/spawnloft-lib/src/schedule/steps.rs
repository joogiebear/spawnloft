//! `task-steps.mjs`: a task of several steps run in order in one run (warn, wait, back up,
//! restart), so the restart waits for the backup. What a step does comes in through [`Deps`] so
//! the chain rules can be tested without a server or a scheduler.

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::js;

/// `STEP_KINDS`: each kind with its label, in the order the Node core lists them.
pub const STEP_KINDS: [(&str, &str); 9] = [
    ("say", "Tell the players"),
    ("command", "Run a server command"),
    ("wait", "Wait"),
    ("countdown", "Count down, telling the players"),
    ("backup", "Take a backup"),
    ("verify", "Verify the backups"),
    ("stop", "Stop the server"),
    ("start", "Start the server"),
    ("restart", "Restart the server"),
];
pub const MAX_STEPS: usize = 12;
/// The total of waits and countdowns: a chain sleeping for most of a day is a typo.
pub const MAX_WAIT_SECONDS: f64 = 2.0 * 60.0 * 60.0;

/// `String(v ?? '')`.
pub(crate) fn text_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        other => js::string(other),
    }
}

/// UTF-16 length, as JavaScript's `length`.
pub(crate) fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `slice(0, n)` in UTF-16 units.
pub(crate) fn cut16(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn clamp_int(v: Option<&Value>, lo: f64, hi: f64, dflt: f64) -> f64 {
    let n = js_round(js::number(v));
    if n.is_finite() { n.max(lo).min(hi) } else { dflt }
}

/// `{ keep }` of a backup: a whole number above 0, at most 365, else null.
pub(crate) fn keep_of(v: Option<&Value>) -> Value {
    let keep = js::number(v);
    if keep.fract() == 0.0 && keep.is_finite() && keep > 0.0 {
        crate::jsjson::num(keep.min(365.0))
    } else {
        Value::Null
    }
}

fn normalise_step(input: &Value, i: usize) -> Result<Value, Failure> {
    let n = i + 1;
    let kind = text_or_empty(input.get("do"));
    if !STEP_KINDS.iter().any(|(k, _)| *k == kind) {
        let all: Vec<&str> = STEP_KINDS.iter().map(|(k, _)| *k).collect();
        return Err(Failure::user(format!(
            "step {n}: \"{kind}\" is not a step - one of {}",
            all.join(", ")
        )));
    }
    if kind == "say" || kind == "command" {
        let raw = text_or_empty(input.get(if kind == "say" { "text" } else { "line" }));
        let text = js::trim(&raw).to_string();
        if text.is_empty() {
            return Err(Failure::user(format!(
                "step {n}: {}",
                if kind == "say" {
                    "what should the players be told?"
                } else {
                    "which command?"
                }
            )));
        }
        if len16(&text) > 400 {
            return Err(Failure::user(format!(
                "step {n}: that is too long for a console line"
            )));
        }
        return Ok(if kind == "say" {
            json!({ "do": kind, "text": text })
        } else {
            json!({ "do": kind, "line": text.strip_prefix('/').unwrap_or(&text) })
        });
    }
    let num = crate::jsjson::num;
    Ok(match kind.as_str() {
        "wait" => json!({ "do": kind, "seconds": num(clamp_int(input.get("seconds"), 5.0, 3600.0, 60.0)) }),
        "countdown" => {
            let raw = text_or_empty(input.get("message"));
            let message = cut16(js::trim(&raw), 120);
            let message = if message.is_empty() {
                "Server restarting".to_string()
            } else {
                message
            };
            json!({ "do": kind, "minutes": num(clamp_int(input.get("minutes"), 1.0, 60.0, 5.0)), "message": message })
        }
        "backup" => json!({ "do": kind, "keep": keep_of(input.get("keep")) }),
        _ => json!({ "do": kind }),
    })
}

/// `normaliseSteps(input)`: the steps checked and cut to their own fields.
pub fn normalise_steps(input: &Value) -> Result<Value, Failure> {
    let raw = match input.get("steps") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    if raw.is_empty() {
        return Err(Failure::user("add at least one step"));
    }
    if raw.len() > MAX_STEPS {
        return Err(Failure::user(format!("a task holds at most {MAX_STEPS} steps")));
    }
    let steps = raw
        .iter()
        .enumerate()
        .map(|(i, s)| normalise_step(s, i))
        .collect::<Result<Vec<_>, _>>()?;
    let waited: f64 = steps
        .iter()
        .map(|s| match s["do"].as_str() {
            Some("wait") => s["seconds"].as_f64().unwrap_or(0.0),
            Some("countdown") => s["minutes"].as_f64().unwrap_or(0.0) * 60.0,
            _ => 0.0,
        })
        .sum();
    if waited > MAX_WAIT_SECONDS {
        return Err(Failure::user(format!(
            "the waits add up to {} minutes; keep them under {}",
            js::number_to_string(js_round(waited / 60.0)),
            js::number_to_string(MAX_WAIT_SECONDS / 60.0)
        )));
    }
    let mut out = Map::new();
    out.insert("type".into(), json!("steps"));
    out.insert("steps".into(), Value::Array(steps));
    out.insert(
        "onlyWhenRunning".into(),
        json!(input.get("onlyWhenRunning") == Some(&json!(true))),
    );
    out.insert(
        "keepGoing".into(),
        json!(input.get("keepGoing") == Some(&json!(true))),
    );
    Ok(Value::Object(out))
}

pub(crate) fn plural(n: f64, word: &str) -> String {
    format!(
        "{} {word}{}",
        js::number_to_string(n),
        if n == 1.0 { "" } else { "s" }
    )
}

fn duration(s: f64) -> String {
    if s % 60.0 == 0.0 {
        plural(s / 60.0, "minute")
    } else if s < 60.0 {
        plural(s, "second")
    } else {
        format!(
            "{}m {}s",
            js::number_to_string((s / 60.0).floor()),
            js::number_to_string(s % 60.0)
        )
    }
}

/// `describeStep(step)`.
pub fn describe_step(step: &Value) -> String {
    let field = |k: &str| js::string(step.get(k));
    let num = |k: &str| js::number(step.get(k));
    match step.get("do").and_then(Value::as_str).unwrap_or("") {
        "say" => format!("tell the players \"{}\"", field("text")),
        "command" => format!("run \"{}\"", field("line")),
        "wait" => format!("wait {}", duration(num("seconds"))),
        "countdown" => format!("a {} countdown", plural(num("minutes"), "minute")),
        "backup" => {
            if js::truthy(step.get("keep")) {
                format!("back up, keeping {}", field("keep"))
            } else {
                "back up".into()
            }
        }
        "verify" => "verify the backups".into(),
        _ => js::string(step.get("do")),
    }
}

/// What a step does, given by the caller: `deps` of `runSteps`.
pub trait Deps {
    fn is_running(&mut self) -> bool;
    fn send(&mut self, line: &str) -> Result<(), String>;
    fn sleep(&mut self, ms: f64);
    fn backup(&mut self, keep: &Value) -> Result<String, String>;
    fn verify(&mut self) -> Result<String, String>;
    fn stop(&mut self) -> Result<(), String>;
    /// `{ failed, timedOut, reason }`
    fn start(&mut self) -> Result<(bool, bool, String), String>;
}

/// How a chain ended: `ok`, `skipped` or `FAILED`, the run line's detail, and each failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub status: &'static str,
    pub detail: String,
    pub failures: Vec<String>,
}

/// `runSteps(action, deps)`: a step with nothing to act on is skipped, not failed. A failed step
/// ends the chain unless `keepGoing` is set, so a restart never follows a backup that did not
/// happen.
pub fn run_steps(action: &Value, deps: &mut dyn Deps) -> Outcome {
    if action.get("onlyWhenRunning") == Some(&json!(true)) && !deps.is_running() {
        return Outcome {
            status: "skipped",
            detail: "the server was not running, and this task only runs while it is".into(),
            failures: Vec::new(),
        };
    }
    let steps = action
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let keep_going = js::truthy(action.get("keepGoing"));
    let mut done = Vec::new();
    let mut failures = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        match run_step(step, deps) {
            Ok(said) => done.push(said),
            Err(why) => {
                failures.push(format!("step {} ({}) failed: {why}", i + 1, describe_step(step)));
                done.push(format!("{} FAILED", describe_step(step)));
                if !keep_going {
                    let left = steps.len() - i - 1;
                    let tail = if left > 0 {
                        format!("; stopped there, {} not run", plural(left as f64, "step"))
                    } else {
                        String::new()
                    };
                    return Outcome {
                        status: "FAILED",
                        detail: format!("{}{tail}", done.join("; ")),
                        failures,
                    };
                }
            }
        }
    }
    Outcome {
        status: if failures.is_empty() { "ok" } else { "FAILED" },
        detail: done.join("; "),
        failures,
    }
}

fn started(res: (bool, bool, String)) -> Result<(), String> {
    match res {
        (true, _, reason) => Err(format!("it stopped again: {reason}")),
        (_, true, _) => Err("it had not finished starting".into()),
        _ => Ok(()),
    }
}

fn run_step(step: &Value, deps: &mut dyn Deps) -> Result<String, String> {
    let running = deps.is_running();
    let field = |k: &str| js::string(step.get(k));
    let num = |k: &str| js::number(step.get(k));
    match step.get("do").and_then(Value::as_str).unwrap_or("") {
        "say" => {
            if !running {
                return Ok("nobody to tell (not running)".into());
            }
            deps.send(&format!("say {}", field("text")))?;
            Ok(format!("told the players \"{}\"", field("text")))
        }
        "command" => {
            if !running {
                return Ok(format!("\"{}\" not sent (not running)", field("line")));
            }
            deps.send(&field("line"))?;
            Ok(format!("ran \"{}\"", field("line")))
        }
        "wait" => {
            deps.sleep(num("seconds") * 1000.0);
            Ok(format!("waited {}", duration(num("seconds"))))
        }
        "countdown" => {
            if !running {
                return Ok("no countdown (not running)".into());
            }
            // the full figure, then one minute, then ten seconds; announcements are best-effort
            let minutes = num("minutes");
            let message = field("message");
            let mut remaining = minutes * 60.0;
            let _ = deps.send(&format!("say {message} in {}", plural(minutes, "minute")));
            if remaining > 60.0 {
                deps.sleep((remaining - 60.0) * 1000.0);
                remaining = 60.0;
                let _ = deps.send(&format!("say {message} in 1 minute"));
            }
            deps.sleep((remaining - 10.0) * 1000.0);
            let _ = deps.send(&format!("say {message} in 10 seconds"));
            deps.sleep(10_000.0);
            Ok(format!("counted down {}", plural(minutes, "minute")))
        }
        "backup" => deps.backup(step.get("keep").unwrap_or(&Value::Null)),
        "verify" => deps.verify(),
        "stop" => {
            if !running {
                return Ok("already stopped".into());
            }
            deps.stop()?;
            Ok("stopped".into())
        }
        "start" => {
            if running {
                return Ok("already running".into());
            }
            started(deps.start()?)?;
            Ok("started".into())
        }
        "restart" => {
            if running {
                deps.stop()?;
            }
            started(deps.start()?)?;
            Ok(if running {
                "restarted"
            } else {
                "started (it was not running)"
            }
            .into())
        }
        _ => Err(format!("unknown step \"{}\"", field("do"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_checked_and_cut_to_their_fields() {
        let s = normalise_steps(&json!({ "steps": [
            { "do": "say", "text": "  hi  " },
            { "do": "command", "line": "/save-all", "x": 1 },
            { "do": "wait", "seconds": 2.5 },
            { "do": "countdown", "minutes": "3", "message": "" },
            { "do": "backup", "keep": 400 },
            { "do": "restart" }
        ], "keepGoing": true }))
        .unwrap();
        assert_eq!(
            crate::jsjson::stringify(&s),
            crate::jsjson::stringify(&json!({ "type": "steps", "steps": [
                { "do": "say", "text": "hi" },
                { "do": "command", "line": "save-all" },
                { "do": "wait", "seconds": 5 },
                { "do": "countdown", "minutes": 3, "message": "Server restarting" },
                { "do": "backup", "keep": 365 },
                { "do": "restart" }
            ], "onlyWhenRunning": false, "keepGoing": true }))
        );
        assert_eq!(
            normalise_steps(&json!({ "steps": [{ "do": "dance" }] }))
                .unwrap_err()
                .message(),
            "step 1: \"dance\" is not a step - one of say, command, wait, countdown, backup, verify, stop, start, restart"
        );
        assert_eq!(
            normalise_steps(&json!({})).unwrap_err().message(),
            "add at least one step"
        );
        assert_eq!(
            normalise_steps(&json!({ "steps": [{ "do": "wait", "seconds": 3600 }, { "do": "wait", "seconds": 3600 }, { "do": "wait", "seconds": 60 }] }))
                .unwrap_err()
                .message(),
            "the waits add up to 121 minutes; keep them under 120"
        );
    }

    #[test]
    fn steps_read_as_sentences() {
        assert_eq!(
            describe_step(&json!({ "do": "wait", "seconds": 90 })),
            "wait 1m 30s"
        );
        assert_eq!(
            describe_step(&json!({ "do": "wait", "seconds": 120 })),
            "wait 2 minutes"
        );
        assert_eq!(
            describe_step(&json!({ "do": "wait", "seconds": 5 })),
            "wait 5 seconds"
        );
        assert_eq!(
            describe_step(&json!({ "do": "countdown", "minutes": 1 })),
            "a 1 minute countdown"
        );
        assert_eq!(
            describe_step(&json!({ "do": "backup", "keep": 3 })),
            "back up, keeping 3"
        );
        assert_eq!(describe_step(&json!({ "do": "backup", "keep": null })), "back up");
        assert_eq!(describe_step(&json!({ "do": "stop" })), "stop");
    }
}
