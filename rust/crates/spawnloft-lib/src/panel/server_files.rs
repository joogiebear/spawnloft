//! `handleFiles` of `ui.mjs`: a server's files (list, read, save, upload, download, rename,
//! delete). What is refused is decided in `files.rs`; an upload's body is the file's bytes, not
//! JSON, with where it goes in the query string.

use serde_json::{Value, json};
use std::path::Path;
use std::sync::Mutex;

use crate::failure::Failure;
use crate::files::{self, Entry};
use crate::registry::{self, Instance};
use crate::settings::Layout;
use crate::{js, sources, supervisor};

use super::Panel;
use super::http::{Reply, Request, field};
use super::routes::Routed;

/// The changes below read what is there, decide, and change it; in Node each ran to its end
/// before another began, so here they take turns.
static CHANGING: Mutex<()> = Mutex::new(());

fn instance(layout: &Layout, name: &str) -> Result<Instance, Failure> {
    registry::lookup(Path::new(&layout.registry_file), name)
}

fn entries(rows: &[Entry]) -> Value {
    Value::Array(rows.iter().map(Entry::to_json).collect())
}

/// `typeof v === 'string' ? v : ''`, as the files functions read a path or a name.
fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `paths` as the files functions take it: a list, or nothing when it is not one.
fn paths(v: Option<&Value>) -> Vec<Option<&str>> {
    match v {
        Some(Value::Array(items)) => items.iter().map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// The download's `Content-Disposition`: `filename*` carries a name outside ASCII, and the plain
/// one, with every such character (each UTF-16 unit of it) and `"` made `_`, is the fallback.
fn disposition(name: &str) -> String {
    let plain: String = name
        .encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if (' '..='~').contains(&c) && c != '"' => c,
            _ => '_',
        })
        .collect();
    format!(
        "attachment; filename=\"{plain}\"; filename*=UTF-8''{}",
        sources::encode_uri_component(name)
    )
}

/// `path.posix.dirname` of a panel path.
fn posix_dirname(p: &str) -> &str {
    match p.rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => ".",
    }
}

/// `archivePaths` given a name that is truthy but not text: every check before the name's, then
/// the name's own refusal (`checkName` reads it as empty).
fn archive_with_odd_name(inst: &Instance, wanted: &[Option<&str>]) -> Failure {
    if wanted.is_empty() {
        return Failure::user("choose something to archive");
    }
    let mut rels = Vec::new();
    for p in wanted {
        match files::resolve_path(inst, *p, true, false) {
            Ok(r) => rels.push(r.rel),
            Err(e) => return e,
        }
    }
    let dir = posix_dirname(&rels[0]);
    if rels.iter().any(|r| posix_dirname(r) != dir) {
        return Failure::user("archive things from one folder at a time");
    }
    match files::check_name(None) {
        Err(e) => e,
        Ok(_) => unreachable!("an empty name is refused"),
    }
}

/// `/api/instances/<name>/files...`.
pub fn route(panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let _ = panel;
    Ok(Routed::Reply(handle(layout, req, name)?))
}

fn handle(layout: &Layout, req: &mut Request, name: &str) -> Result<Reply, Failure> {
    let inst = instance(layout, name)?;
    let verb = req.seg(4).map(str::to_string);
    let running = supervisor::is_running(layout, name)?;
    let q = |req: &Request, k: &str| req.q(k).unwrap_or("").to_string();
    let by = Panel::actor();

    if req.method == "GET" {
        let path = q(req, "path");
        match verb.as_deref() {
            None => {
                let (rel, rows) = files::list_dir(&inst, Some(&path), running)?;
                return Ok(Reply::ok(
                    json!({ "path": rel, "entries": entries(&rows), "running": running }),
                ));
            }
            Some("read") => {
                let f = files::read_file(&inst, Some(&path))?;
                let mut out = json!({ "path": f.path, "size": f.size, "modified": f.modified });
                match f.reason {
                    Some(reason) => {
                        out["text"] = Value::Null;
                        out["reason"] = json!(reason);
                    }
                    None => {
                        out["text"] = json!(f.text);
                        out["version"] = json!(f.version);
                    }
                }
                return Ok(Reply::ok(out));
            }
            // the end of a text file too big to edit, to read and not to save
            Some("tail") => {
                let t = files::read_tail(&inst, Some(&path), files::TAIL_BYTES, files::MAX_UNPACKED_BYTES)?;
                let mut out = json!({ "path": t.path, "size": t.size, "modified": t.modified });
                match t.reason {
                    Some(reason) => {
                        out["text"] = Value::Null;
                        out["reason"] = json!(reason);
                    }
                    None => {
                        out["text"] = json!(t.text);
                        out["whole"] = json!(t.whole);
                        out["shown"] = json!(t.shown);
                        out["of"] = json!(t.of);
                        out["packed"] = json!(t.packed);
                    }
                }
                return Ok(Reply::ok(out));
            }
            Some("image") => {
                let (file, size, kind) = files::image_file(&inst, Some(&path))?;
                return Ok(Reply::File {
                    // from the file's first bytes, never from its name, and not to be guessed at
                    // again; no more than was promised, if the file grows meanwhile
                    headers: vec![
                        ("Content-Type".into(), kind.into()),
                        ("X-Content-Type-Options".into(), "nosniff".into()),
                        (
                            "Content-Security-Policy".into(),
                            "default-src 'none'; sandbox".into(),
                        ),
                        ("Cache-Control".into(), "no-store".into()),
                    ],
                    file,
                    len: size,
                    done: None,
                });
            }
            Some("search") => {
                let found = files::search_names(&inst, Some(&path), Some(&q(req, "q")), running)?;
                return Ok(Reply::ok(json!({
                    "path": found.path,
                    "query": found.query,
                    "results": entries(&found.results),
                    "truncated": found.truncated,
                    "running": running,
                })));
            }
            Some("download") => {
                let out = files::downloadable(&inst, Some(&path))?;
                let headers = vec![
                    ("Content-Type".into(), "application/octet-stream".into()),
                    ("Content-Disposition".into(), disposition(&out.name)),
                    ("Cache-Control".into(), "no-store".into()),
                ];
                let (file, len) = (out.file.clone(), out.size);
                // a folder was zipped to a temporary file, removed once it has been sent
                return Ok(Reply::File {
                    headers,
                    file,
                    len,
                    done: Some(Box::new(move || out.done())),
                });
            }
            _ => return Ok(Reply::not_found()),
        }
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }

    if verb.as_deref() == Some("upload") {
        let (dir, file_name) = (q(req, "dir"), q(req, "name"));
        let overwrite = q(req, "overwrite") == "1";
        let up = files::upload_file(
            layout,
            &by,
            &inst,
            Some(&dir),
            Some(&file_name),
            &mut req.body,
            overwrite,
            running,
        )?;
        return Ok(Reply::ok(
            json!({ "path": up.path, "size": up.size, "snapshot": up.snapshot }),
        ));
    }
    let body = req.json()?;
    let _turn = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    match verb.as_deref() {
        Some("write") => {
            let path = text(field(&body, "path")?);
            let ask = files::WriteAsk {
                text: field(&body, "text")?.cloned(),
                // a version that is not text matches no file, as `version !== versionOf(...)`
                version: text(field(&body, "version")?).map(str::to_string),
                create: field(&body, "create")? == Some(&Value::Bool(true)),
                force: field(&body, "force")? == Some(&Value::Bool(true)),
            };
            let w = files::write_file(layout, &by, &inst, path, &ask)?;
            Ok(Reply::ok(json!({
                "path": w.path,
                "version": w.version,
                "snapshot": w.snapshot,
                "appliesOnRestart": running,
            })))
        }
        Some("mkdir") => {
            let dir = text(field(&body, "dir")?);
            let rel = files::make_folder(layout, &by, &inst, dir, text(field(&body, "name")?))?;
            Ok(Reply::ok(json!({ "path": rel })))
        }
        Some("move") => {
            let from = text(field(&body, "from")?);
            let (from, to) = files::move_path(layout, &by, &inst, from, text(field(&body, "to")?), running)?;
            Ok(Reply::ok(json!({ "from": from, "path": to })))
        }
        Some("delete") => {
            let wanted = paths(field(&body, "paths")?);
            let without_copy = field(&body, "withoutCopy")? == Some(&Value::Bool(true));
            let d = files::delete_paths(layout, &by, &inst, &wanted, without_copy, running)?;
            Ok(Reply::ok(json!({ "deleted": d.deleted, "snapshot": d.snapshot })))
        }
        Some("archive") => {
            let wanted = paths(field(&body, "paths")?);
            let name_v = field(&body, "name")?;
            let archive_name = match name_v {
                Some(Value::String(s)) => Some(s.as_str()),
                v if js::truthy(v) => return Err(archive_with_odd_name(&inst, &wanted)),
                _ => None,
            };
            let (rel, size) = files::archive_paths(layout, &by, &inst, &wanted, archive_name)?;
            Ok(Reply::ok(json!({ "path": rel, "size": size })))
        }
        Some("extract") => {
            let rel = files::extract_archive(layout, &by, &inst, text(field(&body, "path")?), running)?;
            Ok(Reply::ok(json!({ "path": rel })))
        }
        _ => Ok(Reply::not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_names_its_file_as_node_does() {
        assert_eq!(
            disposition("world.zip"),
            "attachment; filename=\"world.zip\"; filename*=UTF-8''world.zip"
        );
        assert_eq!(
            disposition("a \"b\" é😀.txt"),
            "attachment; filename=\"a _b_ ___.txt\"; filename*=UTF-8''a%20%22b%22%20%C3%A9%F0%9F%98%80.txt"
        );
        assert_eq!(
            disposition("x\r\ny"),
            "attachment; filename=\"x__y\"; filename*=UTF-8''x%0D%0Ay"
        );
    }

    #[test]
    fn dirname_is_posix() {
        assert_eq!(posix_dirname("a"), ".");
        assert_eq!(posix_dirname("a/b"), "a");
        assert_eq!(posix_dirname("a/b/c"), "a/b");
    }
}
