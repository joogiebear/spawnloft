//! Test only: `SPAWNLOFT_TEST_ORIGINS`, the map from a download origin to a local fake that lets
//! the parity rig run the real binary with no network (rust/PLAN-CORE-PORT.md section 6.2). The
//! Node core reads the same variable with NODE_ENV=test (`src/test-origins.mjs`); this side reads
//! it only in a build with the `test-hooks` feature, which release packages are built without.
//! Without the feature [`rewrite`] hands every URL back unchanged and the variable is never read.
//!
//! The rules, held by `test/fixtures/contracts/test-origins.json` on both sides: a map is a JSON
//! object of canonical origins (lower-case scheme and host, no default port, nothing after the
//! authority) to origins on this machine; anything else makes the whole variable unusable and
//! every request through it fails. A mapped origin keeps the text after its authority exactly;
//! an unmapped loopback URL passes unchanged; any other URL is refused, never sent.

pub const ORIGINS_ENV: &str = "SPAWNLOFT_TEST_ORIGINS";

/// A parsed map: (origin, replacement) pairs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Origins(Vec<(String, String)>);

struct Parts<'a> {
    host: String,
    origin: String,
    credentials: bool,
    rest: &'a str,
}

/// Splits an http(s) URL the way the WHATWG parser judges its origin: the scheme and host
/// lower-cased, a default port dropped. Hosts are taken as written beyond that (no IDNA), which
/// is all a download constant needs.
fn split(url: &str) -> Result<Parts<'_>, String> {
    let bad = || format!("`{url}` is not an http(s) URL");
    let (scheme, after) = url.split_once("://").ok_or_else(bad)?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => "80",
        "https" => "443",
        _ => return Err(bad()),
    };
    let cut = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (authority, rest) = after.split_at(cut);
    let (credentials, hostport) = match authority.rsplit_once('@') {
        Some((_, h)) => (true, h),
        None => (false, authority),
    };
    // `[::1]:8080`: the port follows the bracket, not the last colon inside it
    let (host, port) = if hostport.starts_with('[') {
        let end = hostport.find(']').ok_or_else(bad)?;
        let (h, p) = hostport.split_at(end + 1);
        (h, p.strip_prefix(':'))
    } else {
        match hostport.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (hostport, None),
        }
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(bad());
    }
    let host = host.to_ascii_lowercase();
    let port = match port {
        None | Some("") => None,
        Some(p) if p.bytes().all(|b| b.is_ascii_digit()) => {
            let n: u32 = p.parse().map_err(|_| bad())?;
            if n > 65535 {
                return Err(bad());
            }
            let n = n.to_string();
            (n != default_port).then_some(n)
        }
        Some(_) => return Err(bad()),
    };
    let origin = match &port {
        Some(p) => format!("{scheme}://{host}:{p}"),
        None => format!("{scheme}://{host}"),
    };
    Ok(Parts {
        host,
        origin,
        credentials,
        rest,
    })
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

/// The map in `text`, or why the variable cannot be used.
pub fn parse(text: &str) -> Result<Origins, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{ORIGINS_ENV} is not JSON: {e}"))?;
    let obj = v
        .as_object()
        .ok_or_else(|| format!("{ORIGINS_ENV} must be a JSON object"))?;
    let mut out = Vec::new();
    for (from, to) in obj {
        let to = to
            .as_str()
            .ok_or_else(|| format!("{ORIGINS_ENV}: {from} -> {to} is not a pair of origins"))?;
        fn canonical(s: &str) -> Option<Parts<'_>> {
            split(s)
                .ok()
                .filter(|p| p.rest.is_empty() && !p.credentials && p.origin == s)
        }
        canonical(from).ok_or_else(|| {
            format!("{ORIGINS_ENV}: {from} is not an origin (scheme://host[:port], nothing after it)")
        })?;
        let t = canonical(to).ok_or_else(|| {
            format!("{ORIGINS_ENV}: {to} is not an origin (scheme://host[:port], nothing after it)")
        })?;
        if !is_loopback(&t.host) {
            return Err(format!("{ORIGINS_ENV}: {to} is not on this machine"));
        }
        out.push((from.clone(), to.to_string()));
    }
    Ok(Origins(out))
}

/// The URL to fetch instead of `url` under `map`, or why the request is refused.
pub fn rewrite_with(map: &Result<Origins, String>, url: &str) -> Result<String, String> {
    let map = map.as_ref().map_err(Clone::clone)?;
    let parts = split(url)?;
    if parts.credentials {
        return Err(format!("{ORIGINS_ENV}: refusing a URL with credentials in it"));
    }
    if let Some((_, to)) = map.0.iter().find(|(from, _)| *from == parts.origin) {
        let sep = if parts.rest.starts_with('/') { "" } else { "/" };
        return Ok(format!("{to}{sep}{}", parts.rest));
    }
    if is_loopback(&parts.host) {
        return Ok(url.to_string());
    }
    Err(format!(
        "{ORIGINS_ENV} has no fake for {}; the request was not sent",
        parts.origin
    ))
}

/// What every request to an outside host calls before it connects (the updater's fetches, the
/// webhook post, and from C1 every download). A client that follows redirects itself follows
/// them without asking again; the rig's fake host refuses to redirect anywhere but its fakes.
/// In a `test-hooks` build with the variable set it returns the URL under the map; otherwise
/// `url` itself.
pub fn rewrite(url: &str) -> Result<String, String> {
    #[cfg(feature = "test-hooks")]
    if let Some(text) = std::env::var_os(ORIGINS_ENV).filter(|v| !v.is_empty()) {
        let map = text
            .into_string()
            .map_err(|_| format!("{ORIGINS_ENV} is not valid UTF-8"))
            .and_then(|t| parse(&t));
        return rewrite_with(&map, url);
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../test/fixtures/contracts/test-origins.json");

    #[test]
    fn every_case_of_the_fixture() {
        let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(f["env"], ORIGINS_ENV);
        let cases = f["cases"].as_array().unwrap();
        assert!(cases.len() > 10);
        for case in cases {
            let map_text = f["maps"][case["map"].as_str().unwrap()].to_string();
            let map = parse(&map_text);
            assert!(map.is_ok(), "{map_text}: {map:?}");
            let url = case["url"].as_str().unwrap();
            let got = rewrite_with(&map, url);
            match case["expect"].as_str() {
                Some(want) => assert_eq!(got.as_deref(), Ok(want), "{url}"),
                None => assert!(got.is_err(), "{url} should be refused, got {got:?}"),
            }
        }
    }

    #[test]
    fn every_bad_map_of_the_fixture_is_refused_whole() {
        let f: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        for bad in f["badMaps"].as_array().unwrap() {
            let text = bad.as_str().unwrap();
            let map = parse(text);
            assert!(map.is_err(), "{text} was accepted");
            // and nothing goes through it, not even a loopback URL
            assert!(rewrite_with(&map, "http://127.0.0.1:1/x").is_err());
        }
    }

    #[cfg(not(feature = "test-hooks"))]
    #[test]
    fn without_test_hooks_the_variable_is_never_read() {
        // the variable may be set for the whole test run; a release build must not care
        assert_eq!(
            rewrite("https://fill.papermc.io/v3/x").as_deref(),
            Ok("https://fill.papermc.io/v3/x")
        );
    }
}
