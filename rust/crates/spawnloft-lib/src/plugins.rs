//! `plugins.mjs` (C5): a server's installed plugins or mods, read straight out of their jars
//! (spawnloft-lib zip.rs `jar`, the readers of `plugins.mjs`), the record of the jars SpawnLoft
//! installed (`.mcctl-plugins.json`), and turning one off or on by renaming it to and from
//! `<file>.jar.disabled`. The Modrinth and Hangar clients are in `modrinth.rs`.

use std::cmp::Ordering;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::activity::{self, Actor};
use crate::failure::Failure;
use crate::registry::Instance;
use crate::{collate, js, jspath};

/// `mcVersionOf(inst)`: the recorded `mcVersion` (as `String()` prints it), else the version the
/// jar's name carries.
pub fn mc_version_of(inst: &Instance) -> Option<String> {
    let recorded = inst.get("mcVersion");
    if js::truthy(recorded) {
        return Some(js::string(recorded));
    }
    match inst.get("jar") {
        v if js::truthy(v) => crate::software::version_from_jar(&js::string(v)),
        _ => None,
    }
}

/// Paper also runs Spigot and Bukkit plugins (`LOADERS`).
pub const LOADERS: [&str; 4] = ["paper", "spigot", "bukkit", "folia"];

/// `contentKindFor(inst)`: Bukkit-family servers load `plugins/`, mod loaders load `mods/`,
/// vanilla loads nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentKind {
    pub dir: &'static str,
    pub kind: &'static str,
    pub word: &'static str,
    pub project_type: &'static str,
    pub hangar: bool,
    pub label: &'static str,
}

pub fn content_kind_for(inst: &Instance) -> ContentKind {
    let sw = crate::software::software_of(inst.get("loader"));
    let (dir, kind, word, project_type, hangar) = match sw.content {
        "mods" => ("mods", "mods", "mod", "mod", false),
        "none" => ("plugins", "none", "plugin", "plugin", false),
        _ => ("plugins", "plugins", "plugin", "plugin", sw.hangar),
    };
    ContentKind {
        dir,
        kind,
        word,
        project_type,
        hangar,
        label: sw.label,
    }
}

/// `loadersFor(inst)`: the Modrinth loader facet, Paper's family when the software has none.
pub fn loaders_for(inst: &Instance) -> Vec<&'static str> {
    let sw = crate::software::software_of(inst.get("loader"));
    if sw.modrinth.is_empty() {
        LOADERS.to_vec()
    } else {
        sw.modrinth.to_vec()
    }
}

fn dir_of(inst: &Instance) -> Result<&str, Failure> {
    crate::create::path_arg(inst.get("dir"), "path")
}

/// `pluginsDir(inst)`.
pub fn plugins_dir(inst: &Instance) -> Result<String, Failure> {
    Ok(jspath::join(&[dir_of(inst)?, content_kind_for(inst).dir]))
}

/// The record of the jars SpawnLoft installed, kept in the plugins folder (the server ignores
/// files that are not jars) so snapshots carry it.
pub const STORE: &str = ".mcctl-plugins.json";

/// `readJson(file, null)`: `None` when the file is not there; one that does not parse fails as
/// `JSON.parse` does.
fn read_json(file: &str) -> Result<Option<Value>, Failure> {
    crate::client::read_json(file)
}

/// `readManaged(inst)`: the store as read, or `{ version: 1, managed: {} }` when it is missing
/// or its `managed` is not an object. (An array passes `typeof === 'object'` in Node and is kept:
/// it holds no jar names, and a jar recorded into it is dropped when the store is written.)
pub fn read_managed(inst: &Instance) -> Result<Value, Failure> {
    let file = jspath::join(&[&plugins_dir(inst)?, STORE]);
    let store = read_json(&file)?;
    match store {
        Some(Value::Object(m)) if matches!(m.get("managed"), Some(Value::Object(_) | Value::Array(_))) => {
            Ok(Value::Object(m))
        }
        _ => Ok(json!({ "version": 1, "managed": {} })),
    }
}

/// `readManaged(inst).managed[file]`: the record of one jar, if it has one.
pub fn managed_entry(store: &Value, file: &str) -> Option<Value> {
    match store.get("managed") {
        Some(Value::Object(m)) => m.get(file).cloned(),
        _ => None,
    }
}

fn write_managed(inst: &Instance, store: &Value) -> Result<(), Failure> {
    let file = jspath::join(&[&plugins_dir(inst)?, STORE]);
    crate::client::write_json(&file, store)
}

/// `recordManaged(inst, file, meta)`.
pub fn record_managed(inst: &Instance, file: &str, meta: Value) -> Result<(), Failure> {
    let mut store = read_managed(inst)?;
    if let Some(Value::Object(m)) = store.get_mut("managed") {
        m.insert(file.to_string(), meta);
    }
    write_managed(inst, &store)
}

/// `forgetManaged(inst, file)`.
pub fn forget_managed(inst: &Instance, file: &str) -> Result<(), Failure> {
    let mut store = read_managed(inst)?;
    let removed = match store.get_mut("managed") {
        Some(Value::Object(m)) => m.shift_remove(file).is_some(),
        // `delete arr[i]` leaves a hole, which the store is written with as null
        Some(Value::Array(a)) => match file.parse::<usize>() {
            Ok(i) if crate::jsjson::is_index_key(file) && i < a.len() => {
                a[i] = Value::Null;
                true
            }
            _ => false,
        },
        _ => false,
    };
    if removed {
        write_managed(inst, &store)?;
    }
    Ok(())
}

/// `moveManaged(inst, from, to)`: the record follows a rename (to the end of the list, as a new
/// key goes in JavaScript).
fn move_managed(inst: &Instance, from: &str, to: &str) -> Result<(), Failure> {
    let mut store = read_managed(inst)?;
    let moved = match store.get_mut("managed") {
        Some(Value::Object(m)) => match m.get(from).cloned() {
            Some(entry) => {
                m.insert(to.to_string(), entry);
                if from != to {
                    m.shift_remove(from);
                }
                true
            }
            None => false,
        },
        _ => false,
    };
    if moved {
        write_managed(inst, &store)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Manifests

/// The characters JavaScript's `.` does not match (line terminators).
fn is_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            let end = if i > start && bytes[i - 1] == b'\r' {
                i - 1
            } else {
                i
            };
            out.push(&text[start..end]);
            start = i + 1;
        }
    }
    out.push(&text[start..]);
    out
}

fn starts_with_space(s: &str) -> bool {
    s.chars().next().is_some_and(js::is_js_space)
}

/// `/^([\w.-]+):\s*(.*)$/` on one line: the key and the value as `(.*)` takes it.
fn yml_key_line(line: &str) -> Option<(&str, &str)> {
    let key_end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'))
        .unwrap_or(line.len());
    if key_end == 0 || !line[key_end..].starts_with(':') {
        return None;
    }
    let rest = line[key_end + 1..].trim_start_matches(js::is_js_space);
    // `(.*)$` cannot cross a line terminator, and giving `\s*`'s characters back cannot help
    if rest.contains(is_terminator) {
        return None;
    }
    Some((&line[..key_end], rest))
}

/// `unquote(v)`.
fn unquote(v: &str) -> String {
    let t = js::trim(v);
    let quoted = (t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\''));
    if quoted {
        // `slice(1, -1)`: a lone quote is empty
        if t.len() >= 2 {
            t[1..t.len() - 1].to_string()
        } else {
            String::new()
        }
    } else {
        t.to_string()
    }
}

/// `parsePluginYml(text)`: the top-level scalars and simple lists of a plugin.yml. Not a YAML
/// parser: nested blocks are skipped and anything unreadable is left out. Keys are lower case.
pub fn parse_plugin_yml(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let lines = split_lines(text);
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() || starts_with_space(line) || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = yml_key_line(line) else {
            continue;
        };
        let key = key.to_lowercase();
        let value = js::trim(raw);
        if matches!(value, "" | "|" | ">" | "|-" | ">-") {
            // a block: a list, a folded scalar, or a nested map (skipped)
            let mut block: Vec<&str> = Vec::new();
            let mut j = i + 1;
            while j < lines.len() && (starts_with_space(lines[j]) || lines[j].is_empty()) {
                let t = js::trim(lines[j]);
                if !t.is_empty() {
                    block.push(t);
                }
                j += 1;
            }
            if block.iter().all(|b| b.starts_with("- ")) {
                let items = block.iter().map(|b| json!(unquote(&b[2..]))).collect();
                out.insert(key, Value::Array(items));
            } else if !value.is_empty() && !block.is_empty() {
                out.insert(key, json!(block.join(" ")));
            }
            continue;
        }
        if value.starts_with('[') && value.ends_with(']') && value.len() >= 2 {
            let items = value[1..value.len() - 1]
                .split(',')
                .map(unquote)
                .filter(|s| !s.is_empty())
                .map(Value::String)
                .collect();
            out.insert(key, Value::Array(items));
            continue;
        }
        out.insert(key, json!(unquote(value)));
    }
    out
}

/// `/^(\w+)\s*=\s*(.+)$/` on a trimmed line.
fn toml_key_line(line: &str) -> Option<(&str, &str)> {
    let key_end = line
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(line.len());
    if key_end == 0 {
        return None;
    }
    let after = line[key_end..].trim_start_matches(js::is_js_space);
    let after = after.strip_prefix('=')?;
    let rest = after.trim_start_matches(js::is_js_space);
    if rest.is_empty() {
        // `.+` takes back one of `\s*`'s characters, unless it is a terminator; the line is
        // trimmed, so nothing that is not one can be there
        let last = after.chars().next_back()?;
        return (!is_terminator(last)).then_some((&line[..key_end], &after[after.len() - last.len_utf8()..]));
    }
    if rest.contains(is_terminator) {
        return None;
    }
    Some((&line[..key_end], rest))
}

/// `value.replace(/\s#.*$/, '')`: the first whitespace-and-hash whose rest holds no line
/// terminator, and everything after it.
fn strip_toml_comment(value: &str) -> &str {
    let chars: Vec<(usize, char)> = value.char_indices().collect();
    for (n, (at, c)) in chars.iter().enumerate() {
        if js::is_js_space(*c)
            && chars.get(n + 1).is_some_and(|(_, h)| *h == '#')
            && !value[chars[n + 1].0..].contains(is_terminator)
        {
            return &value[..*at];
        }
    }
    value
}

/// `s.slice(0, -1)` in UTF-16 units: everything but the last unit.
fn drop_last_unit(s: &str) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16_lossy(&units[..units.len().saturating_sub(1)])
}

/// A mod's manifest as `listPlugins` reads it: the fields it takes, as JavaScript values.
pub type Meta = Map<String, Value>;

/// `parseModsToml(text, { jarVersion })`: the scalar fields of the first `[[mods]]` block of a
/// NeoForge manifest. A version of `${file.jarVersion}` means the one in the jar's MANIFEST.MF.
pub fn parse_mods_toml(text: &str, jar_version: Option<&str>) -> Option<Meta> {
    let lines = split_lines(text);
    let start = lines.iter().position(|l| js::trim(l) == "[[mods]]")?;
    let mut out: Map<String, Value> = Map::new();
    let mut i = start + 1;
    while i < lines.len() {
        let line = js::trim(lines[i]);
        if line.starts_with('[') {
            break;
        }
        if let Some((key, raw)) = toml_key_line(line) {
            let mut value = js::trim(raw).to_string();
            if value.starts_with("'''") || value.starts_with("\"\"\"") {
                let quote = value[..3].to_string();
                let mut body = value[3..].to_string();
                while i + 1 < lines.len() && !body.contains(&quote) {
                    i += 1;
                    body.push('\n');
                    body.push_str(lines[i]);
                }
                value = match body.find(&quote) {
                    Some(at) => js::trim(&body[..at]).to_string(),
                    None => js::trim(&drop_last_unit(&body)).to_string(),
                };
            } else {
                value = js::trim(strip_toml_comment(&value)).to_string();
                let quoted = (value.starts_with('"') && value.ends_with('"'))
                    || (value.starts_with('\'') && value.ends_with('\''));
                if quoted {
                    value = if value.len() >= 2 {
                        value[1..value.len() - 1].to_string()
                    } else {
                        String::new()
                    };
                }
            }
            out.insert(key.to_string(), json!(value));
        }
        i += 1;
    }
    let text_of = |k: &str| out.get(k).and_then(Value::as_str).map(str::to_string);
    let mut version = text_of("version");
    if version
        .as_deref()
        .is_some_and(|v| !v.is_empty() && v.contains("${"))
    {
        version = jar_version.map(str::to_string);
    }
    let display = text_of("displayName").filter(|s| !s.is_empty());
    let mod_id = text_of("modId");
    let mut meta = Map::new();
    meta.insert(
        "name".into(),
        display.or(mod_id.clone()).map_or(Value::Null, Value::String),
    );
    meta.insert("modId".into(), mod_id.map_or(Value::Null, Value::String));
    meta.insert("version".into(), version.map_or(Value::Null, Value::String));
    meta.insert(
        "description".into(),
        text_of("description").map_or(Value::Null, Value::String),
    );
    let authors = match text_of("authors") {
        Some(a) if !a.is_empty() => vec![json!(a)],
        _ => Vec::new(),
    };
    meta.insert("authors".into(), Value::Array(authors));
    Some(meta)
}

/// `/^Implementation-Version:\s*(.+)$/m` over a MANIFEST.MF, trimmed.
fn implementation_version(mf: &str) -> Option<String> {
    const KEY: &str = "Implementation-Version:";
    let mut at = 0;
    while at <= mf.len() {
        let line_start = at == 0 || mf[..at].ends_with(is_terminator);
        if line_start && mf[at..].starts_with(KEY) {
            let after = &mf[at + KEY.len()..];
            let ws_end = after.len() - after.trim_start_matches(js::is_js_space).len();
            let rest = &after[ws_end..];
            let taken = rest.split(is_terminator).next().unwrap_or("");
            if !taken.is_empty() {
                return Some(js::trim(taken).to_string());
            }
            // `.+` takes back the last of `\s*`'s characters that is not a terminator
            let ws = &after[..ws_end];
            if let Some((i, _)) = ws.char_indices().rev().find(|(_, c)| !is_terminator(*c)) {
                let run = ws[i..].split(is_terminator).next().unwrap_or("");
                return Some(js::trim(run).to_string());
            }
        }
        match mf[at..].chars().next() {
            Some(c) => at += c.len_utf8(),
            None => break,
        }
    }
    None
}

fn read_neoforge_manifest(full: &Path) -> Result<Option<Meta>, Failure> {
    let raw = match crate::zip::jar::read_entry(full, "META-INF/neoforge.mods.toml")? {
        Some(r) => Some(r),
        None => crate::zip::jar::read_entry(full, "META-INF/mods.toml")?,
    };
    let Some(raw) = raw else {
        return Ok(None);
    };
    let jar_version = match crate::zip::jar::read_entry(full, "META-INF/MANIFEST.MF")? {
        Some(mf) => implementation_version(&String::from_utf8_lossy(&mf)),
        None => None,
    };
    Ok(parse_mods_toml(
        &String::from_utf8_lossy(&raw),
        jar_version.as_deref(),
    ))
}

/// `x?.[key]` on a parsed JSON value: only objects have fields.
fn field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Object(m) => m.get(key),
        _ => None,
    }
}

/// `a || b` over JavaScript values (`undefined` is `None`).
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if js::truthy(a) { a } else { b }
}

fn read_fabric_manifest(full: &Path) -> Result<Option<Meta>, Failure> {
    let Some(raw) = crate::zip::jar::read_entry(full, "fabric.mod.json")? else {
        return Ok(None);
    };
    let Ok(data) = crate::jsjson::parse(&String::from_utf8_lossy(&raw)) else {
        return Ok(None);
    };
    if data.is_null() {
        // `data.authors` throws on null: the jar is listed by its file name
        return Err(Failure::type_error(
            "Cannot read properties of null (reading 'authors')",
        ));
    }
    // authors are strings or { name } objects, sometimes both
    let authors: Vec<Value> = match field(&data, "authors") {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|a| match a {
                Value::String(_) => Some(a.clone()),
                other => field(other, "name").cloned(),
            })
            .filter(|a| js::truthy(Some(a)))
            .collect(),
        _ => Vec::new(),
    };
    let mut meta = Map::new();
    let put = |meta: &mut Map<String, Value>, k: &str, v: Option<&Value>| {
        if let Some(v) = v {
            meta.insert(k.into(), v.clone());
        }
    };
    put(&mut meta, "name", or(field(&data, "name"), field(&data, "id")));
    meta.insert(
        "modId".into(),
        match field(&data, "id") {
            Some(Value::String(s)) => json!(s),
            _ => Value::Null,
        },
    );
    put(&mut meta, "version", field(&data, "version"));
    put(&mut meta, "description", field(&data, "description"));
    meta.insert("authors".into(), Value::Array(authors));
    put(
        &mut meta,
        "website",
        field(&data, "contact").and_then(|c| field(c, "homepage")),
    );
    Ok(Some(meta))
}

/// The manifest of one jar: plugin.yml or paper-plugin.yml, else fabric.mod.json, else a NeoForge
/// mods.toml; `{}` when none is there or the jar cannot be read.
fn manifest_of(full: &Path) -> Meta {
    let read = || -> Result<Meta, Failure> {
        let yml = match crate::zip::jar::read_entry(full, "plugin.yml")? {
            Some(y) => Some(y),
            None => crate::zip::jar::read_entry(full, "paper-plugin.yml")?,
        };
        if let Some(yml) = yml {
            return Ok(parse_plugin_yml(&String::from_utf8_lossy(&yml)));
        }
        if let Some(m) = read_fabric_manifest(full)? {
            return Ok(m);
        }
        Ok(read_neoforge_manifest(full)?.unwrap_or_default())
    };
    read().unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// The list

const DISABLED: &str = ".disabled";

/// `a ?? null` over a JavaScript value.
fn or_null(v: Option<&Value>) -> Value {
    match v {
        None => Value::Null,
        Some(v) => v.clone(),
    }
}

/// `a || null`.
fn truthy_or_null(v: Option<&Value>) -> Value {
    if js::truthy(v) { or_null(v) } else { Value::Null }
}

/// `listPlugins(inst)`: every `.jar` and `.jar.disabled` in the plugins folder, with what its
/// manifest says and what SpawnLoft recorded about it, sorted by name (`sensitivity: 'base'`).
/// A jar with no readable manifest is still listed, by file name. Each row is the object Node
/// builds, keys in its order.
pub fn list_plugins(inst: &Instance) -> Result<Vec<Value>, Failure> {
    let dir = plugins_dir(inst)?;
    let entries = match crate::fsx::readdir_names(Path::new(&dir)) {
        Ok(e) => e,
        Err(e) if jspath::is_enoent(&e) => return Ok(Vec::new()),
        Err(e) => return Err(Failure::io(&e, "scandir", Some(Path::new(&dir)))),
    };
    let store = read_managed(inst)?;
    let mut rows = Vec::new();
    for file in entries {
        let enabled = file.ends_with(".jar");
        if !enabled && !file.ends_with(".jar.disabled") {
            continue;
        }
        let full = jspath::join(&[&dir, &file]);
        let meta = manifest_of(Path::new(&full));
        let st = std::fs::metadata(&full).map_err(|e| Failure::io(&e, "stat", Some(Path::new(&full))))?;
        let record = managed_entry(&store, &file);
        let rec = record.as_ref();
        let rf = |k: &str| rec.and_then(|r| field(r, k));
        let m = |k: &str| meta.get(k);
        let stem = file
            .strip_suffix(".jar.disabled")
            .or_else(|| file.strip_suffix(".jar"))
            .unwrap_or(&file)
            .to_string();
        let authors = if js::truthy(m("authors")) {
            or_null(m("authors"))
        } else if js::truthy(m("author")) {
            json!([m("author").cloned().unwrap_or(Value::Null)])
        } else {
            json!([])
        };
        let mut row = Map::new();
        row.insert("file".into(), json!(file));
        row.insert("enabled".into(), json!(enabled));
        // managed = SpawnLoft installed it; jars dropped in by hand are listed but never managed
        row.insert("managed".into(), json!(js::truthy(rec)));
        row.insert("source".into(), or_null(rf("source")));
        row.insert("project".into(), or_null(rf("project")));
        row.insert("installedVersion".into(), or_null(rf("version")));
        row.insert(
            "gameVersions".into(),
            match rf("gameVersions") {
                Some(v @ Value::Array(_)) => v.clone(),
                _ => Value::Null,
            },
        );
        row.insert("modId".into(), truthy_or_null(m("modId")));
        row.insert(
            "name".into(),
            if js::truthy(m("name")) {
                or_null(m("name"))
            } else {
                json!(stem)
            },
        );
        row.insert("version".into(), truthy_or_null(m("version")));
        row.insert("description".into(), truthy_or_null(m("description")));
        row.insert("authors".into(), authors);
        row.insert("apiVersion".into(), truthy_or_null(m("api-version")));
        row.insert("website".into(), truthy_or_null(m("website")));
        row.insert("size".into(), crate::jsjson::num(st.len() as f64));
        row.insert(
            "mtime".into(),
            json!(crate::time::iso(crate::backup::mtime_ms(&st) as i64)),
        );
        rows.push(Value::Object(row));
    }
    js_sort(&mut rows, |a, b| {
        // `a.name.localeCompare(b.name, ...)`: `b` is turned into text, `a` must be text
        match a.get("name") {
            Some(Value::String(an)) => Ok(collate::compare_base(an, &js::string(b.get("name")))),
            _ => Err(Failure::type_error("a.name.localeCompare is not a function")),
        }
    })?;
    Ok(rows)
}

/// `Array.prototype.sort` with a comparator that can throw, as V8 runs it: the first run counted
/// (and reversed when strictly descending), then a binary insertion of the rest. For fewer than
/// 64 items that is V8's TimSort exactly; beyond, it gives the same order (the sort is stable)
/// and differs only in which comparisons are made, so a comparator that throws for one item can
/// throw here where V8's merge never reached it (declared difference `sort-comparisons-over-64`).
pub fn js_sort<T: Clone>(
    items: &mut [T],
    mut cmp: impl FnMut(&T, &T) -> Result<Ordering, Failure>,
) -> Result<(), Failure> {
    let n = items.len();
    if n < 2 {
        return Ok(());
    }
    let mut run = 2;
    if cmp(&items[1], &items[0])? == Ordering::Less {
        while run < n && cmp(&items[run], &items[run - 1])? == Ordering::Less {
            run += 1;
        }
        items[..run].reverse();
    } else {
        while run < n && cmp(&items[run], &items[run - 1])? != Ordering::Less {
            run += 1;
        }
    }
    for i in run..n {
        let pivot = items[i].clone();
        let (mut left, mut right) = (0, i);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(&pivot, &items[mid])? == Ordering::Less {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        items[left..=i].rotate_right(1);
    }
    Ok(())
}

/// `safePluginPath(dir, file)`: the name arrives over HTTP; only a plain jar name inside the
/// plugins folder is allowed.
pub(crate) fn safe_plugin_path(dir: &str, file: &str) -> Result<String, Failure> {
    let stem = file
        .strip_suffix(".jar.disabled")
        .or_else(|| file.strip_suffix(".jar"));
    let plain = stem.is_some_and(|s| !s.is_empty() && !s.contains(['\\', '/']));
    if !plain || file.contains("..") {
        return Err(Failure::user(format!("\"{file}\" is not a plugin file name")));
    }
    let full = jspath::join(&[dir, file]);
    if !Path::new(&full).exists() {
        return Err(Failure::user(format!("no plugin file \"{file}\" in {dir}")));
    }
    Ok(full)
}

/// The answer of [`set_plugin_enabled`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switched {
    pub file: String,
    pub enabled: bool,
}

/// `setPluginEnabled(inst, file, enabled)`: renames `<file>.jar` to and from `.jar.disabled`,
/// and the record follows.
pub fn set_plugin_enabled(
    data_root: &str,
    by: &Actor,
    inst: &Instance,
    file: &str,
    enabled: bool,
) -> Result<Switched, Failure> {
    let dir = plugins_dir(inst)?;
    let current = safe_plugin_path(&dir, file)?;
    let is_on = file.ends_with(".jar");
    if is_on == enabled {
        return Ok(Switched {
            file: file.to_string(),
            enabled: is_on,
        });
    }
    let next = if enabled {
        file[..file.len() - DISABLED.len()].to_string()
    } else {
        format!("{file}{DISABLED}")
    };
    let to = jspath::join(&[&dir, &next]);
    std::fs::rename(&current, &to).map_err(|e| {
        let (code, text) = jspath::error_code(&e);
        Failure::Internal {
            head: "Error".into(),
            message: format!("{code}: {text}, rename '{current}' -> '{to}'"),
            code: Some(code.into()),
        }
    })?;
    move_managed(inst, file, &next)?;
    activity::record_by(
        &crate::paths::Roots::new(data_root),
        by,
        &inst.name,
        if enabled {
            "plugin-enable"
        } else {
            "plugin-disable"
        },
        Some(file.strip_suffix(DISABLED).unwrap_or(file)),
        None,
        true,
    );
    Ok(Switched { file: next, enabled })
}

/// `removePlugin(inst, file)`.
pub fn remove_plugin(data_root: &str, by: &Actor, inst: &Instance, file: &str) -> Result<(), Failure> {
    let dir = plugins_dir(inst)?;
    let full = safe_plugin_path(&dir, file)?;
    match std::fs::remove_file(&full) {
        Ok(()) => {}
        Err(e) if jspath::is_enoent(&e) => {}
        Err(e) => return Err(Failure::io(&e, "rm", Some(Path::new(&full)))),
    }
    forget_managed(inst, file)?;
    activity::record_by(
        &crate::paths::Roots::new(data_root),
        by,
        &inst.name,
        "plugin-remove",
        Some(file),
        None,
        true,
    );
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
