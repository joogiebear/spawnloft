//! Where the feed is read from and how (INSTALLER-UPDATER-DESIGN.md 5.2).
//!
//! A [`Source`] is one place that holds releases: the atom feed, the releases API and the download
//! prefix for `<tag>/<asset>`. The one that ships is GitHub Releases over HTTPS. A build with the
//! `internal-feed` feature (CI scenario builds only) also takes `SPAWNLOFT_UPDATE_SOURCE`, a
//! loopback `http://127.0.0.1:<port>/` base that a test serves; a release build has no override.
//!
//! [`Fetch`] is the HTTP side behind a trait so the check logic is tested against fixtures. The
//! real one is `ureq` with rustls, hard caps on body size, a global timeout per feed request and a stall timeout per artifact
//! download.

use std::fmt;
use std::time::Duration;

/// Where releases are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub name: String,
    /// `releases.atom`.
    pub atom: String,
    /// The releases API list, one page; `?per_page=100&page=<n>` is appended.
    pub api: String,
    /// Prefix every artifact URL must start with, followed by `<tag>/`.
    pub download: String,
}

impl Source {
    pub fn github() -> Source {
        Source {
            name: "github".to_string(),
            atom: "https://github.com/joogiebear/spawnloft/releases.atom".to_string(),
            api: "https://api.github.com/repos/joogiebear/spawnloft/releases".to_string(),
            download: "https://github.com/joogiebear/spawnloft/releases/download/".to_string(),
        }
    }

    /// A test server's layout: `<base>releases.atom`, `<base>api/releases`, `<base>download/`.
    pub fn from_base(base: &str) -> Source {
        let base = base.trim_end_matches('/');
        Source {
            name: "override".to_string(),
            atom: format!("{base}/releases.atom"),
            api: format!("{base}/api/releases"),
            download: format!("{base}/download/"),
        }
    }

    /// The feed sources this build consults, in order.
    pub fn configured() -> Vec<Source> {
        #[cfg(feature = "internal-feed")]
        if let Ok(base) = std::env::var("SPAWNLOFT_UPDATE_SOURCE")
            && !base.is_empty()
        {
            return vec![Source::from_base(&base)];
        }
        vec![Source::github()]
    }

    /// `<download><tag>/<file>`.
    pub fn asset(&self, tag: &str, file: &str) -> String {
        format!("{}{tag}/{file}", self.download)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    NotFound,
    Status(u16),
    TooLarge,
    Transport(String),
    /// The URL is not one this build fetches from (not HTTPS, or a loopback URL in a release build).
    Scheme(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::NotFound => write!(f, "404"),
            FetchError::Status(s) => write!(f, "HTTP {s}"),
            FetchError::TooLarge => write!(f, "the response is larger than allowed"),
            FetchError::Transport(e) => write!(f, "{e}"),
            FetchError::Scheme(u) => write!(f, "refusing to fetch {u}"),
        }
    }
}

/// One GET, the whole body, at most `cap` bytes.
pub trait Fetch {
    fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError>;

    /// The same for a release artifact (tens of megabytes): the real client times the stall, not
    /// the whole transfer, so a slow line still finishes.
    fn download(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        self.get(url, cap)
    }
}

/// Whether this build fetches from `url` at all: HTTPS always; plain HTTP only to loopback and
/// only with the `internal-feed` feature.
pub fn allowed_url(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    #[cfg(feature = "internal-feed")]
    if url.starts_with("http://127.0.0.1:") || url.starts_with("http://127.0.0.1/") {
        return true;
    }
    false
}

/// The real client.
#[derive(Debug)]
pub struct Https {
    /// Feed reads: small bodies under one end-to-end budget.
    agent: ureq::Agent,
    /// Artifact downloads: an installer does not fit in the feed budget on a slow line, so the
    /// stall is what is timed (per read), under a generous total.
    artifacts: ureq::Agent,
}

/// The end-to-end budget for one artifact download.
const ARTIFACT_BUDGET: Duration = Duration::from_secs(60 * 60);
/// A download that sends nothing for this long is given up.
const ARTIFACT_STALL: Duration = Duration::from_secs(60);

impl Default for Https {
    fn default() -> Self {
        Self::new(Duration::from_secs(30))
    }
}

impl Https {
    pub fn new(timeout: Duration) -> Https {
        let builder = || {
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .max_redirects(5)
                // a redirect must not step down to plain HTTP; the loopback test feed is the one exception
                .https_only(!cfg!(feature = "internal-feed"))
                .user_agent(format!(
                    "SpawnLoft/{} (update check)",
                    crate::build::current().version
                ))
        };
        let feed = builder().timeout_global(Some(timeout)).build();
        let artifacts = builder()
            .timeout_global(Some(ARTIFACT_BUDGET))
            .timeout_connect(Some(timeout))
            .timeout_per_read(Some(ARTIFACT_STALL))
            .build();
        Https {
            agent: ureq::Agent::new_with_config(feed),
            artifacts: ureq::Agent::new_with_config(artifacts),
        }
    }

    fn read(agent: &ureq::Agent, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        if !allowed_url(url) {
            return Err(FetchError::Scheme(url.to_string()));
        }
        let mut resp = agent
            .get(url)
            .header(
                "Accept",
                "application/octet-stream, application/json, application/atom+xml, */*",
            )
            .call()
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        match resp.status().as_u16() {
            200 => {}
            404 => return Err(FetchError::NotFound),
            other => return Err(FetchError::Status(other)),
        }
        if let Some(len) = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            && len > cap
        {
            return Err(FetchError::TooLarge);
        }
        // read one byte over the cap so an unannounced oversized body is told apart
        let bytes = resp
            .body_mut()
            .with_config()
            .limit(cap as u64 + 1)
            .read_to_vec()
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        if bytes.len() > cap {
            return Err(FetchError::TooLarge);
        }
        Ok(bytes)
    }
}

impl Fetch for Https {
    fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        Https::read(&self.agent, url, cap)
    }

    fn download(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        Https::read(&self.artifacts, url, cap)
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! An in-memory server for the check logic's tests.

    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct FakeFetch {
        pub files: HashMap<String, Vec<u8>>,
        pub fail: HashMap<String, FetchError>,
        pub calls: RefCell<Vec<String>>,
    }

    impl FakeFetch {
        pub fn remove(&mut self, url: &str) {
            self.files.remove(url);
        }

        pub fn put(&mut self, url: impl Into<String>, body: impl Into<Vec<u8>>) {
            self.files.insert(url.into(), body.into());
        }
    }

    impl Fetch for FakeFetch {
        fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
            self.calls.borrow_mut().push(url.to_string());
            if let Some(e) = self.fail.get(url) {
                return Err(e.clone());
            }
            match self.files.get(url) {
                Some(b) if b.len() > cap => Err(FetchError::TooLarge),
                Some(b) => Ok(b.clone()),
                None => Err(FetchError::NotFound),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_source_layout() {
        let s = Source::github();
        assert_eq!(
            s.asset("v2.0.0-beta.3", "spawnloft-updates.json"),
            "https://github.com/joogiebear/spawnloft/releases/download/v2.0.0-beta.3/spawnloft-updates.json"
        );
        let t = Source::from_base("http://127.0.0.1:8123/");
        assert_eq!(t.atom, "http://127.0.0.1:8123/releases.atom");
        assert_eq!(t.download, "http://127.0.0.1:8123/download/");
    }

    #[test]
    fn only_https_without_the_internal_feature() {
        assert!(allowed_url("https://github.com/x"));
        assert!(!allowed_url("http://github.com/x"));
        assert!(!allowed_url("file:///etc/passwd"));
        assert_eq!(
            allowed_url("http://127.0.0.1:9/feed"),
            cfg!(feature = "internal-feed")
        );
        assert!(!allowed_url("http://127.0.0.2:9/feed"));
    }

    #[test]
    fn the_real_client_refuses_a_disallowed_url_before_connecting() {
        let c = Https::default();
        assert!(matches!(
            c.get("http://example.invalid/x", 10),
            Err(FetchError::Scheme(_))
        ));
    }
}
