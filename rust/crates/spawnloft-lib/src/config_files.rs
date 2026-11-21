//! `config-files.mjs` (C3): the text configuration an AI assistant may see and change (plugin
//! configs, Paper's and Bukkit's files, server.properties). Confined to the server folder, to
//! hand-edited text formats, and away from worlds, logs and the files holding players' IPs.
//!
//! Values under secret-looking keys are shown as `[redacted]`, and a write that contains a
//! placeholder is refused, so a redacted file written back whole cannot replace a real password
//! with the word "redacted". Keys SpawnLoft rewrites at every start (ports, RCON) are refused too.
//! No command calls this yet: the panel (C8) and the MCP tools (C9) will. Its behaviour is held to
//! the Node module's by test/fixtures/contracts/c3-library.json.

use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::failure::Failure;
use crate::registry::Instance;
use crate::{backup, collate, fsx, js, jspath, jsregex, props, text};

pub const EXTENSIONS: [&str; 11] = [
    ".yml",
    ".yaml",
    ".json",
    ".json5",
    ".properties",
    ".toml",
    ".conf",
    ".cfg",
    ".ini",
    ".txt",
    ".hocon",
];
pub const MAX_BYTES: u64 = 512 * 1024;
const MAX_LISTED: usize = 400;
const MAX_DEPTH: usize = 6;

/// Regenerable or not configuration; the worlds are added per server from level-name.
const EXCLUDED_DIRS: [&str; 7] = [
    "cache",
    "libraries",
    "versions",
    "logs",
    "crash-reports",
    "databases",
    ".paper-remapped",
];
/// eula.txt is the owner's own agreement to make. The other two hold players' IP addresses.
const REFUSED_FILES: [&str; 3] = ["eula.txt", "banned-ips.json", "usercache.json"];
/// Written by syncProps before every launch.
pub const MANAGED_PROPS: [&str; 5] = [
    "server-port",
    "enable-rcon",
    "rcon.port",
    "rcon.password",
    "broadcast-rcon-to-ops",
];
pub const PLACEHOLDERS: [&str; 2] = ["[redacted]", "[ip hidden]"];

struct Patterns {
    secret_key: Regex,
    secret_camel: Regex,
    line_start: Regex,
    inline_key: Regex,
    query_param: Regex,
    url_credential: Regex,
    not_a_secret: Regex,
    pem_begin: Regex,
    pem_end: Regex,
    inline_stop: Regex,
}

fn p() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let c = |src: &str, i: bool| jsregex::compile(src, i).expect("a fixed pattern");
        Patterns {
            // "token" only as the whole last word, so an eco currency called tokens or a
            // token-cost is not taken for one
            secret_key: c(
                r"password|passwd|secret|webhook|api[-_.]?key|private[-_.]?key|access[-_.]?key|(?:^|[-_.])(?:token|pass|pwd)$",
                true,
            ),
            secret_camel: c(r"[a-z0-9](?:Token|Pass|Pwd)$", false),
            // `key: value`, `key = value`, `- key: value`, `"key": "value"`
            line_start: c(r#"^(\s*(?:-\s*)?["']?)([\w.-]+)(["']?\s*[:=]\s*)"#, false),
            // a key inside a one-line map: `{"a": 1, "password": "x"}`
            inline_key: c(r#"([{,]\s*)(["']?)([\w.-]+)(["']?)(\s*[:=]\s*)"#, false),
            // `?password=x` or `;pwd=x` in a URL or JDBC string
            query_param: c(r#"([?&;])([\w.-]+)=([^&\s"';,]*)"#, false),
            // scheme://user:password@host, or scheme://:password@host with no user
            url_credential: c(r"(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)", true),
            not_a_secret: c(r#"^(null|~|none|true|false|""|''|\[\]|\{\})$"#, true),
            pem_begin: c(r"-----BEGIN [A-Z ]*PRIVATE KEY-----", false),
            pem_end: c(r"-----END [A-Z ]*PRIVATE KEY-----", false),
            inline_stop: c(r"[\s,}\]]", false),
        }
    })
}

fn is_secret_key(key: &str) -> bool {
    p().secret_key.is_match(key) || p().secret_camel.is_match(key)
}

fn is_blank(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

fn not_a_secret(v: &str) -> bool {
    p().not_a_secret.is_match(v)
}

fn redact_line_value(body: &str) -> String {
    let Some(m) = p().line_start.captures(body) else {
        return body.to_string();
    };
    let key = m.get(2).map_or("", |g| g.as_str());
    if !is_secret_key(key) {
        return body.to_string();
    }
    let all = m.get(0).expect("the whole match");
    let rest = &body[all.end()..];
    let b = rest.as_bytes();
    let mut end = b.len();
    while end > 0 && is_blank(b[end - 1]) {
        end -= 1;
    }
    if end > 0 && b[end - 1] == b',' {
        end -= 1;
        while end > 0 && is_blank(b[end - 1]) {
            end -= 1;
        }
    }
    let mut value = &rest[..end];
    let mut quote = "";
    let vb = value.as_bytes();
    if text::js_len(value) >= 3 && (vb[0] == b'"' || vb[0] == b'\'') && vb[vb.len() - 1] == vb[0] {
        quote = &value[..1];
        value = &value[1..value.len() - 1];
    }
    let t = js::trim(value);
    if t.is_empty() || not_a_secret(t) {
        return body.to_string();
    }
    format!(
        "{}{}{}{quote}[redacted]{quote}{}",
        m.get(1).map_or("", |g| g.as_str()),
        key,
        m.get(3).map_or("", |g| g.as_str()),
        &rest[end..]
    )
}

/// `inlineValueEnd(body, from)`: where the value starting at `from` ends (byte offsets).
fn inline_value_end(body: &str, from: usize) -> usize {
    let b = body.as_bytes();
    let open = b.get(from).copied();
    if let Some(q @ (b'"' | b'\'')) = open {
        let mut i = from + 1;
        while i < b.len() {
            if b[i] == b'\\' && q == b'"' {
                // skips one character; a multi-byte one ends on a byte no quote can be
                i += 1;
            } else if b[i] == q {
                return i + 1;
            }
            i += 1;
        }
        return b.len();
    }
    let mut i = from;
    for (off, ch) in body[from..].char_indices() {
        let mut buf = [0u8; 4];
        if p().inline_stop.is_match(ch.encode_utf8(&mut buf)) {
            return from + off;
        }
        i = from + off + ch.len_utf8();
    }
    i
}

fn redact_inline(body: &str) -> String {
    let mut out = String::new();
    let mut copied = 0;
    let mut last = 0;
    while last <= body.len() {
        let Some(m) = p().inline_key.captures_at(body, last) else {
            break;
        };
        // the pattern's `(["']?)...\2` in JavaScript: the closing quote must match the opening one
        let q1 = m.get(2).map_or("", |g| g.as_str());
        let q2 = m.get(4).map_or("", |g| g.as_str());
        let whole = m.get(0).expect("the whole match");
        if q1 != q2 {
            // a backreference the crate cannot write: try the shorter forms JavaScript would
            match backtracked_inline(body, whole.start(), q1) {
                Some((from, key)) => {
                    last = handle_inline(body, from, &key, &mut out, &mut copied);
                }
                None => last = whole.start() + 1,
            }
            continue;
        }
        let from = whole.end();
        let key = m.get(3).map_or("", |g| g.as_str()).to_string();
        last = handle_inline(body, from, &key, &mut out, &mut copied);
    }
    if copied == 0 {
        body.to_string()
    } else {
        out.push_str(&body[copied..]);
        out
    }
}

/// A match of `([{,]\s*)(["']?)([\w.-]+)\2(\s*[:=]\s*)` at `start` where the quotes differ: with
/// the opening quote, JavaScript needs the same quote after the key; without it, the quote is
/// not taken and the key must be followed directly by `:` or `=`.
fn backtracked_inline(body: &str, start: usize, q1: &str) -> Option<(usize, String)> {
    static NOQ: OnceLock<Regex> = OnceLock::new();
    static WITHQ: OnceLock<[Regex; 2]> = OnceLock::new();
    let withq = WITHQ.get_or_init(|| {
        [
            jsregex::compile(r#"^[{,]\s*"([\w.-]+)"\s*[:=]\s*"#, false).expect("fixed"),
            jsregex::compile(r#"^[{,]\s*'([\w.-]+)'\s*[:=]\s*"#, false).expect("fixed"),
        ]
    });
    let noq = NOQ.get_or_init(|| jsregex::compile(r"^[{,]\s*([\w.-]+)\s*[:=]\s*", false).expect("fixed"));
    let rest = &body[start..];
    if !q1.is_empty() {
        let re = if q1 == "\"" { &withq[0] } else { &withq[1] };
        if let Some(m) = re.captures(rest) {
            return Some((start + m.get(0)?.end(), m.get(1)?.as_str().to_string()));
        }
    }
    let m = noq.captures(rest)?;
    Some((start + m.get(0)?.end(), m.get(1)?.as_str().to_string()))
}

/// One key found at `from`: redacts its value when it is a secret; returns where to search next.
fn handle_inline(body: &str, from: usize, key: &str, out: &mut String, copied: &mut usize) -> usize {
    if !is_secret_key(key) {
        return from;
    }
    let end = inline_value_end(body, from);
    let token = &body[from..end];
    let tb = token.as_bytes();
    let quoted = text::js_len(token) >= 2 && (tb[0] == b'"' || tb[0] == b'\'') && tb[tb.len() - 1] == tb[0];
    let inner = if quoted { &token[1..token.len() - 1] } else { token };
    let t = js::trim(inner);
    if t.is_empty() || not_a_secret(t) {
        return from;
    }
    let quote = if quoted { &token[..1] } else { "" };
    out.push_str(&body[*copied..from]);
    out.push_str(&format!("{quote}[redacted]{quote}"));
    *copied = end;
    end
}

fn redact_query(body: &str) -> String {
    p().query_param
        .replace_all(body, |c: &regex::Captures<'_>| {
            let value = c.get(3).map_or("", |g| g.as_str());
            let key = &c[2];
            if !value.is_empty() && is_secret_key(key) && !not_a_secret(value) {
                format!("{}{key}=[redacted]", &c[1])
            } else {
                c[0].to_string()
            }
        })
        .into_owned()
}

fn redact_pem_same_line(body: &str) -> String {
    let Some(begin) = p().pem_begin.find(body) else {
        return body.to_string();
    };
    let from = begin.end();
    match body[from..].find("-----END") {
        Some(off) if p().pem_end.is_match(&body[from + off..]) => {
            format!("{}[redacted]{}", &body[..from], &body[from + off..])
        }
        _ => body.to_string(),
    }
}

/// `redactConfig(text)`: secrets in a config file's text replaced with `[redacted]`.
pub fn redact_config(text: &str) -> String {
    let mut in_pem = false;
    text.split('\n')
        .map(|line| {
            let eol = if line.ends_with('\r') { "\r" } else { "" };
            let body = &line[..line.len() - eol.len()];
            if in_pem {
                if !p().pem_end.is_match(body) {
                    return format!("[redacted]{eol}");
                }
                in_pem = false;
                return format!("{body}{eol}");
            }
            if p().pem_begin.is_match(body) {
                let same = redact_pem_same_line(body);
                if same == body && !p().pem_end.is_match(body) {
                    in_pem = true;
                }
                return format!("{same}{eol}");
            }
            let mut body = redact_line_value(body);
            if body.contains('{') || body.contains(',') {
                body = redact_inline(&body);
            }
            if body.contains('=') {
                body = redact_query(&body);
            }
            let body = p().url_credential.replace_all(&body, "${1}[redacted]${3}");
            format!("{body}{eol}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn dir_of(inst: &Instance) -> Result<String, Failure> {
    backup::dir_of(inst)
}

fn excluded_tops(inst: &Instance) -> Result<Vec<String>, Failure> {
    let dir = dir_of(inst)?;
    let pr = props::read(&jspath::join_path(&dir, &["server.properties"]))?;
    let level = match props::get(&pr, "level-name") {
        Some(v) if !v.is_empty() => v.to_string(),
        _ => "world".into(),
    };
    let mut out: Vec<String> = EXCLUDED_DIRS.iter().map(|d| d.to_lowercase()).collect();
    for d in [
        level.clone(),
        format!("{level}_nether"),
        format!("{level}_the_end"),
    ] {
        out.push(d.to_lowercase());
    }
    Ok(out)
}

/// `fs.realpathSync(inst.dir)`.
pub(crate) fn real_dir(inst: &Instance) -> Result<String, Failure> {
    let dir = dir_of(inst)?;
    fsx::realpath(Path::new(&dir))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| Failure::io(&e, "lstat", Some(Path::new(&dir))))
}

fn realpath_str(p: &Path) -> Result<String, Failure> {
    fsx::realpath(p)
        .map(|r| r.to_string_lossy().into_owned())
        .map_err(|e| Failure::io(&e, "lstat", Some(p)))
}

/// `/^[a-z]:/i`.
pub(crate) fn has_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// What `resolveConfigPath` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigPath {
    pub full: PathBuf,
    pub shown: String,
    pub exists: bool,
}

/// `resolveConfigPath(inst, relative, { mustExist })`: an assistant-supplied path inside the
/// server folder. The errors are written for the model to act on.
pub fn resolve_config_path(
    inst: &Instance,
    relative: Option<&str>,
    must_exist: bool,
) -> Result<ConfigPath, Failure> {
    let relative = match relative {
        Some(r) if !js::trim(r).is_empty() => r,
        _ => {
            return Err(Failure::user(
                "path is required, relative to the server folder, e.g. \"plugins/EcoItems/config.yml\"",
            ));
        }
    };
    let clean = js::trim(relative).replace('\\', "/");
    let clean = clean.strip_prefix("./").unwrap_or(&clean).to_string();
    if clean.contains('\0') || jspath::is_absolute(&clean) || has_drive(&clean) || clean.starts_with('/') {
        return Err(Failure::user(format!(
            "\"{relative}\" must be a path inside the server folder, such as \"plugins/EcoItems/config.yml\""
        )));
    }
    let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() || parts.contains(&"..") {
        return Err(Failure::user(format!(
            "\"{relative}\" must stay inside the server folder"
        )));
    }
    let base = real_dir(inst)?;
    let full = jspath::join_path(&base, &parts);
    let shown = parts.join("/");
    if excluded_tops(inst)?.contains(&parts[0].to_lowercase()) {
        return Err(Failure::user(format!(
            "{shown} is in {}/, which holds worlds, logs or downloads rather than configuration",
            parts[0]
        )));
    }
    let file_name = parts[parts.len() - 1].to_lowercase();
    if parts.len() == 1 && REFUSED_FILES.contains(&file_name.as_str()) {
        return Err(Failure::user(if file_name == "eula.txt" {
            "eula.txt is the server owner's acceptance of the Minecraft EULA; they change it themselves"
                .to_string()
        } else {
            format!("{file_name} holds players' IP addresses and is not available here")
        }));
    }
    if !EXTENSIONS.contains(&jspath::extname(&file_name).as_str()) {
        return Err(Failure::user(format!(
            "{shown} is not a text configuration file ({})",
            EXTENSIONS.join(", ")
        )));
    }
    // a link inside the folder may point anywhere: where the existing part really lands counts
    let mut existing = full.clone();
    while !existing.exists() {
        existing = PathBuf::from(jspath::dirname(&existing.to_string_lossy()));
    }
    if !crate::util::is_inside(Path::new(&base), Path::new(&realpath_str(&existing)?)) {
        return Err(Failure::user(format!("{shown} leads outside the server folder")));
    }
    let exists = existing == full;
    if exists && !std::fs::metadata(&full).is_ok_and(|m| m.is_file()) {
        return Err(Failure::user(format!("{shown} is not a file")));
    }
    if must_exist && !exists {
        return Err(Failure::user(format!(
            "{shown} does not exist. list_config_files shows what does."
        )));
    }
    Ok(ConfigPath { full, shown, exists })
}

fn read_text(full: &Path, shown: &str) -> Result<String, Failure> {
    let size = std::fs::metadata(full)
        .map_err(|e| Failure::io(&e, "stat", Some(full)))?
        .len();
    if size > MAX_BYTES {
        return Err(Failure::user(format!(
            "{shown} is {} KB; files over {} KB are not served",
            (size as f64 / 1024.0 + 0.5).floor(),
            MAX_BYTES / 1024
        )));
    }
    let buf = std::fs::read(full).map_err(|e| Failure::read(&e, full))?;
    if buf.contains(&0) {
        return Err(Failure::user(format!("{shown} is not a text file")));
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// One row of `listConfigFiles`.
#[derive(Debug, Clone, PartialEq)]
pub struct ListedFile {
    pub path: String,
    pub size_bytes: u64,
}

/// `listConfigFiles(inst, folder)`: breadth first, so a cut listing loses deep folders rather
/// than server.properties or a plugin's config.yml.
pub fn list_config_files(inst: &Instance, folder: &str) -> Result<(Vec<ListedFile>, bool), Failure> {
    let base = real_dir(inst)?;
    let mut start = PathBuf::from(&base);
    let f = js::trim(folder);
    if !f.is_empty() && f != "." {
        let mut clean = f.replace('\\', "/");
        if let Some(s) = clean.strip_prefix("./") {
            clean = s.to_string();
        }
        if let Some(s) = clean.strip_suffix('/') {
            clean = s.to_string();
        }
        let parts: Vec<&str> = clean.split('/').filter(|p| !p.is_empty()).collect();
        if jspath::is_absolute(&clean) || has_drive(&clean) || parts.contains(&"..") {
            return Err(Failure::user(format!(
                "\"{folder}\" must be a folder inside the server folder"
            )));
        }
        let Some(first) = parts.first() else {
            return Err(Failure::type_error(
                "Cannot read properties of undefined (reading 'toLowerCase')",
            ));
        };
        if excluded_tops(inst)?.contains(&first.to_lowercase()) {
            return Err(Failure::user(format!(
                "{clean}/ holds worlds, logs or downloads rather than configuration"
            )));
        }
        start = jspath::join_path(&base, &parts);
        if !start.exists() || !start.is_dir() {
            return Err(Failure::user(format!(
                "{clean}/ is not a folder in {}",
                inst.name
            )));
        }
        if !crate::util::is_inside(Path::new(&base), Path::new(&realpath_str(&start)?)) {
            return Err(Failure::user(format!("{clean}/ leads outside the server folder")));
        }
    }
    let excluded = excluded_tops(inst)?;
    let base_path = PathBuf::from(&base);
    let mut files = Vec::new();
    let mut truncated = false;
    let mut level = vec![start];
    let mut depth = 0;
    while !level.is_empty() && depth <= MAX_DEPTH && !truncated {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(mut entries) = fsx::readdir_typed(dir) else {
                continue;
            };
            entries.sort_by(|a, b| collate::compare(&a.0, &b.0));
            for (name, t) in entries {
                let full = dir.join(&name);
                if t.is_dir() {
                    if !(*dir == base_path && excluded.contains(&name.to_lowercase())) {
                        next.push(full);
                    }
                } else if t.is_file() && EXTENSIONS.contains(&jspath::extname(&name).to_lowercase().as_str())
                {
                    if *dir == base_path && REFUSED_FILES.contains(&name.to_lowercase().as_str()) {
                        continue;
                    }
                    if files.len() >= MAX_LISTED {
                        truncated = true;
                        break;
                    }
                    let rel = jspath::relative(&base, &full.to_string_lossy());
                    let sep = if cfg!(windows) { "\\" } else { "/" };
                    files.push(ListedFile {
                        path: rel.split(sep).collect::<Vec<_>>().join("/"),
                        size_bytes: std::fs::metadata(&full)
                            .map_err(|e| Failure::io(&e, "stat", Some(&full)))?
                            .len(),
                    });
                }
            }
            if truncated {
                break;
            }
        }
        level = next;
        depth += 1;
    }
    Ok((files, truncated))
}

/// What `readConfigFile` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadConfig {
    pub path: String,
    pub text: String,
    pub size_bytes: u64,
    pub redacted: bool,
}

/// `readConfigFile(inst, relative)`.
pub fn read_config_file(inst: &Instance, relative: Option<&str>) -> Result<ReadConfig, Failure> {
    let c = resolve_config_path(inst, relative, true)?;
    let raw = read_text(&c.full, &c.shown)?;
    let text = redact_config(&raw);
    Ok(ReadConfig {
        path: c.shown,
        redacted: text != raw,
        size_bytes: raw.len() as u64,
        text,
    })
}

/// What `planConfigWrite` answers: the new text, computed without touching the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub full: PathBuf,
    pub shown: String,
    pub existed: bool,
    pub before: Option<String>,
    pub after: String,
}

/// What a write asks for: `content` (the whole file) or one exact `old_text` -> `new_text`
/// replacement. Each field is the JSON value given, `None` when it was not given (undefined).
#[derive(Debug, Clone, Default)]
pub struct WriteAsk {
    pub content: Option<Value>,
    pub old_text: Option<Value>,
    pub new_text: Option<Value>,
    pub hidden_restored: bool,
}

/// `str.replace(/\n/g, '\r\n')`.
fn crlf(s: &str) -> String {
    s.replace('\n', "\r\n")
}

fn starts_bom(s: &str) -> bool {
    s.starts_with('\u{feff}')
}

/// `planConfigWrite(inst, relative, ask)`: every refusal happens here, so the caller can snapshot
/// and write knowing the write is acceptable.
pub fn plan_config_write(inst: &Instance, relative: Option<&str>, ask: &WriteAsk) -> Result<Plan, Failure> {
    let whole = ask.content.is_some();
    let edit = ask.old_text.is_some() || ask.new_text.is_some();
    if whole == edit {
        return Err(Failure::user(
            "give either content (the whole new file) or old_text and new_text (one exact replacement), not both",
        ));
    }
    let as_str = |v: &Option<Value>| v.as_ref().and_then(Value::as_str).map(str::to_string);
    if edit {
        match (as_str(&ask.old_text), as_str(&ask.new_text)) {
            (Some(o), Some(_)) if !o.is_empty() => {}
            _ => {
                return Err(Failure::user(
                    "old_text and new_text are both needed, and old_text must not be empty",
                ));
            }
        }
    }
    let c = resolve_config_path(inst, relative, edit)?;
    let before = if c.exists {
        Some(read_text(&c.full, &c.shown)?)
    } else {
        None
    };
    let incoming = if whole {
        match ask.content.as_ref() {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'includes')",
                ));
            }
            _ => return Err(Failure::type_error("incoming.includes is not a function")),
        }
    } else {
        as_str(&ask.new_text).unwrap_or_default()
    };
    for ph in PLACEHOLDERS {
        if incoming.contains(ph) {
            return Err(Failure::user(format!(
                "the new text contains \"{ph}\", which is how SpawnLoft hides a value when it shows a file, not the value itself. Writing it would replace the real value. Change only the lines you mean to with old_text and new_text, leaving hidden values out; passwords and tokens are changed by the server owner, by hand."
            )));
        }
    }
    // a whole-file write over hidden values would drop or guess them, unless restoreHidden
    // already put them back from the file on disk
    if whole
        && !ask.hidden_restored
        && let Some(b) = &before
        && redact_config(b) != *b
    {
        return Err(Failure::user(format!(
            "{} has values SpawnLoft hides (passwords, tokens), so it is not rewritten whole. Use old_text and new_text to change the lines you mean to.",
            c.shown
        )));
    }
    let after = if whole {
        let mut after = incoming;
        if let Some(b) = &before {
            if b.contains("\r\n") && !after.contains("\r\n") {
                after = crlf(&after);
            }
            if starts_bom(b) && !starts_bom(&after) {
                after = format!("\u{feff}{after}");
            }
        }
        after
    } else {
        let b = before.clone().unwrap_or_default();
        let old = as_str(&ask.old_text).unwrap_or_default();
        let new = incoming;
        let is_crlf = b.contains("\r\n");
        let find = if is_crlf && !old.contains("\r\n") {
            crlf(&old)
        } else {
            old.clone()
        };
        let put = if is_crlf && !new.contains("\r\n") {
            crlf(&new)
        } else {
            new
        };
        let count = b.matches(find.as_str()).count();
        if count == 0 {
            let hint = if redact_config(&b).contains(old.as_str())
                || PLACEHOLDERS.iter().any(|ph| old.contains(ph))
            {
                " It includes a hidden value; passwords and tokens are changed by the server owner, by hand."
            } else {
                " Read the file again with read_config_file and copy the text exactly, including indentation."
            };
            return Err(Failure::user(format!(
                "old_text was not found in {}.{hint}",
                c.shown
            )));
        }
        if count > 1 {
            return Err(Failure::user(format!(
                "old_text appears {count} times in {}; include more of the surrounding lines so it matches once",
                c.shown
            )));
        }
        let at = b.find(find.as_str()).expect("found once");
        format!("{}{put}{}", &b[..at], &b[at + find.len()..])
    };
    if before.as_deref() == Some(after.as_str()) {
        return Err(Failure::user(format!("that leaves {} unchanged", c.shown)));
    }
    if after.len() as u64 > MAX_BYTES {
        return Err(Failure::user(format!(
            "the new {} would be over {} KB",
            c.shown,
            MAX_BYTES / 1024
        )));
    }
    check_format(&c.shown, &after)?;
    if c.shown.to_lowercase() == "server.properties" {
        let was = props::parse(before.as_deref().unwrap_or(""));
        let now = props::parse(&after);
        let differs = |k: &str| {
            js::trim(props::get(&was, k).unwrap_or("")) != js::trim(props::get(&now, k).unwrap_or(""))
        };
        let mut touched: Vec<&str> = MANAGED_PROPS.iter().copied().filter(|k| differs(k)).collect();
        if js::truthy(inst.get("bind")) && differs("server-ip") {
            touched.push("server-ip");
        }
        if !touched.is_empty() {
            return Err(Failure::user(format!(
                "{} in server.properties {} set by SpawnLoft at every start and would be put back. Ports and RCON are changed in SpawnLoft itself, where it can check the new port is free.",
                touched.join(", "),
                if touched.len() > 1 { "are" } else { "is" }
            )));
        }
    }
    Ok(Plan {
        full: c.full,
        shown: c.shown,
        existed: c.exists,
        before,
        after,
    })
}

/// `restoreHidden(before, shownText)`: for the panel's raw server.properties editor, which shows
/// the file redacted. A line still carrying a placeholder is matched to the line it was shown as
/// and given its real text back; a placeholder on any other line is refused.
pub fn restore_hidden(before: &str, shown_text: &str) -> Result<String, Failure> {
    let strip = |l: &str| l.strip_suffix('\r').unwrap_or(l).to_string();
    let redacted = redact_config(before);
    let shown: Vec<String> = redacted.split('\n').map(strip).collect();
    let real: Vec<String> = before.split('\n').map(strip).collect();
    let mut used = vec![false; shown.len()];
    let mut out = Vec::new();
    for line in shown_text.split('\n') {
        let bare = strip(line);
        if !PLACEHOLDERS.iter().any(|ph| bare.contains(ph)) {
            out.push(bare);
            continue;
        }
        let Some(at) = (0..shown.len()).find(|&i| !used[i] && shown[i] == bare) else {
            return Err(Failure::user(format!(
                "\"{}\" has a hidden value in it and is not a line of the file as it was shown. Hidden values - passwords and tokens - are changed by hand, in the file itself.",
                js::trim(&bare)
            )));
        };
        used[at] = true;
        out.push(real[at].clone());
    }
    Ok(out.join("\n"))
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// `checkFormat(shown, text)`: not a validator; it catches only what stops a config loading at
/// all. YAML indented with a tab, and JSON that does not parse.
pub fn check_format(shown: &str, text: &str) -> Result<(), Failure> {
    let ext = jspath::extname(shown).to_lowercase();
    if ext == ".yml" || ext == ".yaml" {
        let bad = split_lines(text)
            .iter()
            .position(|l| l.trim_start_matches(' ').starts_with('\t'));
        if let Some(i) = bad {
            return Err(Failure::user(format!(
                "line {} of the new {shown} is indented with a tab, which YAML does not allow; use spaces",
                i + 1
            )));
        }
    } else if ext == ".json" {
        let body = text.strip_prefix('\u{feff}').unwrap_or(text);
        if let Err(msg) = crate::jsjson::parse(body) {
            return Err(Failure::user(format!("the new {shown} is not valid JSON: {msg}")));
        }
    }
    Ok(())
}

/// `unchangedSince(plan)`: the file still holds what the plan was made from.
pub fn unchanged_since(plan: &Plan) -> Result<bool, Failure> {
    match std::fs::read(&plan.full) {
        Ok(b) => Ok(plan.before.as_deref() == Some(String::from_utf8_lossy(&b).as_ref())),
        Err(e) if jspath::is_enoent(&e) => Ok(plan.before.is_none()),
        Err(e) => Err(Failure::read(&e, &plan.full)),
    }
}

/// `applyConfigWrite(plan)`: through a temp file and a rename. server.properties carries
/// rcon.password, so an edit keeps it owner-only, as writeProps writes it.
pub fn apply_config_write(plan: &Plan) -> Result<(), Failure> {
    if let Some(parent) = plan.full.parent() {
        fsx::mkdir_all(parent)?;
    }
    let tmp = PathBuf::from(format!(
        "{}.spawnloft-{}.tmp",
        plan.full.display(),
        std::process::id()
    ));
    let private = jspath::basename(&plan.full.to_string_lossy()).to_lowercase() == "server.properties";
    let wrote = if private {
        crate::private_files::write(&tmp, plan.after.as_bytes(), crate::private_files::PRIVATE_MODE)
            .map(|_| ())
    } else {
        std::fs::write(&tmp, plan.after.as_bytes())
    };
    wrote.map_err(|e| Failure::io(&e, "open", Some(&tmp)))?;
    if let Err(e) = fsx::rename_over(&tmp, &plan.full) {
        let _ = std::fs::remove_file(&tmp);
        return Err(fsx::rename_failure(&e, &tmp, &plan.full));
    }
    Ok(())
}

/// `summarizeChange(before, after, maxLines)`: the changed lines as read_config_file shows the
/// file, secrets redacted.
pub fn summarize_change(before: Option<&str>, after: &str, max_lines: usize) -> String {
    let unbom = |s: &str| s.strip_prefix('\u{feff}').unwrap_or(s).to_string();
    let ra = redact_config(&unbom(before.unwrap_or("")));
    let rb = redact_config(&unbom(after));
    let a = split_lines(&ra);
    let b = split_lines(&rb);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len() as isize - 1, b.len() as isize - 1);
    let s = start as isize;
    while end_a >= s && end_b >= s && a[end_a as usize] == b[end_b as usize] {
        end_a -= 1;
        end_b -= 1;
    }
    let mut out = vec![format!("@@ line {} @@", start + 1)];
    if start > 0 {
        out.push(format!("  {}", a[start - 1]));
    }
    for l in &a[start..(end_a + 1) as usize] {
        out.push(format!("- {l}"));
    }
    for l in &b[start..(end_b + 1) as usize] {
        out.push(format!("+ {l}"));
    }
    if ((end_a + 1) as usize) < a.len() {
        out.push(format!("  {}", a[(end_a + 1) as usize]));
    }
    if out.len() > max_lines {
        let more = out.len() - max_lines;
        let mut cut: Vec<String> = out.into_iter().take(max_lines).collect();
        cut.push(format!("... {more} more line(s)"));
        cut.join("\n")
    } else {
        out.join("\n")
    }
}
