//! The database routes of `ui.mjs` (`/api/databases...`, `handleDatabaseBackups`) and a server's
//! `databases/create` (rust/PLAN-CORE-PORT.md C8). Each is the same branch of `route()`, in the
//! same order, so a path that fits two goes to the first, as it did.
//!
//! The list never holds a root or an attachment password (`safeDatabase`): those go out only
//! from `root` and `credentials`, which are asked for one database at a time, and from `attach`
//! and a server's `create`, which answer the credentials they made, as the Node panel does.

use serde_json::{Map, Value, json};

use crate::engines::Progress;
use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{js, platform, services};

use super::Panel;
use super::http::{Reply, Request, field};
use super::jobs::Jobs;
use super::routes::Routed;
use super::shared::{safe_database, status_row};

fn reply(r: Reply) -> Result<Routed, Failure> {
    Ok(Routed::Reply(r))
}

/// `x ? String(x) : fallback`.
fn text_or(v: Option<&Value>, fallback: &str) -> String {
    if js::truthy(v) {
        js::string(v)
    } else {
        fallback.to_string()
    }
}

/// `x ? String(x) : null`.
fn text_if(v: Option<&Value>) -> Option<String> {
    js::truthy(v).then(|| js::string(v))
}

/// `x ?? null`, then `cleanLabel` reads it as `String(x)`.
fn label_of(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        v => Some(js::string(v)),
    }
}

/// `if (!body.name && body.label) body.name = registry.freeName(slugFor(String(body.label)))`,
/// then `String(body.name)`; `None` when there is no name.
fn name_of(layout: &Layout, body: &Value) -> Result<Option<String>, Failure> {
    let name = field(body, "name")?;
    if js::truthy(name) {
        return Ok(Some(js::string(name)));
    }
    // a body that is not an object has no label to read
    let label = field(body, "label")?;
    if !js::truthy(label) {
        return Ok(None);
    }
    let slug = crate::util::slug_for(&js::string(label));
    Ok(Some(registry::free_name(
        std::path::Path::new(&layout.registry_file),
        &slug,
    )?))
}

/// `services.canManage(body.engine || services.defaultEngine())`: a value that is not text is
/// no engine.
fn can_manage(engine: Option<&Value>) -> bool {
    match engine {
        v if !js::truthy(v) => services::can_manage(services::DEFAULT_ENGINE),
        Some(Value::String(s)) => services::can_manage(s),
        _ => false,
    }
}

/// `services.assertNewEngine(body.engine ? String(body.engine) : services.defaultEngine())`.
fn new_engine(engine: Option<&Value>) -> Result<services::Engine, Failure> {
    services::assert_new_engine(&text_or(engine, services::DEFAULT_ENGINE))
}

fn managed_databases() -> bool {
    js::truthy(platform::capabilities().get("managedDatabases"))
}

/// The share of a download done, as a whole percent (`Math.min(100, Math.round(...))`); NaN,
/// which JSON writes as null, when the bytes so far were not given.
fn percent_of(p: &Progress) -> Value {
    match p.received {
        Some(received) => json!((received as f64 / p.total as f64 * 100.0).round().min(100.0)),
        None => Value::Null,
    }
}

/// The `onProgress` of a database's create: each step on the job.
fn create_progress<'a>(jobs: &'a Jobs, id: Option<&'a str>) -> impl FnMut(&Progress) + 'a {
    move |p: &Progress| {
        if p.cached {
            return jobs.stage(id, "cached", Some(100.0), &p.message);
        }
        let (stage, percent) = if p.total > 0 {
            ("download", percent_of(p))
        } else {
            ("setup", Value::Null)
        };
        jobs.update(
            id,
            vec![
                ("stage", json!(stage).into()),
                ("percent", percent.into()),
                ("message", json!(p.message).into()),
            ],
        );
    }
}

/// The `onProgress` of a server's own database: as [`create_progress`], and its last step says
/// the job is done.
fn server_progress<'a>(jobs: &'a Jobs, id: Option<&'a str>) -> impl FnMut(&Progress) + 'a {
    move |p: &Progress| {
        if p.cached {
            return jobs.stage(id, "cached", Some(100.0), &p.message);
        }
        let (stage, percent) = if p.done {
            ("done", if p.total > 0 { percent_of(p) } else { json!(100) })
        } else if p.total > 0 {
            ("download", percent_of(p))
        } else {
            ("setup", Value::Null)
        };
        jobs.update(
            id,
            vec![
                ("stage", json!(stage).into()),
                ("percent", percent.into()),
                ("message", json!(p.message).into()),
                ("done", json!(p.done).into()),
            ],
        );
    }
}

/// `jobUpdate(jobId, { stage: 'error', message, done: true })`, then the throw goes on.
fn failed<T>(jobs: &Jobs, id: Option<&str>, out: Result<T, Failure>) -> Result<T, Failure> {
    if let Err(f) = &out {
        jobs.update(
            id,
            vec![
                ("stage", json!("error").into()),
                ("message", json!(f.message()).into()),
                ("done", json!(true).into()),
            ],
        );
    }
    out
}

/// `/api/databases...`, every method and length: the whole family, down to its `no such database`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Routed, Failure> {
    let n = req.seg.len();
    let get = req.method == "GET";
    let post = req.method == "POST";
    let s2 = req.seg(2).unwrap_or("").to_string();

    if n == 2 && get {
        return reply(list(layout)?);
    }
    if s2 == "external" && post {
        return reply(external(layout, req)?);
    }
    if s2 == "engines" && get {
        return reply(engines());
    }
    if s2 == "versions" && get {
        let engine = services::assert_new_engine(
            req.q("engine")
                .filter(|e| !e.is_empty())
                .unwrap_or(services::DEFAULT_ENGINE),
        )?;
        let rows: Vec<Value> = services::versions_for(engine)?
            .iter()
            .map(services::Release::to_json)
            .collect();
        return reply(Reply::ok(Value::Array(rows)));
    }
    if n == 2 && post {
        return reply(create(panel, layout, req)?);
    }
    if !s2.is_empty() && services::has_instance(layout, &s2)? {
        return reply(one(layout, req, &s2)?);
    }
    reply(Reply::error(404, "no such database"))
}

/// `GET /api/databases`. An external database has no daemon to ask, so it is probed directly.
fn list(layout: &Layout) -> Result<Reply, Failure> {
    let mut rows = Vec::new();
    for i in registry::list_services(std::path::Path::new(&layout.registry_file))? {
        let mut row = match status_row(layout, &i.name) {
            Ok(row) => row,
            Err(_) => {
                let mut row = i.clone();
                row.fields.insert("status".into(), json!("unknown"));
                row
            }
        };
        if js::truthy(i.get("external")) {
            row.fields
                .insert("status".into(), json!(services::external_status(layout, &i)));
        }
        rows.push(safe_database(&row));
    }
    Ok(Reply::ok(Value::Array(rows)))
}

/// `POST /api/databases/external`: a database that runs elsewhere, recorded once it answers.
fn external(layout: &Layout, req: &mut Request) -> Result<Reply, Failure> {
    let body = req.json()?;
    let Some(name) = name_of(layout, &body)? else {
        return Ok(Reply::error(400, "name is required"));
    };
    let get = |k: &str| field(&body, k);
    // the arguments are read before the call, the engine checked first
    let engine = new_engine(get("engine")?)?;
    let host = text_or(get("host")?, "127.0.0.1");
    let port = js::truthy(get("port")?).then(|| js::number(get("port").ok().flatten()));
    let user = text_or(get("user")?, "root");
    let password = match get("password")? {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    };
    let tools = text_if(get("tools")?);
    let label = label_of(get("label")?);
    let db = services::register_external(
        layout,
        &name,
        engine,
        services::External {
            host: &host,
            port,
            user: &user,
            password: &password,
            tools: tools.as_deref(),
            label: label.as_deref(),
        },
    )?;
    let mut row = db;
    row.fields.insert("status".into(), json!("reachable"));
    Ok(Reply::ok(safe_database(&row)))
}

/// `GET /api/databases/engines`: the engines a new database can run.
fn engines() -> Reply {
    let rows: Vec<Value> = ["garnet", "mysql"]
        .into_iter()
        .filter_map(|id| services::Engine::named(id).map(|e| (id, e)))
        .map(|(id, e)| {
            json!({
                "id": id,
                "label": e.label(),
                "defaultPort": e.default_port(),
                "managed": services::can_manage(id),
                "default": id == services::DEFAULT_ENGINE,
            })
        })
        .collect();
    Reply::ok(Value::Array(rows))
}

/// `POST /api/databases`: a managed database, made as a job the page watches.
fn create(panel: &Panel, layout: &Layout, req: &mut Request) -> Result<Reply, Failure> {
    if !managed_databases() {
        return Ok(Reply::error(400, platform::preview_limits::MANAGED_DATABASES));
    }
    let body = req.json()?;
    let Some(name) = name_of(layout, &body)? else {
        return Ok(Reply::error(400, "name is required"));
    };
    let get = |k: &str| field(&body, k);
    let version = get("version")?;
    if !js::truthy(version) {
        return Ok(Reply::error(400, "a version is required"));
    }
    let version = js::string(version);
    let job = text_if(get("jobId")?);
    let id = job.as_deref();
    if !can_manage(get("engine")?) {
        return Ok(Reply::error(
            400,
            "Managed installation of this engine is not available on this platform.",
        ));
    }
    let jobs = &panel.jobs;
    let out = (|| {
        let engine = new_engine(get("engine")?)?;
        let port = js::truthy(get("port")?).then(|| js::number(get("port").ok().flatten()));
        let label = label_of(get("label")?);
        let mut progress = create_progress(jobs, id);
        let db = services::create_database(
            layout,
            &name,
            engine,
            &version,
            port,
            label.as_deref(),
            &mut progress,
        )?;
        jobs.update(
            id,
            vec![
                ("stage", json!("done").into()),
                ("percent", json!(100).into()),
                ("message", json!(format!("Created {}", db.name)).into()),
                ("done", json!(true).into()),
            ],
        );
        Ok(safe_database(&status_row(layout, &db.name)?))
    })();
    Ok(Reply::ok(failed(jobs, id, out)?))
}

/// `/api/databases/<name>...`: one database, which the registry holds beside the servers.
fn one(layout: &Layout, req: &mut Request, db: &str) -> Result<Reply, Failure> {
    let registry_file = std::path::Path::new(&layout.registry_file);
    if !registry::lookup(registry_file, db)?.is_database() {
        return Ok(Reply::error(404, "no such database"));
    }
    let s3 = req.seg(3).unwrap_or("").to_string();
    let get = req.method == "GET";
    if s3 == "credentials" && get {
        let server = req.q("server").unwrap_or("").to_string();
        if server.is_empty() {
            return Ok(Reply::error(400, "server is required"));
        }
        return Ok(Reply::ok(object(services::credentials(layout, db, &server)?)));
    }
    // root credentials are only sent on request, never in the list
    if s3 == "root" && get {
        let inst = services::get_database(layout, db)?;
        return Ok(Reply::ok(root_of(&inst)));
    }
    if s3 == "backups" {
        return backups(layout, req, db);
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let get = |k: &str| field(&body, k);
    match s3.as_str() {
        "attach" | "detach" => {
            let server = get("server")?;
            if !js::truthy(server) {
                return Ok(Reply::error(400, "server is required"));
            }
            let server = js::string(server);
            if s3 == "attach" {
                return Ok(Reply::ok(object(services::attach(layout, db, &server)?)));
            }
            let drop = get("drop")? == Some(&Value::Bool(true));
            // `record.database` as it was: a record without one has no key in the answer
            let database = attachment_database(&services::get_database(layout, db)?, &server);
            let out = services::detach(layout, db, &server, drop)?;
            let mut m = Map::new();
            m.insert("service".into(), json!(db));
            m.insert("server".into(), json!(server));
            m.insert("dropped".into(), json!(out.dropped));
            if database.is_some() {
                m.insert("database".into(), out.database);
            }
            Ok(Reply::ok(Value::Object(m)))
        }
        "delete" => {
            let purge = get("purge")? == Some(&Value::Bool(true));
            let out = services::remove_database(layout, db, purge)?;
            Ok(Reply::ok(json!({
                "name": db,
                "purged": out.purged,
                "detached": out.detached,
            })))
        }
        "address" => {
            let text = |v: Option<&Value>| match v {
                None | Some(Value::Null) => None,
                v => Some(js::string(v)),
            };
            let host = text(get("host")?);
            let port = match get("port")? {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                v => Some(js::number(v)),
            };
            let to = services::Address {
                host,
                port,
                user: text(get("user")?),
                // left out, or blank, keeps the password it has: the form never holds the old one
                password: text_if(get("password")?),
            };
            let (mut next, reachable) = services::update_external(layout, db, to)?;
            next.fields.insert(
                "status".into(),
                json!(if reachable { "reachable" } else { "unreachable" }),
            );
            Ok(Reply::ok(safe_database(&next)))
        }
        _ => Ok(Reply::not_found()),
    }
}

/// Pairs in order, as an object.
fn object(pairs: Vec<(String, Value)>) -> Value {
    Value::Object(pairs.into_iter().collect())
}

/// `db.attachments?.[server]?.database`, `None` where it is `undefined`.
fn attachment_database(db: &Instance, server: &str) -> Option<Value> {
    let all = db.get("attachments").filter(|a| !a.is_null())?;
    let (_, record) = registry::entries_of(all).into_iter().find(|(k, _)| k == server)?;
    record.as_object()?.get("database").cloned()
}

/// `{ host: inst.host ?? '127.0.0.1', port: inst.port, user: inst.root?.user ?? 'root',
/// password: inst.root?.password ?? '' }`.
fn root_of(inst: &Instance) -> Value {
    let or = |v: Option<&Value>, fallback: &str| match v {
        None | Some(Value::Null) => json!(fallback),
        Some(v) => v.clone(),
    };
    let root = |k: &str| inst.get("root").and_then(Value::as_object).and_then(|r| r.get(k));
    let mut m = Map::new();
    m.insert("host".into(), or(inst.get("host"), "127.0.0.1"));
    if let Some(port) = inst.get("port") {
        m.insert("port".into(), port.clone());
    }
    m.insert("user".into(), or(root("user"), "root"));
    m.insert("password".into(), or(root("password"), ""));
    Value::Object(m)
}

/// `handleDatabaseBackups`: a database's own backups (plain SQL dumps). Every answer but a
/// download is the current list, with what was done.
fn backups(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let verb = req.seg(4).map(str::to_string);
    let answer = |extra: Vec<(&str, Value)>| -> Result<Reply, Failure> {
        let mut m = services::database_backup_status(layout, name)?;
        m.insert(
            "backups".into(),
            Value::Array(services::list_database_backups(layout, name)?),
        );
        for (k, v) in extra {
            m.insert(k.into(), v);
        }
        Ok(Reply::ok(Value::Object(m)))
    };
    let get = req.method == "GET";
    if get && verb.as_deref() == Some("download") {
        let file = services::database_backup_file(layout, name, req.q("file").unwrap_or(""))?;
        let len = std::fs::metadata(&file)
            .map_err(|e| Failure::io(&e, "stat", Some(&file)))?
            .len();
        let base = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        return Ok(Reply::File {
            headers: vec![
                ("Content-Type".into(), "application/sql; charset=utf-8".into()),
                (
                    "Content-Disposition".into(),
                    format!("attachment; filename=\"{base}\""),
                ),
                ("Cache-Control".into(), "no-store".into()),
            ],
            file,
            len,
            done: None,
        });
    }
    if get && verb.is_none() {
        return answer(vec![]);
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let by = Panel::actor();
    match verb.as_deref() {
        None => {
            let label = match field(&body, "label")? {
                None | Some(Value::Null) => "manual".to_string(),
                v => js::string(v),
            };
            let taken = services::backup_database(layout, &by, name, &label, false, false)?;
            answer(vec![("taken", taken.to_json())])
        }
        Some("restore") => {
            let file = file_of(&body)?;
            let (restored, safety) = services::restore_database_backup(layout, &by, name, &file)?;
            answer(vec![("restored", json!(restored)), ("safety", json!(safety))])
        }
        Some("delete") => {
            let file = file_of(&body)?;
            let deleted = services::delete_database_backup(layout, &by, name, &file)?;
            answer(vec![("deleted", json!(deleted))])
        }
        Some(_) => Ok(Reply::not_found()),
    }
}

/// `String(body.file ?? '')`.
fn file_of(body: &Value) -> Result<String, Failure> {
    Ok(match field(body, "file")? {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    })
}

/// `POST /api/instances/<name>/databases/create`: make, start and attach a database for a
/// server, on the port after its game port; progress goes out on the job stream (`panel.jobs`).
pub fn create_for_server(
    panel: &Panel,
    layout: &Layout,
    req: &mut Request,
    name: &str,
) -> Result<Routed, Failure> {
    if !managed_databases() {
        return reply(Reply::error(400, platform::preview_limits::MANAGED_DATABASES));
    }
    let body = req.json()?;
    let get = |k: &str| field(&body, k);
    let job = text_if(get("jobId")?);
    let id = job.as_deref();
    if !can_manage(get("engine")?) {
        return reply(Reply::error(
            400,
            "Managed installation of this engine is not available on this platform.",
        ));
    }
    let jobs = &panel.jobs;
    let out = (|| {
        let engine = new_engine(get("engine")?)?;
        let version = text_if(get("version")?);
        let mut progress = server_progress(jobs, id);
        let (db, credentials) = services::create_for_server(
            layout,
            &Panel::actor(),
            name,
            engine,
            version.as_deref(),
            &mut progress,
        )?;
        Ok(json!({
            "database": safe_database(&status_row(layout, &db.name)?),
            "credentials": object(credentials),
        }))
    })();
    reply(Reply::ok(failed(jobs, id, out)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_suggests_a_name_as_slugfor_does() {
        for (label, want) in [
            ("My Server", "My-Server"),
            ("  --a__b--  ", "a__b"),
            ("a  !!  b", "a-b"),
            ("a - b", "a-b"),
            ("\u{1F600}\u{1F600}", "server"),
            ("___", "server"),
            ("é-x", "x"),
            (&"ab-".repeat(20), "ab-ab-ab-ab-ab-ab-ab-ab-ab-ab-ab"),
            ("x_-_y", "x_-_y"),
        ] {
            assert_eq!(crate::util::slug_for(label), want, "{label}");
        }
    }

    #[test]
    fn a_download_is_a_whole_percent_and_never_more_than_all() {
        let p = |received, total| Progress {
            received,
            total,
            ..Progress::say("x")
        };
        assert_eq!(percent_of(&p(Some(1), 3)), json!(33.0));
        assert_eq!(percent_of(&p(Some(1), 2)), json!(50.0));
        assert_eq!(percent_of(&p(Some(9), 2)), json!(100.0));
        assert_eq!(percent_of(&p(None, 2)), Value::Null);
    }

    #[test]
    fn the_root_answer_has_the_keys_the_record_gives() {
        let inst = registry::spread("d", &json!({ "kind": "database", "port": 1, "root": "x" }));
        assert_eq!(
            crate::jsjson::stringify(&root_of(&inst)),
            r#"{"host":"127.0.0.1","port":1,"user":"root","password":""}"#
        );
        let inst = registry::spread(
            "d",
            &json!({ "kind": "database", "host": "h", "root": { "user": "u", "password": "p" } }),
        );
        assert_eq!(
            crate::jsjson::stringify(&root_of(&inst)),
            r#"{"host":"h","user":"u","password":"p"}"#
        );
    }
}
