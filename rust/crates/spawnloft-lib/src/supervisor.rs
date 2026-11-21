//! The read side of `supervisor.mjs`, pulled forward for C1 (rust/PLAN-CORE-PORT.md section 4):
//! a server's status record (`statusOf`), the tail of its console (`tailLog`) and following it
//! (`followLog`). Starting and stopping stay with the Node core until C2.

use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::control::{self, Status};
use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{js, jsjson, time};

/// `x ?? null`.
fn or_null(state: Option<&Map<String, Value>>, key: &str) -> Value {
    state.and_then(|s| s.get(key)).cloned().unwrap_or(Value::Null)
}

/// `statusOf(name)`: the registry record with the live status and the state file's figures.
pub fn status_of(layout: &Layout, name: &str) -> Result<(Instance, Status), Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    status_of_instance(layout, inst)
}

/// [`status_of`] for a record already read.
pub fn status_of_instance(layout: &Layout, inst: Instance) -> Result<(Instance, Status), Failure> {
    let name = inst.name.clone();
    let (status, state) = control::read_state(Path::new(&layout.state_file(&name)))?;
    let s = state.as_ref();
    let mut fields = inst.fields;
    let started = s.and_then(|m| m.get("startedAt"));
    let uptime = if status == Status::Running && js::truthy(started) {
        jsjson::num(time::now_ms() as f64 - js::number(started))
    } else {
        Value::Null
    };
    let restarts = match s.and_then(|m| m.get("restarts")) {
        None | Some(Value::Null) => json!(0),
        Some(v) => v.clone(),
    };
    let rows = [
        ("status", json!(status.as_str())),
        ("javaPid", or_null(s, "javaPid")),
        ("daemonPid", or_null(s, "daemonPid")),
        ("startedAt", or_null(s, "startedAt")),
        ("exitCode", or_null(s, "exitCode")),
        ("crashed", json!(js::truthy(s.and_then(|m| m.get("crashed"))))),
        ("restarts", restarts),
        ("stoppedAt", or_null(s, "stoppedAt")),
        ("lastError", or_null(s, "error")),
        ("uptimeMs", uptime),
        ("stateFile", json!(layout.state_file(&name))),
        ("consoleLog", json!(layout.console_log(&name))),
        (
            "javaAlive",
            json!(s.is_some() && control::pid_alive(s.and_then(|m| m.get("javaPid")))),
        ),
    ];
    for (k, v) in rows {
        fields.insert(k.into(), v);
    }
    Ok((Instance { name, fields }, status))
}

/// `array.slice(start)`'s first index for a JavaScript number `start`.
pub fn slice_start(len: usize, start: f64) -> usize {
    let rel = if start.is_nan() { 0.0 } else { start.trunc() };
    let len_f = len as f64;
    if rel < 0.0 {
        (len_f + rel).max(0.0) as usize
    } else {
        rel.min(len_f) as usize
    }
}

/// Splits on `\r?\n` as `text.split(/\r?\n/)` does.
pub fn split_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            let end = if i > start && b[i - 1] == b'\r' { i - 1 } else { i };
            out.push(text[start..end].to_string());
            start = i + 1;
        }
        i += 1;
    }
    out.push(text[start..].to_string());
    out
}

/// `tailLog(name, count)`: the last `count` lines of the console, read from the last
/// `max(64 KB, count * 512)` bytes. `count` is a JavaScript number, so a nonsense one fails the
/// way Node's `Buffer.alloc` does.
pub fn tail_log(file: &Path, count: f64) -> Result<Vec<String>, Failure> {
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(Vec::new());
    };
    let size = meta.len() as f64;
    // Math.max and Math.min keep a NaN, where f64::max and min drop it
    let scaled = count * 512.0;
    let want = if scaled.is_nan() {
        f64::NAN
    } else {
        scaled.max(65536.0)
    };
    let read_bytes = if want.is_nan() { f64::NAN } else { size.min(want) };
    if read_bytes.is_nan() {
        return Err(Failure::Internal {
            head: "RangeError [ERR_OUT_OF_RANGE]".into(),
            message:
                "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received NaN"
                    .into(),
            code: Some("ERR_OUT_OF_RANGE".into()),
        });
    }
    let n = read_bytes.trunc() as u64;
    let mut f = std::fs::File::open(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    f.seek(SeekFrom::Start(meta.len() - n))
        .map_err(|e| Failure::io(&e, "read", None))?;
    let mut buf = vec![0u8; n as usize];
    let mut got = 0;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(e) => return Err(Failure::io(&e, "read", None)),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = split_lines(&text);
    if size > read_bytes && !lines.is_empty() {
        // a partial first line
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let from = slice_start(lines.len(), -count);
    Ok(lines.split_off(from))
}

/// `followLog(name, onLine)`: polls the console every 250 ms from its current end (or the start
/// after a restart truncated it) and hands each whole new line to `on_line`. Returns when
/// `on_line` says to stop (`false`); read errors are retried at the next poll.
pub fn follow_log(file: &Path, mut on_line: impl FnMut(&str) -> bool) {
    let mut offset = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let mut carry = String::new();
    loop {
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        if size < offset {
            offset = 0;
            carry.clear();
        }
        if size > offset
            && let Ok(mut f) = std::fs::File::open(file)
            && f.seek(SeekFrom::Start(offset)).is_ok()
        {
            let mut buf = vec![0u8; (size - offset) as usize];
            if f.read_exact(&mut buf).is_ok() {
                offset = size;
                carry.push_str(&String::from_utf8_lossy(&buf));
                let mut parts = split_lines(&carry);
                carry = parts.pop().unwrap_or_default();
                for line in parts {
                    if !on_line(&line) {
                        return;
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_like_javascript() {
        assert_eq!(slice_start(3, -1.0), 2);
        assert_eq!(slice_start(3, -0.0), 0);
        assert_eq!(slice_start(3, -1.5), 2);
        assert_eq!(slice_start(3, f64::NEG_INFINITY), 0);
        assert_eq!(slice_start(3, 5.0), 3);
        assert_eq!(slice_start(3, f64::NAN), 0);
    }

    #[test]
    fn lines_split_on_crlf_and_lf() {
        assert_eq!(split_lines("a\r\nb\nc"), ["a", "b", "c"]);
        assert_eq!(split_lines("a\n"), ["a", ""]);
        assert_eq!(split_lines("\r"), ["\r"]);
    }

    #[test]
    fn tail_reads_the_last_lines() {
        let dir = std::env::temp_dir().join(format!("sl-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("console.log");
        std::fs::write(&f, "a\nb\nc\n\n").unwrap();
        assert_eq!(tail_log(&f, 2.0).unwrap(), ["b", "c"]);
        assert_eq!(tail_log(&f, 0.0).unwrap(), ["a", "b", "c"]);
        assert!(matches!(tail_log(&f, f64::NAN), Err(Failure::Internal { .. })));
        assert!(tail_log(&dir.join("none"), f64::NAN).unwrap().is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
