//! `props.mjs`'s reader: `server.properties` as an ordered map, comments and blank lines skipped,
//! the value kept exactly as written after the first `=`; and its writer, which keeps comments
//! and key order.

use std::path::Path;

use crate::failure::Failure;
use crate::js;

/// Keys in file order; a repeated key keeps its first place and its last value, as a `Map` does.
pub type Props = serde_json::Map<String, serde_json::Value>;

/// `parseProps(text)`.
pub fn parse(text: &str) -> Props {
    let mut map = Props::new();
    for line in crate::supervisor::split_lines(text) {
        let trimmed = js::trim(&line);
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
            continue;
        }
        let Some(eq) = line.find('=') else {
            continue;
        };
        map.insert(
            js::trim(&line[..eq]).to_string(),
            serde_json::Value::String(line[eq + 1..].to_string()),
        );
    }
    map
}

/// `readProps(file)`: empty when the file is not there.
pub fn read(file: &Path) -> Result<Props, Failure> {
    match std::fs::read(file) {
        Ok(b) => Ok(parse(&String::from_utf8_lossy(&b))),
        Err(e) if crate::jspath::is_enoent(&e) => Ok(Props::new()),
        Err(e) => Err(Failure::read(&e, file)),
    }
}

/// `props.get(key)` as text.
pub fn get<'a>(props: &'a Props, key: &str) -> Option<&'a str> {
    props.get(key).and_then(|v| v.as_str())
}

/// `writeProps(file, updates)`: each key's line replaced where it stands, new keys appended,
/// trailing blank lines dropped and one newline at the end. Written owner-only (it holds
/// `rcon.password`) through `<file>.tmp-<pid>` and a rename, so a crash never leaves half a file.
pub fn write(file: &Path, updates: &[(String, String)]) -> Result<(), Failure> {
    // Read, change and write back as one step, as Node's one synchronous turn was: the panel's
    // routes are threads, and two of them would otherwise lose a change or share the tmp file.
    static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _writing = WRITING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let lines = match std::fs::read(file) {
        Ok(b) => crate::supervisor::split_lines(&String::from_utf8_lossy(&b)),
        Err(e) if crate::jspath::is_enoent(&e) => Vec::new(),
        Err(e) => return Err(Failure::read(&e, file)),
    };
    // a Map: the first place of a key, its last value
    let mut pending: Vec<(String, String)> = Vec::new();
    for (k, v) in updates {
        match pending.iter_mut().find(|(pk, _)| pk == k) {
            Some(slot) => slot.1 = v.clone(),
            None => pending.push((k.clone(), v.clone())),
        }
    }
    let mut out: Vec<String> = lines
        .into_iter()
        .map(|line| {
            let trimmed = js::trim(&line);
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
                return line;
            }
            let Some(eq) = line.find('=') else {
                return line;
            };
            let key = js::trim(&line[..eq]).to_string();
            match pending.iter().position(|(k, _)| *k == key) {
                Some(i) => {
                    let (_, value) = pending.remove(i);
                    format!("{key}={value}")
                }
                None => line,
            }
        })
        .collect();
    while out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    for (k, v) in pending {
        out.push(format!("{k}={v}"));
    }
    out.push(String::new());
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", std::process::id()));
    let tmp = std::path::PathBuf::from(tmp);
    // the protection's answer is not acted on here, as in Node
    let _protection = crate::private_files::write(&tmp, out.join("\n").as_bytes(), 0o600)
        .map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
    crate::fsx::rename_over(&tmp, file).map_err(|e| crate::fsx::rename_failure(&e, &tmp, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_props_mjs() {
        let p = parse("#c\n! x\nmotd=a=b\r\n  level-name = w \nbad\nmotd=again\n");
        assert_eq!(get(&p, "motd"), Some("again"));
        assert_eq!(get(&p, "level-name"), Some(" w "));
        assert_eq!(p.keys().collect::<Vec<_>>(), ["motd", "level-name"]);
    }

    #[test]
    fn writes_like_props_mjs() {
        let dir = std::env::temp_dir().join(format!("sl-props-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("server.properties");
        std::fs::write(&f, "#c\r\nmotd=x\n bad\n server-port = 1\n\n\n").unwrap();
        let u = |k: &str, v: &str| (k.to_string(), v.to_string());
        write(&f, &[u("server-port", "2"), u("new", "a=b"), u("new", "c")]).unwrap();
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "#c\nmotd=x\n bad\nserver-port=2\nnew=c\n"
        );
        write(&dir.join("none.properties"), &[u("a", "1")]).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("none.properties")).unwrap(),
            "a=1\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
