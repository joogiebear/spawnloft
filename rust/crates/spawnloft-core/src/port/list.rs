//! `list` (and `ls`, and `status` with no name): `cmdList` and `databaseRows` in mcctl.mjs.

use serde_json::Value;
use std::path::Path;

use spawnloft_lib::control::{self, Status};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::{js, settings, text, time};

use super::Ctx;

/// `String(c ?? '')`, as `table` prints a cell.
pub fn cell(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    }
}

/// `inst.rcon?.port ?? '-'`.
fn rcon_cell(inst: &Instance) -> String {
    match inst.get("rcon") {
        Some(Value::Object(r)) => match r.get("port") {
            None | Some(Value::Null) => "-".into(),
            v => js::string(v),
        },
        _ => "-".into(),
    }
}

/// `status === 'running' && state?.startedAt ? humanDuration(Date.now() - state.startedAt) : '-'`.
pub fn uptime_cell(status: Status, state: Option<&serde_json::Map<String, Value>>) -> String {
    let started = state.and_then(|s| s.get("startedAt"));
    if status == Status::Running && js::truthy(started) {
        text::human_duration(Some(time::now_ms() as f64 - js::number(started)))
    } else {
        "-".into()
    }
}

/// `services.ENGINES[engine]?.label ?? engine`, then the version, as the tables print it.
pub fn engine_label(engine: Option<&Value>) -> String {
    match engine.and_then(Value::as_str) {
        Some("mariadb") => "MariaDB".into(),
        Some("garnet") => "Redis (Garnet)".into(),
        Some("mysql") => "MySQL".into(),
        _ => js::string(engine),
    }
}

/// `Object.keys(x ?? {}).join(', ')`.
pub fn attachment_names(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => registry::entries_of(v)
            .into_iter()
            .map(|(k, _)| k)
            .collect::<Vec<_>>()
            .join(", "),
    }
}

pub fn list(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let registry_file = Path::new(&ctx.layout.registry_file);
    let instances = registry::list_instances(registry_file)?;
    if instances.is_empty() {
        ctx.out
            .line(&format!("No instances registered in {}.", ctx.layout.data_root));
        for line in settings::describe_servers_elsewhere(&ctx.layout.data_root) {
            ctx.out.line(&format!("  NOTE: {line}"));
        }
        ctx.out.line("");
        ctx.out
            .line("  Adopt an existing server:  spawnloft adopt <name> <path-to-server-dir>");
        ctx.out
            .line("  Create a fresh one:        spawnloft new <name> --jar <jar> --accept-eula");
        return Ok(());
    }
    let mut rows = vec![
        ["NAME", "STATUS", "PORT", "RCON", "MEM", "UPTIME", "DIR"]
            .map(String::from)
            .to_vec(),
    ];
    for inst in &instances {
        let (status, state) = control::read_state(Path::new(&ctx.layout.state_file(inst.path_name()?)))?;
        rows.push(vec![
            inst.name.clone(),
            status.label().into(),
            cell(inst.get("port")),
            rcon_cell(inst),
            cell(inst.get("memory")),
            uptime_cell(status, state.as_ref()),
            cell(inst.get("dir")),
        ]);
    }
    ctx.out.line(&text::table(&rows));
    let dbs = registry::list_services(registry_file)?;
    if !dbs.is_empty() {
        ctx.out.line("");
        let mut rows = vec![
            [
                "DATABASE", "STATUS", "ENGINE", "PORT", "ATTACHED", "UPTIME", "DIR",
            ]
            .map(String::from)
            .to_vec(),
        ];
        for db in &dbs {
            let (status, state) = control::read_state(Path::new(&ctx.layout.state_file(db.path_name()?)))?;
            let external = js::truthy(db.get("external"));
            let version = match db.get("version") {
                None | Some(Value::Null) => String::new(),
                v => js::string(v),
            };
            let host = match db.get("host") {
                None | Some(Value::Null) => "127.0.0.1".into(),
                v => js::string(v),
            };
            let attached = attachment_names(db.get("attachments"));
            rows.push(vec![
                db.name.clone(),
                if external {
                    "external".into()
                } else {
                    status.label().into()
                },
                js::trim(&format!("{} {version}", engine_label(db.get("engine")))).to_string(),
                if external {
                    format!("{host}:{}", js::string(db.get("port")))
                } else {
                    cell(db.get("port"))
                },
                if attached.is_empty() { "-".into() } else { attached },
                uptime_cell(status, state.as_ref()),
                match db.get("dir") {
                    None | Some(Value::Null) => "-".into(),
                    v => js::string(v),
                },
            ]);
        }
        ctx.out.line(&text::table(&rows));
    }
    Ok(())
}
