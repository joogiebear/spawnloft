//! `props.mjs`'s reader: `server.properties` as an ordered map, comments and blank lines skipped,
//! the value kept exactly as written after the first `=`. The writer moves with C2.

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
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Props::new()),
        Err(e) => Err(Failure::read(&e, file)),
    }
}

/// `props.get(key)` as text.
pub fn get<'a>(props: &'a Props, key: &str) -> Option<&'a str> {
    props.get(key).and_then(|v| v.as_str())
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
}
