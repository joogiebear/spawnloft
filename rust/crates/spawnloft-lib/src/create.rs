//! The parts of `create.mjs` that `set jar=` needs (C2): placing a stored jar in a server's
//! folder and naming the older jars left beside it.

use std::path::{Path, PathBuf};

use crate::failure::Failure;
use crate::jspath;

/// `listJars()`'s names: the store's `.jar` files in `localeCompare` order; nothing when the
/// store does not exist.
pub fn list_jar_names(jars_dir: &str) -> Result<Vec<String>, Failure> {
    let dir = Path::new(jars_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for name in crate::fsx::readdir_names(dir).map_err(|e| Failure::io(&e, "scandir", Some(dir)))? {
        if name.ends_with(".jar") {
            // listJars stats each one; a jar that cannot be read fails the listing there
            let p = dir.join(&name);
            std::fs::metadata(&p).map_err(|e| Failure::io(&e, "stat", Some(&p)))?;
            names.push(name);
        }
    }
    names.sort_by(|a, b| crate::collate::compare(a, b));
    Ok(names)
}

/// `placeJar(dir, chosenJar)`: the jar already in the folder, else copied from the store, else
/// from an absolute path; returns where it is and whether it was copied.
pub fn place_jar(jars_dir: &str, dir: &str, chosen: &str) -> Result<(PathBuf, bool), Failure> {
    let base = jspath::basename(chosen);
    let in_instance = PathBuf::from(jspath::join(&[dir, &base]));
    if in_instance.exists() {
        return Ok((in_instance, false));
    }
    let from_store = PathBuf::from(jspath::join(&[jars_dir, &base]));
    let src = if from_store.exists() {
        Some(from_store)
    } else if jspath::is_absolute(chosen) && Path::new(chosen).exists() {
        Some(PathBuf::from(chosen))
    } else {
        None
    };
    let Some(src) = src else {
        let have = list_jar_names(jars_dir)?.join(", ");
        let stored = if have.is_empty() {
            "  The jar store is empty.".to_string()
        } else {
            format!("  Stored jars: {have}")
        };
        return Err(Failure::user(format!(
            "server jar \"{chosen}\" is not in {jars_dir}.\n{stored}\n  Download one with \"spawnloft paper fetch <version>\" or add one with \"spawnloft jars import <path>\"."
        )));
    };
    std::fs::copy(&src, &in_instance).map_err(|e| {
        let (code, text) = jspath::error_code(&e);
        Failure::Internal {
            head: "Error".into(),
            message: format!(
                "{code}: {text}, copyfile '{}' -> '{}'",
                src.display(),
                in_instance.display()
            ),
            code: Some(code.to_string()),
        }
    })?;
    Ok((in_instance, true))
}

/// `strayJars(dir, currentJar)`: the other `.jar` files in a server's folder with their sizes,
/// in `readdirSync` order; nothing when the folder cannot be read.
pub fn stray_jars(dir: &str, current: &str) -> Vec<(String, u64)> {
    let keep = jspath::basename(current);
    let Ok(names) = crate::fsx::readdir_names(Path::new(dir)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in names {
        if name.to_lowercase().ends_with(".jar") && name != keep {
            // a stat that fails drops the whole list, as the Node try/catch does
            match std::fs::metadata(Path::new(dir).join(&name)) {
                Ok(m) => out.push((name, m.len())),
                Err(_) => return Vec::new(),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jar_comes_from_the_store_once() {
        let root = std::env::temp_dir().join(format!("sl-create-{}", std::process::id()));
        let store = root.join("jars");
        let inst = root.join("i");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&inst).unwrap();
        std::fs::write(store.join("b.jar"), b"x").unwrap();
        std::fs::write(store.join("a.jar"), b"y").unwrap();
        let (s, i) = (store.to_string_lossy(), inst.to_string_lossy());
        let (p, copied) = place_jar(&s, &i, "b.jar").unwrap();
        assert!(copied && p.exists());
        assert!(!place_jar(&s, &i, "b.jar").unwrap().1);
        let f = place_jar(&s, &i, "c.jar").unwrap_err();
        assert!(
            f.message().contains("  Stored jars: a.jar, b.jar\n"),
            "{}",
            f.message()
        );
        std::fs::write(inst.join("old.JAR"), b"zz").unwrap();
        assert_eq!(stray_jars(&i, "b.jar"), vec![("old.JAR".to_string(), 2)]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
