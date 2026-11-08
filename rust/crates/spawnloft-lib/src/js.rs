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
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f.fract() == 0.0 && f.abs() < 1e21 {
        format!("{f:.0}")
    } else {
        f.to_string()
    }
}

/// `Number(value)`, NaN when it is not a number.
pub fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
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
    fn numbers() {
        assert_eq!(number(Some(&json!("1500"))), 1500.0);
        assert!(number(Some(&json!("x"))).is_nan());
        assert!(number(None).is_nan());
        assert_eq!(number(Some(&json!(90000))), 90000.0);
    }
}
