//! `args.mjs` by hand (rust/PLAN-CORE-PORT.md rule 8): `--key value` (the next argument unless it
//! starts with `-`), `--key=value`, `--two-words` as `twoWords`, `--no-thing` as `thing: false`,
//! `-x [value]`, and `--` making the rest positional. Flag handling is part of the CLI contract,
//! so this is a transcription, not a parser of its own.

use spawnloft_lib::jsjson::is_index_key;

/// `BOOLEAN_FLAGS`: flags that never take the next argument as their value.
pub const BOOLEAN_FLAGS: &[&str] = &[
    "json",
    // `<command> --help` never takes the next argument (`start --help survival` names no server)
    "help",
    "h",
    "csv",
    "follow",
    "f",
    "thorough",
    "setAsidePrivateCopies",
    "yes",
    "force",
    "purge",
    "all",
    "drop",
    "check",
    "raw",
    "unstable",
    "offline",
    "acceptEula",
    "withWorlds",
    "wipePlugins",
    "data",
    "detach",
    "wait",
    "sync",
    "open",
    "flush",
    "onLogon",
    "showIps",
    "allowDestructive",
    "harness",
    "latest",
    "launcher",
    "exitWithStdin",
    "link",
    "snapshots",
];

/// A flag's value: text, or `true`/`false` with none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Flag {
    Text(String),
    Bool(bool),
}

impl Flag {
    /// JavaScript truthiness of the value.
    pub fn truthy(&self) -> bool {
        match self {
            Flag::Text(s) => !s.is_empty(),
            Flag::Bool(b) => *b,
        }
    }
    /// `Number(value)`.
    pub fn number(&self) -> f64 {
        match self {
            Flag::Text(s) => spawnloft_lib::js::string_to_number(s),
            Flag::Bool(b) => f64::from(u8::from(*b)),
        }
    }
    /// `String(value)`.
    pub fn text(&self) -> String {
        match self {
            Flag::Text(s) => s.clone(),
            Flag::Bool(b) => b.to_string(),
        }
    }
}

/// What `parseArgs` returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    flags: Vec<(String, Flag)>,
    pub positional: Vec<String>,
}

impl Parsed {
    fn set(&mut self, key: String, value: Flag) {
        match self.flags.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.flags.push((key, value)),
        }
    }
    pub fn get(&self, key: &str) -> Option<&Flag> {
        self.flags.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    /// `Object.keys(flags)`: index-like keys first, ascending, then the rest as given.
    pub fn keys(&self) -> Vec<&str> {
        let mut idx: Vec<&str> = self
            .flags
            .iter()
            .map(|(k, _)| k.as_str())
            .filter(|k| is_index_key(k))
            .collect();
        idx.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
        idx.extend(
            self.flags
                .iter()
                .map(|(k, _)| k.as_str())
                .filter(|k| !is_index_key(k)),
        );
        idx
    }
}

/// `-x` to `X`: `rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())`.
fn camel(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-'
            && let Some(&n) = chars.peek()
            && n.is_ascii_lowercase()
        {
            out.push(n.to_ascii_uppercase());
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

fn takes_next(argv: &[String], i: usize) -> bool {
    argv.get(i + 1)
        .is_some_and(|n| !n.is_empty() && !n.starts_with('-'))
}

/// `parseArgs(argv, { booleanFlags: BOOLEAN_FLAGS })`.
pub fn parse(argv: &[String]) -> Parsed {
    let mut out = Parsed::default();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--" {
            out.positional.extend(argv[i + 1..].iter().cloned());
            break;
        }
        if let Some(body) = arg.strip_prefix("--") {
            let (raw, inline) = match body.split_once('=') {
                Some((k, v)) => (k, Some(v)),
                None => (body, None),
            };
            let key = camel(raw);
            if let Some(v) = inline {
                out.set(key, Flag::Text(v.to_string()));
            } else if let Some(neg) = raw.strip_prefix("no-") {
                out.set(camel(neg), Flag::Bool(false));
            } else if BOOLEAN_FLAGS.contains(&key.as_str()) {
                out.set(key, Flag::Bool(true));
            } else if takes_next(argv, i) {
                i += 1;
                out.set(key, Flag::Text(argv[i].clone()));
            } else {
                out.set(key, Flag::Bool(true));
            }
        } else if arg.len() == 2 && arg.starts_with('-') && arg.as_bytes()[1].is_ascii_alphabetic() {
            let key = arg[1..].to_string();
            if BOOLEAN_FLAGS.contains(&key.as_str()) {
                out.set(key, Flag::Bool(true));
            } else if takes_next(argv, i) {
                i += 1;
                out.set(key, Flag::Text(argv[i].clone()));
            } else {
                out.set(key, Flag::Bool(true));
            }
        } else {
            out.positional.push(arg.clone());
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(list: &[&str]) -> Parsed {
        parse(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn the_cases_of_args_test_mjs() {
        let a = p(&[
            "alpha",
            "--memory",
            "4G",
            "--accept-eula",
            "--no-sync",
            "-n",
            "5",
            "--port=25566",
        ]);
        assert_eq!(a.positional, ["alpha"]);
        assert_eq!(a.get("memory"), Some(&Flag::Text("4G".into())));
        assert_eq!(a.get("acceptEula"), Some(&Flag::Bool(true)));
        assert_eq!(a.get("sync"), Some(&Flag::Bool(false)));
        assert_eq!(a.get("n"), Some(&Flag::Text("5".into())));
        assert_eq!(a.get("port"), Some(&Flag::Text("25566".into())));
        // a boolean flag never eats the next argument
        let b = p(&["--json", "alpha"]);
        assert_eq!(b.positional, ["alpha"]);
        // a value that starts with a dash is not taken
        let c = p(&["-n", "-1"]);
        assert_eq!(c.get("n"), Some(&Flag::Bool(true)));
        assert_eq!(c.positional, ["-1"]);
        // an empty next argument is falsy, so not taken either
        let d = p(&["-n", ""]);
        assert_eq!(d.get("n"), Some(&Flag::Bool(true)));
        assert_eq!(d.positional, [""]);
        let e = p(&["--grep=a=b", "--", "--json", "x"]);
        assert_eq!(e.get("grep"), Some(&Flag::Text("a=b".into())));
        assert_eq!(e.positional, ["--json", "x"]);
        // -1 is not a short flag: one letter only
        assert_eq!(p(&["-12"]).positional, ["-12"]);
        assert_eq!(p(&["--no-json=x"]).get("noJson"), Some(&Flag::Text("x".into())));
        assert_eq!(p(&["--b", "1", "--2", "x", "--a"]).keys(), ["2", "b", "a"]);
    }
}
