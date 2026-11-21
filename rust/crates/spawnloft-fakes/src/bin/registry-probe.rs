//! Changes `instances.json` from a Rust process through spawnloft-lib's registry writes, so
//! test/registry-cross-process.test.mjs can set it against `registry.mjs` (its twin is
//! test/fixtures/registry-node-probe.mjs, with the same commands and output). Test-only; never
//! shipped.
//!
//!   registry-probe put <registry> <name> <json>      putInstance
//!   registry-probe update <registry> <name> <json>   updateInstance; prints the record
//!   registry-probe remove <registry> <name>          removeInstance
//!   registry-probe many <registry> <prefix> <n>      putInstance of <prefix>-0 .. <prefix>-<n-1>
//!   registry-probe free <registry> <base>            freeName
//!
//! A refusal prints `error: <message>` and exits 1.

use std::path::Path;
use std::process::ExitCode;

use spawnloft_lib::failure::Failure;
use spawnloft_lib::jsjson;
use spawnloft_lib::registry;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match run(&args) {
        Ok(Some(out)) => {
            println!("{out}");
            ExitCode::SUCCESS
        }
        Ok(None) => ExitCode::SUCCESS,
        Err(e) => {
            println!("error: {}", e.message());
            ExitCode::FAILURE
        }
    }
}

fn json(text: &str) -> Result<serde_json::Value, Failure> {
    jsjson::parse(text).map_err(Failure::syntax)
}

fn run(args: &[&str]) -> Result<Option<String>, Failure> {
    match args {
        ["put", file, name, cfg] => {
            registry::put_instance(Path::new(file), name, json(cfg)?)?;
            Ok(None)
        }
        ["update", file, name, patch] => {
            let serde_json::Value::Object(patch) = json(patch)? else {
                return Err(Failure::usage("the patch is an object"));
            };
            let inst = registry::update_instance(Path::new(file), name, &patch)?;
            Ok(Some(jsjson::stringify(&serde_json::Value::Object(inst.fields))))
        }
        ["remove", file, name] => {
            registry::remove_instance(Path::new(file), name)?;
            Ok(None)
        }
        ["many", file, prefix, n] => {
            let n: u32 = n.parse().map_err(|_| Failure::usage("n is a count"))?;
            for i in 0..n {
                registry::put_instance(
                    Path::new(file),
                    &format!("{prefix}-{i}"),
                    serde_json::json!({ "port": 30000 + i, "by": "rust" }),
                )?;
            }
            Ok(None)
        }
        ["free", file, base] => Ok(Some(registry::free_name(Path::new(file), base)?)),
        _ => Err(Failure::usage(
            "usage: registry-probe put|update|remove|many|free <registry> ...",
        )),
    }
}
