//! players.rs, mclogs.rs and scrubber.rs against test/fixtures/contracts/c6-library.json: the
//! server folder, the scrubber's files and the operations there, run in order as
//! tools/parity/c6-library-run.mjs ran them on the Node core, must give the same answers and
//! errors; so must the Mojang lookups over the same canned answers and the pure functions.

use regex::Regex;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::path::{Path, PathBuf};

use crate::failure::Failure;
use crate::mclogs;
use crate::players::{self, Answer, Console, Who};
use crate::scrubber;
use crate::settings::Layout;

fn fixture() -> Value {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/contracts/c6-library.json");
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

fn even_text(roots: &[String], s: &str) -> String {
    let mut t = s.to_string();
    for root in roots {
        t = t.replace(root.as_str(), "<root>");
        if cfg!(windows) {
            t = t.replace(&root.replace('\\', "/"), "<root>");
        }
    }
    let stamp = Regex::new(r"\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?").unwrap();
    let iso = Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").unwrap();
    let ban = Regex::new(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}").unwrap();
    let t = stamp.replace_all(&t, "<stamp>");
    let t = iso.replace_all(&t, "<time>");
    ban.replace_all(&t, "<ban stamp>").into_owned()
}

fn even(roots: &[String], v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(even_text(roots, s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| even(roots, x)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), even(roots, x))).collect()),
        x => x.clone(),
    }
}

fn failure(roots: &[String], f: &Failure) -> Map<String, Value> {
    let code = match f {
        Failure::User { code, .. } | Failure::Internal { code, .. } => code.clone(),
        Failure::Usage(_) => None,
    };
    let mut m = Map::new();
    m.insert("error".into(), json!(even_text(roots, f.message())));
    m.insert("code".into(), json!(code));
    m
}

fn s(a: &[Value], i: usize) -> &str {
    a[i].as_str().unwrap()
}

fn b(a: &[Value], i: usize) -> bool {
    a[i].as_bool().unwrap()
}

struct Run {
    dir: PathBuf,
    data: PathBuf,
    layout: Layout,
}

impl Run {
    /// A console answering from the case, as the Node runner's `consoleOf`; the commands it saw.
    fn with_console(
        &self,
        c: &Value,
        f: impl FnOnce(&Console<'_>) -> Result<Value, Failure>,
        roots: &[String],
    ) -> Value {
        let seen = RefCell::new(Vec::<String>::new());
        let exec = |cmd: &str| -> Result<String, Failure> {
            seen.borrow_mut().push(cmd.to_string());
            if let Some(m) = c.get("fail").and_then(Value::as_str) {
                return Err(Failure::Internal {
                    head: "Error".into(),
                    message: m.into(),
                    code: None,
                });
            }
            if let Some(w) = c.get("writes").and_then(Value::as_object) {
                for (file, rows) in w {
                    std::fs::write(self.dir.join(file), rows.to_string()).unwrap();
                }
            }
            Ok(c.get("replies")
                .and_then(|r| r.get(cmd))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string())
        };
        let console = Console {
            running: c.get("running").and_then(Value::as_bool).unwrap_or(false),
            exec: &exec,
        };
        let mut out = match f(&console) {
            Ok(v) => Map::from_iter([("answer".to_string(), v)]),
            Err(e) => failure(roots, &e),
        };
        out.insert("commands".into(), json!(seen.into_inner()));
        Value::Object(out)
    }

    fn share(&self, a: &[Value], roots: &[String]) -> Value {
        let answer = &a[1];
        let sent = RefCell::new(Vec::<Value>::new());
        let post = |url: &str, body: &str| -> Result<mclogs::Reply, String> {
            sent.borrow_mut()
                .push(json!({ "url": url, "body": serde_json::from_str::<Value>(body).unwrap() }));
            if let Some(m) = answer.get("throws").and_then(Value::as_str) {
                return Err(m.into());
            }
            Ok(mclogs::Reply {
                status: answer["status"].as_u64().unwrap() as u16,
                body: crate::jsjson::parse(answer["body"].as_str().unwrap()).ok(),
            })
        };
        let got = mclogs::share_console(
            "srv",
            &self.dir.join(s(a, 0)),
            &self.data.join("run").join("mclogs.json"),
            &post,
        );
        let mut out = match got {
            Ok(v) => Map::from_iter([("result".to_string(), v)]),
            Err(e) => failure(roots, &e),
        };
        out.insert("sent".into(), Value::Array(sent.into_inner()));
        Value::Object(out)
    }

    fn op(&self, op: &str, a: &[Value], roots: &[String]) -> Result<Value, Failure> {
        let dir = &self.dir;
        Ok(match op {
            "listPlayers" => Value::Array(
                players::list_players(dir)?
                    .iter()
                    .map(players::Player::to_json)
                    .collect(),
            ),
            "storedPlayers" => players::stored_players(dir)?,
            "whitelistOn" => json!(players::whitelist_on(dir)?),
            "whitelistEnforced" => json!(players::whitelist_enforced(dir)?),
            "readFile" => json!(std::fs::read_to_string(dir.join(s(a, 0))).unwrap()),
            "writeFile" => {
                std::fs::write(dir.join(s(a, 0)), s(a, 1)).unwrap();
                json!("ok")
            }
            "setOp" => self.with_console(&a[2], |c| players::set_op("srv", dir, s(a, 0), b(a, 1), c), roots),
            "setBan" => self.with_console(
                &a[3],
                |c| players::set_ban("srv", dir, s(a, 0), b(a, 1), s(a, 2), c),
                roots,
            ),
            "setWhitelisted" => self.with_console(
                &a[2],
                |c| players::set_whitelisted("srv", dir, s(a, 0), b(a, 1), c),
                roots,
            ),
            "setWhitelistOn" => {
                self.with_console(&a[1], |c| players::set_whitelist_on(dir, b(a, 0), c), roots)
            }
            "addByName" => {
                let l = &a[4];
                let lookup = |_: &str| -> Result<Option<Who>, String> {
                    if let Some(e) = l.get("error").and_then(Value::as_str) {
                        return Err(e.into());
                    }
                    Ok(l.get("found").map(|f| Who {
                        uuid: f["uuid"].as_str().unwrap().into(),
                        name: f["name"].as_str().unwrap().into(),
                    }))
                };
                self.with_console(
                    &a[3],
                    |c| players::add_by_name(dir, s(a, 0), s(a, 1), s(a, 2), c, &lookup),
                    roots,
                )
            }
            "forgetPlayer" => {
                let mut v = players::forget_player("srv", dir, s(a, 0), b(a, 1))?;
                // the path module's separator, in a result Node made on a system with `/`
                for f in v["files"].as_array_mut().unwrap() {
                    *f = json!(f.as_str().unwrap().replace('\\', "/"));
                }
                v
            }
            "exportConsole" => {
                let r = mclogs::export_console("srv", &dir.join(s(a, 0)), &self.data.join("exports"))?;
                let mut v = r.to_json();
                v["copied"] = json!(std::fs::read_to_string(&r.file).unwrap());
                v["file"] = json!(even_text(roots, v["file"].as_str().unwrap()).replace('\\', "/"));
                v
            }
            "shareConsole" => self.share(a, roots),
            "readTokens" => serde_json::from_str(
                &std::fs::read_to_string(self.data.join("run").join("mclogs.json")).unwrap(),
            )
            .unwrap(),
            "scrubber" => json!(scrubber::scrubber(&self.layout, b(a, 1))(s(a, 0))),
            other => panic!("no operation {other}"),
        })
    }
}

fn pure(c: &Value) -> Result<Value, Failure> {
    use sha2::Digest;
    if let Some(g) = c.get("gen") {
        let line = g["unit"]
            .as_str()
            .unwrap()
            .repeat(g["repeat"].as_u64().unwrap() as usize);
        let mut text = vec![line.as_str(); g["count"].as_u64().unwrap() as usize].join("\n");
        if g["trailing"].as_bool().unwrap() {
            text.push('\n');
        }
        let r = mclogs::trim_for_upload(&text);
        let units: Vec<u16> = r.content.encode_utf16().collect();
        let head = String::from_utf16_lossy(&units[..units.len().min(12)]);
        let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(12)..]);
        let hex: String = sha2::Sha256::digest(r.content.as_bytes())
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect();
        return Ok(
            json!({ "lines": r.lines, "trimmed": r.trimmed, "bytes": r.content.len(), "sha256": hex, "head": head, "tail": tail }),
        );
    }
    let a = c["args"].as_array().unwrap();
    Ok(match c["op"].as_str().unwrap() {
        "redactAccountName" => json!(mclogs::redact_account_name(s(a, 0))),
        "trimForUpload" => {
            let r = mclogs::trim_for_upload(s(a, 0));
            json!({ "content": r.content, "lines": r.lines, "trimmed": r.trimmed })
        }
        "hideIps" => json!(scrubber::hide_ips(s(a, 0))),
        "scrub" => {
            let secrets: Vec<String> = a[1]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            json!(scrubber::scrub(s(a, 0), b(a, 2), &secrets))
        }
        "offlineUuid" => json!(players::offline_uuid(s(a, 0))),
        other => panic!("no function {other}"),
    })
}

fn write(file: &Path, value: &Value) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let text = match value {
        Value::String(s) => s.clone(),
        v => serde_json::to_string_pretty(v).unwrap(),
    };
    std::fs::write(file, text).unwrap();
}

fn expected(case: &Value) -> Value {
    let mut m = case.as_object().unwrap().clone();
    for k in ["op", "args", "gen"] {
        m.shift_remove(k);
    }
    Value::Object(m)
}

#[test]
fn players_mclogs_and_the_scrubber_answer_as_node_does() {
    let fx = fixture();
    let scratch = std::env::temp_dir().join(format!("sl-c6-contract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let data = scratch.join("data");
    let dir = data.join("instances").join("srv");
    for f in fx["tree"].as_array().unwrap() {
        write(&dir.join(f["path"].as_str().unwrap()), &f["text"]);
    }
    let sec = &fx["secrets"];
    write(&data.join("instances.json"), &sec["registry"]);
    write(&data.join("client").join("accounts.json"), &sec["accounts"]);
    write(&data.join("client").join("profiles.json"), &sec["profiles"]);
    for (name, state) in sec["states"].as_object().unwrap() {
        write(
            &data.join("client").join("run").join(name).join("state.json"),
            state,
        );
    }
    let layout = Layout::resolve(&Map::from_iter([(
        "dataRoot".to_string(),
        json!(data.to_string_lossy()),
    )]))
    .unwrap();
    let roots = vec![
        crate::fsx::realpath(&scratch)
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        scratch.to_string_lossy().into_owned(),
    ];
    let run = Run { dir, data, layout };
    let mut failures = Vec::new();
    for (i, case) in fx["ops"].as_array().unwrap().iter().enumerate() {
        let op = case["op"].as_str().unwrap();
        let got = match run.op(op, case["args"].as_array().unwrap(), &roots) {
            Ok(v) => json!({ "result": even(&roots, &v) }),
            Err(e) => Value::Object(failure(&roots, &e)),
        };
        if got != expected(case) {
            failures.push(format!("op {i} {op}:\n  node {}\n  rust {got}", expected(case)));
        }
    }
    for (i, case) in fx["mojang"].as_array().unwrap().iter().enumerate() {
        let a = case["args"].as_array().unwrap();
        let urls = RefCell::new(Vec::<String>::new());
        let get = |url: &str| -> Result<Answer, String> {
            urls.borrow_mut().push(url.to_string());
            if let Some(m) = a[1].get("throws").and_then(Value::as_str) {
                return Err(m.into());
            }
            Ok(Answer {
                status: a[1]["status"].as_u64().unwrap() as u16,
                body: crate::jsjson::parse(a[1]["body"].as_str().unwrap()).ok(),
            })
        };
        let got = match players::mojang_lookup(s(a, 0), &get) {
            Ok(w) => json!({ "result": w.map(|w| json!({ "uuid": w.uuid, "name": w.name })) }),
            Err(e) => json!({ "error": e }),
        };
        let mut got = got.as_object().unwrap().clone();
        got.insert("urls".into(), json!(urls.into_inner()));
        let got = Value::Object(got);
        if got != expected(case) {
            failures.push(format!("mojang {i}:\n  node {}\n  rust {got}", expected(case)));
        }
    }
    for (i, case) in fx["pure"].as_array().unwrap().iter().enumerate() {
        let got = match pure(case) {
            Ok(v) => json!({ "result": v }),
            Err(e) => Value::Object(failure(&roots, &e)),
        };
        if got != expected(case) {
            failures.push(format!(
                "pure {i} {}:\n  node {}\n  rust {got}",
                case["op"],
                expected(case)
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&scratch);
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
