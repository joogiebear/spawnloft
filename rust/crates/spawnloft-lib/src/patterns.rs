//! Console patterns for ready and failed starts (`ready.mjs`). The daemon only uses `ready`, to
//! say "back up after a crash"; the supervisor uses both from the Node side.

use regex::Regex;
use std::sync::LazyLock;

use crate::registry::Instance;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("console pattern")
}

/// Paper, Fabric and NeoForge print vanilla's `Done (12.345s)! For help, type "help"`.
pub static READY: LazyLock<Regex> = LazyLock::new(|| re(r"Done \([0-9.,]+s\)!"));
pub static FAILED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(Failed to start the minecraft server|A fatal error has occurred|Could not (?:reserve|create).*heap|Unable to access jarfile)",
    )
});
pub static MARIADB_READY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)ready for connections"));
pub static MARIADB_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\[ERROR\] (?:Aborting|Can't start server|mariadbd: Can't|mysqld: Can't|InnoDB: Unable to lock|Fatal error)",
    )
});
pub static GARNET_READY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)ready to accept connections"));
pub static GARNET_FAILED: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)address already in use|only one usage of each socket|unhandled exception|cannot bind")
});

/// The pair that fits an instance (`patternsFor`).
pub fn for_instance(inst: &Instance) -> (&'static Regex, &'static Regex) {
    if inst.is_database() {
        if inst.engine() == Some("garnet") {
            return (&GARNET_READY, &GARNET_FAILED);
        }
        return (&MARIADB_READY, &MARIADB_FAILED);
    }
    (&READY, &FAILED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines() {
        assert!(READY.is_match("[12:00:00 INFO]: Done (0.042s)! For help, type \"help\""));
        assert!(READY.is_match("Done (1,234s)!"));
        assert!(!READY.is_match("Done!"));
        assert!(FAILED.is_match("Error: could not create the Java Virtual Machine heap"));
        assert!(MARIADB_READY.is_match("mariadbd: ready for connections."));
        assert!(GARNET_READY.is_match("* Ready to accept connections"));
    }
}
