//! The three pages the panel serves (`/`, `/launcher`, `/setup`) and the stylesheets, scripts and
//! typefaces they load from `/assets/`, plus the components page of a development build
//! (`/components`). All of it is compiled into the binary, so a page can never be a
//! different version from the API behind it and a headless package is one file. A debug or
//! `test-hooks` build with `SPAWNLOFT_CORE_DIR` set (a checkout) reads them from that checkout's
//! `src/panel/` instead, so a page can be edited without a rebuild; an asset is still only ever
//! one of the names compiled in.

use std::path::PathBuf;

const UI: &str = include_str!("../../../../../src/panel/ui.html");
const LAUNCHER: &str = include_str!("../../../../../src/panel/launcher.html");
const SETUP: &str = include_str!("../../../../../src/panel/setup.html");
const COMPONENTS: &str = include_str!("../../../../../src/panel/components.html");

/// Every stylesheet and script under `src/panel/css` and `src/panel/js`, and every typeface under
/// `src/panel/fonts`, by its name there (`css/tokens.css`), sorted by name: made by build.rs.
const ASSETS: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/panel_assets.rs"));

/// The theme mark in each page's `<html>`, replaced with the saved theme when it is served.
pub const THEME_MARK: &str = "data-theme=\"spawnloft\"";

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
    /// Every shared building block in every state (docs/ux-ui-plan-2026-11/PLAN.md phase 3).
    /// Served by a development build only: see `components()`.
    Components,
}

impl Page {
    fn file(self) -> &'static str {
        match self {
            Page::Ui => "ui.html",
            Page::Launcher => "launcher.html",
            Page::Setup => "setup.html",
            Page::Components => "components.html",
        }
    }

    fn embedded(self) -> &'static str {
        match self {
            Page::Ui => UI,
            Page::Launcher => LAUNCHER,
            Page::Setup => SETUP,
            Page::Components => COMPONENTS,
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

/// `/assets/<name>`: a stylesheet, a script or a typeface, and its type. Only a name in the compiled-in table
/// is answered, matched exactly (no decoding, no normalising: the listener has already resolved
/// dot segments, and a name that is not in the table is simply not found). A development build
/// reading a checkout reads that same name from it, and nothing else.
/// `theme` is asked only for the one script that carries it.
pub fn asset(name: &str, theme: fn() -> &'static str) -> Option<(&'static str, Vec<u8>)> {
    let i = ASSETS.binary_search_by(|(n, _)| (*n).cmp(name)).ok()?;
    let (name, embedded) = ASSETS[i];
    let kind = if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if name.ends_with(".woff2") {
        "font/woff2"
    } else {
        "text/javascript; charset=utf-8"
    };
    let bytes = dev_dir()
        .and_then(|dir| std::fs::read(dir.join(name)).ok())
        .unwrap_or_else(|| embedded.to_vec());
    if name == SETUP_THEME_SCRIPT {
        let text = String::from_utf8_lossy(&bytes);
        return Some((
            kind,
            text.replacen(THEME_ASKED, &crate::jsjson::quote(theme()), 1)
                .into_bytes(),
        ));
    }
    Some((kind, bytes))
}

/// `/`: the desktop gets a new localhost port (so a new origin) each launch, which loses
/// localStorage, so the saved theme goes into the page; with it what the page cannot ask
/// before it draws.
pub fn ui(theme: &str, platform: &str, managed_mysql: bool) -> String {
    source(Page::Ui)
        .replacen(THEME_MARK, &format!("data-theme=\"{theme}\""), 1)
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
    source(Page::Launcher).replacen(THEME_MARK, &format!("data-theme=\"{theme}\""), 1)
}

/// `/components`: the shared building blocks in every state, for whoever is building a page.
/// Only a debug or `test-hooks` build answers it, as only those read pages from a checkout; a
/// release build, which every package is, says it is not there.
pub fn components(theme: &str) -> Option<String> {
    if !(cfg!(debug_assertions) || cfg!(feature = "test-hooks")) {
        return None;
    }
    // the icons are ui.html's own sprite, not a copy that could drift from it
    let ui = source(Page::Ui);
    let sprite = ui
        .find("<svg id=\"sprite\"")
        .and_then(|from| ui[from..].find("</svg>").map(|len| &ui[from..from + len + 6]))
        .unwrap_or("");
    Some(
        source(Page::Components)
            .replacen(THEME_MARK, &format!("data-theme=\"{theme}\""), 1)
            .replacen(SPRITE_MARK, sprite, 1),
    )
}

/// Where the components page takes ui.html's icon sprite.
const SPRITE_MARK: &str = "<!-- sprite from ui.html -->";

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
        assert_eq!(UI.matches(THEME_MARK).count(), 1);
        assert_eq!(COMPONENTS.matches(THEME_MARK).count(), 1);
        assert!(UI.contains("name=\"spawnloft-platform\" content=\"win32\""));
        assert!(UI.contains("name=\"spawnloft-managed-mysql\" content=\"true\""));
        assert!(LAUNCHER.contains(THEME_MARK));
        let setup_theme =
            std::str::from_utf8(ASSETS.iter().find(|(n, _)| *n == SETUP_THEME_SCRIPT).unwrap().1).unwrap();
        assert_eq!(setup_theme.matches(THEME_ASKED).count(), 1);
        assert!(SETUP.contains(&format!("<script src=\"/assets/{SETUP_THEME_SCRIPT}\"></script>")));
    }

    #[test]
    fn values_land_in_the_page() {
        let page = ui("classic", "linux", false);
        assert!(page.contains("data-theme=\"classic\""));
        assert!(!page.contains(THEME_MARK));
        let (kind, script) = asset(SETUP_THEME_SCRIPT, || "spawnloft").unwrap();
        let script = String::from_utf8(script).unwrap();
        assert_eq!(kind, "text/javascript; charset=utf-8");
        assert!(!script.contains("get('theme')"), "{script}");
        assert!(script.contains("\"spawnloft\" === 'classic'"), "{script}");
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
        // the typefaces, and not the licences that sit beside them
        let mut fonts = Vec::new();
        walk(&root.join("fonts"), &root, &mut fonts);
        assert!(
            fonts.iter().any(|f| f.ends_with(".txt")),
            "the font licences are kept beside the fonts"
        );
        on_disk.extend(fonts.into_iter().filter(|f| f.ends_with(".woff2")));
        on_disk.sort();
        let table: Vec<String> = ASSETS.iter().map(|(n, _)| n.to_string()).collect();
        assert_eq!(table, on_disk);
        assert!(
            ASSETS.windows(2).all(|w| w[0].0 < w[1].0),
            "sorted, for binary_search"
        );
        for page in [UI, LAUNCHER, SETUP, COMPONENTS] {
            let mut asked = 0;
            for piece in page.split("/assets/").skip(1) {
                let name = &piece[..piece.find('"').unwrap()];
                assert!(asset(name, || "classic").is_some(), "{name}");
                asked += 1;
            }
            assert!(asked >= 2);
            // the built Tailwind file (tools/panel-css.mjs) declares the cascade layers, so it
            // comes straight after the tokens and before the page's own stylesheets
            let first: Vec<&str> = page
                .split("<link rel=\"stylesheet\" href=\"/assets/")
                .skip(1)
                .take(2)
                .map(|piece| &piece[..piece.find('"').unwrap()])
                .collect();
            assert_eq!(first, ["css/tokens.css", "css/tailwind.css"]);
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
        let (kind, bytes) = asset("fonts/inter-latin.woff2", || "classic").unwrap();
        assert_eq!(kind, "font/woff2");
        assert_eq!(&bytes[..4], b"wOF2");
        // only the typefaces are taken from the fonts folder
        assert!(asset("fonts/OFL-inter.txt", || "classic").is_none());
    }

    /// Every typeface the tokens name is one the panel serves, and every one it serves is named.
    #[test]
    fn the_tokens_name_every_bundled_typeface() {
        let (_, tokens) = asset("css/tokens.css", || "classic").unwrap();
        let tokens = String::from_utf8(tokens).unwrap();
        let named: Vec<&str> = tokens
            .split("url(\"/assets/")
            .skip(1)
            .map(|piece| &piece[..piece.find('"').unwrap()])
            .collect();
        let served: Vec<&str> = ASSETS
            .iter()
            .map(|(n, _)| *n)
            .filter(|n| n.ends_with(".woff2"))
            .collect();
        assert!(served.len() >= 3);
        let mut named_sorted = named.clone();
        named_sorted.sort();
        assert_eq!(named_sorted, served);
    }

    #[test]
    fn the_components_page_is_only_in_a_development_build() {
        // tests are a debug build
        let page = components("classic").unwrap();
        assert!(page.contains("data-theme=\"classic\""));
        assert!(COMPONENTS.contains(SPRITE_MARK));
        assert!(!page.contains(SPRITE_MARK));
        assert!(page.contains("<symbol id=\"i-play\""));
        // a Windows checkout may hold the page with CRLF line ends
        assert!(page.replace("\r\n", "\n").contains("</svg>\n<main"));
    }
}
