//! `appearance.mjs`: the application theme, kept in settings.json apart from the data locations
//! so a palette change can never touch where the data lives.

use serde_json::Value;

use crate::failure::Failure;
use crate::settings;

pub const THEMES: [&str; 2] = ["classic", "spawnloft"];

/// The look a settings file with no theme opens in: SpawnLoft's own, the website's lime
/// (docs/ux-ui-plan-2026-11/PLAN.md section 11). Classic is kept for whoever chose it.
pub const DEFAULT_THEME: &str = "spawnloft";

/// `normalizeTheme(value)`: a settings file with no theme opens in the default look, and an
/// unknown value must not become an arbitrary HTML attribute.
pub fn normalize_theme(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("classic") => "classic",
        _ => DEFAULT_THEME,
    }
}

/// `readTheme()`.
pub fn read_theme() -> &'static str {
    normalize_theme(settings::load().0.get("theme"))
}

/// `saveTheme(value)`.
pub fn save_theme(value: Option<&Value>) -> Result<&'static str, Failure> {
    let theme = match value.and_then(Value::as_str) {
        Some("classic") => "classic",
        Some("spawnloft") => "spawnloft",
        _ => {
            return Err(Failure::user(
                "Choose Classic or SpawnLoft for the application theme.",
            ));
        }
    };
    settings::save(&[("theme", Value::String(theme.into()))], false)?;
    Ok(theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_two_themes_are_ever_a_theme() {
        assert_eq!(normalize_theme(None), "spawnloft");
        assert_eq!(normalize_theme(Some(&json!("spawnloft"))), "spawnloft");
        // a saved choice of Classic is kept
        assert_eq!(normalize_theme(Some(&json!("classic"))), "classic");
        for odd in [
            json!("\"><script>"),
            json!(1),
            json!(null),
            json!(["spawnloft"]),
            json!("Spawnloft"),
        ] {
            assert_eq!(normalize_theme(Some(&odd)), "spawnloft", "{odd}");
        }
    }
}
