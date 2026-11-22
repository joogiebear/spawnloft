//! `handlePlugins`, `handlePack` and `handleUpgrade` of `ui.mjs`, and the modpack search: a
//! server's plugins or mods, its modpack and its software upgrade.
//!
//! These download files and write them into a server's folder. Every name and path from the
//! request goes through the library's own checks (`safePluginPath`, the project id pattern, the
//! hosts a pack may use), as in Node; nothing here builds a path or a URL from the request.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::failure::Failure;
use crate::plugin_actions::{self, Also};
use crate::settings::Layout;
use crate::upgrade::{self, Applied};
use crate::{js, jsjson, mrpack, plugin_sources, plugins, registry, supervisor};

use super::Panel;
use super::http::{Reply, Request, field};
use super::jobs::Field;
use super::routes::Routed;

/// `/api/instances/<name>/plugins...`, `.../pack...` and `.../upgrade...`; `req.seg(3)` says which.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let reply = match req.seg(3) {
        Some("plugins") => handle_plugins(panel, layout, req, name)?,
        Some("upgrade") => handle_upgrade(layout, req, name)?,
        _ => handle_pack(panel, layout, req, name)?,
    };
    Ok(Routed::Reply(reply))
}

/// `GET /api/modpacks/search`.
pub fn modpack_search(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = (panel, layout);
    let q = js::trim(req.q("q").unwrap_or("")).to_string();
    let results = if q.is_empty() {
        Vec::new()
    } else {
        plugin_sources::search_modpacks(&q, 20)?
    };
    Ok(Routed::Reply(Reply::ok(json!({ "results": results }))))
}

/// An object as `JSON.stringify` writes it: a key whose value is undefined is left out.
fn object(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v)))
            .collect(),
    )
}

/// `v.key`, undefined on anything that is not an object.
fn prop(v: &Value, key: &str) -> Option<Value> {
    match v {
        Value::Object(m) => m.get(key).cloned(),
        _ => None,
    }
}

/// `body.key ? String(body.key) : null`.
fn text_if_truthy(body: &Value, key: &str) -> Result<Option<String>, Failure> {
    Ok(field(body, key)?
        .filter(|v| js::truthy(Some(v)))
        .map(|v| js::string(Some(v))))
}

/// `{ ...out, running }`: `out`'s keys first, then `running` (in its place if `out` had one).
fn with_running(out: Value, running: bool) -> Value {
    let mut m = match out {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("running".into(), json!(running));
    Value::Object(m)
}

// The installed list needs no network; search, install and update checks do.
fn handle_plugins(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let verb = req.seg(4).map(str::to_string);
    let game_version = plugins::mc_version_of(&inst);
    let gv = game_version.as_deref();
    // plugins on Paper-family servers, mods on Fabric; Hangar only hosts plugins
    let kind = plugins::content_kind_for(&inst);
    let get = req.method == "GET";

    if get && verb.is_none() {
        let pack = mrpack::pack_of(&inst);
        let rows = plugins::list_plugins(&inst)?;
        return Ok(Reply::ok(json!({
            "plugins": rows,
            "running": supervisor::is_running(layout, name)?,
            "gameVersion": game_version,
            "kind": kind.kind,
            "word": kind.word,
            "hangar": kind.hangar,
            "software": kind.label,
            "pack": pack.map(|p| object(vec![
                ("name", prop(&p, "name")),
                ("version", prop(&p, "versionNumber")),
                ("project", prop(&p, "project")),
            ])),
        })));
    }
    if get && verb.as_deref() == Some("search") {
        let q = js::trim(req.q("q").unwrap_or("")).to_string();
        if q.is_empty() {
            return Ok(Reply::ok(json!({ "results": [], "errors": [] })));
        }
        return Ok(Reply::ok(plugin_actions::search_everywhere(&inst, &q)));
    }
    // what an install would fetch and need; asks the source, writes nothing
    if get && verb.as_deref() == Some("plan") {
        let project_id = req.q("projectId").unwrap_or("").to_string();
        if project_id.is_empty() {
            return Ok(Reply::error(400, "projectId is required"));
        }
        let source = req.q("source").filter(|s| !s.is_empty()).unwrap_or("modrinth");
        if source != "modrinth" && source != "hangar" {
            return Ok(Reply::error(400, "unknown source"));
        }
        return Ok(Reply::ok(plugin_actions::plan_install(
            &inst,
            &project_id,
            source,
        )?));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let by = Panel::actor();

    match verb.as_deref() {
        Some("toggle") => {
            let file = js::string(field(&body, "file")?);
            let on = field(&body, "enabled")? == Some(&Value::Bool(true));
            let out = plugins::set_plugin_enabled(&layout.data_root, &by, &inst, &file, on)?;
            Ok(Reply::ok(json!({ "file": out.file, "enabled": out.enabled })))
        }
        Some("delete") => {
            let file = js::string(field(&body, "file")?);
            plugins::remove_plugin(&layout.data_root, &by, &inst, &file)?;
            Ok(Reply::ok(json!({ "removed": file })))
        }
        Some("install") => {
            let Some(project) = field(&body, "projectId")?.filter(|v| js::truthy(Some(v))) else {
                return Ok(Reply::error(400, "projectId is required"));
            };
            // what it needs, to be fetched with it: at most a handful, each a project id and
            // where from
            let also: Vec<Also> = match field(&body, "also")? {
                Some(Value::Array(list)) => list
                    .iter()
                    .take(20)
                    .filter_map(|d| {
                        let id = prop(d, "projectId").filter(|v| js::truthy(Some(v)))?;
                        let hangar = prop(d, "source").as_ref().and_then(Value::as_str) == Some("hangar");
                        Some(Also {
                            project_id: js::string(Some(&id)),
                            source: if hangar { "hangar" } else { "modrinth" }.into(),
                        })
                    })
                    .collect(),
                _ => Vec::new(),
            };
            // `from === 'hangar'`: anything else, a missing source included, is Modrinth
            let hangar = field(&body, "source")?.and_then(Value::as_str) == Some("hangar");
            let out = plugin_actions::install_with_snapshot(
                layout,
                &by,
                &inst,
                &js::string(Some(project)),
                if hangar { "hangar" } else { "modrinth" },
                &also,
            )?;
            Ok(Reply::ok(out))
        }
        Some("updates") => Ok(Reply::ok(plugin_sources::check_updates_report(&inst, gv)?)),
        Some("update") => {
            let file = js::string(field(&body, "file")?);
            Ok(Reply::ok(plugin_actions::update_with_snapshot(
                layout, &by, &inst, &file,
            )?))
        }
        // one snapshot for all updates; the page asks for the restart separately
        Some("update-all") => update_all(panel, layout, &body, &inst),
        _ => Ok(Reply::not_found()),
    }
}

fn update_all(
    panel: &Panel,
    layout: &Layout,
    body: &Value,
    inst: &registry::Instance,
) -> Result<Reply, Failure> {
    let files: Vec<String> = match field(body, "files")? {
        Some(Value::Array(list)) => list
            .iter()
            .map(|v| js::string(Some(v)))
            .filter(|f| !f.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    if files.is_empty() {
        return Ok(Reply::error(400, "files is required"));
    }
    let job_id = text_if_truthy(body, "jobId")?;
    let jobs = &panel.jobs;
    let job = job_id.as_deref();
    let out = plugin_actions::update_all_with_snapshot(
        layout,
        &Panel::actor(),
        inst,
        &files,
        &mut |file, index, total| {
            jobs.update(
                job,
                vec![
                    ("stage", json!("update").into()),
                    (
                        "percent",
                        jsjson::num((index as f64 / total as f64 * 100.0).round()).into(),
                    ),
                    (
                        "message",
                        json!(format!("Updating {file} ({} of {total})", index + 1)).into(),
                    ),
                ],
            )
        },
    )?;
    let updated = out.get("updated").and_then(Value::as_array).map_or(0, Vec::len);
    jobs.update(
        job,
        vec![
            ("stage", json!("done").into()),
            ("percent", json!(100).into()),
            (
                "message",
                json!(format!("Updated {updated} of {}", files.len())).into(),
            ),
            ("done", json!(true).into()),
        ],
    );
    Ok(Reply::ok(out))
}

// GET queries the upstream project (on demand only). POST with no version is a build update;
// with a version it crosses Minecraft versions, which the page has already had confirmed.
// applyUpgrade snapshots first.
fn handle_upgrade(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    if req.method == "GET" {
        let check = upgrade::check_upgrade(&inst)?;
        let current = check.current.as_ref();
        let latest_build = check.latest_build.as_ref();
        return Ok(Reply::ok(json!({
            "software": current.map(|c| c.software),
            "label": current.map(|c| c.label),
            "current": current.map(|c| json!({ "version": c.version, "build": c.build })),
            "latestBuild": latest_build.map(|l| json!({ "build": l.build, "channel": l.channel, "time": l.time })),
            "buildUpdate": latest_build.is_some_and(|l| l.newer),
            "newerVersions": check.newer_versions,
            "latestVersion": check.latest_version,
        })));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let version = text_if_truthy(&body, "version")?;
    let running = supervisor::is_running(layout, name)?;
    let up = upgrade::apply_upgrade_detail(
        layout,
        &Panel::actor(),
        name,
        version.as_deref(),
        &Value::Null,
        running,
    )?;
    let out = match up.applied {
        Applied::AlreadyCurrent { jar } => json!({ "alreadyCurrent": true, "jar": jar }),
        Applied::Done {
            from,
            to,
            channel,
            snapshot,
            old_jars,
        } => object(vec![
            // `inst.jar`, which a record without one leaves out
            ("from", inst.get("jar").map(|_| from)),
            ("to", Some(json!(to))),
            ("label", Some(json!(up.label))),
            ("version", Some(json!(up.version))),
            ("build", Some(up.build)),
            ("channel", Some(channel)),
            ("crossVersion", Some(json!(up.cross_version))),
            ("snapshot", Some(json!(snapshot))),
            ("oldJars", Some(json!(old_jars))),
        ]),
    };
    Ok(Reply::ok(with_running(
        out,
        supervisor::is_running(layout, name)?,
    )))
}

// Modpack version check and update. The core refuses a running server; progress goes through
// the same job stream as creation.
fn handle_pack(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    if req.method == "GET" {
        let out = mrpack::check_pack_update_report(&inst)?;
        return Ok(Reply::ok(with_running(
            out,
            supervisor::is_running(layout, name)?,
        )));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let job_id = text_if_truthy(&body, "jobId")?;
    let job = job_id.as_deref();
    let jobs = &panel.jobs;
    let result = mrpack::update_pack_report(layout, &Panel::actor(), name, &mut |message, percent| {
        jobs.update(
            job,
            vec![
                ("stage", json!("pack").into()),
                ("message", json!(message).into()),
                ("percent", percent.map_or(Value::Null, jsjson::num).into()),
            ],
        )
    });
    match result {
        Ok(out) => {
            jobs.update(
                job,
                vec![
                    ("stage", json!("done").into()),
                    ("percent", json!(100).into()),
                    ("message", json!("Pack updated").into()),
                    ("done", json!(true).into()),
                ],
            );
            Ok(Reply::ok(out))
        }
        Err(err) => {
            let patch: Vec<(&str, Field)> = vec![
                ("stage", json!("error").into()),
                ("message", json!(err.message()).into()),
                ("done", json!(true).into()),
            ];
            jobs.update(job, patch);
            Err(err)
        }
    }
}
