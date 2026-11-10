//! The public keys an update feed may be signed with (INSTALLER-UPDATER-DESIGN.md 5.3, 5.4).
//!
//! One minisign key pair signs every artifact and the envelope of a release. Two slots ship in
//! every build, the release key and a pre-generated "next" key, so a rotation (a release signed
//! with "next" that lists a new "next") needs no flag day; a key is retired by shipping a build
//! without it. The envelope's `keyId` names the key that signed it and is the minisign key id
//! (the 16 hex digits minisign prints), so it can be checked against the signature's own key id.
//!
//! The list is fixed at compile time. CI test builds override it through `SPAWNLOFT_UPDATE_PUBKEYS`
//! (`<id>=<key line>[,<id>=<key line>]`, read by build.rs) so a throwaway key made in the job can
//! sign the test feed; a release build never sets it and ships the keys below.

/// One trust anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedKey {
    /// minisign key id, 16 upper-case hex digits; what the envelope's `keyId` must say.
    pub id: String,
    /// The minisign public key line (`RWQ...`, 56 characters).
    pub key: String,
    /// When the key entered the list (documentation only).
    pub from: &'static str,
}

/// The keys Victor generated on his Windows signing machine on 2026-11-09 (`tauri signer
/// generate`); the private halves never left it. `release` signs today; `next` is sealed away
/// for the first rotation.
const RELEASE_KEYS: [(&str, &str, &str); 2] = [
    (
        "1D6FA7724F159315",
        "RWQVkxVPcqdvHbvBfjZVJEFH+NZIDDnnOEzIFpjLDcgnbP0ex5p7+VJd",
        "2026-11-09 release",
    ),
    (
        "FABC42A3EFD78DF4",
        "RWT0jdfvo0K8+m+bIp/B0qgqssh1oaByYs30Vjtilc6fzKHiyBkwnTeI",
        "2026-11-09 next",
    ),
];

/// The compiled-in override, when the build set one.
const OVERRIDE: Option<&str> = option_env!("SPAWNLOFT_UPDATE_PUBKEYS");

/// Whether this build trusts a key list other than the release one (shown by `update status`).
pub fn is_overridden() -> bool {
    OVERRIDE.is_some_and(|s| !s.trim().is_empty())
}

/// The keys this build trusts.
pub fn trusted() -> Vec<TrustedKey> {
    match OVERRIDE {
        Some(list) if !list.trim().is_empty() => parse_override(list).unwrap_or_else(|why| {
            // a build whose override is malformed must not fall back to trusting anything
            panic!("SPAWNLOFT_UPDATE_PUBKEYS is malformed: {why}")
        }),
        _ => RELEASE_KEYS
            .iter()
            .map(|(id, key, from)| TrustedKey {
                id: (*id).to_string(),
                key: (*key).to_string(),
                from,
            })
            .collect(),
    }
}

/// `<id>=<key line>[,<id>=<key line>]`.
pub fn parse_override(list: &str) -> Result<Vec<TrustedKey>, String> {
    let mut out = Vec::new();
    for item in list.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let Some((id, key)) = item.split_once('=') else {
            return Err(format!("`{item}` is not <id>=<key>"));
        };
        let (id, key) = (id.trim().to_ascii_uppercase(), key.trim().to_string());
        if id.len() != 16 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("key id `{id}` is not 16 hex digits"));
        }
        if !is_key_line(&key) {
            return Err(format!("`{key}` is not a minisign public key line"));
        }
        if out.iter().any(|k: &TrustedKey| k.id == id) {
            return Err(format!("key id {id} is listed twice"));
        }
        out.push(TrustedKey {
            id,
            key,
            from: "build override",
        });
    }
    if out.is_empty() {
        return Err("no keys".to_string());
    }
    Ok(out)
}

/// A minisign public key line: 42 bytes (`Ed`, 8-byte key id, 32-byte key) in base64.
pub fn is_key_line(line: &str) -> bool {
    line.len() == 56
        && line.starts_with("RW")
        && line
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

impl TrustedKey {
    /// The key id minisign derives from the key line (little-endian bytes 2..10, printed as
    /// upper-case hex), to check the list's `id` against the key itself.
    pub fn id_from_key(&self) -> Option<String> {
        let raw = super::base64::decode(&self.key).ok()?;
        if raw.len() != 42 || &raw[..2] != b"Ed" {
            return None;
        }
        Some(raw[2..10].iter().rev().map(|b| format!("{b:02X}")).collect())
    }

    /// The form `tauri-plugin-updater` takes as `pubkey`: the whole `.pub` file, base64 encoded.
    pub fn plugin_pubkey(&self) -> String {
        super::base64::encode(
            format!(
                "untrusted comment: minisign public key: {}\n{}\n",
                self.id, self.key
            )
            .as_bytes(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_keys_are_well_formed_and_their_ids_match() {
        for (id, key, _) in RELEASE_KEYS {
            let k = TrustedKey {
                id: id.to_string(),
                key: key.to_string(),
                from: "",
            };
            assert!(is_key_line(key), "{key}");
            assert_eq!(k.id_from_key().as_deref(), Some(id), "{key}");
            minisign_verify::PublicKey::from_base64(key).expect("decodes");
        }
    }

    #[test]
    fn plugin_pubkey_is_the_pub_file_base64() {
        let k = TrustedKey {
            id: RELEASE_KEYS[0].0.to_string(),
            key: RELEASE_KEYS[0].1.to_string(),
            from: "",
        };
        // what `Get-Content spawnloft-updater.key.pub` printed on Victor's machine
        assert_eq!(
            k.plugin_pubkey(),
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDFENkZBNzcyNEYxNTkzMTUKUldRVmt4VlBjcWR2SGJ2QmZqWlZKRUZIK05aSUREbm5PRXpJRnBqTERjZ25iUDBleDVwNytWSmQK"
        );
    }

    #[test]
    fn override_syntax() {
        let list = format!(
            "{}={}, {}={}",
            RELEASE_KEYS[0].0, RELEASE_KEYS[0].1, RELEASE_KEYS[1].0, RELEASE_KEYS[1].1
        );
        let keys = parse_override(&list).unwrap();
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[1].id, RELEASE_KEYS[1].0);
        assert!(parse_override("").is_err());
        assert!(parse_override("abc").is_err());
        assert!(parse_override("1234=RWQ").is_err());
        assert!(parse_override(&format!("{list},{}", list.split(',').next().unwrap())).is_err());
    }
}
