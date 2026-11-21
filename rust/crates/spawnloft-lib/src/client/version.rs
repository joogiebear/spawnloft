//! The id rules of `client-version.mjs`; the resolver comes with install and launch.

use regex::Regex;
use std::sync::LazyLock;

static SAFE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$").expect("valid"));
static PRE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-pre-?\d| Pre-Release \d").expect("valid"));
static RC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-rc-?\d").expect("valid"));

/// `isSafeVersionId(id)`: a version id as it may reach a folder name, a URL and the game's
/// command line; a trailing dot or space is refused (Windows drops them from folder names).
pub fn is_safe_version_id(id: &str) -> bool {
    SAFE_ID.is_match(id) && !id.contains("..") && !id.ends_with('.') && !id.ends_with(' ')
}

/// `versionKind({ id, type })`.
pub fn version_kind(id: &str, kind: Option<&str>) -> &'static str {
    match kind {
        Some("release") => "release",
        Some("old_beta") => "beta",
        Some("old_alpha") => "alpha",
        _ if PRE.is_match(id) => "pre-release",
        _ if RC.is_match(id) => "release-candidate",
        _ => "snapshot",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        for ok in [
            "1.21.11",
            "26.4-snapshot-6",
            "b1.7.3",
            "1.14.2 Pre-Release 4",
            "rd-132211",
        ] {
            assert!(is_safe_version_id(ok), "{ok}");
        }
        for bad in ["", ".1", "1..2", "1.2.", "1.2 ", "a/b", &"x".repeat(65)] {
            assert!(!is_safe_version_id(bad), "{bad}");
        }
    }

    #[test]
    fn kinds() {
        assert_eq!(version_kind("1.21", Some("release")), "release");
        assert_eq!(version_kind("b1.7.3", Some("old_beta")), "beta");
        assert_eq!(version_kind("1.21-pre1", Some("snapshot")), "pre-release");
        assert_eq!(
            version_kind("1.14.2 Pre-Release 4", Some("snapshot")),
            "pre-release"
        );
        assert_eq!(version_kind("1.21-rc1", Some("snapshot")), "release-candidate");
        assert_eq!(version_kind("24w14a", Some("snapshot")), "snapshot");
        assert_eq!(version_kind("x", None), "snapshot");
    }
}
