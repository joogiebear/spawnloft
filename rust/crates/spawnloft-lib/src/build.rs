//! Which build this is: version, commit and target, as `spawnloft-core --version` prints them.

/// The product name every binary reports.
pub const NAME: &str = "spawnloft-core";

/// Version, commit and target triple of this binary, fixed at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildInfo {
    /// `2.0.0-internal.<run>` from CI, or the workspace version for a local build.
    pub version: &'static str,
    /// Full commit hash when CI passed one, `None` for a local build.
    pub commit: Option<&'static str>,
    /// Rust target triple, for example `x86_64-pc-windows-msvc`.
    pub target: &'static str,
}

/// The identity compiled into this binary.
pub const fn current() -> BuildInfo {
    BuildInfo {
        version: match option_env!("SPAWNLOFT_VERSION") {
            Some(v) if !v.is_empty() => v,
            _ => env!("CARGO_PKG_VERSION"),
        },
        commit: match option_env!("SPAWNLOFT_COMMIT") {
            Some(c) if !c.is_empty() => Some(c),
            _ => None,
        },
        target: env!("SPAWNLOFT_TARGET"),
    }
}

impl BuildInfo {
    /// The commit cut to twelve characters, as the desktop app's build-info.json does.
    pub fn short_commit(&self) -> Option<&'static str> {
        self.commit.map(|c| c.get(..12).unwrap_or(c))
    }

    /// One line: `spawnloft-core 2.0.0-internal.7 (1a461f1e2b3c, x86_64-pc-windows-msvc)`.
    pub fn line(&self) -> String {
        match self.short_commit() {
            Some(commit) => format!("{NAME} {} ({commit}, {})", self.version, self.target),
            None => format!("{NAME} {} ({})", self.version, self.target),
        }
    }

    /// The same as one JSON object, for scripts and `verify-build.mjs`.
    pub fn json(&self) -> String {
        use crate::json::string;
        let commit = self.commit.map(string).unwrap_or_else(|| "null".to_string());
        format!(
            "{{\"name\":{},\"version\":{},\"commit\":{commit},\"target\":{}}}",
            string(NAME),
            string(self.version),
            string(self.target),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL: BuildInfo = BuildInfo {
        version: "2.0.0-internal.0",
        commit: None,
        target: "x86_64-unknown-linux-gnu",
    };
    const CI: BuildInfo = BuildInfo {
        version: "2.0.0-internal.12",
        commit: Some("1a461f1e2b3c4d5e6f708192a3b4c5d6e7f80910"),
        target: "x86_64-pc-windows-msvc",
    };

    #[test]
    fn local_line_has_no_commit() {
        assert_eq!(
            LOCAL.line(),
            "spawnloft-core 2.0.0-internal.0 (x86_64-unknown-linux-gnu)"
        );
    }

    #[test]
    fn ci_line_names_the_short_commit() {
        assert_eq!(
            CI.line(),
            "spawnloft-core 2.0.0-internal.12 (1a461f1e2b3c, x86_64-pc-windows-msvc)"
        );
    }

    #[test]
    fn json_is_one_object() {
        assert_eq!(
            LOCAL.json(),
            r#"{"name":"spawnloft-core","version":"2.0.0-internal.0","commit":null,"target":"x86_64-unknown-linux-gnu"}"#
        );
        assert!(
            CI.json()
                .contains(r#""commit":"1a461f1e2b3c4d5e6f708192a3b4c5d6e7f80910""#)
        );
    }

    #[test]
    fn current_build_has_a_version_and_target() {
        let info = current();
        assert!(!info.version.is_empty());
        assert!(!info.target.is_empty() && info.target != "unknown");
    }
}
