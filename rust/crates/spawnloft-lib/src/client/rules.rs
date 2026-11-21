//! The rule grammar of Mojang's version files and the argument lists it switches (`currentOs`,
//! `ruleAllows`, `ruleProblems`, `gameArguments`, `jvmArguments`, `nativesLibrarySubdir` and
//! `nativesExtraDirs` of client-meta.mjs). A rule with anything else in it is not understood: it
//! never matches, and `rule_problems` reports it.

use serde_json::{Map, Value};

use super::{nullish, prop};
use crate::failure::Failure;
use crate::js;

/// `currentOs()`: Mojang's OS name, Node's arch name, and `os.release()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Os {
    pub name: String,
    pub arch: String,
    pub version: String,
}

impl Os {
    pub fn new(name: &str, arch: &str, version: &str) -> Os {
        Os {
            name: name.into(),
            arch: arch.into(),
            version: version.into(),
        }
    }
    /// The same machine as another arch (`{ ...os, arch }`).
    pub fn as_arch(&self, arch: &str) -> Os {
        Os {
            arch: arch.into(),
            ..self.clone()
        }
    }
}

/// `currentOs()`.
pub fn current_os() -> Os {
    let name = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    };
    // process.arch's names, with ia32 as Mojang's x86
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        "arm" => "arm",
        "powerpc64" => "ppc64",
        "s390x" => "s390x",
        "riscv64" => "riscv64",
        "loongarch64" => "loong64",
        other => other,
    };
    Os::new(name, arch, &crate::platform::os_release())
}

const RULE_KEYS: [&str; 3] = ["action", "os", "features"];
const OS_RULE_KEYS: [&str; 4] = ["name", "arch", "version", "versionRange"];

/// `Object.keys(v)` for a value that is an object (an array's are its indices).
fn keys(v: &Value) -> Vec<String> {
    match v {
        Value::Object(m) => m.keys().cloned().collect(),
        Value::Array(a) => (0..a.len()).map(|i| i.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `typeof v === 'object'` for a value that is not null.
fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// The leading dotted number of a text, as numbers (`6.8.0-45-generic` is 6, 8, 0).
fn dotted_nums(v: &str) -> Vec<f64> {
    let end = {
        let b = v.as_bytes();
        let mut i = 0;
        let mut last_good = 0;
        while i < b.len() && b[i].is_ascii_digit() {
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            last_good = i;
            if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
                i += 1;
            } else {
                break;
            }
        }
        last_good
    };
    v[..end]
        .split('.')
        .filter(|s| !s.is_empty())
        .map(js::string_to_number)
        .collect()
}

/// `compareDotted(a, b)`: -1, 0 or 1.
pub fn compare_dotted(a: &str, b: &str) -> i32 {
    let x = dotted_nums(a);
    let y = dotted_nums(b);
    for i in 0..x.len().max(y.len()) {
        let d = x.get(i).copied().unwrap_or(0.0) - y.get(i).copied().unwrap_or(0.0);
        if d != 0.0 {
            return if d < 0.0 { -1 } else { 1 };
        }
    }
    0
}

/// `/^\d+(?:\.\d+)*$/`.
fn is_dotted(s: &str) -> bool {
    !s.is_empty()
        && s.split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `ruleProblem(rule)`: why SpawnLoft cannot judge this rule, or `None` when it can.
fn rule_problem(rule: &Value) -> Option<String> {
    if !is_object(Some(rule)) {
        return Some("a rule that is not an object".into());
    }
    if let Some(extra) = keys(rule).into_iter().find(|k| !RULE_KEYS.contains(&k.as_str())) {
        return Some(format!("\"{extra}\""));
    }
    let action = prop(Some(rule), "action");
    if !matches!(action, Some(Value::String(a)) if a == "allow" || a == "disallow") {
        return Some("\"action\"".into());
    }
    if let Some(os) = prop(Some(rule), "os") {
        if !js::truthy(Some(os)) || !is_object(Some(os)) {
            return Some("\"os\"".into());
        }
        if let Some(extra) = keys(os).into_iter().find(|k| !OS_RULE_KEYS.contains(&k.as_str())) {
            return Some(format!("\"os.{extra}\""));
        }
        if let Some(range) = prop(Some(os), "versionRange") {
            // os.release() on macOS is the Darwin kernel version, not the macOS one a range names
            if matches!(prop(Some(os), "name"), Some(Value::String(n)) if n == "osx") {
                return Some("\"os.versionRange\" on macOS".into());
            }
            let bad_value = |k: &str| prop(Some(range), k).is_some_and(|v| !is_dotted(&js::string(Some(v))));
            if !js::truthy(Some(range))
                || !is_object(Some(range))
                || keys(range).iter().any(|k| k != "min" && k != "max")
                || bad_value("min")
                || bad_value("max")
            {
                return Some("\"os.versionRange\"".into());
            }
        }
    }
    if let Some(f) = prop(Some(rule), "features")
        && !matches!(f, Value::Object(_))
    {
        return Some("\"features\"".into());
    }
    None
}

/// `asOnHost(rule, os)`: a range for every OS is judged on a Mac as an osx one would be.
fn as_on_host(rule: &Value, os: &Os) -> Value {
    let r_os = prop(Some(rule), "os");
    if js::truthy(r_os)
        && prop(r_os, "name").is_none()
        && prop(r_os, "versionRange").is_some()
        && os.name == "osx"
        && let (Value::Object(r), Some(Value::Object(o))) = (rule, r_os)
    {
        let mut o = o.clone();
        o.insert("name".into(), Value::String("osx".into()));
        let mut r = r.clone();
        r.insert("os".into(), Value::Object(o));
        return Value::Object(r);
    }
    rule.clone()
}

fn str_is(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::String(x)) if x == s)
}

/// The items of a rules list as `for...of` walks it: an array's items, a text's characters;
/// anything else throws.
fn iterate(v: &Value, what: &str) -> Result<Vec<Value>, Failure> {
    match v {
        Value::Array(a) => Ok(a.clone()),
        Value::String(s) => Ok(s.chars().map(|c| Value::String(c.to_string())).collect()),
        _ => Err(Failure::type_error(format!("{what} is not iterable"))),
    }
}

/// `ruleAllows(rules, { os, features })`.
pub fn rule_allows(rules: Option<&Value>, os: &Os, features: &Map<String, Value>) -> Result<bool, Failure> {
    let Some(rules) = rules.filter(|r| js::truthy(Some(r))) else {
        return Ok(true);
    };
    if matches!(rules, Value::Array(a) if a.is_empty()) {
        return Ok(true);
    }
    let mut result = false;
    for rule in iterate(rules, "rules")? {
        if rule_problem(&as_on_host(&rule, os)).is_some() {
            continue;
        }
        let mut matches = true;
        let r_os = prop(Some(&rule), "os");
        if js::truthy(r_os) {
            let name = prop(r_os, "name");
            if js::truthy(name) && !str_is(name, &os.name) {
                matches = false;
            }
            let arch = prop(r_os, "arch");
            if js::truthy(arch) && !str_is(arch, &os.arch) {
                matches = false;
            }
            let version = prop(r_os, "version");
            if js::truthy(version) {
                // a pattern this side cannot compile is one that does not match, as a throwing
                // RegExp is in Node
                match crate::jsregex::compile(&js::string(version), false) {
                    Ok(re) if re.is_match(&os.version) => {}
                    _ => matches = false,
                }
            }
            let range = prop(r_os, "versionRange");
            if js::truthy(range) {
                if let Some(min) = prop(range, "min")
                    && compare_dotted(&os.version, &js::string(Some(min))) < 0
                {
                    matches = false;
                }
                // max is exclusive, so Mojang's pair of Windows rules split the builds
                if let Some(max) = prop(range, "max")
                    && compare_dotted(&os.version, &js::string(Some(max))) >= 0
                {
                    matches = false;
                }
            }
        }
        if matches && let Some(Value::Object(want)) = prop(Some(&rule), "features") {
            for (key, expected) in want {
                let have = match features.get(key) {
                    v if nullish(v) => Value::Bool(false),
                    v => v.cloned().unwrap_or(Value::Null),
                };
                if !super::strict_eq(Some(&have), Some(expected)) {
                    matches = false;
                    break;
                }
            }
        }
        if matches {
            result = str_is(prop(Some(&rule), "action"), "allow");
        }
    }
    Ok(result)
}

/// `ruleProblems(rules, { os })`: what in the rules for this OS SpawnLoft does not understand.
pub fn rule_problems(rules: Option<&Value>, os: &Os) -> Result<Vec<String>, Failure> {
    let mut found: Vec<String> = Vec::new();
    let Some(rules) = rules.filter(|r| !r.is_null()) else {
        return Ok(found);
    };
    for rule in iterate(rules, "rules ?? []")? {
        let name = prop(prop(Some(&rule), "os"), "name");
        if name.is_some() && !str_is(name, &os.name) {
            continue;
        }
        if let Some(p) = rule_problem(&as_on_host(&rule, os))
            && !found.contains(&p)
        {
            found.push(p);
        }
    }
    Ok(found)
}

/// `flattenArgs(args, ctx)`: the strings, and the values of the objects whose rules allow them.
fn flatten_args(args: Option<&Value>, os: &Os, features: &Map<String, Value>) -> Result<Vec<Value>, Failure> {
    let mut out = Vec::new();
    let Some(args) = args.filter(|a| !a.is_null()) else {
        return Ok(out);
    };
    for arg in iterate(args, "args ?? []")? {
        match &arg {
            Value::String(_) => out.push(arg.clone()),
            Value::Object(_) | Value::Array(_) if rule_allows(prop(Some(&arg), "rules"), os, features)? => {
                match prop(Some(&arg), "value") {
                    Some(v @ Value::String(_)) => out.push(v.clone()),
                    Some(Value::Array(items)) => out.extend(items.iter().cloned()),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn split_space(v: &Value, what: &str) -> Result<Vec<Value>, Failure> {
    match v {
        Value::String(s) => Ok(s.split(' ').map(|p| Value::String(p.into())).collect()),
        _ => Err(Failure::type_error(format!("{what}.split is not a function"))),
    }
}

/// `gameArguments(version, { os, features })`.
pub fn game_arguments(
    version: &Value,
    os: &Os,
    features: &Map<String, Value>,
) -> Result<Vec<Value>, Failure> {
    let arguments = prop(Some(version), "arguments");
    if js::truthy(arguments) {
        return flatten_args(prop(arguments, "game"), os, features);
    }
    let legacy = prop(Some(version), "minecraftArguments");
    if js::truthy(legacy) {
        return split_space(legacy.unwrap_or(&Value::Null), "version.minecraftArguments");
    }
    Ok(Vec::new())
}

/// `jvmArguments(version, { os, features })`. Before 1.13 the file carried none and the launcher
/// supplied these two itself.
pub fn jvm_arguments(version: &Value, os: &Os, features: &Map<String, Value>) -> Result<Vec<Value>, Failure> {
    let arguments = prop(Some(version), "arguments");
    if js::truthy(arguments) {
        return flatten_args(prop(arguments, "jvm"), os, features);
    }
    Ok(
        ["-Djava.library.path=${natives_directory}", "-cp", "${classpath}"]
            .iter()
            .map(|s| Value::String((*s).into()))
            .collect(),
    )
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `(?:[\\/][\w.-]+)+[\\/]?` for the whole of `rest`: its segments, or `None`.
fn segments(rest: &str) -> Option<Vec<&str>> {
    let body = rest
        .strip_suffix(['/', '\\'])
        .filter(|b| !b.is_empty())
        .unwrap_or(rest);
    if !body.starts_with(['/', '\\']) {
        return None;
    }
    let parts: Vec<&str> = body[1..].split(['/', '\\']).collect();
    parts
        .iter()
        .all(|p| !p.is_empty() && p.bytes().all(|b| is_word(b) || b == b'.' || b == b'-'))
        .then_some(parts)
}

const NATIVES_PREFIX: &str = "-Djava.library.path=${natives_directory}";

/// `nativesLibrarySubdir(version, { os })`: the folder under the natives directory that
/// java.library.path names (26.x: `java`), `""` for the directory itself or an odd argument.
pub fn natives_library_subdir(version: &Value, os: &Os) -> Result<String, Failure> {
    let args = jvm_arguments(version, os, &Map::new())?;
    let Some(arg) = args.iter().find_map(|a| match a {
        Value::String(s) if s.starts_with(NATIVES_PREFIX) => Some(s.as_str()),
        _ => None,
    }) else {
        return Ok(String::new());
    };
    let rest = &arg[NATIVES_PREFIX.len()..];
    match segments(rest) {
        Some(parts) if !parts.iter().any(|p| *p == "." || *p == "..") => Ok(parts.join("/")),
        _ => Ok(String::new()),
    }
}

/// `nativesExtraDirs(version, { os })`: the other folders the JVM arguments name under the
/// natives directory, made empty with the natives.
pub fn natives_extra_dirs(version: &Value, os: &Os) -> Result<Vec<String>, Failure> {
    let lib = natives_library_subdir(version, os)?;
    let mut dirs: Vec<String> = Vec::new();
    for arg in jvm_arguments(version, os, &Map::new())? {
        let Value::String(arg) = arg else { continue };
        let Some(after) = arg.strip_prefix("-D") else {
            continue;
        };
        let Some((key, value)) = after.split_once('=') else {
            continue;
        };
        if key.is_empty() || !key.bytes().all(|b| is_word(b) || b == b'.') {
            continue;
        }
        let Some(rest) = value.strip_prefix("${natives_directory}") else {
            continue;
        };
        let Some(parts) = segments(rest) else { continue };
        if parts.iter().any(|p| *p == "." || *p == "..") {
            continue;
        }
        let dir = parts.join("/");
        if dir != lib && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn none() -> Map<String, Value> {
        Map::new()
    }

    #[test]
    fn rules_pick_the_os_and_skip_what_they_cannot_judge() {
        let linux = Os::new("linux", "x64", "6.8.0-45-generic");
        let mac = Os::new("osx", "arm64", "24.1.0");
        let rules = json!([{ "action": "allow" }, { "action": "disallow", "os": { "name": "osx" } }]);
        assert!(rule_allows(Some(&rules), &linux, &none()).unwrap());
        assert!(!rule_allows(Some(&rules), &mac, &none()).unwrap());
        let odd = json!([{ "action": "allow", "os": { "name": "linux", "colour": "x" } }]);
        assert!(!rule_allows(Some(&odd), &linux, &none()).unwrap());
        assert_eq!(rule_problems(Some(&odd), &linux).unwrap(), vec!["\"os.colour\""]);
        let range = json!([{ "action": "allow", "os": { "versionRange": { "min": "10.0.17134" } } }]);
        assert_eq!(
            rule_problems(Some(&range), &mac).unwrap(),
            vec!["\"os.versionRange\" on macOS"]
        );
        let win = Os::new("windows", "x64", "10.0.22631");
        assert!(rule_allows(Some(&range), &win, &none()).unwrap());
        assert!(!rule_allows(Some(&range), &Os::new("windows", "x64", "10.0.17000"), &none()).unwrap());
        let feat = json!([{ "action": "allow", "features": { "is_demo_user": true } }]);
        assert!(!rule_allows(Some(&feat), &linux, &none()).unwrap());
        let mut f = Map::new();
        f.insert("is_demo_user".into(), json!(true));
        assert!(rule_allows(Some(&feat), &linux, &f).unwrap());
        assert!(rule_allows(Some(&json!([])), &linux, &none()).unwrap());
        let ver = json!([{ "action": "allow", "os": { "version": "^6\\." } }]);
        assert!(rule_allows(Some(&ver), &linux, &none()).unwrap());
    }

    #[test]
    fn dotted_compare_and_native_dirs() {
        assert_eq!(compare_dotted("10.0.22631", "10.0.17134"), 1);
        assert_eq!(compare_dotted("6.8.0-45-generic", "6.8"), 0);
        assert_eq!(compare_dotted("x", "1"), -1);
        let os = Os::new("linux", "x64", "6");
        let v = json!({ "arguments": { "jvm": [
            "-Djava.library.path=${natives_directory}/java/",
            "-Djna.tmpdir=${natives_directory}/jna",
            "-Dx=${natives_directory}/../up",
            { "rules": [{ "action": "allow" }], "value": ["-Dio.netty.native.workdir=${natives_directory}\\netty"] }
        ] } });
        assert_eq!(natives_library_subdir(&v, &os).unwrap(), "java");
        assert_eq!(natives_extra_dirs(&v, &os).unwrap(), vec!["jna", "netty"]);
        assert_eq!(natives_library_subdir(&json!({}), &os).unwrap(), "");
        assert_eq!(
            game_arguments(&json!({ "minecraftArguments": "--a b" }), &os, &none()).unwrap(),
            vec![json!("--a"), json!("b")]
        );
    }
}
