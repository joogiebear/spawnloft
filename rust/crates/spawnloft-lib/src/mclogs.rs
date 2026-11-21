//! mclogs.mjs: a server's console log exported to a file, or shared on mclo.gs with the account
//! name taken out of its paths. No command calls these; the panel (C8) and MCP (C9) will.
//! test/fixtures/contracts/c6-library.json holds Node's answers (players_contract.rs).

use std::path::{Path, PathBuf};
use std::time::Duration;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::failure::Failure;

pub const MAX_LINES: usize = 25000;
pub const MAX_BYTES: usize = 10 * 1024 * 1024;

pub const UPLOAD_URL: &str = "https://api.mclo.gs/1/log";
pub const UA: &str = "SpawnLoft (github.com/joogiebear/spawnloft)";

/// JavaScript's `\s`, inside a character class.
pub(crate) const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// `fs.readFileSync(file, 'utf8')`: bytes that are not UTF-8 read as U+FFFD.
fn read_text(file: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(file)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

fn read_console(source: &Path) -> Result<String, Failure> {
    if !source.exists() {
        return Err(Failure::user(
            "this server has no console log yet - start it once, and the log appears",
        ));
    }
    let text = read_text(source).map_err(|e| Failure::io(&e, "open", Some(source)))?;
    if crate::js::trim(&text).is_empty() {
        return Err(Failure::user(
            "the console log is empty - there is nothing to export yet",
        ));
    }
    Ok(text)
}

/// `splitLines`: the lines, and whether the text ended with a newline (dropped from the lines).
fn split_lines(text: &str) -> (Vec<&str>, bool) {
    let mut parts: Vec<&str> = text.split('\n').collect();
    let trailing = parts.len() > 1 && parts.last() == Some(&"");
    if trailing {
        parts.pop();
    }
    (parts, trailing)
}

/// `redactAccountName(text)`: the account name in `C:\Users\<name>`, `/home/<name>` and
/// `/Users/<name>` paths becomes `<user>`. Player names and everything else are left alone.
pub fn redact_account_name(text: &str) -> String {
    // Node's first pass ends the name at a lookahead for the separator; the separator is captured
    // and put back here instead, which matches the same text (a match cannot start at a separator)
    let whole = Regex::new(r#"([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\r\n"'<>|:*?]+)([\\/])"#).unwrap();
    let last = Regex::new(&format!(
        r#"([A-Za-z]:[\\/]+Users[\\/]+)([^\\/{JS_SPACE}"'<>|:*?]+)"#
    ))
    .unwrap();
    let unix = Regex::new(&format!(r#"(/(?:home|Users)/)([^/{JS_SPACE}"'<>|:]+)"#)).unwrap();
    let t = whole.replace_all(text, "${1}<user>${3}");
    let t = last.replace_all(&t, "${1}<user>");
    unix.replace_all(&t, "${1}<user>").into_owned()
}

/// What [`trim_for_upload`] keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trimmed {
    pub content: String,
    pub lines: usize,
    pub trimmed: bool,
}

/// `trimForUpload(text)`: the last [`MAX_LINES`] lines, and of those as many whole lines from the
/// end as fit in [`MAX_BYTES`]; a last line longer than that keeps its end.
pub fn trim_for_upload(text: &str) -> Trimmed {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let (parts, trailing) = split_lines(&text);
    let join = |lines: &[String]| {
        let mut s = lines.join("\n");
        if trailing {
            s.push('\n');
        }
        s
    };
    let mut kept: Vec<String> = parts.iter().map(|s| (*s).to_string()).collect();
    let mut trimmed = false;
    if kept.len() > MAX_LINES {
        kept = kept.split_off(kept.len() - MAX_LINES);
        trimmed = true;
    }
    if join(&kept).len() > MAX_BYTES {
        trimmed = true;
        let budget = MAX_BYTES - usize::from(trailing);
        let mut used = 0;
        let mut first = kept.len();
        for i in (0..kept.len()).rev() {
            let cost = kept[i].len() + usize::from(i != kept.len() - 1);
            if used + cost > budget {
                break;
            }
            used += cost;
            first = i;
        }
        kept = if first == kept.len() {
            // `Buffer.from(line).subarray(-budget).toString('utf8')`: a character cut at the
            // start reads as U+FFFD for each byte left of it
            let line = kept[kept.len() - 1].as_bytes();
            let tail = &line[line.len().saturating_sub(budget)..];
            vec![String::from_utf8_lossy(tail).into_owned()]
        } else {
            kept.split_off(first)
        };
    }
    Trimmed {
        content: join(&kept),
        lines: kept.len(),
        trimmed,
    }
}

/// Where [`export_console`] wrote the log.
#[derive(Debug, Clone, PartialEq)]
pub struct Exported {
    pub file: PathBuf,
    pub size: u64,
    pub size_human: String,
    pub lines: usize,
}

impl Exported {
    pub fn to_json(&self) -> Value {
        json!({
            "file": self.file.to_string_lossy(),
            "size": self.size,
            "sizeHuman": self.size_human,
            "lines": self.lines,
        })
    }
}

/// `exportConsole(inst, { sourceFile, outDir })`: the log copied to
/// `<outDir>/<name>_console_<stamp>.log`. The callers pass `layout.console_log(name)` and
/// `<backups>/<name>/exports`, Node's defaults.
pub fn export_console(name: &str, source: &Path, out_dir: &Path) -> Result<Exported, Failure> {
    let text = read_console(source)?;
    crate::fsx::mkdir_all(out_dir)?;
    let file = out_dir.join(format!("{name}_console_{}.log", crate::util::stamp()));
    std::fs::write(&file, &text).map_err(|e| Failure::io(&e, "open", Some(&file)))?;
    let size = std::fs::metadata(&file)
        .map_err(|e| Failure::io(&e, "stat", Some(&file)))?
        .len();
    Ok(Exported {
        file,
        size,
        size_human: crate::text::human_bytes(Some(size as f64)),
        lines: split_lines(&text).0.len(),
    })
}

/// mclo.gs's answer to the upload: the status, and the body as JSON (`None` when it was not).
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
}

/// The upload: `Err` carries what Node's `err.cause?.message || err.message` would say.
pub type Post<'a> = &'a dyn Fn(&str, &str) -> Result<Reply, String>;

/// The network: a JSON POST with SpawnLoft's user agent and a 60 s limit.
pub fn post(url: &str, body: &str) -> Result<Reply, String> {
    let cfg = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(20)
        .timeout_global(Some(Duration::from_secs(60)))
        .build();
    let agent = ureq::Agent::new_with_config(cfg);
    let url = crate::test_origins::rewrite(url).map_err(|_| "fetch failed".to_string())?;
    let res = agent
        .post(&url)
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .send(body.as_bytes())
        .map_err(|e| match e {
            ureq::Error::Timeout(_) => "The operation was aborted due to timeout".to_string(),
            other => other.to_string(),
        })?;
    let status = res.status().as_u16();
    let body = res
        .into_body()
        .read_to_string()
        .ok()
        .and_then(|t| crate::jsjson::parse(t.strip_prefix('\u{feff}').unwrap_or(&t)).ok());
    Ok(Reply { status, body })
}

/// `rememberToken`: the deletion token added to the owner-only list; a failure is ignored.
fn remember_token(token_file: &Path, entry: Value) {
    let mut kept = match read_text(token_file).ok().map(|t| crate::jsjson::parse(&t)) {
        Some(Ok(Value::Array(a))) => a,
        _ => Vec::new(),
    };
    kept.push(entry);
    let _ = crate::fsx::write_json_node(
        token_file,
        &Value::Array(kept),
        Some(crate::private_files::PRIVATE_MODE),
        false,
    );
}

/// `shareConsole(inst, { sourceFile, tokenFile, fetchImpl })`: the log, account name redacted
/// and trimmed, uploaded to mclo.gs. The answer is `{ url, id, raw, lines, trimmed, expires }`
/// as Node builds it (a field mclo.gs left out is left out). The token file is
/// `run/mclogs.json` in Node's default.
pub fn share_console(name: &str, source: &Path, token_file: &Path, send: Post<'_>) -> Result<Value, Failure> {
    let Trimmed {
        content,
        lines,
        trimmed,
    } = trim_for_upload(&redact_account_name(&read_console(source)?));
    let body = crate::jsjson::stringify(&json!({ "content": content, "source": "mcctl" }));
    let res = send(UPLOAD_URL, &body).map_err(|m| Failure::user(format!("could not reach mclo.gs: {m}")))?;
    let Some(body) = res.body else {
        return Err(Failure::user(format!(
            "mclo.gs answered {} with something that was not a log",
            res.status
        )));
    };
    let field = |k: &str| body.as_object().and_then(|o| o.get(k));
    if !crate::js::truthy(field("success")) {
        let why = match field("error") {
            None | Some(Value::Null) => format!("it answered {}", res.status),
            v => crate::js::string(v),
        };
        return Err(Failure::user(format!("mclo.gs refused the log: {why}")));
    }
    let mut out = Map::new();
    let copy = |out: &mut Map<String, Value>, k: &str| {
        if let Some(v) = field(k) {
            out.insert(k.into(), v.clone());
        }
    };
    if crate::js::truthy(field("token")) {
        let mut entry = Map::new();
        copy(&mut entry, "id");
        copy(&mut entry, "url");
        copy(&mut entry, "token");
        entry.insert("instance".into(), json!(name));
        let now = crate::util::now();
        entry.insert("at".into(), json!(crate::jsdate::to_iso(now).unwrap_or_default()));
        remember_token(token_file, Value::Object(entry));
    }
    copy(&mut out, "url");
    copy(&mut out, "id");
    let or_null = |k: &str| match field(k) {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    };
    out.insert("raw".into(), or_null("raw"));
    out.insert("lines".into(), json!(lines));
    out.insert("trimmed".into(), json!(trimmed));
    out.insert("expires".into(), or_null("expires"));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_the_account_in_each_kind_of_path() {
        assert_eq!(
            redact_account_name(r"at C:\Users\Josh Smith\AppData and C:/Users/Ann"),
            r"at C:\Users\<user>\AppData and C:/Users/<user>"
        );
        assert_eq!(
            redact_account_name("/home/josh/x /Users/ann/y"),
            "/home/<user>/x /Users/<user>/y"
        );
    }

    #[test]
    fn keeps_the_end_of_a_line_too_long_to_send() {
        let line = "é".repeat(MAX_BYTES);
        let t = trim_for_upload(&line);
        assert!(t.trimmed);
        assert_eq!(t.lines, 1);
        assert_eq!(t.content.len(), MAX_BYTES);
    }
}
