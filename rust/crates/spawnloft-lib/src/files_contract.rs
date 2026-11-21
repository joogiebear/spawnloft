//! files.rs and config_files.rs against test/fixtures/contracts/c3-library.json: the server folder
//! and operations there, run in order as tools/parity/c3-library-run.mjs ran them on the Node
//! core, must give the same answers, errors and activity.

use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

use crate::activity::Actor;
use crate::config_files::{self as cf, WriteAsk as PlanAsk};
use crate::failure::Failure;
use crate::files::{self, Entry, WriteAsk};
use crate::registry::Instance;
use crate::settings::Layout;

fn fixture() -> Value {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/contracts/c3-library.json");
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

struct Run {
    root: String,
    layout: Layout,
    inst: Instance,
    dir: PathBuf,
    last_snapshot: Option<String>,
}

fn even_text(root: &str, s: &str) -> String {
    let mut t = s.replace(root, "<root>");
    if cfg!(windows) {
        t = t.replace(&root.replace('\\', "/"), "<root>");
    }
    let stamp = Regex::new(r"\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?").unwrap();
    let iso = Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").unwrap();
    // the declared difference json-parse-error-text: V8's message, or serde_json's
    let v8 = Regex::new(r"(?:Expected |Unexpected )[^\n]*?(?:in JSON at position \d+(?: \(line \d+ column \d+\))?|is not valid JSON)").unwrap();
    let serde = Regex::new(r"JSON parse error: [^\n]*").unwrap();
    let t = stamp.replace_all(&t, "<stamp>");
    let t = iso.replace_all(&t, "<time>");
    let t = v8.replace_all(&t, "<invalid json>");
    serde.replace_all(&t, "<invalid json>").into_owned()
}

fn even(root: &str, v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(even_text(root, s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| even(root, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), even(root, x))).collect()),
        x => x.clone(),
    }
}

fn s(args: &[Value], i: usize) -> Option<&str> {
    args.get(i).and_then(Value::as_str)
}

fn opt(args: &[Value], i: usize, key: &str) -> Option<Value> {
    args.get(i).and_then(|o| o.get(key)).cloned()
}

fn flag(args: &[Value], i: usize, key: &str) -> bool {
    opt(args, i, key).is_some_and(|v| v == json!(true))
}

fn entries(list: &[Entry]) -> Value {
    Value::Array(list.iter().map(Entry::to_json).collect())
}

fn plan_ask(o: Option<&Value>) -> PlanAsk {
    let get = |k: &str| o.and_then(|o| o.as_object()).and_then(|m| m.get(k)).cloned();
    PlanAsk {
        content: get("content"),
        old_text: get("oldText"),
        new_text: get("newText"),
        hidden_restored: get("hiddenRestored") == Some(json!(true)),
    }
}

fn file_text(r: files::FileText) -> Value {
    let mut m = Map::new();
    m.insert("path".into(), json!(r.path));
    m.insert("size".into(), json!(r.size));
    m.insert("modified".into(), json!(r.modified));
    m.insert("text".into(), json!(r.text));
    if let Some(reason) = r.reason {
        m.insert("reason".into(), json!(reason));
    }
    if let Some(v) = r.version {
        m.insert("version".into(), json!(v));
    }
    Value::Object(m)
}

impl Run {
    fn by(&self) -> Actor {
        Actor::spawnloft()
    }

    fn op(&mut self, op: &str, a: &[Value]) -> Result<Value, Failure> {
        let (layout, inst, by) = (&self.layout, &self.inst, self.by());
        let paths = |v: Option<&Value>| -> Vec<Option<String>> {
            v.and_then(Value::as_array)
                .map(|l| l.iter().map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        Ok(match op {
            "resolvePath" => {
                let r = files::resolve_path(
                    inst,
                    s(a, 0),
                    opt(a, 1, "mustExist") != Some(json!(false)),
                    flag(a, 1, "allowRoot"),
                )?;
                json!({ "rel": r.rel, "exists": r.stat.is_some() })
            }
            "listDir" => {
                let (path, list) = files::list_dir(inst, s(a, 0), flag(a, 1, "running"))?;
                json!({ "path": path, "entries": entries(&list) })
            }
            "readFile" => file_text(files::read_file(inst, s(a, 0))?),
            "readTail" => {
                let bytes = opt(a, 1, "bytes")
                    .and_then(|v| v.as_u64())
                    .map_or(files::TAIL_BYTES, |n| n as usize);
                let max = opt(a, 1, "maxUnpacked")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(files::MAX_UNPACKED_BYTES);
                let t = files::read_tail(inst, s(a, 0), bytes, max)?;
                let mut m = Map::new();
                m.insert("path".into(), json!(t.path));
                m.insert("size".into(), json!(t.size));
                m.insert("modified".into(), json!(t.modified));
                m.insert("text".into(), json!(t.text));
                if let Some(r) = t.reason {
                    m.insert("reason".into(), json!(r));
                } else {
                    m.insert("whole".into(), json!(t.whole));
                    m.insert("shown".into(), json!(t.shown));
                    m.insert("of".into(), json!(t.of));
                    m.insert("packed".into(), json!(t.packed));
                }
                Value::Object(m)
            }
            "imageFile" => {
                let (_, size, kind) = files::image_file(inst, s(a, 0))?;
                json!({ "size": size, "type": kind })
            }
            "imageKind" => {
                let hex = s(a, 0).unwrap();
                let bytes: Vec<u8> = (0..hex.len())
                    .step_by(2)
                    .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                    .collect();
                json!(files::image_kind(&bytes))
            }
            "writeFile" | "writeFileFresh" => {
                let version = if op == "writeFileFresh" {
                    files::read_file(inst, s(a, 0))?.version
                } else {
                    opt(a, 1, "version").and_then(|v| v.as_str().map(str::to_string))
                };
                let w = files::write_file(
                    layout,
                    &by,
                    inst,
                    s(a, 0),
                    &WriteAsk {
                        text: opt(a, 1, "text"),
                        version,
                        create: flag(a, 1, "create"),
                        force: flag(a, 1, "force"),
                    },
                )?;
                json!({ "path": w.path, "version": w.version, "snapshot": w.snapshot })
            }
            "makeFolder" => json!({ "path": files::make_folder(layout, &by, inst, s(a, 0), s(a, 1))? }),
            "uploadFile" => {
                let body = s(a, 2).unwrap().as_bytes().to_vec();
                let u = files::upload_file(
                    layout,
                    &by,
                    inst,
                    s(a, 0),
                    s(a, 1),
                    &mut body.as_slice(),
                    flag(a, 3, "overwrite"),
                    flag(a, 3, "running"),
                )?;
                json!({ "path": u.path, "size": u.size, "snapshot": u.snapshot })
            }
            "sameButForCase" => {
                let names: Vec<String> = a[2]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                json!(files::same_but_for_case(
                    s(a, 0).unwrap(),
                    s(a, 1).unwrap(),
                    &names
                ))
            }
            "movePath" => {
                let (from, path) =
                    files::move_path(layout, &by, inst, s(a, 0), s(a, 1), flag(a, 2, "running"))?;
                json!({ "from": from, "path": path })
            }
            "deletePaths" => {
                let owned = paths(a.first());
                let refs: Vec<Option<&str>> = owned.iter().map(|p| p.as_deref()).collect();
                let d = files::delete_paths(
                    layout,
                    &by,
                    inst,
                    &refs,
                    flag(a, 1, "withoutCopy"),
                    flag(a, 1, "running"),
                )?;
                json!({ "deleted": d.deleted, "snapshot": d.snapshot })
            }
            "undoLast" => {
                let name = self.last_snapshot.clone().unwrap_or_default();
                let (restored, members) = files::undo_snapshot(layout, &by, inst, &name, false)?;
                json!({ "restored": restored, "members": members })
            }
            "archivePaths" => {
                let owned = paths(a.first());
                let refs: Vec<Option<&str>> = owned.iter().map(|p| p.as_deref()).collect();
                let (path, size) = files::archive_paths(layout, &by, inst, &refs, s(a, 1))?;
                json!({ "path": path, "sized": size > 0 })
            }
            "extractArchive" => {
                json!({ "path": files::extract_archive(layout, &by, inst, s(a, 0), flag(a, 1, "running"))? })
            }
            "searchNames" => {
                let f = files::search_names(inst, s(a, 0), s(a, 1), flag(a, 2, "running"))?;
                let mut results = entries(&f.results);
                // Node lists a folder in the file system's own order, which is byte order only on Unix
                if !cfg!(unix)
                    && let Value::Array(l) = &mut results
                {
                    l.sort_by(|x, y| x["path"].as_str().cmp(&y["path"].as_str()));
                }
                json!({ "path": f.path, "query": f.query, "results": results, "truncated": f.truncated })
            }
            "backupStandard" => {
                let made = crate::backup::create_snapshot(
                    layout,
                    &by,
                    inst,
                    &crate::backup::Options {
                        flush: false,
                        quiet: true,
                        ..Default::default()
                    },
                )?;
                self.last_snapshot = Some(crate::jspath::basename(&made.file));
                return Ok(json!({ "made": true }));
            }
            "downloadable" => {
                let d = files::downloadable(inst, s(a, 0))?;
                let own = crate::jspath::join_path(
                    &self.dir.to_string_lossy(),
                    &s(a, 0).unwrap().split('/').collect::<Vec<_>>(),
                );
                let v = json!({ "name": d.name, "sized": d.size > 0, "temp": d.file != own });
                d.done();
                v
            }
            "resolveConfigPath" => {
                let r = cf::resolve_config_path(inst, s(a, 0), opt(a, 1, "mustExist") != Some(json!(false)))?;
                json!({ "shown": r.shown, "exists": r.exists })
            }
            "listConfigFiles" => {
                let (list, truncated) = cf::list_config_files(inst, s(a, 0).unwrap_or(""))?;
                let list: Vec<Value> = list
                    .iter()
                    .map(|f| json!({ "path": f.path, "sizeBytes": f.size_bytes }))
                    .collect();
                json!({ "files": list, "truncated": truncated })
            }
            "readConfigFile" => {
                let r = cf::read_config_file(inst, s(a, 0))?;
                json!({ "path": r.path, "text": r.text, "sizeBytes": r.size_bytes, "redacted": r.redacted })
            }
            "planConfigWrite" => {
                let p = cf::plan_config_write(inst, s(a, 0), &plan_ask(a.get(1)))?;
                json!({ "shown": p.shown, "existed": p.existed, "before": p.before, "after": p.after })
            }
            "applyPlan" => {
                let p = cf::plan_config_write(inst, s(a, 0), &plan_ask(a.get(1)))?;
                cf::apply_config_write(&p)?;
                json!({ "written": std::fs::read_to_string(&p.full).unwrap() })
            }
            "unchangedSince" => {
                let p = cf::plan_config_write(inst, s(a, 0), &plan_ask(a.get(1)))?;
                let first = cf::unchanged_since(&p)?;
                use std::io::Write;
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&p.full)
                    .unwrap()
                    .write_all(b"# touched\n")
                    .unwrap();
                json!({ "first": first, "after": cf::unchanged_since(&p)? })
            }
            other => panic!("no operation {other}"),
        })
    }
}

fn pure(op: &str, a: &[Value]) -> Result<Value, Failure> {
    Ok(match op {
        "redactConfig" => json!(cf::redact_config(s(a, 0).unwrap())),
        "checkFormat" => {
            cf::check_format(s(a, 0).unwrap(), s(a, 1).unwrap())?;
            json!("ok")
        }
        "summarizeChange" => json!(cf::summarize_change(
            s(a, 0),
            s(a, 1).unwrap(),
            a[2].as_u64().unwrap() as usize
        )),
        "restoreHidden" => json!(cf::restore_hidden(s(a, 0).unwrap(), s(a, 1).unwrap())?),
        "extname" => json!(crate::jspath::extname(s(a, 0).unwrap())),
        other => panic!("no function {other}"),
    })
}

fn answer(root: &str, r: Result<Value, Failure>) -> Value {
    match r {
        Ok(v) => json!({ "result": even(root, &v) }),
        Err(f) => {
            let code = match &f {
                Failure::User { code, .. } | Failure::Internal { code, .. } => code.clone(),
                Failure::Usage(_) => None,
            };
            json!({ "error": even_text(root, f.message()), "code": code })
        }
    }
}

fn expected(root: &str, case: &Value) -> Value {
    let mut m = case.as_object().unwrap().clone();
    m.remove("op");
    m.remove("args");
    // the fixture's own text evened out the same way (the JSON parse message)
    even(root, &Value::Object(m))
}

#[test]
fn files_and_config_files_answer_as_node_does() {
    let fx = fixture();
    let scratch = std::env::temp_dir().join(format!("sl-c3-contract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let data = scratch.join("data");
    let dir = data.join("instances").join("srv");
    for f in fx["tree"].as_array().unwrap() {
        let full = dir.join(f["path"].as_str().unwrap());
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        let bytes = match f.get("base64") {
            Some(b) => base64(b.as_str().unwrap()),
            None => f["text"].as_str().unwrap().as_bytes().to_vec(),
        };
        std::fs::write(&full, bytes).unwrap();
    }
    let dir_text = dir.to_string_lossy().into_owned();
    let mut fields = fx["instance"].as_object().unwrap().clone();
    fields.insert("dir".into(), json!(dir_text));
    std::fs::write(
        data.join("instances.json"),
        json!({ "version": 1, "instances": { "srv": fields } }).to_string(),
    )
    .unwrap();
    let real_root = crate::fsx::realpath(&scratch)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let layout = Layout::resolve(&Map::from_iter([(
        "dataRoot".to_string(),
        json!(data.to_string_lossy()),
    )]))
    .unwrap();
    let mut run = Run {
        root: real_root.clone(),
        layout,
        inst: Instance {
            name: "srv".into(),
            fields,
        },
        dir: dir.clone(),
        last_snapshot: None,
    };
    let mut failures = Vec::new();
    let root_text = scratch.to_string_lossy().into_owned();
    for (i, case) in fx["ops"].as_array().unwrap().iter().enumerate() {
        let op = case["op"].as_str().unwrap();
        let args = case["args"].as_array().unwrap();
        let got = run.op(op, args);
        if let Ok(v) = &got
            && let Some(s) = v.get("snapshot").and_then(Value::as_str)
        {
            run.last_snapshot = Some(s.to_string());
        }
        // both the scratch path and its real path (macOS /var is /private/var)
        let got = answer(
            &run.root,
            got.map(|v| even(&root_text, &v)).map_err(|f| match f {
                Failure::User { message, code } => Failure::User {
                    message: message.replace(&root_text, "<root>"),
                    code,
                },
                f => f,
            }),
        );
        let want = expected(&run.root, case);
        if got != want {
            failures.push(format!("op {i} {op} {args:?}\n  node: {want}\n  rust: {got}"));
        }
    }
    for (i, case) in fx["pure"].as_array().unwrap().iter().enumerate() {
        let op = case["op"].as_str().unwrap();
        let args = case["args"].as_array().unwrap();
        let got = answer(&real_root, pure(op, args));
        let want = expected(&real_root, case);
        if got != want {
            failures.push(format!("pure {i} {op} {args:?}\n  node: {want}\n  rust: {got}"));
        }
    }
    let log = std::fs::read_to_string(data.join("activity.jsonl")).unwrap_or_default();
    let activity: Vec<Value> = log
        .lines()
        .map(|l| even(&real_root, &serde_json::from_str::<Value>(l).unwrap()))
        .collect();
    if Value::Array(activity.clone()) != fx["activity"] {
        failures.push(format!(
            "activity\n  node: {}\n  rust: {}",
            fx["activity"],
            Value::Array(activity)
        ));
    }
    let _ = std::fs::remove_dir_all(&scratch);
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn base64(text: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in text.bytes().filter(|&c| c != b'=') {
        buf = (buf << 6) | A.iter().position(|&x| x == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

/// Links are not in the fixture (Windows runners cannot always make them); the confinement rules
/// for them, as files.test.mjs and config-files.test.mjs hold the Node side to.
#[cfg(unix)]
#[test]
fn links_leading_out_of_the_server_folder_are_inert() {
    use std::os::unix::fs::symlink;
    let scratch = std::env::temp_dir().join(format!("sl-c3-links-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let dir = scratch.join("srv");
    let outside = scratch.join("outside");
    std::fs::create_dir_all(dir.join("plugins")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.yml"), "a: 1\n").unwrap();
    std::fs::write(dir.join("plugins/in.yml"), "b: 2\n").unwrap();
    symlink(&outside, dir.join("out")).unwrap();
    symlink(outside.join("secret.yml"), dir.join("plugins/secret.yml")).unwrap();
    symlink("in.yml", dir.join("plugins/same.yml")).unwrap();
    let inst = Instance {
        name: "srv".into(),
        fields: Map::from_iter([("dir".to_string(), json!(dir.to_string_lossy()))]),
    };
    let leads = |r: Result<_, Failure>| match r {
        Err(f) => f.message().contains("leads outside the server folder"),
        Ok(_) => false,
    };
    // walking into a linked folder that leads out is refused, the link itself is shown inert
    assert!(leads(
        files::resolve_path(&inst, Some("out/secret.yml"), true, false).map(|_| ())
    ));
    assert!(leads(
        files::read_file(&inst, Some("plugins/secret.yml")).map(|_| ())
    ));
    let (_, list) = files::list_dir(&inst, Some("plugins"), false).unwrap();
    let kind = |n: &str| list.iter().find(|e| e.name == n).unwrap().kind;
    assert_eq!((kind("secret.yml"), kind("same.yml")), ("link", "file"));
    assert!(leads(files::list_dir(&inst, Some("out"), false).map(|_| ())));
    // the assistant's view refuses the same
    assert!(leads(
        cf::resolve_config_path(&inst, Some("plugins/secret.yml"), true).map(|_| ())
    ));
    assert!(leads(cf::list_config_files(&inst, "out").map(|_| ())));
    assert_eq!(
        cf::read_config_file(&inst, Some("plugins/same.yml"))
            .unwrap()
            .text,
        "b: 2\n"
    );
    // a delete acts on the link, never on what it points at
    let layout = Layout::resolve(&Map::from_iter([(
        "dataRoot".to_string(),
        json!(scratch.join("data").to_string_lossy()),
    )]))
    .unwrap();
    files::delete_paths(&layout, &Actor::spawnloft(), &inst, &[Some("out")], true, false).unwrap();
    assert!(outside.join("secret.yml").exists() && !dir.join("out").exists());
    std::fs::remove_dir_all(&scratch).unwrap();
}
