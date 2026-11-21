//! `exposure.mjs`: where a server can be joined from, and whether its RCON port is open to the
//! internet. RCON is an unencrypted admin console behind one password, and Minecraft binds it
//! wherever it binds the game. Behind a home router or the Windows firewall that does not matter,
//! so the warning only speaks on Linux with a public address, RCON bound beyond loopback, and no
//! firewall that can be seen. Everything is read without root, so the wording stays at "none was
//! found". Nothing is asked of anything outside this computer.

use serde_json::{Value, json};
use std::path::Path;
use std::sync::LazyLock;

use crate::platform::InterfaceAddress;
use crate::registry::Instance;

/// `os.networkInterfaces()`, as name and addresses.
pub type Interfaces = Vec<(String, Vec<InterfaceAddress>)>;

/// This computer's interfaces.
pub fn interfaces() -> Interfaces {
    crate::platform::network_interfaces()
}

fn octets(address: &str) -> Option<[u32; 4]> {
    let parts: Vec<&str> = address.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u32; 4];
    for (slot, part) in out.iter_mut().zip(&parts) {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
        if *slot > 255 {
            return None;
        }
    }
    Some(out)
}

/// `isPublicIPv4`: routable on the internet: not private, shared, link-local, loopback or
/// reserved.
pub fn is_public_ipv4(address: &str) -> bool {
    let Some([a, b, c, _]) = octets(address) else {
        return false;
    };
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

/// `isPrivateIPv4`: an address a home router hands out.
pub fn is_private_ipv4(address: &str) -> bool {
    let Some([a, b, _, _]) = octets(address) else {
        return false;
    };
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

/// `publicAddresses`.
pub fn public_addresses(interfaces: &Interfaces) -> Vec<String> {
    interfaces
        .iter()
        .flat_map(|(_, list)| list)
        .filter(|e| !e.internal && e.ipv4 && is_public_ipv4(&e.address))
        .map(|e| e.address.clone())
        .collect()
}

// Adapters that software makes for itself: containers, virtual machines, VPN tunnels. They hold
// private addresses too, and nobody on the home network reaches the computer through them.
static VIRTUAL_ADAPTER: LazyLock<regex::Regex> = LazyLock::new(|| {
    crate::jsregex::compile(
        "^(docker|br-|veth|vboxnet|vmnet|virbr|tun|tap|utun|tailscale|wg|zt)|vEthernet|VirtualBox|VMware|Hyper-V|WSL|Tailscale|ZeroTier",
        true,
    )
    .expect("the adapter pattern")
});

/// `lanAddresses`: private addresses on real adapters; a machine whose only network is a
/// virtual one (a server inside a VM) still has those.
pub fn lan_addresses(interfaces: &Interfaces) -> Vec<String> {
    let from = |real_only: bool| -> Vec<String> {
        interfaces
            .iter()
            .filter(|(name, _)| !real_only || !VIRTUAL_ADAPTER.is_match(name))
            .flat_map(|(_, list)| list)
            .filter(|e| !e.internal && e.ipv4 && is_private_ipv4(&e.address))
            .map(|e| e.address.clone())
            .collect()
    };
    let real = from(true);
    if real.is_empty() { from(false) } else { real }
}

/// Line ends as JavaScript's multiline `^` and `$` see them.
fn js_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// `boundAddress`: `server-ip` from server.properties, empty for every interface (Minecraft's
/// default) or when the file cannot be read. Spaces and tabs only around the key, so an empty
/// `server-ip=` never reads the next line as the address.
pub fn bound_address(dir: &str) -> String {
    let Ok(bytes) = std::fs::read(crate::jspath::join(&[dir, "server.properties"])) else {
        return String::new();
    };
    bound_in(&String::from_utf8_lossy(&bytes))
}

/// [`bound_address`] over the file's text.
pub fn bound_in(text: &str) -> String {
    for line in js_lines(text) {
        let rest = line.trim_start_matches([' ', '\t']);
        let Some(rest) = rest.strip_prefix("server-ip") else {
            continue;
        };
        let Some(value) = rest.trim_start_matches([' ', '\t']).strip_prefix('=') else {
            continue;
        };
        return crate::js::trim(value).to_string();
    }
    String::new()
}

fn instance_dir(inst: &Instance) -> String {
    crate::js::string(inst.get("dir"))
}

/// `joinInfo`: the addresses a server answers on, as far as this computer can tell by looking at
/// itself. There is no public address for a computer behind a router: the router has it.
/// `bound` stands in for the registry and server.properties.
pub fn join_info(inst: &Instance, interfaces: &Interfaces, bound: Option<&str>) -> Value {
    let bind = inst.get("bind");
    let raw = match bound {
        Some(b) => b.to_string(),
        None if crate::js::truthy(bind) => crate::js::string(bind),
        None => bound_address(&instance_dir(inst)),
    };
    let trimmed = crate::js::trim(&raw);
    let ip = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed)
        .to_string();
    let everywhere = ip.is_empty() || ip == "0.0.0.0" || ip == "::";
    let loopback_only = !everywhere
        && (ip == "localhost" || ip == "::1" || {
            // /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/: three digits at most, no range check
            let parts: Vec<&str> = ip.split('.').collect();
            parts.len() == 4
                && parts[0] == "127"
                && parts[1..]
                    .iter()
                    .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
        });
    let port = match inst.get("port") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0 && f.is_finite()) => {
            Value::Number(n.clone())
        }
        _ => Value::Null,
    };
    let base = |here: &str| {
        json!({
            "port": port,
            "here": here,
            "loopbackOnly": loopback_only,
            "bindFixed": crate::js::truthy(bind),
        })
    };
    let with = |mut v: Value, extra: Value| {
        if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
            m.extend(e);
        }
        v
    };
    if loopback_only {
        return with(base("localhost"), json!({ "lan": [], "public": [] }));
    }
    let lan = lan_addresses(interfaces);
    let open = public_addresses(interfaces);
    if everywhere {
        return with(base("localhost"), json!({ "lan": lan, "public": open }));
    }
    // told to listen on one address: it answers on that one alone, and not on localhost
    let held = interfaces.iter().flat_map(|(_, l)| l).any(|e| e.address == ip);
    let only_kind = if !held {
        "unknown"
    } else if is_private_ipv4(&ip) {
        "lan"
    } else if open.contains(&ip) {
        "public"
    } else {
        "here"
    };
    let one = |kind: &str| if only_kind == kind { json!([ip]) } else { json!([]) };
    with(
        base(&ip),
        json!({ "only": ip, "onlyKind": only_kind, "lan": one("lan"), "public": one("public") }),
    )
}

/// How a program the firewall check runs is answered: its output, or `None` when it could not
/// run or took longer than five seconds.
pub type Run<'a> = &'a dyn Fn(&str, &[&str]) -> Option<String>;

/// Runs a program with no shell and a five-second limit, as `spawnSync(..., { timeout: 5000 })`.
pub fn run_program(cmd: &str, args: &[&str]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

fn starts_word(line: &str, word: &str) -> bool {
    line.strip_prefix(word)
        .is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

/// `firewallActive`: `Some(true)`, `Some(false)` for none found, or `None` for "could not tell".
/// ufw and firewalld can be read without root; hand-written nftables or iptables rules cannot be
/// listed, so a saved ruleset is a firewall this cannot read, not the lack of one.
pub fn firewall_active(read: &dyn Fn(&str) -> Option<String>, run: Run) -> Option<bool> {
    if let Some(conf) = read("/etc/ufw/ufw.conf") {
        let enabled = js_lines(&conf).any(|line| {
            let t = crate::js::trim(line);
            let Some((key, value)) = t.split_once('=') else {
                return false;
            };
            crate::js::trim(key).eq_ignore_ascii_case("ENABLED")
                && crate::js::trim(value).eq_ignore_ascii_case("yes")
        });
        if enabled {
            return Some(true);
        }
    }
    if run("systemctl", &["is-active", "firewalld"]).is_some_and(|out| crate::js::trim(&out) == "active") {
        return Some(true);
    }
    for file in [
        "/etc/nftables.conf",
        "/etc/iptables/rules.v4",
        "/etc/sysconfig/iptables",
    ] {
        if let Some(text) = read(file)
            && js_lines(&text).any(|line| {
                let t = line.trim_start_matches(crate::js::is_js_space);
                starts_word(t, "table") || starts_word(t, "-A") || starts_word(t, ":INPUT")
            })
        {
            return None;
        }
    }
    Some(false)
}

/// Reads a whole file as text, `None` when it cannot be read.
pub fn read_text(file: &str) -> Option<String> {
    std::fs::read(Path::new(file))
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// What [`rcon_exposure`] is told instead of finding out (the tests' seam).
#[derive(Debug, Default)]
pub struct Seen<'a> {
    pub linux: Option<bool>,
    pub addresses: Option<Vec<String>>,
    /// `Some(None)` is "could not tell".
    pub firewall: Option<Option<bool>>,
    pub bound: Option<&'a str>,
}

/// `rconExposure`: a diagnosis (`{ id, title, advice }`, the shape the panel and doctor show) when
/// the admin console may be open to the internet, else `None`.
pub fn rcon_exposure(inst: &Instance, seen: Seen) -> Option<Value> {
    let linux = seen.linux.unwrap_or(cfg!(target_os = "linux"));
    let rcon_port = inst.get("rcon").and_then(|r| r.get("port"));
    if !linux || !crate::js::truthy(rcon_port) {
        return None;
    }
    let addresses = seen.addresses.unwrap_or_else(|| public_addresses(&interfaces()));
    let first = addresses.first()?;
    let ip = match seen.bound {
        Some(b) => b.to_string(),
        None => bound_address(&instance_dir(inst)),
    };
    if ip == "127.0.0.1" || ip == "localhost" || ip == "::1" {
        return None;
    }
    let wall = seen
        .firewall
        .unwrap_or_else(|| firewall_active(&read_text, &run_program));
    if wall == Some(true) {
        return None;
    }
    let found = if wall.is_none() {
        "A firewall may be in place, but one could not be confirmed."
    } else {
        "No firewall was found."
    };
    let rcon = crate::js::string(rcon_port);
    let game = crate::js::string(inst.get("port"));
    Some(json!({
        "id": "rcon-exposed",
        "title": "The admin console may be open to the internet",
        "advice": format!(
            "This machine has a public address ({first}) and RCON listens on port {rcon} on every interface - \
             Minecraft cannot bind it separately from the game. {found} RCON is unencrypted and guarded only by its password. \
             Block it: sudo ufw allow OpenSSH && sudo ufw allow {game}/tcp && sudo ufw enable \
             (allow SSH first, or enabling the firewall will lock you out)."
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> serde_json::Value {
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test/fixtures/contracts/c1-library.json");
        serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
    }

    fn interfaces_of(v: &Value) -> Interfaces {
        v.as_object()
            .unwrap()
            .iter()
            .map(|(name, list)| {
                let addrs = list
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| InterfaceAddress {
                        address: e["address"].as_str().unwrap().into(),
                        ipv4: e["family"] == "IPv4",
                        internal: e["internal"] == true,
                    })
                    .collect();
                (name.clone(), addrs)
            })
            .collect()
    }

    #[test]
    fn agrees_with_node() {
        let fx = library();
        let fx = &fx["exposure"];
        for c in fx["addresses"].as_array().unwrap() {
            let a = c["address"].as_str().unwrap();
            assert_eq!(Value::Bool(is_public_ipv4(a)), c["public"], "public {a:?}");
            assert_eq!(Value::Bool(is_private_ipv4(a)), c["private"], "private {a:?}");
        }
        for (name, lists) in fx["lists"].as_object().unwrap() {
            let ifaces = interfaces_of(&fx["interfaces"][name]);
            assert_eq!(json!(public_addresses(&ifaces)), lists["public"], "{name}");
            assert_eq!(json!(lan_addresses(&ifaces)), lists["lan"], "{name}");
        }
        for c in fx["joins"].as_array().unwrap() {
            let ifaces = interfaces_of(&fx["interfaces"][c["interfaces"].as_str().unwrap()]);
            let inst = crate::registry::spread("x", &c["inst"]);
            let info = join_info(&inst, &ifaces, c["bound"].as_str());
            assert_eq!(info, c["info"], "{c}");
        }
        for c in fx["rcon"].as_array().unwrap() {
            let seen = &c["seen"];
            let inst = crate::registry::spread("x", &c["inst"]);
            let got = rcon_exposure(
                &inst,
                Seen {
                    linux: Some(seen["platform"] == "linux"),
                    addresses: Some(
                        seen["addresses"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|a| a.as_str().unwrap().to_string())
                            .collect(),
                    ),
                    firewall: Some(seen["firewall"].as_bool()),
                    bound: seen["bound"].as_str(),
                },
            );
            assert_eq!(got.unwrap_or(Value::Null), c["exposure"], "{c}");
        }
        for c in fx["bound"].as_array().unwrap() {
            assert_eq!(
                bound_in(c["text"].as_str().unwrap()),
                c["bound"].as_str().unwrap(),
                "{c}"
            );
        }
        for c in fx["firewall"].as_array().unwrap() {
            let files = c["files"].clone();
            let read = move |f: &str| files.get(f).and_then(Value::as_str).map(String::from);
            let systemctl = c["systemctl"].as_str().map(String::from);
            let run = move |_: &str, _: &[&str]| systemctl.clone();
            assert_eq!(json!(firewall_active(&read, &run)), c["active"], "{c}");
        }
    }

    #[test]
    fn this_computer_lists_its_loopback() {
        let all = interfaces();
        assert!(
            all.iter().flat_map(|(_, l)| l).any(|e| e.internal),
            "no loopback in {all:?}"
        );
    }

    #[test]
    fn bound_reads_only_its_own_line() {
        assert_eq!(bound_in("server-ip=\nserver-port=25565\n"), "");
        assert_eq!(bound_in("motd=x\n \tserver-ip = 10.0.0.5 \r\n"), "10.0.0.5");
        assert_eq!(bound_in("#server-ip=1.2.3.4\n"), "");
        assert_eq!(bound_in("server-ipx=1\nserver-ip=2\n"), "2");
    }

    #[test]
    fn firewall_answers() {
        let none = |_: &str, _: &[&str]| None;
        let active = |_: &str, _: &[&str]| Some("active\n".to_string());
        let files =
            |name: &'static str, text: &'static str| move |f: &str| (f == name).then(|| text.to_string());
        assert_eq!(
            firewall_active(&files("/etc/ufw/ufw.conf", "# x\n ENABLED = YES \n"), &none),
            Some(true)
        );
        assert_eq!(
            firewall_active(&files("/etc/ufw/ufw.conf", "ENABLED=no\n"), &none),
            Some(false)
        );
        assert_eq!(firewall_active(&|_: &str| None, &active), Some(true));
        assert_eq!(
            firewall_active(
                &files("/etc/nftables.conf", "flush ruleset\ntable inet filter {\n"),
                &none
            ),
            None
        );
        assert_eq!(
            firewall_active(
                &files("/etc/iptables/rules.v4", "*filter\n:INPUT ACCEPT\n"),
                &none
            ),
            None
        );
        assert_eq!(
            firewall_active(&files("/etc/nftables.conf", "tables\n"), &none),
            Some(false)
        );
    }
}
