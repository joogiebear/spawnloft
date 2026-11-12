//! The interface size (Preferences > Interface size, Ctrl/Cmd with + - 0): a port of
//! `desktop/ui-zoom.js`, with the same steps, the same Auto table and the same file, so a size
//! chosen in 1.x is the size 2.0 opens at (installer design section 7: `<config>/ui-zoom.json`).

use std::path::Path;

use serde_json::{Value, json};

/// Steps instead of free scaling: each one is a size a person can name.
pub const STEPS: [f64; 8] = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// What was chosen: Auto (a step picked from the display the window is on) or a step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Setting {
    Auto,
    Fixed(f64),
}

impl Setting {
    pub fn to_json(self) -> Value {
        match self {
            Setting::Auto => json!("auto"),
            Setting::Fixed(z) => json!(z),
        }
    }

    /// `"auto"`, or a number snapped to the nearest step; anything else is 100%.
    pub fn from_json(v: &Value) -> Setting {
        match v {
            Value::String(s) if s == "auto" => Setting::Auto,
            Value::Number(n) => Setting::Fixed(clamp(n.as_f64().unwrap_or(1.0))),
            Value::String(s) => Setting::Fixed(clamp(s.trim().parse().unwrap_or(1.0))),
            _ => Setting::Fixed(1.0),
        }
    }
}

/// The nearest step (ties keep the earlier, as `reduce` does in ui-zoom.js); not finite is 100%.
pub fn clamp(n: f64) -> f64 {
    if !n.is_finite() {
        return 1.0;
    }
    STEPS.iter().copied().fold(
        1.0,
        |best, s| if (s - n).abs() < (best - n).abs() { s } else { best },
    )
}

/// The step for a display, from its size in logical (device-independent) pixels, so the OS's
/// own scaling is already taken out: a 4K monitor at OS 150% reads 2560 wide.
pub fn auto_step(width: f64, height: f64) -> f64 {
    const TABLE: [(f64, f64); 3] = [(3400.0, 1.75), (2800.0, 1.5), (2400.0, 1.25)];
    if let Some((_, z)) = TABLE.iter().find(|(min, _)| width >= *min) {
        return *z;
    }
    if height > 0.0 && height < 800.0 {
        return 0.9;
    }
    1.0
}

pub fn resolve(setting: Setting, display: Option<(f64, f64)>) -> f64 {
    match setting {
        Setting::Auto => display.map_or(1.0, |(w, h)| auto_step(w, h)),
        Setting::Fixed(z) => clamp(z),
    }
}

/// One step up (+1) or down (-1) from the size on screen, so Auto at 125% goes to 150%.
pub fn step(current: f64, direction: i32) -> f64 {
    let at = STEPS.iter().position(|s| *s == clamp(current)).unwrap_or(2) as i64;
    let next = (at + i64::from(direction.signum())).clamp(0, STEPS.len() as i64 - 1);
    STEPS[next as usize]
}

/// No file means the size was never chosen: Auto. A file from before Auto holds a number and
/// keeps it.
pub fn load(file: &Path) -> Setting {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("zoom").cloned())
        .map_or(Setting::Auto, |z| Setting::from_json(&z))
}

pub fn save(file: &Path, setting: Setting) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // an unsaved size is a smaller problem than an error on every keypress
    let _ = std::fs::write(file, format!("{}\n", json!({ "zoom": setting.to_json() })));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ui_zoom_js() {
        assert_eq!(clamp(1.3), 1.25);
        assert_eq!(clamp(f64::NAN), 1.0);
        assert_eq!(clamp(9.0), 2.0);
        assert_eq!(auto_step(3840.0, 2160.0), 1.75);
        assert_eq!(auto_step(3072.0, 1728.0), 1.5);
        assert_eq!(auto_step(2560.0, 1440.0), 1.25);
        assert_eq!(auto_step(1920.0, 1080.0), 1.0);
        assert_eq!(auto_step(1366.0, 768.0), 0.9);
        assert_eq!(step(1.25, 1), 1.5);
        assert_eq!(step(2.0, 1), 2.0);
        assert_eq!(step(0.8, -1), 0.8);
        assert_eq!(Setting::from_json(&json!("auto")), Setting::Auto);
        assert_eq!(Setting::from_json(&json!(1.12)), Setting::Fixed(1.1));
        assert_eq!(Setting::from_json(&json!(null)), Setting::Fixed(1.0));
    }

    #[test]
    fn file_round_trip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("sl-zoom-{}", std::process::id()));
        let file = dir.join("ui-zoom.json");
        let _ = std::fs::remove_file(&file);
        assert_eq!(load(&file), Setting::Auto);
        save(&file, Setting::Fixed(1.5));
        assert_eq!(load(&file), Setting::Fixed(1.5));
        // what 1.x wrote
        std::fs::write(&file, "{\"zoom\":\"auto\"}\n").unwrap();
        assert_eq!(load(&file), Setting::Auto);
        let _ = std::fs::remove_dir_all(dir);
    }
}
