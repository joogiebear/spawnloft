//! `linux-libs.mjs`: the shared libraries a downloaded Linux engine expects the system to have.
//! Oracle's MySQL tarball needs libaio, libnuma and ncurses and says nothing when they are
//! missing; mysqld just exits with a loader error. Tried cheapest first, and the engine is
//! installed only if one works: already present; present under Debian's t64 name, fixed with a
//! link in the engine's own folder; or fetched with `apt-get download` / `dnf download` (no
//! root) and unpacked beside the engine. Failing all three, the refusal names the command that
//! fixes it.

use std::path::Path;

use crate::failure::Failure;

pub const LIBS_FOLDER: &str = "spawnloft-libs";

/// `libsDirFor(binaryPath)`: beside the folder that holds the binary's `bin/`.
pub fn libs_dir_for(binary_path: &str) -> String {
    let bin_dir = crate::jspath::dirname(binary_path);
    let root = crate::jspath::dirname(&bin_dir);
    crate::jspath::join(&[&root, LIBS_FOLDER])
}

/// `libraryEnv(binaryPath, env)` as overrides on top of `env`: on Linux, when the engine carries
/// its own libraries, they go first on `LD_LIBRARY_PATH`.
pub fn library_env(binary_path: &str, env: &mut Vec<(String, String)>) {
    if !cfg!(target_os = "linux") {
        return;
    }
    let dir = libs_dir_for(binary_path);
    if !Path::new(&dir).exists() {
        return;
    }
    let current = crate::daemon_launch::env_value(env, "LD_LIBRARY_PATH");
    let value = match current.filter(|v| !v.is_empty()) {
        Some(v) => format!("{dir}:{v}"),
        None => dir,
    };
    crate::daemon_launch::set_env(env, "LD_LIBRARY_PATH", value);
}

/// `parseLdd(text)`: the names ldd reports as not found, first appearance first.
pub fn parse_ldd(text: &str) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let mut words = line.split_whitespace();
        let (Some(name), Some("=>"), Some("not"), Some(found)) =
            (words.next(), words.next(), words.next(), words.next())
        else {
            continue;
        };
        if found.starts_with("found") && !missing.iter().any(|m| m == name) {
            missing.push(name.to_string());
        }
    }
    missing
}

/// `parseLdconfig(text)`: `ldconfig -p`'s name to path, the first line for a name winning.
pub fn parse_ldconfig(text: &str) -> Vec<(String, String)> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^\s*(\S+)\s+\([^)]*\)\s+=>\s+(\S+)").expect("valid"));
    let mut found: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        if let Some(c) = RE.captures(line)
            && !found.iter().any(|(n, _)| n == &c[1])
        {
            found.push((c[1].to_string(), c[2].to_string()));
        }
    }
    found
}

/// One library's package in each family: apt's names are tried in order.
#[derive(Debug)]
pub struct Package {
    pub apt: &'static [&'static str],
    pub dnf: &'static str,
    pub pacman: &'static str,
    pub zypper: &'static str,
}

/// `PACKAGES[name]`.
pub fn package(name: &str) -> Option<Package> {
    Some(match name {
        "libaio.so.1" => Package {
            apt: &["libaio1t64", "libaio1"],
            dnf: "libaio",
            pacman: "libaio",
            zypper: "libaio1",
        },
        "libnuma.so.1" => Package {
            apt: &["libnuma1"],
            dnf: "numactl-libs",
            pacman: "numactl",
            zypper: "libnuma1",
        },
        "libncurses.so.6" => Package {
            apt: &["libncurses6"],
            dnf: "ncurses-libs",
            pacman: "ncurses",
            zypper: "libncurses6",
        },
        "libtinfo.so.6" => Package {
            apt: &["libtinfo6"],
            dnf: "ncurses-libs",
            pacman: "ncurses",
            zypper: "libtinfo6",
        },
        _ => return None,
    })
}

/// `packageFamily(osRelease)`: from the `ID` and `ID_LIKE` lines.
pub fn package_family(os_release: &str) -> Option<&'static str> {
    let mut ids: Vec<String> = Vec::new();
    // `^...$` with the m flag: any line terminator ends a line
    for line in os_release.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
        let value = line.strip_prefix("ID=").or_else(|| line.strip_prefix("ID_LIKE="));
        if let Some(v) = value {
            ids.extend(
                v.replace('"', "")
                    .split(crate::js::is_js_space)
                    .map(str::to_string),
            );
        }
    }
    let any = |names: &[&str]| ids.iter().any(|id| names.contains(&id.as_str()));
    if any(&["debian", "ubuntu"]) {
        Some("apt")
    } else if any(&["fedora", "rhel", "centos"]) {
        Some("dnf")
    } else if any(&["arch"]) {
        Some("pacman")
    } else if any(&["suse", "opensuse"]) {
        Some("zypper")
    } else {
        None
    }
}

/// `installHint(missing, family, engineLabel)`.
pub fn install_hint(missing: &[String], family: Option<&str>, engine_label: &str) -> String {
    let names = missing.join(", ");
    let mut packages: Vec<&str> = Vec::new();
    for name in missing {
        let Some(p) = package(name) else { continue };
        let entry = match family {
            Some("apt") => p.apt.first().copied(),
            Some("dnf") => Some(p.dnf),
            Some("pacman") => Some(p.pacman),
            Some("zypper") => Some(p.zypper),
            _ => None,
        };
        if let Some(e) = entry
            && !packages.contains(&e)
        {
            packages.push(e);
        }
    }
    let command = match family {
        Some("apt") => Some("sudo apt install"),
        Some("dnf") => Some("sudo dnf install"),
        Some("pacman") => Some("sudo pacman -S"),
        Some("zypper") => Some("sudo zypper install"),
        _ => None,
    };
    match command {
        Some(c) if !packages.is_empty() => format!(
            "{engine_label} needs system libraries this machine does not have: {names}. Install them with: {c} {} - then retry.",
            packages.join(" ")
        ),
        _ => format!(
            "{engine_label} needs system libraries this machine does not have: {names}. Install them with your package manager, then retry."
        ),
    }
}

/// `dnfPackagesFor(missing)`: one package can supply several libraries.
pub fn dnf_packages_for(missing: &[String]) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for name in missing {
        if let Some(p) = package(name)
            && !out.contains(&p.dnf)
        {
            out.push(p.dnf);
        }
    }
    out
}

/// `RPM_ARCH[process.arch]`.
pub fn rpm_arch(arch: &str) -> Option<&'static str> {
    match arch {
        "x64" => Some("x86_64"),
        "arm64" => Some("aarch64"),
        _ => None,
    }
}

/// `isMusl()`: ldd names musl, or (when ldd says nothing of glibc) a musl loader is in /lib.
pub fn is_musl_from(ldd_output: Option<&str>, exists: impl Fn(&str) -> bool) -> bool {
    if let Some(said) = ldd_output {
        let lower = said.to_lowercase();
        if lower.contains("musl") {
            return true;
        }
        if lower.contains("glibc") || lower.contains("gnu libc") || lower.contains("gnu c library") {
            return false;
        }
    }
    [
        "ld-musl-x86_64.so.1",
        "ld-musl-aarch64.so.1",
        "ld-musl-armhf.so.1",
    ]
    .iter()
    .any(|f| exists(&format!("/lib/{f}")))
}

#[cfg(target_os = "linux")]
mod system {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// `spawnSync(cmd, args, { timeout })`: stdout and whether it ran and exited 0; `None` when
    /// it could not start.
    pub(super) fn run(
        cmd: &str,
        args: &[&str],
        cwd: Option<&Path>,
        c_locale: bool,
        timeout_ms: u64,
    ) -> Option<(bool, String, String)> {
        let mut c = Command::new(cmd);
        c.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        if c_locale {
            c.env("LC_ALL", "C");
        }
        let out = crate::procx::output_within(c, Duration::from_millis(timeout_ms)).ok()?;
        Some((
            out.ok,
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ))
    }

    pub(super) fn is_musl() -> bool {
        let said = run("ldd", &["--version"], None, false, 5000).map(|(_, o, e)| format!("{o}\n{e}"));
        is_musl_from(said.as_deref(), |p| Path::new(p).exists())
    }

    /// `missingLibraries(binaries, env)`: `None` when there is no ldd to ask.
    pub(super) fn missing_libraries(binaries: &[String]) -> Option<Vec<String>> {
        let mut missing: Vec<String> = Vec::new();
        for file in binaries {
            let mut c = Command::new("ldd");
            c.arg(file)
                .env("LC_ALL", "C")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut env = Vec::new();
            library_env(&binaries[0], &mut env);
            for (k, v) in env {
                c.env(k, v);
            }
            let out = crate::procx::output_within(c, Duration::from_secs(15)).ok()?;
            for name in parse_ldd(&String::from_utf8_lossy(&out.stdout)) {
                if !missing.contains(&name) {
                    missing.push(name);
                }
            }
        }
        Some(missing)
    }

    fn link_renamed(missing: &[String], libs: &Path) {
        let text = match run("ldconfig", &["-p"], None, true, 15000) {
            Some((_, out, _)) => out,
            // ldconfig lives in /sbin, which a user's PATH may not include
            None => run("/sbin/ldconfig", &["-p"], None, false, 15000)
                .map(|(_, o, _)| o)
                .unwrap_or_default(),
        };
        let system = parse_ldconfig(&text);
        for name in missing {
            let want = format!("{name}t64");
            if let Some((_, path)) = system.iter().find(|(n, _)| n == &want) {
                let _ = std::os::unix::fs::symlink(path, libs.join(name));
            }
        }
    }

    fn work_dir() -> Option<std::path::PathBuf> {
        let base = std::env::temp_dir();
        for _ in 0..16 {
            let mut b = [0u8; 6];
            getrandom::fill(&mut b).ok()?;
            let suffix: String = b.iter().map(|x| format!("{x:02x}")).collect();
            let p = base.join(format!("spawnloft-libs-{}", &suffix[..6]));
            if std::fs::create_dir(&p).is_ok() {
                return Some(p);
            }
        }
        None
    }

    /// `copyLibraries(from, to)`: links kept as links so the sonames still resolve.
    fn copy_libraries(from: &Path, to: &Path) {
        let Ok(names) = crate::fsx::readdir_names(from) else {
            return;
        };
        for name in names {
            let source = from.join(&name);
            let Ok(meta) = std::fs::symlink_metadata(&source) else {
                continue;
            };
            if meta.is_dir() {
                copy_libraries(&source, to);
                continue;
            }
            if !(name.contains(".so.") || name.ends_with(".so")) {
                continue;
            }
            let target = to.join(&name);
            let _ = std::fs::remove_file(&target);
            if meta.file_type().is_symlink() {
                if let Ok(link) = std::fs::read_link(&source) {
                    let _ = std::os::unix::fs::symlink(link, &target);
                }
            } else {
                let _ = std::fs::copy(&source, &target);
            }
        }
    }

    fn fetch_with_apt(missing: &[String], libs: &Path, progress: &mut dyn FnMut(&str)) {
        let Some(work) = work_dir() else { return };
        for name in missing {
            for pkg in package(name).map(|p| p.apt).unwrap_or_default() {
                progress(&format!("Fetching {pkg} from your distribution"));
                match run("apt-get", &["download", pkg], Some(&work), false, 120_000) {
                    Some((true, _, _)) => {}
                    _ => continue,
                }
                let deb = crate::fsx::readdir_names(&work)
                    .unwrap_or_default()
                    .into_iter()
                    .find(|f| f.starts_with(&format!("{pkg}_")) && f.ends_with(".deb"));
                let Some(deb) = deb else { continue };
                let out = work.join(format!("x-{pkg}"));
                let deb_path = work.join(&deb).to_string_lossy().into_owned();
                let out_path = out.to_string_lossy().into_owned();
                match run("dpkg-deb", &["-x", &deb_path, &out_path], None, false, 60_000) {
                    Some((true, _, _)) => {}
                    _ => continue,
                }
                copy_libraries(&out, libs);
                break;
            }
            // the package that supplies libaio.so.1 on a t64 system supplies it as libaio.so.1t64
            let target = libs.join(name);
            let renamed = libs.join(format!("{name}t64"));
            if !target.exists() && renamed.exists() {
                let _ = std::os::unix::fs::symlink(format!("{name}t64"), &target);
            }
        }
        let _ = std::fs::remove_dir_all(&work);
    }

    fn fetch_with_dnf(missing: &[String], libs: &Path, progress: &mut dyn FnMut(&str)) {
        let Some(work) = work_dir() else { return };
        for pkg in dnf_packages_for(missing) {
            progress(&format!("Fetching {pkg} from your distribution"));
            let dest = work.join(pkg);
            if std::fs::create_dir(&dest).is_err() {
                continue;
            }
            let dest_s = dest.to_string_lossy().into_owned();
            let mut args = vec!["download", "--destdir", &dest_s];
            if let Some(a) = rpm_arch(crate::platform::node_arch()) {
                args.extend(["--arch", a]);
            }
            args.push(pkg);
            match run("dnf", &args, Some(&dest), true, 180_000) {
                Some((true, _, _)) => {}
                _ => continue,
            }
            let rpm = crate::fsx::readdir_names(&dest)
                .unwrap_or_default()
                .into_iter()
                .find(|f| f.starts_with(&format!("{pkg}-")) && f.ends_with(".rpm"));
            let Some(rpm) = rpm else { continue };
            let out = work.join(format!("x-{pkg}"));
            if std::fs::create_dir(&out).is_err() {
                continue;
            }
            let file = dest.join(&rpm).to_string_lossy().into_owned();
            let unpacked = matches!(
                run(
                    "sh",
                    &["-c", "rpm2cpio \"$1\" | cpio -idm --quiet", "sh", &file],
                    Some(&out),
                    false,
                    60_000
                ),
                Some((true, _, _))
            );
            if !unpacked {
                let _ = run("bsdtar", &["-xf", &file], Some(&out), false, 60_000);
            }
            copy_libraries(&out, libs);
        }
        let _ = std::fs::remove_dir_all(&work);
    }

    pub(super) fn ensure(
        engine_root: &Path,
        binaries: &[String],
        progress: &mut dyn FnMut(&str),
        engine_label: &str,
        allow_fetch: bool,
    ) -> Result<Vec<String>, Failure> {
        if is_musl() {
            return Err(Failure::user(format!(
                "{engine_label} needs glibc, which this system's C library (musl, as on Alpine Linux) does not provide. No package install fixes this - run SpawnLoft on a glibc-based distribution (Debian, Ubuntu, Fedora, and most others) instead."
            )));
        }
        let libs = engine_root.join(LIBS_FOLDER);
        let check = || missing_libraries(binaries);
        let mut missing = match check() {
            None => return Ok(Vec::new()),
            Some(m) if m.is_empty() => return Ok(Vec::new()),
            Some(m) => m,
        };
        let wanted = missing.clone();
        progress(&format!("Checking the system libraries {engine_label} needs"));
        std::fs::create_dir_all(&libs).map_err(|e| Failure::io(&e, "mkdir", Some(&libs)))?;
        link_renamed(&missing, &libs);
        missing = check().unwrap_or_default();
        let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let family = package_family(&os_release);
        if !missing.is_empty() && allow_fetch {
            match family {
                Some("apt") => fetch_with_apt(&missing, &libs, progress),
                Some("dnf") => fetch_with_dnf(&missing, &libs, progress),
                _ => {}
            }
            if matches!(family, Some("apt" | "dnf")) {
                missing = check().unwrap_or_default();
            }
        }
        if !missing.is_empty() {
            let _ = std::fs::remove_dir_all(&libs);
            return Err(Failure::user(install_hint(&missing, family, engine_label)));
        }
        Ok(wanted)
    }
}

/// `ensureLibraries(engineRoot, binaries, { onProgress, engineLabel })`: makes everything these
/// binaries load loadable, or refuses with a reason; returns the libraries it supplied. Called
/// before an engine is moved into place, so one that cannot run never looks installed.
pub fn ensure_libraries(
    engine_root: &Path,
    binaries: &[String],
    progress: &mut dyn FnMut(&str),
    engine_label: &str,
) -> Result<Vec<String>, Failure> {
    #[cfg(target_os = "linux")]
    {
        system::ensure(engine_root, binaries, progress, engine_label, true)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (engine_root, binaries, progress, engine_label);
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_libs_folder_is_beside_bin() {
        // path.join's separator: a backslash on Windows, as in Node
        let want = if cfg!(windows) {
            format!("\\e\\mysql-8\\{LIBS_FOLDER}")
        } else {
            format!("/e/mysql-8/{LIBS_FOLDER}")
        };
        assert_eq!(libs_dir_for("/e/mysql-8/bin/mysqld"), want);
    }

    #[test]
    fn ldd_and_ldconfig_are_read_as_linux_libs_mjs_reads_them() {
        let ldd = "\tlinux-vdso.so.1 (0x00007ffd)\n\tlibaio.so.1 => not found\n\tlibnuma.so.1 => not found\n\tlibaio.so.1 => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x7f)\n";
        assert_eq!(parse_ldd(ldd), ["libaio.so.1", "libnuma.so.1"]);
        let ldc = "1234 libs found in cache `/etc/ld.so.cache'\n\tlibaio.so.1t64 (libc6,x86-64) => /lib/x86_64-linux-gnu/libaio.so.1t64\n\tlibaio.so.1t64 (libc6) => /lib32/libaio.so.1t64\n";
        assert_eq!(
            parse_ldconfig(ldc),
            [(
                "libaio.so.1t64".to_string(),
                "/lib/x86_64-linux-gnu/libaio.so.1t64".to_string()
            )]
        );
    }

    #[test]
    fn hints_name_the_family_command() {
        assert_eq!(
            package_family("NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"),
            Some("apt")
        );
        assert_eq!(
            package_family("ID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n"),
            Some("dnf")
        );
        assert_eq!(package_family("ID=alpine\n"), None);
        let m = vec![
            "libaio.so.1".to_string(),
            "libncurses.so.6".to_string(),
            "libtinfo.so.6".to_string(),
        ];
        assert_eq!(
            install_hint(&m, Some("dnf"), "MySQL"),
            "MySQL needs system libraries this machine does not have: libaio.so.1, libncurses.so.6, libtinfo.so.6. Install them with: sudo dnf install libaio ncurses-libs - then retry."
        );
        assert_eq!(
            install_hint(&m[..1], Some("apt"), "MySQL"),
            "MySQL needs system libraries this machine does not have: libaio.so.1. Install them with: sudo apt install libaio1t64 - then retry."
        );
        assert!(
            install_hint(&m, None, "MySQL").ends_with("Install them with your package manager, then retry.")
        );
        assert_eq!(dnf_packages_for(&m), ["libaio", "ncurses-libs"]);
    }

    #[test]
    fn musl_is_told_by_ldd_first() {
        assert!(is_musl_from(Some("musl libc (x86_64)\nVersion 1.2.4"), |_| false));
        assert!(!is_musl_from(Some("ldd (GNU libc) 2.39"), |_| true));
        assert!(is_musl_from(None, |p| p == "/lib/ld-musl-x86_64.so.1"));
        assert!(!is_musl_from(Some("weird"), |_| false));
    }
}
