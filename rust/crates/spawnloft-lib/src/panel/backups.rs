//! `handleBackups` of `ui.mjs`: a server's backups (list, make, restore, delete, download, the
//! automatic-backup switch), with `pendingBackupsDir`, `autoBackupTask` and `backupTasksOf`.

use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::backup::{self, Snapshot};
use crate::failure::Failure;
use crate::paths::Roots;
use crate::platform::{self, preview_limits};
use crate::registry::{self, Instance};
use crate::schedule::{self, Sched};
use crate::settings::{self, Layout};
use crate::{activity, control, js, jsjson, jspath, supervisor};

use super::Panel;
use super::http::{Reply, Request, failure_reply, field, send};
use super::routes::Routed;

/// The scheduler of this data folder, changed in the panel's name.
pub(super) fn sched(layout: &Layout) -> Sched {
    Sched::new(&layout.data_root, &layout.run_dir, Panel::actor())
}

/// `platformCapabilities().scheduler`.
pub(super) fn scheduler_available() -> bool {
    js::truthy(platform::capabilities().get("scheduler"))
}

/// `schedule.background()` as the page gets it.
pub(super) fn background_json() -> Value {
    let (linger, session) = schedule::background();
    json!({ "linger": linger, "session": session })
}

fn record(layout: &Layout, name: &str, action: &str, detail: &str) {
    activity::record_by(
        &Roots::new(&layout.data_root),
        &Panel::actor(),
        name,
        action,
        Some(detail),
        None,
        true,
    );
}

/// `/api/instances/<name>/backups...`.
pub fn route(_panel: &Panel, layout: &Layout, req: &mut Request, name: &str) -> Result<Routed, Failure> {
    let inst = registry::lookup(Path::new(&layout.registry_file), name)?;
    let action = req.seg(4).map(str::to_string);
    let reply = |r: Reply| Ok(Routed::Reply(r));

    if req.method == "GET" && action.as_deref() == Some("download") {
        let snap = backup::resolve_snapshot(layout, name, req.q("snapshot").unwrap_or(""))?;
        return reply(download(snap)?);
    }
    if req.method == "GET" {
        let history = history(layout, &inst, name)?;
        // the tab draws this first and polls it; the scheduler lookup can take seconds
        if action.as_deref() == Some("history") {
            return reply(Reply::ok(history));
        }
        let automatic = automatic(layout, name)?;
        if action.as_deref() == Some("auto") {
            return reply(Reply::ok(automatic));
        }
        let mut both = match history {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Value::Object(m) = automatic {
            both.extend(m);
        }
        return reply(Reply::ok(Value::Object(both)));
    }
    if req.method != "POST" {
        return reply(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let Some(action) = action else {
        return reply(Reply::ok(create(layout, &inst, name, &body)?));
    };
    let which = || Reply::error(400, "which snapshot?");
    let snapshot_ref = |body: &Value| -> Result<Option<String>, Failure> {
        let s = field(body, "snapshot")?;
        Ok(js::truthy(s).then(|| js::string(s)))
    };
    let by = Panel::actor();
    match action.as_str() {
        "restore" => {
            let Some(reference) = snapshot_ref(&body)? else {
                return reply(which());
            };
            let state = PathBuf::from(layout.state_file(name));
            if let Some(blocked) = control::active_block(&state, name, "restoring")? {
                return reply(Reply::error(
                    409,
                    format!(
                        "{blocked} Extracting over a server that has those files open corrupts a world rather than replacing it."
                    ),
                ));
            }
            let snap = backup::resolve_snapshot(layout, name, &reference)?;
            // withoutCopy answers "the copy could not be kept; restore anyway?", never the default
            let opts = backup::RestoreOptions {
                clean: field(&body, "clean")? == Some(&Value::Bool(true)),
                keep_copy: field(&body, "withoutCopy")? != Some(&Value::Bool(true)),
                ..Default::default()
            };
            let out = backup::restore_snapshot(layout, &by, &inst, &snap, opts)?;
            reply(Reply::ok(json!({
                "restored": out.restored,
                "into": out.into,
                "members": snap.members,
                "databases": { "imported": out.databases.imported, "skipped": out.databases.skipped },
                "safety": out.safety,
            })))
        }
        "lock" => {
            let Some(reference) = snapshot_ref(&body)? else {
                return reply(which());
            };
            let locked = field(&body, "locked")? != Some(&Value::Bool(false));
            let snap = backup::set_snapshot_locked(layout, &by, name, &reference, locked)?;
            reply(Reply::ok(json!({ "name": snap, "locked": locked })))
        }
        "note" => {
            let Some(reference) = snapshot_ref(&body)? else {
                return reply(which());
            };
            // String(note ?? '')
            let note = match field(&body, "note")? {
                None | Some(Value::Null) => String::new(),
                v => js::string(v),
            };
            let (snap, clean) = backup::set_snapshot_note(layout, &by, name, &reference, &note)?;
            reply(Reply::ok(json!({ "name": snap, "note": clean })))
        }
        "exclude" => {
            let patterns = backup::clean_exclude_patterns(&exclude_lines(field(&body, "patterns")?))?;
            let mut patch = Map::new();
            patch.insert(
                "backupExclude".into(),
                if patterns.is_empty() {
                    Value::Null
                } else {
                    json!(patterns)
                },
            );
            registry::update_instance(Path::new(&layout.registry_file), name, &patch)?;
            let detail = if patterns.is_empty() {
                "backups leave nothing out".to_string()
            } else {
                format!("backups leave out {}", patterns.join(", "))
            };
            record(layout, name, "settings", &detail);
            reply(Reply::ok(json!({ "exclude": patterns })))
        }
        "delete" => {
            let Some(reference) = snapshot_ref(&body)? else {
                return reply(which());
            };
            let snap = backup::remove_snapshot(layout, &by, name, &reference)?;
            reply(Reply::ok(json!({ "removed": snap.name, "size": snap.size })))
        }
        "delete-many" => {
            let list = match field(&body, "snapshots")? {
                Some(Value::Array(a)) if !a.is_empty() => a,
                _ => return reply(Reply::error(400, "which backups?")),
            };
            let Some(refs) = list
                .iter()
                .map(|s| s.as_str().map(str::to_string))
                .collect::<Option<Vec<String>>>()
            else {
                return reply(Reply::error(400, "each backup is named by its file name"));
            };
            let out = backup::remove_snapshots(layout, &by, name, &refs)?;
            let skipped: Vec<Value> = out
                .skipped
                .iter()
                .map(|(n, why)| json!({ "name": n, "reason": why }))
                .collect();
            reply(Reply::ok(
                json!({ "removed": out.removed, "size": out.size, "skipped": skipped }),
            ))
        }
        "clean-copies" => clean_copies(layout, name, &body).map(Routed::Reply),
        "auto" => auto(layout, name, &body).map(Routed::Reply),
        _ => reply(Reply::not_found()),
    }
}

/// What the history half of the tab shows.
fn history(layout: &Layout, inst: &Instance, name: &str) -> Result<Value, Failure> {
    let snapshots: Vec<Value> = backup::list_snapshots(layout, name)?
        .iter()
        .map(Snapshot::to_json)
        .collect();
    Ok(json!({
        "snapshots": snapshots,
        "exclude": backup::exclude_patterns(inst),
        // the clean-up of small copies: whether this server has it on, and how old one has to be
        "cleanCopies": inst.get("backupCleanCopies") == Some(&Value::Bool(true)),
        "copyDays": jsjson::num(backup::COPY_DAYS),
        "dir": jspath::join(&[&layout.backups_dir, name]),
        "root": layout.backups_dir,
        // the folder saved for the next start, when it is not the one in use
        "pendingRoot": pending_backups_dir(layout),
        "mirror": backup::mirror_root()?,
        "running": supervisor::is_running(layout, name)?,
        "scopes": backup::SCOPES,
    }))
}

/// What the automatic half of the tab shows: one question to the scheduler for both answers.
fn automatic(layout: &Layout, name: &str) -> Result<Value, Failure> {
    let tasks = sched(layout).list()?;
    let (auto, others) = backup_tasks_of(&tasks, name)?;
    let auto = match auto {
        None => Value::Null,
        Some(t) => {
            let windows = t.get("windows").filter(|w| js::truthy(Some(w)));
            let mut m = Map::new();
            put(&mut m, "id", t.get("id"));
            put(&mut m, "enabled", t.get("enabled"));
            put(&mut m, "schedule", t.get("schedule"));
            m.insert(
                "keep".into(),
                or_null(t.get("action").and_then(|a| a.get("keep"))),
            );
            m.insert("state".into(), or_null(windows.and_then(|w| w.get("state"))));
            m.insert(
                "lastResult".into(),
                json!(windows.map(|w| schedule::describe_result(w.get("lastResult")))),
            );
            m.insert("nextRun".into(), or_null(windows.and_then(|w| w.get("nextRun"))));
            Value::Object(m)
        }
    };
    // other enabled tasks from Schedule that back this server up
    let scheduled: Vec<Value> = others
        .iter()
        .map(|t| {
            let mut m = Map::new();
            for k in ["id", "name", "schedule"] {
                put(&mut m, k, t.get(k));
            }
            Value::Object(m)
        })
        .collect();
    Ok(json!({
        "auto": auto,
        "scheduled": scheduled,
        "automaticAvailable": scheduler_available(),
        "automaticUnavailableReason": preview_limits::SCHEDULER,
        "background": background_json(),
    }))
}

/// `x ?? null`.
fn or_null(v: Option<&Value>) -> Value {
    v.cloned().unwrap_or(Value::Null)
}

/// `{ k: t.k }` as `JSON.stringify` writes it: an undefined value leaves the key out.
pub(super) fn put(m: &mut Map<String, Value>, k: &str, v: Option<&Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v.clone());
    }
}

/// `pendingBackupsDir()`: the backups folder is read once at startup, so one saved since then
/// is not in use yet and the page says so.
fn pending_backups_dir(layout: &Layout) -> Option<String> {
    let next = Layout::resolve(&settings::load().0).ok()?.backups_dir;
    (!next.is_empty() && next != layout.backups_dir).then_some(next)
}

/// `backupTasksOf(tasks, name)`: what backs a server up on a schedule. `auto` is the one task
/// the Backups page's own switch makes and edits (by its owner mark, or an unowned task with the
/// default name, made before the mark existed). `others` are the enabled tasks made in Schedule
/// that take a backup, alone or as a step. Also asked by the overview.
pub fn backup_tasks_of<'a>(
    tasks: &'a [Value],
    name: &str,
) -> Result<(Option<&'a Value>, Vec<&'a Value>), Failure> {
    let mine: Vec<&Value> = tasks
        .iter()
        .filter(|t| t.get("instance").and_then(Value::as_str) == Some(name))
        .collect();
    let kind = |t: &Value| {
        t.get("action")
            .and_then(|a| a.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let plain: Vec<&Value> = mine
        .iter()
        .copied()
        .filter(|t| kind(t).as_deref() == Some("backup"))
        .collect();
    let auto = plain
        .iter()
        .copied()
        .find(|t| t.get("owner").and_then(Value::as_str) == Some(schedule::OWNER_BACKUPS))
        .or_else(|| {
            plain.iter().copied().find(|t| {
                !js::truthy(t.get("owner"))
                    && t.get("name").and_then(Value::as_str) == Some("Automatic backup")
            })
        });
    let mut others = Vec::new();
    for t in mine {
        if auto.is_some_and(|a| std::ptr::eq(a, t)) || t.get("enabled") == Some(&Value::Bool(false)) {
            continue;
        }
        let backs_up = match kind(t).as_deref() {
            Some("backup") => true,
            Some("steps") => has_backup_step(t.get("action").and_then(|a| a.get("steps")))?,
            _ => false,
        };
        if backs_up {
            others.push(t);
        }
    }
    Ok((auto, others))
}

/// `(t.action.steps ?? []).some((step) => step.do === 'backup')`.
fn has_backup_step(steps: Option<&Value>) -> Result<bool, Failure> {
    let list = match steps {
        None | Some(Value::Null) => return Ok(false),
        Some(Value::Array(a)) => a,
        Some(_) => {
            return Err(Failure::type_error(
                "(t.action.steps ?? []).some is not a function",
            ));
        }
    };
    for step in list {
        if step.is_null() {
            return Err(Failure::type_error(
                "Cannot read properties of null (reading 'do')",
            ));
        }
        if step.get("do").and_then(Value::as_str) == Some("backup") {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `cleanExcludePatterns`' input as lines: a list's items as text, or anything else as text
/// split at line ends.
fn exclude_lines(input: Option<&Value>) -> Vec<String> {
    match input {
        Some(Value::Array(a)) => a.iter().map(|l| js::string(Some(l))).collect(),
        None | Some(Value::Null) => vec![String::new()],
        v => js::string(v)
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
            .collect(),
    }
}

/// `POST .../backups`: a backup now. A running server may be backed up; the files it holds
/// locked are left out and said.
fn create(layout: &Layout, inst: &Instance, name: &str, body: &Value) -> Result<Value, Failure> {
    let running = supervisor::is_running(layout, name)?;
    let scope = match field(body, "scope")? {
        Some(Value::String(s)) if backup::SCOPES.contains(&s.as_str()) => s.clone(),
        _ => "standard".into(),
    };
    let label = field(body, "label")?;
    let label = if js::truthy(label) {
        crate::schedule::steps::cut16(&js::string(label), 40)
    } else {
        "manual".into()
    };
    let out = backup::create_snapshot(
        layout,
        &Panel::actor(),
        inst,
        &backup::Options {
            scope,
            label: json!(label),
            running,
            ..Default::default()
        },
    )?;
    Ok(json!({
        "created": jspath::basename(&out.file),
        "size": out.size,
        "members": out.members,
        "skipped": out.skipped,
        "mirrored": out.mirrored,
        "mirrorError": out.mirror_error,
        "saveOnWarning": out.save_on_warning,
        // a backup that missed a database, or was copied while the server wrote, is not "Saved"
        "problems": backup::snapshot_problems(out.manifest.get("warnings")),
    }))
}

/// `POST .../backups/clean-copies`: the clean-up of small copies, on or off.
fn clean_copies(layout: &Layout, name: &str, body: &Value) -> Result<Reply, Failure> {
    // a missing or misspelled "on" must not read as either answer
    let Some(Value::Bool(on)) = field(body, "on")? else {
        return Ok(Reply::error(400, "on must be true or false"));
    };
    let on = *on;
    if on && backup::is_restoring(layout, name) {
        return Ok(Reply::error(
            409,
            "A backup is being put back right now. Turn the clean-up on when that has finished.",
        ));
    }
    let mut patch = Map::new();
    patch.insert(
        "backupCleanCopies".into(),
        if on { json!(true) } else { Value::Null },
    );
    registry::update_instance(Path::new(&layout.registry_file), name, &patch)?;
    let detail = if on {
        format!(
            "small copies are removed after {} days",
            js::number_to_string(backup::COPY_DAYS)
        )
    } else {
        "small copies are kept until deleted".to_string()
    };
    record(layout, name, "settings", &detail);
    // on: the old ones the page listed when it asked go now, and no others; each is checked again
    let listed: Vec<String> = match field(body, "remove")? {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|s| s.as_str().map(str::to_string))
            .take(backup::REMOVE_MANY_LIMIT)
            .collect(),
        _ => Vec::new(),
    };
    let (removed, size) = if on && !listed.is_empty() {
        backup::clean_copies(layout, &Panel::actor(), name, Some(&listed))?
    } else {
        (Vec::new(), 0)
    };
    Ok(Reply::ok(
        json!({ "cleanCopies": on, "removed": removed, "size": size }),
    ))
}

/// `POST .../backups/auto`: the switch. One automatic backup per server, edited in place so a
/// failed change does not leave the server with no schedule.
fn auto(layout: &Layout, name: &str, body: &Value) -> Result<Reply, Failure> {
    if !scheduler_available() {
        return Ok(Reply::error(400, preview_limits::SCHEDULER));
    }
    let s = sched(layout);
    let tasks = s.list()?;
    let existing = backup_tasks_of(&tasks, name)?.0.cloned();
    let existing_id = existing.as_ref().map(|t| js::string(t.get("id")));
    if field(body, "enabled")? == Some(&Value::Bool(false)) {
        if let Some(id) = existing_id {
            s.remove(&id)?;
        }
        return Ok(Reply::ok(json!({ "auto": null })));
    }
    let keep = js::number(field(body, "keep")?);
    let keep = if keep.is_finite() && keep.fract() == 0.0 && keep > 0.0 {
        jsjson::num(keep)
    } else {
        Value::Null
    };
    let action = json!({ "type": "backup", "keep": keep });
    let when = match field(body, "schedule")? {
        None | Some(Value::Null) => json!({ "kind": "daily", "at": "03:00" }),
        Some(v) => v.clone(),
    };
    let made = match existing_id {
        Some(id) => {
            let mut patch = Map::new();
            patch.insert("action".into(), action);
            patch.insert("schedule".into(), when);
            patch.insert("enabled".into(), json!(true));
            patch.insert("owner".into(), json!(schedule::OWNER_BACKUPS));
            s.update(&id, &patch)?
        }
        None => s.create(&json!({
            "instance": name,
            "name": "Automatic backup",
            "action": action,
            "schedule": when,
            "owner": schedule::OWNER_BACKUPS,
        }))?,
    };
    Ok(Reply::ok(json!({
        "auto": {
            "id": made.get("id"),
            "schedule": made.get("schedule"),
            "keep": made.get("action").and_then(|a| a.get("keep")),
        }
    })))
}

/// Node's `checkInvalidHeaderChar`: what a header value may hold at all.
fn header_char_ok(c: char) -> bool {
    c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c)
}

fn invalid_char() -> Failure {
    Failure::Internal {
        head: "TypeError [ERR_INVALID_CHAR]".into(),
        message: "Invalid character in header content [\"content-disposition\"]".into(),
        code: Some("ERR_INVALID_CHAR".into()),
    }
}

/// The `content-disposition` value Node sends for `value`, or `None` where it throws. When the
/// same `writeHead` sets a content length that is not 0, Node turns the value into bytes as
/// latin1 (each UTF-16 unit's low byte) and keeps those bytes read back as UTF-8. That is checked
/// when no header was set before; when one was (a probe's proof), `setHeader` has checked the
/// value as it was given instead.
fn disposition_as_node_sends(value: &str, len: u64, set_before: bool) -> Option<String> {
    let all_ok = |v: &str| v.chars().all(header_char_ok);
    if set_before && !all_ok(value) {
        return None;
    }
    let sent = if len > 0 {
        let bytes: Vec<u8> = value.encode_utf16().map(|u| u as u8).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        value.to_string()
    };
    (set_before || all_ok(&sent)).then_some(sent)
}

/// `GET .../backups/download?snapshot=`: the archive as a file, its name in the header as Node
/// puts it there.
fn download(snap: Snapshot) -> Result<Reply, Failure> {
    let value = format!("attachment; filename=\"{}\"", snap.name);
    let headers = |disposition: String| -> Vec<(String, String)> {
        vec![
            ("content-type".into(), "application/gzip".into()),
            ("content-disposition".into(), disposition),
            ("cache-control".into(), "no-store".into()),
        ]
    };
    let file = PathBuf::from(&snap.path);
    let len = snap.size;
    if value.is_ascii() {
        // both of Node's ways agree on ASCII
        let Some(sent) = disposition_as_node_sends(&value, len, false) else {
            return Err(invalid_char());
        };
        return Ok(Reply::File {
            headers: headers(sent),
            file,
            len,
            done: None,
        });
    }
    // past ASCII the answer depends on whether a proof goes with it, and the listener writes a
    // head as UTF-8 where Node writes latin1, so the head is written here
    Ok(Reply::Stream(Box::new(
        move |conn: &mut TcpStream, proof: Option<&str>| {
            let Some(sent) = disposition_as_node_sends(&value, len, proof.is_some()) else {
                return send(conn, failure_reply(&invalid_char()), proof, false);
            };
            let source = match std::fs::File::open(&file) {
                Ok(f) => f,
                Err(e) => {
                    let gone = Reply::error(500, jspath::node_error(&e, "open", Some(&file)));
                    return send(conn, gone, proof, false);
                }
            };
            let mut head = String::from("HTTP/1.1 200 OK\r\n");
            if let Some(p) = proof {
                head.push_str(&format!("{}: {p}\r\n", crate::panel_auth::PROOF_HEADER));
            }
            for (k, v) in headers(sent) {
                head.push_str(&format!("{k}: {v}\r\n"));
            }
            head.push_str(&format!("Content-Length: {len}\r\nConnection: close\r\n\r\n"));
            // Node writes a head as latin1: each UTF-16 unit's low byte
            let bytes: Vec<u8> = head.encode_utf16().map(|u| u as u8).collect();
            conn.write_all(&bytes)?;
            let sent = io::copy(&mut source.take(len), conn)?;
            if sent < len {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            conn.flush()
        },
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, instance: &str, extra: Value) -> Value {
        let mut t = json!({ "id": id, "instance": instance, "name": id, "enabled": true });
        if let (Value::Object(m), Value::Object(e)) = (&mut t, extra) {
            m.extend(e);
        }
        t
    }

    #[test]
    fn the_automatic_backup_is_found_by_its_mark_then_by_its_old_name() {
        let tasks = vec![
            task(
                "a1",
                "a",
                json!({ "action": { "type": "backup" }, "name": "Automatic backup" }),
            ),
            task(
                "a2",
                "a",
                json!({ "action": { "type": "backup" }, "owner": "backups" }),
            ),
            task(
                "a3",
                "a",
                json!({ "action": { "type": "steps", "steps": [{ "do": "stop" }, { "do": "backup" }] } }),
            ),
            task(
                "a4",
                "a",
                json!({ "action": { "type": "backup" }, "enabled": false }),
            ),
            task("a5", "a", json!({ "action": { "type": "restart" } })),
            task(
                "b1",
                "b",
                json!({ "action": { "type": "backup" }, "owner": "backups" }),
            ),
        ];
        let (auto, others) = backup_tasks_of(&tasks, "a").unwrap();
        assert_eq!(auto.unwrap()["id"], "a2");
        let ids: Vec<&Value> = others.iter().map(|t| &t["id"]).collect();
        assert_eq!(ids, [&json!("a1"), &json!("a3")]);

        let unowned = vec![task(
            "x",
            "a",
            json!({ "action": { "type": "backup" }, "name": "Automatic backup" }),
        )];
        let (auto, others) = backup_tasks_of(&unowned, "a").unwrap();
        assert_eq!(auto.unwrap()["id"], "x");
        assert!(others.is_empty());
        // an owned one is not adopted by name, nor a task of another server
        let owned = vec![task(
            "y",
            "a",
            json!({ "action": { "type": "backup" }, "name": "Automatic backup", "owner": "other" }),
        )];
        assert!(backup_tasks_of(&owned, "a").unwrap().0.is_none());
        assert!(backup_tasks_of(&owned, "b").unwrap().1.is_empty());
    }

    #[test]
    fn steps_that_are_not_a_list_throw_as_javascript_does() {
        let odd = vec![task(
            "s",
            "a",
            json!({ "action": { "type": "steps", "steps": "backup" } }),
        )];
        assert!(backup_tasks_of(&odd, "a").is_err());
        let gap = vec![task(
            "s",
            "a",
            json!({ "action": { "type": "steps", "steps": [null] } }),
        )];
        assert!(backup_tasks_of(&gap, "a").is_err());
        let none = vec![task("s", "a", json!({ "action": { "type": "steps" } }))];
        assert!(backup_tasks_of(&none, "a").unwrap().1.is_empty());
    }

    #[test]
    fn exclude_input_becomes_lines_as_javascript_splits_it() {
        assert_eq!(exclude_lines(None), [""]);
        assert_eq!(exclude_lines(Some(&json!("a\r\nb\nc"))), ["a", "b", "c"]);
        assert_eq!(exclude_lines(Some(&json!(["a", 1, null]))), ["a", "1", "null"]);
        assert_eq!(exclude_lines(Some(&json!({}))), ["[object Object]"]);
        assert_eq!(exclude_lines(Some(&json!(5))), ["5"]);
    }

    #[test]
    fn a_download_name_is_sent_as_node_sends_it() {
        // as Node 22 answers each, with and without a header set before
        let d = |v: &str, before| disposition_as_node_sends(v, 5, before);
        assert_eq!(d("a b\tc~", false).as_deref(), Some("a b\tc~"));
        assert_eq!(d("a\nb", false), None);
        assert_eq!(d("a\nb", true), None);
        assert_eq!(d("\u{20ac}", false), None);
        assert_eq!(d("\u{20ac}", true), None);
        // a unit's low byte: U+0142 is 0x42, which setHeader would have refused
        assert_eq!(d("\u{142}", false).as_deref(), Some("B"));
        assert_eq!(d("\u{142}", true), None);
        assert_eq!(d("\u{c3}\u{a9}", false).as_deref(), Some("\u{e9}"));
        assert_eq!(d("\u{c3}\u{a9}", true).as_deref(), Some("\u{e9}"));
        // a lone byte past ASCII is no UTF-8
        assert_eq!(d("caf\u{e9}", false), None);
        assert_eq!(d("caf\u{e9}", true).as_deref(), Some("caf\u{fffd}"));
        // with no length nothing is turned into bytes
        assert_eq!(
            disposition_as_node_sends("caf\u{e9}", 0, false).as_deref(),
            Some("caf\u{e9}")
        );
    }

    #[test]
    fn header_characters_follow_node() {
        assert!("a b\tc~".chars().all(header_char_ok));
        assert!(header_char_ok('é'));
        assert!(!header_char_ok('\n'));
        assert!(!header_char_ok('\u{7f}'));
        assert!(!header_char_ok('€'));
    }
}
