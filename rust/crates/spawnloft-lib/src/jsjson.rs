//! `JSON.stringify` as the Node core prints it: numbers in JavaScript's form (`25565`, never
//! `25565.0`; `1e+21`), NaN and infinities as `null`, keys in insertion order (serde_json's
//! `preserve_order`), and JavaScript's escapes. Everything the ported commands print or write as
//! JSON goes through here, so a record reads byte for byte as its Node twin.

use serde_json::Value;

use crate::js;

/// What a JSON-reading failure says. The Node core prints V8's own text here; the parity rig
/// evens both out (the declared difference `json-parse-error-text`).
pub const PARSE_ERROR_PREFIX: &str = "JSON parse error: ";

/// `JSON.parse(text)`, strict as JavaScript's is: no byte-order mark, no trailing text. Objects
/// come back with their keys in JavaScript's order (see [`js_order`]).
pub fn parse(text: &str) -> Result<Value, String> {
    let mut v: Value = serde_json::from_str(text).map_err(|e| format!("{PARSE_ERROR_PREFIX}{e}"))?;
    js_order(&mut v);
    Ok(v)
}

/// A key JavaScript treats as an array index: `0`, or digits with no leading zero, below 2^32-1.
pub fn is_index_key(k: &str) -> bool {
    if k.is_empty()
        || k.len() > 10
        || !k.bytes().all(|b| b.is_ascii_digit())
        || (k.len() > 1 && k.starts_with('0'))
    {
        return false;
    }
    k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// Puts every object's keys in the order a JavaScript object keeps them: index-like keys first,
/// ascending, then the rest in insertion order. A server named `10` lists before one named `2`'s
/// neighbour `alpha` in `Object.keys`, and `JSON.stringify` writes them that way.
pub fn js_order(v: &mut Value) {
    match v {
        Value::Array(items) => items.iter_mut().for_each(js_order),
        Value::Object(map) => {
            for (_, child) in map.iter_mut() {
                js_order(child);
            }
            if map.keys().any(|k| is_index_key(k)) {
                let old = std::mem::take(map);
                let (mut idx, rest): (Vec<_>, Vec<_>) = old.into_iter().partition(|(k, _)| is_index_key(k));
                idx.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
                map.extend(idx);
                map.extend(rest);
            }
        }
        _ => {}
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, 2)`.
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value, Some(2), 0);
    out
}

/// A string as a JSON literal, quotes included.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    push_string(&mut out, s);
    out
}

fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A number as `JSON.stringify` prints it.
pub fn number(x: f64) -> String {
    if x.is_finite() {
        js::number_to_string(x)
    } else {
        "null".to_string()
    }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(step) = indent {
        out.push('\n');
        out.push_str(&" ".repeat(step * depth));
    }
}

fn write(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&number(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => push_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                push_string(out, k);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(out, v, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

/// A finite double as a JSON value, or `null` (what `JSON.stringify` makes of NaN).
pub fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_and_escapes_as_javascript_prints_them() {
        let v: Value =
            serde_json::from_str(r#"{"a":25565.0,"b":1e21,"c":-0.0,"d":"x\b\u0001\"\\/é","e":[],"f":{}}"#)
                .unwrap();
        assert_eq!(
            stringify(&v),
            r#"{"a":25565,"b":1e+21,"c":0,"d":"x\b\u0001\"\\/é","e":[],"f":{}}"#
        );
    }

    #[test]
    fn parse_keeps_javascript_key_order() {
        let v = parse(r#"{"alpha":1,"10":2,"2":3,"01":4}"#).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["2", "10", "alpha", "01"]);
        assert!(parse("\u{feff}{}").is_err());
        assert!(parse("{} x").is_err());
    }

    #[test]
    fn pretty_matches_two_space_indent() {
        let v = json!({"version": 1, "instances": {"a": {"port": 1, "list": [1, 2]}}, "e": []});
        assert_eq!(
            stringify_pretty(&v),
            "{\n  \"version\": 1,\n  \"instances\": {\n    \"a\": {\n      \"port\": 1,\n      \"list\": [\n        1,\n        2\n      ]\n    }\n  },\n  \"e\": []\n}"
        );
    }
}
