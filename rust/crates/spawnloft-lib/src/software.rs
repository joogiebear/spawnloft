//! `software.mjs`: the table of server software SpawnLoft can create, and what a jar's name says
//! about the server (its Minecraft version, its loader).

use regex::Regex;
use std::sync::LazyLock;

/// `versionFromJar(jar)`: `paper-1.21.4-...`, `fabric-server-mc.1.21.4-...` and the like.
pub fn version_from_jar(jar: &str) -> Option<String> {
    static FORK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?i)^(?:paper|purpur|folia|asp|spigot|craftbukkit|vanilla)-([0-9]+\.[0-9]+(?:\.[0-9]+)?)",
        )
        .expect("valid")
    });
    static FABRIC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^fabric-server-mc\.([0-9]+\.[0-9]+(?:\.[0-9]+)?)-").expect("valid")
    });
    FORK.captures(jar)
        .or_else(|| FABRIC.captures(jar))
        .map(|m| m[1].to_string())
}

/// `guessLoader(jar, { hasNeoforgeLibs })`: from the jar name, and for NeoForge from the
/// libraries tree its installer leaves. Anything unrecognised is Paper.
pub fn guess_loader(jar: &str, has_neoforge_libs: bool) -> String {
    let lower = jar.to_ascii_lowercase();
    if lower.starts_with("fabric-server") {
        return "fabric".into();
    }
    if has_neoforge_libs {
        return "neoforge".into();
    }
    for id in ["purpur", "folia", "asp", "spigot", "craftbukkit", "vanilla"] {
        if lower.starts_with(&format!("{id}-")) {
            return id.into();
        }
    }
    "paper".into()
}

/// One row of `SOFTWARE`: what a plugins page needs of it. `content` is where it loads add-ons
/// from (`plugins`, `mods` or `none`), `modrinth` the search loader facet (widest-compatible
/// first), `hangar` whether PaperMC's platform is a useful second source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Software {
    pub id: &'static str,
    pub label: &'static str,
    pub content: &'static str,
    pub modrinth: &'static [&'static str],
    pub hangar: bool,
}

const fn sw(
    id: &'static str,
    label: &'static str,
    content: &'static str,
    modrinth: &'static [&'static str],
    hangar: bool,
) -> Software {
    Software {
        id,
        label,
        content,
        modrinth,
        hangar,
    }
}

/// `SOFTWARE`, in its order.
pub const SOFTWARE: [Software; 9] = [
    sw(
        "paper",
        "Paper",
        "plugins",
        &["paper", "spigot", "bukkit", "folia"],
        true,
    ),
    sw(
        "purpur",
        "Purpur",
        "plugins",
        &["purpur", "paper", "spigot", "bukkit", "folia"],
        true,
    ),
    sw("folia", "Folia", "plugins", &["folia"], false),
    sw(
        "asp",
        "Advanced Slime Paper",
        "plugins",
        &["paper", "spigot", "bukkit", "folia"],
        true,
    ),
    sw("spigot", "Spigot", "plugins", &["spigot", "bukkit"], false),
    sw("craftbukkit", "CraftBukkit", "plugins", &["bukkit"], false),
    sw("vanilla", "Vanilla", "none", &[], false),
    sw("fabric", "Fabric", "mods", &["fabric"], false),
    sw("neoforge", "NeoForge", "mods", &["neoforge"], false),
];

/// `softwareOf(loaderOf(inst))` from the recorded `loader`: absent or unknown is Paper (and so is
/// a value that is not text, which `Map.get` never matches).
pub fn software_of(loader: Option<&serde_json::Value>) -> Software {
    let id = match loader {
        Some(serde_json::Value::String(s)) => s.as_str(),
        _ => "paper",
    };
    SOFTWARE
        .iter()
        .find(|s| s.id == id)
        .copied()
        .unwrap_or(SOFTWARE[0])
}

#[cfg(test)]
mod tests {
    #[test]
    fn versions_from_jar_names() {
        use super::version_from_jar as v;
        assert_eq!(v("paper-1.21.4-232.jar").as_deref(), Some("1.21.4"));
        assert_eq!(v("PURPUR-1.20.jar").as_deref(), Some("1.20"));
        assert_eq!(
            v("fabric-server-mc.1.21.1-loader.0.16.jar").as_deref(),
            Some("1.21.1")
        );
        assert_eq!(v("fabric-server-mc.1.21.1.jar"), None);
        assert_eq!(v("server.jar"), None);
        assert_eq!(v("paper-26.1.jar").as_deref(), Some("26.1"));
    }

    #[test]
    fn loaders_from_jar_names() {
        use super::guess_loader as g;
        assert_eq!(g("Fabric-Server-launch.jar", true), "fabric");
        assert_eq!(g("server.jar", true), "neoforge");
        assert_eq!(g("PURPUR-1.21.jar", false), "purpur");
        assert_eq!(g("craftbukkit-1.21.jar", false), "craftbukkit");
        assert_eq!(g("vanilla.jar", false), "paper");
        assert_eq!(g("custom.jar", false), "paper");
    }
}
