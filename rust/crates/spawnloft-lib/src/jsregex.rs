//! Run-time patterns in JavaScript's dialect (`logs --grep`, later MCP's `get_logs` and bot
//! scenarios), translated to this crate's syntax with JavaScript's meanings (non-Unicode mode):
//! `\d`, `\w` and `\b` are ASCII, `.` stops at any line terminator, `\s` is JavaScript's set, a
//! stray `{`, `}` or `]` is a literal (Annex B), `\a` is the letter a. What the `regex` crate
//! cannot do at all, lookaround and backreferences, is refused with a clear message: the declared
//! difference `runtime-pattern-syntax` (rust/PLAN-CORE-PORT.md section 3.4).

use regex::Regex;

use crate::diagnose::JS_DOT;

/// Why a pattern does not compile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternError {
    /// Valid JavaScript, but syntax SpawnLoft's core cannot run (lookaround, backreferences).
    Unsupported(&'static str),
    /// Not a valid pattern; the message is one line.
    Invalid(String),
}

/// JavaScript's `\s`, as code-point ranges.
const SPACE: &[(u32, u32)] = &[
    (0x09, 0x0d),
    (0x20, 0x20),
    (0xa0, 0xa0),
    (0x1680, 0x1680),
    (0x2000, 0x200a),
    (0x2028, 0x2029),
    (0x202f, 0x202f),
    (0x205f, 0x205f),
    (0x3000, 0x3000),
    (0xfeff, 0xfeff),
];
const DIGIT: &[(u32, u32)] = &[(0x30, 0x39)];
const WORD: &[(u32, u32)] = &[(0x30, 0x39), (0x41, 0x5a), (0x5f, 0x5f), (0x61, 0x7a)];

/// One piece of a pattern an escape stands for.
enum Atom {
    /// One character, which the ignore-case flag may widen.
    Char(u32),
    /// A set of characters (`\d`, `\W`, ...): closed under ASCII case already.
    Set(&'static [(u32, u32)], bool),
    /// Text passed through as it is (an assertion).
    Raw(&'static str),
}

fn hex(chars: &[char], at: usize, n: usize) -> Option<u32> {
    if at + n > chars.len() {
        return None;
    }
    let s: String = chars[at..at + n].iter().collect();
    if s.chars().all(|c| c.is_ascii_hexdigit()) {
        u32::from_str_radix(&s, 16).ok()
    } else {
        None
    }
}

fn cp(n: u32) -> String {
    format!("\\x{{{n:x}}}")
}

fn ranges_text(ranges: &[(u32, u32)]) -> String {
    ranges
        .iter()
        .map(|&(lo, hi)| {
            if lo == hi {
                cp(lo)
            } else {
                format!("{}-{}", cp(lo), cp(hi))
            }
        })
        .collect()
}

/// A quantifier `{n}`, `{n,}` or `{n,m}` starting at `chars[at] == '{'`: its length.
fn quantifier_len(chars: &[char], at: usize) -> Option<usize> {
    let mut i = at + 1;
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < chars.len() && chars[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > s
    };
    if !digits(&mut i) {
        return None;
    }
    if i < chars.len() && chars[i] == ',' {
        i += 1;
        digits(&mut i);
    }
    (i < chars.len() && chars[i] == '}').then_some(i + 1 - at)
}

/// The capturing groups in a pattern, which decide whether `\1` is a backreference.
fn group_count(chars: &[char]) -> usize {
    let (mut n, mut i, mut in_class) = (0, 0, false);
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '[' => in_class = true,
            ']' => in_class = false,
            '(' if !in_class => {
                let next: String = chars[i + 1..chars.len().min(i + 3)].iter().collect();
                if !next.starts_with('?')
                    || (next.starts_with("?<") && !matches!(chars.get(i + 3), Some('=' | '!')))
                {
                    n += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    n
}

/// The escape at `chars[i] == '\\'` and how many chars it used.
fn escape(chars: &[char], i: usize, in_class: bool) -> Result<(Atom, usize), PatternError> {
    let Some(&c) = chars.get(i + 1) else {
        return Err(PatternError::Invalid("\\ at end of pattern".into()));
    };
    Ok(match c {
        'd' => (Atom::Set(DIGIT, false), 2),
        'D' => (Atom::Set(DIGIT, true), 2),
        'w' => (Atom::Set(WORD, false), 2),
        'W' => (Atom::Set(WORD, true), 2),
        's' => (Atom::Set(SPACE, false), 2),
        'S' => (Atom::Set(SPACE, true), 2),
        'b' if in_class => (Atom::Char(8), 2),
        'b' => (Atom::Raw("(?-u:\\b)"), 2),
        'B' if !in_class => (Atom::Raw("(?-u:\\B)"), 2),
        't' => (Atom::Char(9), 2),
        'n' => (Atom::Char(10), 2),
        'v' => (Atom::Char(11), 2),
        'f' => (Atom::Char(12), 2),
        'r' => (Atom::Char(13), 2),
        '0' if !chars.get(i + 2).is_some_and(char::is_ascii_digit) => (Atom::Char(0), 2),
        '1'..='9'
            if !in_class && {
                let digits: String = chars[i + 1..].iter().take_while(|d| d.is_ascii_digit()).collect();
                digits.parse::<usize>().is_ok_and(|n| n <= group_count(chars))
            } =>
        {
            return Err(PatternError::Unsupported("a backreference"));
        }
        // Annex B: \8 and \9 with no such group are the digits themselves
        '8' | '9' => (Atom::Char(c as u32), 2),
        'k' if !in_class && chars.get(i + 2) == Some(&'<') => {
            return Err(PatternError::Unsupported("a backreference"));
        }
        '0'..='7' => {
            // Annex B legacy octal: up to three digits, at most \377
            let mut n = 0u32;
            let mut used = 1;
            while used <= 3 && chars.get(i + used).is_some_and(|d| ('0'..='7').contains(d)) {
                let next = n * 8 + chars[i + used].to_digit(8).unwrap_or(0);
                if next > 0o377 {
                    break;
                }
                n = next;
                used += 1;
            }
            (Atom::Char(n), used)
        }
        'x' => match hex(chars, i + 2, 2) {
            Some(n) => (Atom::Char(n), 4),
            None => (Atom::Char('x' as u32), 2),
        },
        'u' => match hex(chars, i + 2, 4) {
            Some(n) if (0xd800..0xe000).contains(&n) => {
                return Err(PatternError::Unsupported("a lone surrogate escape"));
            }
            Some(n) => (Atom::Char(n), 6),
            None => (Atom::Char('u' as u32), 2),
        },
        'c' => match chars.get(i + 2) {
            Some(l) if l.is_ascii_alphabetic() => (Atom::Char(u32::from(*l) % 32), 3),
            // Annex B: `\c` not followed by a letter is a backslash and a c
            _ => (Atom::Char('\\' as u32), 1),
        },
        other => (Atom::Char(other as u32), 2),
    })
}

/// JavaScript's other case of `c` under the ignore-case flag without `u`: its upper case when
/// that is one code unit, never crossing from outside ASCII into ASCII (so `ſ` is not `s`, and
/// the Kelvin sign is not `k`); and every lower-case letter whose upper case is `c`.
fn case_mates(c: u32) -> Vec<u32> {
    let Some(ch) = char::from_u32(c) else {
        return vec![c];
    };
    let canon = |x: char| -> u32 {
        let mut up = x.to_uppercase();
        match (up.next(), up.next()) {
            (Some(u), None) if !(x as u32 >= 128 && (u as u32) < 128) && (u as u32) <= 0xffff => u as u32,
            _ => x as u32,
        }
    };
    let target = canon(ch);
    let mut out = vec![c];
    let mut add = |x: u32| {
        if !out.contains(&x) {
            out.push(x);
        }
    };
    add(target);
    if let Some(t) = char::from_u32(target) {
        for l in t.to_lowercase() {
            if canon(l) == target {
                add(l as u32);
            }
        }
    }
    out
}

fn widen(ranges: &[(u32, u32)], ignore_case: bool) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = ranges.to_vec();
    if !ignore_case {
        return out;
    }
    for &(lo, hi) in ranges {
        // ranges are short in practice; a huge one is widened only where ASCII letters lie
        if hi - lo > 0x2000 {
            for (a, b, shift) in [(0x41u32, 0x5au32, 32i64), (0x61, 0x7a, -32)] {
                let (l, h) = (lo.max(a), hi.min(b));
                if l <= h {
                    out.push(((i64::from(l) + shift) as u32, (i64::from(h) + shift) as u32));
                }
            }
            continue;
        }
        for c in lo..=hi {
            for m in case_mates(c) {
                if m != c {
                    out.push((m, m));
                }
            }
        }
    }
    out
}

fn char_text(c: u32, ignore_case: bool) -> String {
    let mates = if ignore_case { case_mates(c) } else { vec![c] };
    if mates.len() == 1 {
        cp(c)
    } else {
        format!("[{}]", mates.iter().map(|&m| cp(m)).collect::<String>())
    }
}

fn set_text(set: &[(u32, u32)], negated: bool) -> String {
    format!("[{}{}]", if negated { "^" } else { "" }, ranges_text(set))
}

/// The pattern in this crate's syntax.
pub fn translate(source: &str, ignore_case: bool) -> Result<String, PatternError> {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut depth = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                let (atom, used) = escape(&chars, i, false)?;
                out.push_str(&match atom {
                    Atom::Char(n) => char_text(n, ignore_case),
                    Atom::Set(set, neg) => set_text(set, neg),
                    Atom::Raw(r) => r.to_string(),
                });
                i += used;
            }
            '.' => {
                out.push_str(JS_DOT);
                i += 1;
            }
            '(' => {
                let rest: String = chars[i..chars.len().min(i + 4)].iter().collect();
                if rest.starts_with("(?=") || rest.starts_with("(?!") {
                    return Err(PatternError::Unsupported("a lookahead"));
                }
                if rest.starts_with("(?<=") || rest.starts_with("(?<!") {
                    return Err(PatternError::Unsupported("a lookbehind"));
                }
                if rest.starts_with("(?") && !rest.starts_with("(?:") && !rest.starts_with("(?<") {
                    return Err(PatternError::Invalid("Invalid group".into()));
                }
                depth += 1;
                if rest.starts_with("(?:") {
                    out.push_str("(?:");
                    i += 3;
                } else if rest.starts_with("(?<") {
                    // a named group: the name up to `>` is copied as it is
                    let end = chars[i..].iter().position(|&c| c == '>').map(|p| i + p);
                    let Some(end) = end else {
                        return Err(PatternError::Invalid("Invalid capture group name".into()));
                    };
                    out.extend(&chars[i..=end]);
                    i = end + 1;
                } else {
                    out.push('(');
                    i += 1;
                }
            }
            ')' => {
                if depth == 0 {
                    return Err(PatternError::Invalid("Unmatched ')'".into()));
                }
                depth -= 1;
                out.push(')');
                i += 1;
            }
            '{' => match quantifier_len(&chars, i) {
                Some(n) => {
                    out.extend(&chars[i..i + n]);
                    i += n;
                }
                None => {
                    out.push_str(&char_text('{' as u32, false));
                    i += 1;
                }
            },
            '}' | ']' => {
                out.push_str(&char_text(c as u32, false));
                i += 1;
            }
            '[' => i = class(&chars, i, ignore_case, &mut out)?,
            '|' | '^' | '$' | '*' | '+' | '?' => {
                out.push(c);
                i += 1;
            }
            other => {
                out.push_str(&char_text(other as u32, ignore_case));
                i += 1;
            }
        }
    }
    if depth != 0 {
        return Err(PatternError::Invalid("Unterminated group".into()));
    }
    Ok(out)
}

/// One member of a class before it is written out.
enum Member {
    Range(u32, u32),
    Set(&'static [(u32, u32)], bool),
}

/// A character class from `chars[at] == '['`; returns the index after its `]`.
fn class(chars: &[char], at: usize, ignore_case: bool, out: &mut String) -> Result<usize, PatternError> {
    let mut i = at + 1;
    let negated = chars.get(i) == Some(&'^');
    if negated {
        i += 1;
    }
    // one atom of the class: a character, or a set from an escape
    let atom = |i: usize| -> Result<(Member, usize), PatternError> {
        if chars[i] == '\\' {
            let (a, used) = escape(chars, i, true)?;
            Ok(match a {
                Atom::Char(n) => (Member::Range(n, n), used),
                Atom::Set(s, neg) => (Member::Set(s, neg), used),
                Atom::Raw(_) => (Member::Range(chars[i + 1] as u32, chars[i + 1] as u32), used),
            })
        } else {
            Ok((Member::Range(chars[i] as u32, chars[i] as u32), 1))
        }
    };
    let mut members: Vec<Member> = Vec::new();
    loop {
        if i >= chars.len() {
            return Err(PatternError::Invalid("Unterminated character class".into()));
        }
        if chars[i] == ']' {
            i += 1;
            break;
        }
        let (first, used) = atom(i)?;
        i += used;
        // a range a-b; Annex B keeps the dash literal next to a set escape
        if i + 1 < chars.len() && chars[i] == '-' && chars[i + 1] != ']' {
            let (second, used2) = atom(i + 1)?;
            match (&first, &second) {
                (Member::Range(lo, _), Member::Range(hi, _)) => {
                    if lo > hi {
                        return Err(PatternError::Invalid(
                            "Range out of order in character class".into(),
                        ));
                    }
                    members.push(Member::Range(*lo, *hi));
                    i += 1 + used2;
                    continue;
                }
                _ => {
                    members.push(first);
                    members.push(Member::Range('-' as u32, '-' as u32));
                    members.push(second);
                    i += 1 + used2;
                    continue;
                }
            }
        }
        members.push(first);
    }
    if members.is_empty() {
        // [] matches nothing and [^] anything
        out.push_str(if negated {
            "[\\x{0}-\\x{10ffff}]"
        } else {
            "[^\\x{0}-\\x{10ffff}]"
        });
        return Ok(i);
    }
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    let mut nested = String::new();
    for m in &members {
        match m {
            Member::Range(lo, hi) => ranges.push((*lo, *hi)),
            Member::Set(set, false) => ranges.extend_from_slice(set),
            Member::Set(set, true) => nested.push_str(&set_text(set, true)),
        }
    }
    let ranges = widen(&ranges, ignore_case);
    out.push('[');
    if negated {
        out.push('^');
    }
    out.push_str(&ranges_text(&ranges));
    out.push_str(&nested);
    out.push(']');
    Ok(i)
}

/// `new RegExp(source, ignoreCase ? 'i' : '')` for this crate.
pub fn compile(source: &str, ignore_case: bool) -> Result<Regex, PatternError> {
    let translated = translate(source, ignore_case)?;
    regex::RegexBuilder::new(&translated)
        .size_limit(1 << 24)
        .build()
        .map_err(|e| {
            // the crate's message is several lines (the pattern, a caret, the error); its last line
            // says what is wrong
            let text = e.to_string();
            let last = text
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            PatternError::Invalid(last.strip_prefix("error: ").unwrap_or(last).to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &str, i: bool, s: &str) -> bool {
        compile(p, i).unwrap().is_match(s)
    }

    #[test]
    fn javascript_meanings() {
        assert!(m("WARN", true, "[x/warn]"));
        assert!(m(r"\d+", false, "a1"));
        assert!(!m(r"\d", false, "\u{663}")); // an Arabic-Indic digit is not \d in JavaScript
        assert!(!m(r"\w", false, "é"));
        assert!(m(r"a.c", false, "abc"));
        assert!(!m(r"a.c", false, "a\rc"));
        assert!(m(r"a{", false, "a{"));
        assert!(m(r"a{2}", false, "aa"));
        assert!(m(r"x]", false, "x]"));
        assert!(m(r"\a", false, "a"));
        assert!(m(r"[\w-]+$", false, "a-b"));
        assert!(m(r"[a-c]", false, "b"));
        assert!(m(r"\u0041", false, "A"));
        assert!(m(r"\x41", false, "A"));
        assert!(m(r"[^]", false, "\n"));
        assert!(!m(r"[]", false, "a"));
        assert!(m(r"\s", false, "\u{feff}"));
        assert!(m(r" ERROR]| WARN]|Exception", false, "x WARN] y"));
        assert!(m(r"a&&b", false, "a&&b"));
        assert!(m(r"[&&]", false, "&"));
        assert!(m(r"\/x", false, "/x"));
        assert!(m(r"(?<n>a)", false, "a"));
    }

    #[test]
    fn agrees_with_node_on_the_pattern_fixture() {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/js-patterns.json");
        let fx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let subjects: Vec<&str> = fx["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        // what the core refuses on purpose though JavaScript runs it (runtime-pattern-syntax)
        let refused_on_purpose = ["\\uD83D"];
        // JavaScript compares UTF-16 units, so a pattern that is a single unit can match half of
        // an emoji; nothing here can split one
        for p in fx["patterns"].as_array().unwrap() {
            let source = p["source"].as_str().unwrap();
            if refused_on_purpose.contains(&source) {
                assert!(
                    matches!(compile(source, true), Err(PatternError::Unsupported(_))),
                    "{source}"
                );
                continue;
            }
            if p["invalid"] == true {
                assert!(compile(source, true).is_err(), "{source} should not compile");
                continue;
            }
            let re = compile(source, true).unwrap_or_else(|e| panic!("{source}: {e:?}"));
            let got: Vec<&str> = subjects.iter().copied().filter(|s| re.is_match(s)).collect();
            let want: Vec<&str> = p["matches"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap())
                .collect();
            assert_eq!(got, want, "/{source}/i");
        }
    }

    #[test]
    fn refusals_and_errors() {
        assert_eq!(
            compile("a(?=b)", false).unwrap_err(),
            PatternError::Unsupported("a lookahead")
        );
        assert_eq!(
            compile("(?<!a)b", false).unwrap_err(),
            PatternError::Unsupported("a lookbehind")
        );
        assert_eq!(
            compile(r"(a)\1", false).unwrap_err(),
            PatternError::Unsupported("a backreference")
        );
        assert!(matches!(compile("(", false), Err(PatternError::Invalid(_))));
        assert!(matches!(compile("a)", false), Err(PatternError::Invalid(_))));
        assert!(matches!(compile("[a", false), Err(PatternError::Invalid(_))));
        assert!(matches!(compile("\\", false), Err(PatternError::Invalid(_))));
        assert!(matches!(compile("*", false), Err(PatternError::Invalid(_))));
    }
}
