//! `garnet.mjs`: Garnet fills the Redis role (Redis ships no Windows binary; Garnet speaks its
//! protocol). C2 part 1 has the engine store and how one is started; the download comes with
//! the `db` command.

use regex::Regex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

use crate::daemon_launch::{Env, LaunchSpec, StopSpec, runnable, set_env};
use crate::failure::Failure;
use crate::js;
use crate::registry::Instance;
use crate::settings::Layout;

pub const VERSION: &str = "2.1.7";
pub const ENGINE: &str = "garnet";
pub const LABEL: &str = "Redis (Garnet)";
pub const KIND: &str = "redis";
pub const DEFAULT_PORT: u16 = 6379;

/// `engineDir(version)`.
pub fn engine_dir(layout: &Layout, version: &str) -> Result<String, Failure> {
    static RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9.-]+)?$").expect("valid"));
    if !RE.is_match(version) {
        return Err(Failure::user("Invalid Garnet version"));
    }
    Ok(crate::jspath::join(&[
        &layout.engines_dir,
        &format!("garnet-{version}"),
    ]))
}

/// `binary(dir)`: the server in the folder, `bin/`, or one folder down. A `.mjs` is a test
/// stand-in. `None` when the folder cannot be listed.
pub fn binary(dir: &str) -> Option<crate::mariadb::Binary> {
    let mut places = vec![dir.to_string(), crate::jspath::join(&[dir, "bin"])];
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    if cfg!(not(windows)) {
        subdirs.sort();
    }
    places.extend(subdirs.iter().map(|n| crate::jspath::join(&[dir, n])));
    for p in places {
        for n in ["GarnetServer.exe", "GarnetServer", "GarnetServer.mjs"] {
            let f = crate::jspath::join(&[&p, n]);
            if Path::new(&f).exists() {
                return Some(crate::mariadb::Binary {
                    path: f,
                    script: n.ends_with(".mjs"),
                });
            }
        }
    }
    None
}

/// `storageArgs()`: on Linux .NET's own file I/O, since the default device needs libaio and
/// liburing.
pub fn storage_args() -> Vec<String> {
    if cfg!(target_os = "linux") {
        vec!["--device-type".into(), "RandomAccess".into()]
    } else {
        Vec::new()
    }
}

/// `launchSpec(inst)`. The password is on the command line, the only way Garnet takes it; stop
/// waits for SAVE to acknowledge a checkpoint, then ends the process (Garnet has no SHUTDOWN).
pub fn launch_spec(layout: &Layout, inst: &Instance) -> Result<LaunchSpec, Failure> {
    let version = js::string(inst.get("version"));
    let dir = engine_dir(layout, &version)?;
    let Some(server) = binary(&dir) else {
        return Err(Failure::user(format!(
            "Garnet {version} is not in the engine store ({dir}). Add the database again to fetch it."
        )));
    };
    let runtime = crate::jspath::join(&[&dir, ".runtime"]);
    let mut env = Env::new();
    if !server.script {
        set_env(&mut env, "DOTNET_ROOT", runtime.clone());
        set_env(
            &mut env,
            &format!("DOTNET_ROOT_{}", crate::platform::node_arch().to_uppercase()),
            runtime,
        );
        set_env(&mut env, "DOTNET_MULTILEVEL_LOOKUP", "0".into());
        if cfg!(target_os = "linux") {
            set_env(&mut env, "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT", "1".into());
        }
    }
    let password = crate::mariadb::root_password(inst);
    let mut args = vec![
        "--port".into(),
        js::string(inst.get("port")),
        "--bind".into(),
        "127.0.0.1".into(),
        "--auth".into(),
        "Password".into(),
        "--password".into(),
        password.clone(),
        "--checkpointdir".into(),
        crate::jspath::join(&[&js::string(inst.get("dir")), "data"]),
        "--recover".into(),
        "--aof".into(),
    ];
    args.extend(storage_args());
    let (cmd, args, env) = runnable(&server.path, server.script, args, env, false)?;
    let mut resp = json!({
        "host": "127.0.0.1",
        "port": inst.get("port").cloned().unwrap_or(Value::Null),
        "password": password,
        "commands": [["SAVE"]],
        "terminateAfterSave": true,
    });
    // JSON.stringify leaves out a port that is undefined
    if inst.get("port").is_none() {
        resp.as_object_mut().map(|m| m.shift_remove("port"));
    }
    Ok(LaunchSpec {
        cmd,
        args,
        env,
        cwd: js::string(inst.get("dir")),
        stop: StopSpec::Resp(resp),
    })
}
