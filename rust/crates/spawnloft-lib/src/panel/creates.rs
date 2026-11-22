//! Making a server: `POST /api/instances` (a create that downloads or builds, as a job that can
//! be cancelled) and `POST /api/instances/adopt`. Each is the same branch of `route()` in
//! `ui.mjs`, in the same words.

use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::create::{self, NewOptions};
use crate::failure::Failure;
use crate::settings::Layout;
use crate::sources::{self, JarProgress};
use crate::{cancel, java, js, mrpack, registry, util};

use super::Panel;
use super::http::{Reply, Request, field, opt_field};
use super::jobs::{Field, Jobs, is_job_id};
use super::routes::Routed;
use super::shared::{labelled, safe_instance};

fn done(reply: Reply) -> Result<Routed, Failure> {
    Ok(Routed::Reply(reply))
}

/// `body.key` where JavaScript asks whether it is truthy (the body is known not to be null).
fn truthy<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    opt_field(body, key).filter(|v| js::truthy(Some(v)))
}

/// `body.key ? String(body.key) : null`.
fn text(body: &Value, key: &str) -> Option<String> {
    truthy(body, key).map(|v| js::string(Some(v)))
}

/// The name a request gives, or the one made from its label (the page derives it too):
/// `if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))`.
fn name_of(layout: &Layout, body: &Value) -> Result<Option<String>, Failure> {
    // the first read of the body: a `null` body fails here as it does in Node
    if let Some(name) = field(body, "name")?.filter(|v| js::truthy(Some(v))) {
        return Ok(Some(js::string(Some(name))));
    }
    match text(body, "label") {
        Some(label) => {
            registry::free_name(Path::new(&layout.registry_file), &util::slug_for(&label)).map(Some)
        }
        None => Ok(None),
    }
}

/// `body.memory || '4G'`, as it was sent.
fn memory(body: &Value) -> Value {
    truthy(body, "memory").cloned().unwrap_or_else(|| json!("4G"))
}

/// `body.port ? Number(body.port) : null`.
fn port(body: &Value) -> Option<f64> {
    truthy(body, "port").map(|v| js::number(Some(v)))
}

/// `POST /api/instances/adopt`: a server folder that is already there, taken on under a name.
pub fn adopt(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let _ = panel;
    let body = req.json()?;
    // a label alone is enough; the name is derived from it
    let Some(name) = name_of(layout, &body)? else {
        return done(Reply::error(400, "name is required"));
    };
    let Some(dir) = text(&body, "dir") else {
        return done(Reply::error(400, "a server folder is required"));
    };
    let made = create::adopt_instance(
        layout,
        &Panel::actor(),
        &name,
        &dir,
        &text(&body, "jar").map_or(Value::Null, Value::String),
        &json!(text(&body, "memory").unwrap_or_else(|| "4G".into())),
        &Value::Null,
    )?;
    done(Reply::ok(safe_instance(&labelled(
        layout,
        &made.name,
        opt_field(&body, "label"),
    )?)?))
}

/// `POST /api/instances`: a new server, from a modpack, NeoForge's installer or a server jar
/// that is fetched or built first.
pub fn create(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let body = req.json()?;
    let Some(name) = name_of(layout, &body)? else {
        return done(Reply::error(400, "name is required"));
    };
    let job = text(&body, "jobId");
    let job = job.as_deref();
    let jobs = &panel.jobs;
    if job.is_some_and(|id| !is_job_id(id)) {
        return Err(Failure::user(
            "jobId must be 1 to 64 letters, digits, dashes or underscores",
        ));
    }
    // before its record is touched: the job by this id that is still running keeps its own
    if job.is_some_and(|id| jobs.running(id)) {
        return Err(Failure::user("that job is already running"));
    }
    jobs.update(
        job,
        vec![
            ("stage", json!("start").into()),
            ("percent", Value::Null.into()),
            ("message", json!("Starting").into()),
            ("done", json!(false).into()),
            ("cancelling", Field::Unset),
        ],
    );
    let ended = |stage: &str, percent: Option<f64>, message: &str| {
        jobs.update(
            job,
            vec![
                ("stage", json!(stage).into()),
                ("percent", percent.map_or(Value::Null, |p| json!(p)).into()),
                ("message", json!(message).into()),
                ("done", json!(true).into()),
                ("cancelling", Field::Unset),
            ],
        );
    };
    jobs.cancellable(job, || {
        match make(jobs, layout, &body, &name, job) {
            Ok(Made::Refused(reply)) => Ok(reply),
            Ok(Made::Created(created, reply)) => {
                ended("done", Some(100.0), &format!("Created {created}"));
                Ok(reply)
            }
            // stopped on purpose: said as that, on the stream and in the answer, and not as a failure
            Err(e) if cancel::is_cancelled(&e) => {
                ended("cancelled", None, "Cancelled");
                Ok(Reply::json(
                    409,
                    json!({ "error": "Cancelled. No server was created.", "code": "cancelled" }),
                ))
            }
            // also on the job stream, so a watching page shows where it failed; the percent stays
            Err(e) => {
                jobs.update(
                    job,
                    vec![
                        ("stage", json!("error").into()),
                        ("message", json!(e.message()).into()),
                        ("done", json!(true).into()),
                        ("cancelling", Field::Unset),
                    ],
                );
                Err(e)
            }
        }
    })
    .map(Routed::Reply)
}

/// How a create ended without failing: refused before anything was made (the job is left as it
/// is), or made, with the name the job's last word carries.
enum Made {
    Refused(Reply),
    Created(String, Reply),
}

fn make(
    jobs: &Arc<Jobs>,
    layout: &Layout,
    body: &Value,
    name: &str,
    job: Option<&str>,
) -> Result<Made, Failure> {
    let by = Panel::actor();
    let label = opt_field(body, "label");
    let online_mode = opt_field(body, "onlineMode") != Some(&Value::Bool(false));
    let force = opt_field(body, "force") == Some(&Value::Bool(true));
    let shown = |name: &str| safe_instance(&labelled(layout, name, label)?);

    // a modpack decides the loader, Minecraft version, mods and config itself
    if let Some(pack) = text(body, "modpack") {
        let o = mrpack::PackOptions {
            memory: memory(body),
            port: port(body),
            online_mode,
        };
        let result = mrpack::create_from_modpack(layout, &by, name, &pack, o, &mut |m| {
            jobs.stage(job, "pack", mrpack::percent_of(m), m);
        })?;
        let mut answer = shown(name)?;
        answer["pack"] = result.to_json();
        return Ok(Made::Created(result.name.clone(), Reply::ok(answer)));
    }
    // NeoForge is installer-laid and launched from a starter jar
    if opt_field(body, "loader").and_then(Value::as_str) == Some("neoforge") {
        let Some(mc) = text(body, "neoforgeVersion") else {
            return Ok(Made::Refused(Reply::error(
                400,
                "a Minecraft version is required for a NeoForge server",
            )));
        };
        let o = sources::NeoOptions {
            java: java::pick_java(
                text(body, "java").as_deref(),
                java::required_major(Some(&mc)),
                force,
                &format!("Minecraft {mc}"),
            )?,
            memory: memory(body),
            port: port(body),
            online_mode,
        };
        sources::neo_create_server(layout, &by, name, &mc, o, &mut |m| {
            jobs.stage(job, "neoforge", None, m);
        })?;
        return Ok(Made::Created(name.to_string(), Reply::ok(shown(name)?)));
    }
    // every jar-based loader: resolve the version, fetch or build the jar, place it. The
    // per-loader version field names are still read for pages loaded before `version` existed.
    let loader = opt_field(body, "loader")
        .and_then(Value::as_str)
        .filter(|l| sources::is_jar_source(l))
        .unwrap_or("paper");
    let given = |key: &str| opt_field(body, key).filter(|v| !v.is_null());
    let version = given("version")
        .or_else(|| given(&format!("{loader}Version")))
        .or_else(|| given("paperVersion"))
        .filter(|v| js::truthy(Some(v)))
        .map(|v| js::string(Some(v)));
    // pick Java before downloading so an unrunnable version is refused now, not at first start
    let chosen = java::pick_java(
        text(body, "java").as_deref(),
        version.as_deref().and_then(|v| java::required_major(Some(v))),
        force,
        &version
            .as_deref()
            .map_or("this version".to_string(), |v| format!("Minecraft {v}")),
    )?;
    let mut jar = truthy(body, "jar").cloned().unwrap_or(Value::Null);
    if let Some(version) = version.as_deref() {
        let label = sources::label_for(loader);
        jobs.stage(job, "resolve", None, &format!("Finding {label} {version}"));
        let (heard, id) = (jobs.clone(), job.map(str::to_string));
        let report = Rc::new(move |p: JarProgress| {
            let id = id.as_deref();
            match p {
                JarProgress::Cached(m) => heard.stage(
                    id,
                    "cached",
                    Some(100.0),
                    m.as_deref().unwrap_or("Server jar already downloaded"),
                ),
                JarProgress::Message(m) if m.is_empty() => {
                    heard.stage(id, "download", None, "Downloading the server jar");
                }
                JarProgress::Message(m) => heard.stage(id, "build", None, &m),
                JarProgress::Bytes { received, total } => heard.stage(
                    id,
                    "download",
                    // `Math.min(100, Math.round((received / total) * 100))`, nothing without a total
                    (total > 0).then(|| {
                        ((received as f64 / total as f64) * 100.0 + 0.5)
                            .floor()
                            .min(100.0)
                    }),
                    "Downloading the server jar",
                ),
            }
        });
        // BuildTools compiles with a JDK; it is given the Java the server will use
        let fetched = sources::fetch_jar_reporting(&layout.jars_dir, loader, version, None, &chosen, report)?;
        jar = json!(fetched.name);
    } else if loader != "paper" {
        return Ok(Made::Refused(Reply::error(
            400,
            format!(
                "a Minecraft version is required for a {} server",
                sources::label_for(loader)
            ),
        )));
    }
    // the jar is in the shared store by now and stays there; nothing of the server exists yet
    cancel::check_cancelled()?;
    jobs.stage(job, "create", None, "Setting up the server folder");
    let made = create::new_instance(
        layout,
        &by,
        name,
        NewOptions {
            jar,
            java: json!(chosen),
            loader: loader.to_string(),
            mc_version: version,
            memory: Some(memory(body)),
            port: port(body),
            motd: truthy(body, "motd").cloned().unwrap_or(Value::Null),
            online_mode,
            // the person clicking Create is the local operator; no second EULA prompt
            accept_eula: true,
            ..NewOptions::default()
        },
    )?;
    let reply = Reply::ok(shown(&made.name)?);
    Ok(Made::Created(made.name, reply))
}
