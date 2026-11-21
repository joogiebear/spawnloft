//! The parts of `software.mjs` the lifecycle needs before C4 ports the rest: the Minecraft
//! version a server jar's name carries.

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
}
