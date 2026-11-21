//! Printing: `cli-output.mjs`'s envelope, `cli-query.mjs`'s queries, and stdout that ends the
//! command quietly when its reader goes away (mcctl.mjs exits 0 on EPIPE).

use serde_json::{Map, Value, json};
use std::io::Write;
use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::{diagnose, jsjson, supervisor};

use super::{Ctx, check_flags, instance_name};

/// The process's stdout and stderr, or buffers for tests.
#[derive(Debug, Default)]
pub struct Out {
    capture: Option<(Vec<u8>, Vec<u8>)>,
    closed: bool,
    code: Option<u8>,
}

impl Out {
    pub fn stdio() -> Out {
        Out::default()
    }
    #[cfg(test)]
    pub fn captured() -> Out {
        Out {
            capture: Some((Vec::new(), Vec::new())),
            ..Out::default()
        }
    }
    /// Writes to stdout; a closed stdout ends the command with exit 0, as the Node CLI does.
    pub fn print(&mut self, text: &str) {
        if self.closed {
            return;
        }
        match &mut self.capture {
            Some((o, _)) => o.extend_from_slice(text.as_bytes()),
            None => {
                let mut s = std::io::stdout().lock();
                if s.write_all(text.as_bytes()).and_then(|()| s.flush()).is_err() {
                    std::process::exit(0);
                }
            }
        }
    }
    /// `out(line)`: the line and a newline.
    pub fn line(&mut self, text: &str) {
        self.print(&format!("{text}\n"));
    }
    pub fn err(&mut self, text: &str) {
        match &mut self.capture {
            Some((_, e)) => e.extend_from_slice(text.as_bytes()),
            None => {
                let _ = std::io::stderr().write_all(text.as_bytes());
            }
        }
    }
    /// `process.exitCode = n`, for a command that ends normally with a code of its own.
    pub fn set_code(&mut self, code: u8) {
        self.code = Some(code);
    }
    pub fn code(&self) -> u8 {
        self.code.unwrap_or(0)
    }
    #[cfg(test)]
    pub fn stdout_text(&self) -> String {
        self.capture
            .as_ref()
            .map(|(o, _)| String::from_utf8_lossy(o).into_owned())
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub fn stderr_text(&self) -> String {
        self.capture
            .as_ref()
            .map(|(_, e)| String::from_utf8_lossy(e).into_owned())
            .unwrap_or_default()
    }
}

/// `envelope(command, data, { error, type })` as one line (`jsonLine`).
pub fn json_line(command: &str, data: Option<&Value>, failure: Option<&Failure>) -> String {
    json_line_typed(command, data, failure, None)
}

pub fn json_line_typed(
    command: &str,
    data: Option<&Value>,
    failure: Option<&Failure>,
    kind: Option<&str>,
) -> String {
    let mut env = Map::new();
    env.insert("schemaVersion".into(), json!(1));
    env.insert("command".into(), json!(command));
    env.insert("ok".into(), json!(failure.is_none()));
    let kind = if failure.is_some() { Some("error") } else { kind };
    if let Some(k) = kind {
        env.insert("type".into(), json!(k));
    }
    if let Some(d) = data {
        env.insert("data".into(), d.clone());
    }
    if let Some(f) = failure {
        env.insert(
            "error".into(),
            json!({ "code": f.json_code(), "message": f.message() }),
        );
    }
    format!("{}\n", jsjson::stringify(&Value::Object(env)))
}

fn field(inst: &Instance, key: &str) -> Value {
    inst.get(key).cloned().unwrap_or(Value::Null)
}

/// `row.rcon?.port ?? null`.
pub fn rcon_port(inst: &Instance) -> Value {
    match inst.get("rcon") {
        Some(Value::Object(r)) => r.get("port").cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// `statusRecord(name)`: the public record, with no credentials.
pub fn status_record(ctx: &Ctx<'_>, name: &str) -> Result<Value, Failure> {
    let (row, _) = supervisor::status_of(ctx.layout, name)?;
    Ok(record_of(&row))
}

pub fn record_of(row: &Instance) -> Value {
    let external = spawnloft_lib::js::truthy(row.get("external"));
    let kind = match row.get("kind") {
        None | Some(Value::Null) => json!("server"),
        Some(v) => v.clone(),
    };
    json!({
        "name": row.name,
        "label": field(row, "label"),
        "kind": kind,
        "status": if external { json!("external") } else { field(row, "status") },
        "directory": field(row, "dir"),
        "jar": field(row, "jar"),
        "memory": field(row, "memory"),
        "port": field(row, "port"),
        "rconPort": rcon_port(row),
        "engine": field(row, "engine"),
        "external": external,
        "javaPid": field(row, "javaPid"),
        "daemonPid": field(row, "daemonPid"),
        "javaAlive": field(row, "javaAlive"),
        "startedAt": field(row, "startedAt"),
        "uptimeMs": field(row, "uptimeMs"),
        "exitCode": field(row, "exitCode"),
        "consoleLog": field(row, "consoleLog"),
    })
}

/// The `diagnose()` context of a server, as `why` builds it.
pub fn diagnose_context(inst: &Instance) -> diagnose::Context {
    let text = |key: &str| match inst.get(key) {
        None | Some(Value::Null) => None,
        v => Some(spawnloft_lib::js::string(v)),
    };
    let dir = inst.get("dir").map(|d| spawnloft_lib::js::string(Some(d)));
    diagnose::Context {
        port: text("port"),
        memory: text("memory"),
        crash_dir: dir
            .as_deref()
            .map(|d| spawnloft_lib::jspath::join(&[d, "crash-reports"])),
        dir: inst
            .get("dir")
            .filter(|v| spawnloft_lib::js::truthy(Some(v)))
            .map(|d| spawnloft_lib::js::string(Some(d))),
        panel: false,
    }
}

/// `inst.dir` where Node passes it to `path.join`, which refuses anything but a string.
pub fn dir_text(inst: &Instance) -> Result<String, Failure> {
    match inst.get("dir") {
        Some(Value::String(s)) => Ok(s.clone()),
        other => Err(Failure::Internal {
            head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
            message: format!(
                "The \"path\" argument must be of type string. {}",
                received(other)
            ),
            code: Some("ERR_INVALID_ARG_TYPE".into()),
        }),
    }
}

/// The tail of Node's ERR_INVALID_ARG_TYPE message.
pub fn received(v: Option<&Value>) -> String {
    match v {
        None => "Received undefined".into(),
        Some(Value::Null) => "Received null".into(),
        Some(Value::Bool(b)) => format!("Received type boolean ({b})"),
        Some(Value::Number(_)) => format!("Received type number ({})", spawnloft_lib::js::string(v)),
        Some(Value::String(s)) => format!("Received type string ('{s}')"),
        Some(Value::Array(_)) => "Received an instance of Array".into(),
        Some(Value::Object(_)) => "Received an instance of Object".into(),
    }
}

/// `crashReports(inst, { limit })` as JSON.
pub fn crashes_json(dir: &str, limit: usize) -> Result<Value, Failure> {
    let (dir, reports) = diagnose::crash_reports(dir, limit)?;
    Ok(
        json!({ "dir": dir, "reports": reports.iter().map(diagnose::CrashReport::to_json).collect::<Vec<_>>() }),
    )
}

/// `query(command, positional, flags)` for the ported query commands.
pub fn query(ctx: &mut Ctx<'_>, command: &str) -> Result<Value, Failure> {
    check_flags(ctx.args, &["json"])?;
    let positional = &ctx.args.positional;
    let registry_file = Path::new(&ctx.layout.registry_file);
    if command == "list" || (command == "status" && positional.is_empty()) {
        if !positional.is_empty() {
            return Err(Failure::usage("Usage: spawnloft list --json"));
        }
        let mut instances = Vec::new();
        for row in registry::list_instances(registry_file)? {
            instances.push(status_record(ctx, &row.name)?);
        }
        let mut databases = Vec::new();
        for row in registry::list_services(registry_file)? {
            databases.push(status_record(ctx, &row.name)?);
        }
        return Ok(json!({ "instances": instances, "databases": databases }));
    }
    let name = instance_name(positional, command)?.to_string();
    let inst = registry::lookup(registry_file, &name)?;
    match command {
        "status" => status_record(ctx, &name),
        "diagnostics" => {
            let lines = supervisor::tail_log(Path::new(&ctx.layout.console_log(&name)), 400.0)?;
            let dir = dir_text(&inst)?;
            let findings = diagnose::diagnose(&lines, &diagnose_context(&inst));
            let status = status_record(ctx, &name)?;
            Ok(json!({
                "instance": name,
                "status": status,
                "findings": findings.iter().map(diagnose::Finding::to_json).collect::<Vec<_>>(),
                "crashes": crashes_json(&dir, 5)?,
                "scope": "recent-console-and-crash-reports",
            }))
        }
        // plugins and backups are not ported: the ownership table never sends them here
        other => Err(Failure::usage(format!(
            "JSON output is not supported for {other}"
        ))),
    }
}
