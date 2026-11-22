//! The panel's routes that only read the machine or the settings (rust/PLAN-CORE-PORT.md C8,
//! group a): the three pages, `health`, `settings`, `appearance`, `setup`, `java`, `jars`,
//! `software`, `feedback`, `diagnostics` and `mcp`. Each is the same branch of `route()` in
//! `ui.mjs`, in the same words.

use serde_json::{Map, Value, json};
use std::path::Path;

use crate::failure::Failure;
use crate::settings::Layout;
use crate::{
    appearance, build, create, data_format, diagnose, first_run, java, js, jspath, platform, registry,
    services, settings, software, sources, supervisor, time,
};

use super::Panel;
use super::http::{Reply, Request, field, has_own, opt_field};
use super::pages;

/// `/`.
pub fn page_ui() -> Reply {
    Reply::html(
        200,
        &[],
        pages::ui(
            appearance::read_theme(),
            platform::node_platform(),
            services::can_manage("mysql"),
        ),
    )
}

/// `/launcher`. Launch, sign out and remove are one click each, so no other site may put the
/// page in a frame and steer those clicks; a meta CSP cannot say frame-ancestors, a header can.
/// The panel itself frames it, as its Play page, from this same origin.
pub fn page_launcher() -> Reply {
    Reply::html(
        200,
        &[
            ("X-Frame-Options", "SAMEORIGIN"),
            ("Content-Security-Policy", "frame-ancestors 'self'"),
        ],
        pages::launcher(appearance::read_theme()),
    )
}

/// `/setup`: only behind the desktop window. A panel in a browser moves its data with
/// `spawnloft config set-root`, never over HTTP.
pub fn page_setup(panel: &Panel) -> Reply {
    if !panel.shell {
        return Reply::not_found();
    }
    Reply::html(
        200,
        &[
            ("X-Frame-Options", "DENY"),
            ("Content-Security-Policy", "frame-ancestors 'none'"),
        ],
        pages::setup(appearance::read_theme()),
    )
}

/// `/api/setup...`: the first-run wizard's calls.
pub fn setup(panel: &Panel, req: &mut Request) -> Result<Reply, Failure> {
    let n = req.seg.len();
    if n == 2 && req.method == "GET" {
        return Ok(Reply::ok(first_run::get_setup()?));
    }
    if n == 2 && req.method == "POST" {
        if !panel.shell {
            return Ok(Reply::error(
                403,
                "only the SpawnLoft window can change where SpawnLoft keeps its files; use spawnloft config set-root",
            ));
        }
        let body = req.json()?;
        return Ok(Reply::ok(first_run::save_setup(&body)));
    }
    if n == 3 && req.seg(2) == Some("java") && req.method == "GET" {
        return Ok(Reply::ok(first_run::check_java()));
    }
    Ok(Reply::method_not_allowed())
}

/// `/api/appearance`: separate from `/settings` so a palette change cannot touch data locations.
pub fn appearance(req: &mut Request) -> Result<Reply, Failure> {
    if req.method == "GET" {
        return Ok(Reply::ok(json!({ "theme": appearance::read_theme() })));
    }
    if req.method != "POST" {
        return Ok(Reply::method_not_allowed());
    }
    let body = req.json()?;
    let theme = appearance::save_theme(opt_field(&body, "theme"))?;
    Ok(Reply::ok(json!({ "theme": theme })))
}

/// `GET /api/jars`.
pub fn jars(layout: &Layout) -> Result<Reply, Failure> {
    let rows: Vec<Value> = create::list_jars(&layout.jars_dir)?
        .iter()
        .map(|j| json!({ "name": j.name, "size": j.size_human() }))
        .collect();
    Ok(Reply::ok(Value::Array(rows)))
}

/// `GET /api/mcp`: real executable paths for an MCP client's config. A `.cmd` launcher cannot be
/// started by a client that spawns without a shell on Windows, so this names the entry point.
pub fn mcp() -> Reply {
    let cli = crate::entry::cli_command(std::env::var(crate::entry::ENTRY_ENV).ok().as_deref());
    let env: Map<String, Value> = cli.env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    Reply::ok(json!({ "command": cli.exe, "args": ["mcp"], "env": env }))
}

fn data_format_warning(layout: &Layout) -> Option<String> {
    let file = data_format::data_format_file(&layout.data_root);
    let marker = data_format::read(Path::new(&file));
    data_format::warning(&file, marker.as_ref(), Some(data_format::release_version()))
}

/// `GET /api/health`.
pub fn health(layout: &Layout) -> Reply {
    Reply::ok(json!({
        "java": Value::Object(java::health().to_json()),
        "javaDownload": java::download_url_for(),
        "dataFormat": data_format_warning(layout),
    }))
}

/// `GET /api/java/needs?versions=a,b`: what each Minecraft version needs, and what is here.
pub fn java_needs(req: &Request) -> Reply {
    let asked = req.q("versions").unwrap_or("");
    let best = java::discover().best;
    let mut needs = Map::new();
    for v in asked.split(',').filter(|v| !v.is_empty()).take(500) {
        needs.insert(v.to_string(), json!(java::required_major(Some(v))));
    }
    let mut ordered = Value::Object(needs);
    // an object's keys that read as whole numbers come first, in number order
    crate::jsjson::js_order(&mut ordered);
    Reply::ok(json!({
        "needs": ordered,
        "have": best.and_then(|b| b.probe.major),
        "download": java::DOWNLOAD_URL,
    }))
}

/// `GET /api/java`: every Java found.
pub fn java_list() -> Reply {
    let found = java::discover();
    let on_path = if found.on_path.found {
        json!({ "major": found.on_path.major, "version": found.on_path.version })
    } else {
        Value::Null
    };
    let rows: Vec<Value> = found
        .all
        .iter()
        .map(|f| {
            json!({
                "path": f.path,
                "source": f.source,
                "major": f.probe.major,
                "version": f.probe.version,
                "reason": f.probe.reason,
            })
        })
        .collect();
    Reply::ok(json!({
        "best": found.best.map(|b| b.path),
        "onPath": on_path,
        "found": rows,
        "download": java::download_url_for(),
    }))
}

/// The project's page, from the workspace's `repository` (package.json's in the Node core), so a
/// fork changes it in one place.
pub fn project_url() -> Option<String> {
    project_url_from(env!("CARGO_PKG_REPOSITORY"))
}

fn project_url_from(repo: &str) -> Option<String> {
    let part = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
    let slug = match repo.strip_prefix("github:") {
        Some(rest) => rest,
        None => match repo.find("github.com/") {
            Some(at) => repo[at + "github.com/".len()..].trim_end_matches('/'),
            None => repo,
        },
    };
    let slug = slug.strip_suffix(".git").unwrap_or(slug);
    let (owner, name) = slug.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && owner.chars().all(part) && name.chars().all(part))
        .then(|| format!("https://github.com/{owner}/{name}"))
}

/// The panel process's own log, last `count` lines.
fn panel_log_tail(layout: &Layout, count: usize) -> Vec<String> {
    let file = jspath::join_path(&layout.run_dir, &["panel.log"]);
    let Ok(bytes) = std::fs::read(&file) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..]
        .iter()
        .map(|l| (*l).to_string())
        .collect()
}

/// `x ?? fallback`, as text.
fn or_text(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.to_string(),
        v => js::string(v),
    }
}

/// `diagnostics(instanceName, { short })`: the plain-text bug report bundle. It gets pasted
/// publicly, so no RCON password and no webhook URL.
pub fn diagnostics_text(layout: &Layout, instance: Option<&str>, short: bool) -> Result<String, Failure> {
    let mut lines: Vec<String> = Vec::new();
    lines.push("== SpawnLoft diagnostics ==".into());
    lines.push(format!("SpawnLoft: {}", build::current().version));
    // where the Node core named its Node, this core names itself
    lines.push(format!("core: {}", build::current().line()));
    lines.push(format!(
        "os: {} {} {}, {} cores, {} GB",
        platform::node_platform(),
        platform::os_release(),
        platform::node_arch(),
        platform::cpu_count(),
        (platform::total_memory() as f64 / 1_073_741_824.0).round()
    ));
    lines.push(format!("generated: {}", time::iso_now()));
    let jv = java::health();
    let java_line = match (&jv.path, jv.found) {
        (Some(path), true) if !path.is_empty() => format!(
            "{} ({}){}",
            jv.version.as_deref().unwrap_or("null"),
            jv.base.reason,
            if jv.on_path {
                String::new()
            } else {
                format!(" at {path}, not on PATH")
            }
        ),
        _ => jv.message.clone(),
    };
    lines.push(format!("java: {java_line}"));
    for other in &jv.others {
        if Some(&other.path) != jv.path.as_ref() {
            lines.push(format!(
                "java (also): {} at {}",
                other.probe.version.as_deref().unwrap_or("null"),
                other.path
            ));
        }
    }
    lines.push(String::new());
    lines.push("== where things live ==".into());
    for (k, v) in [
        ("dataRoot", &layout.data_root),
        ("instancesDir", &layout.instances_dir),
        ("jarsDir", &layout.jars_dir),
        ("backupsDir", &layout.backups_dir),
        ("runDir", &layout.run_dir),
    ] {
        lines.push(format!("{k}: {v}"));
    }
    lines.push(String::new());
    lines.push("== servers ==".into());
    let registry_file = Path::new(&layout.registry_file);
    let all = registry::list_instances(registry_file)?;
    if all.is_empty() {
        lines.push("(none)".into());
    }
    for inst in all {
        let key = inst.name.clone();
        let row = match supervisor::status_of(layout, &key) {
            Ok((row, _)) => row,
            Err(err) => {
                let mut row = inst;
                row.fields
                    .insert("status".into(), json!(format!("unknown ({})", err.message())));
                row
            }
        };
        let get = |k: &str| row.get(k);
        let truthy = |k: &str| js::truthy(row.get(k));
        lines.push(format!(
            "- {}: {}, {}{}, {}, port {}, jar {}{}{}{}",
            js::string(get("name")),
            js::string(get("status")),
            or_text(get("loader"), "paper"),
            if truthy("mcVersion") {
                format!(" {}", js::string(get("mcVersion")))
            } else {
                String::new()
            },
            js::string(get("memory")),
            js::string(get("port")),
            js::string(get("jar")),
            if truthy("javaPid") {
                format!(", java pid {}", js::string(get("javaPid")))
            } else {
                String::new()
            },
            if truthy("autoRestart") {
                ", auto-restart"
            } else {
                ""
            },
            if truthy("lastError") {
                format!(", last error: {}", js::string(get("lastError")))
            } else {
                String::new()
            },
        ));
    }
    let count = if short { 5 } else { 20 };
    let tail = panel_log_tail(layout, count);
    lines.push(String::new());
    lines.push(format!("== panel log (last {count}) =="));
    if tail.is_empty() {
        lines.push("(empty)".into());
    } else {
        lines.extend(tail);
    }
    if let Some(name) = instance.filter(|n| !n.is_empty())
        && services::has_instance(layout, name)?
    {
        let inst = registry::lookup(registry_file, name)?;
        let log = layout.console_log(name);
        let recent = supervisor::tail_log(Path::new(&log), 60.0)?;
        let findings = diagnose::diagnose(
            &supervisor::tail_log(Path::new(&log), 400.0)?,
            &diagnose::Context::of(&inst),
        );
        lines.push(String::new());
        lines.push(format!("== {name}: diagnosis =="));
        if findings.is_empty() {
            lines.push("(nothing recognised)".into());
        } else {
            lines.extend(findings.iter().map(|f| format!("- {}: {}", f.title, f.advice)));
        }
        // the console tail does not fit in a URL, so the short form leaves it to the clipboard
        if !short {
            lines.push(String::new());
            lines.push(format!("== {name}: console (last 60) =="));
            if recent.is_empty() {
                lines.push("(empty)".into());
            } else {
                lines.extend(recent);
            }
        }
    }
    Ok(lines.join("\n") + "\n")
}

/// `GET /api/diagnostics`.
pub fn diagnostics(layout: &Layout, req: &Request) -> Result<Reply, Failure> {
    let text = diagnostics_text(layout, req.q("instance"), false)?;
    Ok(Reply::Bytes {
        status: 200,
        headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
        body: text.into_bytes(),
    })
}

/// `String.prototype.slice(0, n)`: the first `n` UTF-16 units.
fn slice16(text: &str, n: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `new URLSearchParams(pairs).toString()`.
fn form(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// `GET /api/feedback`: URLs for the Feedback sheet. The bug link prefills GitHub's new-issue
/// form with the short diagnostics (URLs are capped); the full bundle goes to the clipboard.
/// Nothing is sent from here.
pub fn feedback(layout: &Layout, req: &Request) -> Result<Reply, Failure> {
    let instance = req.q("instance");
    let title = slice16(req.q("title").unwrap_or(""), 120);
    let Some(home) = project_url() else {
        return Ok(Reply::ok(
            json!({ "bug": null, "ideas": null, "question": null, "full": "" }),
        ));
    };
    let short = diagnostics_text(layout, instance, true)?;
    let full = diagnostics_text(layout, instance, false)?;
    let body = [
        "**What happened**",
        "",
        "<!-- What you did, what you expected, what you got instead. -->",
        "",
        "**Diagnostics**",
        "",
        "```",
        js::trim_end(&short),
        "```",
        "",
        "<!-- The full diagnostics, console lines included, are on your clipboard: paste them here. -->",
        "",
    ]
    .join("\n");
    let link = |body: &str| {
        format!(
            "{home}/issues/new?{}",
            form(&[
                ("template", "bug_report.md"),
                ("labels", "bug"),
                ("title", &title),
                ("body", body),
            ])
        )
    };
    let mut bug = link(&body);
    if bug.encode_utf16().count() > 7500 {
        let keep = 7500usize
            .saturating_sub(format!("{home}/issues/new?").encode_utf16().count())
            .saturating_sub(400);
        let trimmed = format!(
            "{}\n```\n\n(trimmed - paste the full diagnostics from your clipboard)\n",
            slice16(&body, keep)
        );
        bug = link(&trimmed);
    }
    Ok(Reply::ok(json!({
        "bug": bug,
        "ideas": format!("{home}/discussions/new?category=ideas"),
        "question": format!("{home}/discussions/new?category=q-a"),
        "full": full,
    })))
}

/// `String(x ?? '').trim()`.
fn trimmed(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        v => js::trim(&js::string(v)).to_string(),
    }
}

/// `POST /api/settings`. The data root stays read-only here: it is resolved at start, so
/// changing it live would split creation and lookup across folders. `backupsDir` can be set but
/// applies on restart; the mirror is read live.
pub fn settings_post(layout: &Layout, req: &mut Request) -> Result<Reply, Failure> {
    let body = req.json()?;
    let cannot_write =
        |dir: &str, error: &str| Reply::error(400, format!("SpawnLoft cannot write to {dir}: {error}"));
    if has_own(&body, "backupsMirrorDir")? {
        let raw = trimmed(field(&body, "backupsMirrorDir")?);
        if raw.is_empty() {
            settings::save(&[("backupsMirrorDir", Value::Null)], false)?;
            return Ok(Reply::ok(json!({ "backupsMirrorDir": null })));
        }
        let dir = jspath::resolve(&raw);
        if let Err(error) = settings::check_writable(&dir) {
            return Ok(cannot_write(&dir, &error));
        }
        settings::save(&[("backupsMirrorDir", json!(dir))], false)?;
        return Ok(Reply::ok(json!({ "backupsMirrorDir": dir })));
    }
    if !has_own(&body, "backupsDir")? {
        return Ok(Reply::error(
            400,
            "only backupsDir and backupsMirrorDir can be set from here",
        ));
    }
    let raw = trimmed(field(&body, "backupsDir")?);
    let default_dir = jspath::join(&[&layout.data_root, "backups"]);
    if raw.is_empty() {
        settings::save(&[("backupsDir", Value::Null)], false)?;
        return Ok(Reply::ok(json!({
            "backupsDir": default_dir,
            "restartRequired": default_dir != layout.backups_dir,
        })));
    }
    let dir = jspath::resolve(&raw);
    if let Err(error) = settings::check_writable(&dir) {
        return Ok(cannot_write(&dir, &error));
    }
    // the default folder is saved as "no choice", so backups keep following the data folder
    let saved = if dir == default_dir {
        Value::Null
    } else {
        json!(dir)
    };
    settings::save(&[("backupsDir", saved)], false)?;
    Ok(Reply::ok(json!({
        "backupsDir": dir,
        "restartRequired": dir != layout.backups_dir,
    })))
}

/// `GET /api/settings`.
pub fn settings_get(layout: &Layout) -> Reply {
    Reply::ok(json!({
        "theme": appearance::read_theme(),
        "dataRoot": layout.data_root,
        "instancesDir": layout.instances_dir,
        "separateInstances": layout.separate_instances,
        "jarsDir": layout.jars_dir,
        "backupsDir": layout.backups_dir,
        "templatesDir": layout.templates_dir,
        "runDir": layout.run_dir,
        "settingsFile": layout.settings_file,
        "usingLegacyLayout": false,
        "platform": platform::node_platform(),
        "capabilities": platform::capabilities(),
    }))
}

/// `GET /api/software`: the page builds its Software list from this.
pub fn software_list() -> Reply {
    let rows: Vec<Value> = software::SOFTWARE
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "label": s.label,
                "content": s.content,
                "blurb": s.blurb(),
                "slow": s.slow(),
            })
        })
        .collect();
    Reply::ok(Value::Array(rows))
}

/// `GET /api/<software>/versions`.
pub fn software_versions(id: &str) -> Result<Reply, Failure> {
    Ok(Reply::ok(json!(sources::versions_for(id)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_page_comes_from_the_repository_field() {
        assert_eq!(
            project_url().as_deref(),
            Some("https://github.com/joogiebear/spawnloft")
        );
        for (repo, want) in [
            ("github:a/b", Some("https://github.com/a/b")),
            ("a/b.git", Some("https://github.com/a/b")),
            ("https://github.com/a/b.git", Some("https://github.com/a/b")),
            (
                "git+https://github.com/a-1/b_2.x/",
                Some("https://github.com/a-1/b_2.x"),
            ),
            ("https://example.com/a/b/c", None),
            ("", None),
            ("github:a/b/c", None),
        ] {
            assert_eq!(project_url_from(repo).as_deref(), want, "{repo}");
        }
    }

    #[test]
    fn query_strings_are_built_as_urlsearchparams_builds_them() {
        assert_eq!(
            form(&[("title", "a b&c"), ("body", "**x**\n```\n<!-- y -->")]),
            "title=a+b%26c&body=**x**%0A%60%60%60%0A%3C%21--+y+--%3E"
        );
        assert_eq!(slice16("a\u{1F600}b", 2), "a\u{fffd}");
    }
}
