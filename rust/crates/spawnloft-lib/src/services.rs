//! `services.mjs` (C2): databases are registered like servers, run by the same daemon, and
//! attached to servers with their own credentials. An external database is registered by
//! address and root credentials and is never started or stopped from here. C3 (backups) adds
//! the dumps of a server's attached databases that go into its snapshots, and their import when
//! one is restored.

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
    /// MySQL names its release series; Garnet has none.
    pub series: Option<String>,
    pub status: String,
    pub support: Option<String>,
    pub date: Option<String>,
}

impl Release {
    /// The release as `versions()` gives it, a key left out where the engine has no value.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("version".into(), json!(self.version));
        if let Some(series) = &self.series {
            m.insert("series".into(), json!(series));
        }
        m.insert("status".into(), json!(self.status));
        if let Some(support) = &self.support {
            m.insert("support".into(), json!(support));
        }
        if let Some(date) = &self.date {
            m.insert("date".into(), json!(date));
        }
        Value::Object(m)
    }
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
    /// `module.dump(inst, database, file)`: the bytes written. Only for an engine that
    /// [`can_dump`](Engine::can_dump).
    fn dump(self, layout: &Layout, inst: &Instance, database: &str, file: &Path) -> Result<u64, Failure> {
        mariadb::dump(layout, &self.sql_target(layout, inst)?, database, file)
    }
    /// `module.importSql(inst, file)`: Garnet has none, and calling it is a TypeError in Node.
    fn import_sql(self, layout: &Layout, inst: &Instance, file: &Path) -> Result<(), Failure> {
        match self {
            Engine::Garnet => Err(Failure::type_error("engineOf(...).importSql is not a function")),
            _ => mariadb::import_sql(layout, &self.sql_target(layout, inst)?, file),
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

/// `canManage(engine)`: whether SpawnLoft can install and run this engine here. Windows and
/// macOS always can; elsewhere only where the engine has a verified build.
pub fn can_manage(engine: &str) -> bool {
    if !NEW_ENGINES.contains(&engine) {
        return false;
    }
    if cfg!(any(windows, target_os = "macos")) {
        return true;
    }
    match engine {
        mysql::ENGINE => mysql::supports(),
        _ => garnet::supports(),
    }
}

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
        remove_tree(Path::new(&dir)).map_err(|e| Failure::io(&e, "rm", Some(Path::new(&dir))))?;
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

/// The cleanup after a failed start or attach: a folder that cannot be deleted fails it, with
/// the record kept, as `fs.rmSync` throwing does.
fn forget(layout: &Layout, by: &Actor, name: &str, dir: &str, kill: bool) -> Result<(), Failure> {
    if kill {
        let _ = supervisor::kill(layout, by, name);
    }
    remove_tree(Path::new(dir)).map_err(|e| Failure::io(&e, "rm", Some(Path::new(dir))))?;
    registry::remove_instance(registry_file(layout), name)
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
            forget(layout, by, &name, &dir, false)?;
            return Err(f);
        }
    };
    if out.failed || out.timed_out {
        forget(layout, by, &name, &dir, true)?;
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
            forget(layout, by, &name, &dir, true)?;
            return Err(f);
        }
    };
    progress(&Progress::finished(format!("Created {name}")));
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

/// `obj[key] = value` where `value` may be `undefined`, which JSON.stringify leaves out.
fn put(map: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(v) = value {
        map.insert(key.to_string(), v.clone());
    }
}

/// One attachment of a server: the database it is on and the record of that attachment.
#[derive(Debug)]
pub struct Attachment {
    pub service: String,
    pub record: Value,
}

/// `serverAttachments(serverName)`: what a backup needs of it (the database and the record).
pub fn server_attachments(layout: &Layout, server: &str) -> Result<Vec<Attachment>, Failure> {
    let mut out = Vec::new();
    for db in registry::list_services(registry_file(layout))? {
        let Some(record) = db.get("attachments").filter(|a| !a.is_null()).and_then(|a| {
            registry::entries_of(a)
                .into_iter()
                .find(|(k, _)| k == server)
                .map(|(_, v)| v)
        }) else {
            continue;
        };
        if !js::truthy(Some(&record)) {
            continue;
        }
        out.push(Attachment {
            service: db.name.clone(),
            record,
        });
    }
    Ok(out)
}

/// `dumpFileFor(service, database)`, as `path.join` spells it on this system.
pub fn dump_file_for(service: &str, database: &str) -> String {
    crate::jspath::join(&["databases", &format!("{service}__{database}.sql")])
}

/// What [`dump_attachments`] made: the dumps (records for the manifest) and the databases left
/// out, each `{ service, database, reason }`.
#[derive(Debug, Default, Clone)]
pub struct Dumps {
    pub dumped: Vec<Value>,
    pub skipped: Vec<Value>,
}

fn skip(service: &str, database: Option<&Value>, reason: String) -> Value {
    let mut m = Map::new();
    m.insert("service".into(), json!(service));
    put(&mut m, "database", database);
    m.insert("reason".into(), json!(reason));
    Value::Object(m)
}

/// `dumpAttachments(serverName, dir)`: one SQL dump per attached database into
/// `<dir>/databases/`. A database that cannot be dumped (not running, an engine with its own
/// checkpoints, a dump that failed) is reported as skipped, so the rest of the snapshot is
/// still taken.
pub fn dump_attachments(layout: &Layout, server: &str, dir: &Path) -> Result<Dumps, Failure> {
    let mut out = Dumps::default();
    for a in server_attachments(layout, server)? {
        let db = get_database(layout, &a.service)?;
        let engine = engine_of(&db)?;
        let database = a.record.get("database");
        if !engine.can_dump() {
            out.skipped.push(skip(
                &db.name,
                database,
                format!("{} keeps its own checkpoints; it is not dumped", engine.label()),
            ));
            continue;
        }
        if !is_up(layout, &db)? {
            out.skipped
                .push(skip(&db.name, database, "the database is not running".into()));
            continue;
        }
        if crate::control::is_restoring(Path::new(&layout.state_file(&db.name))) {
            out.skipped.push(skip(
                &db.name,
                database,
                "a backup was being put back into it at the time".into(),
            ));
            continue;
        }
        let database_text = js::string(database);
        let rel = dump_file_for(&db.name, &database_text);
        let file = crate::jspath::join_path(&dir.to_string_lossy(), &[&rel]);
        match engine.dump(layout, &db, &database_text, &file) {
            Ok(bytes) => {
                let mut m = Map::new();
                m.insert("service".into(), json!(db.name));
                put(&mut m, "engine", db.get("engine"));
                put(&mut m, "version", db.get("version"));
                put(&mut m, "database", database);
                put(&mut m, "user", a.record.get("user"));
                m.insert("file".into(), json!(rel.replace('\\', "/")));
                m.insert("bytes".into(), json!(bytes));
                out.dumped.push(Value::Object(m));
            }
            Err(e) => out
                .skipped
                .push(skip(&db.name, database, e.message().to_string())),
        }
    }
    Ok(out)
}

/// What [`import_dumps`] did: the dumps imported, and the rest, each with a `reason`.
#[derive(Debug, Default, Clone)]
pub struct Imported {
    pub imported: Vec<Value>,
    pub skipped: Vec<Value>,
}

fn with_reason(d: &Value, reason: String) -> Value {
    // `{ ...d, reason }`: a dump record that is not an object spreads nothing
    let mut m = match d {
        Value::Object(m) => m.clone(),
        Value::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, u)| (i.to_string(), json!(String::from_utf16_lossy(&[u]))))
            .collect(),
        _ => Map::new(),
    };
    m.insert("reason".into(), json!(reason));
    Value::Object(m)
}

/// `importDumps(serverName, dumps, baseDir)`: each dump a restored snapshot recorded, from
/// `<baseDir>/databases/`, into the database it came from. The manifest names the file and the
/// import runs as the database's root, so only a file in `databases/` inside the server folder
/// is taken: no climbing out, no links leading out.
pub fn import_dumps(layout: &Layout, dumps: &[Value], base_dir: &str) -> Result<Imported, Failure> {
    let mut out = Imported::default();
    for d in dumps {
        let field = |k: &str| d.as_object().and_then(|m| m.get(k));
        let rel = match field("file") {
            Some(Value::String(f)) => crate::util::safe_relative_path(f),
            _ => None,
        };
        let Some(rel) = rel.filter(|r| r.starts_with("databases/")) else {
            out.skipped.push(with_reason(
                d,
                "the manifest names a dump outside the server folder's databases folder; it was not imported"
                    .into(),
            ));
            continue;
        };
        let parts: Vec<&str> = rel.split('/').collect();
        let file = crate::jspath::join_path(base_dir, &parts);
        let shown = file.display().to_string();
        if !file.exists() {
            out.skipped
                .push(with_reason(d, "the dump is missing from the archive".into()));
            continue;
        }
        let base_real = crate::fsx::realpath(Path::new(base_dir))
            .map_err(|e| Failure::io(&e, "realpath", Some(Path::new(base_dir))))?;
        let file_real = crate::fsx::realpath(&file).map_err(|e| Failure::io(&e, "realpath", Some(&file)))?;
        if !crate::util::is_inside(&base_real, &file_real) {
            out.skipped.push(with_reason(
                d,
                "the dump leads outside the server folder; it was not imported".into(),
            ));
            continue;
        }
        let service = js::string(field("service"));
        let known = has_instance(layout, &service)?
            && registry::lookup(registry_file(layout), &service)
                .map(|i| i.is_database())
                .unwrap_or(false);
        if !known {
            out.skipped.push(with_reason(
                d,
                format!("\"{service}\" is no longer here; the dump is left at {shown}"),
            ));
            continue;
        }
        let db = get_database(layout, &service)?;
        if !is_up(layout, &db)? {
            out.skipped.push(with_reason(
                d,
                format!("\"{service}\" is not running; the dump is left at {shown}"),
            ));
            continue;
        }
        if crate::control::is_restoring(Path::new(&layout.state_file(&db.name))) {
            out.skipped.push(with_reason(
                d,
                format!(
                    "a backup is being put back into \"{service}\" right now; the dump is left at {shown}"
                ),
            ));
            continue;
        }
        match engine_of(&db).and_then(|e| e.import_sql(layout, &db, &file)) {
            Ok(()) => out.imported.push(d.clone()),
            Err(e) => out.skipped.push(with_reason(
                d,
                format!("{}; the dump is left at {shown}", e.message()),
            )),
        }
    }
    Ok(out)
}

/// `externalStatus(db)`: whether a database run elsewhere answers its probe now.
pub fn external_status(layout: &Layout, db: &Instance) -> &'static str {
    match engine_of(db).and_then(|e| e.probe(layout, db)) {
        Ok(()) => "reachable",
        Err(_) => "unreachable",
    }
}

// A database's own backups live beside server snapshots, under the database's name (unique across
// servers and databases): one plain .sql file per backup plus a small .json manifest.

/// `databaseBackupsDir(name)`.
pub fn database_backups_dir(layout: &Layout, name: &str) -> String {
    crate::jspath::join(&[&layout.backups_dir, name])
}

/// `DUMP_NAME` (`/^[\w.-]+\.sql$/`): only names this module wrote, nothing that could reach
/// outside the folder.
fn is_dump_name(file: &str) -> bool {
    file.len() > ".sql".len()
        && file.ends_with(".sql")
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// `dumpPath(name, file)`: a backup of `name` by its file name, which must be one this module
/// could have written. A name that passes holds no separator, so it is its own `basename`.
fn dump_path(layout: &Layout, name: &str, file: &str) -> Result<std::path::PathBuf, Failure> {
    if !is_dump_name(file) {
        return Err(Failure::user(format!("\"{file}\" is not a backup of \"{name}\"")));
    }
    let full = crate::jspath::join_path(&database_backups_dir(layout, name), &[file]);
    if !full.exists() {
        return Err(Failure::user(format!(
            "there is no backup called \"{file}\" for \"{name}\""
        )));
    }
    Ok(full)
}

/// The `.json` manifest beside a `.sql` backup (`${full.slice(0, -4)}.json`).
fn manifest_of(full: &Path) -> std::path::PathBuf {
    full.with_extension("json")
}

/// `attachedDatabases(db)`: the database of each attachment, each once, in order. One that names
/// none is `null`; an attachment that is `null` is JavaScript's TypeError.
fn attached_databases(db: &Instance) -> Result<Vec<Value>, Failure> {
    let records: Vec<Value> = match db.get("attachments") {
        None | Some(Value::Null) => Vec::new(),
        Some(a) => registry::entries_of(a).into_iter().map(|(_, v)| v).collect(),
    };
    // `undefined` and `null` are two members of a Set, though both are written as null
    let mut seen: Vec<Option<Value>> = Vec::new();
    for a in records {
        let database = match &a {
            Value::Null => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'database')",
                ));
            }
            Value::Object(m) => m.get("database").cloned(),
            _ => None,
        };
        // an object or a list is a new member each time, as `new Set` compares by identity
        let compound = matches!(database, Some(Value::Object(_) | Value::Array(_)));
        if compound || !seen.contains(&database) {
            seen.push(database);
        }
    }
    Ok(seen.into_iter().map(|d| d.unwrap_or(Value::Null)).collect())
}

/// `databases.join(', ')`: `null` reads as nothing.
fn join_databases(databases: &[Value]) -> String {
    databases
        .iter()
        .map(|d| match d {
            Value::Null => String::new(),
            d => js::string(Some(d)),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `listDatabaseBackups(name)`: newest first. A missing folder is none.
pub fn list_database_backups(layout: &Layout, name: &str) -> Result<Vec<Value>, Failure> {
    get_database(layout, name)?;
    let dir = database_backups_dir(layout, name);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let files: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|f| is_dump_name(f))
        .collect();
    let mut rows: Vec<(i64, Value)> = Vec::new();
    for f in files {
        let full = crate::jspath::join_path(&dir, &[&f]);
        let st = std::fs::metadata(&full).map_err(|e| Failure::io(&e, "stat", Some(&full)))?;
        // `new Date(mtimeMs)` keeps whole milliseconds
        let mtime = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as i64);
        let manifest = match std::fs::read(manifest_of(&full)) {
            Err(_) => Value::Object(Map::new()),
            // a manifest that is there but not JSON fails the listing, as `.then(JSON.parse)` does
            Ok(b) => crate::jsjson::parse(&String::from_utf8_lossy(&b)).map_err(Failure::syntax)?,
        };
        let of = |key: &str| match &manifest {
            Value::Null => Err(Failure::type_error(format!(
                "Cannot read properties of null (reading '{key}')"
            ))),
            Value::Object(m) => Ok(m.get(key).filter(|v| !v.is_null()).cloned()),
            _ => Ok(None),
        };
        let label = of("label")?.unwrap_or_else(|| json!(""));
        let databases = of("databases")?.unwrap_or_else(|| json!([]));
        let size = st.len();
        rows.push((
            mtime,
            json!({
                "name": f,
                "size": size,
                "sizeHuman": crate::text::human_bytes(Some(size as f64)),
                "mtime": crate::time::iso(mtime),
                "label": label,
                "databases": databases,
            }),
        ));
    }
    // a stable sort, as Array.prototype.sort is
    rows.sort_by_key(|r| std::cmp::Reverse(r.0));
    Ok(rows.into_iter().map(|(_, r)| r).collect())
}

/// `databaseBackupStatus(name)`: what the backups page shows above the list.
pub fn database_backup_status(layout: &Layout, name: &str) -> Result<Map<String, Value>, Failure> {
    let db = get_database(layout, name)?;
    let mut m = Map::new();
    m.insert("canDump".into(), json!(engine_of(&db)?.can_dump()));
    m.insert("running".into(), json!(is_up(layout, &db)?));
    m.insert("databases".into(), Value::Array(attached_databases(&db)?));
    m.insert("dir".into(), json!(database_backups_dir(layout, name)));
    Ok(m)
}

/// What [`backup_database`] took.
#[derive(Debug, Clone)]
pub struct DatabaseBackup {
    pub name: String,
    pub file: String,
    pub databases: Vec<Value>,
    pub size: u64,
}

impl DatabaseBackup {
    /// `{ name, file, databases, size, sizeHuman }`.
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "file": self.file,
            "databases": self.databases,
            "size": self.size,
            "sizeHuman": crate::text::human_bytes(Some(self.size as f64)),
        })
    }
}

/// Two backups in this process could pick the same free name and dump into the same parts;
/// Node's single thread interleaved them only at its awaits, and its `wx` refused the second.
static BACKING_UP: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The file-name tag of a backup: `(cleanLabel(label) ?? 'manual').replace(/[^\w-]+/g, '-')`,
/// cut at 40, `manual` when nothing is left.
fn backup_tag(label: &str) -> String {
    let clean = util::clean_label(label).unwrap_or_else(|| "manual".into());
    let mut tag = String::new();
    let mut in_run = false;
    for c in clean.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            tag.push(c);
            in_run = false;
        } else if !in_run {
            tag.push('-');
            in_run = true;
        }
    }
    // only ASCII is left, so 40 characters are 40 UTF-16 units
    let tag: String = tag.chars().take(40).collect();
    if tag.is_empty() { "manual".into() } else { tag }
}

/// `backupDatabase(name, { label, quiet, duringRestore })`: one .sql file. Each database is dumped
/// separately and joined in order (each part names its own database, so the file imports in one
/// go), written as `.pending` and renamed into place, so a listing never offers half a dump.
pub fn backup_database(
    layout: &Layout,
    by: &Actor,
    name: &str,
    label: &str,
    quiet: bool,
    during_restore: bool,
) -> Result<DatabaseBackup, Failure> {
    let state = layout.state_file(name);
    if !during_restore
        && let Some(why) = crate::control::restore_block(Path::new(&state), name, "taking a new one")
    {
        return Err(Failure::user(why));
    }
    let db = get_database(layout, name)?;
    let engine = engine_of(&db)?;
    if !engine.can_dump() {
        return Err(Failure::user(format!(
            "{} keeps its own checkpoints on disk; there is nothing here to dump",
            engine.label()
        )));
    }
    if !is_up(layout, &db)? {
        return Err(Failure::user(format!(
            "\"{name}\" is not running. A dump is read from the running database - start it first."
        )));
    }
    let databases = attached_databases(&db)?;
    if databases.is_empty() {
        return Err(Failure::user(format!(
            "nothing to back up yet: no server is attached to \"{name}\""
        )));
    }
    let dir = database_backups_dir(layout, name);
    crate::fsx::mkdir_all(Path::new(&dir))?;
    let tag = backup_tag(label);
    let _one = BACKING_UP
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let sql = |base: &str| crate::jspath::join_path(&dir, &[&format!("{base}.sql")]);
    let mut base = format!("{tag}_{}", util::stamp());
    let mut n = 2;
    while sql(&base).exists() {
        base = format!("{tag}_{}_{n}", util::stamp());
        n += 1;
    }
    let file = sql(&base);
    let pending = std::path::PathBuf::from(format!("{}.pending", file.display()));
    let parts: Vec<std::path::PathBuf> = (0..databases.len())
        .map(|i| std::path::PathBuf::from(format!("{}.{i}", pending.display())))
        .collect();
    let made = (|| -> Result<(), Failure> {
        for (database, part) in databases.iter().zip(&parts) {
            engine.dump(layout, &db, &js::string(Some(database)), part)?;
        }
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| Failure::io(&e, "open", Some(&pending)))?;
        for part in &parts {
            let mut from = std::fs::File::open(part).map_err(|e| Failure::io(&e, "open", Some(part)))?;
            std::io::copy(&mut from, &mut out).map_err(|e| Failure::io(&e, "write", Some(&pending)))?;
        }
        drop(out);
        let mut manifest = Map::new();
        manifest.insert("database".into(), json!(name));
        put(&mut manifest, "engine", db.get("engine"));
        manifest.insert(
            "version".into(),
            db.get("version").cloned().unwrap_or(Value::Null),
        );
        manifest.insert("label".into(), json!(tag));
        manifest.insert("databases".into(), Value::Array(databases.clone()));
        manifest.insert("createdAt".into(), json!(crate::time::iso_now()));
        let manifest_file = manifest_of(&file);
        std::fs::write(
            &manifest_file,
            crate::jsjson::stringify_pretty(&Value::Object(manifest)),
        )
        .map_err(|e| Failure::io(&e, "open", Some(&manifest_file)))?;
        std::fs::rename(&pending, &file).map_err(|e| Failure::io(&e, "rename", Some(&pending)))
    })();
    for p in std::iter::once(&pending).chain(&parts) {
        let _ = std::fs::remove_file(p);
    }
    made?;
    let size = std::fs::metadata(&file)
        .map_err(|e| Failure::io(&e, "stat", Some(&file)))?
        .len();
    let taken = DatabaseBackup {
        name: format!("{base}.sql"),
        file: file.display().to_string(),
        databases,
        size,
    };
    if !quiet {
        crate::activity::record_by(
            &crate::paths::Roots::new(&layout.data_root),
            by,
            name,
            "backup",
            Some(&format!(
                "{} as SQL, {}",
                join_databases(&taken.databases),
                crate::text::human_bytes(Some(size as f64))
            )),
            Some(&taken.name),
            true,
        );
    }
    Ok(taken)
}

/// The restore marker of a database (`beginRestore`); dropping it clears the mark.
struct RestoreMark(std::path::PathBuf);

impl Drop for RestoreMark {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `beginRestore(name)`: marks the database for as long as the restore runs, so a second
/// restore, a delete or a new dump refuses until it has finished, from any process.
fn begin_restore(layout: &Layout, name: &str) -> Result<RestoreMark, Failure> {
    let state = layout.state_file(name);
    if let Some(why) = crate::control::restore_block(Path::new(&state), name, "restoring another") {
        return Err(Failure::user(why));
    }
    let file = crate::control::restore_marker(Path::new(&state));
    if let Some(dir) = file.parent() {
        crate::fsx::mkdir_all(dir)?;
    }
    let mark = json!({ "pid": std::process::id(), "at": crate::time::iso_now() });
    std::fs::write(&file, crate::jsjson::stringify(&mark))
        .map_err(|e| Failure::io(&e, "open", Some(&file)))?;
    Ok(RestoreMark(file))
}

/// `restoreDatabaseBackup(name, file)`: takes a `pre-restore` backup first, so putting back the
/// wrong one can itself be undone. Returns the file put back and the safety backup's name.
pub fn restore_database_backup(
    layout: &Layout,
    by: &Actor,
    name: &str,
    file: &str,
) -> Result<(String, Option<String>), Failure> {
    let db = get_database(layout, name)?;
    let full = dump_path(layout, name, file)?;
    if !is_up(layout, &db)? {
        return Err(Failure::user(format!(
            "\"{name}\" is not running. A backup is put back into the running database - start it first."
        )));
    }
    let _mark = begin_restore(layout, name)?;
    let safety = if attached_databases(&db)?.is_empty() {
        None
    } else {
        Some(backup_database(layout, by, name, "pre-restore", true, true)?.name)
    };
    engine_of(&db)?.import_sql(layout, &db, &full)?;
    let detail = match &safety {
        Some(s) => format!("{file}; how it was is kept as {s}"),
        None => file.to_string(),
    };
    crate::activity::record_by(
        &crate::paths::Roots::new(&layout.data_root),
        by,
        name,
        "restore",
        Some(&detail),
        None,
        true,
    );
    Ok((file.to_string(), safety))
}

/// `deleteDatabaseBackup(name, file)`: the dump and its manifest. Returns the name deleted.
pub fn delete_database_backup(
    layout: &Layout,
    by: &Actor,
    name: &str,
    file: &str,
) -> Result<String, Failure> {
    get_database(layout, name)?;
    let state = layout.state_file(name);
    if let Some(why) = crate::control::restore_block(Path::new(&state), name, "deleting a backup") {
        return Err(Failure::user(why));
    }
    let full = dump_path(layout, name, file)?;
    // `fs.promises.rm(p, { force: true })`: gone already is fine, a folder is not removed
    for p in [full.clone(), manifest_of(&full)] {
        match std::fs::remove_file(&p) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(Failure::io(&e, "rm", Some(&p)));
            }
            _ => {}
        }
    }
    crate::activity::record_by(
        &crate::paths::Roots::new(&layout.data_root),
        by,
        name,
        "backup-delete",
        Some(file),
        None,
        true,
    );
    Ok(file.to_string())
}

/// `databaseBackupFile(name, file)`: where a backup is, for a download.
pub fn database_backup_file(layout: &Layout, name: &str, file: &str) -> Result<std::path::PathBuf, Failure> {
    get_database(layout, name)?;
    dump_path(layout, name, file)
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

    #[test]
    fn a_release_is_written_with_the_keys_its_engine_gives() {
        let r = Release {
            version: "8.4.11".into(),
            series: Some("8.4".into()),
            status: "Stable".into(),
            support: Some("Long Term Support".into()),
            date: None,
        };
        assert_eq!(
            crate::jsjson::stringify(&r.to_json()),
            r#"{"version":"8.4.11","series":"8.4","status":"Stable","support":"Long Term Support"}"#
        );
    }

    #[test]
    fn only_names_a_backup_could_have_are_taken() {
        for ok in ["a.sql", "manual_2026-01-02_030405.sql", "..sql", "a-b_c.d.sql"] {
            assert!(is_dump_name(ok), "{ok}");
        }
        for bad in [
            "",
            ".sql",
            "a.SQL",
            "a.sql.json",
            "../a.sql",
            "a/b.sql",
            "a b.sql",
            "a\\b.sql",
            "é.sql",
            "a.sql\n",
        ] {
            assert!(!is_dump_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_backup_is_tagged_by_its_label() {
        assert_eq!(backup_tag("manual"), "manual");
        assert_eq!(backup_tag("  Before   the update! "), "Before-the-update-");
        assert_eq!(backup_tag("\u{1F600}"), "-");
        assert_eq!(backup_tag("   "), "manual");
        assert_eq!(backup_tag(&"x".repeat(60)), "x".repeat(40));
    }

    #[test]
    fn the_attached_databases_are_named_once_each() {
        let db = |a: Value| registry::spread("d", &json!({ "kind": "database", "attachments": a }));
        let got = attached_databases(&db(json!({
            "s1": { "database": "s1" },
            "s2": { "database": "s1" },
            "s3": {},
            "s4": { "database": null },
            "s5": "text",
        })))
        .unwrap();
        assert_eq!(got, vec![json!("s1"), Value::Null, Value::Null]);
        assert!(attached_databases(&db(json!({ "s1": null }))).is_err());
        assert!(attached_databases(&db(Value::Null)).unwrap().is_empty());
        assert_eq!(join_databases(&[json!("a"), Value::Null, json!("b")]), "a, , b");
    }

    #[test]
    fn backups_are_listed_newest_first_with_their_manifests() {
        let root = std::env::temp_dir()
            .join(format!("sl-dbbackups-{}", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let _ = std::fs::remove_dir_all(&root);
        let at = |leaf: &str| crate::jspath::join(&[&root, leaf]);
        let layout = Layout {
            instances_dir: at("instances"),
            separate_instances: false,
            registry_file: at("instances.json"),
            templates_dir: at("templates"),
            jars_dir: at("jars"),
            backups_dir: at("backups"),
            run_dir: at("run"),
            engines_dir: at("engines"),
            services_dir: at("services"),
            settings_file: at("settings.json"),
            data_root: root.clone(),
        };
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            &layout.registry_file,
            r#"{"version":1,"instances":{"d1":{"kind":"database","engine":"mariadb","port":1},"s1":{"dir":"x"}}}"#,
        )
        .unwrap();
        assert!(
            list_database_backups(&layout, "d1").unwrap().is_empty(),
            "no folder yet"
        );
        assert!(list_database_backups(&layout, "s1").is_err(), "a server has none");
        let dir = database_backups_dir(&layout, "d1");
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        for (f, body) in [("old.sql", "x"), ("new.sql", "yy"), ("skip.txt", "z")] {
            std::fs::write(crate::jspath::join(&[&dir, f]), body).unwrap();
        }
        std::fs::File::options()
            .write(true)
            .open(crate::jspath::join(&[&dir, "old.sql"]))
            .unwrap()
            .set_modified(old)
            .unwrap();
        std::fs::write(
            crate::jspath::join(&[&dir, "new.json"]),
            r#"{"label":"pre-restore","databases":["s1"]}"#,
        )
        .unwrap();
        let rows = list_database_backups(&layout, "d1").unwrap();
        let names: Vec<&str> = rows.iter().filter_map(|r| r["name"].as_str()).collect();
        assert_eq!(names, ["new.sql", "old.sql"]);
        assert_eq!(rows[0]["label"], "pre-restore");
        assert_eq!(rows[0]["databases"], json!(["s1"]));
        assert_eq!(rows[1]["label"], "");
        assert_eq!(rows[1]["sizeHuman"], "1 B");
        assert_eq!(
            database_backup_file(&layout, "d1", "new.sql").unwrap(),
            crate::jspath::join_path(&dir, &["new.sql"])
        );
        assert_eq!(
            database_backup_file(&layout, "d1", "gone.sql")
                .unwrap_err()
                .message(),
            "there is no backup called \"gone.sql\" for \"d1\""
        );
        assert_eq!(
            database_backup_file(&layout, "d1", "../x.sql")
                .unwrap_err()
                .message(),
            "\"../x.sql\" is not a backup of \"d1\""
        );
        let by = Actor::new("panel", None);
        assert_eq!(
            delete_database_backup(&layout, &by, "d1", "new.sql").unwrap(),
            "new.sql"
        );
        assert!(!std::path::Path::new(&crate::jspath::join(&[&dir, "new.json"])).exists());
        std::fs::write(crate::jspath::join(&[&dir, "old.json"]), "null").unwrap();
        assert!(
            list_database_backups(&layout, "d1").is_err(),
            "a manifest of null is a TypeError"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
