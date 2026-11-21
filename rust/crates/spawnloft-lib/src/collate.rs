//! The order Node's `String.prototype.localeCompare` gives, for every list the core sorts: servers
//! (`registry.mjs` listAll), profiles, jars, scheduled tasks, plugins, files, worlds and players.
//! Rust has no ICU, so this reproduces ICU's root collation (what Node's `en-US` default gives)
//! for printable ASCII, the alphabet of server names and of nearly every plugin, jar and world
//! name. The rules were worked out against Node and are pinned by two fixtures:
//! `test/fixtures/contracts/ordering.json` (a list in Node's order) and `ordering-pairs.json`
//! (random pairs with Node's answer), both checked by the tests below and by
//! `test/contracts-files.test.mjs` on the Node side.
//!
//! The rules, for printable ASCII:
//!
//! - Every character has a primary weight. Space and punctuation come first, in the CLDR root
//!   order in [`PUNCTUATION`] (ICU's default is "non-ignorable", so they count like letters),
//!   then the digits `0`..`9`, then the letters `a`..`z` with case ignored.
//! - Two strings are compared on the primary weights of all their characters first, left to
//!   right; a string that runs out first is the smaller.
//! - Only when every primary weight is equal does case count (ICU's tertiary level): left to
//!   right, the first position where one string has a lowercase letter and the other an uppercase
//!   one decides, lowercase first. So `ab < aB < Ab < AB`, but `a! > A` (the `!` is primary).
//! - `sensitivity: 'base'` (plugins.mjs, files.mjs) stops after the primary level, so `a` and `A`
//!   compare equal and a stable sort keeps their input order, as JavaScript's does.
//! - `numeric: true` (files.mjs) reads each run of digits as one number: leading zeros do not
//!   count (`01` equals `1`, `1.9 < 1.10`), and a number sorts where a digit would.
//!
//! Declared difference: outside printable ASCII there is no ICU table here. Any other character
//! sorts after every ASCII letter, by code point, with no case folding, and only counts at the
//! primary level. That is deterministic and a total order, but it is not Node's order for
//! accented letters or other scripts (free text in player names, file names, world names).

use std::cmp::Ordering;

/// CLDR root order of ASCII space and punctuation, as Node sorts them, before the digits.
pub const PUNCTUATION: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// The primary level of one collation element: a character's weight, or under `numeric` a whole
/// run of digits.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Primary<'a> {
    Weight(u32),
    // digits with leading zeros taken off ("0" for a run of zeros)
    Number(&'a str),
}

/// One collation element, and whether its character was an uppercase letter (the tertiary level).
#[derive(Clone, Copy)]
struct Element<'a> {
    primary: Primary<'a>,
    upper: bool,
}

const DIGITS_AT: u32 = PUNCTUATION.len() as u32;
const LETTERS_AT: u32 = DIGITS_AT + 10;
// past every ASCII weight; the declared difference above
const OTHER_AT: u32 = LETTERS_AT + 26;

fn weight(c: char) -> u32 {
    if let Some(at) = PUNCTUATION.find(c) {
        return at as u32;
    }
    match c {
        '0'..='9' => DIGITS_AT + (c as u32 - '0' as u32),
        'a'..='z' => LETTERS_AT + (c as u32 - 'a' as u32),
        'A'..='Z' => LETTERS_AT + (c as u32 - 'A' as u32),
        _ => OTHER_AT + c as u32,
    }
}

fn elements(s: &str, numeric: bool) -> Vec<Element<'_>> {
    let mut out = Vec::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        if numeric && c.is_ascii_digit() {
            let mut end = at + 1;
            while let Some(&(next, d)) = chars.peek() {
                if !d.is_ascii_digit() {
                    break;
                }
                end = next + 1;
                chars.next();
            }
            let digits = s[at..end].trim_start_matches('0');
            let number = if digits.is_empty() { "0" } else { digits };
            out.push(Element {
                primary: Primary::Number(number),
                upper: false,
            });
            continue;
        }
        out.push(Element {
            primary: Primary::Weight(weight(c)),
            upper: c.is_ascii_uppercase(),
        });
    }
    out
}

fn compare_primary(a: Primary<'_>, b: Primary<'_>) -> Ordering {
    match (a, b) {
        (Primary::Number(x), Primary::Number(y)) => x.len().cmp(&y.len()).then_with(|| x.cmp(y)),
        // a number sorts where a digit does: after punctuation, before letters
        // (never equal: under numeric every digit is in a number)
        (Primary::Number(_), Primary::Weight(w)) => DIGITS_AT.cmp(&w),
        (Primary::Weight(w), Primary::Number(_)) => w.cmp(&DIGITS_AT),
        (Primary::Weight(x), Primary::Weight(y)) => x.cmp(&y),
    }
}

fn collate(a: &str, b: &str, numeric: bool, base: bool) -> Ordering {
    let (ea, eb) = (elements(a, numeric), elements(b, numeric));
    for (x, y) in ea.iter().zip(&eb) {
        let order = compare_primary(x.primary, y.primary);
        if order != Ordering::Equal {
            return order;
        }
    }
    let order = ea.len().cmp(&eb.len());
    if order != Ordering::Equal || base {
        return order;
    }
    for (x, y) in ea.iter().zip(&eb) {
        let order = x.upper.cmp(&y.upper);
        if order != Ordering::Equal {
            return order;
        }
    }
    Ordering::Equal
}

/// `a.localeCompare(b)`: registry, profiles, jars, tasks, config files, players and worlds.
pub fn compare(a: &str, b: &str) -> Ordering {
    collate(a, b, false, false)
}

/// `a.localeCompare(b, undefined, { sensitivity: 'base' })`: the plugin list (plugins.mjs).
pub fn compare_base(a: &str, b: &str) -> Ordering {
    collate(a, b, false, true)
}

/// `a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })`: the file browser
/// (files.mjs).
pub fn compare_numeric_base(a: &str, b: &str) -> Ordering {
    collate(a, b, true, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(name: &str) -> Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts")
            .join(name);
        let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        serde_json::from_str(&text).expect("fixture JSON")
    }

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .expect("a list")
            .iter()
            .map(|s| s.as_str().expect("a string").to_owned())
            .collect()
    }

    fn by_name(variant: &str) -> fn(&str, &str) -> Ordering {
        match variant {
            "default" => compare,
            "base" => compare_base,
            "numericBase" => compare_numeric_base,
            other => panic!("unknown variant {other}"),
        }
    }

    #[test]
    fn collate_sorts_the_ordering_fixture_as_node_does() {
        let fx = fixture("ordering.json");
        let by_default = strings(&fx["orders"]["default"]);
        for (variant, list) in fx["orders"].as_object().expect("orders") {
            let want = strings(list);
            // the default order from reversed input, so a sort that leaves things as they are
            // proves nothing; the others are a stable sort of the default order, as the fixture
            // was made, so their ties land where JavaScript's stable sort puts them
            let mut got = by_default.clone();
            if variant == "default" {
                got.reverse();
            }
            got.sort_by(|a, b| by_name(variant)(a, b));
            assert_eq!(got, want, "{variant}");
        }
    }

    #[test]
    fn collate_agrees_with_node_on_every_recorded_pair() {
        let fx = fixture("ordering-pairs.json");
        let mut checked = 0;
        for (variant, pairs) in fx["pairs"].as_object().expect("pairs") {
            let cmp = by_name(variant);
            for pair in pairs.as_array().expect("a list") {
                let (a, b) = (pair[0].as_str().expect("a"), pair[1].as_str().expect("b"));
                let want = pair[2].as_i64().expect("sign");
                let got = match cmp(a, b) {
                    Ordering::Less => -1,
                    Ordering::Equal => 0,
                    Ordering::Greater => 1,
                };
                assert_eq!(got, want, "{variant}: {a:?} vs {b:?}");
                checked += 1;
            }
        }
        assert!(checked >= 3000, "only {checked} pairs");
    }

    #[test]
    fn collate_follows_the_rules_in_the_module_comment() {
        assert_eq!(compare("ab", "aB"), Ordering::Less);
        assert_eq!(compare("aB", "Ab"), Ordering::Less);
        assert_eq!(compare("a!", "A"), Ordering::Greater);
        assert_eq!(compare("a_b", "a-b"), Ordering::Less);
        assert_eq!(compare("1.9", "1.10"), Ordering::Greater);
        assert_eq!(compare_numeric_base("1.9", "1.10"), Ordering::Less);
        assert_eq!(compare_numeric_base("01", "1"), Ordering::Equal);
        assert_eq!(compare_base("Survival", "survival"), Ordering::Equal);
        assert_eq!(compare("", "a"), Ordering::Less);
    }

    #[test]
    fn collate_puts_other_characters_after_ascii_in_a_total_order() {
        // the declared difference: after every ASCII letter, by code point
        assert_eq!(compare("z", "é"), Ordering::Less);
        assert_eq!(compare("é", "ö"), Ordering::Less);
        assert_eq!(compare("Zed", "Ölund"), Ordering::Less);
        let mut names = vec!["ö", "Z", "é", "a", "É"];
        names.sort_by(|a, b| compare(a, b));
        assert_eq!(names, ["a", "Z", "É", "é", "ö"]);
    }
}
