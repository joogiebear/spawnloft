//! Files that hold secrets (RCON and database passwords, Microsoft refresh tokens, harness tokens,
//! mclo.gs deletion tokens), kept readable by this user alone: `private-files.mjs`.
//!
//! On POSIX that is mode 0600. Windows ignores the mode: a new file inherits its folder's ACL,
//! and a data root off the system drive usually inherits "Authenticated Users: Modify, Users:
//! Read". There the file gets an explicit access list instead, inheritance removed and one entry
//! for the current user. The Node core sets it with icacls; this sets the same list through the
//! security API (`platform::protect_private`), and reads it back the same way, so no program is
//! run and no name has to be parsed out of icacls's localized output. Which principals may stand on
//! a private file is decided by SID: this user, SYSTEM and Administrators.

use std::path::{Path, PathBuf};

pub const PRIVATE_MODE: u32 = 0o600;

/// SYSTEM and Administrators, the equivalents of root.
pub const ROOT_SIDS: [&str; 2] = ["S-1-5-18", "S-1-5-32-544"];

/// What [`inspect`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Missing,
    Private,
    /// Others can open it: why, and the explicit entries that are not allowed (Windows).
    Open {
        reason: String,
        leftovers: Vec<String>,
    },
}

fn owner_only(mode: u32) -> bool {
    mode & 0o077 == 0
}

/// `protectPrivateFile`: makes `file` readable and writable by this user only. Never fails hard:
/// a drive with no permissions (FAT) answers with the reason, and the caller decides.
pub fn protect(file: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(mode))
            .map_err(|e| crate::jspath::node_error(&e, "chmod", Some(file)))
    }
    #[cfg(windows)]
    {
        // a mode that is not owner-only asks for no ACL
        if !owner_only(mode) {
            return Ok(());
        }
        crate::platform::protect_private(file).map_err(|e| format!("its permissions could not be set ({e})"))
    }
}

/// `writePrivateFile`: writes `data` to `file` so it is never on disk under the folder's
/// permissions. On Windows a new file is created with the private list already on it; a file
/// that exists (a leftover temp file) is protected before the data goes in. The outer error is a
/// write that failed; the inner one is [`protect`]'s answer.
pub fn write(file: &Path, data: &[u8], mode: u32) -> std::io::Result<Result<(), String>> {
    use std::io::Write;
    #[cfg(windows)]
    if owner_only(mode) {
        match crate::platform::create_private_new(file) {
            Ok(mut f) => {
                f.write_all(data)?;
                return Ok(Ok(()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let protection = protect(file, mode);
                std::fs::write(file, data)?;
                return Ok(protection);
            }
            // the API refused (a drive with no ACLs): written plainly, then the same attempt
            // icacls would make, whose reason is the answer
            Err(_) => {
                std::fs::write(file, data)?;
                return Ok(protect(file, mode));
            }
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    opts.open(file)?.write_all(data)?;
    Ok(protect(file, mode))
}

/// `inspectPrivateFile`.
pub fn inspect(file: &Path) -> State {
    // existsSync: anything that cannot be stat'ed reads as missing
    let Ok(meta) = std::fs::metadata(file) else {
        return State::Missing;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file;
        let mode = meta.permissions().mode() & 0o777;
        if !owner_only(mode) {
            return State::Open {
                reason: format!("its permissions are {mode:o}, not 600"),
                leftovers: Vec::new(),
            };
        }
        State::Private
    }
    #[cfg(windows)]
    {
        let _ = meta;
        let entries = match crate::platform::access_entries(file) {
            Ok(Some(entries)) => entries,
            Ok(None) => {
                return State::Open {
                    reason: "it has no access list, so everyone can open it".into(),
                    leftovers: Vec::new(),
                };
            }
            Err(e) => {
                return State::Open {
                    reason: format!("its permissions could not be read ({e})"),
                    leftovers: Vec::new(),
                };
            }
        };
        let me = crate::platform::user_sid().ok();
        judge(&entries, me.as_deref())
    }
}

/// The Windows verdict over a file's entries: every one has to be this user's, SYSTEM's or
/// Administrators', and none inherited from the folder. Kept apart from the API so the wording is
/// tested on every platform.
pub fn judge(entries: &[AccessEntry], me: Option<&str>) -> State {
    let allowed = |e: &AccessEntry| {
        e.sid
            .as_deref()
            .is_some_and(|s| ROOT_SIDS.contains(&s) || me == Some(s))
    };
    let inherited: Vec<&str> = entries
        .iter()
        .filter(|e| e.inherited)
        .map(|e| e.principal.as_str())
        .collect();
    let others: Vec<String> = entries
        .iter()
        .filter(|e| !e.inherited && !allowed(e))
        .map(|e| e.principal.clone())
        .collect();
    if inherited.is_empty() && others.is_empty() {
        return State::Private;
    }
    let mut reasons = Vec::new();
    if !inherited.is_empty() {
        reasons.push(format!(
            "it inherits its folder's permissions ({})",
            inherited.join(", ")
        ));
    }
    if !others.is_empty() {
        reasons.push(format!("{} can open it", others.join(", ")));
    }
    State::Open {
        reason: reasons.join(" and "),
        leftovers: others,
    }
}

#[cfg(windows)]
pub use crate::platform::AccessEntry;

/// One access entry, as [`judge`] weighs it (the Windows type, mirrored for the other platforms'
/// tests).
#[cfg(not(windows))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessEntry {
    pub principal: String,
    pub sid: Option<String>,
    pub inherited: bool,
}

/// `repairPrivateFile`: makes an existing file owner-only and checks the result. The native
/// list replaces every entry at once, so nothing is left to remove one by one as after icacls.
pub fn repair(file: &Path) -> Result<(), String> {
    protect(file, PRIVATE_MODE)?;
    if cfg!(not(windows)) {
        return Ok(());
    }
    match inspect(file) {
        State::Open { reason, .. } => Err(format!("after the repair {reason}")),
        _ => Ok(()),
    }
}

/// One file the doctor checks, and what it holds ("RCON passwords").
#[derive(Debug, Clone)]
pub struct Secret {
    pub file: PathBuf,
    pub what: String,
}

/// `checkPrivateFiles`: `(problems, notes)`. Only files that exist are checked; with `repair` a
/// file others can read is made owner-only, without it the problem says how.
pub fn check(files: &[Secret], repair_them: bool) -> (Vec<String>, Vec<String>) {
    let mut problems = Vec::new();
    let mut notes = Vec::new();
    for Secret { file, what } in files {
        let State::Open { reason, .. } = inspect(file) else {
            continue;
        };
        let shown = file.display();
        if repair_them {
            match repair(file) {
                Ok(()) => notes.push(format!("{what}: made owner-only ({reason})")),
                Err(why) => problems.push(format!(
                    "{what}: other users on this computer can read {shown} ({reason}) and it could not be made owner-only: {why}"
                )),
            }
            continue;
        }
        problems.push(format!(
            "{what}: other users on this computer can read {shown} ({reason}); run doctor without --json to make it owner-only"
        ));
    }
    (problems, notes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sl-private-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(principal: &str, sid: Option<&str>, inherited: bool) -> AccessEntry {
        AccessEntry {
            principal: principal.into(),
            sid: sid.map(Into::into),
            inherited,
        }
    }

    #[test]
    fn judges_entries_as_inspect_private_file_does() {
        let me = Some("S-1-5-21-1-2-3-1001");
        assert_eq!(
            judge(
                &[
                    entry("PC\\josh", me, false),
                    entry("NT AUTHORITY\\SYSTEM", Some("S-1-5-18"), false),
                    entry("BUILTIN\\Administrators", Some("S-1-5-32-544"), false),
                ],
                me
            ),
            State::Private
        );
        assert_eq!(
            judge(
                &[
                    entry("PC\\josh", me, false),
                    entry("BUILTIN\\Users", Some("S-1-5-32-545"), true),
                    entry("NT AUTHORITY\\Authenticated Users", Some("S-1-5-11"), true),
                    entry("Everyone", Some("S-1-1-0"), false),
                    entry("*S-1-5-21-9-9-9-500", Some("S-1-5-21-9-9-9-500"), false),
                ],
                me
            ),
            State::Open {
                reason: "it inherits its folder's permissions (BUILTIN\\Users, NT AUTHORITY\\Authenticated Users) and Everyone, *S-1-5-21-9-9-9-500 can open it".into(),
                leftovers: vec!["Everyone".into(), "*S-1-5-21-9-9-9-500".into()],
            }
        );
        // an inherited entry of this user's own still means the folder decides
        assert!(matches!(
            judge(&[entry("PC\\josh", me, true)], me),
            State::Open { .. }
        ));
        // with no user to compare against, only root stands
        assert!(matches!(
            judge(&[entry("PC\\josh", me, false)], None),
            State::Open { .. }
        ));
    }

    #[test]
    fn missing_files_are_skipped() {
        let d = temp("missing");
        assert_eq!(inspect(&d.join("nope")), State::Missing);
        let (problems, notes) = check(
            &[Secret {
                file: d.join("nope"),
                what: "RCON passwords".into(),
            }],
            true,
        );
        assert!(problems.is_empty() && notes.is_empty());
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn modes_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp("posix");
        let f = d.join("secret.json");
        std::fs::write(&f, "{}").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            inspect(&f),
            State::Open {
                reason: "its permissions are 644, not 600".into(),
                leftovers: vec![]
            }
        );
        let what = Secret {
            file: f.clone(),
            what: "RCON passwords".into(),
        };
        let (problems, _) = check(std::slice::from_ref(&what), false);
        assert_eq!(
            problems,
            [format!(
                "RCON passwords: other users on this computer can read {} (its permissions are 644, not 600); run doctor without --json to make it owner-only",
                f.display()
            )]
        );
        let (problems, notes) = check(&[what], true);
        assert!(problems.is_empty());
        assert_eq!(
            notes,
            ["RCON passwords: made owner-only (its permissions are 644, not 600)"]
        );
        assert_eq!(inspect(&f), State::Private);

        // a wider leftover is tightened by the write
        let g = d.join("token.json");
        std::fs::write(&g, "old").unwrap();
        std::fs::set_permissions(&g, std::fs::Permissions::from_mode(0o666)).unwrap();
        write(&g, b"new", PRIVATE_MODE).unwrap().unwrap();
        assert_eq!(std::fs::metadata(&g).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&g).unwrap(), "new");

        assert_eq!(
            protect(&d.join("gone"), PRIVATE_MODE),
            Err(format!(
                "ENOENT: no such file or directory, chmod '{}'",
                d.join("gone").display()
            ))
        );
        std::fs::remove_dir_all(&d).unwrap();
    }

    // The plan's check for C1: the list set here is the list icacls leaves for the Node core.
    #[cfg(windows)]
    #[test]
    fn the_native_list_is_what_icacls_leaves() {
        let d = temp("acl");
        let by_icacls = d.join("icacls.json");
        let native = d.join("native.json");
        std::fs::write(&by_icacls, "{}").unwrap();
        std::fs::write(&native, "{}").unwrap();
        assert!(
            matches!(inspect(&native), State::Open { .. }),
            "a new file inherits"
        );
        let sid = crate::platform::user_sid().unwrap();
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let out = std::process::Command::new(format!("{root}\\System32\\icacls.exe"))
            .arg(&by_icacls)
            .args(["/inheritance:r", "/grant:r", &format!("*{sid}:F")])
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
        protect(&native, PRIVATE_MODE).unwrap();
        // icacls may add the auto-inherited flags (AI, AR), and the SDDL may name this user by an
        // alias (LA for the built-in administrator, as on the CI runners)
        let shape = |s: String| s.replace("AI", "").replace("AR", "");
        let want = shape(crate::platform::dacl_sddl(&native).unwrap());
        let me = want
            .strip_prefix("D:P(A;;FA;;;")
            .and_then(|r| r.strip_suffix(')'))
            .unwrap_or_else(|| panic!("one full-access entry, protected: {want}"));
        assert!(
            me == sid || (me.len() == 2 && me.bytes().all(|b| b.is_ascii_uppercase())),
            "{want} for {sid}"
        );
        // icacls leaves the same entry, protected; where the folder gave SYSTEM and Administrators
        // explicit entries it keeps those too, which a private file allows
        let theirs = shape(crate::platform::dacl_sddl(&by_icacls).unwrap());
        assert!(
            theirs.starts_with("D:P(") && theirs.contains(&format!("(A;;FA;;;{me})")),
            "{theirs}"
        );
        let rest = theirs.replace(&format!("(A;;FA;;;{me})"), "");
        assert!(
            rest.trim_start_matches("D:P")
                .replace("(A;;FA;;;SY)", "")
                .replace("(A;;FA;;;BA)", "")
                .is_empty(),
            "icacls left others: {theirs}"
        );
        assert_eq!(inspect(&native), State::Private);
        assert_eq!(inspect(&by_icacls), State::Private);

        // created private: the list is there from the first byte, and a rewrite keeps it
        let fresh = d.join("fresh.json");
        write(&fresh, b"{}", PRIVATE_MODE).unwrap().unwrap();
        assert_eq!(shape(crate::platform::dacl_sddl(&fresh).unwrap()), want);
        write(&fresh, b"{\"a\":1}", PRIVATE_MODE).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "{\"a\":1}");
        assert_eq!(inspect(&fresh), State::Private);

        // a leftover readable by everyone is repaired whole
        let open = d.join("open.json");
        std::fs::write(&open, "{}").unwrap();
        let grant = std::process::Command::new(format!("{root}\\System32\\icacls.exe"))
            .arg(&open)
            .args(["/grant", "*S-1-1-0:R"])
            .output()
            .unwrap();
        assert!(grant.status.success());
        let State::Open { leftovers, .. } = inspect(&open) else {
            panic!("open")
        };
        assert_eq!(leftovers, ["Everyone"]);
        repair(&open).unwrap();
        assert_eq!(inspect(&open), State::Private);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
