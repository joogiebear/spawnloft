//! `scrubber`, `hideIps` and `collectSecrets` from mcp-tools.mjs, as a module of their own: the net
//! under everything the MCP server (C9) and the diagnostics bundle send out. Secrets SpawnLoft
//! holds (passwords, webhooks, tokens) become `[redacted]`, and player IPs `[ip hidden]` unless
//! they are asked for. test/fixtures/contracts/c6-library.json holds Node's answers.

use serde_json::Value;

use crate::settings::Layout;

/// `scrubber({ showIps, secrets })(text)`: each secret, longest first, replaced, then the IPs
/// hidden unless `show_ips`.
pub fn scrub(text: &str, show_ips: bool, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            out = out.replace(secret.as_str(), "[redacted]");
        }
    }
    if show_ips { out } else { hide_ips(&out) }
}

/// `scrubber({ showIps })`: a scrubber that reads the secrets afresh on each call, so a changed
/// password is still caught.
pub fn scrubber(layout: &Layout, show_ips: bool) -> impl Fn(&str) -> String + '_ {
    move |text| {
        if text.is_empty() {
            return String::new();
        }
        scrub(text, show_ips, &collect_secrets(layout))
    }
}

fn digit(b: u8) -> bool {
    b.is_ascii_digit()
}

fn hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `(?=:\d{1,5}\b)` at `at`.
fn port_follows(t: &[u8], at: usize) -> bool {
    if t.get(at) != Some(&b':') {
        return false;
    }
    let run = t[at + 1..].iter().take_while(|b| digit(**b)).count();
    // \d{1,5} gives back digits until a word boundary follows; between two digits there is none
    (1..=run.min(5))
        .rev()
        .any(|n| !t.get(at + 1 + n).is_some_and(|b| word(*b)))
}

/// The ends `\d{1,3}(?:\.\d{1,3}){3}` can reach from `at`, in the order a backtracking engine
/// tries them.
fn v4_ends(t: &[u8], at: usize, group: u8, out: &mut Vec<usize>) {
    let run = t[at..].iter().take(3).take_while(|b| digit(**b)).count();
    for n in (1..=run).rev() {
        let end = at + n;
        if group == 3 {
            out.push(end);
        } else if t.get(end) == Some(&b'.') {
            v4_ends(t, end + 1, group + 1, out);
        }
    }
}

/// The ends `(?::[0-9a-fA-F]{0,4}){2,7}` can reach from `at` after `done` repetitions.
fn v6_groups(t: &[u8], at: usize, done: u8, out: &mut Vec<usize>) {
    if done < 7 && t.get(at) == Some(&b':') {
        let run = t[at + 1..].iter().take(4).take_while(|b| hex(**b)).count();
        for n in (0..=run).rev() {
            v6_groups(t, at + 1 + n, done + 1, out);
        }
    }
    if done >= 2 {
        out.push(at);
    }
}

/// Where the IP after the `/` at `slash` ends, as Node's `IP_RE` matches it.
fn ip_end(t: &[u8], slash: usize) -> Option<usize> {
    let at = slash + 1;
    let mut ends = Vec::new();
    v4_ends(t, at, 0, &mut ends);
    if t.get(at) == Some(&b'[') {
        let run = t[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'%'))
            .count();
        if run > 0 && t.get(at + 1 + run) == Some(&b']') {
            ends.push(at + 2 + run);
        }
    }
    let run = t[at..].iter().take(4).take_while(|b| hex(**b)).count();
    for n in (0..=run).rev() {
        v6_groups(t, at + n, 0, &mut ends);
    }
    ends.into_iter().find(|end| port_follows(t, *end))
}

/// `hideIps(text)`: a socket address Java prints (`/203.0.113.5:51234`, `/[2001:db8::1]:51234`,
/// `/2001:db8::1:51234`) loses its address; the port stays.
pub fn hide_ips(text: &str) -> String {
    let t = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < t.len() {
        if t[i] == b'/'
            && let Some(end) = ip_end(t, i)
        {
            out.push_str(&text[copied..i]);
            out.push_str("/[ip hidden]");
            copied = end;
            i = end;
            continue;
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["password", "webhook", "secret", "token"]
        .iter()
        .any(|w| k.contains(w))
}

fn walk(value: &Value, key: &str, found: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if secret_key(key) && crate::text::js_len(s) >= 4 && !found.contains(s) {
                found.push(s.clone());
            }
        }
        Value::Array(a) => {
            for (i, v) in a.iter().enumerate() {
                walk(v, &i.to_string(), found);
            }
        }
        Value::Object(m) => {
            for (k, v) in m {
                walk(v, k, found);
            }
        }
        _ => {}
    }
}

/// `collectSecrets()`: every string of four or more characters under a key that names a password,
/// webhook, secret or token, in the registry, the accounts and each client's state file; longest
/// first, so a secret containing another is not half-replaced. A file that cannot be read hides
/// nothing and stops nothing.
pub fn collect_secrets(layout: &Layout) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(reg) = crate::registry::load(std::path::Path::new(&layout.registry_file)) {
        walk(&reg, "", &mut found);
    }
    let client = crate::client::paths::Paths::new(layout);
    if let Ok(accounts) = crate::client::accounts::load(&client) {
        walk(&Value::Array(accounts), "", &mut found);
    }
    for p in crate::client::profiles::list(&client).unwrap_or_default() {
        let file = client.state_file(&p.name());
        if let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(state) = crate::jsjson::parse(&text)
        {
            walk(&state, "", &mut found);
        }
    }
    // stable, as V8's sort is: secrets of one length keep the order they were found in
    found.sort_by_key(|s| std::cmp::Reverse(crate::text::js_len(s)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_the_addresses_java_prints() {
        assert_eq!(
            hide_ips("Steve[/203.0.113.5:51234] logged in"),
            "Steve[/[ip hidden]:51234] logged in"
        );
        assert_eq!(hide_ips("/[2001:db8::1]:25565"), "/[ip hidden]:25565");
        assert_eq!(hide_ips("from /::1:25565 ok"), "from /[ip hidden]:25565 ok");
        // no port after it, or a path: left alone
        assert_eq!(hide_ips("/1.2.3.4 and /usr/lib"), "/1.2.3.4 and /usr/lib");
        assert_eq!(hide_ips("/1.2.3.4:123456"), "/1.2.3.4:123456");
    }

    #[test]
    fn longest_secret_first() {
        let s = vec!["hunter22".to_string(), "hunter".to_string()];
        assert_eq!(scrub("hunter22 hunter", true, &s), "[redacted] [redacted]");
    }
}
