//! The three pages the panel serves (`/`, `/launcher`, `/setup`). They are compiled into the
//! binary, so a page can never be a different version from the API behind it and a headless
//! package is one file. A development build (no bundled runtime beside it) with
//! `SPAWNLOFT_CORE_DIR` set reads them from that checkout's `src/` instead, so a page can be
//! edited without a rebuild.

use std::path::PathBuf;

const UI: &str = include_str!("../../../../../src/ui.html");
const LAUNCHER: &str = include_str!("../../../../../src/launcher.html");
const SETUP: &str = include_str!("../../../../../src/setup.html");

/// Which page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Ui,
    Launcher,
    Setup,
}

impl Page {
    fn file(self) -> &'static str {
        match self {
            Page::Ui => "ui.html",
            Page::Launcher => "launcher.html",
            Page::Setup => "setup.html",
        }
    }

    fn embedded(self) -> &'static str {
        match self {
            Page::Ui => UI,
            Page::Launcher => LAUNCHER,
            Page::Setup => SETUP,
        }
    }
}

/// The checkout to read pages from: only for a development build, as `SPAWNLOFT_NODE` and the
/// core folder are (`runtime::core_dir`). An installed build never reads a page from disk.
fn dev_dir() -> Option<PathBuf> {
    let installed = crate::runtime::runtime_dir().is_some_and(|r| r.exists());
    if installed {
        return None;
    }
    std::env::var_os("SPAWNLOFT_CORE_DIR")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(p).join("src"))
}

/// The page's source.
pub fn source(page: Page) -> String {
    if let Some(dir) = dev_dir()
        && let Ok(text) = std::fs::read_to_string(dir.join(page.file()))
    {
        return text;
    }
    page.embedded().to_string()
}

/// `/`: the desktop gets a new localhost port (so a new origin) each launch, which loses
/// localStorage, so the saved theme goes into the page; with it what the page cannot ask
/// before it draws.
pub fn ui(theme: &str, platform: &str, managed_mysql: bool) -> String {
    source(Page::Ui)
        .replacen("data-theme=\"classic\"", &format!("data-theme=\"{theme}\""), 1)
        .replacen(
            "name=\"spawnloft-platform\" content=\"win32\"",
            &format!("name=\"spawnloft-platform\" content=\"{platform}\""),
            1,
        )
        .replacen(
            "name=\"spawnloft-managed-mysql\" content=\"true\"",
            &format!("name=\"spawnloft-managed-mysql\" content=\"{managed_mysql}\""),
            1,
        )
}

/// `/launcher`: the same theme injection as `/`.
pub fn launcher(theme: &str) -> String {
    source(Page::Launcher).replacen("data-theme=\"classic\"", &format!("data-theme=\"{theme}\""), 1)
}

/// `/setup`: the theme goes in as on `/`, so the first frame has the right colours.
pub fn setup(theme: &str) -> String {
    source(Page::Setup).replacen(
        "new URLSearchParams(location.search).get('theme')",
        &crate::jsjson::quote(theme),
        1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_has_the_marks_its_values_go_into() {
        // a page edited so that a mark is gone would silently keep its placeholder
        assert_eq!(UI.matches("data-theme=\"classic\"").count(), 1);
        assert!(UI.contains("name=\"spawnloft-platform\" content=\"win32\""));
        assert!(UI.contains("name=\"spawnloft-managed-mysql\" content=\"true\""));
        assert!(LAUNCHER.contains("data-theme=\"classic\""));
        assert!(SETUP.contains("new URLSearchParams(location.search).get('theme')"));
    }

    #[test]
    fn values_land_in_the_page() {
        let page = Page::Ui
            .embedded()
            .replacen("data-theme=\"classic\"", "data-theme=\"spawnloft\"", 1);
        assert!(page.contains("data-theme=\"spawnloft\""));
        assert!(
            !SETUP
                .replacen(
                    "new URLSearchParams(location.search).get('theme')",
                    "\"classic\"",
                    1
                )
                .contains("get('theme')")
        );
    }
}
