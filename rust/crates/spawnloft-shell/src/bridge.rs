//! The window's half of the panel: `window.spawnloftDesktop` for the panel's pages, the rules for
//! where the window may go, and the extra windows the panel opens. This replaces what Electron's
//! `main.js` and `preload.js` did (PLAN-2.0-REMAINING.md section 3C).
//!
//! Who may call what (the security note in 3C):
//! - The bridge is a fixed set of named commands (below), never a generic open or shell. Each
//!   command checks its arguments itself, as `main.js` did.
//! - They are granted by a capability added at run time for exactly the panel's origin,
//!   `http://127.0.0.1:<port>`, not `http://127.0.0.1:*`: another loopback page (a plugin's web
//!   map, say) gets nothing even if it were shown. Tauri's own IPC scripts and its invoke key are
//!   injected into top-level frames only, so a frame inside the panel cannot call them either.
//! - Every command checks once more that the webview asking is showing the panel's origin now.
//! - The navigation guard keeps every window on that origin (plus the window's own start page and
//!   `about:` frames); a link anywhere else does nothing, and `window.open` of an https address
//!   goes to the system browser, as in 1.x.
//! - The plugins used from here (dialog) get no permissions: the page cannot reach their commands.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

use crate::local;
use crate::winstate::{self, Tracker};
use crate::zoom::{self, Setting};

/// The commands the page may call; `build.rs` declares the same list as the app's ACL manifest,
/// which makes Tauri refuse any command not granted by a capability.
pub const COMMANDS: &[&str] = &[
    "pick_folder",
    "pick_file",
    "get_zoom",
    "set_zoom",
    "zoom_key",
    "open_external",
    "open_profile_folder",
    "open_microsoft_login",
    "restart_core",
    "focus_window",
];

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        pick_folder,
        pick_file,
        get_zoom,
        set_zoom,
        zoom_key,
        open_external,
        open_profile_folder,
        open_microsoft_login,
        restart_core,
        focus_window
    ]
}

/// Injected into every top-level page of every window; it only defines the bridge on a
/// `http://127.0.0.1:<port>` page, and the commands check that it is the panel's.
pub const BRIDGE_JS: &str = include_str!("bridge.js");

pub const MAIN: &str = "main";
pub const LAUNCHER: &str = "launcher";
const CONSOLE_PREFIX: &str = "console-";
const MAIN_DEFAULT: (f64, f64) = (1280.0, 820.0);
const MAIN_MIN: (f64, f64) = (900.0, 600.0);
// the launcher's size in CSS pixels, as desktop/launcher-window.js
const LAUNCHER_CSS: (f64, f64) = (1040.0, 640.0);
const LAUNCHER_MIN_CSS: (f64, f64) = (640.0, 520.0);
/// The Microsoft sign-in the panel may ask the system browser to open (desktop/login-window.js
/// `isAuthorizeUrl`, src/client-auth.mjs `AUTHORIZE_URL` and `MSA_CLIENT_ID`).
const AUTHORIZE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MSA_CLIENT_ID: &str = "946097b5-241d-4f83-9981-c6d0778e5507";
const CALLBACK_PATH: &str = "/api/client/accounts/login/callback";

/// The window's state: which panel it shows, the interface size, and where windows were.
#[derive(Debug)]
pub struct Shell {
    panel: Mutex<Option<Url>>,
    granted: Mutex<Vec<u16>>,
    setting: Mutex<Setting>,
    zoom: Mutex<f64>,
    display: Mutex<Option<String>>,
    main_state: Tracker,
    launcher_state: Tracker,
    reported: Mutex<Vec<PathBuf>>,
    /// When a window was last signed in again because its page asked.
    signed_in_again: Mutex<Option<std::time::Instant>>,
}

impl Shell {
    pub fn new() -> Self {
        let config = local::config_dir();
        Self {
            panel: Mutex::new(None),
            granted: Mutex::new(Vec::new()),
            setting: Mutex::new(zoom::load(&config.join("ui-zoom.json"))),
            zoom: Mutex::new(1.0),
            display: Mutex::new(None),
            main_state: Tracker::new(config.join("window-state.json")),
            launcher_state: Tracker::new(config.join("launcher-window-state.json")),
            reported: Mutex::new(Vec::new()),
            signed_in_again: Mutex::new(None),
        }
    }

    pub fn panel(&self) -> Option<Url> {
        self.panel.lock().ok()?.clone()
    }

    pub fn panel_addr(&self) -> Option<SocketAddr> {
        let p = self.panel()?;
        Some(SocketAddr::from(([127, 0, 0, 1], p.port()?)))
    }

    fn zoom(&self) -> f64 {
        self.zoom.lock().map_or(1.0, |z| *z)
    }

    fn setting(&self) -> Setting {
        self.setting.lock().map_or(Setting::Auto, |s| *s)
    }

    /// True the first time a finished download is reported (the last 32 are remembered).
    fn first_report(&self, path: &Path) -> bool {
        let Ok(mut seen) = self.reported.lock() else {
            return true;
        };
        if seen.iter().any(|p| p == path) {
            return false;
        }
        if seen.len() >= 32 {
            seen.remove(0);
        }
        seen.push(path.to_path_buf());
        true
    }

    pub fn flush(&self) {
        self.main_state.flush();
        self.launcher_state.flush();
    }
}

/// Scheme, host and port equal to the panel's (paths, queries and fragments are the page's).
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// The window's own start page (`dist/index.html`), shown until the panel answers.
fn is_start_page(url: &Url) -> bool {
    // Windows serves it at http://tauri.localhost; elsewhere that is an ordinary name a local
    // server could answer, and the start page is tauri://localhost
    match url.scheme() {
        "tauri" => !cfg!(windows) && url.host_str() == Some("localhost"),
        "http" | "https" => cfg!(windows) && url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// A page that lost its sign-in moves here to ask for a new one. The panel serves nothing
/// there: the window answers.
const AGAIN_PATH: &str = spawnloft_lib::panel_auth::AGAIN_PATH;

/// Two requests to be signed in again closer together than this are a sign-in that does not
/// hold (the page asks by itself when it finds it has none), and the second is not answered.
const AGAIN_GAP: std::time::Duration = std::time::Duration::from_secs(10);

/// Asked of the window by the start page's "could not start" state, and by a second start of
/// the app that found the main window gone: start the core (again). `main.rs` listens.
pub const RETRY_EVENT: &str = "spawnloft:retry";

/// `Some(to)` when `url` is a panel page asking to be signed in again; `to` is where the page
/// said it was (`/launcher`, `/setup`), when it said.
pub fn sign_in_request(url: &Url, panel: Option<&Url>) -> Option<Option<String>> {
    if !panel.is_some_and(|p| same_origin(url, p)) || url.path() != AGAIN_PATH {
        return None;
    }
    Some(
        url.query_pairs()
            .find(|(k, _)| k == "to")
            .map(|(_, v)| v.into_owned()),
    )
}

/// What a link on the start page's "could not start" state asks of the window.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum StartAction {
    Retry,
    ShowLog,
    Quit,
}

/// The start page has no bridge (it is not the panel), so its buttons are links to itself with
/// `?do=`, and the window reads them as they are followed.
pub fn start_action(url: &Url) -> Option<StartAction> {
    if !is_start_page(url) {
        return None;
    }
    match url.query_pairs().find(|(k, _)| k == "do")?.1.as_ref() {
        "retry" => Some(StartAction::Retry),
        "log" => Some(StartAction::ShowLog),
        "quit" => Some(StartAction::Quit),
        _ => None,
    }
}

/// One sentence for the person, for a reason written for the log.
pub fn failure_words(why: &str) -> &'static str {
    if why.contains("has no core program") {
        "A part of SpawnLoft is missing from this installation. Installing SpawnLoft again will put it back."
    } else if why.contains("did not print its address") {
        "SpawnLoft's background service took too long to start."
    } else if why.contains("keeps stopping") {
        "SpawnLoft's background service keeps stopping."
    } else if why.contains("exited before") || why.contains("did not start") {
        "SpawnLoft's background service did not start."
    } else {
        "SpawnLoft's background service started, but this window could not open its panel."
    }
}

/// The main window says the core could not be started, with Try again, the log and Quit;
/// `false` when there is no main window to say it in.
pub fn show_failure<R: Runtime>(app: &AppHandle<R>, why: &str, log: &Path) -> bool {
    let Some(w) = app.get_webview_window(MAIN) else {
        return false;
    };
    let mut url = start_page();
    url.query_pairs_mut()
        .append_pair("failed", failure_words(why))
        .append_pair("detail", why)
        .append_pair("log", &log.display().to_string());
    w.navigate(url).is_ok()
}

/// The address that signs a window in at the panel: `/auth` with a token that works once.
pub fn login_url<R: Runtime>(app: &AppHandle<R>, to: Option<&str>) -> Result<Url, String> {
    let shell = app.state::<Shell>();
    let (Some(panel), Some(addr)) = (shell.panel(), shell.panel_addr()) else {
        return Err("the panel is not up".into());
    };
    // the key is only ever used to sign; what goes in the address is a token that works once
    let path = spawnloft_lib::panel_auth::load_key()
        .and_then(|key| spawnloft_lib::panel_auth::login_path(&key, addr.port(), to))
        .map_err(|e| format!("could not sign the window in to the panel: {e}"))?;
    panel
        .join(&path)
        .map_err(|e| format!("could not build the panel's address: {e}"))
}

/// A window whose sign-in ran out (the panel's idle time) is signed in again where it was. A
/// console window cannot be: a sign-in lands on the panel or the launcher. It closes, and the
/// main window, which shares the sign-in, comes forward signed in.
fn sign_in_again<R: Runtime>(app: &AppHandle<R>, label: &str, to: Option<&str>) {
    let (target, to) = if label == LAUNCHER {
        (LAUNCHER, Some("/launcher"))
    } else if label == MAIN {
        (MAIN, to)
    } else {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
        (MAIN, None)
    };
    let Some(w) = app.get_webview_window(target) else {
        return reopen_main(app);
    };
    // The page asks by itself, so a sign-in that does not hold would ask for ever: a second
    // request right after the first is told so and not answered.
    let too_soon = app.state::<Shell>().signed_in_again.lock().is_ok_and(|mut last| {
        let soon = last.is_some_and(|at| at.elapsed() < AGAIN_GAP);
        *last = Some(std::time::Instant::now());
        soon
    });
    let made = if too_soon {
        Err("could not sign the window in to the panel: the sign-in did not hold".to_string())
    } else {
        login_url(app, to)
    };
    match made {
        Ok(url) => {
            if let Err(e) = w.navigate(url) {
                local::log(&format!("sign in again: {e}"));
            }
            focus(&w);
        }
        // said in the main window: a link that was followed and did nothing reads as broken
        Err(e) => {
            local::log(&format!("sign in again: {e}"));
            show_failure(app, &e, &local::run_dir().join("panel.log"));
        }
    }
}

/// The main window was closed while a launcher or console window kept the app alive, and the
/// app was started again: build it anew and sign it in.
pub fn reopen_main<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    // off the caller's thread, which has to return before a window can exist
    std::thread::spawn(move || match build_main(&app) {
        Ok(w) => {
            if !app.state::<crate::Core>().is_running() {
                let _ = app.emit(RETRY_EVENT, ());
                return;
            }
            match login_url(&app, None) {
                Ok(url) => {
                    if let Err(e) = w.navigate(url) {
                        local::log(&format!("reopen the main window: {e}"));
                    }
                }
                // No panel to open: a core that is still starting, or one that never came up
                // and said so in the window that has since been closed. Either way it is
                // started over, and opens the panel in this window when it is up.
                Err(e) => {
                    local::log(&format!("reopen the main window: {e}"));
                    let _ = app.emit(RETRY_EVENT, ());
                }
            }
        }
        Err(e) => local::log(&format!("could not reopen the main window: {e}")),
    });
}

/// Every navigation of every window comes through here: the two the window answers itself,
/// then the guard.
fn on_navigation<R: Runtime>(app: &AppHandle<R>, label: &str, url: &Url) -> bool {
    if label == MAIN
        && let Some(action) = start_action(url)
    {
        // Only from the start page itself. On Linux and macOS this is asked for the frames of a
        // page as well, and a frame inside the panel has no business quitting the app.
        let on_start_page = app
            .get_webview_window(MAIN)
            .and_then(|w| w.url().ok())
            .is_some_and(|at| is_start_page(&at));
        if !on_start_page {
            local::log("a start page action asked from another page was refused");
            return false;
        }
        // None of them is followed as a link: an address that restarts the core must not be
        // left in the window's history for Back or Reload to find.
        match action {
            // the core is stopped and started; the window goes to its plain "Starting" state
            StartAction::Retry => {
                let _ = app.emit(RETRY_EVENT, ());
            }
            StartAction::ShowLog => {
                let _ = tauri_plugin_opener::open_path(local::run_dir(), None::<&str>);
            }
            StartAction::Quit => app.exit(0),
        }
        return false;
    }
    if let Some(to) = sign_in_request(url, app.state::<Shell>().panel().as_ref()) {
        let (app, label) = (app.clone(), label.to_string());
        std::thread::spawn(move || sign_in_again(&app, &label, to.as_deref()));
        return false;
    }
    may_navigate(app, url)
}

/// Where a window may go: the panel's origin, the start page, and `about:` frames.
pub fn may_navigate<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    if is_start_page(url) || (url.scheme() == "about" && matches!(url.path(), "blank" | "srcdoc")) {
        return true;
    }
    let ok = app
        .state::<Shell>()
        .panel()
        .is_some_and(|p| same_origin(url, &p) && url.username().is_empty() && url.password().is_none());
    if !ok {
        local::log(&format!("navigation refused: {}", redact(url)));
    }
    ok
}

/// A URL for the log without its query (sign-in codes and file names stay out of it).
fn redact(url: &Url) -> String {
    let mut u = url.clone();
    u.set_query(None);
    u.set_fragment(None);
    u.to_string()
}

/// The panel is up at `url` (`http://127.0.0.1:<port>/`): remember it and grant the bridge to
/// that exact origin. A restarted core has a new port and gets a capability of its own; the old
/// origin stays granted but no window can go there (the guard follows `panel`).
pub fn set_panel<R: Runtime>(app: &AppHandle<R>, url: &Url) -> Result<(), String> {
    let port = url.port().ok_or("the panel address has no port")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err(format!("the panel address is not loopback: {url}"));
    }
    let shell = app.state::<Shell>();
    let fresh = shell.granted.lock().map(|g| !g.contains(&port)).unwrap_or(true);
    if fresh {
        // local as well: right after the window moves from its start page (tauri://localhost) to
        // the panel, webkit2gtk can still name the old origin on the first IPC request, and the
        // ACL then refuses the panel itself. The start page's only script writes the text of a
        // failure the window gave it and calls nothing, and every command checks the window's
        // live URL against the panel (from_panel), so this grants nothing a non-panel page can
        // use.
        let mut cap = CapabilityBuilder::new(format!("panel-{port}"))
            .remote(format!("http://127.0.0.1:{port}"))
            .local(true)
            .windows([MAIN, LAUNCHER, "console-*"]);
        for cmd in COMMANDS {
            cap = cap.permission(format!("allow-{}", cmd.replace('_', "-")));
        }
        app.add_capability(cap).map_err(|e| format!("capability: {e}"))?;
        if let Ok(mut g) = shell.granted.lock() {
            g.push(port);
        }
    }
    if let Ok(mut p) = shell.panel.lock() {
        *p = Some(url.clone());
    }
    Ok(())
}

/// The core has gone: no origin is the panel until the next one prints its address, and the
/// main window shows its start page meanwhile.
pub fn clear_panel<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut p) = app.state::<Shell>().panel.lock() {
        *p = None;
    }
    for (label, w) in app.webview_windows() {
        if label == MAIN {
            let _ = w.navigate(start_page());
        } else {
            let _ = w.close();
        }
    }
}

/// Every command starts here: the webview asking must be showing the panel right now.
fn from_panel<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let shell = webview.state::<Shell>();
    match (shell.panel(), webview.url()) {
        (Some(p), Ok(u)) if same_origin(&p, &u) => Ok(()),
        (_, u) => {
            let at = u.map_or_else(|e| e.to_string(), |u| redact(&u));
            local::log(&format!("bridge refused a call from {at} (not the panel)"));
            Err("not the panel".into())
        }
    }
}

// ---- the commands --------------------------------------------------------------------------

fn short_title(title: Option<String>, fallback: &str) -> String {
    let t: String = title
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect();
    if t.trim().is_empty() {
        fallback.to_string()
    } else {
        t
    }
}

/// An absolute folder, or null when cancelled.
#[tauri::command]
async fn pick_folder<R: Runtime>(
    webview: Webview<R>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    from_panel(&webview)?;
    let dialog = webview
        .dialog()
        .file()
        .set_title(short_title(title, "Choose a folder"))
        .set_parent(&webview.window());
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// A file (world archives first), or null when cancelled. Windows cannot offer files and folders
/// in one native dialog, so the page has a text field for a folder path, as in 1.x.
#[tauri::command]
async fn pick_file<R: Runtime>(webview: Webview<R>, title: Option<String>) -> Result<Option<String>, String> {
    from_panel(&webview)?;
    let dialog = webview
        .dialog()
        .file()
        .set_title(short_title(title, "Choose a file"))
        .add_filter("World archives", &["zip", "gz", "tgz"])
        .add_filter("All files", &["*"])
        .set_parent(&webview.window());
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

fn zoom_reply(shell: &Shell) -> Value {
    json!({ "setting": shell.setting().to_json(), "zoom": shell.zoom() })
}

#[tauri::command]
fn get_zoom<R: Runtime>(webview: Webview<R>) -> Result<Value, String> {
    from_panel(&webview)?;
    Ok(zoom_reply(&webview.state::<Shell>()))
}

/// `'auto'` or a factor; returns `{ setting, zoom }`.
#[tauri::command]
fn set_zoom<R: Runtime>(webview: Webview<R>, value: Value) -> Result<Value, String> {
    from_panel(&webview)?;
    choose_zoom(webview.app_handle(), Setting::from_json(&value));
    Ok(zoom_reply(&webview.state::<Shell>()))
}

/// Ctrl/Cmd with + (1), - (-1) or 0 (0): a fixed choice, stepped from the size on screen.
#[tauri::command]
fn zoom_key<R: Runtime>(webview: Webview<R>, step: i32) -> Result<Value, String> {
    from_panel(&webview)?;
    let shell = webview.state::<Shell>();
    let next = if step == 0 {
        1.0
    } else {
        zoom::step(shell.zoom(), step)
    };
    choose_zoom(webview.app_handle(), Setting::Fixed(next));
    Ok(zoom_reply(&shell))
}

/// https only, so a page can never launch a local program or a `file:`/`ms-settings:` handler.
#[tauri::command]
fn open_external<R: Runtime>(webview: Webview<R>, url: String) -> Result<Value, String> {
    from_panel(&webview)?;
    Ok(json!({ "ok": open_https(&url) }))
}

fn open_https(url: &str) -> bool {
    // the parsed form is what is opened: parsing drops control characters, so the string checked
    // and the string handed to the system are the same
    let Some(parsed) = Url::parse(url).ok().filter(|u| {
        url.len() <= 8192 && u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
    }) else {
        return false;
    };
    if let Err(e) = tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>) {
        local::log(&format!("could not open the browser: {e}"));
        return false;
    }
    true
}

/// A launcher profile's folder in the file manager. The folder comes from the panel, never from
/// the page: the page sends a name, the panel says that profile's folder (it checks the name with
/// its own rule), and it must be a folder. The page learns `ok` and nothing else.
#[tauri::command]
async fn open_profile_folder<R: Runtime>(webview: Webview<R>, name: String) -> Result<Value, String> {
    from_panel(&webview)?;
    let no = Ok(json!({ "ok": false }));
    if name.is_empty() || name.len() > 200 {
        return no;
    }
    let Some(addr) = webview.state::<Shell>().panel_addr() else {
        return no;
    };
    let folder = tauri::async_runtime::spawn_blocking(move || {
        let list = local::panel_get(addr, "/api/client/profiles").ok()?;
        let row = list
            .as_array()?
            .iter()
            .find(|p| p["name"].as_str() == Some(name.as_str()))?;
        let dir = PathBuf::from(row["folder"].as_str()?);
        (dir.is_absolute() && dir.is_dir()).then_some(dir)
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(dir) = folder else { return no };
    Ok(json!({ "ok": tauri_plugin_opener::open_path(&dir, None::<&str>).is_ok() }))
}

/// The authorize URL the panel made for this app, sending the code back to this panel's own port
/// (the core tells the Node panel which, `SPAWNLOFT_PANEL_PUBLIC_PORT`). Anything else is refused.
pub fn is_authorize_url(url: &str, port: u16, client_id: &str) -> bool {
    let Ok(u) = Url::parse(url) else { return false };
    if url.len() > 8192 || !u.username().is_empty() || u.password().is_some() || u.fragment().is_some() {
        return false;
    }
    if format!("{}{}", u.origin().ascii_serialization(), u.path()) != AUTHORIZE_URL {
        return false;
    }
    let one = |key: &str| {
        let all: Vec<String> = u
            .query_pairs()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .collect();
        (all.len() == 1).then(|| all[0].clone())
    };
    one("client_id").as_deref() == Some(client_id)
        && one("response_type").as_deref() == Some("code")
        && one("redirect_uri") == Some(format!("http://localhost:{port}{CALLBACK_PATH}"))
}

/// Microsoft's sign-in in the system browser (installer design section 7, plan step 3): the
/// person's own browser, its saved sign-ins and password manager, and nothing of Microsoft's page
/// inside SpawnLoft. Resolves at once with `external: true`; the outcome reaches the launcher
/// through the panel's login stream when the browser comes back to the callback.
#[tauri::command]
fn open_microsoft_login<R: Runtime>(webview: Webview<R>, url: String) -> Result<Value, String> {
    from_panel(&webview)?;
    let port = webview
        .state::<Shell>()
        .panel()
        .and_then(|p| p.port())
        .unwrap_or(0);
    let client_id =
        spawnloft_lib::paths::env_var("SPAWNLOFT_MSA_CLIENT_ID").unwrap_or_else(|| MSA_CLIENT_ID.to_string());
    if !is_authorize_url(&url, port, &client_id) {
        local::log("refused a sign-in address that is not this panel's Microsoft authorize URL");
        return Ok(json!({ "ok": false }));
    }
    Ok(json!({ "ok": open_https(&url), "external": true }))
}

/// Brings the calling window forward. The Microsoft sign-in happens in the system browser,
/// which is then on top of the launcher that has the answer.
#[tauri::command]
fn focus_window<R: Runtime>(webview: Webview<R>) -> Result<Value, String> {
    from_panel(&webview)?;
    let w = webview.window();
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    Ok(json!({ "ok": true }))
}

/// After the first-run wizard saved new locations: the core reads them only at start.
#[tauri::command]
fn restart_core(webview: Webview) -> Result<Value, String> {
    from_panel(&webview)?;
    let app = webview.app_handle().clone();
    // off this thread: the core takes up to a second to stop, and the page waits for nothing
    std::thread::spawn(move || {
        clear_panel(&app);
        app.state::<crate::Core>().stop();
        crate::start_core(app.clone());
    });
    Ok(json!({ "ok": true }))
}

pub fn start_page() -> Url {
    // what WebviewUrl::App("index.html") resolves to on each platform
    let base = if cfg!(windows) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(base)
        .and_then(|b| b.join("index.html"))
        .unwrap_or_else(|_| Url::parse("about:blank").expect("about:blank"))
}

// ---- zoom ----------------------------------------------------------------------------------

/// The display a window is on, as `(id, logical width, logical height)`.
fn display_of<R: Runtime>(w: &WebviewWindow<R>) -> Option<(String, f64, f64)> {
    let m = w.current_monitor().ok()??;
    let s = m.scale_factor();
    let id = format!("{:?}@{},{}", m.name(), m.position().x, m.position().y);
    Some((id, f64::from(m.size().width) / s, f64::from(m.size().height) / s))
}

fn choose_zoom<R: Runtime>(app: &AppHandle<R>, setting: Setting) {
    let shell = app.state::<Shell>();
    if let Ok(mut s) = shell.setting.lock() {
        *s = setting;
    }
    zoom::save(&local::config_dir().join("ui-zoom.json"), setting);
    apply_zoom(app, true);
}

/// Works out the factor for the main window's display and applies it to every window. Auto
/// follows the window to another monitor; `force` re-applies even when nothing changed.
pub fn apply_zoom<R: Runtime>(app: &AppHandle<R>, force: bool) {
    let shell = app.state::<Shell>();
    let display = app.get_webview_window(MAIN).as_ref().and_then(display_of);
    let moved = {
        let mut d = shell.display.lock().ok();
        let id = display.as_ref().map(|d| d.0.clone());
        let moved = d.as_deref().is_some_and(|cur| *cur != id);
        if let Some(d) = d.as_mut() {
            **d = id;
        }
        moved
    };
    if !force && !(moved && shell.setting() == Setting::Auto) {
        return;
    }
    let z = zoom::resolve(shell.setting(), display.map(|(_, w, h)| (w, h)));
    if let Ok(mut cur) = shell.zoom.lock() {
        *cur = z;
    }
    for w in app.webview_windows().values() {
        let _ = w.set_zoom(z);
    }
}

// ---- windows -------------------------------------------------------------------------------

/// The rules every window gets: the guard, the bridge, downloads, and window.open.
fn panel_window<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let nav = app.clone();
    let nav_label = label.to_string();
    let opener = app.clone();
    let theme_bg = tauri::window::Color(0x0c, 0x0e, 0x14, 0xff);
    WebviewWindowBuilder::new(app, label, url)
        .title("SpawnLoft")
        .background_color(theme_bg)
        .initialization_script(BRIDGE_JS)
        .on_navigation(move |url| on_navigation(&nav, &nav_label, url))
        .on_new_window(move |url, _features| {
            open_requested(&opener, &url);
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| on_download(&webview, event))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let z = webview.state::<Shell>().zoom();
                let _ = webview.set_zoom(z);
            }
        })
}

/// The main window, where the 1.x window was (or centred at the default size).
pub fn build_main<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let areas = winstate::work_areas(app);
    let state = winstate::load(
        &local::config_dir().join("window-state.json"),
        &areas,
        MAIN_DEFAULT,
        MAIN_MIN,
    );
    let mut b = panel_window(app, MAIN, WebviewUrl::App("index.html".into()))
        .inner_size(state.width, state.height)
        .min_inner_size(MAIN_MIN.0, MAIN_MIN.1)
        .maximized(state.maximized);
    b = match state.position {
        Some((x, y)) => b.position(x, y),
        None => b.center(),
    };
    let w = b.build()?;
    apply_zoom(app, true);
    let tracked = w.clone();
    w.on_window_event(move |e| {
        let app = tracked.app_handle();
        match e {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                app.state::<Shell>().main_state.observe(&tracked);
                apply_zoom(app, false);
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                if let Ok(mut d) = app.state::<Shell>().display.lock() {
                    *d = Some(String::new());
                }
                apply_zoom(app, false);
            }
            WindowEvent::CloseRequested { .. } => app.state::<Shell>().main_state.flush(),
            _ => {}
        }
    });
    Ok(w)
}

/// What a `window.open` from a panel page may become (desktop/launcher-window.js `windowKind`):
/// exactly `/launcher`, or `/?console=<name>`; an https address goes to the browser; anything else
/// is refused.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    Launcher,
    Console(String),
    External,
    Refused,
}

pub fn window_kind(url: &Url, panel: Option<&Url>) -> Kind {
    if url.scheme() == "https" {
        return Kind::External;
    }
    let Some(panel) = panel.filter(|p| same_origin(url, p)) else {
        return Kind::Refused;
    };
    let _ = panel;
    if url.fragment().is_some() {
        return Kind::Refused;
    }
    if url.path() == "/launcher" && url.query().is_none() {
        return Kind::Launcher;
    }
    if url.path() == "/"
        && let Some(q) = url.query()
        && let Some(name) = q.strip_prefix("console=")
        && !name.is_empty()
        && name.len() <= 300
        && !name.contains(['&', '#'])
    {
        return Kind::Console(name.to_string());
    }
    Kind::Refused
}

fn open_requested<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    let panel = app.state::<Shell>().panel();
    match window_kind(url, panel.as_ref()) {
        Kind::External => {
            open_https(url.as_str());
        }
        Kind::Refused => local::log(&format!("window.open refused: {}", redact(url))),
        kind => {
            let app = app.clone();
            let url = url.clone();
            // built off the event handler's thread, which has to return before the window exists
            std::thread::spawn(move || {
                if let Err(e) = open_child(&app, kind, url) {
                    local::log(&format!("could not open a window: {e}"));
                }
            });
        }
    }
}

fn focus<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn open_child<R: Runtime>(app: &AppHandle<R>, kind: Kind, url: Url) -> tauri::Result<()> {
    let z = app.state::<Shell>().zoom();
    match kind {
        Kind::Console(name) => {
            // one window per server: the panel opening it again brings it forward
            let label = format!("{CONSOLE_PREFIX}{}", hex(name.as_bytes()));
            if let Some(w) = app.get_webview_window(&label) {
                focus(&w);
                return Ok(());
            }
            panel_window(app, &label, WebviewUrl::External(url))
                .inner_size(980.0, 660.0)
                .min_inner_size(520.0, 360.0)
                .build()?;
        }
        Kind::Launcher => {
            if let Some(w) = app.get_webview_window(LAUNCHER) {
                focus(&w);
                return Ok(());
            }
            // the first size follows the zoom on the panel's screen; after that the saved size wins
            let area = app
                .get_webview_window(MAIN)
                .and_then(|w| w.current_monitor().ok().flatten())
                .map(|m| {
                    let s = m.scale_factor();
                    let a = m.work_area();
                    LogicalSize::new(f64::from(a.size.width) / s, f64::from(a.size.height) / s)
                });
            let (size, min) = launcher_bounds(z, area);
            let state = winstate::load(
                &local::config_dir().join("launcher-window-state.json"),
                &winstate::work_areas(app),
                size,
                min,
            );
            let mut b = panel_window(app, LAUNCHER, WebviewUrl::External(url))
                .title("SpawnLoft Launcher")
                .inner_size(state.width, state.height)
                .min_inner_size(min.0, min.1)
                .maximized(state.maximized);
            if let Some((x, y)) = state.position {
                b = b.position(x, y);
            }
            let w = b.build()?;
            let tracked = w.clone();
            w.on_window_event(move |e| {
                let shell = tracked.state::<Shell>();
                match e {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => shell.launcher_state.observe(&tracked),
                    WindowEvent::CloseRequested { .. } => shell.launcher_state.flush(),
                    _ => {}
                }
            });
        }
        Kind::External | Kind::Refused => {}
    }
    Ok(())
}

/// The launcher's first size and minimum in window pixels for a page at `zoom`, never bigger than
/// the work area (desktop/launcher-window.js `launcherBounds`).
pub fn launcher_bounds(zoom: f64, area: Option<LogicalSize<f64>>) -> ((f64, f64), (f64, f64)) {
    let z = if zoom.is_finite() && zoom > 0.0 { zoom } else { 1.0 };
    let (max_w, max_h) = area.map_or((f64::INFINITY, f64::INFINITY), |a| {
        (a.width.floor(), a.height.floor())
    });
    let fit = |css: f64, max: f64| (css * z).round().min(max);
    (
        (fit(LAUNCHER_CSS.0, max_w), fit(LAUNCHER_CSS.1, max_h)),
        (fit(LAUNCHER_MIN_CSS.0, max_w), fit(LAUNCHER_MIN_CSS.1, max_h)),
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---- downloads -----------------------------------------------------------------------------

/// The panel's export, backup, snapshot and diagnostics links (`a.download`, four sites in
/// ui.html): saved into the Downloads folder under a name that is not taken yet, then shown in
/// the file manager. Only the panel's own files: a download from anywhere else is refused.
fn on_download<R: Runtime>(webview: &Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let panel = webview.state::<Shell>().panel();
            let ours = panel.as_ref().is_some_and(|p| {
                same_origin(&url, p)
                    || (url.scheme() == "blob"
                        && Url::parse(url.path()).is_ok_and(|inner| same_origin(&inner, p)))
            });
            if !ours {
                local::log(&format!("download refused: {}", redact(&url)));
                return false;
            }
            let dir = download_dir(webview);
            let suggested = destination
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "download".into());
            *destination = unique_path(&dir, &safe_file_name(&suggested));
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            // webkit2gtk tells every webview of the app about each download: show it once
            if let Some(p) = &path
                && !webview.state::<Shell>().first_report(p)
            {
                return true;
            }
            match (success, path) {
                (true, Some(p)) => {
                    if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&p) {
                        local::log(&format!("saved {} but could not show it: {e}", p.display()));
                    }
                }
                (ok, p) => local::log(&format!("download finished, success {ok}, {p:?}")),
            }
            true
        }
        _ => true,
    }
}

/// The system's Downloads folder; where there is none configured (no `user-dirs.dirs` on Linux),
/// `~/Downloads` when it exists, then the home folder.
fn download_dir<R: Runtime>(webview: &Webview<R>) -> PathBuf {
    if let Ok(d) = webview.path().download_dir() {
        return d;
    }
    let home = webview.path().home_dir().unwrap_or_else(|_| std::env::temp_dir());
    let d = home.join("Downloads");
    if d.is_dir() { d } else { home }
}

/// A file name with no folder parts and nothing a file system refuses.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = clean.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if clean.is_empty() {
        "download".into()
    } else {
        clean.chars().take(200).collect()
    }
}

/// `dir/name`, or `dir/name (2).ext` and onwards when that is taken.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_window_answers_sign_in_and_start_page_links() {
        let p = u("http://127.0.0.1:4100/");
        assert_eq!(
            sign_in_request(&u("http://127.0.0.1:4100/auth/again"), Some(&p)),
            Some(None)
        );
        assert_eq!(
            sign_in_request(&u("http://127.0.0.1:4100/auth/again?to=/launcher"), Some(&p)),
            Some(Some("/launcher".into()))
        );
        // another port is not the panel, and neither is any other path
        assert_eq!(
            sign_in_request(&u("http://127.0.0.1:4101/auth/again"), Some(&p)),
            None
        );
        assert_eq!(sign_in_request(&u("http://127.0.0.1:4100/auth"), Some(&p)), None);
        assert_eq!(
            sign_in_request(&u("http://127.0.0.1:4100/auth/again"), None),
            None
        );

        let start = start_page();
        let with = |q: &str| {
            let mut s = start.clone();
            s.set_query(Some(q));
            s
        };
        assert_eq!(start_action(&start), None);
        assert_eq!(start_action(&with("do=retry")), Some(StartAction::Retry));
        assert_eq!(start_action(&with("do=log")), Some(StartAction::ShowLog));
        assert_eq!(start_action(&with("do=quit")), Some(StartAction::Quit));
        assert_eq!(start_action(&with("do=format")), None);
        assert_eq!(start_action(&with("failed=x&detail=y")), None);
        // only the start page's own links: a panel page with the same query is a panel page
        assert_eq!(start_action(&u("http://127.0.0.1:4100/?do=quit")), None);
    }

    #[test]
    fn a_failure_is_said_for_a_person() {
        for why in [
            "this installation has no core program (resources/bin)",
            "/opt/x/spawnloft-core did not start: No such file or directory",
            "the core did not print its address within 90 seconds",
            "the core exited before the panel was ready; see panel.log",
            "the core keeps stopping; see panel.log",
            "the core printed a bad address `x`",
            "capability: nope",
        ] {
            let said = failure_words(why);
            assert!(
                !said.contains("core") && !said.contains("panel.log") && !said.contains("capability"),
                "{said}"
            );
            assert!(said.ends_with('.'), "{said}");
        }
        assert_ne!(
            failure_words("the core keeps stopping; see panel.log"),
            failure_words("the core printed a bad address `x`")
        );
    }

    #[test]
    fn window_kinds_are_exact() {
        let p = u("http://127.0.0.1:4100/");
        assert_eq!(
            window_kind(&u("http://127.0.0.1:4100/launcher"), Some(&p)),
            Kind::Launcher
        );
        assert_eq!(
            window_kind(&u("http://127.0.0.1:4100/?console=survival%20world"), Some(&p)),
            Kind::Console("survival%20world".into())
        );
        for bad in [
            "http://127.0.0.1:4100/launcher?x=1",
            "http://127.0.0.1:4100/launcher#play",
            "http://127.0.0.1:4100/launcherx",
            "http://127.0.0.1:4100/?console=a&b=c",
            "http://127.0.0.1:4100/?console=",
            "http://127.0.0.1:4101/launcher",
            "http://localhost:4100/launcher",
            "file:///etc/passwd",
            "http://evil.example/",
        ] {
            assert_eq!(window_kind(&u(bad), Some(&p)), Kind::Refused, "{bad}");
        }
        assert_eq!(window_kind(&u("https://example.com/x"), Some(&p)), Kind::External);
        assert_eq!(
            window_kind(&u("http://127.0.0.1:4100/launcher"), None),
            Kind::Refused
        );
    }

    #[test]
    fn only_this_panels_authorize_url() {
        let good = format!(
            "{AUTHORIZE_URL}?client_id={MSA_CLIENT_ID}&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A4100%2Fapi%2Fclient%2Faccounts%2Flogin%2Fcallback&scope=x&state=s"
        );
        assert!(is_authorize_url(&good, 4100, MSA_CLIENT_ID));
        assert!(!is_authorize_url(&good, 4101, MSA_CLIENT_ID), "another port");
        assert!(!is_authorize_url(&good, 4100, "someone-else"));
        assert!(!is_authorize_url(&format!("{good}#x"), 4100, MSA_CLIENT_ID));
        assert!(!is_authorize_url(
            &format!("{good}&client_id=two"),
            4100,
            MSA_CLIENT_ID
        ));
        assert!(!is_authorize_url(
            &good.replace(
                "login.microsoftonline.com",
                "login.microsoftonline.com.evil.example"
            ),
            4100,
            MSA_CLIENT_ID
        ));
        assert!(!is_authorize_url(
            &good.replace("https://", "https://a:b@"),
            4100,
            MSA_CLIENT_ID
        ));
        assert!(!is_authorize_url(
            &good.replace("response_type=code", "response_type=token"),
            4100,
            MSA_CLIENT_ID
        ));
    }

    #[test]
    fn origins_and_start_pages() {
        let p = u("http://127.0.0.1:4100/");
        assert!(same_origin(&u("http://127.0.0.1:4100/api/x?y#z"), &p));
        assert!(!same_origin(&u("http://127.0.0.1:41000/"), &p));
        assert!(!same_origin(&u("https://127.0.0.1:4100/"), &p));
        assert_eq!(is_start_page(&u("tauri://localhost/index.html")), !cfg!(windows));
        assert_eq!(
            is_start_page(&u("http://tauri.localhost/index.html")),
            cfg!(windows)
        );
        assert!(!is_start_page(&u("http://tauri.localhost.evil.example/")));
    }

    #[test]
    fn download_names() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\x\\a:b.zip"), "a_b.zip");
        assert_eq!(safe_file_name(".."), "download");
        let dir = std::env::temp_dir().join(format!("sl-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("world.zip"), b"").unwrap();
        std::fs::write(dir.join("world (2).zip"), b"").unwrap();
        assert_eq!(unique_path(&dir, "world.zip"), dir.join("world (3).zip"));
        assert_eq!(unique_path(&dir, "other"), dir.join("other"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn launcher_fits_the_screen() {
        assert_eq!(launcher_bounds(1.5, None), ((1560.0, 960.0), (960.0, 780.0)));
        let small = Some(LogicalSize::new(1280.0, 680.0));
        assert_eq!(launcher_bounds(1.5, small), ((1280.0, 680.0), (960.0, 680.0)));
    }
}

#[cfg(test)]
mod manifest {
    #[test]
    fn build_rs_declares_every_bridge_command() {
        let build = include_str!("../build.rs");
        for cmd in super::COMMANDS {
            assert!(
                build.contains(&format!("\"{cmd}\"")),
                "{cmd} missing from build.rs"
            );
        }
        // the list itself, whatever the checkout's line endings
        let list = build
            .split("commands(&[")
            .nth(1)
            .and_then(|r| r.split("])").next())
            .unwrap_or("");
        assert_eq!(list.matches('"').count(), super::COMMANDS.len() * 2);
    }
}
