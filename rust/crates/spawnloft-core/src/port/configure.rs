//! `set <name> key=value...` and `props <name> [key=value...]`: `cmdSet` and `cmdProps` in
//! mcctl.mjs (C2).

use serde_json::{Map, Value, json};
use std::path::Path;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::{create, js, jsjson, jspath, notify, props, supervisor, text, util};

use super::Ctx;
use super::output::dir_text;

/// `pair.split('=')`: the key, and the rest joined again (`None` with no `=` at all).
fn split_pair(pair: &str) -> (&str, Option<&str>) {
    match pair.split_once('=') {
        Some((k, v)) => (k, Some(v)),
        None => (pair, None),
    }
}

fn malformed(pair: &str) -> Failure {
    Failure::user(format!("malformed assignment \"{pair}\" - expected key=value"))
}

/// `assertPortUsable(name, Number(value), label)`.
fn port_usable(registry_file: &Path, name: &str, value: &str, label: &str) -> Result<u16, Failure> {
    let n = js::string_to_number(value);
    if !(n.is_finite() && n.fract() == 0.0 && (1.0..=65535.0).contains(&n)) {
        return Err(Failure::user(format!(
            "{} is not a {label} number - use 1 to 65535",
            js::number_to_string(n)
        )));
    }
    registry::assert_port_usable(registry_file, name, &json!(n as u16), label)
}

/// `{ ...(patch.rcon ?? inst.rcon), [key]: value }`.
fn rcon_with(patch: &Map<String, Value>, inst: &Instance, key: &str, value: Value) -> Value {
    let base = patch.get("rcon").or_else(|| inst.get("rcon"));
    let mut out = Map::new();
    if let Some(b) = base {
        for (k, v) in registry::entries_of(b) {
            out.insert(k, v);
        }
    }
    out.insert(key.to_string(), value);
    Value::Object(out)
}

/// `${typeof v === 'object' ? JSON.stringify(v) : v}`.
fn shown(v: &Value) -> String {
    match v {
        Value::Null | Value::Object(_) | Value::Array(_) => jsjson::stringify(v),
        other => js::string(Some(other)),
    }
}

pub fn set(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "set")?.to_string();
    let assignments = &ctx.args.positional[1..];
    if assignments.is_empty() {
        return Err(Failure::user(
            "set requires key=value pairs, e.g. spawnloft set survival memory=8G",
        ));
    }
    let registry_file = Path::new(&ctx.layout.registry_file);
    let inst = registry::lookup(registry_file, &name)?;
    let mut patch = Map::new();
    for pair in assignments {
        let (key, value) = split_pair(pair);
        let value = value.unwrap_or("");
        if value.is_empty() {
            return Err(malformed(pair));
        }
        let lower = value.to_lowercase();
        match key {
            "memory" | "java" | "jar" => {
                patch.insert(key.into(), json!(value));
            }
            "label" => {
                let label = if lower == "off" {
                    Value::Null
                } else {
                    util::clean_label(value).map_or(Value::Null, Value::String)
                };
                patch.insert("label".into(), label);
            }
            "port" => {
                let p = port_usable(registry_file, &name, value, "port")?;
                patch.insert("port".into(), json!(p));
            }
            "rcon.port" => {
                let p = port_usable(registry_file, &name, value, "RCON port")?;
                let r = rcon_with(&patch, &inst, "port", json!(p));
                patch.insert("rcon".into(), r);
            }
            "rcon.password" => {
                let r = rcon_with(&patch, &inst, "password", json!(value));
                patch.insert("rcon".into(), r);
            }
            "auto-restart" => {
                if !["on", "off", "true", "false"].contains(&lower.as_str()) {
                    return Err(Failure::user("auto-restart takes on or off"));
                }
                patch.insert("autoRestart".into(), json!(lower == "on" || lower == "true"));
            }
            "webhook" => {
                if lower == "off" {
                    patch.insert("webhook".into(), Value::Null);
                } else {
                    if !notify::acceptable_webhook(value) {
                        return Err(Failure::user(format!(
                            "\"{value}\" is not an http(s) URL - paste the one Discord gives you"
                        )));
                    }
                    patch.insert("webhook".into(), json!(value));
                }
            }
            _ => {
                return Err(Failure::user(format!(
                    "unknown setting \"{key}\" - one of: label, memory, java, jar, port, rcon.port, rcon.password, auto-restart, webhook"
                )));
            }
        }
    }
    let jar = patch.get("jar").and_then(Value::as_str).map(str::to_string);
    // the jar is placed before the record names it: a server runs the jar in its own folder
    if let Some(j) = &jar {
        create::place_jar(&ctx.layout.jars_dir, &dir_text(&inst)?, j)?;
    }
    registry::update_instance(registry_file, &name, &patch)?;
    ctx.out.line(&format!("Updated \"{name}\":"));
    for (k, v) in &patch {
        ctx.out.line(&format!("  {k} = {}", shown(v)));
    }
    if let Some(j) = &jar {
        let dir = dir_text(&inst)?;
        let stray = create::stray_jars(&dir, j);
        if !stray.is_empty() {
            ctx.out.line("");
            ctx.out
                .line(&format!("{} older jar(s) left in {dir}:", stray.len()));
            for (n, size) in &stray {
                ctx.out
                    .line(&format!("  {n}  {}", text::human_bytes(Some(*size as f64))));
            }
            ctx.out
                .line("Kept on purpose - they are how you go back. Delete them when you are sure.");
        }
    }
    if supervisor::is_running(ctx.layout, &name)? {
        ctx.out.line("Restart the instance for changes to take effect.");
    }
    Ok(())
}

/// `a < b` for strings in JavaScript: UTF-16 code units.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub fn props(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "props")?.to_string();
    let inst = registry::lookup(Path::new(&ctx.layout.registry_file), &name)?;
    let file = jspath::join(&[&dir_text(&inst)?, "server.properties"]);
    let assignments = &ctx.args.positional[1..];

    if assignments.is_empty() {
        let read = props::read(Path::new(&file))?;
        // `[...map.entries()].sort()`: each [key, value] compared as the text "key,value"
        let mut rows: Vec<(String, String)> = read
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
            .collect();
        rows.sort_by(|a, b| utf16_cmp(&format!("{},{}", a.0, a.1), &format!("{},{}", b.0, b.1)));
        let table: Vec<Vec<String>> = rows.into_iter().map(|(k, v)| vec![format!("{k}:"), v]).collect();
        ctx.out.line(&text::table(&table));
        return Ok(());
    }
    let mut updates: Vec<(String, String)> = Vec::new();
    for pair in assignments {
        let (key, value) = split_pair(pair);
        let Some(value) = value else {
            return Err(malformed(pair));
        };
        updates.push((key.to_string(), value.to_string()));
    }
    // a plain object: a repeated key keeps its first place and last value, index-like keys first
    let updates = js::object_entries(updates);
    props::write(Path::new(&file), &updates)?;
    ctx.out.line(&format!("Updated {file}:"));
    for (k, v) in &updates {
        ctx.out.line(&format!("  {k}={v}"));
    }
    if supervisor::is_running(ctx.layout, &name)? {
        ctx.out.line("Restart the instance for changes to take effect.");
    }
    Ok(())
}
