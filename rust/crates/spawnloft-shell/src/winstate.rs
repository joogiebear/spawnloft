//! Where the window opens: a port of `desktop/window-state.js`, reading and writing the same
//! `window-state.json` and `launcher-window-state.json` in `<config>` (installer design section
//! 7), so 2.0 opens where 1.x was closed. Positions and sizes are logical pixels, as Electron's
//! were; a saved position only counts if a grabbable part of the window lands on some display's
//! work area, so an unplugged monitor never leaves the window off screen.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{LogicalPosition, LogicalSize, Runtime, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct State {
    pub width: f64,
    pub height: f64,
    pub position: Option<(f64, f64)>,
    pub maximized: bool,
}

pub fn is_visible_somewhere(b: Rect, displays: &[Rect]) -> bool {
    displays.iter().any(|a| {
        let ox = (b.x + b.width).min(a.x + a.width) - b.x.max(a.x);
        let oy = (b.y + b.height).min(a.y + a.height) - b.y.max(a.y);
        ox > 120.0 && oy > 40.0
    })
}

pub fn load(file: &Path, displays: &[Rect], defaults: (f64, f64), min: (f64, f64)) -> State {
    let fallback = State {
        width: defaults.0,
        height: defaults.1,
        position: None,
        maximized: false,
    };
    let Some(saved) = std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return fallback;
    };
    let num = |k: &str| saved.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
    let width = num("width")
        .filter(|w| *w > 0.0)
        .unwrap_or(defaults.0)
        .round()
        .max(min.0);
    let height = num("height")
        .filter(|h| *h > 0.0)
        .unwrap_or(defaults.1)
        .round()
        .max(min.1);
    let position = match (num("x"), num("y")) {
        (Some(x), Some(y)) => {
            let at = Rect {
                x: x.round(),
                y: y.round(),
                width,
                height,
            };
            is_visible_somewhere(at, displays).then_some((at.x, at.y))
        }
        _ => None,
    };
    State {
        width,
        height,
        position,
        maximized: saved.get("maximized") == Some(&Value::Bool(true)),
    }
}

/// Every display's work area in logical pixels (each divided by its own scale factor).
pub fn work_areas<R: Runtime>(app: &tauri::AppHandle<R>) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let s = m.scale_factor();
            let a = m.work_area();
            Rect {
                x: f64::from(a.position.x) / s,
                y: f64::from(a.position.y) / s,
                width: f64::from(a.size.width) / s,
                height: f64::from(a.size.height) / s,
            }
        })
        .collect()
}

/// Remembers a window's normal bounds as it moves and resizes, and writes them at most every
/// 400 ms and when it closes. While maximised or minimised the last normal bounds are kept, so
/// un-maximising after a restart gives the earlier size back (Electron's getNormalBounds).
#[derive(Debug)]
pub struct Tracker {
    file: PathBuf,
    inner: Mutex<(Option<Rect>, bool, Option<Instant>)>,
}

impl Tracker {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            inner: Mutex::new((None, false, None)),
        }
    }

    pub fn observe<R: Runtime>(&self, w: &WebviewWindow<R>) {
        let maximized = w.is_maximized().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        let Ok(mut g) = self.inner.lock() else { return };
        g.1 = maximized;
        if !maximized
            && !minimized
            && let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor())
        {
            let p: LogicalPosition<f64> = pos.to_logical(scale);
            let s: LogicalSize<f64> = size.to_logical(scale);
            g.0 = Some(Rect {
                x: p.x,
                y: p.y,
                width: s.width,
                height: s.height,
            });
        }
        let due = g.2.is_none_or(|t| t.elapsed() >= Duration::from_millis(400));
        if due {
            g.2 = Some(Instant::now());
            Self::write(&self.file, g.0, g.1);
        }
    }

    pub fn flush(&self) {
        if let Ok(g) = self.inner.lock() {
            Self::write(&self.file, g.0, g.1);
        }
    }

    fn write(file: &Path, rect: Option<Rect>, maximized: bool) {
        let Some(r) = rect else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let state = json!({
            "x": r.x.round(), "y": r.y.round(),
            "width": r.width.round(), "height": r.height.round(),
            "maximized": maximized,
        });
        // losing the position is a smaller problem than failing to close
        let _ = std::fs::write(
            file,
            format!("{}\n", serde_json::to_string_pretty(&state).unwrap_or_default()),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1040.0,
    };

    #[test]
    fn a_position_off_every_display_is_dropped() {
        let dir = std::env::temp_dir().join(format!("sl-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("window-state.json");
        std::fs::write(
            &file,
            r#"{"x":3000,"y":100,"width":1200,"height":700,"maximized":true}"#,
        )
        .unwrap();
        let s = load(&file, &[SCREEN], (1280.0, 820.0), (900.0, 600.0));
        assert_eq!(s.position, None);
        assert!(s.maximized);
        assert_eq!((s.width, s.height), (1200.0, 700.0));

        std::fs::write(&file, r#"{"x":100,"y":50,"width":300,"height":200}"#).unwrap();
        let s = load(&file, &[SCREEN], (1280.0, 820.0), (900.0, 600.0));
        assert_eq!(s.position, Some((100.0, 50.0)));
        assert_eq!((s.width, s.height), (900.0, 600.0), "never below the minimum");

        let s = load(
            &dir.join("missing.json"),
            &[SCREEN],
            (1280.0, 820.0),
            (900.0, 600.0),
        );
        assert_eq!((s.width, s.height, s.position), (1280.0, 820.0, None));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn visibility_needs_a_title_bar_not_a_pixel() {
        let edge = Rect {
            x: 1900.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert!(!is_visible_somewhere(edge, &[SCREEN]));
        let ok = Rect { x: 1700.0, ..edge };
        assert!(is_visible_somewhere(ok, &[SCREEN]));
    }
}
