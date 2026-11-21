//! The Node core's text helpers (`util.mjs`): aligned tables, durations and sizes as people read
//! them. Widths are counted in UTF-16 code units, as JavaScript's `String.length` and `padEnd` do,
//! so a table with non-ASCII paths lines up exactly as the Node core lines it up.

use crate::js;

/// `s.length` in JavaScript.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `table(rows)`: rows[0] is the header; columns two spaces apart, each line's end trimmed.
pub fn table(rows: &[Vec<String>]) -> String {
    let Some(header) = rows.first() else {
        return String::new();
    };
    let widths: Vec<usize> = (0..header.len())
        .map(|i| {
            rows.iter()
                .map(|r| r.get(i).map_or(0, |c| js_len(c)))
                .max()
                .unwrap_or(0)
        })
        .collect();
    rows.iter()
        .map(|r| {
            let line = (0..header.len())
                .map(|i| {
                    let cell = r.get(i).map_or("", String::as_str);
                    let pad = widths[i].saturating_sub(js_len(cell));
                    format!("{cell}{}", " ".repeat(pad))
                })
                .collect::<Vec<_>>()
                .join("  ");
            trim_end_js(&line).to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(js::is_js_space)
}

/// `humanDuration(ms)`: `42s`, `3m 5s`, `2h 10m`, `4d 1h`; `-` for no value.
pub fn human_duration(ms: Option<f64>) -> String {
    let Some(ms) = ms.filter(|m| !m.is_nan()) else {
        return "-".to_string();
    };
    let s = (ms / 1000.0).floor();
    if s < 60.0 {
        return format!("{}s", js::number_to_string(s));
    }
    let m = (s / 60.0).floor();
    if m < 60.0 {
        return format!("{}m {}s", js::number_to_string(m), js::number_to_string(s % 60.0));
    }
    let h = (m / 60.0).floor();
    if h < 24.0 {
        return format!("{}h {}m", js::number_to_string(h), js::number_to_string(m % 60.0));
    }
    format!(
        "{}d {}h",
        js::number_to_string((h / 24.0).floor()),
        js::number_to_string(h % 24.0)
    )
}

/// `humanBytes(n)`: `512 B`, `1.5 KB` ... `TB`; `-` for no value.
pub fn human_bytes(n: Option<f64>) -> String {
    let Some(mut n) = n else {
        return "-".to_string();
    };
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut i = 0;
    while n >= 1024.0 && i < units.len() - 1 {
        n /= 1024.0;
        i += 1;
    }
    format!("{} {}", js::to_fixed(n, if i == 0 { 0 } else { 1 }), units[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tables_pad_by_utf16_length_and_trim() {
        let t = table(&[row(&["NAME", "DIR"]), row(&["a", "/x"]), row(&["😀b", ""])]);
        assert_eq!(t, "NAME  DIR\na     /x\n😀b");
    }

    #[test]
    fn durations_and_sizes() {
        assert_eq!(human_duration(None), "-");
        assert_eq!(human_duration(Some(999.0)), "0s");
        assert_eq!(human_duration(Some(65_000.0)), "1m 5s");
        assert_eq!(human_duration(Some(7_260_000.0)), "2h 1m");
        assert_eq!(human_duration(Some(90_000_000.0)), "1d 1h");
        assert_eq!(human_duration(Some(-5000.0)), "-5s");
        assert_eq!(human_bytes(Some(512.0)), "512 B");
        assert_eq!(human_bytes(Some(1536.0)), "1.5 KB");
        assert_eq!(
            human_bytes(Some(1024.0 * 1024.0 * 1024.0 * 1024.0 * 2048.0)),
            "2048.0 TB"
        );
    }
}
