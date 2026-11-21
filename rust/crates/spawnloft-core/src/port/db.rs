//! `db [list|versions|add|create|connect|attach|detach|creds|address|root|remove]`: `cmdDb` and
//! `printCredentials` in mcctl.mjs (C2).

use serde_json::Value;
use std::path::Path;

use spawnloft_lib::engines::Progress;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry;
use spawnloft_lib::services::{self, Address, Engine, External};
use spawnloft_lib::{js, mariadb, text};

use super::Ctx;
use super::args::Flag;
use super::output::Out;

fn flag<'a>(ctx: &'a Ctx<'_>, key: &str) -> Option<&'a Flag> {
    ctx.args.get(key)
}

/// `flags[key] ? String(flags[key]) : null`.
fn text_if_truthy(ctx: &Ctx<'_>, key: &str) -> Option<String> {
    flag(ctx, key).filter(|f| f.truthy()).map(Flag::text)
}

/// `flags[key] != null ? String(flags[key]) : null`.
fn text_if_given(ctx: &Ctx<'_>, key: &str) -> Option<String> {
    flag(ctx, key).map(Flag::text)
}

/// `services.assertNewEngine(String(flags.engine ?? services.defaultEngine()))`.
fn engine_flag(ctx: &Ctx<'_>) -> Result<Engine, Failure> {
    let name = flag(ctx, "engine").map_or_else(|| services::DEFAULT_ENGINE.to_string(), Flag::text);
    services::assert_new_engine(&name)
}

/// The `onProgress` both `add` and `create` print with: a download by tens of percent, every
/// other step as it comes.
fn printer(out: &mut Out) -> impl FnMut(&Progress) + '_ {
    let mut last_percent = -1.0f64;
    move |p: &Progress| {
        if p.total > 0
            && let Some(received) = p.received
        {
            let pct = ((received as f64 / p.total as f64) * 10.0).floor() * 10.0;
            if pct != last_percent {
                last_percent = pct;
                out.line(&format!("  {} {}%", p.message, js::number_to_string(pct)));
            }
        } else if !p.message.is_empty() {
            out.line(&format!("  {}", p.message));
        }
    }
}

fn value_text(v: Option<&Value>) -> String {
    js::string(v)
}

/// `printCredentials(c)`.
fn print_credentials(out: &mut Out, c: &[(String, Value)]) {
    let get = |k: &str| c.iter().find(|(n, _)| n == k).map(|(_, v)| v);
    let mut rows = vec![
        vec!["host:".to_string(), value_text(get("host"))],
        vec!["port:".to_string(), value_text(get("port"))],
    ];
    for (key, label) in [("database", "database:"), ("user", "user:")] {
        if js::truthy(get(key)) {
            rows.push(vec![label.into(), value_text(get(key))]);
        }
    }
    rows.push(vec!["password:".into(), value_text(get("password"))]);
    for (key, label) in [("jdbc", "jdbc:"), ("url", "url:"), ("keyPrefix", "key prefix:")] {
        if js::truthy(get(key)) {
            rows.push(vec![label.into(), value_text(get(key))]);
        }
    }
    out.line(&text::table(&rows));
    if js::truthy(get("note")) {
        out.line(&format!("  {}", value_text(get("note"))));
    }
    out.line("Configure your plugins manually with these values. SpawnLoft does not edit plugin configs.");
}

pub fn db(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let positional = ctx.args.positional.clone();
    let sub = positional.first().map_or("list", String::as_str);
    let at = |i: usize| positional.get(i).filter(|s| !s.is_empty()).cloned();
    let layout = ctx.layout;

    match sub {
        "list" => {
            let dbs = registry::list_services(Path::new(&layout.registry_file))?;
            if dbs.is_empty() {
                ctx.out.line("No databases.");
                ctx.out.line("");
                ctx.out
                    .line("  Add one with: spawnloft db add <name> --version <mysql-version>");
                ctx.out.line("  See versions: spawnloft db versions");
                return Ok(());
            }
            let rows = super::list::database_rows(ctx, &dbs)?;
            ctx.out.line(&text::table(&rows));
            Ok(())
        }
        "versions" => {
            let engine = engine_flag(ctx)?;
            let list = services::versions_for(engine)?;
            if list.is_empty() {
                return Err(Failure::user(format!(
                    "{} publishes no stable releases right now",
                    flag(ctx, "engine").map_or_else(|| services::DEFAULT_ENGINE.to_string(), Flag::text)
                )));
            }
            let mut rows = vec![
                ["VERSION", "STATUS", "SUPPORT", "RELEASED"]
                    .map(String::from)
                    .to_vec(),
            ];
            for v in list.iter().take(20) {
                rows.push(vec![
                    v.version.clone(),
                    v.status.clone(),
                    v.support.clone().unwrap_or_else(|| "-".into()),
                    v.date.clone().unwrap_or_else(|| "-".into()),
                ]);
            }
            ctx.out.line(&text::table(&rows));
            if list.len() > 20 {
                ctx.out.line(&format!("  ...and {} older.", list.len() - 20));
            }
            Ok(())
        }
        "add" => {
            let Some(name) = at(1) else {
                return Err(Failure::user(
                    "usage: spawnloft db add <name> --version <version> [--port <n>] [--label \"...\"]",
                ));
            };
            let engine = engine_flag(ctx)?;
            let version = match text_if_truthy(ctx, "version") {
                Some(v) => v,
                None => {
                    let Some(newest) = services::versions_for(engine)?.into_iter().next() else {
                        return Err(Failure::user(format!(
                            "{} publishes no stable release to pick from - name one with --version",
                            flag(ctx, "engine")
                                .map_or_else(|| services::DEFAULT_ENGINE.to_string(), Flag::text)
                        )));
                    };
                    ctx.out.line(&format!(
                        "Using {} {}, the newest stable release.",
                        engine.label(),
                        newest.version
                    ));
                    newest.version
                }
            };
            let port = flag(ctx, "port").filter(|f| f.truthy()).map(Flag::number);
            let label = flag(ctx, "label").map(Flag::text);
            let db = {
                let mut progress = printer(ctx.out);
                services::create_database(
                    layout,
                    &name,
                    engine,
                    &version,
                    port,
                    label.as_deref(),
                    &mut progress,
                )?
            };
            ctx.out.line("");
            ctx.out.line(&format!(
                "Created database \"{}\" ({} {}) on 127.0.0.1:{}",
                db.name,
                services::label_of(db.get("engine")),
                js::string(db.get("version")),
                js::string(db.get("port"))
            ));
            ctx.out
                .line(&format!("Start it with: spawnloft start {}", db.name));
            ctx.out.line(&format!(
                "Then attach a server: spawnloft db attach {} <server>",
                db.name
            ));
            Ok(())
        }
        "create" => {
            let Some(server) = at(1) else {
                return Err(Failure::user(
                    "usage: spawnloft db create <server> [--version <version>] [--engine mysql|garnet]",
                ));
            };
            let engine = engine_flag(ctx)?;
            let version = text_if_truthy(ctx, "version");
            let (db, credentials) = {
                let mut progress = printer(ctx.out);
                services::create_for_server(
                    layout,
                    &super::lifecycle::cli(),
                    &server,
                    engine,
                    version.as_deref(),
                    &mut progress,
                )?
            };
            ctx.out.line("");
            ctx.out.line(&format!(
                "Created database \"{}\" ({} {}) on 127.0.0.1:{}, running, attached to \"{server}\".",
                db.name,
                services::label_of(db.get("engine")),
                js::string(db.get("version")),
                js::string(db.get("port"))
            ));
            ctx.out.line("");
            print_credentials(ctx.out, &credentials);
            Ok(())
        }
        "attach" | "detach" => {
            let (Some(db_name), Some(server)) = (at(1), at(2)) else {
                return Err(Failure::user(format!(
                    "usage: spawnloft db {sub} <database> <server>{}",
                    if sub == "detach" { " [--drop]" } else { "" }
                )));
            };
            if sub == "attach" {
                let creds = services::attach(layout, &db_name, &server)?;
                ctx.out
                    .line(&format!("\"{server}\" is attached to \"{db_name}\"."));
                ctx.out.line("");
                print_credentials(ctx.out, &creds);
                return Ok(());
            }
            let drop = flag(ctx, "drop").is_some_and(Flag::truthy);
            let res = services::detach(layout, &db_name, &server, drop)?;
            let database = js::string(Some(&res.database));
            ctx.out.line(&format!(
                "\"{server}\" is detached from \"{db_name}\"; database {database} {}.",
                if res.dropped { "dropped" } else { "kept" }
            ));
            Ok(())
        }
        "creds" | "credentials" => {
            let (Some(db_name), Some(server)) = (at(1), at(2)) else {
                return Err(Failure::user("usage: spawnloft db creds <database> <server>"));
            };
            let creds = services::credentials(layout, &db_name, &server)?;
            print_credentials(ctx.out, &creds);
            Ok(())
        }
        "connect" => {
            let Some(name) = at(1) else {
                return Err(Failure::user(
                    "usage: spawnloft db connect <name> --engine mysql|garnet --host <host> --port <n> --user <u> --password <p> [--tools <folder>]",
                ));
            };
            let engine = engine_flag(ctx)?;
            let host = text_if_truthy(ctx, "host").unwrap_or_else(|| "127.0.0.1".into());
            let user = text_if_truthy(ctx, "user").unwrap_or_else(|| "root".into());
            let password = text_if_given(ctx, "password").unwrap_or_default();
            let tools = text_if_truthy(ctx, "tools");
            let label = flag(ctx, "label").map(Flag::text);
            let db = services::register_external(
                layout,
                &name,
                engine,
                External {
                    host: &host,
                    port: flag(ctx, "port").filter(|f| f.truthy()).map(Flag::number),
                    user: &user,
                    password: &password,
                    tools: tools.as_deref(),
                    label: label.as_deref(),
                },
            )?;
            ctx.out.line(&format!(
                "Registered \"{}\": {} at {}:{}, answering.",
                db.name,
                engine.label(),
                js::string(db.get("host")),
                js::string(db.get("port"))
            ));
            ctx.out.line(&format!(
                "Attach a server: spawnloft db attach {} <server>",
                db.name
            ));
            Ok(())
        }
        "address" => {
            let given = ["host", "port", "user", "password"]
                .iter()
                .any(|k| flag(ctx, k).is_some());
            let db_name = match at(1) {
                Some(n) if given => n,
                _ => {
                    return Err(Failure::user(
                        "usage: spawnloft db address <database> [--host h] [--port n] [--user u] [--password p]",
                    ));
                }
            };
            let (db, reachable) = services::update_external(
                layout,
                &db_name,
                Address {
                    host: text_if_given(ctx, "host"),
                    port: flag(ctx, "port").map(Flag::number),
                    user: text_if_given(ctx, "user"),
                    password: text_if_given(ctx, "password"),
                },
            )?;
            ctx.out.line(&format!(
                "\"{}\" now points at {}:{}{}",
                db.name,
                js::string(db.get("host")),
                js::string(db.get("port")),
                if reachable {
                    ", answering."
                } else {
                    " - nothing answers there yet."
                }
            ));
            Ok(())
        }
        "root" => {
            let Some(db_name) = at(1) else {
                return Err(Failure::user("usage: spawnloft db root <database>"));
            };
            let db = services::get_database(layout, &db_name)?;
            let host = match db.get("host") {
                None | Some(Value::Null) => "127.0.0.1".to_string(),
                v => js::string(v),
            };
            let user =
                mariadb::root_field(&db, "user").map_or_else(|| "root".into(), |u| js::string(Some(&u)));
            let password =
                mariadb::root_field(&db, "password").map_or_else(String::new, |p| js::string(Some(&p)));
            let rows = vec![
                vec!["host:".to_string(), host],
                vec!["port:".to_string(), js::string(db.get("port"))],
                vec!["user:".to_string(), user],
                vec!["password:".to_string(), password],
            ];
            ctx.out.line(&text::table(&rows));
            Ok(())
        }
        "remove" | "rm" => {
            let Some(db_name) = at(1) else {
                return Err(Failure::user("usage: spawnloft db remove <database> [--purge]"));
            };
            let purge = flag(ctx, "purge").is_some_and(Flag::truthy);
            let res = services::remove_database(layout, &db_name, purge)?;
            ctx.out.line(&format!(
                "Removed database \"{db_name}\"{}.",
                if res.purged {
                    " and its files"
                } else {
                    " (files kept)"
                }
            ));
            if !res.detached.is_empty() {
                ctx.out.line(&format!(
                    "Servers that were attached: {} - update any plugin configs you configured manually.",
                    res.detached.join(", ")
                ));
            }
            Ok(())
        }
        _ => Err(Failure::user(
            "usage: spawnloft db [list|versions|add|create|connect|attach|detach|creds|root|remove]",
        )),
    }
}
