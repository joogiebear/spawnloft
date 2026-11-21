//! `plugin-actions.mjs` (C5 part 3): the plugin work the panel and the MCP server share, kept
//! apart from `plugin_sources` because it takes snapshots and asks the supervisor.

use serde_json::{Map, Value, json};

use crate::activity::Actor;
use crate::failure::Failure;
use crate::plugin_sources as sources;
use crate::plugins::{content_kind_for, loaders_for, mc_version_of};
use crate::registry::Instance;
use crate::settings::Layout;
use crate::{jspath, paths::Roots};

/// `searchEverywhere(inst, q)`: one source being down does not blank the other's results; a
/// failure becomes a note beside them. Node asks both at once; here Modrinth is asked first,
/// then Hangar, and the answer is the same.
pub fn search_everywhere(inst: &Instance, q: &str) -> Value {
    let kind = content_kind_for(inst);
    // vanilla loads nothing; a search would send Modrinth an empty loader facet and get a 400
    if kind.kind == "none" {
        return json!({ "results": [], "errors": [format!("{} runs no plugins or mods", kind.label)] });
    }
    let mut results = Vec::new();
    let mut errors = Vec::new();
    match sources::search_plugins(q, 20, &loaders_for(inst), kind.project_type) {
        Ok(hits) => results.extend(hits),
        Err(e) => errors.push(json!(e.message())),
    }
    if kind.hangar {
        match sources::search_hangar(q, 10) {
            Ok(hits) => results.extend(hits),
            Err(e) => errors.push(json!(e.message())),
        }
    }
    json!({ "results": results, "errors": errors })
}

/// `snapshotPlugins(inst, label)`: the plugins folder alone, before a jar is added or replaced
/// (a new plugin can rewrite other plugins' data on first start just as an update can).
fn snapshot_plugins(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    label: &str,
) -> Result<Option<String>, Failure> {
    let dir = crate::create::path_arg(inst.get("dir"), "path")?;
    if !std::path::Path::new(&jspath::join(&[dir, content_kind_for(inst).dir])).exists() {
        return Ok(None);
    }
    let made = crate::backup::create_snapshot(
        layout,
        by,
        inst,
        &crate::backup::Options {
            scope: "plugins".into(),
            label: json!(label),
            running: crate::supervisor::is_running(layout, &inst.name)?,
            quiet: true,
            change_copy: true,
            ..crate::backup::Options::default()
        },
    )?;
    Ok(Some(made.file))
}

fn base(file: &Option<String>) -> Option<String> {
    file.as_deref().map(jspath::basename)
}

fn record(layout: &Layout, by: &Actor, inst: &Instance, action: &str, detail: &str, snapshot: Option<&str>) {
    crate::activity::record_by(
        &Roots::new(&layout.data_root),
        by,
        &inst.name,
        action,
        Some(detail),
        snapshot,
        true,
    );
}

/// `planInstall(inst, projectId, { source })`: what an install would fetch and what it needs,
/// for the page to ask about before anything is written.
pub fn plan_install(inst: &Instance, project_id: &str, source: &str) -> Result<Value, Failure> {
    let source = if source == "hangar" { "hangar" } else { "modrinth" };
    sources::plan_install(inst, project_id, source, mc_version_of(inst).as_deref())
}

fn fetch_one(inst: &Instance, id: &str, from: &str, game_version: Option<&str>) -> Result<Value, Failure> {
    if from == "hangar" {
        sources::install_from_hangar(inst, id, game_version)
    } else {
        sources::install_plugin(inst, id, game_version)
    }
}

/// `${installed} ${version ?? ''}`.trim()
fn installed_detail(got: &Value) -> String {
    let version = match got.get("version") {
        None | Some(Value::Null) => String::new(),
        v => crate::js::string(v),
    };
    format!("{} {version}", crate::js::string(got.get("installed")))
        .trim()
        .to_string()
}

/// One thing to fetch alongside: a project id and where it lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Also {
    pub project_id: String,
    pub source: String,
}

/// `installWithSnapshot(inst, projectId, { source, also })`: what the thing asked for cannot
/// load without is fetched after it under the same one snapshot; one that fails is reported and
/// the rest carry on.
pub fn install_with_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    project_id: &str,
    source: &str,
    also: &[Also],
) -> Result<Value, Failure> {
    let game_version = mc_version_of(inst);
    let gv = game_version.as_deref();
    let snap = snapshot_plugins(layout, by, inst, "pre-install")?;
    let snapshot = base(&snap);
    let result = fetch_one(inst, project_id, source, gv)?;
    record(
        layout,
        by,
        inst,
        "plugin-install",
        &installed_detail(&result),
        snapshot.as_deref(),
    );
    let mut extras = Vec::new();
    let mut failed = Vec::new();
    for dep in also {
        match fetch_one(inst, &dep.project_id, &dep.source, gv) {
            Ok(got) => {
                extras.push(json!({
                    "projectId": dep.project_id,
                    "installed": got["installed"],
                    "version": got.get("version").cloned().unwrap_or(Value::Null),
                }));
                record(
                    layout,
                    by,
                    inst,
                    "plugin-install",
                    &installed_detail(&got),
                    snapshot.as_deref(),
                );
            }
            Err(e) => failed.push(json!({ "projectId": dep.project_id, "error": e.message() })),
        }
    }
    let mut out = match result {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("extras".into(), json!(extras));
    out.insert("failed".into(), json!(failed));
    out.insert("snapshot".into(), json!(snap));
    Ok(Value::Object(out))
}

/// `updateWithSnapshot(inst, file)`.
pub fn update_with_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    file: &str,
) -> Result<Value, Failure> {
    let game_version = mc_version_of(inst);
    let snap = snapshot_plugins(layout, by, inst, "pre-update")?;
    let result = sources::update_plugin(inst, file, game_version.as_deref())?;
    let detail = format!(
        "{} to {}",
        crate::js::string(result.get("from")),
        crate::js::string(result.get("updated"))
    );
    record(layout, by, inst, "plugin-update", &detail, base(&snap).as_deref());
    let mut out = match result {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    out.insert("snapshot".into(), json!(snap));
    Ok(Value::Object(out))
}

/// `updateAllWithSnapshot(inst, files, { onProgress })`: one snapshot for the whole batch, then
/// the updates in order; a failure is recorded and the rest carry on.
pub fn update_all_with_snapshot(
    layout: &Layout,
    by: &Actor,
    inst: &Instance,
    files: &[String],
    on_progress: &mut dyn FnMut(&str, usize, usize),
) -> Result<Value, Failure> {
    let game_version = mc_version_of(inst);
    let snap = snapshot_plugins(layout, by, inst, "pre-update")?;
    let mut updated: Vec<Value> = Vec::new();
    let mut failed = Vec::new();
    for (index, file) in files.iter().enumerate() {
        on_progress(file, index, files.len());
        match sources::update_plugin(inst, file, game_version.as_deref()) {
            Ok(Value::Object(m)) => {
                let mut row = Map::new();
                row.insert("file".into(), json!(file));
                row.extend(m);
                updated.push(Value::Object(row));
            }
            Ok(_) => updated.push(json!({ "file": file })),
            Err(e) => failed.push(json!({ "file": file, "error": e.message() })),
        }
    }
    if !updated.is_empty() {
        let names: Vec<String> = updated
            .iter()
            // `u.updated` of a row that came back without one joins as ''
            .map(|u| match u.get("updated") {
                None | Some(Value::Null) => String::new(),
                v => crate::js::string(v),
            })
            .collect();
        let mut detail = names.join(", ");
        if !failed.is_empty() {
            detail.push_str(&format!("; {} failed", failed.len()));
        }
        record(layout, by, inst, "plugin-update", &detail, base(&snap).as_deref());
    }
    Ok(json!({ "updated": updated, "failed": failed, "snapshot": snap }))
}
