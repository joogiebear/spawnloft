//! `mysql.mjs`: managed MySQL from Oracle's pinned native archives, no system service: the
//! archive table, the download and setup, how one is started, and the client conventions it
//! shares with MariaDB.

use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::engines::{InstallLock, OnProgress, Progress, Staging};

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
    // has_engine checked both; a folder changed in between fails as a missing engine, never a panic
    let missing = || Failure::user("The managed MySQL engine is missing or incomplete.");
    let server = mariadb::binary(&dir, "server").ok_or_else(missing)?;
    let admin = mariadb::binary(&dir, "admin").ok_or_else(missing)?;
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

/// `supports()`: Windows x64, a Mac with a pinned archive, Linux on x64.
pub fn supports() -> bool {
    entry_for(crate::platform::node_platform(), crate::platform::node_arch()).is_some()
}

/// `os.release()`'s major number on a Mac (Darwin 24 is macOS 15).
fn darwin_major() -> f64 {
    let out = std::process::Command::new("uname").arg("-r").output();
    let text = out
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    js::string_to_number(text.trim().split('.').next().unwrap_or(""))
}

/// `assertSupported()`.
pub fn assert_supported() -> Result<(), Failure> {
    let (platform, arch) = (crate::platform::node_platform(), crate::platform::node_arch());
    if platform == "linux" && arch != "x64" {
        return Err(Failure::user(
            "Managed MySQL on Linux requires an x64 machine; Oracle publishes no small arm64 build. You can still connect to an existing MySQL database, and managed Redis runs on arm64.",
        ));
    }
    if !supports() {
        return Err(Failure::user(
            "Managed MySQL requires Windows x64, an Apple Silicon or Intel Mac, or Linux on x64.",
        ));
    }
    // `Number(...) < 24` is false for NaN
    if platform == "darwin" && darwin_major() < 24.0 {
        return Err(Failure::user(
            "Managed MySQL requires macOS 15 or later. You can still connect to an existing MySQL database.",
        ));
    }
    Ok(())
}

/// `versions()`: the one pinned release.
pub fn versions() -> Result<Vec<crate::services::Release>, Failure> {
    assert_supported()?;
    Ok(vec![crate::services::Release {
        version: VERSION.into(),
        status: "Stable".into(),
        support: Some("Long Term Support".into()),
        date: None,
    }])
}

fn binary_path(dir: &str, role: &str) -> Result<String, Failure> {
    mariadb::binary(dir, role)
        .map(|b| b.path)
        .ok_or_else(|| Failure::user("The MySQL engine installation is incomplete. Download it again."))
}

/// `fetchEngine(version, { onProgress })`: under a lock file and in a private staging folder, so a
/// failed download never looks installed.
pub fn fetch_engine(layout: &Layout, version: &str, progress: OnProgress) -> Result<(), Failure> {
    assert_supported()?;
    let v = Value::String(version.into());
    let (archive, url) = archive_for(&v)?;
    let dir = engine_dir(layout, &v)?;
    if has_engine(layout, &v) {
        progress(&Progress::say(format!("MySQL {version} is already here")));
        return Ok(());
    }
    let store = Path::new(&layout.engines_dir);
    crate::fsx::mkdir_all(store)?;
    let lock = format!("{dir}.install-lock");
    let Some(_lock) = InstallLock::take(Path::new(&lock))? else {
        return Err(Failure::user(format!(
            "MySQL installation is already in progress. If a previous installation was interrupted, close SpawnLoft and remove {lock}, then retry."
        )));
    };
    if has_engine(layout, &v) {
        return Ok(());
    }
    if Path::new(&dir).exists() {
        return Err(Failure::user(format!(
            "An incomplete MySQL engine exists at {dir}. Move it aside before retrying; no existing files were replaced."
        )));
    }
    let staging = Staging(crate::engines::mkdtemp(&crate::jspath::join(&[
        &layout.engines_dir,
        ".mysql-download-",
    ]))?);
    let file = staging.0.join(archive.file);
    let unpacked = staging.0.join("engine");
    std::fs::create_dir(&unpacked).map_err(|e| Failure::io(&e, "mkdir", Some(&unpacked)))?;
    crate::engines::fetch_pinned(
        &url,
        &file,
        crate::download::Hash::Sha256,
        archive.sha256,
        &format!("Downloading MySQL {version}"),
        progress,
        "MySQL download checksum mismatch. Nothing was installed; please retry.",
        |status| format!("MySQL download failed ({status}). Please retry."),
    )?;
    progress(&Progress::say(format!("Unpacking MySQL {version}")));
    let ok = crate::engines::unpack(&file, &unpacked, true, &staging.0)?;
    let unpacked_s = unpacked.to_string_lossy().into_owned();
    if !ok || !ROLES.iter().all(|r| mariadb::binary(&unpacked_s, r).is_some()) {
        return Err(Failure::user(
            "The MySQL archive did not unpack completely. Please retry.",
        ));
    }
    // before the move into place, or an engine that cannot load its libraries looks installed
    let binaries = vec![
        binary_path(&unpacked_s, "server")?,
        binary_path(&unpacked_s, "client")?,
    ];
    crate::linux_libs::ensure_libraries(&unpacked, &binaries, &mut |m| progress(&Progress::say(m)), LABEL)?;
    let marker = serde_json::json!({
        "version": version,
        "arch": crate::platform::node_arch(),
        "sha256": archive.sha256,
    });
    let marker_file = unpacked.join("spawnloft-engine.json");
    std::fs::write(&marker_file, crate::jsjson::stringify(&marker))
        .map_err(|e| Failure::io(&e, "open", Some(&marker_file)))?;
    std::fs::rename(&unpacked, &dir)
        .map_err(|e| crate::fsx::rename_failure(&e, &unpacked, Path::new(&dir)))?;
    Ok(())
}

/// `iniFor(inst, socket)`: values quoted, loopback only, X protocol off.
pub fn ini_for(layout: &Layout, inst: &Instance, socket: Option<&str>) -> Result<String, Failure> {
    let value = |text: &str| {
        format!(
            "\"{}\"",
            text.replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
        )
    };
    let version = inst.get("version").cloned().unwrap_or(Value::Null);
    let dir = js::string(inst.get("dir"));
    let mut lines = vec![
        "# Managed by SpawnLoft; plugin configs remain manual.".to_string(),
        "[mysqld]".into(),
        format!("basedir={}", value(&engine_dir(layout, &version)?)),
        format!("datadir={}", value(&mariadb::data_dir(inst))),
    ];
    if !cfg!(windows) {
        lines.push(format!("socket={}", value(socket.unwrap_or("null"))));
    }
    lines.push(format!(
        "pid-file={}",
        value(&crate::jspath::join(&[&dir, "mysql.pid"]))
    ));
    lines.extend([
        format!("port={}", js::string(inst.get("port"))),
        "bind-address=127.0.0.1".into(),
        "mysqlx=0".into(),
        "skip-name-resolve".into(),
        "character-set-server=utf8mb4".into(),
        "collation-server=utf8mb4_unicode_ci".into(),
        "max_connections=100".into(),
        "log-error-verbosity=2".into(),
        String::new(),
    ]);
    Ok(lines.join("\n"))
}

/// `execute(cmd, args, { env, timeout })`: the last 32 KiB of each output kept.
fn execute(cmd: &str, args: &[String], env: &Env, timeout_ms: u64) -> Result<String, Failure> {
    let command = crate::procx::command(cmd, args, env, None);
    let done = crate::procx::output_within_capped(command, Duration::from_millis(timeout_ms), Some(32768))
        .map_err(|e| {
            Failure::user(format!(
                "MySQL tool could not start: spawn {cmd} {}",
                crate::jspath::error_code(&e).0
            ))
        })?;
    if done.ok {
        return Ok(String::from_utf8_lossy(&done.stdout).into_owned());
    }
    if done.timed_out {
        return Err(Failure::user("MySQL setup timed out."));
    }
    // the loader's STATUS_DLL_NOT_FOUND
    if cfg!(windows) && matches!(done.code, Some(-1073741515)) {
        return Err(Failure::user(
            "MySQL needs the Microsoft Visual C++ x64 runtime. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, then retry.",
        ));
    }
    let code = done.code.map_or_else(|| "null".to_string(), |c| c.to_string());
    Err(Failure::user(format!(
        "MySQL tool exited {code}: {}",
        js::trim(&String::from_utf8_lossy(&done.stderr))
    )))
}

fn root_password_strict(inst: &Instance) -> Result<String, Failure> {
    match inst.get("root") {
        None | Some(Value::Null) => Err(Failure::type_error(format!(
            "Cannot read properties of {} (reading 'password')",
            if inst.get("root").is_some() {
                "null"
            } else {
                "undefined"
            }
        ))),
        Some(r) => Ok(js::string(r.get("password"))),
    }
}

/// `initData(inst)`: `--initialize` with a temporary root password, then one start with an init
/// file that sets the real one, stopped again through the admin tool over a private channel.
pub fn init_data(layout: &Layout, inst: &Instance) -> Result<(), Failure> {
    assert_supported()?;
    let version = inst.get("version").cloned().unwrap_or(Value::Null);
    let dir = engine_dir(layout, &version)?;
    if !has_engine(layout, &version) {
        return Err(Failure::user(
            "The MySQL engine installation is incomplete. Download it again.",
        ));
    }
    let data = mariadb::data_dir(inst);
    if Path::new(&data).exists() {
        return Err(Failure::user(
            "Refusing to initialize an existing MySQL data directory.",
        ));
    }
    let inst_dir = js::string(inst.get("dir"));
    {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        b.create(&inst_dir)
            .map_err(|e| Failure::io(&e, "mkdir", Some(Path::new(&inst_dir))))?;
    }
    #[cfg(unix)]
    let socket = Some(socket_for(inst)?);
    #[cfg(not(unix))]
    let socket: Option<String> = None;
    let ini = mariadb::ini_file(inst);
    write_private(Path::new(&ini), &ini_for(layout, inst, socket.as_deref())?, false)?;
    let server = binary_path(&dir, "server")?;
    let mut env = Env::new();
    crate::linux_libs::library_env(&server, &mut env);
    execute(
        &server,
        &["--no-defaults".into(), "--version".into()],
        &env,
        180_000,
    )?;
    execute(
        &server,
        &[
            "--no-defaults".into(),
            "--initialize".into(),
            format!("--basedir={dir}"),
            format!("--datadir={data}"),
        ],
        &env,
        180_000,
    )?;
    let password = root_password_strict(inst)?;
    let init_file = crate::jspath::join(&[&inst_dir, "bootstrap.sql"]);
    let quoted = mariadb::quote_str(&password);
    let bootstrap = [
        format!("ALTER USER 'root'@'localhost' IDENTIFIED BY {quoted};"),
        format!("CREATE USER 'root'@'127.0.0.1' IDENTIFIED BY {quoted};"),
        "GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;".into(),
    ]
    .join("\n");
    write_private(Path::new(&init_file), &bootstrap, true)?;
    let result = bootstrap_run(
        &dir,
        &server,
        &ini,
        &init_file,
        &env,
        &password,
        socket.as_deref(),
    );
    let _ = std::fs::remove_file(&init_file);
    result
}

fn write_private(file: &Path, text: &str, exclusive: bool) -> Result<(), Failure> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true);
    if exclusive {
        o.create_new(true);
    } else {
        o.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(file).map_err(|e| Failure::io(&e, "open", Some(file)))?;
    f.write_all(text.as_bytes())
        .map_err(|e| Failure::io(&e, "write", Some(file)))
}

fn bootstrap_run(
    dir: &str,
    server: &str,
    ini: &str,
    init_file: &str,
    env: &Env,
    password: &str,
    socket: Option<&str>,
) -> Result<(), Failure> {
    use std::io::Read;
    let win = cfg!(windows);
    let shared_memory = format!(
        "SpawnLoft-{}",
        crate::lock::random_uuid().map_err(|e| Failure::user(e.to_string()))?
    );
    let mut args = vec![
        format!("--defaults-file={ini}"),
        "--skip-networking".into(),
        format!("--init-file={init_file}"),
    ];
    if win {
        args.extend([
            "--console".into(),
            "--shared-memory".into(),
            format!("--shared-memory-base-name={shared_memory}"),
        ]);
    }
    let mut command = crate::procx::command(server, &args, env, None);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    crate::platform::hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| Failure::user(format!("spawn {server} {}", crate::jspath::error_code(&e).0)))?;
    let mut stderr = child.stderr.take().expect("piped");
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let kill = |child: &mut std::process::Child| {
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    let mut log = String::new();
    loop {
        if crate::patterns::MARIADB_READY.is_match(&log) {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            // what is left in the pipe is part of the reason
            while let Ok(c) = rx.recv_timeout(Duration::from_millis(100)) {
                log.push_str(&String::from_utf8_lossy(&c));
            }
            let code = status
                .code()
                .map_or_else(|| "null".to_string(), |c| c.to_string());
            let tail = tail_chars(&log, 8192);
            return Err(Failure::user(format!(
                "MySQL setup stopped ({code}): {}",
                tail.replace(password, "[redacted]")
            )));
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            kill(&mut child);
            return Err(Failure::user(
                "MySQL setup did not become ready within 60 seconds.",
            ));
        }
        if let Ok(c) = rx.recv_timeout((deadline - now).min(Duration::from_millis(100))) {
            log.push_str(&String::from_utf8_lossy(&c));
            log = tail_chars(&log, 8192);
        }
    }
    let admin = match binary_path(dir, "admin") {
        Ok(a) => a,
        Err(f) => {
            kill(&mut child);
            return Err(f);
        }
    };
    let mut admin_args = vec!["--no-defaults".to_string()];
    if win {
        admin_args.extend([
            "--protocol=MEMORY".into(),
            format!("--shared-memory-base-name={shared_memory}"),
        ]);
    } else {
        admin_args.extend([
            "--protocol=SOCKET".into(),
            format!("--socket={}", socket.unwrap_or("null")),
        ]);
    }
    admin_args.extend(["--user=root".into(), "shutdown".into()]);
    let mut admin_env = env.clone();
    crate::daemon_launch::set_env(&mut admin_env, "MYSQL_PWD", password.to_string());
    if let Err(f) = execute(&admin, &admin_args, &admin_env, 30_000) {
        kill(&mut child);
        return Err(f);
    }
    let status = child.wait().ok();
    if status.and_then(|s| s.code()) != Some(0) {
        return Err(Failure::user("MySQL did not finish setup cleanly."));
    }
    Ok(())
}

/// `.slice(-n)` of a string, in UTF-16 units as JavaScript counts.
fn tail_chars(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= n {
        return s.to_string();
    }
    String::from_utf16_lossy(&units[units.len() - n..])
}

/// `withTools(inst)`: a managed instance uses its own engine's tools; an external one keeps
/// normal discovery or the user's folder.
pub fn with_tools(layout: &Layout, inst: &Instance) -> Result<Instance, Failure> {
    if js::truthy(inst.get("external")) {
        return Ok(inst.clone());
    }
    let version = inst.get("version").cloned().unwrap_or(Value::Null);
    let mut out = inst.clone();
    out.fields.insert("external".into(), Value::Bool(true));
    out.fields.insert(
        "tools".into(),
        serde_json::json!({ "dir": engine_dir(layout, &version)? }),
    );
    Ok(out)
}
