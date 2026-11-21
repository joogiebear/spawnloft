//! `garnet.mjs`: Garnet fills the Redis role (Redis ships no Windows binary; Garnet speaks its
//! protocol): the pinned native builds with a private .NET runtime, how one is started, and the
//! attachments, which are one shared key space and password rather than per-server users.

use regex::Regex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use crate::daemon_launch::{Env, LaunchSpec, StopSpec, runnable, set_env};
use crate::engines::{InstallLock, OnProgress, Progress, Staging};
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

/// `ARCHIVES[platform-arch]`: Microsoft's builds, pinned to their published SHA-256 digests.
fn archive_entry(platform: &str, arch: &str) -> Option<(&'static str, &'static str)> {
    Some(match (platform, arch) {
        ("win32", "x64") => (
            "win-x64-based-readytorun.zip",
            "3409c9aba39565caa4c6166f2d7c66ac112c2a773d70679b1bb34458dea16473",
        ),
        ("darwin", "arm64") => (
            "osx-arm64-based.tar.xz",
            "e4b41812a5c554735046022e6f4ab8a8651511444f284935339296bd83e431b9",
        ),
        ("darwin", "x64") => (
            "osx-x64-based.tar.xz",
            "19bf42260c35d5521794f4a422e3df5d8cb0a921ab3a10a896413d4b7d45abdd",
        ),
        ("linux", "x64") => (
            "linux-x64-based.tar.xz",
            "cd36cd82b5a8b1da91acb0d7e3fba6aa01341f32556b89552058393b3fa9cf2d",
        ),
        ("linux", "arm64") => (
            "linux-arm64-based.tar.xz",
            "9365dc73df63d36cd2d29938e16494cb8ac9942444b22f37eaf4ff778615bd81",
        ),
        _ => return None,
    })
}

/// `supports()`.
pub fn supports() -> bool {
    archive_entry(crate::platform::node_platform(), crate::platform::node_arch()).is_some()
}

/// `archiveFor(version)`: the pinned archive's name, digest and URL.
pub fn archive_for(version: &str) -> Result<(&'static str, &'static str, String), Failure> {
    let (platform, arch) = (crate::platform::node_platform(), crate::platform::node_arch());
    match archive_entry(platform, arch) {
        Some((name, sha)) if version == VERSION => Ok((
            name,
            sha,
            format!("https://github.com/microsoft/garnet/releases/download/v{VERSION}/{name}"),
        )),
        _ => Err(Failure::user(format!(
            "No verified Redis (Garnet) {version} archive for {platform}/{arch}."
        ))),
    }
}

/// `versions()`: the one verified build.
pub fn versions() -> Result<Vec<crate::services::Release>, Failure> {
    archive_for(VERSION)?;
    Ok(vec![crate::services::Release {
        version: VERSION.into(),
        status: "Stable".into(),
        support: Some("Verified native build".into()),
        date: None,
    }])
}

/// The .NET runtime kept private to the engine, and its SHA-512 per runtime identifier.
pub const RUNTIME_VERSION: &str = "10.0.12";

fn runtime_hash(rid: &str) -> Option<&'static str> {
    Some(match rid {
        "win-x64" => {
            "844fa99e16fd6f44e0a7c29def7a82d7846902334d6a955248a9519a4dddb3f5acceb9c9223bef69f8c83b8ae2417537e5b76dddf79fb7117dc85b5039bc1297"
        }
        "osx-arm64" => {
            "d1b422c2afecb5e741430584c3e1887d5e0f2df321a80d492fdd13d8c7f99579f0dbbf34e348bc512cb276f0f86b4645423a032ded52808b74ab8eb0d7bf2a6d"
        }
        "osx-x64" => {
            "c5019357c9d8fbe30b49ec8f81ae85be56a784d8b4b75f470e931583c39e082773c089b39785b322770a298ab08636c6b30e695a2397fc311060f73c98743b48"
        }
        "linux-x64" => {
            "58388fdde4f13bd703c7a6f7defb3300b17e42ba5fe8bca50066f80f64ac7406620dcdfb4acc1eff7992750c8cc5cff8369dd12d09730c8a9e8760d6032f7f6e"
        }
        "linux-arm64" => {
            "ac1e0090391085ba70c7457adaaa8f6cc20dc216b9b368b4227a427de271708d783380c7b955b7be4897ff24849fbe5c3b7ec1cb1c38345a725de9a3812280eb"
        }
        _ => return None,
    })
}

/// `runtimeId()`.
pub fn runtime_id() -> String {
    let os = match crate::platform::node_platform() {
        "win32" => "win",
        "darwin" => "osx",
        "linux" => "linux",
        _ => "undefined",
    };
    format!("{os}-{}", crate::platform::node_arch())
}

/// `hasEngine(version)`: a stand-in counts; a real build needs its marker and its runtime.
pub fn has_engine(layout: &Layout, version: &str) -> Result<bool, Failure> {
    let dir = engine_dir(layout, version)?;
    let Some(server) = binary(&dir) else {
        return Ok(false);
    };
    if server.script {
        return Ok(true);
    }
    let Ok(text) = std::fs::read(crate::jspath::join_path(&dir, &["spawnloft-engine.json"])) else {
        return Ok(false);
    };
    let Ok(marker) = crate::jsjson::parse(&String::from_utf8_lossy(&text)) else {
        return Ok(false);
    };
    let Ok((_, sha, _)) = archive_for(version) else {
        return Ok(false);
    };
    let field = |k: &str| marker.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(
        field("platform").as_deref() == Some(crate::platform::node_platform())
            && field("arch").as_deref() == Some(crate::platform::node_arch())
            && field("sha256").as_deref() == Some(sha)
            && Path::new(&crate::jspath::join(&[
                &dir,
                ".runtime",
                "shared",
                "Microsoft.NETCore.App",
                RUNTIME_VERSION,
            ]))
            .exists(),
    )
}

/// `fetchEngine(version, { onProgress })`: the pinned build and its private runtime, under a
/// lock and in a staging folder, moved into place only when both are complete.
pub fn fetch_engine(layout: &Layout, version: &str, progress: OnProgress) -> Result<(), Failure> {
    let dir = engine_dir(layout, version)?;
    if has_engine(layout, version)? {
        progress(&Progress::say(format!("Garnet {version} is already here")));
        return Ok(());
    }
    if !supports() {
        return Err(Failure::user(
            "Managed Redis (Garnet) requires Windows x64, an Apple Silicon or Intel Mac, or Linux on x64 or arm64.",
        ));
    }
    if version != VERSION {
        return Err(Failure::user(format!(
            "No verified Garnet {version} bundle. See: spawnloft db versions --engine garnet"
        )));
    }
    let (_, sha, url) = archive_for(version)?;
    crate::fsx::mkdir_all(Path::new(&layout.engines_dir))?;
    let lock = format!("{dir}.install-lock");
    let Some(_lock) = InstallLock::take(Path::new(&lock))? else {
        return Err(Failure::user(format!(
            "Redis installation is already in progress. If it was interrupted, close SpawnLoft and remove {lock}, then retry."
        )));
    };
    if has_engine(layout, version)? {
        return Ok(());
    }
    if Path::new(&dir).exists() {
        return Err(Failure::user(format!(
            "An incomplete Garnet engine exists at {dir}. Move it aside before retrying."
        )));
    }
    let staging = Staging(crate::engines::mkdtemp(&crate::jspath::join(&[
        &layout.engines_dir,
        ".garnet-download-",
    ]))?);
    let file = staging.0.join("download");
    let unpacked = staging.0.join("engine");
    std::fs::create_dir(&unpacked).map_err(|e| Failure::io(&e, "mkdir", Some(&unpacked)))?;
    crate::engines::fetch_pinned(
        &url,
        &file,
        crate::download::Hash::Sha256,
        sha,
        &format!("Downloading Redis (Garnet) {version}"),
        progress,
        "Garnet download checksum mismatch. Nothing was installed; please retry.",
        |status| format!("Garnet download failed ({status}). Please retry."),
    )?;
    progress(&Progress::say(format!("Unpacking Redis (Garnet) {version}")));
    let ok = crate::engines::unpack(&file, &unpacked, false, &staging.0)?;
    let server = binary(&unpacked.to_string_lossy());
    let Some(server) = server.filter(|_| ok) else {
        return Err(Failure::user("The Garnet archive did not unpack completely."));
    };
    // the archive does not keep the exec bit everywhere
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let p = Path::new(&server.path);
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| Failure::io(&e, "chmod", Some(p)))?;
    }
    #[cfg(not(unix))]
    let _ = server;
    install_runtime(&unpacked, &staging.0, progress)?;
    let marker = json!({
        "version": version,
        "platform": crate::platform::node_platform(),
        "arch": crate::platform::node_arch(),
        "sha256": sha,
    });
    let marker_file = unpacked.join("spawnloft-engine.json");
    std::fs::write(&marker_file, crate::jsjson::stringify(&marker))
        .map_err(|e| Failure::io(&e, "open", Some(&marker_file)))?;
    std::fs::rename(&unpacked, &dir)
        .map_err(|e| crate::fsx::rename_failure(&e, &unpacked, Path::new(&dir)))?;
    Ok(())
}

fn install_runtime(dir: &Path, staging: &Path, progress: OnProgress) -> Result<(), Failure> {
    let rid = runtime_id();
    let Some(hash) = runtime_hash(&rid) else {
        return Err(Failure::user(format!("No verified Redis runtime for {rid}.")));
    };
    let suffix = if cfg!(windows) { "zip" } else { "tar.gz" };
    let url = format!(
        "https://builds.dotnet.microsoft.com/dotnet/Runtime/{RUNTIME_VERSION}/dotnet-runtime-{RUNTIME_VERSION}-{rid}.{suffix}"
    );
    let file = staging.join("runtime-archive");
    crate::engines::fetch_pinned(
        &url,
        &file,
        crate::download::Hash::Sha512,
        hash,
        "Downloading the private Redis runtime",
        progress,
        "Redis runtime checksum mismatch. Nothing was installed.",
        |status| format!("Redis runtime download failed ({status}). Please retry."),
    )?;
    let runtime = dir.join(".runtime");
    std::fs::create_dir(&runtime).map_err(|e| Failure::io(&e, "mkdir", Some(&runtime)))?;
    let ok = crate::engines::unpack(&file, &runtime, false, staging)?;
    let dotnet = runtime.join(if cfg!(windows) { "dotnet.exe" } else { "dotnet" });
    if !ok || !dotnet.exists() {
        return Err(Failure::user(
            "The Redis runtime archive did not unpack completely.",
        ));
    }
    Ok(())
}

/// `initData(inst)`: only the folder; Garnet makes its checkpoint files on the first save.
pub fn init_data(inst: &Instance) -> Result<(), Failure> {
    let dir = crate::jspath::join(&[&js::string(inst.get("dir")), "data"]);
    crate::fsx::mkdir_all(Path::new(&dir))
}

/// `probe(inst)`: PING with the root password; whether it answered PONG.
pub fn probe(inst: &Instance) -> Result<bool, Failure> {
    let host = crate::mariadb::host_of(inst);
    let n = js::number(inst.get("port"));
    let port = if n.fract() == 0.0 && (0.0..=65535.0).contains(&n) {
        n as u16
    } else {
        0
    };
    let password = crate::mariadb::root_password(inst);
    let password = (!password.is_empty()).then_some(password.as_str());
    let reply = crate::resp::send(
        &host,
        port,
        &[vec!["PING".into()]],
        password,
        Duration::from_secs(5),
    )
    .map_err(Failure::user)?;
    Ok(reply == "PONG")
}

/// `newRecord(serverName, inst)`: who uses the key space, not a user of its own.
pub fn new_record(server: &str, inst: &Instance) -> Value {
    json!({
        "database": null,
        "user": null,
        "password": crate::mariadb::root_password(inst),
        "keyPrefix": format!("{server}:"),
        "createdAt": crate::time::iso_now(),
    })
}

/// `encodeURIComponent(s)`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `credentialsFor(inst, record)`.
pub fn credentials_for(inst: &Instance, record: &Value) -> Vec<(String, Value)> {
    let host = crate::mariadb::host_of(inst);
    let pw = match record.get("password") {
        None | Some(Value::Null) => crate::mariadb::root_password(inst),
        v => js::string(v),
    };
    let auth = if pw.is_empty() {
        String::new()
    } else {
        format!(":{}@", encode_uri_component(&pw))
    };
    vec![
        (
            "url".into(),
            json!(format!("redis://{auth}{host}:{}", js::string(inst.get("port")))),
        ),
        (
            "keyPrefix".into(),
            record
                .get("keyPrefix")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null),
        ),
        (
            "note".into(),
            json!(
                "Redis has no per-server databases or users: every server attached here shares this password and key space. Plugins prefix their keys; LuckPerms and most others do it for you."
            ),
        ),
    ]
}

#[cfg(test)]
mod db_tests {
    use super::*;

    #[test]
    fn the_url_carries_the_password_encoded() {
        assert_eq!(
            encode_uri_component("a b/c:d@é!*'()~"),
            "a%20b%2Fc%3Ad%40%C3%A9!*'()~"
        );
        let inst = crate::registry::spread("kv", &json!({ "port": 6380, "root": { "password": "p w" } }));
        let rec = new_record("smp", &inst);
        assert_eq!(rec["keyPrefix"], "smp:");
        let c = credentials_for(&inst, &rec);
        assert_eq!(c[0], ("url".to_string(), json!("redis://:p%20w@127.0.0.1:6380")));
        let open = crate::registry::spread("kv", &json!({ "port": 6380, "root": {} }));
        assert_eq!(
            credentials_for(&open, &json!({}))[0].1,
            json!("redis://127.0.0.1:6380")
        );
    }
}
