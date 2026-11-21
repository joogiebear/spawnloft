//! JavaScript's loose readings of JSON values, so lenient readers of files the Node core writes
//! agree with it: `Boolean(x)`, `String(x)` and `Number(x)`.

use serde_json::Value;

/// `Boolean(value)`; a missing value is `undefined`, so false.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `String(value)` for the shapes a registry holds; a missing value is `"undefined"`.
pub fn string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_text(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| match v {
                Value::Null => String::new(),
                other => string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

fn number_text(n: &serde_json::Number) -> String {
    // JSON.parse reads every number as a double, so a huge integer prints as JavaScript prints it
    number_to_string(n.as_f64().unwrap_or(f64::NAN))
}

/// `Number.prototype.toString()` (ECMA-262 Number::toString with radix 10): the shortest digits
/// that read back as the same double, in plain notation from 1e-6 up to 1e21 and with an exponent
/// outside that.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` is the shortest round-trip form too: "1.2345e-7"
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e >= 0 { format!("+{e}") } else { e.to_string() };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// `Number.prototype.toFixed(digits)`: the exact value of the double rounded half away from zero
/// (Rust's own formatting rounds an exact tie to even, so 1.25 would be "1.2", not "1.3").
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    // the exact expansion, far enough past the cut that the digit after it is the true one
    let long = format!("{:.*}", digits + 40, x.abs());
    let dot = long.find('.').unwrap_or(long.len());
    let keep = dot + if digits > 0 { 1 + digits } else { 0 };
    let next = long
        .as_bytes()
        .get(if digits > 0 { keep } else { dot + 1 })
        .copied()
        .unwrap_or(b'0');
    let mut kept: Vec<u8> = long.as_bytes()[..keep].to_vec();
    if next >= b'5' {
        // add one in the last place, carrying through nines
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            match kept[i] {
                b'.' => continue,
                b'9' => kept[i] = b'0',
                d => {
                    kept[i] = d + 1;
                    break;
                }
            }
        }
    }
    let body = String::from_utf8(kept).unwrap_or_default();
    // (-0.04).toFixed(1) is "-0.0"; (-0).toFixed(1) is "0.0"
    if x < 0.0 { format!("-{body}") } else { body }
}

/// JavaScript's whitespace and line terminators (`String.prototype.trim`).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `str.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number(text)` (ECMA-262 StringToNumber): blank is 0; `0x`, `0o` and `0b` integers;
/// `Infinity` with an optional sign; decimal literals; NaN for anything else.
pub fn string_to_number(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |rest: &str, base: u32| -> f64 {
        if rest.is_empty() || !rest.chars().all(|c| c.is_digit(base)) {
            return f64::NAN;
        }
        rest.chars().fold(0f64, |acc, c| {
            acc * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
        })
    };
    let lower2 = t.get(..2).map(str::to_ascii_lowercase);
    match lower2.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // digits [. digits] [e [+-] digits], at least one mantissa digit
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut mantissa_digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        mantissa_digits += i - f;
    }
    if mantissa_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    // Rust takes "1." and ".5" as JavaScript does; a bare "." was refused above
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)`, NaN when it is not a number.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => match items.as_slice() {
            // Number([]) is 0 and Number([x]) is Number(String(x))
            [] => 0.0,
            [one] => string_to_number(&string(Some(one))),
            _ => f64::NAN,
        },
        Some(_) => f64::NAN,
    }
}

/// A positive number from an environment variable, like `Number(process.env.X) > 0 ? ... : fallback`.
pub fn positive_env(names: &[&str]) -> Option<f64> {
    for name in names {
        if let Ok(v) = std::env::var(name)
            && !v.is_empty()
        {
            let n = number(Some(&Value::String(v)));
            return if n > 0.0 { Some(n) } else { None };
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truthiness() {
        assert!(!truthy(None));
        assert!(!truthy(Some(&json!(null))));
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("false"))));
        assert!(truthy(Some(&json!(1))));
        assert!(truthy(Some(&json!({}))));
    }

    #[test]
    fn strings() {
        assert_eq!(string(None), "undefined");
        assert_eq!(string(Some(&json!(4))), "4");
        assert_eq!(string(Some(&json!(4.5))), "4.5");
        assert_eq!(string(Some(&json!("4G"))), "4G");
    }

    #[test]
    fn number_text_matches_javascript() {
        for (x, want) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (-2.5, "-2.5"),
            (12345678901234567890.0, "12345678901234567000"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_string(x), want, "{x}");
        }
    }

    #[test]
    fn to_fixed_rounds_ties_up() {
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.35, 1), "1.4"); // 1.35 is below the tie as a double
        assert_eq!(to_fixed(1.45, 1), "1.4");
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-2.5, 0), "-3");
        assert_eq!(to_fixed(-0.0, 1), "0.0");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(12.0, 1), "12.0");
        assert_eq!(to_fixed(1023.95, 1), "1024.0");
    }

    #[test]
    fn strings_to_numbers() {
        for (s, want) in [
            ("", 0.0),
            ("  ", 0.0),
            (" 5 ", 5.0),
            ("0x10", 16.0),
            ("0B11", 3.0),
            ("1e2", 100.0),
            ("1.", 1.0),
            (".5", 0.5),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(string_to_number(s), want, "{s:?}");
        }
        for s in [
            "abc", "true", ".", "1e", "inf", "nan", "infinity", "-0x10", "1_000", "0x",
        ] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
    }

    #[test]
    fn agrees_with_node_on_the_number_fixture() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/js-numbers.json");
        let fx: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        for c in fx["parse"].as_array().unwrap() {
            let text = c["text"].as_str().unwrap();
            assert_eq!(
                number_to_string(string_to_number(text)),
                c["value"].as_str().unwrap(),
                "Number({text:?})"
            );
        }
        for c in fx["print"].as_array().unwrap() {
            let n = c["n"].as_f64().unwrap();
            assert_eq!(number_to_string(n), c["text"].as_str().unwrap(), "String({n})");
            assert_eq!(to_fixed(n, 1), c["fixed1"].as_str().unwrap(), "({n}).toFixed(1)");
            assert_eq!(to_fixed(n, 0), c["fixed0"].as_str().unwrap(), "({n}).toFixed(0)");
        }
    }

    #[test]
    fn numbers() {
        assert_eq!(number(Some(&json!("1500"))), 1500.0);
        assert!(number(Some(&json!("x"))).is_nan());
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(90000))), 90000.0);
    }
}
