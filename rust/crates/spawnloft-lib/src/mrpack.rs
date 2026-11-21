//! `mrpack.mjs` (C5): Modrinth modpacks (`.mrpack`) as servers. `modrinth.index.json` lists the
//! files, their hashes and download addresses; `overrides/` and `server-overrides/` are
//! configuration laid on top, the latter winning. Everything is downloaded and checked before
//! the server is made, and a failed install removes it again.
//!
//! Packs come from strangers, so every rule of the Node module holds here case for case
//! (test/modpack-hardening.test.mjs and test/mrpack.test.mjs, mapped one to one in `tests.rs`):
//! paths confined to the server folder, downloads only over https from the hosts the pack format
//! allows, redirects followed by hand and held to https on a public address, each file capped
//! at its declared size and checked against every published checksum before it gets its name.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::activity::Actor;
use crate::cancel;
use crate::failure::Failure;
use crate::modrinth::{self, Lost, Reply, Request};
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::text::human_bytes;
use crate::{js, jspath, plugins, sources};

/// The provenance record of a whole pack, in the server's folder.
pub const PACK_FILE: &str = ".mcctl-pack.json";

/// The hosts the Modrinth pack format allows. The index must not be able to point a download at
/// an arbitrary address (a service on localhost, say).
pub const ALLOWED_PACK_HOSTS: [&str; 4] = [
    "cdn.modrinth.com",
    "github.com",
    "raw.githubusercontent.com",
    "gitlab.com",
];

/// Cap on a single pack file, so a pack cannot fill the disk by lying about (or never ending) a
/// download.
pub const MAX_PACK_FILE_BYTES: u64 = 1024 * 1024 * 1024;
/// Cap when the pack states no size (the format requires one, but packs are not trusted).
pub const DEFAULT_PACK_FILE_BYTES: u64 = 256 * 1024 * 1024;

const REDIRECT_STATUS: [u16; 5] = [301, 302, 303, 307, 308];

/// What is progress to the command line: the message of each `onProgress({ message })`.
pub type OnProgress<'a> = &'a mut dyn FnMut(&str);

/// The transport: the network, or a test's scripted answers (`fetchImpl`).
pub type Fetch<'a> = &'a mut dyn FnMut(&Request<'_>) -> Result<Reply, Lost>;

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `allowedPackUrl(raw)`: the normalised address if it is https from an allowed host with no
/// login, else `None`.
pub fn allowed_pack_url(raw: &Value) -> Option<String> {
    let url = url::Url::parse(&js::string(Some(raw))).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if url.port().is_some_and(|p| p != 443) {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    if !ALLOWED_PACK_HOSTS.contains(&host.as_str()) {
        return None;
    }
    Some(url.to_string())
}

/// One file of a pack, as `parseIndex` reduces it.
#[derive(Debug, Clone, PartialEq)]
pub struct PackFile {
    pub path: String,
    pub sha1: Option<String>,
    pub sha512: Option<String>,
    pub url: String,
    pub size: f64,
}

/// The loader a pack needs: `fabric` or `neoforge`, and its version as the index wrote it.
#[derive(Debug, Clone, PartialEq)]
pub struct Loader {
    pub kind: &'static str,
    pub version: Value,
    /// the version as text, once checked (`assertSafeVersion`'s answer)
    pub text: String,
}

impl Loader {
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind, "version": self.version })
    }
}

/// `parseIndex(index)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Index {
    pub name: Value,
    pub version_id: Value,
    pub mc: Value,
    /// the Minecraft version as text, once checked
    pub mc_text: String,
    pub loader: Loader,
    pub files: Vec<PackFile>,
    pub skipped: usize,
}

fn field<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(key),
        _ => None,
    }
}

/// `String(value ?? '')` and `assertSafeVersion`.
fn safe_version(value: Option<&Value>, label: &str) -> Result<String, Failure> {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        v => js::string(v),
    };
    sources::assert_safe_version(&text, label)
}

/// `parseIndex(index)`: reduces the index to what the install needs and refuses loaders
/// SpawnLoft cannot run, paths outside the pack, hosts a pack may not use, files with no
/// checksum (or one that is not a checksum) and impossible sizes. Any one bad file refuses the
/// whole pack.
pub fn parse_index(index: &Value) -> Result<Index, Failure> {
    let files_raw = match field(Some(index), "files") {
        Some(Value::Array(f))
            if js::truthy(Some(index))
                && field(Some(index), "game").and_then(Value::as_str) == Some("minecraft") =>
        {
            f
        }
        _ => {
            return Err(Failure::user(
                "that file does not look like a Modrinth modpack index",
            ));
        }
    };
    let deps = match field(Some(index), "dependencies") {
        None | Some(Value::Null) => None,
        d => d,
    };
    let mc = field(deps, "minecraft");
    if !js::truthy(mc) {
        return Err(Failure::user("the pack names no Minecraft version"));
    }
    for other in ["forge", "quilt-loader"] {
        if js::truthy(field(deps, other)) {
            return Err(Failure::user(format!(
                "this pack is built for {}, which SpawnLoft cannot run - Fabric and NeoForge packs only",
                other.replacen("-loader", "", 1)
            )));
        }
    }
    let (kind, version) = if js::truthy(field(deps, "fabric-loader")) {
        ("fabric", field(deps, "fabric-loader"))
    } else if js::truthy(field(deps, "neoforge")) {
        ("neoforge", field(deps, "neoforge"))
    } else {
        return Err(Failure::user(
            "the pack names no loader SpawnLoft can run (Fabric or NeoForge)",
        ));
    };
    // these become a jar store file name and part of a download address
    let mc_text = safe_version(mc, "the pack's Minecraft version")?;
    let loader_text = safe_version(
        version,
        if kind == "fabric" {
            "the pack's Fabric loader version"
        } else {
            "the pack's NeoForge version"
        },
    )?;

    let mut files = Vec::new();
    for f in files_raw {
        let env = match f {
            Value::Null => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'env')",
                ));
            }
            other => field(Some(other), "env"),
        };
        if field(env, "server").and_then(Value::as_str) == Some("unsupported") {
            continue;
        }
        let raw_path = js::string(field(Some(f), "path")).replace('\\', "/");
        let hashes = match field(Some(f), "hashes") {
            Some(h @ (Value::Object(_) | Value::Array(_))) => h.clone(),
            _ => json!({}),
        };
        let downloads = match field(Some(f), "downloads") {
            Some(Value::Array(d)) => d.clone(),
            _ => Vec::new(),
        };
        let url = downloads.iter().find_map(allowed_pack_url);
        files.push((
            raw_path,
            hashes,
            downloads.len(),
            url,
            field(Some(f), "fileSize").cloned(),
        ));
    }
    let mut out = Vec::new();
    for (raw_path, hashes, downloads, url, size) in &files {
        // author-supplied paths are confined here, once
        let Some(path) = crate::util::safe_relative_path(raw_path) else {
            return Err(Failure::user(format!(
                "the pack lists a file outside its own folder (\"{raw_path}\"); refusing the whole pack"
            )));
        };
        if *downloads == 0 {
            return Err(Failure::user(format!(
                "the pack gives no download for \"{path}\""
            )));
        }
        let Some(url) = url else {
            return Err(Failure::user(format!(
                "\"{path}\" is only offered from a host a pack may not use (https from {} only); refusing the whole pack",
                ALLOWED_PACK_HOSTS.join(", ")
            )));
        };
        // a file with no published checksum cannot be verified; every published one is checked
        for (kind, len) in [("sha1", 40), ("sha512", 128)] {
            let h = field(Some(hashes), kind);
            if !matches!(h, None | Some(Value::Null)) && !is_hex(&js::string(h), len) {
                return Err(Failure::user(format!(
                    "the pack's {kind} checksum for \"{path}\" is not a checksum; refusing the whole pack"
                )));
            }
        }
        if !js::truthy(field(Some(hashes), "sha1")) && !js::truthy(field(Some(hashes), "sha512")) {
            return Err(Failure::user(format!(
                "the pack publishes no checksum for \"{path}\", so it could not be verified; refusing the whole pack"
            )));
        }
        let size_value = match size {
            None | Some(Value::Null) => None,
            Some(v) => Some(v),
        };
        if let Some(v) = size_value {
            let ok = v
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9007199254740991.0 && n >= 0.0);
            if !ok {
                return Err(Failure::user(format!(
                    "the pack lists an impossible size for \"{path}\"; refusing the whole pack"
                )));
            }
        }
        let sum = |kind: &str| {
            let h = field(Some(hashes), kind);
            js::truthy(h).then(|| js::string(h).to_lowercase())
        };
        out.push(PackFile {
            path,
            sha1: sum("sha1"),
            sha512: sum("sha512"),
            url: url.clone(),
            size: size_value.and_then(Value::as_f64).unwrap_or(0.0),
        });
    }
    let name = field(Some(index), "name");
    let version_id = field(Some(index), "versionId");
    Ok(Index {
        name: if js::truthy(name) {
            name.cloned().unwrap_or(Value::Null)
        } else {
            json!("modpack")
        },
        version_id: if js::truthy(version_id) {
            version_id.cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        },
        mc: mc.cloned().unwrap_or(Value::Null),
        mc_text,
        loader: Loader {
            kind,
            version: version.cloned().unwrap_or(Value::Null),
            text: loader_text,
        },
        skipped: files_raw.len() - files.len(),
        files: out,
    })
}

// ---------------------------------------------------------------------------------------------
// Verified downloads

/// `isLocalHost(hostname)`: loopback, private, link-local and other addresses that are not
/// public.
pub fn is_local_host(hostname: &str) -> bool {
    let lower = hostname.to_ascii_lowercase();
    let h = lower.strip_prefix('[').unwrap_or(&lower);
    let h = h.strip_suffix(']').unwrap_or(h);
    if h == "localhost" || h.ends_with(".localhost") || h == "::1" || h == "::" {
        return true;
    }
    let b = h.as_bytes();
    let hex = |c: u8| c.is_ascii_hexdigit();
    let fe80 = b.len() >= 5
        && b[0] == b'f'
        && b[1] == b'e'
        && matches!(b[2], b'8' | b'9' | b'a' | b'b')
        && hex(b[3])
        && b[4] == b':';
    let fc00 =
        b.len() >= 5 && b[0] == b'f' && matches!(b[1], b'c' | b'd') && hex(b[2]) && hex(b[3]) && b[4] == b':';
    if h.starts_with("::ffff:") || fe80 || fc00 {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4
        || !parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let n = |p: &str| p.parse::<f64>().unwrap_or(f64::INFINITY);
    let (a, b) = (n(parts[0]), n(parts[1]));
    a == 0.0
        || a == 10.0
        || a == 127.0
        || a >= 224.0
        || (a == 169.0 && b == 254.0)
        || (a == 172.0 && (16.0..=31.0).contains(&b))
        || (a == 192.0 && b == 168.0)
}

/// The options of `downloadVerified`.
#[derive(Debug, Clone)]
pub struct Verify<'a> {
    pub size: f64,
    pub sha1: Option<&'a str>,
    pub sha512: Option<&'a str>,
    pub label: &'a str,
    pub timeout: Duration,
    pub max_redirects: usize,
}

impl Default for Verify<'_> {
    fn default() -> Self {
        Verify {
            size: 0.0,
            sha1: None,
            sha512: None,
            label: "",
            timeout: Duration::from_secs(180),
            max_redirects: 5,
        }
    }
}

/// `download failed: <why> (<url>)`.
fn failed(why: &str, url: &str) -> Failure {
    Failure::user(format!("download failed: {why} ({url})"))
}

fn too_large(label: &str, cap: u64) -> Failure {
    Failure::user(format!(
        "\"{label}\" is larger than the {} the pack allows for it; nothing was installed",
        human_bytes(Some(cap as f64))
    ))
}

/// `downloadVerified(url, dest, opts)`: streams to `<dest>.part` and renames it into place only
/// when the size and every published checksum match, so a bad file never has the final name.
/// The declared size is also the read cap. Redirects are followed by hand because each hop must
/// still be https on a public address. Answers the bytes received.
pub fn download_verified(url: &str, dest: &Path, o: &Verify<'_>, fetch: Fetch<'_>) -> Result<u64, Failure> {
    let label = if o.label.is_empty() { url } else { o.label };
    if o.size > MAX_PACK_FILE_BYTES as f64 {
        return Err(Failure::user(format!(
            "\"{label}\" says it is {}, more than the {} a pack file may be; nothing was installed",
            human_bytes(Some(o.size)),
            human_bytes(Some(MAX_PACK_FILE_BYTES as f64))
        )));
    }
    let cap = if o.size > 0.0 {
        o.size as u64
    } else {
        DEFAULT_PACK_FILE_BYTES
    };
    cancel::check_cancelled()?;

    let mut current = url.to_string();
    let mut hop = 0;
    let reply = loop {
        let Ok(target) = url::Url::parse(&current) else {
            return Err(Failure::user(format!(
                "download failed: \"{current}\" is not a URL"
            )));
        };
        let host = target.host_str().unwrap_or("");
        if target.scheme() != "https"
            || !target.username().is_empty()
            || target.password().is_some()
            || is_local_host(host)
        {
            return Err(Failure::user(format!(
                "download refused: {} is not an https address on the internet",
                target.origin().ascii_serialization()
            )));
        }
        let href = target.to_string();
        let reply = fetch(&Request {
            method: "GET",
            url: &href,
            user_agent: modrinth::NODE_UA,
            json_body: None,
            timeout: o.timeout,
            manual_redirects: true,
        })
        .map_err(|e| {
            if cancel::check_cancelled().is_err() {
                cancel::cancelled()
            } else {
                failed(&e.why(), url)
            }
        })?;
        if !REDIRECT_STATUS.contains(&reply.status) {
            break reply;
        }
        let next = reply.location.clone().filter(|l| !l.is_empty());
        drop(reply);
        let Some(next) = next.filter(|_| hop < o.max_redirects) else {
            return Err(Failure::user(format!(
                "download failed: too many redirects ({url})"
            )));
        };
        current = target
            .join(&next)
            .map_err(|_| Failure::Internal {
                head: "TypeError".into(),
                message: "Invalid URL".into(),
                code: Some("ERR_INVALID_URL".into()),
            })?
            .to_string();
        hop += 1;
    };
    if !reply.ok_with_body() {
        return Err(Failure::user(format!(
            "download failed: {} for {url}",
            reply.status
        )));
    }
    let announced = reply
        .content_length
        .as_deref()
        .map(js::string_to_number)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0);
    if announced > cap as f64 {
        return Err(too_large(label, cap));
    }

    let part = {
        let mut p = dest.as_os_str().to_owned();
        p.push(".part");
        std::path::PathBuf::from(p)
    };
    let mut sums: Vec<(&str, crate::download::Hasher)> = Vec::new();
    if let Some(want) = o.sha1 {
        sums.push((want, crate::download::Hasher::new(crate::download::Hash::Sha1)));
    }
    if let Some(want) = o.sha512 {
        sums.push((want, crate::download::Hasher::new(crate::download::Hash::Sha512)));
    }
    let mut received: u64 = 0;
    let streamed = (|| -> Result<(), Failure> {
        let mut sink = std::fs::File::create(&part)
            .map_err(|e| failed(&jspath::node_error(&e, "open", Some(&part)), url))?;
        let mut body = reply.body;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            cancel::check_cancelled()?;
            let n = match body.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    return Err(failed(modrinth::TIMED_OUT, url));
                }
                Err(_) => return Err(failed("terminated", url)),
            };
            received += n as u64;
            if received > cap {
                return Err(too_large(label, cap));
            }
            for (_, h) in sums.iter_mut() {
                h.update(&chunk[..n]);
            }
            sink.write_all(&chunk[..n])
                .map_err(|e| failed(&jspath::node_error(&e, "write", None), url))?;
        }
        Ok(())
    })();
    if let Err(e) = streamed {
        let _ = std::fs::remove_file(&part);
        return Err(if cancel::check_cancelled().is_err() {
            cancel::cancelled()
        } else {
            e
        });
    }
    if o.size > 0.0 && received as f64 != o.size {
        let _ = std::fs::remove_file(&part);
        return Err(Failure::user(format!(
            "\"{label}\" is not the size the pack published; nothing was installed"
        )));
    }
    for (want, h) in sums {
        if h.hex() != want {
            let _ = std::fs::remove_file(&part);
            return Err(Failure::user(format!(
                "\"{label}\" did not match the checksum the pack published; nothing was installed"
            )));
        }
    }
    std::fs::rename(&part, dest).map_err(|e| {
        let (code, text) = jspath::error_code(&e);
        Failure::Internal {
            head: "Error".into(),
            message: format!(
                "{code}: {text}, rename '{}' -> '{}'",
                part.display(),
                dest.display()
            ),
            code: Some(code.into()),
        }
    })?;
    Ok(received)
}

/// A pack file staged on disk, ready to be copied into place.
#[derive(Debug, Clone, PartialEq)]
pub struct Staged {
    pub file: PackFile,
    pub at: String,
}

/// `stagePackFiles(index, tmp, onProgress)`: each file downloaded and verified into
/// `<tmp>/staged/<n>`, in the pack's order; the first bad one stops it. `tmp` is the caller's
/// to remove.
pub fn stage_pack_files(
    index: &Index,
    tmp: &str,
    on_progress: OnProgress<'_>,
    fetch: Fetch<'_>,
) -> Result<Vec<Staged>, Failure> {
    let dir = jspath::join(&[tmp, "staged"]);
    crate::fsx::mkdir_all(Path::new(&dir))?;
    let total = index.files.len();
    let mut staged = Vec::new();
    for (i, f) in index.files.iter().enumerate() {
        let base = f.path.rsplit('/').next().unwrap_or(&f.path);
        on_progress(&format!("Downloading {base} ({} of {total})", i + 1));
        let file = jspath::join(&[&dir, &i.to_string()]);
        download_verified(
            &f.url,
            Path::new(&file),
            &Verify {
                size: f.size,
                sha1: f.sha1.as_deref(),
                sha512: f.sha512.as_deref(),
                label: &f.path,
                ..Verify::default()
            },
            fetch,
        )?;
        staged.push(Staged {
            file: f.clone(),
            at: file,
        });
    }
    Ok(staged)
}

// ---------------------------------------------------------------------------------------------
// The pack on Modrinth

const RUNNABLE: [&str; 2] = ["fabric", "neoforge"];

/// `resolvePackVersion(projectId)`: the newest Fabric or NeoForge release and its file.
fn resolve_pack_version(project_id: &str) -> Result<(Value, Value), Failure> {
    let path = format!(
        "/project/{}/version?{}",
        sources::encode_uri_component(project_id),
        modrinth::search_param("loaders", "[\"fabric\",\"neoforge\"]")
    );
    let versions = modrinth::modrinth_request(&path, None)?;
    let Some(version) = modrinth::pick_version(&versions, None, &RUNNABLE)? else {
        return Err(Failure::user(
            "that pack has no Fabric or NeoForge release SpawnLoft can install",
        ));
    };
    let Some(file) = modrinth::primary_file(&version)? else {
        return Err(Failure::user("that pack version has no downloadable file"));
    };
    Ok((version, file))
}

/// `download(url)`: the whole pack archive in memory, with a 180 s limit.
fn download_whole(url: &str) -> Result<Vec<u8>, Failure> {
    cancel::check_cancelled()?;
    let reply = modrinth::send(&Request {
        method: "GET",
        url,
        user_agent: modrinth::NODE_UA,
        json_body: None,
        timeout: Duration::from_secs(180),
        manual_redirects: false,
    })
    .map_err(|e| {
        if cancel::check_cancelled().is_err() {
            cancel::cancelled()
        } else {
            failed(&e.why(), url)
        }
    })?;
    if !reply.ok() {
        return Err(Failure::user(format!(
            "download failed: {} for {url}",
            reply.status
        )));
    }
    modrinth::read_all(reply).map_err(|f| match f {
        Failure::Internal { head, .. } if head == "TimeoutError" => failed(modrinth::TIMED_OUT, url),
        _ => failed("terminated", url),
    })
}

/// A scratch folder `<tmpdir>/spawnloft-mrpack-XXXXXX` (`fs.mkdtempSync`).
fn make_tmp() -> Result<String, Failure> {
    let base = crate::util::os_tmpdir();
    for _ in 0..100 {
        let mut b = [0u8; 6];
        let _ = getrandom::fill(&mut b);
        const ALPHA: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let tag: String = b
            .iter()
            .map(|x| ALPHA[*x as usize % ALPHA.len()] as char)
            .collect();
        let dir = jspath::join(&[&base, &format!("spawnloft-mrpack-{tag}")]);
        // `fs.mkdtempSync` makes the folder 0700: what is staged in it is checked, then copied
        #[cfg(unix)]
        let builder = {
            let mut b = std::fs::DirBuilder::new();
            std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
            b
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        match builder.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(Failure::io(&e, "mkdtemp", Some(Path::new(&dir)))),
        }
    }
    Err(Failure::user("could not make a scratch folder"))
}

fn remove_tree(dir: &str) {
    let _ = std::fs::remove_dir_all(dir);
}

/// The pack archive fetched, its checksum checked, and its index read and parsed.
struct Archive {
    tmp: String,
    mrpack: String,
    index: Index,
}

/// `fetchPackArchive(packFile, onProgress)`.
fn fetch_pack_archive(pack_file: &Value, on_progress: OnProgress<'_>) -> Result<Archive, Failure> {
    on_progress(&format!(
        "Downloading {}",
        js::string(field(Some(pack_file), "filename"))
    ));
    let url = js::string(field(Some(pack_file), "url"));
    let bytes = download_whole(&url)?;
    let want = modrinth::prop(field(Some(pack_file), "hashes"), "sha1")
        .ok()
        .flatten();
    if js::truthy(want) {
        let got = crate::sha1::hex(&bytes);
        if Some(&json!(got)) != want {
            return Err(Failure::user(
                "the pack download did not match its checksum; nothing was installed",
            ));
        }
    }
    let tmp = make_tmp()?;
    let read = || -> Result<Archive, Failure> {
        let mrpack = jspath::join(&[&tmp, "pack.mrpack"]);
        std::fs::write(&mrpack, &bytes).map_err(|e| Failure::io(&e, "open", Some(Path::new(&mrpack))))?;
        let Some(raw) = crate::zip::jar::read_entry(Path::new(&mrpack), "modrinth.index.json")? else {
            return Err(Failure::user(
                "the pack has no modrinth.index.json - it is not an mrpack",
            ));
        };
        let value = crate::jsjson::parse(&String::from_utf8_lossy(&raw)).map_err(Failure::syntax)?;
        let index = parse_index(&value)?;
        Ok(Archive {
            tmp: tmp.clone(),
            mrpack,
            index,
        })
    };
    read().inspect_err(|_| remove_tree(&tmp))
}

/// Fetching the loader caches it in the jar store, so the install after it is a cache hit.
/// The loader fetched into the jars store before anything changes. A Fabric launcher's name
/// comes back: the instance names it from the start, as a create with no jar is refused.
fn cache_loader(
    layout: &Layout,
    index: &Index,
    on_progress: OnProgress<'_>,
) -> Result<Option<String>, Failure> {
    if index.loader.kind == "fabric" {
        on_progress(&format!(
            "Fetching Fabric {} for {}",
            index.loader.text, index.mc_text
        ));
        let launcher =
            sources::fabric_fetch(&layout.jars_dir, &index.mc_text, Some(&index.loader.text), false)?;
        return Ok(Some(launcher.name));
    }
    sources::neo_fetch_installer(&layout.jars_dir, &index.loader.text, on_progress)?;
    Ok(None)
}

/// `installLoader(inst, index)`: Fabric's launcher placed in the folder; NeoForge's installer run
/// inside it. The jar name to record.
fn install_loader(
    layout: &Layout,
    inst: &Instance,
    index: &Index,
    on_progress: OnProgress<'_>,
) -> Result<String, Failure> {
    let dir = crate::create::path_arg(inst.get("dir"), "path")?.to_string();
    if index.loader.kind == "fabric" {
        on_progress(&format!(
            "Fetching Fabric {} for {}",
            index.loader.text, index.mc_text
        ));
        let launcher =
            sources::fabric_fetch(&layout.jars_dir, &index.mc_text, Some(&index.loader.text), false)?;
        crate::create::place_jar(&layout.jars_dir, &dir, &launcher.name)?;
        return Ok(launcher.name);
    }
    let installer = sources::neo_fetch_installer(&layout.jars_dir, &index.loader.text, on_progress)?;
    sources::neo_install_server(&dir, &installer.path, &inst.java(), on_progress)?;
    Ok("server.jar".into())
}

fn copy_staged(
    dir: &str,
    staged: &[Staged],
    after_each: &mut dyn FnMut(&Staged) -> Result<(), Failure>,
) -> Result<(), Failure> {
    for f in staged {
        let parts: Vec<&str> = f.file.path.split('/').collect();
        let mut all = vec![dir];
        all.extend(parts);
        let target = jspath::join(&all);
        crate::fsx::mkdir_all(Path::new(&jspath::dirname(&target)))?;
        std::fs::copy(&f.at, &target).map_err(|e| {
            let (code, text) = jspath::error_code(&e);
            Failure::Internal {
                head: "Error".into(),
                message: format!("{code}: {text}, copyfile '{}' -> '{target}'", f.at),
                code: Some(code.into()),
            }
        })?;
        after_each(f)?;
    }
    Ok(())
}

/// `overrides/` then `server-overrides/` laid over the folder; the paths written, in order.
fn lay_overrides(mrpack: &str, dir: &str) -> Result<Vec<String>, Failure> {
    let strip = |prefix: &'static str| move |name: &str| name.strip_prefix(prefix).map(str::to_string);
    let mut laid = crate::zip::jar::extract(Path::new(mrpack), Path::new(dir), strip("overrides/"))?;
    laid.extend(crate::zip::jar::extract(
        Path::new(mrpack),
        Path::new(dir),
        strip("server-overrides/"),
    )?);
    Ok(laid)
}

/// Whether a pack path is a mod jar directly in `mods/` (the ones shown in the Mods tab).
fn is_top_mod(path: &str) -> bool {
    path.starts_with("mods/") && path.ends_with(".jar") && !path[5..].contains('/')
}

/// The options `cmdNew` hands `createFromModpack`.
#[derive(Debug, Clone)]
pub struct PackOptions {
    pub memory: Value,
    pub port: Option<f64>,
    pub online_mode: bool,
}

/// What `createFromModpack` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct Created {
    pub name: String,
    pub pack: Value,
    pub pack_version: Option<Value>,
    pub mc: Value,
    pub loader: Loader,
    pub files: usize,
    pub skipped: usize,
    pub port: f64,
}

/// `version.version_number`: `None` is undefined, which JSON leaves out and text prints as
/// `undefined`.
fn version_number(version: &Value) -> Option<Value> {
    field(Some(version), "version_number").cloned()
}

/// An object of `pairs` as `JSON.stringify` writes it: an undefined value leaves its key out.
fn object(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(
        pairs
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (k.to_string(), v)))
            .collect(),
    )
}

/// `createFromModpack(name, projectId, opts)`.
pub fn create_from_modpack(
    layout: &Layout,
    by: &Actor,
    name: &str,
    project_id: &str,
    o: PackOptions,
    on_progress: OnProgress<'_>,
) -> Result<Created, Failure> {
    on_progress("Finding the pack on Modrinth");
    let (version, pack_file) = resolve_pack_version(project_id)?;
    let Archive { tmp, mrpack, index } = fetch_pack_archive(&pack_file, on_progress)?;

    let before = (|| -> Result<(Vec<Staged>, crate::create::Made), Failure> {
        let jar = cache_loader(layout, &index, on_progress)?;
        let staged = stage_pack_files(&index, &tmp, on_progress, &mut modrinth::send)?;
        // the last point where stopping leaves nothing behind but the scratch folder
        cancel::check_cancelled()?;
        on_progress("Creating the server");
        let made = crate::create::new_instance(
            layout,
            by,
            name,
            crate::create::NewOptions {
                jar: jar.map_or(Value::Null, Value::from),
                loader: index.loader.kind.into(),
                mc_version: Some(index.mc_text.clone()),
                memory: Some(o.memory.clone()),
                port: o.port,
                online_mode: o.online_mode,
                accept_eula: true,
                motd: index.name.clone(),
                ..crate::create::NewOptions::default()
            },
        )?;
        Ok((staged, made))
    })();
    let (staged, made) = match before {
        Ok(x) => x,
        Err(e) => {
            // only the scratch folder exists at this point
            remove_tree(&tmp);
            return Err(e);
        }
    };
    let inst = Instance {
        name: name.to_string(),
        fields: made.cfg.clone(),
    };
    let dir = made.text("dir");
    let registry_file = Path::new(&layout.registry_file);

    let laid = (|| -> Result<(), Failure> {
        let jar = install_loader(layout, &inst, &index, on_progress)?;
        let mut patch = Map::new();
        patch.insert("jar".into(), json!(jar));
        if !index.mc.is_string() {
            // the record keeps the version as the pack wrote it
            patch.insert("mcVersion".into(), index.mc.clone());
        }
        registry::update_instance(registry_file, name, &patch)?;
        copy_staged(&dir, &staged, &mut |f| {
            // pack-owned mods show in the Mods tab but are never offered updates of their own;
            // recorded as each is copied, so a pack that ships the record file itself overwrites
            // what came before it, as in Node
            if is_top_mod(&f.file.path) {
                plugins::record_managed(
                    &inst,
                    jspath::basename(&f.file.path).as_str(),
                    object(vec![
                        ("source", Some(json!("modpack"))),
                        ("project", Some(json!(project_id))),
                        ("version", version_number(&version)),
                        ("installedAt", Some(json!(crate::time::iso_now()))),
                    ]),
                )?;
            }
            Ok(())
        })?;
        on_progress("Applying the pack\u{2019}s configuration");
        let overrides = lay_overrides(&mrpack, &dir)?;
        let mut files: Vec<Value> = index.files.iter().map(|f| json!(f.path)).collect();
        files.extend(overrides.into_iter().map(Value::String));
        crate::client::write_json(
            &jspath::join(&[&dir, PACK_FILE]),
            &object(vec![
                ("project", Some(json!(project_id))),
                ("versionId", Some(index.version_id.clone())),
                ("versionNumber", version_number(&version)),
                ("name", Some(index.name.clone())),
                ("mc", Some(index.mc.clone())),
                ("loader", Some(index.loader.to_json())),
                ("installedAt", Some(json!(crate::time::iso_now()))),
                ("files", Some(json!(files))),
                ("skippedClientOnly", Some(json!(index.skipped))),
            ]),
        )
    })();
    if let Err(e) = laid {
        // this call made the server, so it removes the half-laid pack; the original error is the
        // one worth reporting
        if registry::remove_instance(registry_file, name).is_ok() {
            remove_tree(&dir);
        }
        remove_tree(&tmp);
        return Err(e);
    }
    remove_tree(&tmp);
    Ok(Created {
        name: name.to_string(),
        pack: index.name,
        pack_version: version_number(&version),
        mc: index.mc,
        loader: index.loader,
        files: index.files.len(),
        skipped: index.skipped,
        port: made.port,
    })
}

// ---------------------------------------------------------------------------------------------
// A pack server's pack

/// `packOf(inst)`: the record, or `None` when it is missing or does not parse.
pub fn pack_of(inst: &Instance) -> Option<Value> {
    let dir = inst.dir()?;
    let bytes = std::fs::read(jspath::join(&[dir, PACK_FILE])).ok()?;
    // callers test `if (!pack)`: a record of null, 0, false or "" is no record
    crate::jsjson::parse(&String::from_utf8_lossy(&bytes))
        .ok()
        .filter(|v| js::truthy(Some(v)))
}

/// `loaderOfRecord(pack)`: `loader`, or the older `fabricLoader`.
fn loader_of_record(pack: &Value) -> Option<(Value, Value)> {
    match field(Some(pack), "loader") {
        None | Some(Value::Null) => {
            let fl = field(Some(pack), "fabricLoader");
            js::truthy(fl).then(|| (json!("fabric"), fl.cloned().unwrap_or(Value::Null)))
        }
        Some(l) => Some((
            field(Some(l), "kind").cloned().unwrap_or(Value::Null),
            field(Some(l), "version").cloned().unwrap_or(Value::Null),
        )),
    }
}

/// `planRemovals(oldFiles, newFiles, { protect })`: what an update may delete, the files the old
/// pack owned that the new one does not, never a protected path (exactly or as a folder above
/// it, in any case) and never a path that climbs or is absolute. Paths are compared as the file
/// they name (`safeRelativePath`), so `./ops.json` in a pack's overrides is ops.json.
pub fn plan_removals(old: &[Value], new: &[Value], protect: &[String]) -> Vec<String> {
    let norm = |p: &Value| crate::util::safe_relative_path(&js::string(Some(p)));
    let keep: std::collections::HashSet<String> = new.iter().filter_map(norm).collect();
    let guards: Vec<String> = protect.iter().map(|g| g.to_lowercase()).collect();
    let guarded = |p: &str| {
        let low = p.to_lowercase();
        guards
            .iter()
            .any(|g| low == *g || low.starts_with(&format!("{g}/")))
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in old.iter().filter_map(norm) {
        if !seen.insert(p.clone()) {
            continue;
        }
        if !keep.contains(&p) && !guarded(&p) {
            out.push(p);
        }
    }
    out
}

fn protected_paths(inst: &Instance) -> Result<Vec<String>, Failure> {
    let dir = crate::create::path_arg(inst.get("dir"), "path")?;
    let props = crate::props::read(Path::new(&jspath::join(&[dir, "server.properties"])))?;
    let level = crate::props::get(&props, "level-name")
        .filter(|l| !l.is_empty())
        .unwrap_or("world")
        .to_string();
    let mut out = vec![
        level.clone(),
        format!("{level}_nether"),
        format!("{level}_the_end"),
    ];
    for p in [
        "server.properties",
        "eula.txt",
        "ops.json",
        "whitelist.json",
        "banned-players.json",
        "banned-ips.json",
        "usercache.json",
        PACK_FILE,
        "mods/.mcctl-plugins.json",
        "plugins/.mcctl-plugins.json",
    ] {
        out.push(p.into());
    }
    Ok(out)
}

fn not_from_a_pack(name: &str) -> Failure {
    Failure::user(format!("\"{name}\" was not built from a modpack"))
}

/// What `checkPackUpdate` answers that the command line prints.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub latest: Option<Value>,
    pub update_available: bool,
}

/// `checkPackUpdate(inst)`.
pub fn check_pack_update(inst: &Instance) -> Result<Check, Failure> {
    let Some(pack) = pack_of(inst) else {
        return Err(not_from_a_pack(&inst.name));
    };
    let (version, _) = resolve_pack_version(&js::string(field(Some(&pack), "project")))?;
    let latest = version_number(&version);
    let current = field(Some(&pack), "versionNumber");
    Ok(Check {
        update_available: !js::strict_equals(latest.as_ref(), current),
        latest,
    })
}

/// What `updatePack` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum Updated {
    AlreadyLatest(Option<Value>),
    Done {
        from: Option<Value>,
        to: Option<Value>,
        mc: Value,
        mc_changed: bool,
        files: usize,
        removed: usize,
        snapshot: String,
    },
}

/// `updatePack(name)`: download and check everything first, snapshot, and only then change
/// files. Only files the old record owned and the new pack dropped are deleted.
pub fn update_pack(
    layout: &Layout,
    by: &Actor,
    name: &str,
    on_progress: OnProgress<'_>,
) -> Result<Updated, Failure> {
    let registry_file = Path::new(&layout.registry_file);
    let inst = registry::lookup(registry_file, name)?;
    let (status, _) = crate::control::read_state(Path::new(&layout.state_file(name)))?;
    if matches!(
        status,
        crate::control::Status::Running | crate::control::Status::Stopping
    ) {
        return Err(Failure::user(format!(
            "\"{name}\" is running - stop it before updating its pack, or its own files change under it"
        )));
    }
    let Some(pack) = pack_of(&inst) else {
        return Err(not_from_a_pack(name));
    };
    on_progress("Finding the pack on Modrinth");
    let project = field(Some(&pack), "project").cloned();
    let (version, pack_file) = resolve_pack_version(&js::string(project.as_ref()))?;
    let old_number = field(Some(&pack), "versionNumber").cloned();
    let new_number = version_number(&version);
    if js::strict_equals(new_number.as_ref(), old_number.as_ref()) {
        return Ok(Updated::AlreadyLatest(old_number));
    }

    let Archive { tmp, mrpack, index } = fetch_pack_archive(&pack_file, on_progress)?;
    let result = (|| -> Result<Updated, Failure> {
        // cache the loader now so the install after the snapshot cannot fail on a download
        cache_loader(layout, &index, on_progress)?;
        let staged = stage_pack_files(&index, &tmp, on_progress, &mut modrinth::send)?;

        on_progress("Snapshotting before anything changes");
        let snap = crate::backup::create_snapshot(
            layout,
            by,
            &inst,
            &crate::backup::Options {
                scope: "standard".into(),
                label: json!("pre-pack-update"),
                running: false,
                ..crate::backup::Options::default()
            },
        )?;

        on_progress("Applying the new pack");
        let dir = crate::create::path_arg(inst.get("dir"), "path")?.to_string();
        copy_staged(&dir, &staged, &mut |_| Ok(()))?;
        let overrides = lay_overrides(&mrpack, &dir)?;
        let mut new_owned: Vec<Value> = index.files.iter().map(|f| json!(f.path)).collect();
        new_owned.extend(overrides.into_iter().map(Value::String));

        // `oldFiles = []` stands in for undefined only
        let old_files: Vec<Value> = match field(Some(&pack), "files") {
            None => Vec::new(),
            Some(Value::Array(a)) => a.clone(),
            Some(Value::Null) => {
                return Err(Failure::type_error(
                    "Cannot read properties of null (reading 'map')",
                ));
            }
            Some(_) => return Err(Failure::type_error("oldFiles.map is not a function")),
        };
        let removals = plan_removals(&old_files, &new_owned, &protected_paths(&inst)?);
        for p in &removals {
            let mut all = vec![dir.as_str()];
            all.extend(p.split('/'));
            let target = jspath::join(&all);
            match std::fs::symlink_metadata(&target) {
                Ok(m) if m.is_dir() => {
                    return Err(Failure::Internal {
                        head: "SystemError [ERR_FS_EISDIR]".into(),
                        message: format!("Path is a directory: rm returned EISDIR (is a directory) {target}"),
                        code: Some("ERR_FS_EISDIR".into()),
                    });
                }
                Ok(_) => std::fs::remove_file(&target)
                    .map_err(|e| Failure::io(&e, "rm", Some(Path::new(&target))))?,
                // `force` forgives a file that is not there, and nothing else
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(Failure::io(&e, "lstat", Some(Path::new(&target)))),
            }
        }

        let changed = match loader_of_record(&pack) {
            None => true,
            Some((kind, v)) => {
                kind.as_str() != Some(index.loader.kind)
                    || !js::strict_equals(Some(&v), Some(&index.loader.version))
            }
        };
        if changed {
            let jar = install_loader(layout, &inst, &index, on_progress)?;
            if inst.get("jar").and_then(Value::as_str) != Some(jar.as_str()) {
                let mut patch = Map::new();
                patch.insert("jar".into(), json!(jar));
                registry::update_instance(registry_file, name, &patch)?;
            }
        }
        let mut patch = Map::new();
        patch.insert("mcVersion".into(), index.mc.clone());
        patch.insert("loader".into(), json!(index.loader.kind));
        registry::update_instance(registry_file, name, &patch)?;

        // `contentPathFor(inst, file)`: by the loader the server had when the update began
        let content_dir = match inst.get("loader").and_then(Value::as_str) {
            Some("fabric" | "neoforge") => "mods",
            _ => "plugins",
        };
        let store = plugins::read_managed(&inst)?;
        let entries: Vec<(String, Value)> = match store.get("managed") {
            Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            Some(Value::Array(a)) => a
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
            _ => Vec::new(),
        };
        for (file, entry) in js::object_entries(entries) {
            let source = modrinth::prop(Some(&entry), "source")?;
            if source.and_then(Value::as_str) == Some("modpack")
                && !Path::new(&jspath::join(&[&dir, content_dir, &file])).exists()
            {
                plugins::forget_managed(&inst, &file)?;
            }
        }
        for f in &index.files {
            if is_top_mod(&f.path) {
                plugins::record_managed(
                    &inst,
                    jspath::basename(&f.path).as_str(),
                    object(vec![
                        ("source", Some(json!("modpack"))),
                        ("project", project.clone()),
                        ("version", new_number.clone()),
                        ("installedAt", Some(json!(crate::time::iso_now()))),
                    ]),
                )?;
            }
        }
        crate::client::write_json(
            &jspath::join(&[&dir, PACK_FILE]),
            &object(vec![
                ("project", project.clone()),
                ("versionId", Some(index.version_id.clone())),
                ("versionNumber", new_number.clone()),
                ("name", Some(index.name.clone())),
                ("mc", Some(index.mc.clone())),
                ("loader", Some(index.loader.to_json())),
                ("installedAt", Some(json!(crate::time::iso_now()))),
                ("files", Some(json!(new_owned))),
                ("skippedClientOnly", Some(json!(index.skipped))),
            ]),
        )?;
        Ok(Updated::Done {
            from: old_number.clone(),
            to: new_number.clone(),
            mc: index.mc.clone(),
            mc_changed: !js::strict_equals(Some(&index.mc), field(Some(&pack), "mc")),
            files: index.files.len(),
            removed: removals.len(),
            snapshot: snap.file,
        })
    })();
    remove_tree(&tmp);
    result
}

#[cfg(test)]
mod tests;
