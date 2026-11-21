//! `status <name>`: `cmdStatus` and `databaseStatus` in mcctl.mjs. With no name it is `list`.

use serde_json::Value;

use spawnloft_lib::control::Status;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::Instance;
use spawnloft_lib::{js, jspath, props, supervisor, text};

use super::Ctx;
use super::list::{attachment_names, cell, engine_label};
use super::output::dir_text;

fn s(v: &str) -> String {
    v.to_string()
}

/// `x ?? fallback` as a cell.
fn or(inst: &Instance, key: &str, fallback: &str) -> String {
    match inst.get(key) {
        None | Some(Value::Null) => fallback.into(),
        v => js::string(v),
    }
}

/// `String(x)`.
fn string(inst: &Instance, key: &str) -> String {
    js::string(inst.get(key))
}

fn tail_rows(st: &Instance, status: Status, pid_label: &str, rows: &mut Vec<[String; 2]>) {
    if matches!(status, Status::Running | Status::Stopping) {
        let uptime = st.get("uptimeMs").and_then(Value::as_f64);
        rows.push([s(pid_label), string(st, "javaPid")]);
        rows.push([s("daemon pid"), string(st, "daemonPid")]);
        rows.push([s("uptime"), text::human_duration(uptime)]);
    } else if !matches!(st.get("exitCode"), None | Some(Value::Null)) {
        rows.push([s("last exit code"), string(st, "exitCode")]);
    }
    rows.push([s("console log"), cell(st.get("consoleLog"))]);
}

fn print(ctx: &mut Ctx<'_>, rows: Vec<[String; 2]>) {
    let table: Vec<Vec<String>> = rows.into_iter().map(|[k, v]| vec![format!("{k}:"), v]).collect();
    ctx.out.line(&text::table(&table));
}

pub fn status(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let Some(name) = ctx.args.positional.first().filter(|n| !n.is_empty()).cloned() else {
        return super::list::list(ctx);
    };
    let (st, status) = supervisor::status_of(ctx.layout, &name)?;
    if st.is_database() {
        let rows = vec![
            [s("database"), st.name.clone()],
            [s("label"), or(&st, "label", "(none)")],
            [s("status"), status.label().into()],
            [
                s("engine"),
                format!("{} {}", engine_label(st.get("engine")), string(&st, "version")),
            ],
            [s("directory"), cell(st.get("dir"))],
            [s("host"), s("127.0.0.1")],
            [s("port"), string(&st, "port")],
            [s("attached"), {
                let a = attachment_names(st.get("attachments"));
                if a.is_empty() { s("(none)") } else { a }
            }],
        ];
        let mut rows = rows;
        tail_rows(&st, status, "engine pid", &mut rows);
        print(ctx, rows);
        return Ok(());
    }
    let dir = dir_text(&st)?;
    let p = props::read(&jspath::join_path(&dir, &["server.properties"]))?;
    let prop = |key: &str| props::get(&p, key).map_or_else(|| s("(unset)"), String::from);
    let java = if js::truthy(st.get("java")) {
        string(&st, "java")
    } else {
        s("java")
    };
    let rcon = match st.get("rcon") {
        Some(Value::Object(r)) => match r.get("port") {
            None | Some(Value::Null) => s("-"),
            v => js::string(v),
        },
        _ => s("-"),
    };
    let mut rows = vec![
        [s("instance"), st.name.clone()],
        [s("label"), or(&st, "label", "(none)")],
        [s("status"), status.label().into()],
        [s("directory"), cell(st.get("dir"))],
        [s("jar"), cell(st.get("jar"))],
        [s("memory"), cell(st.get("memory"))],
        [s("java"), java],
        [s("port"), string(&st, "port")],
        [s("rcon port"), rcon],
        [s("level-name"), prop("level-name")],
        [s("motd"), prop("motd")],
        [s("online-mode"), prop("online-mode")],
    ];
    tail_rows(&st, status, "java pid", &mut rows);
    print(ctx, rows);
    Ok(())
}
