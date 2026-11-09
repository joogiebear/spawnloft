//! `spawnloft-updates.json` and its signature (INSTALLER-UPDATER-DESIGN.md 5.3).
//!
//! The signature is checked on the raw bytes before anything in them is read, against the key
//! list of [`super::keys`], and the signature's trusted comment is checked against the payload so
//! a signature cannot be moved between files or versions. Only then is the JSON parsed, field by
//! field into a fresh struct; nothing of the parsed value is kept by reference and unknown keys
//! are ignored. Every refusal has a short code for `update.log`.
//!
//! The signature file is what `tauri signer sign --app-version <version> spawnloft-updates.json`
//! writes: a minisign signature (prehashed, as every minisign since 0.6) whose trusted comment is
//! `timestamp:<unix>\tfile:spawnloft-updates.json\tversion:<version>`, the whole file base64
//! encoded, exactly like the `.sig` of an artifact. The Tauri CLI has no flag for a custom trusted
//! comment (checked in tauri-cli 2.12.4 `signer/sign.rs`), so the binding uses its `file:` and
//! `version:` fields; nothing else is needed, because `channel` is inside the signed payload.

use std::collections::BTreeMap;
use std::fmt;

use semver::Version;
use serde_json::Value;

use super::keys::TrustedKey;

/// The largest envelope the client reads; a release lists a handful of platforms.
pub const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
/// The largest signature file: a minisign signature is about 300 bytes before base64.
pub const MAX_SIGNATURE_BYTES: usize = 1024;
/// The largest artifact an envelope may name; the download is capped at the named size.
pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
/// The envelope schema this client understands.
pub const FORMAT: u64 = 1;
/// The product every envelope must name.
pub const PRODUCT: &str = "spawnloft";
/// The envelope's file name, as the trusted comment must name it.
pub const FILE_NAME: &str = "spawnloft-updates.json";

/// Stable only, or stable plus betas (the 1.x rule: `update-channel.json`, a prerelease build
/// defaults to beta).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }

    pub fn parse(s: &str) -> Option<Channel> {
        match s {
            "stable" => Some(Channel::Stable),
            "beta" => Some(Channel::Beta),
            _ => None,
        }
    }

    /// The channel a release is published on: stable for a version without a prerelease, beta
    /// for `beta.N`; `next`, `internal`, `spike` and anything else belong to no channel.
    pub fn of(v: &Version) -> Option<Channel> {
        if v.pre.is_empty() {
            Some(Channel::Stable)
        } else if v.pre.as_str().split('.').next() == Some("beta") {
            Some(Channel::Beta)
        } else {
            None
        }
    }

    /// Whether a release version is offered on this channel: stable takes stable releases; beta
    /// takes stable and beta releases (a beta user is moved to the stable that follows).
    pub fn accepts(self, v: &Version) -> bool {
        if v.pre.is_empty() {
            return true;
        }
        match self {
            Channel::Stable => false,
            Channel::Beta => v.pre.as_str().split('.').next() == Some("beta"),
        }
    }
}

/// One artifact of a release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEntry {
    pub url: String,
    pub size: u64,
    /// Lower-case hex, 128 digits.
    pub sha512: String,
    /// The artifact's minisign signature in Tauri's form (base64 of the `.sig` file); the
    /// Linux packages have none (the package manager installs them).
    pub signature: Option<String>,
}

/// A verified envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub key_id: String,
    pub channel: Channel,
    pub version: Version,
    pub tag: String,
    /// `generatedAt` as written and as seconds since the epoch.
    pub generated_at: String,
    pub generated_at_secs: i64,
    pub expires_at_secs: Option<i64>,
    pub notes: Option<String>,
    pub min_version: Version,
    pub data_format: u32,
    pub platforms: BTreeMap<String, PlatformEntry>,
}

/// Why an envelope was not accepted. `code()` is the word that goes into `update.log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    TooLarge,
    SignatureFormat(String),
    Signature,
    KeyId { signed_by: String, claimed: String },
    TrustedComment(String),
    Json(String),
    Field(String),
    Product(String),
    Format(u64),
    Channel { wanted: Channel, got: String },
    Tag { tag: String, version: String },
    Url(String),
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::TooLarge => "too-large",
            Refusal::SignatureFormat(_) => "signature-format",
            Refusal::Signature => "signature",
            Refusal::KeyId { .. } => "key-id",
            Refusal::TrustedComment(_) => "trusted-comment",
            Refusal::Json(_) => "json",
            Refusal::Field(_) => "field",
            Refusal::Product(_) => "product",
            Refusal::Format(_) => "format",
            Refusal::Channel { .. } => "channel",
            Refusal::Tag { .. } => "tag",
            Refusal::Url(_) => "url",
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Refusal::TooLarge => write!(f, "the feed is larger than an update feed can be"),
            Refusal::SignatureFormat(why) => {
                write!(f, "the signature file is not a minisign signature: {why}")
            }
            Refusal::Signature => write!(
                f,
                "the signature does not verify with any key this SpawnLoft trusts"
            ),
            Refusal::KeyId { signed_by, claimed } => write!(
                f,
                "the feed says it was signed by key {claimed} but the signature is from key {signed_by}"
            ),
            Refusal::TrustedComment(why) => write!(f, "the signature does not belong to this feed: {why}"),
            Refusal::Json(why) => write!(f, "the feed is not JSON: {why}"),
            Refusal::Field(why) => write!(f, "the feed is malformed: {why}"),
            Refusal::Product(p) => write!(f, "the feed is for `{p}`, not SpawnLoft"),
            Refusal::Format(n) => write!(f, "the feed uses format {n}, which this SpawnLoft does not read"),
            Refusal::Channel { wanted, got } => {
                write!(f, "the feed is for the {got} channel, not {}", wanted.as_str())
            }
            Refusal::Tag { tag, version } => {
                write!(f, "the feed's tag {tag} does not name its version {version}")
            }
            Refusal::Url(u) => write!(f, "an artifact URL is not under the release it belongs to: {u}"),
        }
    }
}

/// What the caller knows the envelope must say.
#[derive(Debug, Clone, Copy)]
pub struct Expect<'a> {
    pub channel: Channel,
    /// The release download prefix every artifact URL must start with, followed by `<tag>/`
    /// (`https://github.com/joogiebear/spawnloft/releases/download/`).
    pub download_base: &'a str,
}

/// Verifies `sig_b64` over `bytes` with one of `keys`, then parses and checks the payload.
pub fn verify(
    bytes: &[u8],
    sig_b64: &str,
    keys: &[TrustedKey],
    expect: Expect<'_>,
) -> Result<Envelope, Refusal> {
    if bytes.len() > MAX_ENVELOPE_BYTES || sig_b64.len() > MAX_SIGNATURE_BYTES {
        return Err(Refusal::TooLarge);
    }
    let (signature, signer) = verify_signature(bytes, sig_b64, keys)?;
    let envelope = parse(bytes, expect)?;
    if envelope.key_id != signer.id {
        return Err(Refusal::KeyId {
            signed_by: signer.id.clone(),
            claimed: envelope.key_id,
        });
    }
    check_trusted_comment(signature.trusted_comment(), FILE_NAME, &envelope.version)?;
    Ok(envelope)
}

/// The minisign check alone: which trusted key signed `bytes`. The signature's key id is matched
/// by minisign-verify itself, so only the key it names is tried; `allow_legacy` is off because
/// every signer in use writes prehashed signatures.
pub fn verify_signature<'k>(
    bytes: &[u8],
    sig_b64: &str,
    keys: &'k [TrustedKey],
) -> Result<(minisign_verify::Signature, &'k TrustedKey), Refusal> {
    let sig_text = super::base64::decode(sig_b64)
        .ok()
        .and_then(|raw| String::from_utf8(raw).ok())
        .ok_or_else(|| Refusal::SignatureFormat("not base64 text".to_string()))?;
    let signature =
        minisign_verify::Signature::decode(&sig_text).map_err(|e| Refusal::SignatureFormat(e.to_string()))?;
    for key in keys {
        let Ok(pk) = minisign_verify::PublicKey::from_base64(&key.key) else {
            continue;
        };
        if pk.verify(bytes, &signature, false).is_ok() {
            return Ok((signature, key));
        }
    }
    Err(Refusal::Signature)
}

/// `timestamp:<unix>\tfile:spawnloft-updates.json\tversion:<version>` (the Tauri CLI's fields,
/// any order, extra fields ignored): `file` and `version` must both be present and match.
pub fn check_trusted_comment(comment: &str, file_name: &str, version: &Version) -> Result<(), Refusal> {
    let field = |name: &str| {
        comment
            .split('\t')
            .find_map(|f| f.strip_prefix(name).and_then(|rest| rest.strip_prefix(':')))
    };
    match field("file") {
        Some(f) if f == file_name => {}
        Some(other) => {
            return Err(Refusal::TrustedComment(format!(
                "it was made for `{other}`, not {file_name}"
            )));
        }
        None => return Err(Refusal::TrustedComment("it names no file".to_string())),
    }
    let Some(signed) = field("version") else {
        return Err(Refusal::TrustedComment(
            "it carries no version (sign with --app-version)".to_string(),
        ));
    };
    match Version::parse(signed.trim_start_matches('v')) {
        Ok(v) if &v == version => Ok(()),
        _ => Err(Refusal::TrustedComment(format!(
            "it was made for version {signed}, the feed says {version}"
        ))),
    }
}

/// An asset file name as the release tool writes it: `[A-Za-z0-9][A-Za-z0-9._-]*`, no path
/// separators of either kind, no drive letter, no `..` (it would need a leading dot).
pub fn is_file_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b) if b.is_ascii_alphanumeric())
        && name.len() <= 255
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn field<'a>(obj: &'a serde_json::Map<String, Value>, name: &str) -> Result<&'a Value, Refusal> {
    obj.get(name)
        .ok_or_else(|| Refusal::Field(format!("`{name}` is missing")))
}

fn text(obj: &serde_json::Map<String, Value>, name: &str, max: usize) -> Result<String, Refusal> {
    match field(obj, name)? {
        Value::String(s) if !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control) => {
            Ok(s.clone())
        }
        _ => Err(Refusal::Field(format!(
            "`{name}` must be a string of at most {max} characters"
        ))),
    }
}

fn version_field(obj: &serde_json::Map<String, Value>, name: &str) -> Result<Version, Refusal> {
    let s = text(obj, name, 64)?;
    Version::parse(&s).map_err(|_| Refusal::Field(format!("`{name}` ({s}) is not a semver version")))
}

/// The payload alone, without any signature check: for tests and for the signer's self-check.
pub fn parse(bytes: &[u8], expect: Expect<'_>) -> Result<Envelope, Refusal> {
    let doc: Value = serde_json::from_slice(bytes).map_err(|e| Refusal::Json(e.to_string()))?;
    let Value::Object(obj) = doc else {
        return Err(Refusal::Json("not an object".to_string()));
    };
    match field(&obj, "format")?.as_u64() {
        Some(FORMAT) => {}
        Some(n) => return Err(Refusal::Format(n)),
        None => return Err(Refusal::Field("`format` is not a number".to_string())),
    }
    let product = text(&obj, "product", 32)?;
    if product != PRODUCT {
        return Err(Refusal::Product(product));
    }
    let key_id = text(&obj, "keyId", 16)?.to_ascii_uppercase();
    if key_id.len() != 16 || !key_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Refusal::Field("`keyId` is not a minisign key id".to_string()));
    }
    let channel_text = text(&obj, "channel", 16)?;
    let channel = Channel::parse(&channel_text).ok_or_else(|| Refusal::Channel {
        wanted: expect.channel,
        got: channel_text.clone(),
    })?;
    let version = version_field(&obj, "version")?;
    // the label must be the version's own channel (a stable release's envelope says `stable`
    // whoever reads it) and the version must be one the reader's channel takes: a beta client
    // takes the stable that follows its betas, a stable client never takes a beta
    if Channel::of(&version) != Some(channel) {
        return Err(Refusal::Field(format!(
            "version {version} is not a {} release",
            channel.as_str()
        )));
    }
    if !expect.channel.accepts(&version) {
        return Err(Refusal::Channel {
            wanted: expect.channel,
            got: channel_text,
        });
    }
    let tag = text(&obj, "tag", 80)?;
    if tag != format!("v{version}") {
        return Err(Refusal::Tag {
            tag,
            version: version.to_string(),
        });
    }
    let generated_at = text(&obj, "generatedAt", 40)?;
    let generated_at_secs = crate::time::parse_iso_utc(&generated_at)
        .ok_or_else(|| Refusal::Field("`generatedAt` is not a UTC timestamp".to_string()))?;
    let expires_at_secs = match obj.get("expiresAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(
            crate::time::parse_iso_utc(s)
                .ok_or_else(|| Refusal::Field("`expiresAt` is not a UTC timestamp".to_string()))?,
        ),
        Some(_) => return Err(Refusal::Field("`expiresAt` is not a string".to_string())),
    };
    let notes = match obj.get("notes") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.len() <= 2048 && !s.chars().any(char::is_control) => Some(s.clone()),
        Some(_) => return Err(Refusal::Field("`notes` is not a short string".to_string())),
    };
    let min_version = version_field(&obj, "minVersion")?;
    if min_version > version {
        return Err(Refusal::Field(
            "`minVersion` is above the release's own version".to_string(),
        ));
    }
    let data_format = field(&obj, "dataFormat")?
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n >= 1)
        .ok_or_else(|| Refusal::Field("`dataFormat` is not a positive whole number".to_string()))?;
    let Value::Object(raw_platforms) = field(&obj, "platforms")? else {
        return Err(Refusal::Field("`platforms` is not an object".to_string()));
    };
    if raw_platforms.is_empty() || raw_platforms.len() > 16 {
        return Err(Refusal::Field(
            "`platforms` must list 1 to 16 targets".to_string(),
        ));
    }
    let prefix = format!("{}{tag}/", expect.download_base);
    let mut platforms = BTreeMap::new();
    for (target, entry) in raw_platforms {
        if target.is_empty()
            || target.len() > 32
            || !target
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        {
            return Err(Refusal::Field(format!(
                "platform `{target}` is not a target name"
            )));
        }
        let Value::Object(e) = entry else {
            return Err(Refusal::Field(format!("platform `{target}` is not an object")));
        };
        let url = text(e, "url", 512)?;
        if !url.starts_with(&prefix) || url.len() == prefix.len() {
            return Err(Refusal::Url(url));
        }
        let file = &url[prefix.len()..];
        if !is_file_name(file) {
            return Err(Refusal::Url(url));
        }
        let size = field(e, "size")?
            .as_u64()
            .ok_or_else(|| Refusal::Field(format!("`size` of {target} is not a number")))?;
        if size == 0 || size > MAX_ARTIFACT_BYTES {
            return Err(Refusal::Field(format!(
                "`size` of {target} is {size}, outside 1 to {MAX_ARTIFACT_BYTES}"
            )));
        }
        let sha512 = text(e, "sha512", 128)?.to_ascii_lowercase();
        if sha512.len() != 128 || !sha512.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Refusal::Field(format!(
                "`sha512` of {target} is not 128 hex digits"
            )));
        }
        let signature = match e.get("signature") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                if super::base64::decode(s).is_err() || s.len() > MAX_SIGNATURE_BYTES {
                    return Err(Refusal::Field(format!(
                        "`signature` of {target} is not a base64 signature file"
                    )));
                }
                Some(s.clone())
            }
            Some(_) => {
                return Err(Refusal::Field(format!("`signature` of {target} is not a string")));
            }
        };
        platforms.insert(
            target.clone(),
            PlatformEntry {
                url,
                size,
                sha512,
                signature,
            },
        );
    }
    Ok(Envelope {
        key_id,
        channel,
        version,
        tag,
        generated_at,
        generated_at_secs,
        expires_at_secs,
        notes,
        min_version,
        data_format,
        platforms,
    })
}

impl Envelope {
    /// The file name of a platform's artifact (the last URL segment).
    pub fn file_name(entry: &PlatformEntry) -> &str {
        entry.url.rsplit('/').next().unwrap_or(&entry.url)
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! Throwaway keys and a signer for the updater's tests (the `minisign` crate is a
    //! dev-dependency only).

    use super::*;

    pub struct TestKey {
        pub trusted: TrustedKey,
        pub secret: minisign::SecretKey,
    }

    impl TestKey {
        pub fn generate() -> TestKey {
            let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
            let key = pair.pk.to_base64();
            let trusted = TrustedKey {
                id: String::new(),
                key: key.clone(),
                from: "test",
            };
            let id = trusted.id_from_key().unwrap();
            TestKey {
                trusted: TrustedKey {
                    id,
                    key,
                    from: "test",
                },
                secret: pair.sk,
            }
        }

        /// Signs `data` the way `tauri signer sign --app-version <version> <file>` does, returning
        /// Tauri's base64-of-the-signature-file form.
        pub fn sign(&self, data: &[u8], file: &str, version: &str) -> String {
            let comment = format!("timestamp:1700000000\tfile:{file}\tversion:{version}");
            self.sign_with_comment(data, &comment)
        }

        pub fn sign_with_comment(&self, data: &[u8], comment: &str) -> String {
            let sig = minisign::sign(
                None,
                &self.secret,
                data,
                Some(comment),
                Some("signature from spawnloft test key"),
            )
            .unwrap();
            super::super::base64::encode(sig.to_string().as_bytes())
        }
    }

    pub const BASE: &str = "https://github.com/joogiebear/spawnloft/releases/download/";

    /// A well-formed beta envelope for `version` signed by `key`; `edit` may change the JSON
    /// before it is signed.
    pub fn envelope_json(
        key_id: &str,
        version: &str,
        edit: impl FnOnce(&mut serde_json::Map<String, Value>),
    ) -> Vec<u8> {
        let tag = format!("v{version}");
        let mut doc = serde_json::json!({
            "format": 1,
            "product": "spawnloft",
            "keyId": key_id,
            "channel": if version.contains('-') { "beta" } else { "stable" },
            "version": version,
            "tag": tag,
            "generatedAt": "2026-12-01T18:02:11Z",
            "expiresAt": "2027-03-01T18:02:11Z",
            "notes": format!("https://github.com/joogiebear/spawnloft/releases/tag/{tag}"),
            "minVersion": "2.0.0-beta.1",
            "dataFormat": 1,
            "platforms": {
                "windows-x86_64": {
                    "url": format!("{BASE}{tag}/SpawnLoft-Setup-{version}.exe"),
                    "size": 9123456,
                    "sha512": "ab".repeat(64),
                    "signature": "ZmFrZQ=="
                },
                "darwin-aarch64": {
                    "url": format!("{BASE}{tag}/SpawnLoft-{version}-mac-arm64.app.tar.gz"),
                    "size": 1,
                    "sha512": "cd".repeat(64),
                    "signature": "ZmFrZQ=="
                },
                "linux-x86_64-deb": {
                    "url": format!("{BASE}{tag}/SpawnLoft-{version}-linux-amd64.deb"),
                    "size": 2,
                    "sha512": "ef".repeat(64)
                }
            }
        });
        if let Value::Object(map) = &mut doc {
            edit(map);
        }
        serde_json::to_vec(&doc).unwrap()
    }

    pub fn signed(
        key: &TestKey,
        version: &str,
        edit: impl FnOnce(&mut serde_json::Map<String, Value>),
    ) -> (Vec<u8>, String) {
        let bytes = envelope_json(&key.trusted.id, version, edit);
        let sig = key.sign(&bytes, FILE_NAME, version);
        (bytes, sig)
    }

    pub fn beta() -> Expect<'static> {
        Expect {
            channel: Channel::Beta,
            download_base: BASE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;

    #[test]
    fn a_good_envelope_verifies_and_parses() {
        let key = TestKey::generate();
        let (bytes, sig) = signed(&key, "2.0.0-beta.3", |_| {});
        let env = verify(&bytes, &sig, std::slice::from_ref(&key.trusted), beta()).unwrap();
        assert_eq!(env.key_id, key.trusted.id);
        assert_eq!(env.version, Version::parse("2.0.0-beta.3").unwrap());
        assert_eq!(env.tag, "v2.0.0-beta.3");
        assert_eq!(
            env.generated_at_secs,
            crate::time::parse_iso_utc("2026-12-01T18:02:11Z").unwrap()
        );
        assert_eq!(env.platforms.len(), 3);
        let win = &env.platforms["windows-x86_64"];
        assert_eq!(Envelope::file_name(win), "SpawnLoft-Setup-2.0.0-beta.3.exe");
        assert!(env.platforms["linux-x86_64-deb"].signature.is_none());
    }

    #[test]
    fn wrong_key_is_refused() {
        let signer = TestKey::generate();
        let other = TestKey::generate();
        let (bytes, sig) = signed(&signer, "2.0.0-beta.3", |_| {});
        assert_eq!(
            verify(&bytes, &sig, &[other.trusted], beta()).unwrap_err(),
            Refusal::Signature
        );
        // and a signature over different bytes
        let mut tampered = bytes.clone();
        tampered[bytes.len() - 2] = b' ';
        assert_eq!(
            verify(&tampered, &sig, std::slice::from_ref(&signer.trusted), beta()).unwrap_err(),
            Refusal::Signature
        );
    }

    #[test]
    fn a_signature_moved_from_another_file_or_version_is_refused() {
        let key = TestKey::generate();
        let keys = std::slice::from_ref(&key.trusted);
        let bytes = envelope_json(&key.trusted.id, "2.0.0-beta.3", |_| {});
        // signed as an artifact of the same release
        let sig = key.sign(&bytes, "SpawnLoft-Setup-2.0.0-beta.3.exe", "2.0.0-beta.3");
        assert_eq!(
            verify(&bytes, &sig, keys, beta()).unwrap_err().code(),
            "trusted-comment"
        );
        // signed as the envelope of another version
        let sig = key.sign(&bytes, FILE_NAME, "2.0.0-beta.2");
        assert_eq!(
            verify(&bytes, &sig, keys, beta()).unwrap_err().code(),
            "trusted-comment"
        );
        // signed with no version at all (tauri signer sign without --app-version)
        let sig = key.sign_with_comment(&bytes, &format!("timestamp:1\tfile:{FILE_NAME}"));
        assert_eq!(
            verify(&bytes, &sig, keys, beta()).unwrap_err().code(),
            "trusted-comment"
        );
        // a plain minisign comment
        let sig = key.sign_with_comment(&bytes, "timestamp:1");
        assert_eq!(
            verify(&bytes, &sig, keys, beta()).unwrap_err().code(),
            "trusted-comment"
        );
        // the right one still passes, in any field order and with extra fields
        let sig = key.sign_with_comment(
            &bytes,
            &format!("version:v2.0.0-beta.3\textra:1\tfile:{FILE_NAME}"),
        );
        assert!(verify(&bytes, &sig, keys, beta()).is_ok());
    }

    #[test]
    fn key_id_must_name_the_signing_key() {
        let release = TestKey::generate();
        let next = TestKey::generate();
        let keys = vec![release.trusted.clone(), next.trusted.clone()];
        // signed by next, claims release
        let bytes = envelope_json(&release.trusted.id, "2.0.0-beta.3", |_| {});
        let sig = next.sign(&bytes, FILE_NAME, "2.0.0-beta.3");
        assert_eq!(verify(&bytes, &sig, &keys, beta()).unwrap_err().code(), "key-id");
        // a rotation: signed by next and saying so
        let (bytes, sig) = signed(&next, "2.0.0-beta.3", |_| {});
        assert_eq!(
            verify(&bytes, &sig, &keys, beta()).unwrap().key_id,
            next.trusted.id
        );
        // an unknown key id with a valid signature from a trusted key
        let bytes = envelope_json("0000000000000000", "2.0.0-beta.3", |_| {});
        let sig = release.sign(&bytes, FILE_NAME, "2.0.0-beta.3");
        assert_eq!(verify(&bytes, &sig, &keys, beta()).unwrap_err().code(), "key-id");
    }

    #[test]
    fn payload_rules() {
        let key = TestKey::generate();
        let keys = std::slice::from_ref(&key.trusted);
        let refused = |edit: fn(&mut serde_json::Map<String, Value>)| {
            let (bytes, sig) = signed(&key, "2.0.0-beta.3", edit);
            verify(&bytes, &sig, keys, beta()).unwrap_err().code()
        };
        assert_eq!(
            refused(|m| {
                m.insert("format".into(), 2.into());
            }),
            "format"
        );
        assert_eq!(
            refused(|m| {
                m.insert("product".into(), "mcctl".into());
            }),
            "product"
        );
        assert_eq!(
            // a beta version labelled stable: the label is wrong, whoever reads it
            refused(|m| {
                m.insert("channel".into(), "stable".into());
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m.insert("channel".into(), "next".into());
            }),
            "channel"
        );
        assert_eq!(
            refused(|m| {
                m.insert("tag".into(), "v2.0.0-beta.4".into());
            }),
            "tag"
        );
        assert_eq!(
            refused(|m| {
                m.insert("generatedAt".into(), "2026-12-01T18:02:11+01:00".into());
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m.insert("minVersion".into(), "2.0.0".into());
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m.insert("dataFormat".into(), 0.into());
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m.remove("platforms");
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m["platforms"]["windows-x86_64"]["url"] =
                    "https://evil.example/SpawnLoft-Setup-2.0.0-beta.3.exe".into();
            }),
            "url"
        );
        assert_eq!(
            refused(|m| {
                m["platforms"]["windows-x86_64"]["url"] =
                    format!("{BASE}v2.0.0-beta.2/SpawnLoft-Setup-2.0.0-beta.2.exe").into();
            }),
            "url"
        );
        assert_eq!(
            refused(|m| {
                m["platforms"]["windows-x86_64"]["url"] = format!("{BASE}v2.0.0-beta.3/../x.exe").into();
            }),
            "url"
        );
        assert_eq!(
            refused(|m| {
                m["platforms"]["windows-x86_64"]["sha512"] = "abc".into();
            }),
            "field"
        );
        assert_eq!(
            refused(|m| {
                m["platforms"]["windows-x86_64"]["signature"] = "not base64!".into();
            }),
            "field"
        );
        // a beta envelope naming a `next` version
        assert_eq!(
            refused(|m| {
                m.insert("version".into(), "2.0.0-next.1".into());
                m.insert("tag".into(), "v2.0.0-next.1".into());
            }),
            "field"
        );
    }

    #[test]
    fn stable_channel_rejects_a_beta_envelope() {
        let key = TestKey::generate();
        let (bytes, sig) = signed(&key, "2.0.0-beta.3", |_| {});
        let stable = Expect {
            channel: Channel::Stable,
            download_base: BASE,
        };
        assert_eq!(
            verify(&bytes, &sig, std::slice::from_ref(&key.trusted), stable)
                .unwrap_err()
                .code(),
            "channel"
        );
    }

    #[test]
    fn beta_channel_takes_the_stable_that_follows() {
        let key = TestKey::generate();
        // the release tool labels 2.0.0 `stable`; a beta client takes it
        let (bytes, sig) = signed(&key, "2.0.0", |_| {});
        let env = verify(&bytes, &sig, std::slice::from_ref(&key.trusted), beta()).unwrap();
        assert_eq!(env.channel, Channel::Stable);
        let stable = Expect {
            channel: Channel::Stable,
            download_base: BASE,
        };
        assert!(verify(&bytes, &sig, std::slice::from_ref(&key.trusted), stable).is_ok());
        // a stable version labelled beta is malformed, whoever reads it
        let (bytes, sig) = signed(&key, "2.0.0", |m| {
            m.insert("channel".into(), "beta".into());
        });
        assert_eq!(
            verify(&bytes, &sig, std::slice::from_ref(&key.trusted), beta())
                .unwrap_err()
                .code(),
            "field"
        );
        // a `next` build belongs to no channel
        let (bytes, sig) = signed(&key, "2.0.0-next.1", |m| {
            m.insert("channel".into(), "beta".into());
        });
        assert!(verify(&bytes, &sig, std::slice::from_ref(&key.trusted), beta()).is_err());
    }

    #[test]
    fn size_caps() {
        let key = TestKey::generate();
        let (bytes, sig) = signed(&key, "2.0.0-beta.3", |_| {});
        let big = vec![b' '; MAX_ENVELOPE_BYTES + 1];
        assert_eq!(
            verify(&big, &sig, std::slice::from_ref(&key.trusted), beta()).unwrap_err(),
            Refusal::TooLarge
        );
        let long_sig = "A".repeat(MAX_SIGNATURE_BYTES + 4);
        assert_eq!(
            verify(&bytes, &long_sig, std::slice::from_ref(&key.trusted), beta()).unwrap_err(),
            Refusal::TooLarge
        );
        assert_eq!(
            verify(&bytes, "not base64", std::slice::from_ref(&key.trusted), beta())
                .unwrap_err()
                .code(),
            "signature-format"
        );
    }

    #[test]
    fn channel_membership() {
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(Channel::Stable.accepts(&v("2.0.0")));
        assert!(!Channel::Stable.accepts(&v("2.0.0-beta.1")));
        assert!(Channel::Beta.accepts(&v("2.0.0")));
        assert!(Channel::Beta.accepts(&v("2.0.0-beta.1")));
        assert!(!Channel::Beta.accepts(&v("2.0.0-next.1")));
        assert!(!Channel::Beta.accepts(&v("2.0.0-internal.16")));
        assert!(!Channel::Beta.accepts(&v("2.0.0-spike.2")));
    }
}
