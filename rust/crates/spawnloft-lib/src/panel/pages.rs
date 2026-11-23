//! The three pages the panel serves (`/`, `/launcher`, `/setup`) and the stylesheets and scripts
//! they load from `/assets/`. All of it is compiled into the binary, so a page can never be a
//! different version from the API behind it and a headless package is one file. A debug or
//! `test-hooks` build with `SPAWNLOFT_CORE_DIR` set (a checkout) reads them from that checkout's
//! `src/panel/` instead, so a page can be edited without a rebuild; an asset is still only ever
//! one of the names compiled in.

use std::path::PathBuf;

const UI: &str = include_str!("../../../../../src/panel/ui.html");
const LAUNCHER: &str = include_str!("../../../../../src/panel/launcher.html");
const SETUP: &str = include_str!("../../../../../src/panel/setup.html");

/// Every file under `src/panel/css` and `src/panel/js`, by its name there (`css/tokens.css`),
/// sorted by name: made by build.rs.
const ASSETS: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/panel_assets.rs"));

/// The setup page's first script: the theme goes into it, as it went into the page while the
/// script was inline.
const SETUP_THEME_SCRIPT: &str = "js/setup/00-theme.js";
const THEME_ASKED: &str = "new URLSearchParams(location.search).get('theme')";

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

/// The checkout to read pages from: only in a debug or `test-hooks` build. A release build, which
/// every package is, never reads a page from disk.
fn dev_dir() -> Option<PathBuf> {
    if !(cfg!(debug_assertions) || cfg!(feature = "test-hooks")) {
        return None;
    }
    std::env::var_os("SPAWNLOFT_CORE_DIR")
        .filter(|p| !p.is_empty())
        .map(|p| PathBuf::from(p).join("src").join("panel"))
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

/// `/assets/<name>`: a stylesheet or a script, and its type. Only a name in the compiled-in table
/// is answered, matched exactly (no decoding, no normalising: the listener has already resolved
/// dot segments, and a name that is not in the table is simply not found). A development build
/// reading a checkout reads that same name from it, and nothing else.
/// `theme` is asked only for the one script that carries it.
pub fn asset(name: &str, theme: fn() -> &'static str) -> Option<(&'static str, String)> {
    let i = ASSETS.binary_search_by(|(n, _)| (*n).cmp(name)).ok()?;
    let (name, embedded) = ASSETS[i];
    let kind = if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else {
        "text/javascript; charset=utf-8"
    };
    let text = dev_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join(name)).ok())
        .unwrap_or_else(|| embedded.to_string());
    if name == SETUP_THEME_SCRIPT {
        return Some((
            kind,
            text.replacen(THEME_ASKED, &crate::jsjson::quote(theme()), 1),
        ));
    }
    Some((kind, text))
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

/// `/setup`: the theme goes into the page's first script (`asset`), as on `/`, so the first
/// frame has the right colours.
pub fn setup() -> String {
    source(Page::Setup)
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
        let setup_theme = ASSETS.iter().find(|(n, _)| *n == SETUP_THEME_SCRIPT).unwrap().1;
        assert_eq!(setup_theme.matches(THEME_ASKED).count(), 1);
        assert!(SETUP.contains(&format!("<script src=\"/assets/{SETUP_THEME_SCRIPT}\"></script>")));
    }

    #[test]
    fn values_land_in_the_page() {
        let page = Page::Ui
            .embedded()
            .replacen("data-theme=\"classic\"", "data-theme=\"spawnloft\"", 1);
        assert!(page.contains("data-theme=\"spawnloft\""));
        let (kind, script) = asset(SETUP_THEME_SCRIPT, || "spawnloft").unwrap();
        assert_eq!(kind, "text/javascript; charset=utf-8");
        assert!(!script.contains("get('theme')"), "{script}");
        assert!(script.contains("\"spawnloft\" === 'spawnloft'"), "{script}");
    }

    /// Every file in `src/panel/css` and `src/panel/js` is in the table, and every page names
    /// only files that are in it, so a page can never ask for something the panel will not send.
    #[test]
    fn the_table_holds_every_file_and_every_page_asks_only_for_those() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/panel");
        fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
                    out.push(rel);
                }
            }
        }
        let mut on_disk = Vec::new();
        walk(&root.join("css"), &root, &mut on_disk);
        walk(&root.join("js"), &root, &mut on_disk);
        on_disk.sort();
        let table: Vec<String> = ASSETS.iter().map(|(n, _)| n.to_string()).collect();
        assert_eq!(table, on_disk);
        assert!(
            ASSETS.windows(2).all(|w| w[0].0 < w[1].0),
            "sorted, for binary_search"
        );
        for page in [UI, LAUNCHER, SETUP] {
            let mut asked = 0;
            for piece in page.split("/assets/").skip(1) {
                let name = &piece[..piece.find('"').unwrap()];
                assert!(asset(name, || "classic").is_some(), "{name}");
                asked += 1;
            }
            assert!(asked >= 2);
            // no script left in the page itself: the launcher's policy allows none
            assert!(!page.contains("<script>"));
            assert!(!page.contains("<style>"));
        }
        assert!(!LAUNCHER.contains("script-src 'self' 'unsafe-inline'"));
    }

    #[test]
    fn only_exact_names_are_answered() {
        assert!(asset("css/tokens.css", || "classic").is_some());
        for name in [
            "",
            "css",
            "css/",
            "/css/tokens.css",
            "css//tokens.css",
            "css/tokens.css/",
            "css/./tokens.css",
            "css/../css/tokens.css",
            "css%2ftokens.css",
            "CSS/tokens.css",
            "css/tokens.css?x",
            "css/tokens.css\0",
            "../ui.html",
            "ui.html",
            "../../Cargo.toml",
        ] {
            assert!(asset(name, || "classic").is_none(), "{name}");
        }
        let (kind, _) = asset("css/tokens.css", || "classic").unwrap();
        assert_eq!(kind, "text/css; charset=utf-8");
    }
}
