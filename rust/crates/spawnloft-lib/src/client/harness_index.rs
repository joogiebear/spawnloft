//! `client-harness-index.mjs`: the signed list of harness builds. Two release assets of the mod
//! repo's fixed `index` tag, harness-index.json and its one-line Ed25519 signature, checked on the
//! raw bytes before anything is parsed against the two public keys below. A list older than the
//! one this build shipped with, or than the one already cached, is refused, and a row can only
//! name a jar among the mod repo's own releases, pinned by sha256. Nothing about the list ever
//! fails a launch: bad, stale, replayed, oversized or unreachable all mean "the cached verified
//! copy, else the built-in rows", and the reason goes to a status file the doctor reads.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use super::paths::Paths;
use super::prop;
use crate::failure::Failure;
use crate::js;

/// A key the list may be signed with: its name and its SPKI DER, base64.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Key {
    pub name: &'static str,
    pub spki: &'static str,
}

/// Both made by Victor on the signing machine on 2026-10-29; the private halves never leave it.
pub const HARNESS_INDEX_KEYS: &[Key] = &[
    Key {
        name: "primary",
        spki: "MCowBQYDK2VwAyEA4gftri3viZzfRIT7o+lr5ndac+Kd9/KKSIoTFba/DGc=",
    },
    Key {
        name: "spare",
        spki: "MCowBQYDK2VwAyEA7eDiBj6m+d/4AgWLqJEo0QfG4Q6QJHxRgvN7mrR851c=",
    },
];

/// The serial of the signed list whose rows were last copied into the built-in rows.
pub const HARNESS_INDEX_MIN_SERIAL: f64 = 1.0;

pub const HARNESS_RELEASE_PREFIX: &str =
    "https://github.com/joogiebear/spawnloft-harness-mod/releases/download/";
pub const HARNESS_INDEX_URL: &str =
    "https://github.com/joogiebear/spawnloft-harness-mod/releases/download/index/harness-index.json";
pub const HARNESS_INDEX_SIG_URL: &str =
    "https://github.com/joogiebear/spawnloft-harness-mod/releases/download/index/harness-index.json.sig";

/// Signed and verified ahead of the file's bytes, so a signature this key made over anything
/// else can never pass for a list.
pub const SIGNATURE_DOMAIN: &str = "spawnloft-harness-index/1\n";

pub const MAX_INDEX_BYTES: u64 = 64 * 1024;
pub const MAX_SIG_BYTES: u64 = 1024;
const MAX_ROWS: usize = 100;
const MAX_REVOKE: usize = 8;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const FRESH_MS: f64 = 24.0 * 3_600_000.0;
const RETRY_AFTER_FAILURE_MS: f64 = 3_600_000.0;
const FORCE_GUARD_MS: f64 = 60_000.0;

const INDEX_FILE: &str = "harness-index.json";
const SIG_FILE: &str = "harness-index.json.sig";
const STATUS_FILE: &str = "harness-index.status.json";
const REVOKED_FILE: &str = "harness-revoked-keys.json";

fn re(p: &str) -> Regex {
    Regex::new(p).expect("valid")
}
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$"));
static TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^v[0-9A-Za-z][0-9A-Za-z.-]{0,39}-mc[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"));
static FILE_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^spawnloft-harness-[0-9A-Za-z][0-9A-Za-z.-]{0,39}\+[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jar$")
});
static SHA256_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9a-fA-F]{64}$"));
static SIG_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9+/]{86}==$"));
static SPKI_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9+/]{40,120}={0,2}$"));

/// One verified row.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub minecraft: Vec<String>,
    pub version: String,
    pub tag: String,
    pub file: String,
    pub sha256: String,
}

/// A verified list.
#[derive(Debug, Clone, PartialEq)]
pub struct Index {
    pub serial: f64,
    pub generated: Option<String>,
    pub rows: Vec<Row>,
    pub revoke: Vec<String>,
    pub key: &'static str,
    /// The bytes it was verified from (`bytes` beside a cached copy).
    pub bytes: Vec<u8>,
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `harnessJarUrl(row)`.
pub fn jar_url(row: &Row) -> String {
    format!(
        "{HARNESS_RELEASE_PREFIX}{}/{}",
        row.tag,
        encode_uri_component(&row.file)
    )
}

/// A refusal, with its code (`indexError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexError {
    pub code: &'static str,
    pub message: String,
}

fn index_error(code: &'static str, message: impl Into<String>) -> IndexError {
    IndexError {
        code,
        message: message.into(),
    }
}

/// `Buffer.from(text, 'base64')` for text SIG_RE or SPKI_RE already admitted: the bits left over
/// past the last whole byte are dropped, as Node drops them.
fn base64_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => break,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

// The SPKI DER of an Ed25519 key: this prefix, then the 32 bytes of the key.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

fn verifies(spki: &str, signed: &[u8], signature: &[u8]) -> bool {
    let der = base64_lenient(spki);
    let Some(raw) = der.strip_prefix(&ED25519_SPKI_PREFIX[..]) else {
        return false;
    };
    if raw.len() != 32 {
        return false;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, raw)
        .verify(signed, signature)
        .is_ok()
}

fn trim_sig(text: &str) -> &str {
    text.trim_end_matches(['\r', '\n', '\t', ' '])
}

/// `JSON.stringify(v)` for a message: undefined is the word itself.
fn shown(v: Option<&Value>) -> String {
    v.map_or("undefined".to_string(), crate::jsjson::stringify)
}

fn valid_row(raw: &Value, n: usize) -> Result<Row, IndexError> {
    let bad =
        |field: &str, why: String| index_error("harness-index-format", format!("row {n}: {field} {why}"));
    if !raw.is_object() {
        return Err(bad("", "is not an object".into()));
    }
    let ids = match raw.get("minecraft") {
        Some(Value::Array(ids)) if !ids.is_empty() && ids.len() <= 20 => ids,
        _ => return Err(bad("minecraft", "must be a list of 1 to 20 version ids".into())),
    };
    let mut minecraft = Vec::new();
    for id in ids {
        match id {
            Value::String(s) if super::version::is_safe_version_id(s) => minecraft.push(s.clone()),
            other => {
                return Err(bad(
                    "minecraft",
                    format!(
                        "has an id SpawnLoft would not use ({})",
                        crate::jsjson::stringify(other)
                    ),
                ));
            }
        }
    }
    let text = |k: &str, re: &Regex| match raw.get(k) {
        Some(Value::String(s)) if re.is_match(s) => Some(s.clone()),
        _ => None,
    };
    let version =
        text("version", &VERSION_RE).ok_or_else(|| bad("version", "is not a mod version".into()))?;
    let tag = text("tag", &TAG_RE).ok_or_else(|| bad("tag", "is not a harness release tag".into()))?;
    let file = text("file", &FILE_RE).ok_or_else(|| bad("file", "is not a harness jar name".into()))?;
    let sha256 = text("sha256", &SHA256_RE).ok_or_else(|| bad("sha256", "is not 64 hex digits".into()))?;
    Ok(Row {
        minecraft,
        version,
        tag,
        file,
        sha256: sha256.to_ascii_lowercase(),
    })
}

fn is_safe_integer(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n)
}

/// `parseHarnessIndex(bytes, sigText, { keys, minSerial, revoked })`.
pub fn parse(
    bytes: &[u8],
    sig_text: &str,
    keys: &[Key],
    min_serial: f64,
    revoked: &[String],
) -> Result<Index, IndexError> {
    let sig_line = trim_sig(sig_text);
    if !SIG_RE.is_match(sig_line) {
        return Err(index_error(
            "harness-index-signature",
            "the signature file is not one base64 Ed25519 signature",
        ));
    }
    let signature = base64_lenient(sig_line);
    let mut signed = SIGNATURE_DOMAIN.as_bytes().to_vec();
    signed.extend_from_slice(bytes);
    let Some(key) = keys
        .iter()
        .find(|k| !revoked.iter().any(|r| r == k.spki) && verifies(k.spki, &signed, &signature))
    else {
        return Err(index_error(
            "harness-index-signature",
            "the signature does not verify with any key this SpawnLoft trusts",
        ));
    };

    let doc = crate::jsjson::parse(&String::from_utf8_lossy(bytes))
        .map_err(|e| index_error("harness-index-format", format!("not JSON: {e}")))?;
    if !doc.is_object() {
        return Err(index_error("harness-index-format", "not a JSON object"));
    }
    if doc.get("format").and_then(Value::as_f64) != Some(1.0) {
        return Err(index_error(
            "harness-index-format",
            format!(
                "format {} is not one this SpawnLoft reads",
                shown(doc.get("format"))
            ),
        ));
    }
    let serial = match is_safe_integer(doc.get("serial")) {
        Some(s) if s >= 1.0 => s,
        _ => {
            return Err(index_error(
                "harness-index-format",
                "serial is not a positive whole number",
            ));
        }
    };
    let raw_rows = match doc.get("rows") {
        Some(Value::Array(r)) if r.len() <= MAX_ROWS => r,
        _ => {
            return Err(index_error(
                "harness-index-format",
                format!("rows must be a list of at most {MAX_ROWS}"),
            ));
        }
    };
    let rows = raw_rows
        .iter()
        .enumerate()
        .map(|(i, r)| valid_row(r, i + 1))
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = std::collections::HashSet::new();
    for id in rows.iter().flat_map(|r| r.minecraft.iter()) {
        if !seen.insert(id.clone()) {
            return Err(index_error(
                "harness-index-format",
                format!("Minecraft {id} is listed twice"),
            ));
        }
    }
    let revoke = match doc.get("revoke") {
        None => Vec::new(),
        Some(Value::Array(list))
            if list.len() <= MAX_REVOKE
                && list
                    .iter()
                    .all(|k| k.as_str().is_some_and(|s| SPKI_RE.is_match(s))) =>
        {
            list.iter().filter_map(|k| k.as_str().map(String::from)).collect()
        }
        Some(_) => {
            return Err(index_error(
                "harness-index-format",
                format!("revoke must be a list of at most {MAX_REVOKE} public keys"),
            ));
        }
    };
    if serial < min_serial {
        return Err(index_error(
            "harness-index-serial",
            format!(
                "serial {} is older than the list this SpawnLoft shipped with ({})",
                js::number_to_string(serial),
                js::number_to_string(min_serial)
            ),
        ));
    }
    let generated = match doc.get("generated") {
        Some(Value::String(g)) => {
            let units: Vec<u16> = g.encode_utf16().take(40).collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    };
    Ok(Index {
        serial,
        generated,
        rows,
        revoke,
        key: key.name,
        bytes: bytes.to_vec(),
    })
}

// ---- the cache -------------------------------------------------------------------------------

/// Where the list lives and what it is checked against.
#[derive(Debug, Clone, Copy)]
pub struct Opts<'a> {
    pub cache_dir: &'a str,
    pub keys: &'a [Key],
    pub min_serial: f64,
}

impl<'a> Opts<'a> {
    pub fn new(cache_dir: &'a str) -> Opts<'a> {
        Opts {
            cache_dir,
            keys: HARNESS_INDEX_KEYS,
            min_serial: HARNESS_INDEX_MIN_SERIAL,
        }
    }
}

fn file(dir: &str, name: &str) -> String {
    crate::jspath::join(&[dir, name])
}

/// `readJsonFile(dest, fallback)`: any failure is the fallback.
fn read_json_file(dest: &str) -> Option<Value> {
    let bytes = std::fs::read(dest).ok()?;
    crate::jsjson::parse(&String::from_utf8_lossy(&bytes)).ok()
}

fn key_set_of(keys: &[Key]) -> String {
    let mut s: Vec<&str> = keys.iter().map(|k| k.spki).collect();
    s.sort();
    s.join(",")
}

fn read_revoked(o: Opts<'_>) -> Vec<String> {
    let Some(stored) = read_json_file(&file(o.cache_dir, REVOKED_FILE)) else {
        return Vec::new();
    };
    if prop(Some(&stored), "keys") != Some(&json!(key_set_of(o.keys))) {
        return Vec::new();
    }
    match prop(Some(&stored), "revoked") {
        Some(Value::Array(list)) => list.iter().filter_map(|k| k.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

fn write_status(dir: &str, status: &Value) {
    // the status is for the doctor; a disk that cannot take it has bigger news
    if crate::fsx::mkdir_all(std::path::Path::new(dir)).is_ok() {
        let _ = super::write_atomic(
            &file(dir, STATUS_FILE),
            format!("{}\n", crate::jsjson::stringify_pretty(status)).as_bytes(),
        );
    }
}

fn drop_cache(dir: &str) {
    for name in [INDEX_FILE, SIG_FILE, "harness-index.json.fetched-at"] {
        let _ = super::rm_force(&file(dir, name));
    }
}

/// `statusFields(s)`: `lastCheck`, `outcome` and `reason` of an old status.
fn status_fields(s: Option<&Value>) -> serde_json::Map<String, Value> {
    let last = js::number(prop(s, "lastCheck"));
    let mut m = serde_json::Map::new();
    m.insert(
        "lastCheck".into(),
        if last.is_nan() || last == 0.0 {
            Value::Null
        } else {
            crate::jsjson::num(last)
        },
    );
    m.insert("outcome".into(), super::or_null(prop(s, "outcome")));
    m.insert("reason".into(), super::or_null(prop(s, "reason")));
    m
}

/// `loadCachedHarnessIndex(...)`: the copy in the cache, verified again, or `None`. A copy that
/// no longer verifies is deleted.
pub fn load_cached(o: Opts<'_>, revoked: Option<&[String]>) -> Option<Index> {
    let bytes = std::fs::read(file(o.cache_dir, INDEX_FILE)).ok()?;
    let sig = std::fs::read(file(o.cache_dir, SIG_FILE)).ok()?;
    let sig = String::from_utf8_lossy(&sig);
    let stored;
    let revoked = match revoked {
        Some(r) => r,
        None => {
            stored = read_revoked(o);
            &stored
        }
    };
    match parse(&bytes, &sig, o.keys, o.min_serial, revoked) {
        Ok(ix) => Some(ix),
        Err(err) => {
            drop_cache(o.cache_dir);
            let old = read_json_file(&file(o.cache_dir, STATUS_FILE));
            let mut status = status_fields(old.as_ref().filter(|v| v.is_object()));
            status.insert("source".into(), json!("built-in"));
            status.insert("serial".into(), Value::Null);
            status.insert("key".into(), Value::Null);
            status.insert("generated".into(), Value::Null);
            status.insert("outcome".into(), json!(err.code));
            status.insert(
                "reason".into(),
                json!(format!("the cached list was dropped: {}", err.message)),
            );
            write_status(o.cache_dir, &Value::Object(status));
            None
        }
    }
}

// ---- in memory -------------------------------------------------------------------------------

type Loaded = HashMap<String, Option<Index>>;
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);
static LAST_TRIED: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

fn loaded_get(dir: &str) -> Option<Option<Index>> {
    LOADED.lock().ok()?.as_ref()?.get(dir).cloned()
}

fn loaded_set(dir: &str, ix: Option<Index>) {
    if let Ok(mut m) = LOADED.lock() {
        m.get_or_insert_with(HashMap::new).insert(dir.to_string(), ix);
    }
}

/// `indexRows(...)`: the rows of the verified copy in use, loaded by the first lookup.
pub fn index_rows(o: Opts<'_>) -> Vec<Row> {
    if loaded_get(o.cache_dir).is_none() {
        loaded_set(o.cache_dir, load_cached(o, None));
    }
    loaded_get(o.cache_dir)
        .flatten()
        .map(|ix| ix.rows)
        .unwrap_or_default()
}

/// Tests: forget what this process loaded and when it last asked the network.
pub fn forget() {
    if let Ok(mut m) = LOADED.lock() {
        *m = None;
    }
    if let Ok(mut m) = LAST_TRIED.lock() {
        *m = None;
    }
}

// ---- refresh ---------------------------------------------------------------------------------

/// How the two files are fetched: `fetchCapped(url, { maxBytes, timeoutMs, label })`.
pub type Fetch<'a> = &'a (dyn Fn(&str, u64, &str) -> Result<Vec<u8>, Failure> + Sync);

pub fn default_fetch(url: &str, max_bytes: u64, label: &str) -> Result<Vec<u8>, Failure> {
    crate::download::fetch_capped(
        url,
        max_bytes,
        FETCH_TIMEOUT,
        2,
        Duration::from_millis(1500),
        label,
    )
}

fn failure_code(e: &Failure) -> Option<&str> {
    match e {
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.as_deref(),
        Failure::Usage(_) => None,
    }
}

/// `refreshHarnessIndex({ force })`: asks GitHub for the list when the copy in use is older than
/// a day (an hour after a failed try), or now with `force` (at most once a minute). Never fails:
/// the outcome goes to the status file and is returned. `fetch` is a test's own; without one,
/// `SPAWNLOFT_HARNESS_INDEX_FETCH=off` turns the refresh off.
pub fn refresh(o: Opts<'_>, force: bool, fetch: Option<Fetch<'_>>, now: &dyn Fn() -> f64) -> &'static str {
    if fetch.is_none() && std::env::var("SPAWNLOFT_HARNESS_INDEX_FETCH").as_deref() == Ok("off") {
        return "off";
    }
    let fetch: Fetch<'_> = fetch.unwrap_or(&default_fetch);
    let dir = o.cache_dir;
    let old = read_json_file(&file(dir, STATUS_FILE));
    let old = old.as_ref();
    let fetched_at = read_json_file(&file(dir, "harness-index.json.fetched-at"))
        .map_or(f64::NAN, |v| js::number(Some(&v)));
    if !force {
        index_rows(o);
        if fetched_at.is_finite() && now() - fetched_at < FRESH_MS && loaded_get(dir).flatten().is_some() {
            return "fresh";
        }
        let outcome = prop(old, "outcome");
        let failed = js::truthy(outcome)
            && !matches!(outcome, Some(Value::String(s)) if s == "accepted" || s == "unchanged");
        let last = js::number(prop(old, "lastCheck"));
        let last = if last.is_nan() { 0.0 } else { last };
        if failed && now() - last < RETRY_AFTER_FAILURE_MS {
            return "recently-failed";
        }
    }
    let tried = LAST_TRIED
        .lock()
        .ok()
        .and_then(|m| m.as_ref().and_then(|m| m.get(dir).copied()))
        .unwrap_or(f64::NEG_INFINITY);
    if now() - tried < FORCE_GUARD_MS {
        return "recently-tried";
    }
    if let Ok(mut m) = LAST_TRIED.lock() {
        m.get_or_insert_with(HashMap::new).insert(dir.to_string(), now());
    }

    let record = |outcome: &'static str, reason: Option<String>, copy: Option<&Index>| -> &'static str {
        write_status(
            dir,
            &json!({
                "lastCheck": crate::jsjson::num(now()),
                "outcome": outcome,
                "reason": reason,
                "source": if copy.is_some() { "index" } else { "built-in" },
                "serial": copy.map(|c| crate::jsjson::num(c.serial)),
                "generated": copy.and_then(|c| c.generated.clone()),
                "key": copy.map(|c| c.key),
            }),
        );
        outcome
    };
    let current = || loaded_get(dir).flatten().or_else(|| load_cached(o, None));

    let got = fetch(HARNESS_INDEX_URL, MAX_INDEX_BYTES, "the harness list").and_then(|bytes| {
        let sig = fetch(HARNESS_INDEX_SIG_URL, MAX_SIG_BYTES, "the harness list signature")?;
        Ok((bytes, String::from_utf8_lossy(&sig).into_owned()))
    });
    let (bytes, sig) = match got {
        Ok(v) => v,
        Err(err) => {
            let outcome = if failure_code(&err) == Some("too-large") {
                "harness-index-oversized"
            } else {
                "harness-index-unreachable"
            };
            return record(outcome, Some(err.message().to_string()), current().as_ref());
        }
    };

    let stored_revoked = read_revoked(o);
    let fresh = match parse(&bytes, &sig, o.keys, o.min_serial, &stored_revoked) {
        Ok(f) => f,
        Err(err) => return record(err.code, Some(err.message), current().as_ref()),
    };

    // a key the new list revokes is out before the cached copy is compared with it
    let signed_by = o.keys.iter().find(|k| k.name == fresh.key).map(|k| k.spki);
    let mut revoked = stored_revoked.clone();
    for k in &fresh.revoke {
        if Some(k.as_str()) != signed_by && o.keys.iter().any(|known| known.spki == k) && !revoked.contains(k)
        {
            revoked.push(k.clone());
        }
    }
    let cached = load_cached(o, Some(&revoked));
    if let Some(cached) = &cached {
        if fresh.serial < cached.serial {
            loaded_set(dir, Some(cached.clone()));
            return record(
                "harness-index-serial",
                Some(format!(
                    "serial {} is older than the cached list ({}); a replay of an old list",
                    js::number_to_string(fresh.serial),
                    js::number_to_string(cached.serial)
                )),
                Some(cached),
            );
        }
        if fresh.serial == cached.serial {
            loaded_set(dir, Some(cached.clone()));
            if bytes != cached.bytes {
                return record(
                    "harness-index-serial",
                    Some(format!(
                        "serial {} was published again with different content",
                        js::number_to_string(fresh.serial)
                    )),
                    Some(cached),
                );
            }
            if let Err(err) = super::write_atomic(
                &file(dir, "harness-index.json.fetched-at"),
                js::number_to_string(now()).as_bytes(),
            ) {
                return record(
                    "harness-index-store",
                    Some(format!("could not write to {dir}: {}", err.message())),
                    Some(cached),
                );
            }
            return record("unchanged", None, Some(cached));
        }
    }

    let stored = (|| -> Result<(), Failure> {
        crate::fsx::mkdir_all(std::path::Path::new(dir))?;
        if revoked.len() != stored_revoked.len() {
            let doc = json!({ "keys": key_set_of(o.keys), "revoked": revoked });
            super::write_atomic(
                &file(dir, REVOKED_FILE),
                format!("{}\n", crate::jsjson::stringify_pretty(&doc)).as_bytes(),
            )?;
        }
        super::write_atomic(&file(dir, INDEX_FILE), &bytes)?;
        super::write_atomic(&file(dir, SIG_FILE), sig.as_bytes())?;
        super::write_atomic(
            &file(dir, "harness-index.json.fetched-at"),
            js::number_to_string(now()).as_bytes(),
        )
    })();
    if let Err(err) = stored {
        loaded_set(dir, cached.clone());
        return record(
            "harness-index-store",
            Some(format!("could not write to {dir}: {}", err.message())),
            cached.as_ref(),
        );
    }
    loaded_set(dir, Some(fresh.clone()));
    record("accepted", None, Some(&fresh))
}

/// `refreshHarnessIndex()` for the profile store's cache folder, on the clock.
pub fn refresh_default(paths: &Paths, force: bool) -> &'static str {
    let dir = paths.cache_dir();
    refresh(Opts::new(&dir), force, None, &crate::util::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8032 test 1: the secret key 9d61b19d..., its public key and the signature of the
    // empty message
    const PK: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn b64(data: &[u8]) -> String {
        crate::update::base64::encode(data)
    }

    #[test]
    fn the_shipped_keys_are_ed25519_spki() {
        for k in HARNESS_INDEX_KEYS {
            let der = base64_lenient(k.spki);
            assert_eq!(&der[..12], &ED25519_SPKI_PREFIX);
            assert_eq!(der.len(), 44);
        }
    }

    #[test]
    fn rfc8032_vector_verifies_through_spki() {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend(hex(PK));
        let spki = b64(&der);
        let sig = hex(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        );
        assert!(verifies(&spki, b"", &sig));
        assert!(!verifies(&spki, b"x", &sig));
        assert!(!verifies("MCowBQYDK2VwAyEA", b"", &sig));
    }

    #[test]
    fn refusals_before_and_after_the_signature() {
        let e = parse(b"{}", "not a sig", HARNESS_INDEX_KEYS, 1.0, &[]).unwrap_err();
        assert_eq!(e.code, "harness-index-signature");
        let sig = format!("{}==\n", "A".repeat(86));
        let e = parse(b"{}", &sig, HARNESS_INDEX_KEYS, 1.0, &[]).unwrap_err();
        assert_eq!(
            e.message,
            "the signature does not verify with any key this SpawnLoft trusts"
        );
    }

    struct Signer {
        pair: ring::signature::Ed25519KeyPair,
        spki: &'static str,
    }

    fn signer() -> Signer {
        use ring::signature::KeyPair;
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(pair.public_key().as_ref());
        Signer {
            pair,
            spki: Box::leak(b64(&der).into_boxed_str()),
        }
    }

    fn signed(s: &Signer, doc: &Value) -> (Vec<u8>, String) {
        let bytes = crate::jsjson::stringify(doc).into_bytes();
        let mut msg = SIGNATURE_DOMAIN.as_bytes().to_vec();
        msg.extend_from_slice(&bytes);
        (bytes, format!("{}\n", b64(s.pair.sign(&msg).as_ref())))
    }

    fn list(serial: u32, revoke: Option<&str>) -> Value {
        let mut doc = json!({ "format": 1, "serial": serial, "generated": "2026-11-21", "rows": [
            { "minecraft": ["1.21.11"], "version": "1.0.0", "tag": "v1.0.0-mc1.21.11", "file": "spawnloft-harness-1.0.0+1.21.11.jar", "sha256": "a".repeat(64) }
        ] });
        if let Some(k) = revoke {
            doc["revoke"] = json!([k]);
        }
        doc
    }

    #[test]
    fn refresh_accepts_keeps_and_refuses() {
        forget();
        let dir = std::env::temp_dir().join(format!("sl-hidx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dir_s = dir.to_str().unwrap().to_string();
        let a = signer();
        let b = signer();
        let keys: &'static [Key] = Box::leak(
            vec![
                Key {
                    name: "primary",
                    spki: a.spki,
                },
                Key {
                    name: "spare",
                    spki: b.spki,
                },
            ]
            .into_boxed_slice(),
        );
        let o = Opts {
            cache_dir: &dir_s,
            keys,
            min_serial: 1.0,
        };
        let clock = std::sync::atomic::AtomicU64::new(1_000_000_000_000);
        let now = || clock.load(std::sync::atomic::Ordering::SeqCst) as f64;
        let tick = |ms: u64| clock.fetch_add(ms, std::sync::atomic::Ordering::SeqCst);
        let serve = std::sync::Mutex::new((Vec::new(), String::new()));
        let fetch = |url: &str, max: u64, _: &str| -> Result<Vec<u8>, Failure> {
            let (bytes, sig) = serve.lock().unwrap().clone();
            let body = if url.ends_with(".sig") {
                sig.into_bytes()
            } else {
                bytes
            };
            if body.len() as u64 > max {
                return Err(Failure::User {
                    message: "too big".into(),
                    code: Some("too-large".into()),
                });
            }
            Ok(body)
        };
        let status = || read_json_file(&file(&dir_s, STATUS_FILE)).unwrap();

        *serve.lock().unwrap() = signed(&a, &list(2, None));
        assert_eq!(refresh(o, true, Some(&fetch), &now), "accepted");
        assert_eq!(status()["serial"], json!(2));
        assert_eq!(status()["key"], json!("primary"));
        assert_eq!(index_rows(o).len(), 1);
        // within the minute, even forced, the network is not asked again
        assert_eq!(refresh(o, true, Some(&fetch), &now), "recently-tried");
        // fresh for a day
        tick(120_000);
        assert_eq!(refresh(o, false, Some(&fetch), &now), "fresh");
        // the same bytes again
        assert_eq!(refresh(o, true, Some(&fetch), &now), "unchanged");
        // a replay of an older list, and the same serial with other content
        tick(120_000);
        *serve.lock().unwrap() = signed(&a, &list(1, None));
        assert_eq!(refresh(o, true, Some(&fetch), &now), "harness-index-serial");
        tick(120_000);
        let mut other = list(2, None);
        other["generated"] = json!("changed");
        *serve.lock().unwrap() = signed(&a, &other);
        assert_eq!(refresh(o, true, Some(&fetch), &now), "harness-index-serial");
        assert_eq!(status()["source"], json!("index"));
        // a list signed by neither key, then one too large
        tick(120_000);
        *serve.lock().unwrap() = signed(&signer(), &list(9, None));
        assert_eq!(refresh(o, true, Some(&fetch), &now), "harness-index-signature");
        tick(120_000);
        *serve.lock().unwrap() = (vec![b' '; 70_000], String::new());
        assert_eq!(refresh(o, true, Some(&fetch), &now), "harness-index-oversized");
        // the spare revokes the primary: the primary's cached copy is dropped, the new list kept
        tick(120_000);
        *serve.lock().unwrap() = signed(&b, &list(3, Some(a.spki)));
        assert_eq!(refresh(o, true, Some(&fetch), &now), "accepted");
        assert_eq!(status()["key"], json!("spare"));
        let revoked = read_json_file(&file(&dir_s, REVOKED_FILE)).unwrap();
        assert_eq!(revoked["revoked"], json!([a.spki]));
        // from now on the primary's lists do not verify
        tick(120_000);
        *serve.lock().unwrap() = signed(&a, &list(4, None));
        assert_eq!(refresh(o, true, Some(&fetch), &now), "harness-index-signature");
        // a cache edited by hand is dropped on the next load
        forget();
        std::fs::write(file(&dir_s, INDEX_FILE), b"{}").unwrap();
        assert!(index_rows(o).is_empty());
        assert!(!std::path::Path::new(&file(&dir_s, SIG_FILE)).exists());
        assert_eq!(status()["outcome"], json!("harness-index-signature"));
        let _ = std::fs::remove_dir_all(&dir);
        forget();
    }

    #[test]
    fn rows_are_checked_field_by_field() {
        let row = json!({ "minecraft": ["1.21.11"], "version": "1.0.0", "tag": "v1.0.0-mc1.21.11", "file": "spawnloft-harness-1.0.0+1.21.11.jar", "sha256": "A".repeat(64) });
        let r = valid_row(&row, 1).unwrap();
        assert_eq!(r.sha256, "a".repeat(64));
        assert_eq!(
            jar_url(&r),
            format!("{HARNESS_RELEASE_PREFIX}v1.0.0-mc1.21.11/spawnloft-harness-1.0.0%2B1.21.11.jar")
        );
        let mut bad = row.clone();
        bad["minecraft"] = json!(["1.21.11", 5]);
        assert_eq!(
            valid_row(&bad, 2).unwrap_err().message,
            "row 2: minecraft has an id SpawnLoft would not use (5)"
        );
        assert_eq!(
            valid_row(&json!(null), 3).unwrap_err().message,
            "row 3:  is not an object"
        );
    }
}
