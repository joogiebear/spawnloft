//! `download.mjs`: fetching a file into the jar store, hashed as it arrives, and the small
//! fetches around it (`fetchRetry`, `fetchCapped`, `fetchJson`). Blocking `ureq`, no async
//! runtime; a download is cancelled through its job ([`crate::cancel`]).
//!
//! Proxy variables: Node's `fetch` reads none (`HTTPS_PROXY` and the rest are ignored unless
//! `NODE_USE_ENV_PROXY` is set, which SpawnLoft never sets), while `ureq` reads them by default.
//! So every agent here is built with the proxy turned off, and the two behave the same (checked
//! in C1, plan 6.1 and the tests below). Redirects are followed up to Node's 20, downgrades to
//! plain HTTP included, as `fetch` does.
//!
//! The words for a network failure (`getaddrinfo ENOTFOUND x` in Node) are `ureq`'s, a declared
//! difference (plan 6.1); the sentence around them is Node's.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cancel;
use crate::failure::Failure;
use crate::text::human_bytes;

/// The User-Agent every download sends.
pub const UA: &str = "SpawnLoft (github.com/joogiebear/spawnloft)";
/// Timeouts, busy or restarting servers, rate limits: worth asking again.
pub const TRANSIENT: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];
/// How long a download may go without a byte, from asking to the last one, before it is given up
/// and asked for again. A connection that dies quietly (a sleeping laptop, a router dropping
/// state) would otherwise hold its caller for ever.
pub const STALL: Duration = Duration::from_secs(30);
const DOWNLOAD_ATTEMPTS: u32 = 3;
const CHUNK: usize = 64 * 1024;

fn coded(message: impl Into<String>, code: &str) -> Failure {
    Failure::User {
        message: message.into(),
        code: Some(code.into()),
    }
}

/// The agent every fetch here uses, with `limits` applied: no proxy (as Node's `fetch`), statuses
/// handed back rather than turned into errors, Node's redirect limit.
pub(crate) fn agent(
    limits: impl FnOnce(
        ureq::config::ConfigBuilder<ureq::typestate::AgentScope>,
    ) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope>,
) -> ureq::Agent {
    let builder = ureq::Agent::config_builder()
        .proxy(None)
        .http_status_as_error(false)
        .max_redirects(20)
        .user_agent(UA);
    ureq::Agent::new_with_config(limits(builder).build())
}

/// Where a fetch is sent: the URL itself, or in a test-hooks build the parity rig's fake host.
pub(crate) fn target(url: &str) -> Result<String, String> {
    crate::test_origins::rewrite(url)
}

/// Why a request got no answer, in Node's `err.cause?.message || err.message` place.
pub(crate) fn cause(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Io(io) => io.to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn is_timeout(e: &ureq::Error) -> bool {
    match e {
        ureq::Error::Timeout(_) => true,
        ureq::Error::Io(io) => io.kind() == io::ErrorKind::TimedOut,
        _ => false,
    }
}

/// A body read failure as the `ureq` error it carries.
fn body_error(e: io::Error) -> ureq::Error {
    ureq::Error::from(e)
}

/// How [`fetch_retry`] ended without an answer.
#[derive(Debug)]
pub enum NoAnswer {
    /// Every attempt failed to get a response; the last one's error.
    Failed(ureq::Error),
    /// The job was cancelled between two attempts.
    Cancelled,
}

/// `fetchRetry`: `open` is asked again when a second request usually changes the answer (GitHub's
/// download servers return stray 504s). Refusals such as 403 and 404, and the last answer if
/// every attempt was transient, are returned at once so the caller's message names the status.
/// Only opening the response is retried; a download that breaks half way is the caller's to
/// report. The pause before attempt n+1 is `delay` × n; a cancelled job ends the retrying.
/// `retry_timeouts`: whether a time-out is an attempt to retry (Node's per-attempt `timeoutMs`)
/// or the caller giving up (a signal the caller fired, as the download's stall watchdog is).
pub fn fetch_retry(
    mut open: impl FnMut() -> Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    attempts: u32,
    delay: Duration,
    retry_timeouts: bool,
    mut on_retry: impl FnMut(u32, String),
) -> Result<ureq::http::Response<ureq::Body>, NoAnswer> {
    let mut attempt = 1;
    loop {
        let last = attempt >= attempts;
        match open() {
            Err(e) => {
                // a cancelled job is not a server having a bad moment
                if last || cancel::check_cancelled().is_err() || (!retry_timeouts && is_timeout(&e)) {
                    return Err(NoAnswer::Failed(e));
                }
                on_retry(attempt, cause(&e));
            }
            Ok(res) => {
                let status = res.status().as_u16();
                if last || !TRANSIENT.contains(&status) {
                    return Ok(res);
                }
                // an unread body holds its connection open
                drop(res);
                on_retry(attempt, format!("HTTP {status}"));
            }
        }
        if cancel::sleep(delay * attempt).is_err() {
            return Err(NoAnswer::Cancelled);
        }
        attempt += 1;
    }
}

/// `fetchCapped(url, { maxBytes, timeoutMs, attempts, label })`: a small file read into memory,
/// for bytes that are checked before anything trusts them (the signed harness list). The body is
/// counted as it arrives and the request is given up the moment it passes `max_bytes`, whatever
/// Content-Length said; one deadline covers each attempt, body included. Fails with code
/// `too-large` or `download-failed`.
pub fn fetch_capped(
    url: &str,
    max_bytes: u64,
    timeout: Duration,
    attempts: u32,
    delay: Duration,
    label: &str,
) -> Result<Vec<u8>, Failure> {
    let agent = agent(|b| b.timeout_global(Some(timeout)));
    let timed_out = format!(
        "timed out after {} s",
        crate::js::number_to_string(timeout.as_millis() as f64 / 1000.0)
    );
    let words = |e: &ureq::Error| {
        if is_timeout(e) {
            timed_out.clone()
        } else {
            cause(e)
        }
    };
    let sent = target(url).map_err(|e| coded(format!("could not reach {label}: {e}"), "download-failed"))?;
    let mut attempt = 1;
    loop {
        let last = attempt >= attempts;
        let res = agent
            .get(&sent)
            .header("User-Agent", UA)
            .header("Accept", "application/octet-stream, */*")
            .call();
        let res = match res {
            Err(e) => {
                if last {
                    return Err(coded(
                        format!("could not reach {label}: {}", words(&e)),
                        "download-failed",
                    ));
                }
                std::thread::sleep(delay * attempt);
                attempt += 1;
                continue;
            }
            Ok(r) => r,
        };
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            drop(res);
            if last || !TRANSIENT.contains(&status) {
                return Err(coded(format!("{label} answered {status}"), "download-failed"));
            }
            std::thread::sleep(delay * attempt);
            attempt += 1;
            continue;
        }
        let mut reader = res.into_body().into_reader();
        let mut body = Vec::new();
        let mut chunk = vec![0u8; CHUNK];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Ok(body),
                Ok(n) => {
                    if (body.len() + n) as u64 > max_bytes {
                        return Err(coded(
                            format!("{label} is larger than {}", human_bytes(Some(max_bytes as f64))),
                            "too-large",
                        ));
                    }
                    body.extend_from_slice(&chunk[..n]);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => {
                    let e = body_error(e);
                    return Err(coded(
                        format!("could not read {label}: {}", words(&e)),
                        "download-failed",
                    ));
                }
            }
        }
    }
}

/// `fetchJson(url, { label })`: one request with 20 seconds for all of it, the body parsed as
/// JSON (a body that is not JSON fails as `JSON.parse` does, in serde_json's words).
pub fn fetch_json(url: &str, label: &str) -> Result<serde_json::Value, Failure> {
    const ABORTED: &str = "The operation was aborted due to timeout";
    let agent = agent(|b| b.timeout_global(Some(Duration::from_secs(20))));
    let sent = target(url).map_err(|e| Failure::user(format!("could not reach {label}: {e}")))?;
    let res = agent
        .get(&sent)
        .header("User-Agent", UA)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| {
            let why = if is_timeout(&e) {
                ABORTED.to_string()
            } else {
                cause(&e)
            };
            Failure::user(format!("could not reach {label}: {why}"))
        })?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(Failure::user(format!("{label} answered {status}")));
    }
    let mut text = Vec::new();
    if let Err(e) = res.into_body().into_reader().read_to_end(&mut text) {
        let e = body_error(e);
        return Err(if is_timeout(&e) {
            Failure::Internal {
                head: "TimeoutError".into(),
                message: ABORTED.into(),
                code: None,
            }
        } else {
            Failure::Internal {
                head: "TypeError".into(),
                message: "terminated".into(),
                code: None,
            }
        });
    }
    crate::jsjson::parse(&String::from_utf8_lossy(&text)).map_err(Failure::syntax)
}

/// `partPath(dest)`: where a download is written until it is whole. One name per attempt: two
/// downloads of the same file (two setups on one Minecraft version) each write their own, and one
/// of them stopping or failing takes nothing from the other.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut b = [0u8; 4];
    // without random bytes the time stands in; the pid already keeps processes apart
    if getrandom::fill(&mut b).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        b = nanos.to_le_bytes();
    }
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let mut s = dest.as_os_str().to_os_string();
    s.push(format!(".{}-{hex}.part", std::process::id()));
    PathBuf::from(s)
}

/// `dropPart(tmp)`: removes what a stopped download had written. Never the reason the caller
/// hears about: a file Windows still holds for a moment is tried again, and then left.
pub fn drop_part(tmp: &Path) {
    for attempt in 0..6 {
        match std::fs::remove_file(tmp) {
            Ok(()) => return,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(_) if attempt < 5 => std::thread::sleep(Duration::from_millis(100 * (attempt + 1))),
            Err(_) => return,
        }
    }
}

/// A digest the publisher names. Node takes any name `crypto` knows; the port adds each as its
/// caller arrives (sha1 and md5 with the server downloads of C4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hash {
    Sha256,
    Sha512,
    Sha1,
    Md5,
}

/// A digest computed as the bytes arrive.
pub enum Hasher {
    Sha256(sha2::Sha256),
    Sha512(sha2::Sha512),
    Sha1(sha1::Sha1),
    Md5(md5::Md5),
}

impl std::fmt::Debug for Hasher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let name = match self {
            Hasher::Sha256(_) => "sha256",
            Hasher::Sha512(_) => "sha512",
            Hasher::Sha1(_) => "sha1",
            Hasher::Md5(_) => "md5",
        };
        write!(f, "Hasher({name})")
    }
}

impl Hasher {
    pub fn new(h: Hash) -> Hasher {
        use sha2::Digest;
        match h {
            Hash::Sha256 => Hasher::Sha256(sha2::Sha256::new()),
            Hash::Sha512 => Hasher::Sha512(sha2::Sha512::new()),
            Hash::Sha1 => Hasher::Sha1(sha1::Sha1::new()),
            Hash::Md5 => Hasher::Md5(md5::Md5::new()),
        }
    }
    pub fn update(&mut self, data: &[u8]) {
        use sha2::Digest;
        match self {
            Hasher::Sha256(h) => h.update(data),
            Hasher::Sha512(h) => h.update(data),
            Hasher::Sha1(h) => h.update(data),
            Hasher::Md5(h) => h.update(data),
        }
    }
    pub fn hex(self) -> String {
        use sha2::Digest;
        let bytes: Vec<u8> = match self {
            Hasher::Sha256(h) => h.finalize().to_vec(),
            Hasher::Sha512(h) => h.finalize().to_vec(),
            Hasher::Sha1(h) => h.finalize().to_vec(),
            Hasher::Md5(h) => h.finalize().to_vec(),
        };
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// What `downloadFile` is asked to check and report.
pub struct Options<'a> {
    /// The algorithm and the publisher's digest; both or neither are checked.
    pub hash: Option<Hash>,
    pub expected: Option<String>,
    /// `(received, total)` after every chunk; total is Content-Length, 0 when not given.
    pub on_progress: Option<&'a mut dyn FnMut(u64, u64)>,
    /// A body smaller than this is not what was asked for (a server jar).
    pub min_bytes: u64,
    /// How the file is named in messages; the destination path when not given.
    pub label: Option<String>,
    pub stall: Duration,
    pub attempts: u32,
    pub retry_delay: Duration,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Options {
            hash: None,
            expected: None,
            on_progress: None,
            min_bytes: 0,
            label: None,
            stall: STALL,
            attempts: DOWNLOAD_ATTEMPTS,
            retry_delay: Duration::from_millis(1500),
        }
    }
}

impl std::fmt::Debug for Options<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("hash", &self.hash)
            .field("expected", &self.expected)
            .field("min_bytes", &self.min_bytes)
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

/// What a download wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Downloaded {
    pub size: u64,
    pub size_human: String,
}

/// A failed attempt, and whether a fresh one may help (a stall, a connection cut part way); a
/// refusal, a wrong checksum and a cancelled job may not.
struct Attempt {
    failure: Failure,
    retryable: bool,
}

impl From<Failure> for Attempt {
    fn from(failure: Failure) -> Attempt {
        Attempt {
            failure,
            retryable: false,
        }
    }
}

fn retryable(message: String) -> Attempt {
    Attempt {
        failure: coded(message, "download-failed"),
        retryable: true,
    }
}

/// What the helper thread of a download hands back, in order.
enum Arrived {
    /// an attempt failed and another is coming (the watchdog winds back)
    Retry,
    /// every attempt failed, or the job was cancelled between them
    NoAnswer(NoAnswer),
    Head {
        status: u16,
        length: u64,
    },
    Chunk(Vec<u8>),
    /// the body broke part way
    Broken(ureq::Error),
    End,
}

/// The helper thread's side: asks (with retries) and passes the body on. Ends as soon as the
/// download stops listening.
fn fetch_into(agent: &ureq::Agent, url: &str, tx: &std::sync::mpsc::SyncSender<Arrived>) {
    let res = fetch_retry(
        || agent.get(url).header("User-Agent", UA).call(),
        4,
        Duration::from_millis(1500),
        false,
        |_, _| {
            let _ = tx.send(Arrived::Retry);
        },
    );
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(Arrived::NoAnswer(e));
            return;
        }
    };
    let status = res.status().as_u16();
    let length = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .map(crate::js::string_to_number)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0) as u64;
    if tx.send(Arrived::Head { status, length }).is_err() || !(200..300).contains(&status) {
        return;
    }
    let mut reader = res.into_body().into_reader();
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let sent = match reader.read(&mut chunk) {
            Ok(0) => {
                let _ = tx.send(Arrived::End);
                return;
            }
            Ok(n) => tx.send(Arrived::Chunk(chunk[..n].to_vec())),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => {
                let _ = tx.send(Arrived::Broken(body_error(e)));
                return;
            }
        };
        if sent.is_err() {
            return;
        }
    }
}

/// `downloadFile(url, dest, options)`: the body goes to a `.part` file next to `dest`, hashed as
/// it arrives, and gets its final name only once the size floor and the hash hold; a truncated
/// download would otherwise look like a jar and fail later with an opaque class-loading error.
/// A stall or a connection cut part way is asked for again, up to `attempts` times.
pub fn download_file(url: &str, dest: &Path, mut options: Options) -> Result<Downloaded, Failure> {
    let mut attempt = 1;
    loop {
        match download_once(url, dest, &mut options) {
            Ok(done) => return Ok(done),
            Err(a) if !a.retryable || attempt >= options.attempts => return Err(a.failure),
            Err(_) => {
                cancel::sleep(options.retry_delay * attempt)?;
                attempt += 1;
            }
        }
    }
}

/// The disk's own errors (full, read-only) are not the network's to retry.
fn disk_error(e: &io::Error) -> bool {
    matches!(
        crate::jspath::error_code(e).0,
        "ENOSPC" | "EROFS" | "EACCES" | "EPERM" | "EDQUOT" | "EIO"
    )
}

fn download_once(url: &str, dest: &Path, o: &mut Options) -> Result<Downloaded, Attempt> {
    let what = o.label.clone().unwrap_or_else(|| dest.display().to_string());
    cancel::check_cancelled()?;
    let stall = o.stall;
    let stalled = || {
        retryable(format!(
            "download of {what} failed: nothing arrived for {} seconds",
            (stall.as_secs_f64()).round()
        ))
    };
    // The request runs on a helper thread and hands back what arrives; this thread keeps Node's
    // watchdog (one deadline from asking, wound back by every retry and every chunk) and watches
    // for a cancel, so neither waits on a quiet connection. The agent's own time-outs only make
    // an abandoned helper end.
    let backstop = (stall > Duration::ZERO).then_some(stall + Duration::from_secs(5));
    let agent = agent(|b| {
        b.timeout_resolve(backstop)
            .timeout_connect(backstop)
            .timeout_send_request(backstop)
            .timeout_recv_response(backstop)
            .timeout_per_read(backstop)
    });
    let sent =
        target(url).map_err(|e| coded(format!("download of {what} failed: {e}"), "download-failed"))?;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Arrived>(8);
    let job = cancel::current();
    std::thread::spawn(move || cancel::with_cancel(job, || fetch_into(&agent, &sent, &tx)));

    let part_way = |why: String| retryable(format!("download of {what} failed part way: {why}"));
    let tmp = part_path(dest);
    let mut file: Option<File> = None;
    let mut digest = o.hash.map(Hasher::new);
    let mut received = 0u64;
    let mut total = 0u64;
    let wind = || (stall > Duration::ZERO).then(|| std::time::Instant::now() + stall);
    let mut deadline = wind();
    let outcome: Result<(), Attempt> = loop {
        if cancel::check_cancelled().is_err() {
            break Err(cancel::cancelled().into());
        }
        let wait = match deadline {
            Some(d) => d
                .saturating_duration_since(std::time::Instant::now())
                .min(Duration::from_millis(100)),
            None => Duration::from_millis(100),
        };
        let arrived = match rx.recv_timeout(wait) {
            Ok(a) => a,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if deadline.is_some_and(|d| std::time::Instant::now() >= d) {
                    break Err(stalled());
                }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                break Err(part_way("the connection ended".into()));
            }
        };
        match arrived {
            Arrived::Retry => deadline = wind(),
            Arrived::NoAnswer(NoAnswer::Cancelled) => break Err(cancel::cancelled().into()),
            Arrived::NoAnswer(NoAnswer::Failed(e)) => {
                if cancel::check_cancelled().is_err() {
                    break Err(cancel::cancelled().into());
                }
                if is_timeout(&e) {
                    break Err(stalled());
                }
                break Err(coded(
                    format!("download of {what} failed: {}", cause(&e)),
                    "download-failed",
                )
                .into());
            }
            Arrived::Head { status, length } => {
                // 204 and 205 have no body, which Node's `!res.body` refuses as well
                if !(200..300).contains(&status) || status == 204 || status == 205 {
                    break Err(coded(
                        format!("download of {what} failed ({status}) from {url}"),
                        "download-failed",
                    )
                    .into());
                }
                total = length;
                match File::create(&tmp) {
                    Ok(f) => file = Some(f),
                    Err(e) if disk_error(&e) => break Err(Failure::io(&e, "open", Some(&tmp)).into()),
                    Err(e) => break Err(part_way(crate::jspath::node_error(&e, "open", Some(&tmp)))),
                }
                deadline = wind();
            }
            Arrived::Chunk(chunk) => {
                deadline = wind();
                if let Some(d) = digest.as_mut() {
                    d.update(&chunk);
                }
                received += chunk.len() as u64;
                if let Some(p) = o.on_progress.as_mut() {
                    p(received, total);
                }
                let Some(f) = file.as_mut() else { continue };
                if let Err(e) = f.write_all(&chunk) {
                    break Err(if disk_error(&e) {
                        Attempt::from(Failure::io(&e, "write", None))
                    } else {
                        part_way(crate::jspath::node_error(&e, "write", None))
                    });
                }
            }
            Arrived::Broken(e) => {
                break Err(if is_timeout(&e) {
                    stalled()
                } else {
                    part_way(cause(&e))
                });
            }
            Arrived::End => {
                if let Some(f) = file.as_mut()
                    && let Err(e) = f.flush()
                {
                    break Err(Failure::io(&e, "write", None).into());
                }
                break Ok(());
            }
        }
    };
    drop(file);
    if let Err(a) = outcome {
        // stopped half way: the half is not left for a later download to trip on
        drop(rx);
        drop_part(&tmp);
        return Err(a);
    }

    let size = std::fs::metadata(&tmp)
        .map(|m| m.len())
        .map_err(|e| Failure::io(&e, "stat", Some(&tmp)))?;
    if size < o.min_bytes {
        let _ = std::fs::remove_file(&tmp);
        return Err(Failure::user(format!(
            "{what} came back {}, which is not a server jar",
            human_bytes(Some(size as f64))
        ))
        .into());
    }
    // an empty digest is none, as Node's `digest && expected` reads it
    if let (Some(d), Some(expected)) = (digest, o.expected.as_deref().filter(|e| !e.is_empty())) {
        let got = d.hex();
        if got.to_lowercase() != expected.to_lowercase() {
            let _ = std::fs::remove_file(&tmp);
            return Err(coded(
                format!("checksum mismatch for {what}\n  expected {expected}\n  got      {got}"),
                "checksum-mismatch",
            )
            .into());
        }
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let (code, text) = crate::jspath::error_code(&e);
        Failure::Internal {
            head: "Error".into(),
            message: format!(
                "{code}: {text}, rename '{}' -> '{}'",
                tmp.display(),
                dest.display()
            ),
            code: Some(code.into()),
        }
    })?;
    Ok(Downloaded {
        size,
        size_human: human_bytes(Some(size as f64)),
    })
}

#[cfg(test)]
mod tests;
