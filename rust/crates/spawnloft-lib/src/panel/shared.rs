//! What several route families say the same way: a server or a database as the page gets it
//! (`safeInstance`, `safeDatabase`, `labelled` of `ui.mjs`).

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{java, js, jspath, plugins, props, services, supervisor, util};

/// `supervisor.statusOf(name)`: the record with what is known of its process.
pub fn status_row(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    Ok(supervisor::status_of(layout, name)?.0)
}

/// `safeInstance(row)`: a server for the page. The RCON password never goes to a page (browser
/// cache, screenshots, pasted reports).
pub fn safe_instance(row: &Instance) -> Result<Value, Failure> {
    let mut safe = row.fields.clone();
    let rcon = safe.shift_remove("rcon");
    // online-mode lives in server.properties, not the registry
    let mut online_mode = Value::Null;
    let mut level_name = Value::Null;
    // a missing folder is already reported through status
    // (a record whose `dir` is not text: `path.join` throws, and that is caught the same way)
    if let Some(Value::String(dir)) = row.get("dir")
        && let Ok(p) = props::read(Path::new(&jspath::join(&[dir, "server.properties"])))
    {
        online_mode = json!(props::get(&p, "online-mode") != Some("false"));
        level_name = json!(
            props::get(&p, "level-name")
                .filter(|v| !v.is_empty())
                .unwrap_or("world")
        );
    }
    let rcon_port = match rcon.as_ref().and_then(|r| r.get("port")) {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    };
    safe.insert("rconPort".into(), rcon_port);
    safe.insert("onlineMode".into(), online_mode);
    safe.insert("levelName".into(), level_name);
    safe.insert(
        "javaNeeds".into(),
        json!(java::required_major(plugins::mc_version_of(row).as_deref())),
    );
    // what it would launch with if it had no Java arguments of its own
    if !row.is_database() {
        let memory = match row.get("memory") {
            None | Some(Value::Null) => "4G".to_string(),
            v => js::string(v),
        };
        let flags = registry::jvm_flags_for(&memory).map_err(Failure::user)?;
        safe.insert("defaultJvmFlags".into(), json!(flags));
    }
    Ok(Value::Object(safe))
}

/// `labelled(name, raw)`: records a label that says more than the name, and answers the server
/// as [`status_row`] does.
pub fn labelled(layout: &Layout, name: &str, raw: Option<&Value>) -> Result<Instance, Failure> {
    let label = match raw {
        None | Some(Value::Null) => None,
        v => util::clean_label(&js::string(v)),
    };
    if let Some(label) = label.filter(|l| l != name) {
        let mut patch = Map::new();
        patch.insert("label".into(), json!(label));
        registry::update_instance(Path::new(&layout.registry_file), name, &patch)?;
    }
    status_row(layout, name)
}

/// `safeDatabase(row)`: a database for the page, without the root and attachment passwords; the
/// page asks for credentials when it needs them.
pub fn safe_database(row: &Instance) -> Value {
    let mut safe = row.fields.clone();
    let root = safe.shift_remove("root");
    let attachments = safe.shift_remove("attachments");
    safe.shift_remove("tools");
    let mut shown = Map::new();
    // `Object.entries(attachments ?? {})`: a list or a text has entries too
    if let Some(all) = attachments.as_ref().filter(|a| !a.is_null()) {
        for (server, a) in registry::entries_of(all) {
            let of = |k: &str| a.get(k).cloned().unwrap_or(Value::Null);
            // a field that is not there is left out of the JSON, as `undefined` is
            let mut one = Map::new();
            for k in ["database", "user"] {
                if a.get(k).is_some() {
                    one.insert(k.into(), of(k));
                }
            }
            one.insert("createdAt".into(), of("createdAt"));
            shown.insert(server, Value::Object(one));
        }
    }
    let engine = row.get("engine");
    let named = engine.and_then(Value::as_str).and_then(services::Engine::named);
    // `engine?.label ?? row.engine`: a record with no engine at all has neither key in its JSON
    let or_engine = |v: Option<&str>| v.map(|v| json!(v)).or_else(|| engine.cloned());
    let host = match row.get("host") {
        None | Some(Value::Null) => json!("127.0.0.1"),
        Some(v) => v.clone(),
    };
    let root_user = match root.as_ref().and_then(|r| r.get("user")) {
        None | Some(Value::Null) => json!("root"),
        Some(v) => v.clone(),
    };
    for (key, value) in [
        ("engineLabel", or_engine(named.map(services::Engine::label))),
        ("engineKind", or_engine(named.map(services::Engine::kind))),
    ] {
        match value {
            Some(v) => safe.insert(key.into(), v),
            None => safe.shift_remove(key),
        };
    }
    safe.insert("external".into(), json!(js::truthy(row.get("external"))));
    safe.insert("host".into(), host);
    safe.insert("rootUser".into(), root_user);
    safe.insert("attachments".into(), Value::Object(shown));
    Value::Object(safe)
}
