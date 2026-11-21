//! `mysql.mjs`: managed MySQL from Oracle's pinned native archives, no system service. C2 part 1
//! has the archive table, the engine store and how one is started; the download and setup come
//! with the `db` command.

use serde_json::Value;
#[cfg(unix)]
use std::path::Path;

use crate::daemon_launch::{Env, LaunchSpec, StopSpec};
use crate::failure::Failure;
use crate::js;
use crate::mariadb;
use crate::registry::Instance;
use crate::settings::Layout;

pub const ENGINE: &str = "mysql";
pub const LABEL: &str = "MySQL";
pub const KIND: &str = "mariadb";
pub const DEFAULT_PORT: u16 = 3306;
pub const VERSION: &str = "8.4.11";

/// A pinned archive: its file name and SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Archive {
    pub file: &'static str,
    pub sha256: &'static str,
}

const MAC_ARM64: Archive = Archive {
    file: "mysql-8.4.11-macos15-arm64.tar.gz",
    sha256: "b96e00493bc3499b9ffd7f08d65c5d64933af0383a8287d9873b64f94c2d6009",
};
const MAC_X64: Archive = Archive {
    file: "mysql-8.4.11-macos15-x86_64.tar.gz",
    sha256: "90e8aea10698d01b978f0179e72e8d5e2cbe9f9bd5771e88b0b75d7c82244d3f",
};
pub const WINDOWS_ARCHIVE: Archive = Archive {
    file: "mysql-8.4.11-winx64.zip",
    sha256: "a492371d687d2bab088b0062581144a0044b8964baefdf4faa579292b423d25c",
};
const LINUX_X64: Archive = Archive {
    file: "mysql-8.4.11-linux-glibc2.28-x86_64-minimal.tar.xz",
    sha256: "383f54e124d5f325d67f0c6912a8f96814eedc761a17ea30112e52fa4cc6b143",
};

fn entry_for(platform: &str, arch: &str) -> Option<Archive> {
    match (platform, arch) {
        ("win32", "x64") => Some(WINDOWS_ARCHIVE),
        ("darwin", "arm64") => Some(MAC_ARM64),
        ("darwin", "x64") => Some(MAC_X64),
        ("linux", "x64") => Some(LINUX_X64),
        _ => None,
    }
}

/// `archiveFor(version)`: the pinned archive for this machine, with its download URL.
pub fn archive_for(version: &Value) -> Result<(Archive, String), Failure> {
    let (platform, arch) = (crate::platform::node_platform(), crate::platform::node_arch());
    match entry_for(platform, arch) {
        Some(a) if version.as_str() == Some(VERSION) => {
            Ok((a, format!("https://cdn.mysql.com/Downloads/MySQL-8.4/{}", a.file)))
        }
        _ => Err(Failure::user(format!(
            "No verified MySQL {} archive for {platform}/{arch}. See: spawnloft db versions",
            js::string(Some(version))
        ))),
    }
}

/// `engineDir(version)`.
pub fn engine_dir(layout: &Layout, version: &Value) -> Result<String, Failure> {
    archive_for(version)?;
    Ok(crate::jspath::join(&[
        &layout.engines_dir,
        &format!(
            "mysql-{}-{}-{}",
            js::string(Some(version)),
            crate::platform::node_platform(),
            crate::platform::node_arch()
        ),
    ]))
}

const ROLES: [&str; 4] = ["server", "admin", "client", "dump"];

/// `hasEngine(version)`: the marker names the pinned archive and every tool is there.
pub fn has_engine(layout: &Layout, version: &Value) -> bool {
    let (Ok(dir), Ok((archive, _))) = (engine_dir(layout, version), archive_for(version)) else {
        return false;
    };
    let Ok(text) = std::fs::read(crate::jspath::join_path(&dir, &["spawnloft-engine.json"])) else {
        return false;
    };
    let Ok(marker) = crate::jsjson::parse(&String::from_utf8_lossy(&text)) else {
        return false;
    };
    // `marker.sha256` of a null marker throws, which the try turns into false
    marker.get("sha256").and_then(Value::as_str) == Some(archive.sha256)
        && ROLES.iter().all(|r| mariadb::binary(&dir, r).is_some())
}

/// `socketFor(inst)`: a short path under `/tmp/spawnloft-mysql-<uid>`, a folder this user alone
/// owns, so data folders with spaces or past the socket path limit still work.
#[cfg(unix)]
pub fn socket_for(inst: &Instance) -> Result<String, Failure> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let uid = crate::platform::uid();
    let base = format!("/tmp/spawnloft-mysql-{uid}");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)
        .map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&base))))?;
    let meta =
        std::fs::symlink_metadata(&base).map_err(|e| Failure::io(&e, "lstat", Some(Path::new(&base))))?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.uid() != uid {
        return Err(Failure::user(format!("Cannot use MySQL socket directory {base}")));
    }
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| Failure::io(&e, "chmod", Some(Path::new(&base))))?;
    let resolved = crate::jspath::resolve(&js::string(inst.get("dir")));
    let hash = crate::sha256::hex(resolved.as_bytes());
    Ok(crate::jspath::join(&[&base, &format!("{}.sock", &hash[..20])]))
}

/// `launchSpec(inst)`.
pub fn launch_spec(layout: &Layout, inst: &Instance) -> Result<LaunchSpec, Failure> {
    let version = inst.get("version").cloned().unwrap_or(Value::Null);
    let dir = engine_dir(layout, &version)?;
    if !has_engine(layout, &version) {
        return Err(Failure::user(
            "The managed MySQL engine is missing or incomplete.",
        ));
    }
    #[cfg(unix)]
    socket_for(inst)?;
    let server = mariadb::binary(&dir, "server").expect("checked by has_engine");
    let admin = mariadb::binary(&dir, "admin").expect("checked by has_engine");
    let mut env = Env::new();
    crate::linux_libs::library_env(&server.path, &mut env);
    let mut args = vec![format!("--defaults-file={}", mariadb::ini_file(inst))];
    if cfg!(windows) {
        args.push("--console".into());
    }
    // `inst.root.password`: a record with no root fails as JavaScript does
    let password = match inst.get("root") {
        None | Some(Value::Null) => {
            return Err(Failure::type_error(format!(
                "Cannot read properties of {} (reading 'password')",
                if inst.get("root").is_some() {
                    "null"
                } else {
                    "undefined"
                }
            )));
        }
        Some(r) => js::string(r.get("password")),
    };
    let mut stop_env = env.clone();
    crate::daemon_launch::set_env(&mut stop_env, "MYSQL_PWD", password);
    Ok(LaunchSpec {
        cmd: server.path,
        args,
        env,
        cwd: js::string(inst.get("dir")),
        stop: StopSpec::Command {
            cmd: admin.path,
            args: vec![
                "--no-defaults".into(),
                "--protocol=TCP".into(),
                "--host=127.0.0.1".into(),
                format!("--port={}", js::string(inst.get("port"))),
                "--user=root".into(),
                "shutdown".into(),
            ],
            env: stop_env,
        },
    })
}
