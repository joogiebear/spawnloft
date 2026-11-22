//! `appearance.mjs`: the application theme, kept in settings.json apart from the data locations
//! so a palette change can never touch where the data lives.

use serde_json::Value;

use crate::failure::Failure;
use crate::settings;

pub const THEMES: [&str; 2] = ["classic", "spawnloft"];

/// `normalizeTheme(value)`: older settings files have no theme, and an unknown value must not
/// become an arbitrary HTML attribute.
pub fn normalize_theme(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("spawnloft") => "spawnloft",
        _ => "classic",
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
        assert_eq!(normalize_theme(None), "classic");
        assert_eq!(normalize_theme(Some(&json!("spawnloft"))), "spawnloft");
        for odd in [
            json!("\"><script>"),
            json!(1),
            json!(null),
            json!(["spawnloft"]),
            json!("Spawnloft"),
        ] {
            assert_eq!(normalize_theme(Some(&odd)), "classic", "{odd}");
        }
    }
}
