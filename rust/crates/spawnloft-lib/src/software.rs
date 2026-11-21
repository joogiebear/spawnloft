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
