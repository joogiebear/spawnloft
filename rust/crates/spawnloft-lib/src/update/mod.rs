//! The 2.x updater's client side (INSTALLER-UPDATER-DESIGN.md section 5): discover releases,
//! fetch and verify the signed envelope, apply the policy, and hand the window shell (or the
//! headless `update apply`) one pinned record saying exactly which file, from which URL, with
//! which signature, may be installed. `tauri-plugin-updater` then downloads and verifies the
//! artifact against that record and nothing else.
//!
//! Module map: [`keys`] (trust anchors), [`envelope`] (signature and payload), [`releases`]
//! (which tags exist), [`policy`] (may it be offered), [`fetch`] (HTTP), [`store`] (files in the
//! config folder), and here the check itself.

pub mod api;
pub mod base64;
pub mod envelope;
pub mod fetch;
pub mod keys;
pub mod policy;
pub mod releases;
pub mod store;

use std::path::PathBuf;

use semver::Version;
use serde_json::{Value, json};

use envelope::{Channel, Envelope, Expect, PlatformEntry, Refusal};
use fetch::{Fetch, FetchError, Source};
use keys::TrustedKey;
use policy::{Install, Skip, Verdict};
use releases::Candidate;
use store::{State, Store};

/// How many release envelopes one check reads at most while walking down (`minVersion` hops,
/// releases without an envelope).
const MAX_WALK: usize = 12;
/// Pages of the releases API read when the atom window is not enough (100 releases a page).
const MAX_API_PAGES: usize = 5;
const ATOM_CAP: usize = 1024 * 1024;
const API_CAP: usize = 2 * 1024 * 1024;
/// The largest artifact `update apply` downloads itself.
pub const ARTIFACT_CAP: usize = envelope::MAX_ARTIFACT_BYTES as usize;
/// Cached download versions kept.
pub const CACHE_KEEP: usize = 2;

/// The updater target of this build, in the plugin's naming.
pub fn target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        _ => "unsupported",
    }
}

/// How this Linux install was made: `deb` or `rpm`. The packages write it beside the core's
/// folder (`/opt/SpawnLoft/resources/package-type`, `/opt/spawnloft-cli/package-type`, both
/// `<core dir>/../package-type`); a build run from elsewhere goes by the distribution.
pub fn linux_package_kind() -> &'static str {
    let marker = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("package-type")))
        .and_then(|p| std::fs::read_to_string(p).ok());
    match marker.as_deref().map(str::trim) {
        Some("deb") => "deb",
        Some("rpm") => "rpm",
        _ if std::path::Path::new("/etc/debian_version").exists() => "deb",
        _ => "rpm",
    }
}

/// On Linux the envelope lists `-deb` and `-rpm` entries; the package family of this install.
fn linux_package_suffix() -> &'static str {
    if linux_package_kind() == "deb" {
        "-deb"
    } else {
        "-rpm"
    }
}

/// A `spawnloft-cli` install (`/opt/spawnloft-cli/bin/spawnloft-core`): its marker sits beside
/// `bin/`, and there is no window two levels up (the desktop package has
/// `/opt/SpawnLoft/spawnloft-desktop` beside `resources/`).
pub fn linux_cli_install() -> bool {
    let Some(prefix) = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.to_path_buf()))
    else {
        return false;
    };
    prefix.join("package-type").is_file()
        && !prefix
            .parent()
            .is_some_and(|p| p.join("spawnloft-desktop").exists())
}

/// What a headless `spawnloft-cli` box is told: the envelope names only the desktop packages (whose
/// `Conflicts:` would remove the CLI and pull in a GUI stack), so the CLI package of the same
/// release is named for the user to fetch and install with the package manager.
pub fn linux_cli_notice(pinned: &Pinned, kind: &str) -> String {
    let arch = match (std::env::consts::ARCH, kind) {
        ("aarch64", "deb") => "arm64",
        ("aarch64", _) => "aarch64",
        (_, "deb") => "amd64",
        _ => "x86_64",
    };
    let file = format!("spawnloft-cli-{}-linux-{arch}.{kind}", pinned.version);
    let url = match pinned.url.rsplit_once('/') {
        Some((base, _)) => format!("{base}/{file}"),
        None => file.clone(),
    };
    let manager = if kind == "deb" { "apt" } else { "dnf" };
    format!(
        "spawnloft-cli {} is available. Download {url} and install it with: sudo {manager} install ./{file}",
        pinned.version
    )
}

/// Linux updates are installed by the package manager, never by SpawnLoft (design 5.7, Q-F): the
/// command a user runs for a verified download at `path`. A rollback installs a lower version,
/// which both managers only do when told to.
pub fn linux_install_command(kind: &str, path: &std::path::Path, rollback: bool) -> String {
    let p = path.display().to_string();
    let quoted = if p
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+~".contains(c))
    {
        p
    } else {
        format!("'{}'", p.replace('\'', "'\\''"))
    };
    match (kind, rollback) {
        ("deb", false) => format!("sudo apt install {quoted}"),
        ("deb", true) => format!("sudo apt install --allow-downgrades {quoted}"),
        (_, false) => format!("sudo dnf install {quoted}"),
        (_, true) => format!("sudo dnf downgrade {quoted}"),
    }
}

/// The install command for the pending offer, when this is Linux and it is downloaded and verified.
pub fn pending_install_command(store: &Store) -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let state = store.state();
    let pending = state.pending.as_ref()?;
    if linux_cli_install() {
        return Some(linux_cli_notice(pending, linux_package_kind()));
    }
    if !state.downloaded {
        return None;
    }
    let file = store.cache_file(&pending.version, &pending.file);
    file.is_file()
        .then(|| linux_install_command(linux_package_kind(), &file, pending.rollback))
}

/// The envelope entry for this build's target.
pub fn platform_entry<'e>(env: &'e Envelope, target: &str) -> Option<(&'e str, &'e PlatformEntry)> {
    if let Some((k, e)) = env.platforms.get_key_value(target) {
        return Some((k.as_str(), e));
    }
    if target.starts_with("linux-") {
        let key = format!("{target}{}", linux_package_suffix());
        if let Some((k, e)) = env.platforms.get_key_value(&key) {
            return Some((k.as_str(), e));
        }
    }
    None
}

/// Everything the shell needs to install one verified release, and nothing it may change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pinned {
    pub version: String,
    pub tag: String,
    pub notes: Option<String>,
    /// The envelope's platform key this record was taken from.
    pub target: String,
    pub url: String,
    pub file: String,
    pub size: u64,
    pub sha512: String,
    /// The artifact's minisign signature in Tauri's form; `None` for Linux packages.
    pub signature: Option<String>,
    pub key_id: String,
    /// The public key in the plugin's `pubkey` form (the `.pub` file, base64).
    pub pubkey: String,
    pub data_format: u32,
    pub min_version: String,
    /// `generatedAt` of the envelope it came from.
    pub generated_at: String,
    /// A rollback the person asked for (lower version; `/ROLLBACK` on Windows).
    pub rollback: bool,
}

impl Pinned {
    fn from(env: &Envelope, key: &TrustedKey, target: &str, entry: &PlatformEntry, rollback: bool) -> Pinned {
        Pinned {
            version: env.version.to_string(),
            tag: env.tag.clone(),
            notes: env.notes.clone(),
            target: target.to_string(),
            url: entry.url.clone(),
            file: Envelope::file_name(entry).to_string(),
            size: entry.size,
            sha512: entry.sha512.clone(),
            signature: entry.signature.clone(),
            key_id: key.id.clone(),
            pubkey: key.plugin_pubkey(),
            data_format: env.data_format,
            min_version: env.min_version.to_string(),
            generated_at: env.generated_at.clone(),
            rollback,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "tag": self.tag,
            "notes": self.notes,
            "target": self.target,
            "url": self.url,
            "file": self.file,
            "size": self.size,
            "sha512": self.sha512,
            "signature": self.signature,
            "keyId": self.key_id,
            "pubkey": self.pubkey,
            "dataFormat": self.data_format,
            "minVersion": self.min_version,
            "generatedAt": self.generated_at,
            "rollback": self.rollback,
        })
    }

    /// The record back from JSON (the state file, or the shell reading `update check --json`).
    pub fn from_json(v: &Value) -> Option<Pinned> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Pinned {
            version: s("version")?,
            tag: s("tag")?,
            notes: s("notes"),
            target: s("target")?,
            url: s("url")?,
            file: s("file").filter(|f| envelope::is_file_name(f))?,
            size: v.get("size").and_then(Value::as_u64)?,
            sha512: s("sha512")?,
            signature: s("signature"),
            key_id: s("keyId")?,
            pubkey: s("pubkey")?,
            data_format: u32::try_from(v.get("dataFormat").and_then(Value::as_u64)?).ok()?,
            min_version: s("minVersion")?,
            generated_at: s("generatedAt")?,
            rollback: v.get("rollback").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// The release manifest the plugin reads, built from this record alone (`restore_update`),
    /// so the plugin never fetches an unsigned `latest.json`.
    pub fn plugin_manifest(&self) -> Value {
        let entry = json!({ "url": self.url, "signature": self.signature.clone().unwrap_or_default() });
        let mut platforms = serde_json::Map::new();
        platforms.insert(self.target.clone(), entry.clone());
        if self.target.starts_with("windows-") {
            platforms.insert(format!("{}-nsis", self.target), entry);
        } else if self.target.starts_with("darwin-") {
            platforms.insert(format!("{}-app", self.target), entry);
        }
        json!({
            "version": self.version,
            "notes": self.notes,
            "pub_date": Value::Null,
            "platforms": Value::Object(platforms),
        })
    }
}

/// What a check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Update(Box<Pinned>),
    UpToDate,
    /// A newer release exists but this install may not take it (data format, `minVersion` with
    /// no hop available).
    Blocked(String),
    /// No source answered.
    Unreachable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub installed: String,
    pub channel: Channel,
    pub checked_at: String,
    pub source: Option<String>,
    pub outcome: Outcome,
    /// The envelope accepted (or last seen) had passed its `expiresAt`.
    pub stale: bool,
    pub hold: Option<String>,
    /// What happened to each candidate, newest first.
    pub steps: Vec<String>,
}

impl Report {
    pub fn to_json(&self) -> Value {
        let (result, update, reason) = match &self.outcome {
            Outcome::Update(p) => ("update", Some(p.to_json()), None),
            Outcome::UpToDate => ("up-to-date", None, None),
            Outcome::Blocked(why) => ("blocked", None, Some(why.clone())),
            Outcome::Unreachable(why) => ("unreachable", None, Some(why.clone())),
        };
        json!({
            "ok": !matches!(self.outcome, Outcome::Unreachable(_)),
            "installed": self.installed,
            "channel": self.channel.as_str(),
            "checkedAt": self.checked_at,
            "source": self.source,
            "result": result,
            "update": update,
            "reason": reason,
            "staleFeed": self.stale,
            "hold": self.hold,
            "steps": self.steps,
        })
    }
}

/// What the check runs with.
pub struct Context<'a> {
    pub installed: Version,
    pub channel: Channel,
    pub store: &'a Store,
    pub data_root: PathBuf,
    pub keys: Vec<TrustedKey>,
    pub sources: Vec<Source>,
    pub fetch: &'a dyn Fetch,
    pub now_secs: i64,
    pub target: String,
}

impl std::fmt::Debug for Context<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Context")
            .field("installed", &self.installed)
            .field("channel", &self.channel)
            .field("sources", &self.sources)
            .field("target", &self.target)
            .finish_non_exhaustive()
    }
}

impl<'a> Context<'a> {
    /// The context a running binary uses: this build, the config folder, the compiled-in keys.
    pub fn current(
        store: &'a Store,
        fetch: &'a dyn Fetch,
        channel: Option<Channel>,
    ) -> Result<Context<'a>, String> {
        let installed = Version::parse(crate::build::current().version)
            .map_err(|e| format!("this build's version is not semver: {e}"))?;
        let channel = channel.unwrap_or(if store.channel(&installed).beta {
            Channel::Beta
        } else {
            Channel::Stable
        });
        Ok(Context {
            installed,
            channel,
            store,
            data_root: crate::paths::resolve_data_root(),
            keys: keys::trusted(),
            sources: Source::configured(),
            fetch,
            now_secs: crate::time::now_ms() / 1000,
            target: target().to_string(),
        })
    }

    fn install_rules(&self, hold: Option<&'a Version>) -> Result<Install<'_>, String> {
        Ok(Install {
            version: &self.installed,
            channel: self.channel,
            data_format: Store::data_format(&self.data_root)?,
            baseline_secs: crate::time::parse_iso_utc(policy::FEED_BASELINE).unwrap_or(0),
            last_accepted_secs: self.store.last_accepted_secs(),
            hold_below: hold,
            now_secs: self.now_secs,
        })
    }

    fn expect<'s>(&self, source: &'s Source) -> Expect<'s> {
        Expect {
            channel: self.channel,
            download_base: &source.download,
        }
    }

    /// The tags the atom feed lists (about ten entries).
    fn atom_tags(&self, source: &Source, steps: &mut Vec<String>) -> Vec<String> {
        match self.fetch.get(&source.atom, ATOM_CAP) {
            Ok(xml) => releases::tags_from_atom(&String::from_utf8_lossy(&xml)),
            Err(e) => {
                steps.push(format!("{}: atom feed: {e}", source.name));
                Vec::new()
            }
        }
    }

    /// More tags from the releases API, newest first, until a page reaches the installed version
    /// (the "more than ten releases behind" case) or the page budget is spent.
    fn api_tags(&self, source: &Source, into: &mut Vec<String>) -> Result<(), FetchError> {
        for page in 1..=MAX_API_PAGES {
            let url = format!("{}?per_page=100&page={page}", source.api);
            let body = self.fetch.get(&url, API_CAP)?;
            let page_tags = releases::tags_from_api(&body).map_err(FetchError::Transport)?;
            let done = page_tags.len() < 100
                || releases::candidates(&page_tags, self.channel)
                    .iter()
                    .any(|c| c.version <= self.installed);
            for t in page_tags {
                if !into.contains(&t) {
                    into.push(t);
                }
            }
            if done {
                break;
            }
        }
        Ok(())
    }

    /// The tags a source lists: the atom feed, and the API when the atom feed gave nothing.
    fn tags(&self, source: &Source, steps: &mut Vec<String>) -> Result<Vec<String>, FetchError> {
        let mut tags = self.atom_tags(source, steps);
        if tags.is_empty() {
            self.api_tags(source, &mut tags)?;
        }
        Ok(tags)
    }

    /// Fetches and verifies the envelope of `cand` from `source`. `Ok(None)` means the release has
    /// no envelope (a 1.x release, or one not finished): skip it.
    fn envelope(&self, source: &Source, cand: &Candidate) -> Result<Option<(Envelope, &TrustedKey)>, Step> {
        let bytes = match self.fetch.get(
            &source.asset(&cand.tag, envelope::FILE_NAME),
            envelope::MAX_ENVELOPE_BYTES,
        ) {
            Ok(b) => b,
            Err(FetchError::NotFound) => return Ok(None),
            Err(e) => return Err(Step::Unreachable(e.to_string())),
        };
        let sig = match self.fetch.get(
            &source.asset(&cand.tag, &format!("{}.sig", envelope::FILE_NAME)),
            envelope::MAX_SIGNATURE_BYTES,
        ) {
            Ok(b) => String::from_utf8_lossy(&b).trim().to_string(),
            Err(FetchError::NotFound) => return Ok(None),
            Err(e) => return Err(Step::Unreachable(e.to_string())),
        };
        let (_, signer) = envelope::verify_signature(&bytes, &sig, &self.keys).map_err(Step::Refused)?;
        let env = envelope::verify(&bytes, &sig, &self.keys, self.expect(source)).map_err(Step::Refused)?;
        if env.version != cand.version {
            return Err(Step::Refused(Refusal::Tag {
                tag: cand.tag.clone(),
                version: env.version.to_string(),
            }));
        }
        Ok(Some((env, signer)))
    }

    /// One check: every source in turn until one answers.
    pub fn check(&self) -> Report {
        let hold = self.store.hold();
        let mut report = Report {
            installed: self.installed.to_string(),
            channel: self.channel,
            checked_at: crate::time::iso_now(),
            source: None,
            outcome: Outcome::Unreachable("no update source is configured".to_string()),
            stale: false,
            hold: hold.as_ref().map(ToString::to_string),
            steps: Vec::new(),
        };
        self.store.log(
            "check",
            &[
                ("installed", &report.installed),
                ("channel", self.channel.as_str()),
                ("target", &self.target),
            ],
        );
        let mut unreachable: Vec<String> = Vec::new();
        for source in &self.sources {
            match self.check_source(source, hold.as_ref(), &mut report.steps) {
                Ok((outcome, stale)) => {
                    report.source = Some(source.name.clone());
                    report.outcome = outcome;
                    report.stale = stale;
                    unreachable.clear();
                    break;
                }
                Err(why) => {
                    report.steps.push(format!("{}: {why}", source.name));
                    unreachable.push(format!("{}: {why}", source.name));
                }
            }
        }
        if !unreachable.is_empty() {
            report.outcome = Outcome::Unreachable(unreachable.join("; "));
        }
        self.record(&report);
        report
    }

    /// `Ok` when the source answered (whatever it said), `Err` when it must be skipped: not
    /// reachable, or its newest envelope failed verification (the next source is tried, design 5.3).
    fn check_source(
        &self,
        source: &Source,
        hold: Option<&Version>,
        steps: &mut Vec<String>,
    ) -> Result<(Outcome, bool), String> {
        let mut tags = self
            .tags(source, steps)
            .map_err(|e| format!("could not list releases: {e}"))?;
        let rules = self.install_rules(hold)?;
        let mut walk = self.walk(source, &tags, &rules, hold, steps)?;
        // a hop is needed and the atom window did not reach down to the installed version: the
        // release in between may be older than the window shows
        if walk.offer.is_none()
            && walk.hop_needed
            && !releases::candidates(&tags, self.channel)
                .iter()
                .any(|c| c.version <= self.installed)
        {
            match self.api_tags(source, &mut tags) {
                Ok(()) => walk = self.walk(source, &tags, &rules, hold, steps)?,
                Err(e) => steps.push(format!("{}: releases API: {e}", source.name)),
            }
        }
        if let Some(pinned) = walk.offer {
            return Ok((Outcome::Update(Box::new(pinned)), walk.stale));
        }
        // nothing to offer: the feed may simply be frozen (a listing an attacker holds still, or
        // newer releases removed). The newest release at or below the installed version, normally
        // the installed one, carries the `expiresAt` that says so (design 5.3, review item 7).
        if walk.blocked.is_none() {
            walk.stale = self.frozen(source, &tags, &rules, steps)?;
        }
        Ok((
            walk.blocked.map_or(Outcome::UpToDate, Outcome::Blocked),
            walk.stale,
        ))
    }

    /// Whether the newest envelope at or below the installed version has expired (or is missing).
    /// A refused envelope here fails the source like one in the walk would.
    fn frozen(
        &self,
        source: &Source,
        tags: &[String],
        rules: &Install<'_>,
        steps: &mut Vec<String>,
    ) -> Result<bool, String> {
        let Some(cand) = releases::candidates(tags, self.channel)
            .into_iter()
            .find(|c| c.version <= self.installed)
        else {
            steps.push("no release at or below the installed version is listed".to_string());
            return Ok(true);
        };
        match self.envelope(source, &cand) {
            Ok(Some((env, _))) => {
                let stale = policy::is_stale(rules, &env);
                steps.push(format!(
                    "{}: {}",
                    cand.tag,
                    if stale {
                        "feed expired (stale)"
                    } else {
                        "feed current"
                    }
                ));
                Ok(stale)
            }
            Ok(None) => {
                steps.push(format!("{}: no update feed (stale)", cand.tag));
                Ok(true)
            }
            Err(Step::Unreachable(why)) => Err(format!("{}: {why}", cand.tag)),
            Err(Step::Refused(r)) => {
                self.store.log(
                    "refused",
                    &[("tag", &cand.tag), ("code", r.code()), ("why", &r.to_string())],
                );
                Err(format!("{}: refused ({}): {r}", cand.tag, r.code()))
            }
        }
    }

    /// Newest first, every candidate above the installed version, until one may be offered.
    fn walk(
        &self,
        source: &Source,
        tags: &[String],
        rules: &Install<'_>,
        hold: Option<&Version>,
        steps: &mut Vec<String>,
    ) -> Result<Walk, String> {
        let mut walk = Walk::default();
        let mut fetched = 0;
        for cand in releases::candidates(tags, self.channel) {
            if cand.version <= self.installed {
                break;
            }
            if fetched >= MAX_WALK {
                steps.push(format!("stopped after {MAX_WALK} releases"));
                break;
            }
            fetched += 1;
            let (env, signer) = match self.envelope(source, &cand) {
                Ok(Some(x)) => x,
                Ok(None) => {
                    // a release without its feed (never published with one, or taken down): an
                    // offer made from it earlier is withdrawn
                    steps.push(format!("{}: no update feed (skipped)", cand.tag));
                    self.forget_pending(&Some(cand.version.clone()), "no update feed");
                    fetched -= 1;
                    continue;
                }
                Err(Step::Unreachable(why)) => return Err(format!("{}: {why}", cand.tag)),
                Err(Step::Refused(r)) => {
                    self.store.log(
                        "refused",
                        &[("tag", &cand.tag), ("code", r.code()), ("why", &r.to_string())],
                    );
                    return Err(format!("{}: refused ({}): {r}", cand.tag, r.code()));
                }
            };
            match policy::judge_update(rules, &env) {
                Verdict::Offer { stale } => {
                    walk.stale = stale;
                    let Some((target, entry)) = platform_entry(&env, &self.target) else {
                        steps.push(format!("{}: no artifact for {}", cand.tag, self.target));
                        walk.blocked
                            .get_or_insert(format!("{} has no build for {}", env.version, self.target));
                        continue;
                    };
                    steps.push(format!("{}: offered", cand.tag));
                    if let Some(h) = hold
                        && env.version > *h
                    {
                        let _ = self.store.clear_hold();
                        self.store.log(
                            "hold-cleared",
                            &[("below", &h.to_string()), ("newer", &env.version.to_string())],
                        );
                    }
                    walk.offer = Some(Pinned::from(&env, signer, target, entry, false));
                    return Ok(walk);
                }
                Verdict::Skip(Skip::NeedsHop { min_version }) => {
                    steps.push(format!("{}: needs {min_version} first", cand.tag));
                    walk.hop_needed = true;
                    walk.blocked.get_or_insert(format!(
                        "{} needs at least {min_version} installed first; no release in between was found",
                        env.version
                    ));
                }
                Verdict::Skip(Skip::Held) => steps.push(format!("{}: held", cand.tag)),
                Verdict::Skip(Skip::NotNewer) => steps.push(format!("{}: not newer", cand.tag)),
                Verdict::Refuse(reason) => {
                    self.store.log(
                        "refused",
                        &[
                            ("tag", &cand.tag),
                            ("code", reason.code()),
                            ("why", &reason.to_string()),
                        ],
                    );
                    match reason {
                        policy::Reason::Replayed { .. } | policy::Reason::FromTheFuture { .. } => {
                            // the newest release is older than one already accepted: that one may
                            // have been taken down (a yanked release). Its offer is withdrawn so
                            // nothing installs it; the floor stands, so only a release made after
                            // the yank is ever offered again (fail closed)
                            if let Some(p) = self.store.state().pending
                                && !tags.contains(&p.tag)
                            {
                                self.forget_pending(&Version::parse(&p.version).ok(), "taken down");
                            }
                            return Err(format!("{}: refused ({}): {reason}", cand.tag, reason.code()));
                        }
                        other => {
                            steps.push(format!("{}: {other}", cand.tag));
                            walk.blocked = Some(other.to_string());
                            walk.hop_needed = false;
                            return Ok(walk);
                        }
                    }
                }
            }
        }
        Ok(walk)
    }

    /// Withdraws the saved offer when it names `version` (or any offer, for `None`): the window
    /// must not install something the feed no longer carries.
    fn forget_pending(&self, version: &Option<Version>, why: &str) {
        let mut state = self.store.state();
        let Some(p) = state.pending.as_ref() else { return };
        let same = match version {
            Some(v) => Version::parse(&p.version).ok().as_ref() == Some(v),
            None => true,
        };
        if !same {
            return;
        }
        self.store
            .log("offer-withdrawn", &[("version", &p.version), ("why", why)]);
        state.pending = None;
        state.downloaded = false;
        let _ = self.store.save_state(&state);
    }

    fn record(&self, report: &Report) {
        let mut state = self.store.state();
        state.last_check_at = Some(report.checked_at.clone());
        state.stale_feed = report.stale;
        let result = match &report.outcome {
            Outcome::Update(p) => {
                let newer = state
                    .pending
                    .as_ref()
                    .is_none_or(|old| old.version != p.version || old.sha512 != p.sha512);
                if newer {
                    state.downloaded = false;
                }
                state.pending = Some((**p).clone());
                let accepted = crate::time::parse_iso_utc(&p.generated_at).unwrap_or(0);
                if state
                    .last_accepted_generated_at
                    .as_deref()
                    .and_then(crate::time::parse_iso_utc)
                    .is_none_or(|prev| accepted > prev)
                {
                    state.last_accepted_generated_at = Some(p.generated_at.clone());
                }
                format!("update {}", p.version)
            }
            Outcome::UpToDate => {
                state.pending = None;
                state.downloaded = false;
                "up-to-date".to_string()
            }
            Outcome::Blocked(why) => {
                state.pending = None;
                state.downloaded = false;
                format!("blocked: {why}")
            }
            // an unreachable feed keeps the last offer
            Outcome::Unreachable(why) => format!("unreachable: {why}"),
        };
        state.last_result = Some(result.clone());
        let _ = self.store.save_state(&state);
        self.store.log(
            "result",
            &[
                ("source", report.source.as_deref().unwrap_or("-")),
                ("result", &result),
                ("stale", if report.stale { "yes" } else { "no" }),
            ],
        );
    }

    /// The releases below the installed one that the feed knows, for the rollback list.
    pub fn rollback_candidates(&self) -> Result<Vec<RollbackEntry>, String> {
        let source = self.sources.first().ok_or("no update source is configured")?;
        let mut steps = Vec::new();
        let tags = self
            .tags(source, &mut steps)
            .map_err(|e| format!("could not list releases: {e}"))?;
        let rules = self.install_rules(None)?;
        let mut out = Vec::new();
        for cand in releases::candidates(&tags, self.channel) {
            if cand.version >= self.installed {
                continue;
            }
            if out.len() >= MAX_WALK {
                break;
            }
            let (env, _) = match self.envelope(source, &cand) {
                Ok(Some(x)) => x,
                Ok(None) => continue,
                Err(Step::Unreachable(why)) => return Err(format!("{}: {why}", cand.tag)),
                Err(Step::Refused(r)) => {
                    out.push(RollbackEntry {
                        version: cand.version.to_string(),
                        tag: cand.tag.clone(),
                        data_format: 0,
                        allowed: false,
                        reason: Some(format!("refused ({}): {r}", r.code())),
                    });
                    continue;
                }
            };
            let (allowed, reason) = match policy::judge_rollback(&rules, &env, false) {
                Verdict::Offer { .. } if platform_entry(&env, &self.target).is_some() => (true, None),
                Verdict::Offer { .. } => (false, Some(format!("no build for {}", self.target))),
                Verdict::Refuse(r) => (false, Some(r.to_string())),
                Verdict::Skip(_) => (false, Some("not a rollback".to_string())),
            };
            out.push(RollbackEntry {
                version: env.version.to_string(),
                tag: env.tag.clone(),
                data_format: env.data_format,
                allowed,
                reason,
            });
        }
        Ok(out)
    }

    /// The pinned record for a rollback to `version`, after verification and the rollback rules;
    /// writes the hold so the next check does not offer the current version again.
    pub fn plan_rollback(&self, version: &Version, force_data_format: bool) -> Result<Pinned, String> {
        let source = self.sources.first().ok_or("no update source is configured")?;
        let cand = Candidate {
            version: version.clone(),
            tag: format!("v{version}"),
        };
        if !self.channel.accepts(version) {
            return Err(format!("{version} is not a {} release", self.channel.as_str()));
        }
        let (env, signer) = match self.envelope(source, &cand) {
            Ok(Some(x)) => x,
            Ok(None) => return Err(format!("{} has no update feed", cand.tag)),
            Err(Step::Unreachable(why)) => return Err(format!("{}: {why}", cand.tag)),
            Err(Step::Refused(r)) => {
                self.store.log(
                    "refused",
                    &[("tag", &cand.tag), ("code", r.code()), ("why", &r.to_string())],
                );
                return Err(format!("{}: refused ({}): {r}", cand.tag, r.code()));
            }
        };
        let rules = self.install_rules(None)?;
        match policy::judge_rollback(&rules, &env, force_data_format) {
            Verdict::Offer { .. } => {}
            Verdict::Refuse(r) => return Err(r.to_string()),
            Verdict::Skip(_) => return Err("not a rollback".to_string()),
        }
        let (target, entry) = platform_entry(&env, &self.target)
            .ok_or_else(|| format!("{} has no build for {}", env.version, self.target))?;
        let pinned = Pinned::from(&env, signer, target, entry, true);
        // a second rollback keeps the first hold: the version the person fled first stays held
        let hold = match self.store.hold() {
            Some(h) if h > self.installed => h,
            _ => self.installed.clone(),
        };
        self.store
            .set_hold(&hold)
            .map_err(|e| format!("could not write the hold: {e}"))?;
        self.store.log(
            "rollback-planned",
            &[
                ("to", &pinned.version),
                ("from", &self.installed.to_string()),
                ("hold-below", &hold.to_string()),
            ],
        );
        let mut state = self.store.state();
        state.pending = Some(pinned.clone());
        state.downloaded = false;
        let _ = self.store.save_state(&state);
        Ok(pinned)
    }

    /// `update status`: the saved state plus what the channel and hold say, for the panel.
    pub fn status(&self) -> Value {
        let state: State = self.store.state();
        let choice = self.store.channel(&self.installed);
        json!({
            "installed": self.installed.to_string(),
            "channel": self.channel.as_str(),
            "channelChosen": choice.chosen,
            "onBetaBuild": choice.on_beta_build,
            "target": self.target,
            "keys": self.keys.iter().map(|k| json!({ "id": k.id, "from": k.from })).collect::<Vec<_>>(),
            "keysOverridden": keys::is_overridden(),
            "feedBaseline": policy::FEED_BASELINE,
            "dataFormat": Store::data_format(&self.data_root).ok(),
            "lastCheckAt": state.last_check_at,
            "lastResult": state.last_result,
            "pending": state.pending.as_ref().map(Pinned::to_json),
            "downloaded": state.downloaded,
            "staleFeed": state.stale_feed,
            "hold": self.store.hold().map(|v| v.to_string()),
            "sources": self.sources.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            // Linux: what to run to install the verified download (the app never installs it)
            "installCommand": pending_install_command(self.store),
        })
    }
}

/// One row of the rollback list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackEntry {
    pub version: String,
    pub tag: String,
    pub data_format: u32,
    pub allowed: bool,
    pub reason: Option<String>,
}

impl RollbackEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "version": self.version,
            "tag": self.tag,
            "dataFormat": self.data_format,
            "allowed": self.allowed,
            "reason": self.reason,
        })
    }
}

enum Step {
    Unreachable(String),
    Refused(Refusal),
}

/// What one pass over the candidates produced.
#[derive(Default)]
struct Walk {
    offer: Option<Pinned>,
    blocked: Option<String>,
    stale: bool,
    /// A candidate asked for a lower release first.
    hop_needed: bool,
}

/// SHA-512 of `bytes`, lower-case hex (the envelope's `sha512`).
pub fn sha512_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha512::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The artifact checks the plugin makes, for the headless path and for a cached copy: minisign
/// signature with the pinned key, the signed version in its trusted comment, and the envelope's
/// sha512. `Ok` means the bytes are exactly the release's artifact.
pub fn verify_artifact(bytes: &[u8], pinned: &Pinned, keys: &[TrustedKey]) -> Result<(), String> {
    let Some(sig) = pinned.signature.as_deref() else {
        // Linux packages carry no minisign signature (the package manager installs them, design
        // 5.7): the signed envelope's size and sha512 are what bind the bytes. Every other
        // platform's artifact is run by this program and must be signed.
        if !pinned.target.starts_with("linux-") {
            return Err(format!("the {} artifact carries no signature", pinned.target));
        }
        return check_size_and_digest(bytes, pinned);
    };
    let key = keys
        .iter()
        .find(|k| k.id == pinned.key_id)
        .ok_or_else(|| format!("key {} is not trusted by this build", pinned.key_id))?;
    if !envelope::is_file_name(&pinned.file) {
        return Err(format!("`{}` is not an asset file name", pinned.file));
    }
    let (signature, _) = envelope::verify_signature(bytes, sig, std::slice::from_ref(key))
        .map_err(|r| format!("artifact signature: {r}"))?;
    // the signature's own comment binds it to this file and this version (design 5.3)
    let want = Version::parse(&pinned.version).map_err(|e| e.to_string())?;
    envelope::check_trusted_comment(signature.trusted_comment(), &pinned.file, &want)
        .map_err(|r| format!("artifact signature: {r}"))?;
    check_size_and_digest(bytes, pinned)
}

/// The envelope's size and sha512 for `bytes`.
fn check_size_and_digest(bytes: &[u8], pinned: &Pinned) -> Result<(), String> {
    if bytes.len() as u64 != pinned.size {
        return Err(format!(
            "the artifact is {} bytes, the feed said {}",
            bytes.len(),
            pinned.size
        ));
    }
    let digest = sha512_hex(bytes);
    if digest != pinned.sha512 {
        return Err("the artifact's sha512 does not match the feed".to_string());
    }
    Ok(())
}

/// Headless install (`spawnloft update apply`, design 5.1): download, verify, cache, and on
/// Windows run the installer silently. Returns what was done.
pub fn apply(ctx: &Context<'_>, pinned: &Pinned, run_installer: bool) -> Result<String, String> {
    // a headless spawnloft-cli box never downloads the desktop package the envelope names
    if cfg!(target_os = "linux") && linux_cli_install() {
        return Ok(linux_cli_notice(pinned, linux_package_kind()));
    }
    let cached = ctx.store.cache_file(&pinned.version, &pinned.file);
    let bytes = match std::fs::read(&cached) {
        Ok(b) if verify_artifact(&b, pinned, &ctx.keys).is_ok() => {
            ctx.store.log(
                "cache-hit",
                &[("version", &pinned.version), ("file", &pinned.file)],
            );
            b
        }
        _ => {
            ctx.store.remove_cached(&pinned.version);
            ctx.store
                .log("download", &[("version", &pinned.version), ("url", &pinned.url)]);
            // the envelope named the size: a body past it is refused before it is in memory
            let cap = usize::try_from(pinned.size.min(ARTIFACT_CAP as u64)).unwrap_or(usize::MAX);
            let b = ctx
                .fetch
                .download(&pinned.url, cap)
                .map_err(|e| format!("download failed: {e}"))?;
            if let Err(why) = verify_artifact(&b, pinned, &ctx.keys) {
                ctx.store
                    .log("download-refused", &[("version", &pinned.version), ("why", &why)]);
                return Err(why);
            }
            ctx.store
                .store_artifact(&pinned.version, &pinned.file, &b, CACHE_KEEP)
                .map_err(|e| format!("could not keep the download: {e}"))?;
            ctx.store.log(
                "downloaded",
                &[
                    ("version", &pinned.version),
                    ("bytes", &b.len().to_string()),
                    ("sha512", "ok"),
                ],
            );
            b
        }
    };
    let mut state = ctx.store.state();
    if state
        .pending
        .as_ref()
        .is_some_and(|p| p.version == pinned.version)
    {
        state.downloaded = true;
        let _ = ctx.store.save_state(&state);
    }
    if !run_installer {
        return Ok(format!(
            "{} verified and kept at {}",
            pinned.version,
            cached.display()
        ));
    }
    if cfg!(windows) {
        let mut args = vec!["/S", "/UPDATE"];
        if pinned.rollback {
            args.push("/ROLLBACK");
        }
        ctx.store.log(
            "install",
            &[("version", &pinned.version), ("args", &args.join(" "))],
        );
        let mut cmd = std::process::Command::new(&cached);
        cmd.args(&args);
        cmd.spawn()
            .map_err(|e| format!("could not start the installer: {e}"))?;
        Ok(format!("installing {} ({} bytes)", pinned.version, bytes.len()))
    } else if cfg!(target_os = "linux") {
        // the package manager installs it (Q-F); the bytes are verified, so the command names them
        Ok(format!(
            "{} verified and kept at {}; install it with: {}",
            pinned.version,
            cached.display(),
            linux_install_command(linux_package_kind(), &cached, pinned.rollback)
        ))
    } else {
        Ok(format!(
            "{} verified and kept at {}; open SpawnLoft to install it (the window replaces the app bundle)",
            pinned.version,
            cached.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::envelope::testkit::*;
    use super::fetch::testkit::FakeFetch;
    use super::*;

    struct Fixture {
        key: TestKey,
        fetch: FakeFetch,
        source: Source,
        store: Store,
    }

    fn atom(tags: &[&str]) -> String {
        let mut xml = String::from("<feed>");
        for t in tags {
            xml.push_str(&format!(
                "<entry><link rel=\"alternate\" href=\"https://github.com/joogiebear/spawnloft/releases/tag/{t}\"/></entry>"
            ));
        }
        xml.push_str("</feed>");
        xml
    }

    impl Fixture {
        fn new(label: &str, tags: &[&str]) -> Fixture {
            let dir = std::env::temp_dir().join(format!("sl-update-check-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let mut fetch = FakeFetch::default();
            let source = Source {
                name: "test".into(),
                atom: "https://feed.test/releases.atom".into(),
                api: "https://feed.test/api/releases".into(),
                download: BASE.into(),
            };
            fetch.put(source.atom.clone(), atom(tags));
            Fixture {
                key: TestKey::generate(),
                fetch,
                source,
                store: Store::new(dir),
            }
        }

        fn publish(&mut self, version: &str, edit: impl FnOnce(&mut serde_json::Map<String, Value>)) {
            let (bytes, sig) = signed(&self.key, version, edit);
            let tag = format!("v{version}");
            self.fetch
                .put(self.source.asset(&tag, envelope::FILE_NAME), bytes);
            self.fetch.put(
                self.source.asset(&tag, "spawnloft-updates.json.sig"),
                sig.into_bytes(),
            );
        }

        fn ctx(&self, installed: &str) -> Context<'_> {
            Context {
                installed: Version::parse(installed).unwrap(),
                channel: Channel::Beta,
                store: &self.store,
                data_root: self.store.dir.join("data"),
                keys: vec![self.key.trusted.clone()],
                sources: vec![self.source.clone()],
                fetch: &self.fetch,
                now_secs: crate::time::parse_iso_utc("2026-12-02T00:00:00Z").unwrap(),
                target: "windows-x86_64".into(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.store.dir);
        }
    }

    #[test]
    fn offers_the_highest_verified_release_whatever_the_feed_order() {
        let mut f = Fixture::new(
            "order",
            &[
                "v2.0.0-beta.2",
                "v1.6.0-beta.413",
                "v2.0.0-next.9",
                "v2.0.0-beta.4",
                "v2.0.0-beta.3",
            ],
        );
        f.publish("2.0.0-beta.3", |_| {});
        f.publish("2.0.0-beta.4", |_| {});
        let report = f.ctx("2.0.0-beta.2").check();
        let Outcome::Update(p) = &report.outcome else {
            panic!("{report:?}")
        };
        assert_eq!(p.version, "2.0.0-beta.4");
        assert_eq!(p.file, "SpawnLoft-Setup-2.0.0-beta.4.exe");
        assert_eq!(p.key_id, f.key.trusted.id);
        assert!(!p.rollback);
        // only the newest envelope was fetched
        assert!(!f.fetch.calls.borrow().iter().any(|u| u.contains("beta.3/")));
        let state = f.store.state();
        assert_eq!(state.pending.as_ref().unwrap().version, "2.0.0-beta.4");
        assert_eq!(
            state.last_accepted_generated_at.as_deref(),
            Some("2026-12-01T18:02:11Z")
        );
        assert!(
            f.store
                .log_tail(10)
                .iter()
                .any(|l| l.contains("result=\"update 2.0.0-beta.4\""))
        );
    }

    #[test]
    fn a_release_without_an_envelope_is_skipped_and_the_next_one_taken() {
        let mut f = Fixture::new("missing", &["v2.0.0-beta.5", "v2.0.0-beta.4", "v2.0.0-beta.2"]);
        f.publish("2.0.0-beta.4", |_| {});
        let report = f.ctx("2.0.0-beta.2").check();
        let Outcome::Update(p) = &report.outcome else {
            panic!("{report:?}")
        };
        assert_eq!(p.version, "2.0.0-beta.4");
        assert!(
            report
                .steps
                .iter()
                .any(|s| s.contains("v2.0.0-beta.5: no update feed"))
        );
    }

    #[test]
    fn up_to_date_when_nothing_is_above() {
        let mut f = Fixture::new("current", &["v2.0.0-beta.4", "v2.0.0-beta.3"]);
        f.publish("2.0.0-beta.4", |_| {});
        assert_eq!(f.ctx("2.0.0-beta.4").check().outcome, Outcome::UpToDate);
        assert_eq!(f.ctx("2.1.0").check().outcome, Outcome::UpToDate);
        assert_eq!(f.store.state().pending, None);
    }

    #[test]
    fn a_tampered_newest_envelope_makes_the_source_fail_closed() {
        let mut f = Fixture::new("tamper", &["v2.0.0-beta.4", "v2.0.0-beta.3"]);
        f.publish("2.0.0-beta.3", |_| {});
        f.publish("2.0.0-beta.4", |_| {});
        // flip a byte of beta.4's envelope after signing
        let url = f.source.asset("v2.0.0-beta.4", envelope::FILE_NAME);
        let mut bytes = f.fetch.files[&url].clone();
        let n = bytes.len();
        bytes[n - 3] ^= 1;
        f.fetch.put(url, bytes);
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("refused (signature)")),
            "{report:?}"
        );
        // beta.3 was never offered in its place
        assert!(!f.fetch.calls.borrow().iter().any(|u| u.contains("beta.3/")));
        assert!(
            f.store
                .log_tail(10)
                .iter()
                .any(|l| l.contains("refused") && l.contains("code=signature"))
        );
        assert_eq!(f.store.state().pending, None);
    }

    #[test]
    fn wrong_key_and_wrong_comment_are_refused() {
        let mut f = Fixture::new("wrongkey", &["v2.0.0-beta.4"]);
        let other = TestKey::generate();
        let bytes = envelope_json(&other.trusted.id, "2.0.0-beta.4", |_| {});
        let sig = other.sign(&bytes, envelope::FILE_NAME, "2.0.0-beta.4");
        f.fetch.put(
            f.source.asset("v2.0.0-beta.4", envelope::FILE_NAME),
            bytes.clone(),
        );
        f.fetch.put(
            f.source.asset("v2.0.0-beta.4", "spawnloft-updates.json.sig"),
            sig.into_bytes(),
        );
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("refused (signature)")),
            "{report:?}"
        );

        let sig = f.key.sign(
            &envelope_json(&f.key.trusted.id, "2.0.0-beta.4", |_| {}),
            "SpawnLoft-Setup-2.0.0-beta.4.exe",
            "2.0.0-beta.4",
        );
        f.fetch.put(
            f.source.asset("v2.0.0-beta.4", envelope::FILE_NAME),
            envelope_json(&f.key.trusted.id, "2.0.0-beta.4", |_| {}),
        );
        f.fetch.put(
            f.source.asset("v2.0.0-beta.4", "spawnloft-updates.json.sig"),
            sig.into_bytes(),
        );
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("refused (trusted-comment)")),
            "{report:?}"
        );
    }

    #[test]
    fn replayed_feed_is_refused_after_a_newer_one_was_accepted() {
        let mut f = Fixture::new("replay", &["v2.0.0-beta.4", "v2.0.0-beta.3"]);
        f.publish("2.0.0-beta.4", |m| {
            m.insert("generatedAt".into(), "2026-12-01T20:00:00Z".into());
        });
        assert!(matches!(
            f.ctx("2.0.0-beta.2").check().outcome,
            Outcome::Update(_)
        ));
        // the host now serves an older envelope under a higher version
        f.fetch
            .put(f.source.atom.clone(), atom(&["v2.0.0-beta.5", "v2.0.0-beta.4"]));
        f.publish("2.0.0-beta.5", |m| {
            m.insert("generatedAt".into(), "2026-12-01T19:00:00Z".into());
        });
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("replayed")),
            "{report:?}"
        );
        // the earlier offer is kept while its release is still listed
        assert_eq!(f.store.state().pending.unwrap().version, "2.0.0-beta.4");
        // the accepted release disappears from the listing (taken down): the offer is withdrawn,
        // and the floor stands, so the older beta.3 is still refused
        f.fetch.put(f.source.atom.clone(), atom(&["v2.0.0-beta.3"]));
        f.publish("2.0.0-beta.3", |_| {});
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("replayed")),
            "{report:?}"
        );
        assert_eq!(f.store.state().pending, None);
        assert!(f.store.log_tail(50).iter().any(|l| l.contains("offer-withdrawn")));
    }

    #[test]
    fn a_future_dated_feed_is_refused() {
        let mut f = Fixture::new("future", &["v2.0.0-beta.4"]);
        f.publish("2.0.0-beta.4", |m| {
            m.insert("generatedAt".into(), "2026-12-10T00:00:00Z".into());
        });
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("refused (future)")),
            "{report:?}"
        );
        assert_eq!(f.store.state().last_accepted_generated_at, None);
    }

    #[test]
    fn a_release_taken_down_withdraws_its_offer() {
        let mut f = Fixture::new("yanked", &["v2.0.0-beta.4", "v2.0.0-beta.3"]);
        f.publish("2.0.0-beta.4", |_| {});
        f.publish("2.0.0-beta.3", |_| {});
        assert!(matches!(
            f.ctx("2.0.0-beta.2").check().outcome,
            Outcome::Update(_)
        ));
        // the tag stays listed but its feed is gone
        f.fetch
            .remove(&f.source.asset("v2.0.0-beta.4", envelope::FILE_NAME));
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Update(ref p) if p.version == "2.0.0-beta.3"),
            "{report:?}"
        );
        assert_eq!(f.store.state().pending.unwrap().version, "2.0.0-beta.3");
    }

    #[test]
    fn a_frozen_feed_is_reported_stale() {
        let mut f = Fixture::new("frozen", &["v2.0.0-beta.4", "v2.0.0-beta.3"]);
        f.publish("2.0.0-beta.4", |m| {
            m.insert("expiresAt".into(), "2026-11-20T00:00:00Z".into());
        });
        let report = f.ctx("2.0.0-beta.4").check();
        assert_eq!(report.outcome, Outcome::UpToDate);
        assert!(report.stale, "{report:?}");
        assert!(f.store.state().stale_feed);
        // a listing with nothing at or below the installed version is stale too
        let report = f.ctx("2.1.0").check();
        assert_eq!(report.outcome, Outcome::UpToDate);
        assert!(report.stale, "{report:?}");
        // a current envelope for the installed release is not
        f.publish("2.0.0-beta.4", |_| {});
        let report = f.ctx("2.0.0-beta.4").check();
        assert!(!report.stale, "{report:?}");
        // and a tampered one fails the source like the walk would
        let url = f.source.asset("v2.0.0-beta.4", envelope::FILE_NAME);
        let mut bytes = f.fetch.files[&url].clone();
        let n = bytes.len();
        bytes[n - 3] ^= 1;
        f.fetch.put(url, bytes);
        assert!(matches!(
            f.ctx("2.0.0-beta.4").check().outcome,
            Outcome::Unreachable(_)
        ));
    }

    #[test]
    fn baseline_refuses_a_replay_on_a_fresh_install() {
        let mut f = Fixture::new("baseline", &["v2.0.0-beta.4"]);
        f.publish("2.0.0-beta.4", |m| {
            m.insert("generatedAt".into(), "2026-11-01T00:00:00Z".into());
        });
        let report = f.ctx("2.0.0-beta.2").check();
        assert!(
            matches!(report.outcome, Outcome::Unreachable(ref w) if w.contains("replayed")),
            "{report:?}"
        );
    }

    #[test]
    fn min_version_walks_down_to_a_hop() {
        let mut f = Fixture::new("hop", &["v2.2.0", "v2.1.0", "v2.0.0"]);
        f.publish("2.2.0", |m| {
            m.insert("minVersion".into(), "2.1.0".into());
        });
        f.publish("2.1.0", |m| {
            m.insert("minVersion".into(), "2.0.0".into());
        });
        let report = f.ctx("2.0.0").check();
        let Outcome::Update(p) = &report.outcome else {
            panic!("{report:?}")
        };
        assert_eq!(p.version, "2.1.0");
        assert!(
            report
                .steps
                .iter()
                .any(|s| s.contains("v2.2.0: needs 2.1.0 first"))
        );
        // and once on 2.1.0, 2.2.0 is offered
        let Outcome::Update(p) = f.ctx("2.1.0").check().outcome else {
            panic!()
        };
        assert_eq!(p.version, "2.2.0");
        // with no hop available the check is blocked and says so
        let mut g = Fixture::new("nohop", &["v2.2.0", "v2.0.0"]);
        g.publish("2.2.0", |m| {
            m.insert("minVersion".into(), "2.1.0".into());
        });
        assert!(
            matches!(g.ctx("2.0.0").check().outcome, Outcome::Blocked(ref w) if w.contains("needs at least 2.1.0"))
        );
    }

    #[test]
    fn data_format_above_the_feed_blocks() {
        let mut f = Fixture::new("dataformat", &["v2.0.0-beta.4"]);
        f.publish("2.0.0-beta.4", |_| {});
        std::fs::create_dir_all(f.store.dir.join("data")).unwrap();
        std::fs::write(f.store.dir.join("data/data-format.json"), br#"{"format":2}"#).unwrap();
        assert!(
            matches!(f.ctx("2.0.0-beta.2").check().outcome, Outcome::Blocked(ref w) if w.contains("data format"))
        );
    }

    #[test]
    fn hold_then_a_newer_release_clears_it() {
        let mut f = Fixture::new("hold", &["v2.1.0", "v2.0.1", "v2.0.0"]);
        f.publish("2.1.0", |_| {});
        f.publish("2.0.1", |_| {});
        f.store.set_hold(&Version::parse("2.1.0").unwrap()).unwrap();
        let report = f.ctx("2.0.0").check();
        assert_eq!(report.outcome, Outcome::UpToDate);
        assert!(report.steps.iter().any(|s| s.contains("v2.1.0: held")));
        assert!(f.store.hold().is_some());
        f.fetch
            .put(f.source.atom.clone(), atom(&["v2.1.1", "v2.1.0", "v2.0.0"]));
        f.publish("2.1.1", |_| {});
        let Outcome::Update(p) = f.ctx("2.0.0").check().outcome else {
            panic!()
        };
        assert_eq!(p.version, "2.1.1");
        assert_eq!(f.store.hold(), None);
    }

    #[test]
    fn api_pages_are_read_when_the_atom_window_is_all_newer() {
        let mut f = Fixture::new("api", &["v2.0.9", "v2.0.8"]);
        f.publish("2.0.9", |m| {
            m.insert("minVersion".into(), "2.0.5".into());
        });
        f.publish("2.0.8", |m| {
            m.insert("minVersion".into(), "2.0.5".into());
        });
        f.publish("2.0.5", |m| {
            m.insert("minVersion".into(), "2.0.0".into());
        });
        f.fetch.put(
            format!("{}?per_page=100&page=1", f.source.api),
            br#"[{"tag_name":"v2.0.9"},{"tag_name":"v2.0.8"},{"tag_name":"v2.0.5"},{"tag_name":"v2.0.0"},{"tag_name":"v1.5.0"}]"#.to_vec(),
        );
        let Outcome::Update(p) = f.ctx("2.0.0").check().outcome else {
            panic!()
        };
        assert_eq!(p.version, "2.0.5");
    }

    #[test]
    fn unreachable_when_nothing_answers() {
        let f = Fixture::new("down", &[]);
        let mut g = f.ctx("2.0.0");
        g.sources[0].atom = "https://feed.test/nope.atom".into();
        let report = g.check();
        assert!(matches!(report.outcome, Outcome::Unreachable(_)), "{report:?}");
        assert!(!report.to_json()["ok"].as_bool().unwrap());
    }

    #[test]
    fn rollback_list_and_plan() {
        let mut f = Fixture::new("rollback", &["v2.1.0", "v2.0.1", "v2.0.0", "v2.0.0-beta.9"]);
        f.publish("2.0.1", |_| {});
        f.publish("2.0.0", |m| {
            m.insert("dataFormat".into(), 1.into());
        });
        f.publish("2.0.0-beta.9", |_| {});
        std::fs::create_dir_all(f.store.dir.join("data")).unwrap();
        std::fs::write(f.store.dir.join("data/data-format.json"), br#"{"format":1}"#).unwrap();
        let list = f.ctx("2.1.0").rollback_candidates().unwrap();
        let versions: Vec<&str> = list.iter().map(|e| e.version.as_str()).collect();
        assert_eq!(versions, ["2.0.1", "2.0.0", "2.0.0-beta.9"]);
        assert!(list.iter().all(|e| e.allowed));

        let ctx = f.ctx("2.1.0");
        let pinned = ctx
            .plan_rollback(&Version::parse("2.0.1").unwrap(), false)
            .unwrap();
        assert!(pinned.rollback);
        assert_eq!(pinned.version, "2.0.1");
        assert_eq!(f.store.hold().unwrap().to_string(), "2.1.0");
        // a second rollback (2.0.1 to 2.0.0-beta.9) keeps the higher hold
        f.ctx("2.0.1")
            .plan_rollback(&Version::parse("2.0.0-beta.9").unwrap(), false)
            .unwrap();
        assert_eq!(f.store.hold().unwrap().to_string(), "2.1.0");
        assert!(
            ctx.plan_rollback(&Version::parse("2.1.0").unwrap(), false)
                .is_err()
        );
        assert!(
            ctx.plan_rollback(&Version::parse("2.5.0").unwrap(), false)
                .is_err()
        );
        assert!(
            ctx.plan_rollback(&Version::parse("2.0.0-next.1").unwrap(), false)
                .is_err()
        );

        // a data folder on format 2 disables format-1 releases unless forced
        std::fs::write(f.store.dir.join("data/data-format.json"), br#"{"format":2}"#).unwrap();
        let list = f.ctx("2.1.0").rollback_candidates().unwrap();
        assert!(list.iter().all(|e| !e.allowed), "{list:?}");
        assert!(
            f.ctx("2.1.0")
                .plan_rollback(&Version::parse("2.0.1").unwrap(), false)
                .is_err()
        );
        assert!(
            f.ctx("2.1.0")
                .plan_rollback(&Version::parse("2.0.1").unwrap(), true)
                .is_ok()
        );
    }

    #[test]
    fn pinned_round_trips_and_builds_the_plugin_manifest() {
        let key = TestKey::generate();
        let env = envelope::parse(&envelope_json(&key.trusted.id, "2.0.0-beta.3", |_| {}), beta()).unwrap();
        let (target, entry) = platform_entry(&env, "windows-x86_64").unwrap();
        let p = Pinned::from(&env, &key.trusted, target, entry, false);
        assert_eq!(Pinned::from_json(&p.to_json()).unwrap(), p);
        let m = p.plugin_manifest();
        assert_eq!(m["version"], "2.0.0-beta.3");
        assert_eq!(m["platforms"]["windows-x86_64"]["url"], p.url);
        assert_eq!(m["platforms"]["windows-x86_64-nsis"]["signature"], "ZmFrZQ==");
        assert!(
            platform_entry(&env, "linux-x86_64").is_some()
                || !cfg!(target_os = "linux")
                || !std::path::Path::new("/etc/debian_version").exists()
        );
    }

    #[test]
    fn linux_install_command_names_the_verified_file_and_quotes_it() {
        use std::path::Path;
        assert_eq!(
            linux_install_command(
                "deb",
                Path::new("/home/a/.config/spawnloft/updates/2.0.1/SpawnLoft-2.0.1-linux-amd64.deb"),
                false
            ),
            "sudo apt install /home/a/.config/spawnloft/updates/2.0.1/SpawnLoft-2.0.1-linux-amd64.deb"
        );
        assert_eq!(
            linux_install_command("rpm", Path::new("/home/a b/it's.rpm"), false),
            "sudo dnf install '/home/a b/it'\\''s.rpm'"
        );
        assert_eq!(
            linux_install_command("rpm", Path::new("/t/x.rpm"), true),
            "sudo dnf downgrade /t/x.rpm"
        );
        assert_eq!(
            linux_install_command("deb", Path::new("/t/x.deb"), true),
            "sudo apt install --allow-downgrades /t/x.deb"
        );
    }

    #[test]
    fn a_cli_box_is_pointed_at_the_cli_package_of_the_same_release() {
        let key = TestKey::generate();
        let env = envelope::parse(&envelope_json(&key.trusted.id, "2.0.0-beta.3", |_| {}), beta()).unwrap();
        let (target, entry) = platform_entry(&env, "windows-x86_64").unwrap();
        let p = Pinned::from(&env, &key.trusted, target, entry, false);
        let notice = linux_cli_notice(&p, "deb");
        let (base, _) = p.url.rsplit_once('/').unwrap();
        assert!(
            notice.contains(&format!("{base}/spawnloft-cli-2.0.0-beta.3-linux-")),
            "{notice}"
        );
        assert!(
            notice.contains(".deb and install it with: sudo apt install ./spawnloft-cli-2.0.0-beta.3-linux-"),
            "{notice}"
        );
        assert!(linux_cli_notice(&p, "rpm").contains("sudo dnf install ./spawnloft-cli-"));
    }

    #[test]
    fn a_linux_package_is_bound_by_the_envelope_and_nothing_else_goes_unsigned() {
        let key = TestKey::generate();
        let package = b"deb bytes".to_vec();
        let sha = sha512_hex(&package);
        let env = envelope::parse(
            &envelope_json(&key.trusted.id, "2.0.0-beta.3", |m| {
                m["platforms"]["linux-x86_64-deb"]["sha512"] = sha.clone().into();
                m["platforms"]["linux-x86_64-deb"]["size"] = (package.len() as u64).into();
            }),
            beta(),
        )
        .unwrap();
        let (target, entry) = platform_entry(&env, "linux-x86_64-deb").unwrap();
        let p = Pinned::from(&env, &key.trusted, target, entry, false);
        assert!(p.signature.is_none());
        let keys = vec![key.trusted.clone()];
        assert_eq!(verify_artifact(&package, &p, &keys), Ok(()));
        assert!(
            verify_artifact(b"deb bytez", &p, &keys)
                .unwrap_err()
                .contains("sha512")
        );
        assert!(
            verify_artifact(b"longer deb bytes", &p, &keys)
                .unwrap_err()
                .contains("bytes")
        );
        // a record for a platform whose artifact this program runs is never taken unsigned
        let mut windows = p.clone();
        windows.target = "windows-x86_64".into();
        assert!(
            verify_artifact(&package, &windows, &keys)
                .unwrap_err()
                .contains("no signature")
        );
    }

    #[test]
    fn artifact_verification_binds_signature_version_size_and_hash() {
        let key = TestKey::generate();
        let artifact = b"installer bytes".to_vec();
        let sig = key.sign(&artifact, "SpawnLoft-Setup-2.0.0-beta.3.exe", "2.0.0-beta.3");
        let sha = sha512_hex(&artifact);
        let env = envelope::parse(
            &envelope_json(&key.trusted.id, "2.0.0-beta.3", |m| {
                m["platforms"]["windows-x86_64"]["signature"] = sig.clone().into();
                m["platforms"]["windows-x86_64"]["sha512"] = sha.clone().into();
                m["platforms"]["windows-x86_64"]["size"] = (artifact.len() as u64).into();
            }),
            beta(),
        )
        .unwrap();
        let (target, entry) = platform_entry(&env, "windows-x86_64").unwrap();
        let p = Pinned::from(&env, &key.trusted, target, entry, false);
        let keys = vec![key.trusted.clone()];
        assert_eq!(verify_artifact(&artifact, &p, &keys), Ok(()));
        assert!(
            verify_artifact(b"other bytes", &p, &keys)
                .unwrap_err()
                .contains("signature")
        );
        let mut wrong_version = p.clone();
        wrong_version.version = "2.0.0-beta.4".into();
        assert!(
            verify_artifact(&artifact, &wrong_version, &keys)
                .unwrap_err()
                .contains("made for version")
        );
        let mut wrong_hash = p.clone();
        wrong_hash.sha512 = "00".repeat(64);
        assert!(
            verify_artifact(&artifact, &wrong_hash, &keys)
                .unwrap_err()
                .contains("sha512")
        );
        let mut wrong_size = p.clone();
        wrong_size.size += 1;
        assert!(
            verify_artifact(&artifact, &wrong_size, &keys)
                .unwrap_err()
                .contains("bytes")
        );
        let other = TestKey::generate();
        assert!(
            verify_artifact(&artifact, &p, &[other.trusted])
                .unwrap_err()
                .contains("not trusted")
        );
        // an artifact signed without --app-version
        let moved = key.sign_with_comment(
            &artifact,
            "timestamp:1\tfile:SpawnLoft-Setup-2.0.0-beta.2.exe\tversion:2.0.0-beta.3",
        );
        let mut moved_pin = p.clone();
        moved_pin.signature = Some(moved);
        assert!(
            verify_artifact(&artifact, &moved_pin, &keys)
                .unwrap_err()
                .contains("made for `SpawnLoft-Setup-2.0.0-beta.2.exe`")
        );
        let legacy = key.sign_with_comment(&artifact, "timestamp:1\tfile:SpawnLoft-Setup-2.0.0-beta.3.exe");
        let mut legacy_pin = p.clone();
        legacy_pin.signature = Some(legacy);
        assert!(
            verify_artifact(&artifact, &legacy_pin, &keys)
                .unwrap_err()
                .contains("no version")
        );
    }

    #[test]
    fn sha512_known_vector() {
        assert_eq!(
            sha512_hex(b"abc"),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
    }
}
