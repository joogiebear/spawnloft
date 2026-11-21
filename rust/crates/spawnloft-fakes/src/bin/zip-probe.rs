//! Reads and writes zips from a Rust process through spawnloft-lib's `zip` module, so
//! test/zip-cross-process.test.mjs can set it against `zip.mjs` and the jar readers of
//! `plugins.mjs` (its twin is test/fixtures/zip-node-probe.mjs, with the same commands and
//! output). Test-only; never shipped.
//!
//!   zip-probe create <zip> <cwd> [--zip64] [--exclude <name>]... -- <member>...   createZip
//!   zip-probe list <zip>                    zipEntries, as JSON
//!   zip-probe extract <zip> <dest>          extractZip
//!   zip-probe is-zip <file>                 isZip
//!   zip-probe jar-list <zip>                zipEntryList
//!   zip-probe jar-read <zip> <name>         readZipEntry, as hex (null when absent)
//!   zip-probe jar-extract <zip> <dest> <prefix>   extractZip with mapPath: names under
//!                                           <prefix> without it, others skipped
//!
//! A failure prints the line the core would (`error: <message>`, or the error's first stack
//! line) and exits 1.

use std::path::Path;
use std::process::ExitCode;

use serde_json::{Value, json};
use spawnloft_lib::failure::Failure;
use spawnloft_lib::zip;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match run(&args) {
        Ok(out) => {
            println!("{}", spawnloft_lib::jsjson::stringify(&out));
            ExitCode::SUCCESS
        }
        Err(e) => {
            print!("{}", e.stderr_text());
            ExitCode::FAILURE
        }
    }
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

fn run(args: &[&str]) -> Result<Value, Failure> {
    match args {
        ["create", file, cwd, rest @ ..] => {
            let mut zip64 = false;
            let mut exclude = Vec::new();
            let mut members = Vec::new();
            let mut i = 0;
            while i < rest.len() {
                match rest[i] {
                    "--zip64" => zip64 = true,
                    "--exclude" => {
                        i += 1;
                        exclude.push(rest[i]);
                    }
                    "--" => {
                        members.extend_from_slice(&rest[i + 1..]);
                        break;
                    }
                    other => return Err(Failure::usage(format!("unknown option {other}"))),
                }
                i += 1;
            }
            let made = zip::create(Path::new(file), cwd, &members, &exclude, zip64)?;
            Ok(json!({ "entries": made.entries }))
        }
        ["list", file] => {
            let mut f =
                std::fs::File::open(file).map_err(|e| Failure::io(&e, "open", Some(Path::new(file))))?;
            let mut out = Vec::new();
            for entry in zip::entries(&mut f)? {
                let e = entry?;
                out.push(json!({
                    "name": e.name, "madeBy": e.made_by, "flags": e.flags, "method": e.method, "crc": e.crc,
                    "packed": e.packed, "size": e.size, "attributes": e.attributes, "offset": e.offset,
                }));
            }
            Ok(Value::Array(out))
        }
        ["extract", file, dest] => Ok(json!({ "files": zip::extract(Path::new(file), Path::new(dest))? })),
        ["is-zip", file] => Ok(json!(zip::is_zip(Path::new(file))?)),
        ["jar-list", file] => Ok(Value::Array(
            zip::jar::entry_list(Path::new(file))?
                .into_iter()
                .map(|(name, size)| json!({ "name": name, "size": size }))
                .collect(),
        )),
        ["jar-read", file, name] => Ok(match zip::jar::read_entry(Path::new(file), name)? {
            Some(data) => json!(hex(&data)),
            None => Value::Null,
        }),
        ["jar-extract", file, dest, prefix] => {
            Ok(json!(zip::jar::extract(Path::new(file), Path::new(dest), |n| {
                n.strip_prefix(prefix).map(str::to_string)
            })?))
        }
        _ => Err(Failure::usage("unknown command")),
    }
}
