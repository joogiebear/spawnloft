//! `mariadb.mjs`: the engine store layout, its binaries and how a managed MariaDB is started.
//! MariaDB is no longer offered for new databases; it stays as the driver MySQL shares its
//! client conventions with. The download, setup and SQL parts come with the `db` command.

use std::path::Path;

use crate::daemon_launch::{Env, LaunchSpec, StopSpec, runnable};
use crate::failure::Failure;
use crate::js;
use crate::registry::Instance;
use crate::settings::Layout;

pub const ENGINE: &str = "mariadb";
pub const LABEL: &str = "MariaDB";
pub const KIND: &str = "mariadb";
pub const DEFAULT_PORT: u16 = 3306;

/// `engineDir(version)`.
pub fn engine_dir(layout: &Layout, version: &str) -> String {
    crate::jspath::join(&[&layout.engines_dir, &format!("mariadb-{version}")])
}

/// The binary names per role, new names first (10.4 renamed them).
fn names(role: &str) -> &'static [&'static str] {
    match role {
        "server" => &["mariadbd", "mysqld"],
        "init" => &["mariadb-install-db", "mysql_install_db"],
        "admin" => &["mariadb-admin", "mysqladmin"],
        "client" => &["mariadb", "mysql"],
        "dump" => &["mariadb-dump", "mysqldump"],
        _ => &[],
    }
}

/// A binary found for a role: its path, and whether it is a `.mjs` test stand-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binary {
    pub path: String,
    pub script: bool,
}

/// `binary(dir, role)`: under `bin/` (the store) or in the folder itself (a tools folder such
/// as XAMPP's `mysql\bin`), `.exe` then no extension then `.mjs`.
pub fn binary(dir: &str, role: &str) -> Option<Binary> {
    if dir.is_empty() {
        return None;
    }
    for name in names(role) {
        for ext in [".exe", "", ".mjs"] {
            let file = format!("{name}{ext}");
            for p in [
                crate::jspath::join(&[dir, "bin", &file]),
                crate::jspath::join(&[dir, &file]),
            ] {
                if Path::new(&p).exists() {
                    return Some(Binary {
                        path: p,
                        script: ext == ".mjs",
                    });
                }
            }
        }
    }
    None
}

/// `hostOf(inst)`.
pub fn host_of(inst: &Instance) -> String {
    match inst.get("host") {
        None | Some(serde_json::Value::Null) => "127.0.0.1".into(),
        v => js::string(v),
    }
}

/// `inst.root?.<key>`.
pub fn root_field(inst: &Instance, key: &str) -> Option<serde_json::Value> {
    inst.get("root")
        .filter(|r| !r.is_null())
        .and_then(|r| r.get(key))
        .filter(|v| !v.is_null())
        .cloned()
}

/// `rootArgs(inst)`.
pub fn root_args(inst: &Instance) -> Vec<String> {
    vec![
        "--no-defaults".into(),
        "--protocol=TCP".into(),
        format!("--host={}", host_of(inst)),
        format!("--port={}", js::string(inst.get("port"))),
        format!(
            "--user={}",
            root_field(inst, "user").map_or_else(|| "root".into(), |u| js::string(Some(&u)))
        ),
    ]
}

/// `inst.root?.password ?? ''`.
pub fn root_password(inst: &Instance) -> String {
    root_field(inst, "password").map_or_else(String::new, |p| js::string(Some(&p)))
}

/// `dataDir(inst)`.
pub fn data_dir(inst: &Instance) -> String {
    crate::jspath::join(&[&js::string(inst.get("dir")), "data"])
}

/// `iniFile(inst)`.
pub fn ini_file(inst: &Instance) -> String {
    crate::jspath::join(&[&js::string(inst.get("dir")), "my.ini"])
}

/// `launchSpec(inst)`: `--console` puts the log on stderr; the stop is the admin tool over TCP,
/// the password in the environment.
pub fn launch_spec(layout: &Layout, inst: &Instance) -> Result<LaunchSpec, Failure> {
    let version = js::string(inst.get("version"));
    let dir = engine_dir(layout, &version);
    let Some(server) = binary(&dir, "server") else {
        return Err(Failure::user(format!(
            "MariaDB {version} is not in the engine store ({dir}). Add the database again to fetch it."
        )));
    };
    let (cmd, args, env) = runnable(
        &server.path,
        server.script,
        vec![format!("--defaults-file={}", ini_file(inst)), "--console".into()],
        Env::new(),
        true,
    )?;
    let stop = match binary(&dir, "admin") {
        Some(admin) => {
            let mut a = root_args(inst);
            a.push("shutdown".into());
            let pw: Env = vec![("MYSQL_PWD".into(), root_password(inst))];
            let (cmd, args, env) = runnable(&admin.path, admin.script, a, pw, true)?;
            StopSpec::Command { cmd, args, env }
        }
        None => StopSpec::None,
    };
    Ok(LaunchSpec {
        cmd,
        args,
        env,
        cwd: js::string(inst.get("dir")),
        stop,
    })
}
