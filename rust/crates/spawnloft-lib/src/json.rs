//! The little JSON the skeleton writes, without a dependency. `serde_json` replaces this when the
//! daemon needs to read JSON as well.

/// `value` as a JSON string literal, quotes included.
pub fn string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::string;

    #[test]
    fn escapes_what_json_requires() {
        assert_eq!(string("plain"), "\"plain\"");
        assert_eq!(string("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(string("line\nnext\ttab"), "\"line\\nnext\\ttab\"");
        assert_eq!(string("\u{1}"), "\"\\u0001\"");
        assert_eq!(string("ünïcode"), "\"ünïcode\"");
    }
}
