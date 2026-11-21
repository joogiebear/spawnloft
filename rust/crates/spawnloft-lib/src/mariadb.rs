//! `mariadb.mjs`: the engine store layout, its binaries, how a managed MariaDB is started, and
//! the client conventions MySQL shares: SQL through the client tool, attach and detach grants,
//! dumps and imports. MariaDB is no longer offered for new databases (every caller of
//! `createDatabase` and `versionsFor` passes `assertNewEngine`), so its download API, fetch and
//! data setup are unreachable and not ported; records made by an older build still run.

use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

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

/// `toolsDir(inst)`: a managed database's own engine; an external one's recorded tools folder,
/// else whatever [`find_tools`] finds.
pub fn tools_dir(layout: &Layout, inst: &Instance) -> Option<String> {
    if !js::truthy(inst.get("external")) {
        return Some(engine_dir(layout, &js::string(inst.get("version"))));
    }
    let tools = inst.get("tools").and_then(|t| t.get("dir"));
    if js::truthy(tools) {
        return Some(js::string(tools));
    }
    find_tools(layout)
}

/// `findTools()`: the engine store's MariaDB and MySQL folders, then the usual install places,
/// the first that holds a client.
pub fn find_tools(layout: &Layout) -> Option<String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(names) = crate::fsx::readdir_names(Path::new(&layout.engines_dir)) {
        for e in names {
            if e.starts_with("mariadb-") || e.starts_with("mysql-") {
                candidates.push(crate::jspath::join(&[&layout.engines_dir, &e]));
            }
        }
    }
    if cfg!(windows) {
        candidates.push("C:\\xampp\\mysql\\bin".into());
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            let Some(base) = std::env::var(var).ok().filter(|v| !v.is_empty()) else {
                continue;
            };
            let Ok(entries) = crate::fsx::readdir_names(Path::new(&base)) else {
                continue;
            };
            for e in entries {
                let lower = e.to_lowercase();
                if lower.starts_with("mariadb") {
                    candidates.push(crate::jspath::join(&[&base, &e, "bin"]));
                }
                if lower == "mysql" {
                    let inner = crate::jspath::join(&[&base, &e]);
                    // a folder that cannot be read ends the scan of this base, as the try does
                    let Ok(versions) = crate::fsx::readdir_names(Path::new(&inner)) else {
                        break;
                    };
                    for v in versions {
                        if v.to_lowercase().starts_with("mysql server") {
                            candidates.push(crate::jspath::join(&[&inner, &v, "bin"]));
                        }
                    }
                }
            }
        }
    }
    if cfg!(target_os = "macos") {
        for base in ["/opt/homebrew/opt", "/usr/local/opt"] {
            for formula in ["mysql", "mysql@8.4", "mariadb", "mariadb@11.4"] {
                candidates.push(crate::jspath::join(&[base, formula, "bin"]));
            }
        }
        candidates.push("/usr/local/mysql/bin".into());
        if let Ok(path) = std::env::var("PATH") {
            candidates.extend(path.split(':').filter(|p| !p.is_empty()).map(str::to_string));
        }
    }
    candidates.into_iter().find(|c| binary(c, "client").is_some())
}

/// `quoteIdent(name)`.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// `quoteStr(s)`.
pub fn quote_str(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

fn root_env(inst: &Instance) -> Env {
    vec![("MYSQL_PWD".into(), root_password(inst))]
}

/// `sql(inst, statements)`: the statements through the client tool as root; its output.
pub fn sql(layout: &Layout, inst: &Instance, statements: &str) -> Result<String, Failure> {
    let dir = tools_dir(layout, inst);
    let Some(client) = dir.as_deref().and_then(|d| binary(d, "client")) else {
        return Err(Failure::user(if js::truthy(inst.get("external")) {
            format!(
                "no MariaDB/MySQL client tools found for \"{}\". Select a folder containing mariadb or mysql, or create a managed database here once to download its tools.",
                inst.name
            )
        } else {
            format!(
                "MariaDB {} has no client tool under {}",
                js::string(inst.get("version")),
                dir.as_deref().unwrap_or("undefined")
            )
        }));
    };
    let mut args = root_args(inst);
    args.extend([
        "--batch".into(),
        "--skip-column-names".into(),
        "--execute".into(),
        statements.into(),
    ]);
    let (cmd, args, env) = runnable(&client.path, client.script, args, root_env(inst), true)?;
    let command = crate::procx::command(&cmd, &args, &env, None);
    let done = match crate::procx::output_within(command, Duration::from_secs(60)) {
        Ok(d) => d,
        Err(e) => {
            let (code, _) = crate::jspath::error_code(&e);
            return Err(Failure::user(format!(
                "could not run the MariaDB client: spawn {cmd} {code}"
            )));
        }
    };
    let stdout = String::from_utf8_lossy(&done.stdout).into_owned();
    if done.timed_out {
        return Err(Failure::user(
            "could not run the MariaDB client: it did not answer within a minute",
        ));
    }
    match done.code {
        Some(0) => Ok(stdout),
        Some(code) => {
            let stderr = String::from_utf8_lossy(&done.stderr);
            let said = if !stderr.is_empty() {
                stderr.into_owned()
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("exit {code}")
            };
            Err(Failure::user(format!("MariaDB refused: {}", js::trim(&said))))
        }
        // a signal: execFile's "Command failed" message
        None => Err(Failure::user(format!(
            "could not run the MariaDB client: Command failed: {cmd} {}\n{}",
            args.join(" "),
            String::from_utf8_lossy(&done.stderr)
        ))),
    }
}

fn loopback_users(user: &str) -> String {
    ["localhost", "127.0.0.1"]
        .iter()
        .map(|h| format!("{}@{}", quote_str(user), quote_str(h)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `attachSql({ database, user, password })`: both loopback hosts, since skip-name-resolve keys
/// TCP connections by address; IF NOT EXISTS plus ALTER, so attaching twice repairs.
pub fn attach_sql(database: &str, user: &str, password: &str) -> String {
    let db = quote_ident(database);
    let hosts: Vec<String> = ["localhost", "127.0.0.1"]
        .iter()
        .map(|h| format!("{}@{}", quote_str(user), quote_str(h)))
        .collect();
    let mut lines = vec![format!(
        "CREATE DATABASE IF NOT EXISTS {db} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    )];
    for u in &hosts {
        lines.push(format!(
            "CREATE USER IF NOT EXISTS {u} IDENTIFIED BY {};",
            quote_str(password)
        ));
    }
    for u in &hosts {
        lines.push(format!("ALTER USER {u} IDENTIFIED BY {};", quote_str(password)));
    }
    lines.push(format!("GRANT ALL PRIVILEGES ON {db}.* TO {};", hosts.join(", ")));
    lines.push("FLUSH PRIVILEGES;".into());
    lines.join("\n")
}

/// `detachSql({ database, user, drop })`.
pub fn detach_sql(database: &str, user: &str, drop: bool) -> String {
    let mut lines = vec![format!("DROP USER IF EXISTS {};", loopback_users(user))];
    if drop {
        lines.push(format!("DROP DATABASE IF EXISTS {};", quote_ident(database)));
    }
    lines.push("FLUSH PRIVILEGES;".into());
    lines.join("\n")
}

/// `runToFile(cmd, args, env, { stdout, stdin, label })`.
fn run_to_file(
    cmd: &str,
    args: &[String],
    env: &Env,
    stdout: Option<&mut dyn std::io::Write>,
    stdin: Option<std::fs::File>,
    label: &str,
) -> Result<(), Failure> {
    let command = crate::procx::command(cmd, args, env, None);
    match crate::procx::run_to_file(command, stdout, stdin) {
        Ok(done) if done.code == Some(0) => Ok(()),
        Ok(done) => {
            let stderr = String::from_utf8_lossy(&done.stderr);
            let first = js::trim(&stderr)
                .split('\n')
                .next()
                .unwrap_or("")
                .trim_end_matches('\r')
                .to_string();
            let code = done.code.map_or_else(|| "null".to_string(), |c| c.to_string());
            Err(Failure::user(format!(
                "MariaDB {label} exited {code}: {}",
                if first.is_empty() {
                    "no reason given"
                } else {
                    &first
                }
            )))
        }
        Err(crate::procx::ToFileError::Spawn(e)) => Err(Failure::user(format!(
            "could not run the MariaDB {label}: spawn {cmd} {}",
            crate::jspath::error_code(&e).0
        ))),
        Err(crate::procx::ToFileError::Write(e)) => Err(Failure::user(format!(
            "could not write the output of the MariaDB {label}: {}",
            crate::jspath::node_error(&e, "write", None)
        ))),
        Err(crate::procx::ToFileError::Read(e)) => Err(Failure::user(format!(
            "could not read the input for the MariaDB {label}: {}",
            crate::jspath::node_error(&e, "read", None)
        ))),
    }
}

/// `dump(inst, database, file)`: `--single-transaction` for a consistent snapshot without locks,
/// `--databases` so the file names its own database. Returns the bytes written.
pub fn dump(layout: &Layout, inst: &Instance, database: &str, file: &Path) -> Result<u64, Failure> {
    let dir = tools_dir(layout, inst);
    let Some(tool) = dir.as_deref().and_then(|d| binary(d, "dump")) else {
        return Err(Failure::user(format!(
            "no MariaDB dump tool found for \"{}\" under {}",
            inst.name,
            dir.as_deref().unwrap_or("(no tools folder)")
        )));
    };
    let mut args = root_args(inst);
    args.extend(
        [
            "--single-transaction",
            "--routines",
            "--triggers",
            "--events",
            "--databases",
            database,
        ]
        .map(String::from),
    );
    let (cmd, args, env) = runnable(&tool.path, tool.script, args, root_env(inst), true)?;
    if let Some(parent) = file.parent() {
        crate::fsx::mkdir_all(parent)?;
    }
    let mut out = std::fs::File::create(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    if let Err(f) = run_to_file(&cmd, &args, &env, Some(&mut out), None, "dump tool") {
        drop(out);
        let _ = std::fs::remove_file(file);
        return Err(f);
    }
    // the file is unbuffered: every byte was handed to it as it came, and a failed write failed
    // the dump above
    drop(out);
    std::fs::metadata(file)
        .map(|m| m.len())
        .map_err(|e| Failure::io(&e, "stat", Some(file)))
}

/// `importSql(inst, file)`: the file into the client as root.
pub fn import_sql(layout: &Layout, inst: &Instance, file: &Path) -> Result<(), Failure> {
    let dir = tools_dir(layout, inst);
    let Some(client) = dir.as_deref().and_then(|d| binary(d, "client")) else {
        return Err(Failure::user(format!(
            "no MariaDB client tool found for \"{}\" under {}",
            inst.name,
            dir.as_deref().unwrap_or("(no tools folder)")
        )));
    };
    let (cmd, args, env) = runnable(&client.path, client.script, root_args(inst), root_env(inst), true)?;
    let input = std::fs::File::open(file).map_err(|e| {
        Failure::user(format!(
            "could not read the input for the MariaDB client: {}",
            crate::jspath::node_error(&e, "open", Some(file))
        ))
    })?;
    run_to_file(&cmd, &args, &env, None, Some(input), "client")
}

/// `probe(inst)`.
pub fn probe(layout: &Layout, inst: &Instance) -> Result<(), Failure> {
    sql(layout, inst, "SELECT 1;").map(|_| ())
}

/// `newRecord(serverName)`: a database and a user named after the server.
pub fn new_record(server: &str) -> Result<Value, Failure> {
    Ok(json!({
        "database": server,
        "user": server,
        "password": crate::util::random_password(24)?,
        "createdAt": crate::time::iso_now(),
    }))
}

fn record_text(record: &Value, key: &str) -> String {
    js::string(record.get(key))
}

/// `provision(inst, record)`.
pub fn provision(layout: &Layout, inst: &Instance, record: &Value) -> Result<(), Failure> {
    sql(
        layout,
        inst,
        &attach_sql(
            &record_text(record, "database"),
            &record_text(record, "user"),
            &record_text(record, "password"),
        ),
    )
    .map(|_| ())
}

/// `deprovision(inst, record, { drop })`.
pub fn deprovision(layout: &Layout, inst: &Instance, record: &Value, drop: bool) -> Result<(), Failure> {
    sql(
        layout,
        inst,
        &detach_sql(
            &record_text(record, "database"),
            &record_text(record, "user"),
            drop,
        ),
    )
    .map(|_| ())
}

/// `credentialsFor(inst, record)`.
pub fn credentials_for(inst: &Instance, record: &Value) -> Vec<(String, Value)> {
    vec![(
        "jdbc".into(),
        json!(format!(
            "jdbc:mysql://{}:{}/{}",
            host_of(inst),
            js::string(inst.get("port")),
            record_text(record, "database")
        )),
    )]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_strings_cannot_break_out() {
        assert_eq!(quote_ident("a`b"), "`a``b`");
        assert_eq!(quote_str("it's"), "'it''s'");
        assert_eq!(quote_str("a\\b"), "'a\\\\b'");
    }

    #[test]
    fn attach_grants_one_database_on_both_loopback_hosts() {
        let sql = attach_sql("smp", "smp", "p4ss");
        let want = "CREATE DATABASE IF NOT EXISTS `smp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n\
CREATE USER IF NOT EXISTS 'smp'@'localhost' IDENTIFIED BY 'p4ss';\n\
CREATE USER IF NOT EXISTS 'smp'@'127.0.0.1' IDENTIFIED BY 'p4ss';\n\
ALTER USER 'smp'@'localhost' IDENTIFIED BY 'p4ss';\n\
ALTER USER 'smp'@'127.0.0.1' IDENTIFIED BY 'p4ss';\n\
GRANT ALL PRIVILEGES ON `smp`.* TO 'smp'@'localhost', 'smp'@'127.0.0.1';\n\
FLUSH PRIVILEGES;";
        assert_eq!(sql, want);
        assert_eq!(
            detach_sql("smp", "smp", false),
            "DROP USER IF EXISTS 'smp'@'localhost', 'smp'@'127.0.0.1';\nFLUSH PRIVILEGES;"
        );
        assert!(detach_sql("smp", "smp", true).contains("\nDROP DATABASE IF EXISTS `smp`;\n"));
    }
}
