//! `config [show|set-root|set-instances|set-backup-mirror|same-drive]`: `cmdConfig` in mcctl.mjs
//! (C3), where the data folder and its parts are, and the backup mirror.

use serde_json::{Value, json};

use spawnloft_lib::failure::Failure;
use spawnloft_lib::{backup, jspath, settings, text};

use super::Ctx;

fn row(a: &str, b: String) -> Vec<String> {
    vec![a.to_string(), b]
}

/// `path.resolve(dir)` and the write test; the refusal names the folder and why.
fn writable_folder(arg: &str) -> Result<String, Failure> {
    let abs = jspath::resolve(arg);
    if let Err(why) = settings::check_writable(&abs) {
        return Err(Failure::user(format!("cannot write to {abs}\n  {why}")));
    }
    Ok(abs)
}

pub fn config(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let positional = ctx.args.positional.clone();
    let sub = positional.first().map(String::as_str);
    let arg = positional.get(1).filter(|s| !s.is_empty());

    match sub {
        None | Some("") | Some("show") => {
            let l = ctx.layout;
            let mirror = backup::mirror_root()?.unwrap_or_else(|| {
                "(none - one disk failure takes servers and snapshots together)".to_string()
            });
            let instances = if l.separate_instances {
                format!("{}   (separate location)", l.instances_dir)
            } else {
                l.instances_dir.clone()
            };
            ctx.out.line(&text::table(&[
                row("settings file:", l.settings_file.clone()),
                row("data root:", l.data_root.clone()),
                row("instances:", instances),
                row("jars:", l.jars_dir.clone()),
                row("backups:", l.backups_dir.clone()),
                row("backup mirror:", mirror),
                row("templates:", l.templates_dir.clone()),
                row("run state:", l.run_dir.clone()),
            ]));
            // the legacy layout (a checkout's own folder as the data root) is the Node core's
            // alone: settings.rs never picks it
            Ok(())
        }
        Some(s @ ("set-root" | "set-instances")) => {
            let Some(dir) = arg else {
                return Err(Failure::user(format!("usage: spawnloft config {s} <path>")));
            };
            let abs = writable_folder(dir)?;
            // set-root names the data folder a damaged settings file would have held, so it may
            // replace one (keeping the damaged file); set-instances would drop it with the
            // damage, so it refuses
            let root = s == "set-root";
            let patch: Vec<(&str, Value)> = if root {
                vec![("dataRoot", json!(abs))]
            } else {
                vec![("instancesDir", json!(abs)), ("separateInstances", json!(true))]
            };
            let (_, aside) = settings::save(&patch, root)?;
            if let Some(kept) = aside {
                ctx.out.line(&format!(
                    "The settings file could not be read, so it was kept as {kept}."
                ));
            }
            ctx.out.line(&format!(
                "Saved. {}: {abs}",
                if root { "Data root" } else { "Instances directory" }
            ));
            ctx.out.line("");
            ctx.out.line("Takes effect on the next command. Nothing is moved: the registry is inside the data root, so");
            ctx.out.line("the servers you already have are not listed under the new one, and keep running where they are.");
            ctx.out
                .line("To move the data and keep everything working: spawnloft data move <folder>");
            Ok(())
        }
        Some("set-backup-mirror") => {
            let Some(a) = arg else {
                return Err(Failure::user(
                    "usage: spawnloft config set-backup-mirror <path>|off",
                ));
            };
            if a.to_lowercase() == "off" {
                settings::save(&[("backupsMirrorDir", Value::Null)], false)?;
                ctx.out
                    .line("Mirroring turned off. Copies already made stay where they are.");
                return Ok(());
            }
            let abs = writable_folder(a)?;
            settings::save(&[("backupsMirrorDir", json!(abs))], false)?;
            ctx.out.line(&format!(
                "Every new snapshot, for every server, now also copies to {abs}."
            ));
            ctx.out
                .line("Ideally that is another drive - the point is that one disk failure cannot take");
            ctx.out
                .line("the servers and their backups together. Retention deletions follow the mirror.");
            Ok(())
        }
        Some("same-drive") => {
            settings::save(&[("separateInstances", json!(false))], false)?;
            ctx.out.line("Servers will be created under the data root again.");
            Ok(())
        }
        Some(_) => Err(Failure::user(
            "usage: spawnloft config [show|set-root <path>|set-instances <path>|same-drive]",
        )),
    }
}
