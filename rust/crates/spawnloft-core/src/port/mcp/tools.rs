//! The tools of `mcp-tools.mjs` and `mcp-client-tools.mjs`. Tiers: read tools are always
//! offered; undoable actions are offered but marked as writes; destructive tools exist only with
//! `--allow-destructive` and need `confirm: true` after a preview. Deleting a server, database
//! credentials and secret settings are deliberately not exposed.
//!
//! What each tool is called, its title, description, input schema and annotations are the
//! contract every MCP client caches: they live in `tools.json`, copied from the Node core's
//! listing (`test/fixtures/contracts/cli/mcp-tools.json`, which a test holds this file to), so
//! the Rust listing is the same bytes. The code here is what each one does.

use serde_json::{Map, Value};
use std::sync::LazyLock;

use spawnloft_lib::activity::Actor;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::settings::Layout;
use spawnloft_lib::{js, supervisor};

/// What a tool is run with: where the data is, who is acting (the assistant, by the name it
/// gave), and the progress callback (a no-op without a progress token).
pub struct Call<'a> {
    pub layout: &'a Layout,
    pub by: Actor,
    pub progress: &'a (dyn Fn(&str) + Sync),
}

/// A tool's answer: the text the model reads and the structured data (`{ text, data }`).
pub struct Out {
    pub text: Option<String>,
    pub data: Value,
}

impl Out {
    pub fn new(data: Value, text: impl Into<String>) -> Out {
        Out {
            text: Some(text.into()),
            data,
        }
    }
}

pub type Args = Map<String, Value>;
pub type Run = fn(&Call<'_>, &Args) -> Result<Out, Failure>;

pub struct Tool {
    pub name: &'static str,
    pub run: Run,
    /// `failed(data)`: the call worked but what it found is a failure (`isError`).
    pub failed: Option<fn(&Value) -> bool>,
}

/// The listing of every tool, destructive ones included, in the Node core's order.
static LISTING: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let v = spawnloft_lib::jsjson::parse(include_str!("tools.json")).expect("tools.json is JSON");
    match v {
        Value::Array(items) => items,
        _ => panic!("tools.json is a list"),
    }
});

/// The tools that exist only with `--allow-destructive`.
pub const DESTRUCTIVE: &[&str] = &["restore", "kill", "upgrade_minecraft"];

impl Tool {
    pub fn listing(&self) -> &'static Value {
        LISTING
            .iter()
            .find(|t| t.get("name").and_then(Value::as_str) == Some(self.name))
            .expect("every tool is listed in tools.json")
    }
}

/// `toolsFor({ allowDestructive })`: read tools, client read tools, actions, client actions,
/// then the destructive ones.
pub fn tools_for(allow_destructive: bool) -> Vec<&'static Tool> {
    LISTING
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .filter(|n| allow_destructive || !DESTRUCTIVE.contains(n))
        .map(|n| {
            ALL.iter()
                .find(|t| t.name == n)
                .unwrap_or_else(|| panic!("tool {n} has no implementation"))
        })
        .collect()
}

static ALL: LazyLock<Vec<Tool>> = LazyLock::new(|| {
    let mut all = super::read::tools();
    all.extend(super::act::tools());
    all.extend(super::client::tools());
    all
});

pub const INSTRUCTIONS: &str = "SpawnLoft runs Minecraft servers on this computer. Start with list_servers to learn the server names.
Changes to plugins and the server software take effect when the server next restarts. install_plugin and update_plugin take a plugins snapshot first; take a backup yourself before anything else risky.
To change a plugin's settings, find the file with list_config_files, read it with read_config_file, and change it with write_config_file using old_text and new_text; each change is snapshotted first. Then reload the plugin with run_command, or restart.
When a server will not start, read diagnostics before get_logs. For get_logs, prefer level \"warn\" over reading everything.
When a person reports a bug, diagnostics with bundle: true writes a zip they can attach.
Destructive tools (restore, kill, upgrade_minecraft), when present, describe what they would do unless called with confirm: true; show that description to the user before confirming.
Test players: bot_run_scenario joins up to five scripted players for plugin tests. client_launch starts the real game for one player when what matters is what a player sees; use client_profiles to find a profile, client_join to connect it to a server, client_chat and client_messages to talk, client_screenshot for evidence, client_quit when done.";

// ------------------------------------------------------------------------------ helpers

/// An argument that was given (`args.x !== undefined`).
pub fn arg<'a>(args: &'a Args, key: &str) -> Option<&'a Value> {
    args.get(key)
}

/// A string argument the schema has checked, or its default.
pub fn text_arg(args: &Args, key: &str) -> Option<String> {
    args.get(key).map(|v| js::string(Some(v)))
}

pub fn bool_arg(args: &Args, key: &str, default: bool) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        _ => default,
    }
}

pub fn number_arg(args: &Args, key: &str, default: f64) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(default)
}

/// The required `name` argument.
pub fn name_arg(args: &Args) -> String {
    text_arg(args, "name").unwrap_or_else(|| "undefined".into())
}

/// `getInstance(n)`.
pub fn instance(call: &Call<'_>, name: &str) -> Result<Instance, Failure> {
    registry::lookup(std::path::Path::new(&call.layout.registry_file), name)
}

/// `server(n)`: a Minecraft server, not a database.
pub fn server(call: &Call<'_>, name: &str) -> Result<Instance, Failure> {
    let inst = instance(call, name)?;
    if inst.is_database() {
        return Err(Failure::user(format!(
            "\"{name}\" is a database, not a Minecraft server"
        )));
    }
    Ok(inst)
}

pub fn is_running(call: &Call<'_>, name: &str) -> Result<bool, Failure> {
    supervisor::is_running(call.layout, name)
}

/// `lines(list)`.
pub fn lines(list: &[String]) -> String {
    if list.is_empty() {
        "(no lines)".into()
    } else {
        list.join("\n")
    }
}

/// `{ a, ...b }`: `b`'s keys over `a`'s, each kept where it first appeared.
pub fn spread(mut into: Map<String, Value>, v: &Value) -> Map<String, Value> {
    if let Value::Object(m) = v {
        for (k, val) in m {
            into.insert(k.clone(), val.clone());
        }
    }
    into
}

pub fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// `path.basename(file)`.
pub fn basename(file: &str) -> String {
    spawnloft_lib::jspath::basename(file)
}

pub const MAX_LOG_LINES: usize = 500;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The listing is the contract: the Node core's `tools/list`, byte for byte.
    #[test]
    fn the_listing_is_the_node_cores() {
        let golden = include_str!("../../../../../../test/fixtures/contracts/cli/mcp-tools.json");
        let golden = spawnloft_lib::jsjson::parse(golden).unwrap();
        let steps = golden["steps"].as_array().unwrap();
        let listing = |step: usize| -> String {
            let stdout = steps[step]["stdout"].as_str().unwrap();
            let line = stdout.lines().nth(1).unwrap();
            let v = spawnloft_lib::jsjson::parse(line).unwrap();
            spawnloft_lib::jsjson::stringify(&v["result"]["tools"])
        };
        let ours = |d: bool| {
            let list: Vec<Value> = tools_for(d).iter().map(|t| t.listing().clone()).collect();
            spawnloft_lib::jsjson::stringify(&Value::Array(list))
        };
        assert_eq!(ours(false), listing(0));
        assert_eq!(ours(true), listing(1));
        assert_eq!(tools_for(true).len(), 39);
    }

    #[test]
    fn instructions_are_the_node_cores() {
        let golden = include_str!("../../../../../../test/fixtures/contracts/cli/mcp-tools.json");
        let golden = spawnloft_lib::jsjson::parse(golden).unwrap();
        let line = golden["steps"][0]["stdout"]
            .as_str()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .to_string();
        let v = spawnloft_lib::jsjson::parse(&line).unwrap();
        assert_eq!(v["result"]["instructions"], json!(INSTRUCTIONS));
    }
}
