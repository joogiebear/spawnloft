//! `services.mjs` (C2): databases are registered like servers, run by the same daemon, and
//! attached to servers with their own credentials. An external database is registered by
//! address and root credentials and is never started or stopped from here. The database
//! backups, dumps of attachments and their import are C3's (backups), on top of this.

use serde_json::{Map, Value, json};
use std::path::Path;

use crate::activity::Actor;
use crate::control::Status;
use crate::engines::{OnProgress, Progress};
use crate::failure::Failure;
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{garnet, js, mariadb, mysql, supervisor, util};

/// One release `versions()` offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub status: String,
    pub support: Option<String>,
    pub date: Option<String>,
}

/// An engine module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Mariadb,
    Garnet,
    Mysql,
}

impl Engine {
    /// `ENGINES[name]`.
    pub fn named(name: &str) -> Option<Engine> {
        match name {
            mariadb::ENGINE => Some(Engine::Mariadb),
            garnet::ENGINE => Some(Engine::Garnet),
            mysql::ENGINE => Some(Engine::Mysql),
            _ => None,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Engine::Mariadb => mariadb::LABEL,
            Engine::Garnet => garnet::LABEL,
            Engine::Mysql => mysql::LABEL,
        }
    }
    pub fn kind(self) -> &'static str {
        match self {
            Engine::Mariadb => mariadb::KIND,
            Engine::Garnet => garnet::KIND,
            Engine::Mysql => mysql::KIND,
        }
    }
    pub fn default_port(self) -> u16 {
        match self {
            Engine::Mariadb => mariadb::DEFAULT_PORT,
            Engine::Garnet => garnet::DEFAULT_PORT,
            Engine::Mysql => mysql::DEFAULT_PORT,
        }
    }
    pub fn can_dump(self) -> bool {
        !matches!(self, Engine::Garnet)
    }
    fn versions(self) -> Result<Vec<Release>, Failure> {
        match self {
            Engine::Garnet => garnet::versions(),
            Engine::Mysql => mysql::versions(),
            // only through assertNewEngine, which MariaDB never passes
            Engine::Mariadb => Err(unreachable_mariadb()),
        }
    }
    fn fetch_engine(self, layout: &Layout, version: &str, progress: OnProgress) -> Result<(), Failure> {
        match self {
            Engine::Garnet => garnet::fetch_engine(layout, version, progress),
            Engine::Mysql => mysql::fetch_engine(layout, version, progress),
            Engine::Mariadb => Err(unreachable_mariadb()),
        }
    }
    fn init_data(self, layout: &Layout, inst: &Instance) -> Result<(), Failure> {
        match self {
            Engine::Garnet => garnet::init_data(inst),
            Engine::Mysql => mysql::init_data(layout, inst),
            Engine::Mariadb => Err(unreachable_mariadb()),
        }
    }
    /// The SQL engines run their client tools: a managed MySQL its own, as `withTools` gives.
    fn sql_target(self, layout: &Layout, inst: &Instance) -> Result<Instance, Failure> {
        match self {
            Engine::Mysql => mysql::with_tools(layout, inst),
            _ => Ok(inst.clone()),
        }
    }
    pub fn probe(self, layout: &Layout, inst: &Instance) -> Result<(), Failure> {
        match self {
            Engine::Garnet => garnet::probe(inst).map(|_| ()),
            _ => mariadb::probe(layout, &self.sql_target(layout, inst)?),
        }
    }
    fn new_record(self, server: &str, inst: &Instance) -> Result<Value, Failure> {
        match self {
            Engine::Garnet => Ok(garnet::new_record(server, inst)),
            _ => mariadb::new_record(server),
        }
    }
    fn provision(self, layout: &Layout, inst: &Instance, record: &Value) -> Result<(), Failure> {
        match self {
            Engine::Garnet => Ok(()),
            _ => mariadb::provision(layout, &self.sql_target(layout, inst)?, record),
        }
    }
    fn deprovision(
        self,
        layout: &Layout,
        inst: &Instance,
        record: &Value,
        drop: bool,
    ) -> Result<(), Failure> {
        match self {
            Engine::Garnet => Ok(()),
            _ => mariadb::deprovision(layout, &self.sql_target(layout, inst)?, record, drop),
        }
    }
    fn credentials_for(self, inst: &Instance, record: &Value) -> Vec<(String, Value)> {
        match self {
            Engine::Garnet => garnet::credentials_for(inst, record),
            _ => mariadb::credentials_for(inst, record),
        }
    }
    /// `module.binary?.(dir, 'client')`: Garnet has no client tool.
    fn has_client(self, dir: &str) -> bool {
        match self {
            Engine::Garnet => false,
            _ => mariadb::binary(dir, "client").is_some(),
        }
    }
}

fn unreachable_mariadb() -> Failure {
    Failure::user("Choose MySQL or Redis (Garnet). MariaDB is not offered for new databases.")
}

/// `ENGINES[engine]?.label ?? engine`.
pub fn label_of(engine: Option<&Value>) -> String {
    match engine.and_then(Value::as_str).and_then(Engine::named) {
        Some(e) => e.label().to_string(),
        None => js::string(engine),
    }
}

/// `NEW_ENGINES`: MariaDB stays as an internal driver.
pub const NEW_ENGINES: [&str; 2] = ["mysql", "garnet"];

/// `assertNewEngine(engine)`.
pub fn assert_new_engine(engine: &str) -> Result<Engine, Failure> {
    if !NEW_ENGINES.contains(&engine) {
        return Err(Failure::user(
            "Choose MySQL or Redis (Garnet). MariaDB is not offered for new databases.",
        ));
    }
    Ok(Engine::named(engine).expect("a new engine is known"))
}

pub const DEFAULT_ENGINE: &str = "mysql";

fn registry_file(layout: &Layout) -> &Path {
    Path::new(&layout.registry_file)
}

/// `hasInstance(name)`: an own key of `instances`.
pub fn has_instance(layout: &Layout, name: &str) -> Result<bool, Failure> {
    Ok(registry::entries_of(&registry::load(registry_file(layout))?)
        .iter()
        .any(|(k, _)| k == name))
}

/// `getDatabase(name)`.
pub fn get_database(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    let inst = registry::lookup(registry_file(layout), name)?;
    if !inst.is_database() {
        return Err(Failure::user(format!("\"{name}\" is a server, not a database")));
    }
    Ok(inst)
}

/// `assertServer(name)`.
pub fn assert_server(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    let inst = registry::lookup(registry_file(layout), name)?;
    if inst.is_database() {
        return Err(Failure::user(format!("\"{name}\" is a database, not a server")));
    }
    Ok(inst)
}

/// `isUp(db)`: an external database is assumed up; the call itself reports otherwise.
fn is_up(layout: &Layout, db: &Instance) -> Result<bool, Failure> {
    if js::truthy(db.get("external")) {
        return Ok(true);
    }
    Ok(supervisor::read_state(layout, &db.name)?.0 == Status::Running)
}

/// `engineOf(inst)`.
fn engine_of(inst: &Instance) -> Result<Engine, Failure> {
    match inst.get("engine").and_then(Value::as_str).and_then(Engine::named) {
        Some(e) => Ok(e),
        None => Err(Failure::user(format!(
            "\"{}\" runs an engine this build does not know: {}",
            inst.name,
            js::string(inst.get("engine"))
        ))),
    }
}

fn attachments(db: &Instance) -> Map<String, Value> {
    match db.get("attachments") {
        Some(Value::Object(m)) => m.clone(),
        Some(v) if !v.is_null() => registry::entries_of(v).into_iter().collect(),
        _ => Map::new(),
    }
}

fn attachment(db: &Instance, server: &str) -> Option<Value> {
    let a = db.get("attachments")?;
    if a.is_null() {
        return None;
    }
    registry::entries_of(a)
        .into_iter()
        .find(|(k, _)| k == server)
        .map(|(_, v)| v)
        .filter(|v| !v.is_null())
}

/// `versionsFor(engine)`.
pub fn versions_for(engine: Engine) -> Result<Vec<Release>, Failure> {
    engine.versions()
}

/// A port given by hand: `assertPortUsable(name, Number(port))`.
pub fn port_usable(layout: &Layout, name: &str, port: f64) -> Result<u16, Failure> {
    if !(port.is_finite() && port.fract() == 0.0 && (1.0..=65535.0).contains(&port)) {
        return Err(Failure::user(format!(
            "{} is not a port number - use 1 to 65535",
            js::number_to_string(port)
        )));
    }
    registry::assert_port_usable(registry_file(layout), name, &json!(port as u16), "port")
}

/// `createDatabase(name, { engine, version, port, label, onProgress })`: registered last, so a
/// failed download or setup leaves nothing behind but the engine.
pub fn create_database(
    layout: &Layout,
    name: &str,
    engine: Engine,
    version: &str,
    port: Option<f64>,
    label: Option<&str>,
    progress: OnProgress,
) -> Result<Instance, Failure> {
    registry::validate_name(name).map_err(Failure::user)?;
    if has_instance(layout, name)? {
        return Err(Failure::user(format!(
            "\"{name}\" already exists - servers and databases share one set of names"
        )));
    }
    if version.is_empty() {
        return Err(Failure::user(
            "a version is required - see: spawnloft db versions",
        ));
    }
    let chosen = match port {
        Some(p) => port_usable(layout, name, p)?,
        None => util::find_free_port(
            f64::from(engine.default_port()),
            &registry::used_ports(registry_file(layout))?,
        )?,
    };
    engine.fetch_engine(layout, version, progress)?;
    if has_instance(layout, name)? {
        return Err(Failure::user(format!(
            "\"{name}\" was created while the database engine downloaded. Pick another name."
        )));
    }
    port_usable(layout, name, f64::from(chosen))?;

    let dir = crate::jspath::join(&[&layout.services_dir, name]);
    // claim the folder before setup; never set up or delete an existing database or another
    // request's setup in progress
    crate::fsx::mkdir_all(Path::new(&layout.services_dir))?;
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    if let Err(e) = b.create(&dir) {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            return Err(Failure::user(format!(
                "A database folder already exists at {dir}. Move it aside or finish the existing setup before retrying."
            )));
        }
        return Err(Failure::io(&e, "mkdir", Some(Path::new(&dir))));
    }
    let mut fields = Map::new();
    fields.insert("kind".into(), json!("database"));
    fields.insert(
        "engine".into(),
        json!(match engine {
            Engine::Mariadb => mariadb::ENGINE,
            Engine::Garnet => garnet::ENGINE,
            Engine::Mysql => mysql::ENGINE,
        }),
    );
    fields.insert("version".into(), json!(version));
    fields.insert("dir".into(), json!(dir));
    fields.insert("port".into(), json!(chosen));
    fields.insert("root".into(), json!({ "password": util::random_password(24)? }));
    fields.insert("autoRestart".into(), json!(true));
    fields.insert("attachments".into(), json!({}));
    fields.insert("createdAt".into(), json!(crate::time::iso_now()));
    if let Some(clean) = label.and_then(util::clean_label)
        && clean != name
    {
        fields.insert("label".into(), json!(clean));
    }
    progress(&Progress::say(format!(
        "Setting up {} {version} on port {chosen}",
        engine.label()
    )));
    let inst = registry::spread(name, &Value::Object(fields.clone()));
    let set_up = engine.init_data(layout, &inst).and_then(|()| {
        if has_instance(layout, name)? {
            return Err(Failure::user(format!(
                "\"{name}\" was created while the database initialized. Pick another name."
            )));
        }
        Ok(())
    });
    if let Err(f) = set_up {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(f);
    }
    registry::put_instance(registry_file(layout), name, Value::Object(fields))?;
    Ok(inst)
}

/// `nameForServer(serverName)`: the server's name plus `-db`, cut to fit 32 characters.
pub fn name_for_server(layout: &Layout, server: &str) -> Result<String, Failure> {
    let units: Vec<u16> = server.encode_utf16().take(32 - 3).collect();
    let base = format!(
        "{}-db",
        String::from_utf16_lossy(&units).trim_end_matches(['-', '_'])
    );
    registry::free_name(registry_file(layout), &base)
}

/// `portForServer(server)`: the game port plus one, walking up from there when taken.
pub fn port_for_server(layout: &Layout, server: &Instance) -> Result<u16, Failure> {
    let want = js::number(server.get("port")) + 1.0;
    let taken = registry::used_ports(registry_file(layout))?;
    if !(want.is_finite() && want.fract() == 0.0 && (1.0..=65535.0).contains(&want)) {
        return util::find_free_port(f64::from(mariadb::DEFAULT_PORT), &taken);
    }
    util::find_free_port(want, &taken)
}

fn forget(layout: &Layout, by: &Actor, name: &str, dir: &str, kill: bool) {
    if kill {
        let _ = supervisor::kill(layout, by, name);
    }
    let _ = std::fs::remove_dir_all(dir);
    let _ = registry::remove_instance(registry_file(layout), name);
}

/// `createForServer(serverName, { engine, version, onProgress })`: creates, starts and attaches a
/// server's own database in one step. A database that fails to start or attach is removed
/// again; the engine download is kept.
pub fn create_for_server(
    layout: &Layout,
    by: &Actor,
    server_name: &str,
    engine: Engine,
    version: Option<&str>,
    progress: OnProgress,
) -> Result<(Instance, Vec<(String, Value)>), Failure> {
    let server = assert_server(layout, server_name)?;
    let version = match version {
        Some(v) => v.to_string(),
        None => {
            progress(&Progress::say(format!(
                "Asking {} for its newest stable release",
                engine.label()
            )));
            match versions_for(engine)?.into_iter().next() {
                Some(r) => r.version,
                None => {
                    return Err(Failure::user(format!(
                        "{} publishes no stable release to pick from - name one with --version",
                        engine.label()
                    )));
                }
            }
        }
    };
    let name = name_for_server(layout, server_name)?;
    let port = port_for_server(layout, &server)?;
    let label = match server.get("label") {
        v if js::truthy(v) => Some(format!("{} database", js::string(v))),
        _ => None,
    };
    let db = create_database(
        layout,
        &name,
        engine,
        &version,
        Some(f64::from(port)),
        label.as_deref(),
        progress,
    )?;
    let dir = js::string(db.get("dir"));

    progress(&Progress::say(format!("Starting {name} on port {port}")));
    let out = match supervisor::start(layout, by, &name, supervisor::StartOptions::default()) {
        Ok(o) => o,
        Err(f) => {
            forget(layout, by, &name, &dir, false);
            return Err(f);
        }
    };
    if out.failed || out.timed_out {
        forget(layout, by, &name, &dir, true);
        return Err(Failure::user(if out.failed {
            format!(
                "the database started but stopped again: {}",
                out.reason.as_deref().unwrap_or("undefined")
            )
        } else {
            "the database did not report ready in time; nothing was kept".into()
        }));
    }
    progress(&Progress::say(format!("Attaching {server_name}")));
    let credentials = match attach(layout, &name, server_name) {
        Ok(c) => c,
        Err(f) => {
            // the server may have been renamed or deleted during the download, or provisioning
            // failed: cleaned up as a failed start is
            forget(layout, by, &name, &dir, true);
            return Err(f);
        }
    };
    progress(&Progress::say(format!("Created {name}")));
    Ok((get_database(layout, &name)?, credentials))
}

/// What `removeDatabase` did.
#[derive(Debug)]
pub struct Removed {
    pub purged: bool,
    pub detached: Vec<String>,
}

/// `removeDatabase(name, { purge })`. An external database is only forgotten.
pub fn remove_database(layout: &Layout, name: &str, purge: bool) -> Result<Removed, Failure> {
    let inst = get_database(layout, name)?;
    let state = layout.state_file(name);
    if let Some(why) = crate::control::active_block(Path::new(&state), name, "deleting it")? {
        return Err(Failure::user(why));
    }
    let detached: Vec<String> = attachments(&inst).keys().cloned().collect();
    let purged = purge && js::truthy(inst.get("dir")) && !js::truthy(inst.get("external"));
    if purged {
        let dir = js::string(inst.get("dir"));
        if let Err(e) = remove_tree(Path::new(&dir)) {
            return Err(Failure::user(format!(
                "could not delete {dir}: {}\n  \"{name}\" is still registered.",
                crate::jspath::node_error(&e, "rm", Some(Path::new(&dir)))
            )));
        }
    }
    registry::remove_instance(registry_file(layout), name)?;
    crate::control::clear_state(Path::new(&state));
    Ok(Removed { purged, detached })
}

/// `fs.rmSync(dir, { recursive: true, force: true })`: a missing folder is no error.
fn remove_tree(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(dir),
        Ok(_) => std::fs::remove_file(dir),
    }
}

/// `attach(dbName, serverName)`: idempotent; attaching again re-asserts the same credentials,
/// so plugins configured by hand keep working.
pub fn attach(layout: &Layout, db_name: &str, server_name: &str) -> Result<Vec<(String, Value)>, Failure> {
    let db = get_database(layout, db_name)?;
    assert_server(layout, server_name)?;
    if !is_up(layout, &db)? {
        return Err(Failure::user(format!(
            "\"{db_name}\" is not running - start it first, then attach"
        )));
    }
    let engine = engine_of(&db)?;
    let record = match attachment(&db, server_name) {
        Some(r) => r,
        None => engine.new_record(server_name, &db)?,
    };
    engine.provision(layout, &db, &record)?;
    let mut all = attachments(&db);
    all.insert(server_name.to_string(), record);
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Object(all));
    registry::update_instance(registry_file(layout), db_name, &patch)?;
    credentials(layout, db_name, server_name)
}

/// What `detach` did.
#[derive(Debug)]
pub struct Detached {
    pub dropped: bool,
    pub database: Value,
}

/// `detach(dbName, serverName, { drop })`.
pub fn detach(layout: &Layout, db_name: &str, server_name: &str, drop: bool) -> Result<Detached, Failure> {
    let db = get_database(layout, db_name)?;
    let Some(record) = attachment(&db, server_name).filter(|r| js::truthy(Some(r))) else {
        return Err(Failure::user(format!(
            "\"{server_name}\" is not attached to \"{db_name}\""
        )));
    };
    if is_up(layout, &db)? {
        engine_of(&db)?.deprovision(layout, &db, &record, drop)?;
    } else if drop {
        return Err(Failure::user(format!(
            "\"{db_name}\" is not running, so its data cannot be dropped - start it first, or detach without --drop"
        )));
    }
    let mut rest = attachments(&db);
    rest.shift_remove(server_name);
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Object(rest));
    registry::update_instance(registry_file(layout), db_name, &patch)?;
    Ok(Detached {
        dropped: drop,
        database: record.get("database").cloned().unwrap_or(Value::Null),
    })
}

/// `credentials(dbName, serverName)`: in the order the Node core's object holds them.
pub fn credentials(
    layout: &Layout,
    db_name: &str,
    server_name: &str,
) -> Result<Vec<(String, Value)>, Failure> {
    let db = get_database(layout, db_name)?;
    let Some(a) = attachment(&db, server_name).filter(|r| js::truthy(Some(r))) else {
        return Err(Failure::user(format!(
            "\"{server_name}\" is not attached to \"{db_name}\" - attach it first"
        )));
    };
    let engine_value = db.get("engine").cloned().unwrap_or(Value::Null);
    let kind = match engine_value.as_str().and_then(Engine::named) {
        Some(e) => json!(e.kind()),
        None => engine_value.clone(),
    };
    let host = match db.get("host") {
        None | Some(Value::Null) => json!("127.0.0.1"),
        Some(h) => h.clone(),
    };
    let mut out: Vec<(String, Value)> = vec![
        ("service".into(), json!(db_name)),
        ("server".into(), json!(server_name)),
        ("engine".into(), engine_value),
        ("kind".into(), kind),
        ("host".into(), host),
        ("port".into(), db.get("port").cloned().unwrap_or(Value::Null)),
        (
            "database".into(),
            a.get("database").cloned().unwrap_or(Value::Null),
        ),
        ("user".into(), a.get("user").cloned().unwrap_or(Value::Null)),
        (
            "password".into(),
            a.get("password").cloned().unwrap_or(Value::Null),
        ),
    ];
    for (k, v) in engine_of(&db)?.credentials_for(&db, &a) {
        match out.iter_mut().find(|(n, _)| *n == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    Ok(out)
}

/// What an external database is registered with.
#[derive(Debug)]
pub struct External<'a> {
    pub host: &'a str,
    pub port: Option<f64>,
    pub user: &'a str,
    pub password: &'a str,
    pub tools: Option<&'a str>,
    pub label: Option<&'a str>,
}

/// `registerExternal(name, {...})`: it must answer a probe before it is recorded, so a wrong
/// address fails now rather than at the first attach.
pub fn register_external(
    layout: &Layout,
    name: &str,
    engine: Engine,
    ext: External,
) -> Result<Instance, Failure> {
    registry::validate_name(name).map_err(Failure::user)?;
    if has_instance(layout, name)? {
        return Err(Failure::user(format!(
            "\"{name}\" already exists - servers and databases share one set of names"
        )));
    }
    let port = ext.port.unwrap_or(f64::from(engine.default_port()));
    if !(port.is_finite() && port.fract() == 0.0 && (1.0..=65535.0).contains(&port)) {
        return Err(Failure::user(format!(
            "{} is not a port number",
            ext.port.map_or_else(|| "null".into(), js::number_to_string)
        )));
    }
    let mut fields = Map::new();
    fields.insert("kind".into(), json!("database"));
    fields.insert(
        "engine".into(),
        json!(match engine {
            Engine::Mariadb => mariadb::ENGINE,
            Engine::Garnet => garnet::ENGINE,
            Engine::Mysql => mysql::ENGINE,
        }),
    );
    fields.insert("external".into(), json!(true));
    fields.insert(
        "host".into(),
        json!(if ext.host.is_empty() {
            "127.0.0.1"
        } else {
            ext.host
        }),
    );
    fields.insert("port".into(), json!(port as u16));
    fields.insert(
        "root".into(),
        json!({
            "user": if ext.user.is_empty() { "root" } else { ext.user },
            "password": ext.password,
        }),
    );
    fields.insert("attachments".into(), json!({}));
    fields.insert("createdAt".into(), json!(crate::time::iso_now()));
    if let Some(tools) = ext.tools.filter(|t| !t.is_empty()) {
        if !engine.has_client(tools) {
            return Err(Failure::user(format!(
                "{tools} holds no client tool this engine knows"
            )));
        }
        fields.insert("tools".into(), json!({ "dir": tools }));
    }
    if let Some(clean) = ext.label.and_then(util::clean_label)
        && clean != name
    {
        fields.insert("label".into(), json!(clean));
    }
    let inst = registry::spread(name, &Value::Object(fields.clone()));
    engine.probe(layout, &inst)?;
    registry::put_instance(registry_file(layout), name, Value::Object(fields))?;
    Ok(inst)
}

/// What `updateExternal` is given: each `None` is left as it is.
#[derive(Debug)]
pub struct Address {
    pub host: Option<String>,
    pub port: Option<f64>,
    pub user: Option<String>,
    pub password: Option<String>,
}

/// `updateExternal(name, {...})`: saved even when nothing answers there yet, the answer
/// reported, not enforced. Returns the record and whether it answered.
pub fn update_external(layout: &Layout, name: &str, to: Address) -> Result<(Instance, bool), Failure> {
    let db = get_database(layout, name)?;
    if !js::truthy(db.get("external")) {
        return Err(Failure::user(format!(
            "\"{name}\" is run by SpawnLoft; its address is not edited by hand"
        )));
    }
    let mut patch = Map::new();
    if let Some(host) = &to.host {
        let clean = js::trim(host);
        if clean.is_empty() || clean.chars().any(js::is_js_space) {
            return Err(Failure::user(format!("\"{host}\" is not a host name or address")));
        }
        patch.insert("host".into(), json!(clean));
    }
    if let Some(port) = to.port {
        if !(port.is_finite() && port.fract() == 0.0 && (1.0..=65535.0).contains(&port)) {
            return Err(Failure::user(format!(
                "{} is not a port number",
                js::number_to_string(port)
            )));
        }
        patch.insert("port".into(), json!(port as u16));
    }
    if to.user.is_some() || to.password.is_some() {
        let current = |k: &str, fallback: &str| match mariadb::root_field(&db, k) {
            Some(v) => js::string(Some(&v)),
            None => fallback.to_string(),
        };
        let user = match &to.user {
            Some(u) if !js::trim(u).is_empty() => js::trim(u).to_string(),
            _ => current("user", "root"),
        };
        let password = match &to.password {
            Some(p) => p.clone(),
            None => current("password", ""),
        };
        patch.insert("root".into(), json!({ "user": user, "password": password }));
    }
    let next = registry::update_instance(registry_file(layout), name, &patch)?;
    let reachable = engine_of(&next).and_then(|e| e.probe(layout, &next)).is_ok();
    Ok((next, reachable))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_new_engines_are_offered() {
        assert_eq!(assert_new_engine("mysql").unwrap(), Engine::Mysql);
        assert_eq!(assert_new_engine("garnet").unwrap(), Engine::Garnet);
        assert!(assert_new_engine("mariadb").is_err());
        assert!(assert_new_engine("redis").is_err());
        assert_eq!(label_of(Some(&json!("garnet"))), "Redis (Garnet)");
        assert_eq!(label_of(Some(&json!("x"))), "x");
        assert_eq!(label_of(None), "undefined");
    }
}
