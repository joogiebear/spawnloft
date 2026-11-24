//! `panel-open.mjs`: how `spawnloft ui` hands a browser its one-use sign-in link
//! (rust/PANEL-AUTH-DESIGN.md 3.7).
//!
//! The link is never put on a command line: on Linux and macOS every account can read other
//! processes' arguments, and a link read there works for whoever uses it first. It goes in a
//! small page in `<config>/open/` instead (a private folder, never the data root, which may be
//! shared), and the browser is pointed at that file. The page sends the browser on to the link.
//!
//! Each file is named after its link's nonce, hashed, so the panel that takes the link can delete
//! the file it came from. Anything older than a link lives is deleted by the next writer and by
//! every panel start, so a file that was never opened does not outlive its (by then dead) link.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::panel_auth::{FUTURE_LEEWAY_MS, LOGIN_TTL_MS};

const MAX_AGE_MS: u64 = LOGIN_TTL_MS + FUTURE_LEEWAY_MS;

/// `<config>/open`.
pub fn open_dir() -> PathBuf {
    crate::paths::config_dir().join("open")
}

/// The page's name for the link with this nonce: nothing of the token shows in it.
pub fn open_file_name(nonce: &str) -> String {
    let hex = crate::sha256::hex(format!("open.v1.{nonce}").as_bytes());
    format!("{}.html", &hex[..32])
}

/// Only names this module makes: 32 lowercase hex digits and `.html`.
fn is_ours(name: &str) -> bool {
    name.strip_suffix(".html").is_some_and(|stem| {
        stem.len() == 32
            && stem
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// The folder, made private, and checked to be this user's own folder before anything goes in.
fn ensure_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| crate::jspath::node_error(&e, "mkdir", Some(dir)))?;
        // not followed: a link to a folder elsewhere is not this folder
        let stat =
            std::fs::symlink_metadata(dir).map_err(|e| crate::jspath::node_error(&e, "lstat", Some(dir)))?;
        if !stat.file_type().is_dir() {
            return Err(format!(
                "{} is not a folder; delete it and try again",
                dir.display()
            ));
        }
        if stat.uid() != crate::platform::uid() {
            return Err(format!(
                "{} belongs to another account; delete it and try again",
                dir.display()
            ));
        }
        if stat.mode() & 0o077 != 0 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| crate::jspath::node_error(&e, "chmod", Some(dir)))?;
        }
    }
    #[cfg(not(unix))]
    {
        // APPDATA is the user's own already
        std::fs::create_dir_all(dir).map_err(|e| crate::jspath::node_error(&e, "mkdir", Some(dir)))?;
    }
    Ok(())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Deletes the pages whose links are dead. Only names this module makes are touched.
pub fn sweep_open_files() {
    sweep_in(&open_dir(), now_ms());
}

fn sweep_in(dir: &Path, now: f64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(is_ours) {
            continue;
        }
        let file = dir.join(&name);
        // gone already, or not ours to delete: either way nothing to do
        let Ok(stat) = std::fs::symlink_metadata(&file) else {
            continue;
        };
        let modified = stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if now - modified > MAX_AGE_MS as f64 {
            let _ = std::fs::remove_file(&file);
        }
    }
}

/// The panel took the link with this nonce: the page that carried it has done its job.
pub fn remove_open_file(nonce: &str) {
    remove_in(&open_dir(), nonce);
}

fn remove_in(dir: &Path, nonce: &str) {
    let good = nonce.len() == 22
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if good {
        let _ = std::fs::remove_file(dir.join(open_file_name(nonce)));
    }
}

/// `&`, `<`, `>`, `"` and `'` as numeric references.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => out.push_str(&format!("&#{};", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// No script: a refresh and a link, so it works with scripts off and says what it is if it stays.
pub fn open_page(url: &str) -> String {
    let href = escape(url);
    let mut page = crate::panel_auth::styled_page(
        "Opening SpawnLoft",
        &format!(
            "<p>If nothing happens, <a class=\"go\" href=\"{href}\">Continue to SpawnLoft</a></p>\
             <p class=\"small\">This link signs one browser in, once, within five minutes.</p>"
        ),
        &format!(
            "<meta name=\"referrer\" content=\"no-referrer\"><meta http-equiv=\"refresh\" content=\"0; url={href}\">"
        ),
    );
    page.push('\n');
    page
}

/// Writes the page for `url` (a login link whose nonce is `nonce`) and returns its path. The
/// file is created exclusively and private before the link goes in.
pub fn write_open_file(url: &str, nonce: &str) -> Result<PathBuf, String> {
    write_in(&open_dir(), url, nonce)
}

fn write_in(dir: &Path, url: &str, nonce: &str) -> Result<PathBuf, String> {
    ensure_dir(dir)?;
    sweep_in(dir, now_ms());
    let file = dir.join(open_file_name(nonce));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options
        .open(&file)
        .map_err(|e| crate::jspath::node_error(&e, "open", Some(&file)))?;
    let written = (|| -> Result<(), String> {
        crate::private_files::protect(&file, 0o600)
            .map_err(|reason| format!("could not make {} private: {reason}", file.display()))?;
        f.write_all(open_page(url).as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| crate::jspath::node_error(&e, "write", None))
    })();
    drop(f);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&file);
        return Err(e);
    }
    Ok(file)
}

/// The system's own program that opens a file in the browser. Only the file's path is passed,
/// never the link.
pub fn system_opener(system_root: Option<&str>) -> String {
    if cfg!(windows) {
        // explorer, not `cmd /c start`: a path goes to it as one argument, with no shell to parse it
        let root = system_root.filter(|r| !r.is_empty()).unwrap_or("C:\\Windows");
        format!("{}\\explorer.exe", root.trim_end_matches('\\'))
    } else if cfg!(target_os = "macos") {
        "open".into()
    } else {
        "xdg-open".into()
    }
}

/// `BROWSER` when it is set, else the system's opener. `BROWSER` is taken as one program, run
/// with the file as its only argument; a value holding a list or arguments is not ours to parse,
/// and when it cannot be run the system's opener is used instead.
pub fn opener(browser: Option<&str>, system_root: Option<&str>) -> String {
    match browser.map(crate::js::trim).filter(|b| !b.is_empty()) {
        Some(chosen) => chosen.to_string(),
        None => system_opener(system_root),
    }
}

/// Whether there is a browser here to open at all: a Linux or BSD machine reached over SSH has
/// no display, and opening there would only claim to. `BROWSER` set says there is one.
pub fn can_open() -> bool {
    let set = |k: &str| std::env::var(k).is_ok_and(|v| !v.is_empty());
    if std::env::var("BROWSER").is_ok_and(|v| !crate::js::trim(&v).is_empty()) {
        return true;
    }
    cfg!(windows) || cfg!(target_os = "macos") || set("DISPLAY") || set("WAYLAND_DISPLAY")
}

fn start(program: &str, file: &Path) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // on its own, so it outlives this command and its terminal
    #[cfg(unix)]
    crate::platform::detach(&mut cmd);
    cmd.spawn().is_ok()
}

/// Opens the page in the browser. Never fails: with no browser the link is printed anyway.
pub fn open_in_browser(file: &Path) {
    let root = std::env::var("SystemRoot").ok();
    let browser = std::env::var("BROWSER").ok();
    let first = opener(browser.as_deref(), root.as_deref());
    let fallback = system_opener(root.as_deref());
    if !start(&first, file) && first != fallback {
        start(&fallback, file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce(c: char) -> String {
        c.to_string().repeat(22)
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sl-panel-open-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_page_is_private_named_after_its_nonce_and_has_no_script() {
        let root = scratch("page");
        let dir = root.join("open");
        let url = format!(
            "http://127.0.0.1:8770/auth?t=v1.login.8770.1.{}.x&to=/launcher",
            nonce('A')
        );
        let file = write_in(&dir, &url, &nonce('A')).unwrap();
        assert_eq!(file.parent().unwrap(), dir);
        let name = file.file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(name, open_file_name(&nonce('A')));
        assert!(is_ours(&name));
        // the name gives nothing of the token away
        assert!(!name.contains(&nonce('A')));
        // what Node's sha256 of "open.v1.AAAAAAAAAAAAAAAAAAAAAA" starts with
        assert_eq!(name, "543c367fe86d5e4efe8e3e94aa9219b5.html");
        let html = std::fs::read_to_string(&file).unwrap();
        assert!(!html.to_lowercase().contains("<script"));
        assert!(html.contains(&format!(
            "<meta http-equiv=\"refresh\" content=\"0; url=http://127.0.0.1:8770/auth?t=v1.login.8770.1.{}.x&#38;to=/launcher\">",
            nonce('A')
        )));
        assert!(html.contains("<meta name=\"referrer\" content=\"no-referrer\">"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        // made exclusively: the same name twice is refused, not overwritten
        assert!(write_in(&dir, &url, &nonce('A')).unwrap_err().contains("EEXIST"));
        remove_in(&dir, &nonce('A'));
        assert!(!file.exists());
        // a nonce of another shape names nothing to remove
        remove_in(&dir, "../../x");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_loose_folder_is_put_right_and_a_link_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("loose");
        let dir = root.join("open");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_in(&dir, "http://127.0.0.1:1/auth?t=x", &nonce('B')).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), &dir).unwrap();
        let refused = write_in(&dir, "http://127.0.0.1:1/auth?t=x", &nonce('C')).unwrap_err();
        assert!(refused.contains("is not a folder"), "{refused}");
        assert!(
            std::fs::read_dir(root.join("elsewhere"))
                .unwrap()
                .next()
                .is_none()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pages_older_than_a_link_lives_are_swept_and_foreign_files_stay() {
        let root = scratch("sweep");
        let dir = root.join("open");
        let fresh = write_in(&dir, "http://127.0.0.1:1/auth?t=x", &nonce('D')).unwrap();
        let old = write_in(&dir, "http://127.0.0.1:1/auth?t=x", &nonce('E')).unwrap();
        let foreign = dir.join("notes.html");
        std::fs::write(&foreign, "mine").unwrap();
        // judged a moment after the links have died
        let later = now_ms() + MAX_AGE_MS as f64 + 1000.0;
        sweep_in(&dir, now_ms());
        assert!(fresh.exists() && old.exists());
        sweep_in(&dir, later);
        assert!(!fresh.exists() && !old.exists());
        assert!(foreign.exists());
        sweep_in(&root.join("nowhere"), later);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_opener_is_one_program_and_never_the_link() {
        assert_eq!(opener(Some("  firefox  "), None), "firefox");
        assert_eq!(opener(Some("   "), None), system_opener(None));
        assert_eq!(opener(None, None), system_opener(None));
        if cfg!(windows) {
            assert_eq!(system_opener(Some("D:\\Win")), "D:\\Win\\explorer.exe");
            assert_eq!(system_opener(None), "C:\\Windows\\explorer.exe");
        }
        assert_eq!(escape("a&b<c>\"d'"), "a&#38;b&#60;c&#62;&#34;d&#39;");
    }
}
