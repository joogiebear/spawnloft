//! The part of `client-meta.mjs` the version lists need: Mojang's version manifest and the small
//! JSON lists kept beside it in the cache folder (`cachedJson`), each with the time it was
//! fetched. The library, argument and natives readers come with install and launch.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

use super::paths::Paths;
use crate::failure::Failure;

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const RESOURCES_URL: &str = "https://resources.download.minecraft.net";

/// How a list is fetched: `fetchJson(url, { label })` unless a caller (a test) says otherwise.
pub type FetchJson<'a> = &'a (dyn Fn(&str, &str) -> Result<Value, Failure> + Sync);

pub fn default_fetch(url: &str, label: &str) -> Result<Value, Failure> {
    crate::download::fetch_json(url, label)
}

/// `cachedJson`'s options.
#[derive(Clone, Copy)]
pub struct Cached<'a> {
    pub label: &'a str,
    pub max_age_ms: f64,
    pub min_age_ms: f64,
    pub force: bool,
    pub fetch: FetchJson<'a>,
}

impl std::fmt::Debug for Cached<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cached")
            .field("label", &self.label)
            .field("force", &self.force)
            .finish()
    }
}

impl<'a> Cached<'a> {
    pub fn new(label: &'a str, force: bool) -> Cached<'a> {
        Cached {
            label,
            max_age_ms: 3_600_000.0,
            min_age_ms: 60_000.0,
            force,
            fetch: &default_fetch,
        }
    }
}

// When this process last went to the network for each cached list (`lastTried`).
static LAST_TRIED: Mutex<Option<HashMap<String, f64>>> = Mutex::new(None);

fn last_tried(dest: &str) -> f64 {
    LAST_TRIED
        .lock()
        .ok()
        .and_then(|m| m.as_ref().and_then(|m| m.get(dest).copied()))
        .unwrap_or(f64::NEG_INFINITY)
}

fn set_last_tried(dest: &str, at: f64) {
    if let Ok(mut m) = LAST_TRIED.lock() {
        m.get_or_insert_with(HashMap::new).insert(dest.to_string(), at);
    }
}

/// Tests: forget when this process last asked the network.
pub fn forget_tries() {
    if let Ok(mut m) = LAST_TRIED.lock() {
        *m = None;
    }
}

enum CacheRead {
    /// `JSON.parse(readFileSync(dest))` worked.
    Parsed(Value),
    /// ENOENT, or a file that is not JSON: no usable cache yet.
    Unusable,
}

fn read_cached(dest: &str) -> Result<CacheRead, Failure> {
    let path = std::path::Path::new(dest);
    match std::fs::read(path) {
        Ok(bytes) => match crate::jsjson::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(v) => Ok(CacheRead::Parsed(v)),
            Err(_) => Ok(CacheRead::Unusable),
        },
        Err(e) if crate::jspath::is_enoent(&e) => Ok(CacheRead::Unusable),
        Err(e) => Err(Failure::read(&e, path)),
    }
}

/// `cachedJson(file, url, opts)`: used while younger than `max_age_ms`, fetched again after; a
/// failed fetch falls back to the stale copy. `force` fetches now, unless the copy is younger
/// than `min_age_ms` or the network was tried that recently.
pub fn cached_json(cache_dir: &str, file: &str, url: &str, o: Cached<'_>) -> Result<Value, Failure> {
    let dest = crate::jspath::join(&[cache_dir, file]);
    let fetched_at_path = format!("{dest}.fetched-at");

    if let CacheRead::Parsed(cached) = read_cached(&dest)? {
        // the stamp is read inside the same try: a missing one means no usable cache
        let stamp = match std::fs::read(&fetched_at_path) {
            Ok(b) => Some(crate::js::string_to_number(&String::from_utf8_lossy(&b))),
            Err(e) if crate::jspath::is_enoent(&e) => None,
            Err(e) => return Err(Failure::read(&e, std::path::Path::new(&fetched_at_path))),
        };
        if let Some(fetched_at) = stamp {
            let now = crate::util::now();
            let age = now - fetched_at;
            let limit = if o.force { o.min_age_ms } else { o.max_age_ms };
            if !fetched_at.is_nan() && age < limit {
                return Ok(cached);
            }
            if now - last_tried(&dest) < o.min_age_ms {
                return Ok(cached);
            }
        }
    }

    set_last_tried(&dest, crate::util::now());
    let fetched = (o.fetch)(url, o.label).and_then(|body| {
        crate::fsx::mkdir_all(std::path::Path::new(cache_dir))?;
        super::write_atomic(&dest, crate::jsjson::stringify(&body).as_bytes())?;
        super::write_atomic(
            &fetched_at_path,
            crate::js::number_to_string(crate::util::now()).as_bytes(),
        )?;
        Ok(body)
    });
    match fetched {
        Ok(body) => Ok(body),
        Err(err) => match read_cached(&dest)? {
            CacheRead::Parsed(v) => Ok(v),
            CacheRead::Unusable => Err(err),
        },
    }
}

/// `fetchManifest({ cacheDir, force })`.
pub fn fetch_manifest(paths: &Paths, force: bool, fetch: FetchJson<'_>) -> Result<Value, Failure> {
    let mut o = Cached::new("the Minecraft version list", force);
    o.fetch = fetch;
    cached_json(&paths.cache_dir(), "version_manifest_v2.json", MANIFEST_URL, o)
}
