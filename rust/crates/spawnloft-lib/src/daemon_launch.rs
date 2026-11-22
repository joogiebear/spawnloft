//! `daemon-launch.mjs`: how a server's daemon is started: `spawnloft-core daemon <name>`, the only
//! daemon since the Node one left with the Node core (C10; `SPAWNLOFT_DAEMON` and the `daemon`
//! setting mean nothing now, and `doctor` says so of a leftover `"daemon": "node"`). A database's launch spec is
//! worked out here by its engine module and handed to the Rust daemon on stdin, so no password
//! is on disk or in a process list.

use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::failure::Failure;
use crate::registry::Instance;
use crate::settings::Layout;
use crate::{garnet, js, mariadb, mysql};

/// An environment as overrides on top of the process's own: `(name, value)` in the order the
/// Node core's object spread would hold them.
pub type Env = Vec<(String, String)>;

/// `env[name]` among the overrides, else the process's own (as the core sees it).
pub fn env_value(env: &Env, name: &str) -> Option<String> {
    env.iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
        .or_else(|| base_value(name))
}

/// `{ ...env, [name]: value }`.
pub fn set_env(env: &mut Env, name: &str, value: String) {
    match env.iter_mut().find(|(k, _)| k == name) {
        Some(slot) => slot.1 = value,
        None => env.push((name.to_string(), value)),
    }
}

/// The environment a daemon inherits: this process's, with `SPAWNLOFT_ENTRY` naming this binary
/// (as it did when the Node core ran behind it) and the Node variables removed.
fn base_value(name: &str) -> Option<String> {
    match name {
        crate::entry::ENTRY_ENV => std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        "ELECTRON_RUN_AS_NODE" | "NODE_OPTIONS" | "NODE_PATH" => None,
        _ => std::env::var(name).ok(),
    }
}

/// `envDelta(full)`: the overrides that differ from the process's own.
pub fn env_delta(env: &Env) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in env {
        if base_value(k).as_deref() != Some(v.as_str()) {
            out.insert(k.clone(), json!(v));
        } else {
            out.shift_remove(k);
        }
    }
    out
}

/// How a database is stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopSpec {
    None,
    Stdin(String),
    Command {
        cmd: String,
        args: Vec<String>,
        env: Env,
    },
    /// `{ resp: {...} }` as the engine wrote it
    Resp(Value),
}

/// An engine's `launchSpec(inst)`, the parts the daemon gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub cmd: String,
    pub args: Vec<String>,
    pub env: Env,
    pub cwd: String,
    pub stop: StopSpec,
}

/// The Node that runs a `.mjs` stand-in (the tests' fake JVM and engines), `process.execPath`
/// in the Node core: `SPAWNLOFT_NODE` or `node` on PATH, in a `test-hooks` build only.
pub fn script_runtime() -> Result<String, Failure> {
    crate::runtime::script_node()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| Failure::user(format!("a test stand-in program needs the Node runtime: {e}")))
}

/// `runnable(bin, args, env)` of the engine modules: a `.mjs` runs on Node with
/// `ELECTRON_RUN_AS_NODE`; a managed Linux engine may carry its own libraries (linux-libs).
pub fn runnable(
    path: &str,
    script: bool,
    args: Vec<String>,
    mut env: Env,
    library_env: bool,
) -> Result<(String, Vec<String>, Env), Failure> {
    if script {
        let mut all = vec![path.to_string()];
        all.extend(args);
        set_env(&mut env, "ELECTRON_RUN_AS_NODE", "1".into());
        return Ok((script_runtime()?, all, env));
    }
    if library_env {
        crate::linux_libs::library_env(path, &mut env);
    }
    Ok((path.to_string(), args, env))
}

/// `databaseSpec(inst)`: the program as the Rust daemon reads it (daemon/program.rs).
pub fn database_spec(layout: &Layout, inst: &Instance) -> Result<Value, Failure> {
    let spec = launch_spec(layout, inst)?;
    let stop = match &spec.stop {
        StopSpec::None => Value::Null,
        StopSpec::Stdin(s) => json!({ "stdin": s }),
        StopSpec::Command { cmd, args, env } => {
            json!({ "cmd": cmd, "args": args, "env": Value::Object(env_delta(env)) })
        }
        StopSpec::Resp(r) => json!({ "resp": r }),
    };
    Ok(json!({
        "cmd": spec.cmd,
        "args": spec.args,
        "env": Value::Object(env_delta(&spec.env)),
        "cwd": spec.cwd,
        "stop": stop,
    }))
}

/// The engine module's `launchSpec`.
pub fn launch_spec(layout: &Layout, inst: &Instance) -> Result<LaunchSpec, Failure> {
    match inst.get("engine") {
        Some(Value::String(e)) if e == mariadb::ENGINE => mariadb::launch_spec(layout, inst),
        Some(Value::String(e)) if e == garnet::ENGINE => garnet::launch_spec(layout, inst),
        Some(Value::String(e)) if e == mysql::ENGINE => mysql::launch_spec(layout, inst),
        other => Err(Failure::Internal {
            head: "Error".into(),
            message: format!("Unknown database engine: {}", js::string(other)),
            code: None,
        }),
    }
}

/// `coreBinary()`: `SPAWNLOFT_CORE_BIN`, else this binary.
pub fn core_binary() -> String {
    match std::env::var("SPAWNLOFT_CORE_BIN").ok().filter(|v| !v.is_empty()) {
        Some(b) => crate::jspath::resolve(&b),
        None => std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| crate::build::NAME.into()),
    }
}

/// `rustDaemonArgs(name, { database })`. `--node` names the Node that runs a `.mjs` stand-in,
/// in a test build that has one.
pub fn rust_daemon_args(layout: &Layout, name: &str, database: bool) -> Vec<String> {
    let mut args = vec![
        "daemon".to_string(),
        name.to_string(),
        "--data-root".into(),
        layout.data_root.clone(),
    ];
    if let Ok(node) = crate::runtime::script_node() {
        args.push("--node".into());
        args.push(node.to_string_lossy().into_owned());
    }
    if database {
        args.extend(["--spec".into(), "-".into()]);
    }
    args
}

/// The folder daemons start in: this binary's own, so a daemon holds no other folder open.
pub fn daemon_cwd() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| ".".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_delta_holds_only_what_differs() {
        let path = std::env::var("PATH").unwrap_or_default();
        let env: Env = vec![
            ("PATH".into(), path),
            ("SL_TEST_NEW".into(), "1".into()),
            ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
        ];
        let d = env_delta(&env);
        assert_eq!(
            d.keys().collect::<Vec<_>>(),
            ["SL_TEST_NEW", "ELECTRON_RUN_AS_NODE"]
        );
    }

    #[test]
    fn an_unknown_engine_fails_as_node_does() {
        let layout = Layout::resolve(&Map::from_iter([("dataRoot".into(), json!("/tmp/sl-x"))])).unwrap();
        let inst = crate::registry::spread("d", &json!({ "kind": "database", "engine": "x" }));
        let f = database_spec(&layout, &inst).unwrap_err();
        assert_eq!(f.stderr_text(), "Error: Unknown database engine: x\n");
    }
}
