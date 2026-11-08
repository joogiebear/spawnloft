//! What a launch runs: the command, its arguments and environment, and how it is asked to stop.
//!
//! A Minecraft server's program is worked out here from the registry on every launch, as
//! `daemon.mjs` does, so a changed memory or Java setting applies at the next crash restart. A
//! database's program comes from the Node supervisor (its engine modules know the engine store's
//! layout, which R1 does not port), handed over on stdin once and reused for crash restarts.

use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::js;
use crate::registry::{self, Instance};

/// How a running program is asked to shut down.
#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    /// A line written to its console (`stop` for Minecraft).
    Stdin(String),
    /// An admin tool run beside it (MariaDB, MySQL).
    Command {
        cmd: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
    /// Commands over the Redis protocol; with `terminate_after_save` the process is then
    /// terminated, since Garnet has no SHUTDOWN.
    Resp {
        host: String,
        port: u16,
        password: Option<String>,
        commands: Vec<Vec<String>>,
        terminate_after_save: bool,
    },
    /// Nothing graceful: wait, then kill.
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub cmd: String,
    pub args: Vec<String>,
    /// Added to (or replacing) what the daemon inherited.
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub stop: Stop,
}

/// `--password x` and `--password=x` hidden in a logged command line (`maskSecretArgs`).
pub fn mask_secret_args(args: &[String]) -> Vec<String> {
    let secret_flag =
        |a: &str| a.eq_ignore_ascii_case("--password") || a.eq_ignore_ascii_case("--requirepass");
    args.iter()
        .enumerate()
        .map(|(i, a)| {
            if i > 0 && secret_flag(&args[i - 1]) {
                return "[redacted]".to_string();
            }
            if let Some((flag, _)) = a.split_once('=')
                && secret_flag(flag)
            {
                return format!("{flag}=[redacted]");
            }
            a.clone()
        })
        .collect()
}

fn is_script(bin: &str) -> bool {
    let lower = bin.to_ascii_lowercase();
    lower.ends_with(".js") || lower.ends_with(".mjs")
}

/// A Minecraft server: Java with the jar, stopped by `stop` on its console. A `java` that is a
/// `.mjs`/`.js` file is the test hook: a stand-in JVM run by the Node runtime the supervisor
/// named, never a `node` from PATH (the packaged app has none).
pub fn minecraft(inst: &Instance, node: Option<&Path>) -> Result<Program, String> {
    let dir = inst
        .dir()
        .ok_or_else(|| format!("instance \"{}\" has no folder in instances.json", inst.name))?;
    let jar = inst
        .jar()
        .ok_or_else(|| format!("instance \"{}\" has no jar in instances.json", inst.name))?;
    let memory = js::string(inst.get("memory"));
    let flags = match inst.jvm_flags() {
        Some(f) => f,
        None => registry::jvm_flags_for(&memory)?,
    };
    let jar_name = Path::new(dir)
        .join(jar)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("instance \"{}\" has no usable jar name", inst.name))?;
    let mut args = vec![format!("-Xms{memory}"), format!("-Xmx{memory}")];
    args.extend(flags);
    args.extend(["-jar".to_string(), jar_name, "--nogui".to_string()]);
    let java = inst.java();
    let (cmd, args, env) = if is_script(&java) {
        let node = node.ok_or("this server's java is a script, which needs the Node runtime (--node)")?;
        let mut all = vec![java];
        all.extend(args);
        (
            node.to_string_lossy().into_owned(),
            all,
            vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())],
        )
    } else {
        (java, args, Vec::new())
    };
    Ok(Program {
        cmd,
        args,
        env,
        cwd: PathBuf::from(dir),
        stop: Stop::Stdin("stop\n".into()),
    })
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().map(|x| js::string(Some(x))).collect())
        .unwrap_or_default()
}

fn env_pairs(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), js::string(Some(v)))).collect())
        .unwrap_or_default()
}

/// A database's program as the supervisor sent it: `{ cmd, args, env, cwd, stop }`, where `env`
/// holds only what differs from the daemon's own environment.
pub fn from_spec(spec: &Value) -> Result<Program, String> {
    let cmd = spec
        .get("cmd")
        .and_then(Value::as_str)
        .ok_or("the launch spec has no cmd")?
        .to_string();
    let cwd = spec
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or("the launch spec has no cwd")?;
    let stop = match spec.get("stop") {
        Some(Value::Object(s)) if s.get("stdin").is_some_and(Value::is_string) => {
            Stop::Stdin(js::string(s.get("stdin")))
        }
        Some(Value::Object(s)) if s.get("cmd").is_some_and(Value::is_string) => Stop::Command {
            cmd: js::string(s.get("cmd")),
            args: strings(s.get("args")),
            env: env_pairs(s.get("env")),
        },
        Some(Value::Object(s)) if s.get("resp").is_some_and(Value::is_object) => {
            let r = &s["resp"];
            let port = js::number(r.get("port"));
            if !(1.0..=65535.0).contains(&port) {
                return Err("the launch spec's Redis stop has no port".into());
            }
            Stop::Resp {
                host: r
                    .get("host")
                    .and_then(Value::as_str)
                    .unwrap_or("127.0.0.1")
                    .to_string(),
                port: port as u16,
                password: r
                    .get("password")
                    .and_then(Value::as_str)
                    .filter(|p| !p.is_empty())
                    .map(String::from),
                commands: r
                    .get("commands")
                    .and_then(Value::as_array)
                    .map(|c| c.iter().map(|x| strings(Some(x))).collect())
                    .unwrap_or_default(),
                terminate_after_save: js::truthy(r.get("terminateAfterSave")),
            }
        }
        _ => Stop::None,
    };
    Ok(Program {
        cmd,
        args: strings(spec.get("args")),
        env: env_pairs(spec.get("env")),
        cwd: PathBuf::from(cwd),
        stop,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inst(fields: Value) -> Instance {
        Instance {
            name: "a".into(),
            fields: fields.as_object().unwrap().clone(),
        }
    }

    #[test]
    fn minecraft_program_matches_daemon_mjs() {
        let p = minecraft(
            &inst(json!({ "dir": "/srv/a", "jar": "paper.jar", "memory": "2G" })),
            None,
        )
        .unwrap();
        assert_eq!(p.cmd, "java");
        assert_eq!(p.args[..2], ["-Xms2G".to_string(), "-Xmx2G".to_string()]);
        assert_eq!(
            p.args[p.args.len() - 3..],
            ["-jar".to_string(), "paper.jar".to_string(), "--nogui".to_string()]
        );
        assert!(p.args.contains(&"-XX:+UseG1GC".to_string()));
        assert_eq!(p.stop, Stop::Stdin("stop\n".into()));

        let own = minecraft(
            &inst(json!({ "dir": "/srv/a", "jar": "x/paper.jar", "memory": "2G", "jvmFlags": ["-Dx=1"] })),
            None,
        )
        .unwrap();
        assert_eq!(
            own.args,
            ["-Xms2G", "-Xmx2G", "-Dx=1", "-jar", "paper.jar", "--nogui"]
        );
    }

    #[test]
    fn the_test_hook_runs_scripts_on_the_named_runtime() {
        let i = inst(json!({ "dir": "/srv/a", "jar": "s.jar", "memory": "1G", "java": "/t/fake-java.mjs" }));
        assert!(minecraft(&i, None).is_err());
        let p = minecraft(&i, Some(Path::new("/opt/node"))).unwrap();
        assert_eq!(p.cmd, "/opt/node");
        assert_eq!(p.args[0], "/t/fake-java.mjs");
        assert_eq!(p.env, [("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())]);
    }

    #[test]
    fn database_specs() {
        let p = from_spec(
            &json!({ "cmd": "/e/mariadbd", "args": ["--console"], "env": { "A": "1" }, "cwd": "/d",
            "stop": { "cmd": "/e/admin", "args": ["shutdown"], "env": { "MYSQL_PWD": "pw" } } }),
        )
        .unwrap();
        assert_eq!(
            p.stop,
            Stop::Command {
                cmd: "/e/admin".into(),
                args: vec!["shutdown".into()],
                env: vec![("MYSQL_PWD".into(), "pw".into())]
            }
        );
        let g = from_spec(&json!({ "cmd": "g", "cwd": "/d", "stop": { "resp": { "host": "127.0.0.1", "port": 6379, "password": "pw",
            "commands": [["SAVE"]], "terminateAfterSave": true } } })).unwrap();
        assert!(matches!(
            g.stop,
            Stop::Resp {
                port: 6379,
                terminate_after_save: true,
                ..
            }
        ));
        assert!(from_spec(&json!({ "args": [] })).is_err());
    }

    #[test]
    fn masks_passwords() {
        let args: Vec<String> = ["--port", "1", "--password", "pw", "--requirepass=x", "--console"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            mask_secret_args(&args),
            [
                "--port",
                "1",
                "--password",
                "[redacted]",
                "--requirepass=[redacted]",
                "--console"
            ]
        );
    }
}
