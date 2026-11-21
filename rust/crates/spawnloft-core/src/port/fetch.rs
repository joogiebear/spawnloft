//! Fetching server software (C4 part 2): `paper`, `upgrade`, and `new` with a software flag
//! (`--paper`, `--fabric`, `--spigot` ... and `--neoforge`), as `cmdPaper`, `cmdUpgrade` and
//! `cmdNew` in mcctl.mjs answer them, over spawnloft-lib's `sources` and `upgrade`.

use serde_json::Value;

use spawnloft_lib::create::NewOptions;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::upgrade::{self, Applied};
use spawnloft_lib::{create, java, js, registry, sources, supervisor, text};

use super::args::Flag;
use super::create::{flag_value, print_created};
use super::lifecycle::cli;
use super::{Ctx, require_name};

/// `Array.prototype.slice(0, end)`'s end for a list of `len`: NaN is 0, a negative counts from
/// the end, and the end is clamped.
fn slice_end(len: usize, end: f64) -> usize {
    if end.is_nan() {
        return 0;
    }
    let end = end.trunc();
    if end < 0.0 {
        (len as f64 + end).max(0.0) as usize
    } else {
        end.min(len as f64) as usize
    }
}

/// `Number(flags.x ?? fallback)`.
fn number_or(ctx: &Ctx<'_>, key: &str, fallback: f64) -> f64 {
    ctx.args.get(key).map_or(fallback, Flag::number)
}

fn truthy(ctx: &Ctx<'_>, key: &str) -> bool {
    ctx.args.get(key).is_some_and(Flag::truthy)
}

/// A build named on the command line: `null` is none, anything else is matched as its text.
fn wanted(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        v => Some(js::string(Some(v))),
    }
}

pub fn paper(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let pos = ctx.args.positional.clone();
    let sub = pos.first().map_or("versions", String::as_str);
    match sub {
        "versions" => {
            let unstable = truthy(ctx, "unstable");
            let all = sources::paper_versions("paper", unstable)?;
            let limit = number_or(ctx, "limit", 25.0);
            ctx.out.line(&format!(
                "Paper versions (newest first){}:",
                if unstable { ", including pre-releases" } else { "" }
            ));
            ctx.out
                .line(&format!("  {}", all[..slice_end(all.len(), limit)].join("  ")));
            let len = all.len() as f64;
            if len > limit {
                ctx.out.line(&format!(
                    "  ... {} older (use --limit {})",
                    js::number_to_string(len - limit),
                    all.len()
                ));
            }
            Ok(())
        }
        "builds" => {
            let Some(version) = pos.get(1).filter(|v| !v.is_empty()) else {
                return Err(Failure::user("usage: spawnloft paper builds <version>"));
            };
            let all = sources::paper_builds("paper", version)?;
            let limit = number_or(ctx, "limit", 15.0);
            let mut rows = vec![["BUILD", "CHANNEL", "DATE", "FILE"].map(String::from).to_vec()];
            for b in &all[..slice_end(all.len(), limit)] {
                let time = js::string(Some(&b.time));
                let name = match &b.name {
                    Value::Null => "-".to_string(),
                    v => js::string(Some(v)),
                };
                rows.push(vec![
                    js::string(Some(&b.build)),
                    js::string(Some(&b.channel)),
                    utf16_prefix(&time, 10),
                    name,
                ]);
            }
            ctx.out.line(&text::table(&rows));
            Ok(())
        }
        "fetch" => {
            let Some(version) = pos.get(1).filter(|v| !v.is_empty()) else {
                return Err(Failure::user(
                    "usage: spawnloft paper fetch <version> [build] [--force]",
                ));
            };
            let res = sources::paper_fetch(
                &ctx.layout.jars_dir,
                "paper",
                version,
                pos.get(2).map(String::as_str),
                truthy(ctx, "force"),
            )?;
            let build = js::string(Some(&res.build));
            let channel = js::string(Some(&res.channel));
            if res.cached {
                ctx.out.line(&format!(
                    "Already stored: {} (build {build}, {channel}). Re-download with --force.",
                    res.name
                ));
            } else {
                ctx.out.line(&format!(
                    "Downloaded {} — build {build}, {channel}, {}, checksum verified.",
                    res.name,
                    res.size_human.as_deref().unwrap_or("undefined")
                ));
            }
            ctx.out
                .line(&format!("Use it with: spawnloft new <name> --jar {}", res.name));
            Ok(())
        }
        _ => Err(Failure::user(
            "usage: spawnloft paper [versions|builds <version>|fetch <version> [build]]",
        )),
    }
}

/// `text.slice(0, n)`, counted in UTF-16 units as JavaScript does.
fn utf16_prefix(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<_>>())
}

pub fn upgrade(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = require_name(&ctx.args.positional, "upgrade")?.to_string();
    let inst = registry::lookup(std::path::Path::new(&ctx.layout.registry_file), &name)?;
    let running = supervisor::is_running(ctx.layout, &name)?;

    if truthy(ctx, "check") {
        let info = upgrade::check_upgrade(&inst)?;
        let (Some(current), Some(latest)) = (&info.current, &info.latest_build) else {
            ctx.out.line(&format!(
                "{} is not a jar SpawnLoft can update: it updates the Paper, Purpur, Folia and Advanced Slime Paper jars it downloaded itself.",
                js::string(inst.get("jar"))
            ));
            return Ok(());
        };
        ctx.out.line(&format!(
            "{name} runs {} {} build {}.",
            current.label,
            current.version,
            js::string(Some(&current.build))
        ));
        let channel = &latest.channel;
        if latest.newer {
            let words = if js::truthy(Some(channel)) {
                format!(" ({})", js::string(Some(channel)).to_lowercase())
            } else {
                String::new()
            };
            ctx.out.line(&format!(
                "Build {} is available{words}. Apply with: spawnloft upgrade {name}",
                js::string(Some(&latest.build))
            ));
        } else {
            let stable = if channel.as_str() == Some("STABLE") {
                "stable "
            } else {
                ""
            };
            ctx.out.line(&format!(
                "That is the newest {stable}build for {}.",
                current.version
            ));
        }
        if let Some(v) = info.newer_versions.first() {
            ctx.out.line(&format!(
                "Minecraft {v} is out. Cross with: spawnloft upgrade {name} --version {v} --yes"
            ));
        }
        return Ok(());
    }

    let version = ctx.args.get("version").filter(|f| f.truthy()).map(Flag::text);
    let current = upgrade::parse_server_jar(inst.get("jar"));
    if let (Some(v), Some(c)) = (&version, &current)
        && *v != c.version
        && !truthy(ctx, "yes")
    {
        return Err(Failure::user(format!(
            "upgrading \"{name}\" from {} to {v} migrates its worlds, and worlds do not migrate back.\n  A snapshot is taken first, but read your plugins' release notes too. Re-run with --yes.",
            c.version
        )));
    }

    let build = flag_value(ctx, "build");
    match upgrade::apply_upgrade(ctx.layout, &cli(), &name, version.as_deref(), &build, running)? {
        Applied::AlreadyCurrent { jar } => {
            ctx.out
                .line(&format!("{name} already runs {jar} - nothing to do."));
        }
        Applied::Done {
            from,
            to,
            channel,
            snapshot,
            old_jars,
        } => {
            if let Some(s) = snapshot {
                ctx.out.line(&format!("Snapshot: {s}"));
            }
            let tag = if js::truthy(Some(&channel)) && channel.as_str() != Some("STABLE") {
                format!(" ({})", js::string(Some(&channel)))
            } else {
                String::new()
            };
            ctx.out
                .line(&format!("{name}: {} -> {to}{tag}", js::string(Some(&from))));
            if !old_jars.is_empty() {
                ctx.out
                    .line("  Old jar kept in the instance folder - the way back if this build misbehaves.");
            }
            ctx.out.line(if running {
                "  The server is running; the new jar loads at its next restart."
            } else {
                "  Takes effect at the next start."
            });
        }
    }
    Ok(())
}

fn label_of(id: &str) -> &'static str {
    match id {
        "paper" => "Paper",
        "purpur" => "Purpur",
        "folia" => "Folia",
        "asp" => "Advanced Slime Paper",
        "spigot" => "Spigot",
        "craftbukkit" => "CraftBukkit",
        "vanilla" => "Vanilla",
        "fabric" => "Fabric",
        _ => "NeoForge",
    }
}

/// `java.pickJava({ explicit: flags.java ?? null, needs: requiredMajor(version), force, what })`.
fn pick_java(ctx: &Ctx<'_>, version: &str) -> Result<String, Failure> {
    let explicit = match ctx.args.get("java") {
        // `--java` alone is `true`, which execFile refuses before running anything
        Some(Flag::Bool(true)) => {
            return Err(Failure::Internal {
                head: "TypeError [ERR_INVALID_ARG_TYPE]".into(),
                message: "The \"file\" argument must be of type string. Received type boolean (true)".into(),
                code: Some("ERR_INVALID_ARG_TYPE".into()),
            });
        }
        Some(Flag::Text(s)) if !s.is_empty() => Some(s.as_str()),
        _ => None,
    };
    java::pick_java(
        explicit,
        java::required_major(Some(version)),
        truthy(ctx, "force"),
        &format!("Minecraft {version}"),
    )
}

/// `new` with a software flag: the jar fetched (or built) into the store first, so a failed
/// fetch leaves no half-made server; `--neoforge` has its installer lay the server down.
/// Answers `false` when no software flag is set and the plain `new` should go on.
pub fn new_with_software(ctx: &mut Ctx<'_>, name: &str) -> Result<bool, Failure> {
    let chosen: Vec<&str> = sources::JAR_IDS
        .iter()
        .copied()
        .filter(|id| truthy(ctx, id))
        .collect();
    let neoforge = truthy(ctx, "neoforge");
    if chosen.len() > 1 || (!chosen.is_empty() && neoforge) {
        let mut ids: Vec<String> = chosen.iter().map(|id| format!("--{id}")).collect();
        if neoforge {
            ids.push("--neoforge".into());
        }
        return Err(Failure::user(format!("pick one of {}", ids.join(", "))));
    }
    if let Some(id) = chosen.first().copied() {
        let version = ctx.args.get(id).map(Flag::text).unwrap_or_default();
        if id == "spigot" || id == "craftbukkit" {
            ctx.out.line(&format!(
                "{} is compiled here by BuildTools - this takes several minutes the first time.",
                label_of(id)
            ));
        }
        let java = pick_java(ctx, &version)?;
        let build = wanted(&flag_value(ctx, "build"));
        let jars = ctx.layout.jars_dir.clone();
        let mut last = String::new();
        let out = &mut *ctx.out;
        let mut progress = |m: &str| {
            if !m.is_empty() && m != last {
                last = m.to_string();
                out.line(&format!("  {m}"));
            }
        };
        let res = sources::fetch_jar(&jars, id, &version, build.as_deref(), &java, Some(&mut progress))?;
        if res.cached {
            ctx.out.line(&format!("Using stored {}.", res.name));
        } else {
            let build = if js::truthy(Some(&res.build)) {
                format!(" (build {})", js::string(Some(&res.build)))
            } else {
                String::new()
            };
            let size = match res.size_human.as_deref() {
                Some(s) if !s.is_empty() => format!(", {s}"),
                _ => String::new(),
            };
            ctx.out.line(&format!("Downloaded {}{build}{size}.", res.name));
        }
        let o = NewOptions {
            loader: id.into(),
            mc_version: Some(version),
            jar: serde_json::json!(res.name),
            java: serde_json::json!(java),
            ..super::create::new_options(ctx)
        };
        let made = create::new_instance(ctx.layout, &cli(), name, o)?;
        print_created(ctx, &made);
        return Ok(true);
    }
    if neoforge {
        let mc = ctx.args.get("neoforge").map(Flag::text).unwrap_or_default();
        let java = pick_java(ctx, &mc)?;
        let o = sources::NeoOptions {
            java,
            memory: match flag_value(ctx, "memory") {
                Value::Null => serde_json::json!("4G"),
                v => v,
            },
            port: ctx.args.get("port").filter(|f| f.truthy()).map(Flag::number),
            online_mode: !truthy(ctx, "offline"),
        };
        let layout = ctx.layout;
        let out = &mut *ctx.out;
        let mut progress = |m: &str| out.line(&format!("  {m}"));
        let res = sources::neo_create_server(layout, &cli(), name, &mc, o, &mut progress)?;
        ctx.out.line(&format!(
            "Created instance \"{name}\" — NeoForge {} (minecraft {}), port {}",
            res.neo_version,
            res.mc.as_deref().unwrap_or("null"),
            js::number_to_string(res.port)
        ));
        ctx.out.line(&format!("Start it with: spawnloft start {name}"));
        return Ok(true);
    }
    Ok(false)
}
