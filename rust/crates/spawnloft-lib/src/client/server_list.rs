//! `client-server-list.mjs`: the game's own Multiplayer list (servers.dat in a profile's folder),
//! kept in step with the SpawnLoft servers on the profile's version. The file is the player's:
//! every entry SpawnLoft did not write stays as it is, byte for byte, and an entry SpawnLoft
//! wrote that the player then edited or deleted is theirs from then on. A file that cannot be
//! read whole is never written.

use serde_json::{Map, Value, json};

use super::prop;
use crate::failure::Failure;
use crate::js;

// NBT, as the game writes servers.dat: uncompressed, big-endian. Strings and compound keys keep
// their bytes (Java's modified UTF-8) and arrays their payload, so what is not touched is written
// back exactly as it was read.
const END: u8 = 0;
const BYTE: u8 = 1;
const STRING: u8 = 8;
const LIST: u8 = 9;
const COMPOUND: u8 = 10;
const MAX_DEPTH: usize = 64;
/// The game's own list, icons included, is a few hundred KB at most.
pub const MAX_SERVERS_DAT: u64 = 4 * 1024 * 1024;
const MAX_TAGS: usize = 100_000;

fn fixed_size(t: u8) -> Option<usize> {
    match t {
        1 => Some(1),
        2 => Some(2),
        3 => Some(4),
        4 => Some(8),
        5 => Some(4),
        6 => Some(8),
        _ => None,
    }
}

fn array_unit(t: u8) -> Option<usize> {
    match t {
        7 => Some(1),
        11 => Some(4),
        12 => Some(8),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tag {
    Fixed { kind: u8, raw: Vec<u8> },
    Array { kind: u8, count: i32, raw: Vec<u8> },
    Str(Vec<u8>),
    List { of: u8, items: Vec<Tag> },
    Compound(Vec<(Vec<u8>, Tag)>),
}

impl Tag {
    fn kind(&self) -> u8 {
        match self {
            Tag::Fixed { kind, .. } | Tag::Array { kind, .. } => *kind,
            Tag::Str(_) => STRING,
            Tag::List { .. } => LIST,
            Tag::Compound(_) => COMPOUND,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nbt {
    pub name: Vec<u8>,
    pub root: Vec<(Vec<u8>, Tag)>,
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
    tags: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        if self.at + n > self.buf.len() {
            return Err("the file ends in the middle of a tag".into());
        }
        let out = &self.buf[self.at..self.at + n];
        self.at += n;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<usize, String> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]) as usize)
    }
    fn i32(&mut self) -> Result<i32, String> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn payload(&mut self, kind: u8, depth: usize) -> Result<Tag, String> {
        if depth > MAX_DEPTH {
            return Err("tags nested too deep".into());
        }
        self.tags += 1;
        if self.tags > MAX_TAGS {
            return Err("more tags than a server list holds".into());
        }
        if let Some(n) = fixed_size(kind) {
            return Ok(Tag::Fixed {
                kind,
                raw: self.take(n)?.to_vec(),
            });
        }
        if let Some(unit) = array_unit(kind) {
            let n = self.i32()?;
            if n < 0 {
                return Err("the file ends in the middle of a tag".into());
            }
            let len = (n as usize)
                .checked_mul(unit)
                .ok_or("the file ends in the middle of a tag")?;
            return Ok(Tag::Array {
                kind,
                count: n,
                raw: self.take(len)?.to_vec(),
            });
        }
        match kind {
            STRING => {
                let n = self.u16()?;
                Ok(Tag::Str(self.take(n)?.to_vec()))
            }
            LIST => {
                let of = self.u8()?;
                let n = self.i32()?;
                if n < 0 || (n > 0 && of == END) {
                    return Err("a list of nothing with items in it".into());
                }
                let mut items = Vec::new();
                for _ in 0..n {
                    items.push(self.payload(of, depth + 1)?);
                }
                Ok(Tag::List { of, items })
            }
            COMPOUND => {
                let mut entries = Vec::new();
                loop {
                    let t = self.u8()?;
                    if t == END {
                        break;
                    }
                    let n = self.u16()?;
                    let key = self.take(n)?.to_vec();
                    entries.push((key, self.payload(t, depth + 1)?));
                }
                Ok(Tag::Compound(entries))
            }
            other => Err(format!("unknown tag type {other}")),
        }
    }
}

/// `readNbt(buf)`.
pub fn read_nbt(buf: &[u8]) -> Result<Nbt, String> {
    let mut r = Reader { buf, at: 0, tags: 0 };
    let kind = r.u8()?;
    if kind != COMPOUND {
        return Err("not an NBT file (it does not start with a compound tag)".into());
    }
    let n = r.u16()?;
    let name = r.take(n)?.to_vec();
    let Tag::Compound(root) = r.payload(COMPOUND, 0)? else {
        unreachable!("a compound payload");
    };
    if r.at != buf.len() {
        return Err("bytes left over after the last tag".into());
    }
    Ok(Nbt { name, root })
}

fn write_payload(out: &mut Vec<u8>, tag: &Tag) {
    match tag {
        Tag::Fixed { raw, .. } => out.extend_from_slice(raw),
        Tag::Array { count, raw, .. } => {
            out.extend_from_slice(&count.to_be_bytes());
            out.extend_from_slice(raw);
        }
        Tag::Str(raw) => {
            out.extend_from_slice(&(raw.len() as u16).to_be_bytes());
            out.extend_from_slice(raw);
        }
        Tag::List { of, items } => {
            out.push(*of);
            out.extend_from_slice(&(items.len() as i32).to_be_bytes());
            for item in items {
                write_payload(out, item);
            }
        }
        Tag::Compound(entries) => {
            for (key, child) in entries {
                out.push(child.kind());
                out.extend_from_slice(&(key.len() as u16).to_be_bytes());
                out.extend_from_slice(key);
                write_payload(out, child);
            }
            out.push(END);
        }
    }
}

/// `writeNbt(doc)`.
pub fn write_nbt(doc: &Nbt) -> Vec<u8> {
    let mut out = vec![COMPOUND];
    out.extend_from_slice(&(doc.name.len() as u16).to_be_bytes());
    out.extend_from_slice(&doc.name);
    write_payload(&mut out, &Tag::Compound(doc.root.clone()));
    out
}

/// `mutf8(text)`: Java's modified UTF-8, one UTF-16 unit at a time, U+0000 as two bytes.
pub fn mutf8(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for c in text.encode_utf16() {
        let c = c as u32;
        if (0x01..=0x7f).contains(&c) {
            out.push(c as u8);
        } else if c <= 0x7ff {
            out.push((0xc0 | (c >> 6)) as u8);
            out.push((0x80 | (c & 0x3f)) as u8);
        } else {
            out.push((0xe0 | (c >> 12)) as u8);
            out.push((0x80 | ((c >> 6) & 0x3f)) as u8);
            out.push((0x80 | (c & 0x3f)) as u8);
        }
    }
    out
}

/// `fromMutf8(raw)`, as UTF-16 units decoded the way `String.fromCharCode` joins them.
pub fn from_mutf8(raw: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let a = raw[i] as u32;
        if a < 0x80 {
            units.push(a as u16);
            i += 1;
        } else if a & 0xe0 == 0xc0 && i + 1 < raw.len() {
            units.push((((a & 0x1f) << 6) | (raw[i + 1] as u32 & 0x3f)) as u16);
            i += 2;
        } else if a & 0xf0 == 0xe0 && i + 2 < raw.len() {
            units.push(
                (((a & 0x0f) << 12) | ((raw[i + 1] as u32 & 0x3f) << 6) | (raw[i + 2] as u32 & 0x3f)) as u16,
            );
            i += 3;
        } else {
            units.push(0xfffd);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

fn child<'a>(entries: &'a [(Vec<u8>, Tag)], key: &str) -> Option<&'a Tag> {
    entries.iter().find(|(k, _)| from_mutf8(k) == key).map(|(_, t)| t)
}

fn text_of(entries: &[(Vec<u8>, Tag)], key: &str) -> Option<String> {
    match child(entries, key) {
        Some(Tag::Str(raw)) => Some(from_mutf8(raw)),
        _ => None,
    }
}

fn set_text(entries: &mut Vec<(Vec<u8>, Tag)>, key: &str, value: &str) {
    match entries.iter().position(|(k, _)| from_mutf8(k) == key) {
        None => entries.push((mutf8(key), Tag::Str(mutf8(value)))),
        Some(at) => entries[at].1 = Tag::Str(mutf8(value)),
    }
}

/// `addressKey(ip)`: two spellings of one place (the port the game assumes, and this machine by
/// either name) are one key.
pub fn address_key(ip: Option<&str>) -> String {
    let raw = js::trim(ip.unwrap_or("")).to_lowercase();
    let mut host = raw.clone();
    let mut port = "25565".to_string();
    let v6 = raw
        .strip_prefix('[')
        .and_then(|r| r.split_once(']'))
        .filter(|(h, rest)| {
            !h.is_empty()
                && !h.contains(']')
                && (rest.is_empty()
                    || rest
                        .strip_prefix(':')
                        .is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())))
        });
    if let Some((h, rest)) = v6 {
        host = h.to_string();
        if let Some(p) = rest.strip_prefix(':') {
            port = p.to_string();
        }
    } else if raw.split(':').count() == 2 {
        let (h, p) = raw.split_once(':').expect("two parts");
        host = h.to_string();
        port = p.to_string();
    }
    if let Some(h) = host.strip_suffix('.') {
        host = h.to_string();
    }
    if host == "localhost" || host == "::1" {
        host = "127.0.0.1".into();
    }
    let n = js::string_to_number(&port);
    let port = if n != 0.0 && !n.is_nan() {
        js::number_to_string(n)
    } else {
        port
    };
    format!("{host}:{port}")
}

fn hidden(entry: &Tag) -> bool {
    let Tag::Compound(e) = entry else {
        return false;
    };
    matches!(child(e, "hidden"), Some(Tag::Fixed { kind: BYTE, raw }) if raw[0] != 0)
}

fn shown(entry: &Tag) -> bool {
    matches!(entry, Tag::Compound(_)) && !hidden(entry)
}

fn entry_text(entry: &Tag, key: &str) -> Option<String> {
    match entry {
        Tag::Compound(e) => text_of(e, key),
        _ => None,
    }
}

/// One server the list should show: `{ key, name, ip }`, key being the SpawnLoft server's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    pub key: String,
    pub name: String,
    pub ip: String,
}

/// What `reconcile` decided.
#[derive(Debug, Clone, PartialEq)]
pub struct Reconciled {
    pub next: Map<String, Value>,
    pub before: Map<String, Value>,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
}

impl Reconciled {
    pub fn changed(&self) -> bool {
        self.added + self.updated + self.removed > 0
    }
}

fn record(ip: &str, name: &str, state: &str) -> Value {
    json!({ "ip": ip, "name": name, "state": state })
}

/// `{ ip: was.ip, name: was.name, state }`, with what the record held as it held it.
fn record_was(was: &Value, state: &str) -> Value {
    super::object(vec![
        ("ip", prop(Some(was), "ip").cloned()),
        ("name", prop(Some(was), "name").cloned()),
        ("state", Some(json!(state))),
    ])
}

/// `String(x ?? '')` of a record's field, for `addressKey`.
fn key_text(v: Option<&Value>) -> String {
    if super::nullish(v) {
        String::new()
    } else {
        js::string(v)
    }
}

/// `reconcile(entries, state, wanted)`: brings the list (changed in place) in step with
/// `wanted`. `state` is what SpawnLoft remembers having written (`{ <key>: { ip, name, state } }`,
/// state `ours`, `theirs` or `dismissed`). Entries are tracked by their position in the list.
pub fn reconcile(entries: &mut Vec<Tag>, state: &Value, wanted: &[Wanted]) -> Reconciled {
    let mut next = Map::new();
    let mut before = Map::new();
    let (mut added, mut updated, mut removed) = (0, 0, 0);
    let known: Vec<(String, Value)> = match state {
        Value::Object(m) => m
            .iter()
            .filter(|(_, was)| matches!(was, Value::Object(_)))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    let want = |key: &str| wanted.iter().rev().find(|w| w.key == key);
    let was_text = |was: &Value, k: &str| prop(Some(was), k).and_then(Value::as_str).map(String::from);
    // entries are identified by an id that survives removals: their index into `ids`
    let mut ids: Vec<usize> = (0..entries.len()).collect();
    let mut next_id = entries.len();
    let mut mine: Vec<(String, usize)> = Vec::new();
    let mut taken: Vec<usize> = Vec::new();
    let find = |entries: &[Tag], ids: &[usize], taken: &[usize], ip: Option<&str>, name: Option<&str>| {
        entries
            .iter()
            .zip(ids)
            .find(|(e, id)| {
                shown(e)
                    && !taken.contains(id)
                    && entry_text(e, "ip").as_deref() == ip
                    && entry_text(e, "name").as_deref() == name
            })
            .map(|(_, id)| *id)
    };
    for (key, was) in &known {
        if prop(Some(was), "state") != Some(&json!("ours")) {
            continue;
        }
        let ip = was_text(was, "ip");
        let name = was_text(was, "name");
        let mut hit = if ip.is_some() && name.is_some() {
            find(entries, &ids, &taken, ip.as_deref(), name.as_deref())
        } else {
            None
        };
        if hit.is_none()
            && let Some(prev) = prop(Some(was), "prev").filter(|p| js::truthy(Some(p)))
        {
            let (pi, pn) = (was_text(prev, "ip"), was_text(prev, "name"));
            if pi.is_some() && pn.is_some() {
                hit = find(entries, &ids, &taken, pi.as_deref(), pn.as_deref());
            }
        }
        if let Some(id) = hit {
            mine.push((key.clone(), id));
            taken.push(id);
        }
    }
    let theirs = |entries: &[Tag], ids: &[usize], taken: &[usize], ip: Option<&str>| {
        let k = address_key(ip);
        entries.iter().zip(ids).any(|(e, id)| {
            shown(e) && !taken.contains(id) && address_key(entry_text(e, "ip").as_deref()) == k
        })
    };
    for (key, was) in &known {
        let w = want(key);
        let was_ip = key_text(prop(Some(was), "ip"));
        if prop(Some(was), "state") == Some(&json!("ours")) {
            let entry = mine.iter().find(|(k, _)| k == key).map(|(_, id)| *id);
            let Some(id) = entry else {
                // an add that never reached the file is not a delete: it is added again below
                if js::truthy(prop(Some(was), "pending")) {
                    continue;
                }
                // edited in the game, or deleted there: the player's call either way
                if w.is_some() {
                    let state = if theirs(entries, &ids, &taken, Some(&was_ip)) {
                        "theirs"
                    } else {
                        "dismissed"
                    };
                    next.insert(key.clone(), record_was(was, state));
                }
                continue;
            };
            let at = ids.iter().position(|x| *x == id).expect("a live entry");
            let Some(w) = w else {
                entries.remove(at);
                ids.remove(at);
                taken.retain(|x| *x != id);
                removed += 1;
                // until the file is written the entry is still there, and still SpawnLoft's
                before.insert(key.clone(), record_was(was, "ours"));
                continue;
            };
            let (cur_ip, cur_name) = (entry_text(&entries[at], "ip"), entry_text(&entries[at], "name"));
            if cur_ip.as_deref() != Some(w.ip.as_str()) || cur_name.as_deref() != Some(w.name.as_str()) {
                let mut rec = record(&w.ip, &w.name, "ours");
                rec["prev"] = json!({ "ip": cur_ip, "name": cur_name });
                before.insert(key.clone(), rec);
                if let Tag::Compound(e) = &mut entries[at] {
                    set_text(e, "name", &w.name);
                    set_text(e, "ip", &w.ip);
                }
                updated += 1;
            }
            next.insert(key.clone(), record(&w.ip, &w.name, "ours"));
        } else if let Some(w) = w
            && address_key(Some(&w.ip)) == address_key(Some(&was_ip))
        {
            // theirs or dismissed stays so while the server stays where it was
            let state = if prop(Some(was), "state") == Some(&json!("theirs")) {
                "theirs"
            } else {
                "dismissed"
            };
            next.insert(key.clone(), record_was(was, state));
        }
    }
    for w in wanted {
        if next.contains_key(&w.key) {
            continue;
        }
        if theirs(entries, &ids, &taken, Some(&w.ip)) {
            // the player already lists this address under a name of their own
            next.insert(w.key.clone(), record(&w.ip, &w.name, "theirs"));
            continue;
        }
        entries.push(Tag::Compound(vec![
            (mutf8("name"), Tag::Str(mutf8(&w.name))),
            (mutf8("ip"), Tag::Str(mutf8(&w.ip))),
        ]));
        ids.push(next_id);
        taken.push(next_id);
        next_id += 1;
        next.insert(w.key.clone(), record(&w.ip, &w.name, "ours"));
        let mut pending = record(&w.ip, &w.name, "ours");
        pending["pending"] = json!(true);
        before.insert(w.key.clone(), pending);
        added += 1;
    }
    let mut merged = next.clone();
    for (k, v) in &before {
        merged.insert(k.clone(), v.clone());
    }
    Reconciled {
        next,
        before: merged,
        added,
        updated,
        removed,
    }
}

/// What `syncServerList` did.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Synced {
    pub changed: bool,
    pub added: u32,
    pub updated: u32,
    pub removed: u32,
    pub skipped: Option<String>,
}

/// The state file, or nothing: one that cannot be read is no memory at all (entries in the file
/// are then the player's; nothing is removed).
fn read_state(state_file: &str) -> Value {
    match super::read_json(state_file) {
        Ok(Some(data)) => match prop(Some(&data), "entries") {
            Some(e @ Value::Object(_)) => e.clone(),
            _ => json!({}),
        },
        _ => json!({}),
    }
}

fn write_state(state_file: &str, entries: &Map<String, Value>) -> Result<(), Failure> {
    if entries.is_empty() {
        super::rm_force(state_file)
    } else {
        super::write_json(state_file, &json!({ "version": 1, "entries": entries }))
    }
}

/// `syncServerList({ file, stateFile, wanted })`: reads servers.dat, reconciles it, and writes it
/// back only if something changed. Never fails for a file it cannot use: that is `skipped`. The
/// memory is written before the file and again after it, so a stop between the two never leaves
/// an entry of SpawnLoft's in the file that SpawnLoft has forgotten is its own.
pub fn sync(file: &str, state_file: &str, wanted: &[Wanted]) -> Synced {
    let state = read_state(state_file);
    if wanted.is_empty() && state.as_object().is_none_or(Map::is_empty) {
        return Synced::default();
    }
    let skipped = |why: String| Synced {
        skipped: Some(why),
        ..Synced::default()
    };
    let path = std::path::Path::new(file);
    let mut doc = match std::fs::metadata(path) {
        Err(_) => Nbt {
            name: Vec::new(),
            root: vec![(
                mutf8("servers"),
                Tag::List {
                    of: COMPOUND,
                    items: Vec::new(),
                },
            )],
        },
        Ok(m) => {
            if !m.is_file() || m.len() > MAX_SERVERS_DAT {
                return skipped("servers.dat is not a file SpawnLoft can read".into());
            }
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(e) => {
                    return skipped(format!(
                        "servers.dat could not be read ({})",
                        crate::jspath::read_error(&e, path)
                    ));
                }
            };
            match read_nbt(&bytes) {
                Ok(d) => d,
                Err(why) => return skipped(format!("servers.dat could not be read ({why})")),
            }
        }
    };
    let at = match doc.root.iter().position(|(k, _)| from_mutf8(k) == "servers") {
        Some(i) => i,
        None => {
            doc.root.push((
                mutf8("servers"),
                Tag::List {
                    of: COMPOUND,
                    items: Vec::new(),
                },
            ));
            doc.root.len() - 1
        }
    };
    let out = match &mut doc.root[at].1 {
        Tag::List { of, items } if items.is_empty() || *of == COMPOUND => {
            *of = COMPOUND;
            reconcile(items, &state, wanted)
        }
        _ => return skipped("servers.dat does not hold a list of servers".into()),
    };
    let tmp = format!("{file}.spawnloft.tmp");
    let written = (|| -> Result<(), String> {
        if out.changed() {
            write_state(state_file, &out.before).map_err(|f| f.message().to_string())?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| crate::jspath::node_error(&e, "mkdir", Some(dir)))?;
            }
            // on the disk before it takes the list's place: a power cut must not leave an empty list
            {
                use std::io::Write;
                let tp = std::path::Path::new(&tmp);
                let mut f =
                    std::fs::File::create(tp).map_err(|e| crate::jspath::node_error(&e, "open", Some(tp)))?;
                f.write_all(&write_nbt(&doc))
                    .map_err(|e| crate::jspath::node_error(&e, "write", None))?;
                f.sync_all()
                    .map_err(|e| crate::jspath::node_error(&e, "fsync", None))?;
            }
            crate::fsx::rename_over(std::path::Path::new(&tmp), path).map_err(|e| {
                crate::fsx::rename_failure(&e, std::path::Path::new(&tmp), path)
                    .message()
                    .to_string()
            })?;
        }
        write_state(state_file, &out.next).map_err(|f| f.message().to_string())
    })();
    if let Err(why) = written {
        let _ = std::fs::remove_file(&tmp);
        return skipped(format!("servers.dat could not be updated ({why})"));
    }
    Synced {
        changed: out.changed(),
        added: out.added,
        updated: out.updated,
        removed: out.removed,
        skipped: None,
    }
}

/// `SERVER_LIST_SINCE`: 1.7's release, as far back as the file's shape was checked.
pub const SERVER_LIST_SINCE_MS: f64 = 1_382_400_000_000.0;

/// `versionKeepsServerList(version)`.
pub fn version_keeps_server_list(version: Option<&Value>) -> bool {
    let at = match prop(version, "releaseTime") {
        v if super::nullish(v) => f64::NAN,
        v => crate::jsdate::parse(&js::string(v)),
    };
    at.is_finite() && at >= SERVER_LIST_SINCE_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str, ip: &str) -> Tag {
        Tag::Compound(vec![
            (mutf8("ip"), Tag::Str(mutf8(ip))),
            (mutf8("name"), Tag::Str(mutf8(name))),
            (
                mutf8("icon"),
                Tag::Array {
                    kind: 7,
                    count: 2,
                    raw: vec![1, 2],
                },
            ),
        ])
    }

    fn file(items: Vec<Tag>) -> Nbt {
        Nbt {
            name: Vec::new(),
            root: vec![(mutf8("servers"), Tag::List { of: COMPOUND, items })],
        }
    }

    fn w(key: &str, name: &str, ip: &str) -> Wanted {
        Wanted {
            key: key.into(),
            name: name.into(),
            ip: ip.into(),
        }
    }

    #[test]
    fn nbt_round_trips_byte_for_byte() {
        let doc = file(vec![server("A", "1.2.3.4"), server("é😀", "x")]);
        let bytes = write_nbt(&doc);
        assert_eq!(read_nbt(&bytes).unwrap(), doc);
        assert_eq!(write_nbt(&read_nbt(&bytes).unwrap()), bytes);
        assert_eq!(from_mutf8(&mutf8("é😀\u{0}")), "é😀\u{0}");
        assert_eq!(mutf8("\u{0}"), vec![0xc0, 0x80]);
        assert!(read_nbt(&bytes[..bytes.len() - 1]).is_err());
        let mut extra = bytes.clone();
        extra.push(0);
        assert_eq!(
            read_nbt(&extra).unwrap_err(),
            "bytes left over after the last tag"
        );
        assert_eq!(
            read_nbt(&[1]).unwrap_err(),
            "not an NBT file (it does not start with a compound tag)"
        );
        // a list of nothing that claims items
        assert_eq!(
            read_nbt(&[10, 0, 0, 9, 0, 1, b'l', 0, 0, 0, 0, 1, 0]).unwrap_err(),
            "a list of nothing with items in it"
        );
    }

    #[test]
    fn address_keys_join_spellings_of_one_place() {
        assert_eq!(address_key(Some("LOCALHOST")), "127.0.0.1:25565");
        assert_eq!(address_key(Some("127.0.0.1:25565")), "127.0.0.1:25565");
        assert_eq!(address_key(Some("[::1]:25570")), "127.0.0.1:25570");
        assert_eq!(address_key(Some("host.:0025570")), "host:25570");
        assert_eq!(address_key(Some("a:b:c")), "a:b:c:25565");
        assert_eq!(address_key(Some("h:x")), "h:x");
        assert_eq!(address_key(None), ":25565");
    }

    #[test]
    fn reconcile_adds_updates_removes_and_respects_the_player() {
        let mut items = vec![server("Mine", "10.0.0.5")];
        let got = reconcile(
            &mut items,
            &json!({}),
            &[w("a", "A", "127.0.0.1:25565"), w("b", "B", "10.0.0.5:25565")],
        );
        assert_eq!((got.added, got.updated, got.removed), (1, 0, 0));
        assert_eq!(got.next["b"]["state"], "theirs");
        assert_eq!(got.before["a"]["pending"], true);
        assert_eq!(items.len(), 2);
        // the next sync: a moved server is updated, a gone one removed
        let state = Value::Object(got.next);
        let got = reconcile(&mut items, &state, &[w("a", "A", "127.0.0.1:25570")]);
        assert_eq!((got.added, got.updated, got.removed), (0, 1, 0));
        assert_eq!(
            got.before["a"]["prev"],
            json!({ "ip": "127.0.0.1:25565", "name": "A" })
        );
        let state = Value::Object(got.next);
        let got = reconcile(&mut items, &state, &[]);
        assert_eq!((got.added, got.updated, got.removed), (0, 0, 1));
        assert_eq!(items, vec![server("Mine", "10.0.0.5")]);
        // an entry the player deleted is not put back
        let state = json!({ "a": { "ip": "1.1.1.1:25565", "name": "A", "state": "ours" } });
        let got = reconcile(&mut items, &state, &[w("a", "A", "1.1.1.1:25565")]);
        assert_eq!(got.next["a"]["state"], "dismissed");
        assert!(!got.changed());
    }

    #[test]
    fn sync_writes_only_a_whole_file() {
        let d = std::env::temp_dir().join(format!("sl-servers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("servers.dat").to_string_lossy().into_owned();
        let s = d.join("server-list.json").to_string_lossy().into_owned();
        assert_eq!(sync(&f, &s, &[]), Synced::default());
        let got = sync(&f, &s, &[w("a", "A", "127.0.0.1:25565")]);
        assert!(got.changed && got.added == 1 && got.skipped.is_none());
        let doc = read_nbt(&std::fs::read(&f).unwrap()).unwrap();
        assert_eq!(doc.root.len(), 1);
        std::fs::write(&f, b"junk").unwrap();
        let got = sync(&f, &s, &[w("a", "A", "127.0.0.1:25565")]);
        assert_eq!(
            got.skipped.as_deref(),
            Some("servers.dat could not be read (not an NBT file (it does not start with a compound tag))")
        );
        assert_eq!(std::fs::read(&f).unwrap(), b"junk");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn the_list_is_kept_from_1_7_on() {
        assert!(version_keeps_server_list(Some(
            &json!({ "releaseTime": "2013-10-22T00:00:00Z" })
        )));
        assert!(!version_keeps_server_list(Some(
            &json!({ "releaseTime": "2013-10-21T23:59:59Z" })
        )));
        assert!(!version_keeps_server_list(Some(&json!({}))));
        assert!(!version_keeps_server_list(None));
    }
}
