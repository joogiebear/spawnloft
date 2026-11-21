//! The cross-process lock of `util.mjs` (`acquireLock`, `lockHolder`, `withLock`), ported line
//! for line so a Rust process and a Node process exclude each other on the same file.
//!
//! The lock is a file created exclusively and holding `{"pid":<pid>,"token":"<uuid>"}`, the
//! holder's pid and a token of its own. A lock whose pid is no longer alive is taken over; a bare
//! number is the 1.x format and reads the same. Release removes the file only while it still holds
//! this holder's token. The contract, with every place that takes such a lock, is
//! `test/fixtures/contracts/locks.json`.
//!
//! Node has two waiting flavours, a blocking one and `acquireLockAsync` for a holder in the same
//! process. Rust has threads instead of one event loop, so [`acquire`] in wait mode is both: a
//! second thread polls until the first releases. Like Node, this process's own pid always reads as
//! alive, so a lock held by another thread of this process is held, never taken over.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// How long a waiter sleeps between tries.
pub const POLL_MS: u64 = 20;
/// The default wait before giving up.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// A lock file this young may still be between creation and write.
pub const WRITE_GRACE_MS: f64 = 2000.0;
/// A break lock this old was left by a process that died while clearing a stale lock.
pub const BREAK_STALE_MS: f64 = 10_000.0;
/// The pause after a busy error (Windows: a just-deleted file that is not gone yet).
pub const BUSY_PAUSE_MS: u64 = 5;
/// Tries in one `try_lock` before an unopenable lock file is reported as held.
pub const MAX_ATTEMPTS: u32 = 60;
/// From this try on a stale lock is no longer broken, only reported.
const BREAK_ATTEMPTS: u32 = 5;
// fs.rmSync's { maxRetries: 10, retryDelay: 10 }
const RM_RETRIES: u32 = 10;
const RM_RETRY_DELAY_MS: u64 = 10;

/// `mode` of `acquireLock`: wait until the timeout, or give up at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Wait,
    /// For a start or install, where a silently queued second attempt is worse than being told
    /// to retry.
    Fail,
}

/// The options of `acquireLock`; the default is `{ mode: 'wait', timeoutMs: 10000 }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub mode: Mode,
    pub timeout_ms: u64,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            mode: Mode::Wait,
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

impl Options {
    pub fn fail() -> Self {
        Options {
            mode: Mode::Fail,
            ..Options::default()
        }
    }

    pub fn wait(timeout_ms: u64) -> Self {
        Options {
            mode: Mode::Wait,
            timeout_ms,
        }
    }
}

/// Why a lock was not taken, with Node's message for each.
#[derive(Debug)]
pub enum LockError {
    /// Wait mode ran out of time. `holder` is the pid last seen, if any.
    TimedOut { file: PathBuf, holder: Option<u64> },
    /// `withLock` in fail mode found it held.
    NotGot { file: PathBuf },
    /// A file system error Node would have thrown.
    Io(io::Error),
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Node interpolates a null holder as "null"
            LockError::TimedOut { file, holder } => {
                let holder = holder.map_or_else(|| "null".to_string(), |p| p.to_string());
                write!(
                    f,
                    "timed out waiting for lock {} (held by pid {holder})",
                    file.display()
                )
            }
            LockError::NotGot { file } => write!(f, "could not get a lock on {}", file.display()),
            LockError::Io(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for LockError {}

impl From<io::Error> for LockError {
    fn from(e: io::Error) -> Self {
        LockError::Io(e)
    }
}

/// A held lock. [`Lock::release`] lets go and reports a failure; dropping it lets go too, quietly,
/// so a panic or an early return does not leave the lock to wait for this process to exit.
#[derive(Debug)]
pub struct Lock {
    file: PathBuf,
    token: String,
    released: bool,
}

impl Lock {
    pub fn file(&self) -> &Path {
        &self.file
    }

    /// The token this holder wrote, which release checks.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Removes the lock if it is still ours; one taken over since isn't ours to delete.
    pub fn release(mut self) -> io::Result<()> {
        self.released = true;
        release_lock(&self.file, &self.token)
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if !self.released {
            let _ = release_lock(&self.file, &self.token);
        }
    }
}

/// One try at the lock.
#[derive(Debug)]
pub enum Attempt {
    Got(Lock),
    /// Held, by this pid when it is known. `None`: being written, or unopenable.
    Held(Option<u64>),
}

/// The record a holder writes: `JSON.stringify({ pid, token })`, no whitespace, no newline.
pub fn record(pid: u32, token: &str) -> String {
    serde_json::json!({ "pid": pid, "token": token }).to_string()
}

/// A random RFC 4122 version 4 UUID in lowercase, as `crypto.randomUUID()` gives.
pub fn random_uuid() -> io::Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| io::Error::other(format!("the system gave no random bytes: {e}")))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// What a lock file says: its pid and, for the current format, its token.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub pid: u64,
    /// `None` for a legacy bare pid, or a token that is not a string.
    pub token: Option<String>,
}

/// `lockRecord`: a bare number is the legacy format; `None` for an empty or damaged file (a lock
/// being written, or garbage).
pub fn parse_record(text: &str) -> Option<Record> {
    let t = js_trim(text);
    if t.is_empty() {
        return None;
    }
    if t.bytes().all(|c| c.is_ascii_digit()) {
        // Number(t): a pid past u64 is not alive either way
        return Some(Record {
            pid: t.parse().unwrap_or(u64::MAX),
            token: None,
        });
    }
    let rec: serde_json::Value = serde_json::from_str(t).ok()?;
    // Number.isInteger(rec.pid) && rec.pid > 0; JSON allows 1.0 and 1e3 for an integer
    let pid = rec.get("pid")?.as_f64()?;
    if !(pid > 0.0 && pid.fract() == 0.0) {
        return None;
    }
    let pid = if pid >= u64::MAX as f64 {
        u64::MAX
    } else {
        pid as u64
    };
    let token = rec.get("token").and_then(|v| v.as_str()).map(str::to_string);
    Some(Record { pid, token })
}

// String.prototype.trim: JavaScript's white space, which unlike Rust's includes U+FEFF (a BOM)
// and leaves out U+0085.
fn js_trim(s: &str) -> &str {
    const SPACE: &[char] = &[
        '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}', '\u{202f}',
        '\u{205f}', '\u{3000}', '\u{feff}',
    ];
    let space = |c: char| SPACE.contains(&c) || ('\u{2000}'..='\u{200a}').contains(&c);
    s.trim_matches(space)
}

// Only the pid is checked, not the program: a program check declared a live holder dead in the
// packaged Windows app. A reused pid keeps the lock held until that process exits.
fn holder_alive(rec: Option<&Record>) -> bool {
    let Some(rec) = rec else { return false };
    if rec.pid == u64::from(std::process::id()) {
        return true;
    }
    pid_alive(rec.pid)
}

// process.kill(pid, 0) refuses a pid that is not a 32-bit signed integer, which pidAlive reads
// as not alive.
fn pid_alive(pid: u64) -> bool {
    match u32::try_from(pid) {
        Ok(p) if p > 0 && p <= i32::MAX as u32 => crate::procid::alive(p),
        _ => false,
    }
}

// EPERM, EACCES and EBUSY as Node names them: Windows leaves a just-deleted file unopenable until
// the last handle closes, which fails the create when several processes take over one abandoned
// lock at once.
fn lock_busy(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    match e.raw_os_error() {
        // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
        Some(5) | Some(32) | Some(33) if cfg!(windows) => true,
        // EPERM, EACCES, EBUSY
        Some(1) | Some(13) | Some(16) if cfg!(unix) => true,
        _ => false,
    }
}

// The codes fs.rmSync retries: EBUSY, EMFILE, ENFILE, ENOTEMPTY, EPERM.
fn rm_retryable(e: &io::Error) -> bool {
    if matches!(
        e.kind(),
        io::ErrorKind::ResourceBusy | io::ErrorKind::DirectoryNotEmpty
    ) {
        return true;
    }
    match e.raw_os_error() {
        // access denied (a delete pending), sharing and lock violations, too many open files
        Some(4) | Some(5) | Some(32) | Some(33) if cfg!(windows) => true,
        Some(1) | Some(16) | Some(23) | Some(24) if cfg!(unix) => true,
        _ => false,
    }
}

// fs.rmSync(file, { force: true, maxRetries: 10, retryDelay: 10 }): a missing file is fine, a
// held one is retried with a growing pause.
fn rm_retry(file: &Path) -> io::Result<()> {
    let mut i = 1;
    loop {
        match std::fs::remove_file(file) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) if rm_retryable(&e) && i <= RM_RETRIES => {
                std::thread::sleep(Duration::from_millis(RM_RETRY_DELAY_MS * u64::from(i)));
                i += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

// fs.writeFileSync(file, text, { flag: 'wx' }): created exclusively, then written.
fn write_new(file: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file)?;
    f.write_all(text.as_bytes())
}

// readFileSync(file, 'utf8'), None on any error.
fn read_lock_text(file: &Path) -> Option<String> {
    std::fs::read(file)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

// Date.now() - mtimeMs; infinite when the file cannot be read. Negative for a clock step back,
// which reads as young, as in Node.
fn file_age_ms(file: &Path) -> f64 {
    let Ok(mtime) = std::fs::metadata(file).and_then(|m| m.modified()) else {
        return f64::INFINITY;
    };
    match SystemTime::now().duration_since(mtime) {
        Ok(d) => d.as_secs_f64() * 1000.0,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

fn breaker_path(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".break");
    PathBuf::from(s)
}

// Two waiters seeing the same dead holder must not both delete, or the second removes the live
// lock the first just took. So clearing is itself exclusive (`.break`), and the lock is removed
// only if it still reads as it did when judged dead.
fn break_stale_lock(file: &Path, seen: &str) -> io::Result<bool> {
    let breaker = breaker_path(file);
    if let Err(e) = write_new(&breaker, &std::process::id().to_string()) {
        let exists = e.kind() == io::ErrorKind::AlreadyExists;
        if !exists && !lock_busy(&e) {
            return Err(e);
        }
        if exists && file_age_ms(&breaker) > BREAK_STALE_MS {
            rm_retry(&breaker)?;
        }
        return Ok(false);
    }
    let cleared = if read_lock_text(file).as_deref() == Some(seen) {
        rm_retry(file)
    } else {
        Ok(())
    };
    // the breaker goes whatever happened; its own failure is the one reported, as in a finally
    rm_retry(&breaker)?;
    cleared.map(|()| true)
}

fn release_lock(file: &Path, token: &str) -> io::Result<()> {
    let ours = read_lock_text(file)
        .and_then(|t| parse_record(&t))
        .is_some_and(|r| r.token.as_deref() == Some(token));
    if ours { rm_retry(file) } else { Ok(()) }
}

/// `tryLock`: one go at the lock, taking over a stale one on the way.
pub fn try_lock(file: &Path) -> io::Result<Attempt> {
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let mut attempt = 0;
    loop {
        // bounded so an unopenable lock file is reported as held rather than spun on
        if attempt > MAX_ATTEMPTS {
            return Ok(Attempt::Held(None));
        }
        let this = attempt;
        attempt += 1;
        let token = random_uuid()?;
        match write_new(file, &record(std::process::id(), &token)) {
            Ok(()) => {
                return Ok(Attempt::Got(Lock {
                    file: file.to_path_buf(),
                    token,
                    released: false,
                }));
            }
            Err(e) if lock_busy(&e) => {
                std::thread::sleep(Duration::from_millis(BUSY_PAUSE_MS));
                continue;
            }
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
            Err(_) => {}
        }
        let Some(seen) = read_lock_text(file) else {
            // released between the create and the read, or briefly unreadable
            std::thread::sleep(Duration::from_millis(2));
            continue;
        };
        let rec = parse_record(&seen);
        if holder_alive(rec.as_ref()) {
            return Ok(Attempt::Held(rec.map(|r| r.pid)));
        }
        // empty: its owner is between creating and writing it, not dead until it has had time
        if rec.is_none() && file_age_ms(file) < WRITE_GRACE_MS {
            return Ok(Attempt::Held(None));
        }
        if this >= BREAK_ATTEMPTS || !break_stale_lock(file, &seen)? {
            return Ok(Attempt::Held(rec.map(|r| r.pid)));
        }
    }
}

/// `acquireLock`. Wait mode retries every 20 ms until the timeout; fail mode answers `None` at
/// once when the lock is held.
pub fn acquire(file: &Path, opts: Options) -> Result<Option<Lock>, LockError> {
    let deadline = Instant::now() + Duration::from_millis(opts.timeout_ms);
    loop {
        let holder = match try_lock(file)? {
            Attempt::Got(lock) => return Ok(Some(lock)),
            Attempt::Held(holder) => holder,
        };
        if opts.mode == Mode::Fail {
            return Ok(None);
        }
        if Instant::now() > deadline {
            return Err(LockError::TimedOut {
                file: file.to_path_buf(),
                holder,
            });
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// `lockHolder`: the pid holding a lock, or `None` if free (absent or stale). A just-created,
/// not yet written lock reads as held by -1. Read-only: never takes the lock or clears a stale one.
pub fn holder(file: &Path) -> Option<i64> {
    let text = read_lock_text(file)?;
    let Some(rec) = parse_record(&text) else {
        return (file_age_ms(file) < WRITE_GRACE_MS).then_some(-1);
    };
    // a live holder is a 32-bit pid, so it fits
    holder_alive(Some(&rec)).then(|| i64::try_from(rec.pid).unwrap_or(i64::MAX))
}

/// `withLock`: runs `f` under the lock. Fail mode that finds it held is
/// "could not get a lock on <file>". A failed release is reported over `f`'s result, as a throw
/// from Node's `finally` replaces the value.
pub fn with_lock<T>(file: &Path, opts: Options, f: impl FnOnce() -> T) -> Result<T, LockError> {
    let Some(lock) = acquire(file, opts)? else {
        return Err(LockError::NotGot {
            file: file.to_path_buf(),
        });
    };
    let out = f();
    lock.release()?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct Dir(PathBuf);
    impl Dir {
        fn new(label: &str) -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let n = N.fetch_add(1, Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!("spawnloft-lock-{label}-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // a pid that was alive a moment ago and is not now
    fn dead_pid() -> u32 {
        let exe = if cfg!(windows) { "cmd" } else { "true" };
        let mut cmd = std::process::Command::new(exe);
        if cfg!(windows) {
            cmd.args(["/c", "exit"]);
        }
        let mut child = cmd.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    fn set_old(file: &Path, ms: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(file).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_millis(ms))
            .unwrap();
    }

    fn is_uuid_v4(s: &str) -> bool {
        let b = s.as_bytes();
        s.len() == 36
            && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
            && b[14] == b'4'
            && matches!(b[19], b'8' | b'9' | b'a' | b'b')
            && s.chars()
                .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
    }

    #[test]
    fn uuids_are_lowercase_version_4() {
        let a = random_uuid().unwrap();
        assert!(is_uuid_v4(&a), "{a}");
        assert_ne!(a, random_uuid().unwrap());
    }

    #[test]
    fn writes_the_node_record_byte_for_byte() {
        let d = Dir::new("record");
        let file = d.file("sub/dir/x.lock");
        let lock = acquire(&file, Options::default()).unwrap().unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            text,
            format!(
                "{{\"pid\":{},\"token\":\"{}\"}}",
                std::process::id(),
                lock.token()
            )
        );
        assert!(is_uuid_v4(lock.token()));
        assert_eq!(holder(&file), Some(i64::from(std::process::id())));
        lock.release().unwrap();
        assert!(!file.exists());
        assert_eq!(holder(&file), None);
    }

    #[test]
    fn parses_both_formats_like_lock_record() {
        let pid = |t: &str| parse_record(t).map(|r| r.pid);
        assert_eq!(pid("123"), Some(123));
        assert_eq!(pid(" 0123\n"), Some(123));
        assert_eq!(pid("\u{feff}77"), Some(77), "a BOM is JavaScript white space");
        assert_eq!(pid("\u{85}77"), None, "U+0085 is not");
        assert_eq!(pid("0"), Some(0), "a legacy zero is a record, and a dead one");
        assert_eq!(pid(""), None);
        assert_eq!(pid("  \n"), None);
        assert_eq!(pid("12a"), None);
        assert_eq!(pid("-5"), None);
        assert_eq!(pid("{\"pid\":5,\"token\":\"t\"}"), Some(5));
        assert_eq!(pid("{\"pid\":5.0}"), Some(5));
        assert_eq!(pid("{\"pid\":5.5}"), None);
        assert_eq!(pid("{\"pid\":0}"), None);
        assert_eq!(pid("{\"pid\":\"5\"}"), None);
        assert_eq!(pid("{\"pid\":5"), None);
        assert_eq!(pid("[5]"), None);
        assert_eq!(pid("null"), None);
        let r = parse_record("{\"pid\":5,\"token\":\"abc\"}").unwrap();
        assert_eq!(r.token.as_deref(), Some("abc"));
        assert_eq!(parse_record("{\"pid\":5,\"token\":7}").unwrap().token, None);
    }

    #[test]
    fn a_live_holder_is_held_and_named() {
        let d = Dir::new("live");
        let file = d.file("x.lock");
        let lock = acquire(&file, Options::fail()).unwrap().unwrap();
        // this process's own pid counts as alive: a second taker here is refused
        assert!(acquire(&file, Options::fail()).unwrap().is_none());
        match try_lock(&file).unwrap() {
            Attempt::Held(Some(p)) => assert_eq!(p, u64::from(std::process::id())),
            other => panic!("{other:?}"),
        }
        drop(lock);
        assert!(!file.exists(), "dropping a lock releases it");
    }

    #[test]
    fn a_dead_holder_is_taken_over_in_both_formats() {
        let d = Dir::new("dead");
        let dead = dead_pid();
        for text in [dead.to_string(), record(dead, "someone-else")] {
            let file = d.file("x.lock");
            std::fs::write(&file, &text).unwrap();
            assert_eq!(holder(&file), None, "{text}");
            let lock = acquire(&file, Options::fail()).unwrap().expect("taken over");
            assert!(std::fs::read_to_string(&file).unwrap().contains(lock.token()));
            assert!(!breaker_path(&file).exists(), "the breaker is cleared");
            lock.release().unwrap();
        }
    }

    #[test]
    fn an_empty_lock_is_respected_while_young_and_taken_when_old() {
        let d = Dir::new("empty");
        let file = d.file("x.lock");
        std::fs::write(&file, "").unwrap();
        assert_eq!(holder(&file), Some(-1));
        assert!(matches!(try_lock(&file).unwrap(), Attempt::Held(None)));
        set_old(&file, 3000);
        assert_eq!(holder(&file), None);
        let lock = acquire(&file, Options::fail()).unwrap().expect("past the grace");
        lock.release().unwrap();
        // damaged text counts as empty
        std::fs::write(&file, "garbage").unwrap();
        assert_eq!(holder(&file), Some(-1));
    }

    #[test]
    fn a_fresh_breaker_blocks_a_takeover_and_a_stale_one_is_cleared() {
        let d = Dir::new("breaker");
        let file = d.file("x.lock");
        let dead = dead_pid();
        std::fs::write(&file, dead.to_string()).unwrap();
        std::fs::write(breaker_path(&file), "1").unwrap();
        match try_lock(&file).unwrap() {
            Attempt::Held(Some(p)) => assert_eq!(p, u64::from(dead)),
            other => panic!("{other:?}"),
        }
        assert!(
            breaker_path(&file).exists(),
            "a fresh breaker is left to its owner"
        );
        set_old(&breaker_path(&file), 11_000);
        // the first try clears the stale breaker and reports held; the next takes over
        assert!(matches!(try_lock(&file).unwrap(), Attempt::Held(Some(_))));
        assert!(!breaker_path(&file).exists());
        assert!(matches!(try_lock(&file).unwrap(), Attempt::Got(_)));
    }

    #[test]
    fn release_leaves_a_lock_someone_else_rewrote() {
        let d = Dir::new("token");
        let file = d.file("x.lock");
        let lock = acquire(&file, Options::default()).unwrap().unwrap();
        let other = record(std::process::id(), "not-the-same-token");
        std::fs::write(&file, &other).unwrap();
        lock.release().unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), other);
        // a legacy record has no token, so it is never ours either
        let lock = {
            std::fs::remove_file(&file).unwrap();
            acquire(&file, Options::default()).unwrap().unwrap()
        };
        std::fs::write(&file, std::process::id().to_string()).unwrap();
        lock.release().unwrap();
        assert!(file.exists());
    }

    #[test]
    fn wait_mode_times_out_with_nodes_message() {
        let d = Dir::new("timeout");
        let file = d.file("x.lock");
        let _held = acquire(&file, Options::default()).unwrap().unwrap();
        let began = Instant::now();
        let err = acquire(&file, Options::wait(100)).unwrap_err();
        assert!(began.elapsed() >= Duration::from_millis(100));
        assert_eq!(
            err.to_string(),
            format!(
                "timed out waiting for lock {} (held by pid {})",
                file.display(),
                std::process::id()
            )
        );
        std::fs::write(&file, "").unwrap();
        let err = acquire(&file, Options::wait(30)).unwrap_err();
        assert!(err.to_string().ends_with("(held by pid null)"), "{err}");
    }

    #[test]
    fn with_lock_runs_under_the_lock_and_refuses_in_fail_mode() {
        let d = Dir::new("with");
        let file = d.file("x.lock");
        let got = with_lock(&file, Options::default(), || holder(&file)).unwrap();
        assert_eq!(got, Some(i64::from(std::process::id())));
        assert!(!file.exists());
        let _held = acquire(&file, Options::default()).unwrap().unwrap();
        let err = with_lock(&file, Options::fail(), || ()).unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("could not get a lock on {}", file.display())
        );
    }

    #[test]
    fn threads_exclude_each_other_in_wait_mode() {
        let d = Dir::new("threads");
        let file = Arc::new(d.file("x.lock"));
        let count = Arc::new(d.file("count"));
        std::fs::write(&*count, "0").unwrap();
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (file, count) = (file.clone(), count.clone());
                std::thread::spawn(move || {
                    for _ in 0..25 {
                        with_lock(&file, Options::wait(30_000), || {
                            let n: u32 = std::fs::read_to_string(&*count).unwrap().trim().parse().unwrap();
                            std::fs::write(&*count, (n + 1).to_string()).unwrap();
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        assert_eq!(std::fs::read_to_string(&*count).unwrap(), "100");
    }

    // the same fixture test/contracts-locks.test.mjs holds util.mjs to
    #[test]
    fn constants_and_record_match_the_contract_fixture() {
        const FIXTURE: &str = include_str!("../../../../test/fixtures/contracts/locks.json");
        let fx: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let rules = &fx["rules"];
        let n = |k: &str| rules[k].as_f64().unwrap_or_else(|| panic!("rules.{k}"));
        assert_eq!(n("writeGraceMs"), WRITE_GRACE_MS);
        assert_eq!(rules["breaker"]["staleMs"].as_f64(), Some(BREAK_STALE_MS));
        assert_eq!(rules["breaker"]["suffix"], ".break");
        assert_eq!(n("pollMs"), POLL_MS as f64);
        assert_eq!(n("defaultTimeoutMs"), DEFAULT_TIMEOUT_MS as f64);
        assert_eq!(n("busyPauseMs"), BUSY_PAUSE_MS as f64);
        assert_eq!(n("maxAttempts"), f64::from(MAX_ATTEMPTS));
        assert_eq!(n("breakAttempts"), f64::from(BREAK_ATTEMPTS));
        assert_eq!(
            rules["rmRetry"]["maxRetries"].as_f64(),
            Some(f64::from(RM_RETRIES))
        );
        assert_eq!(
            rules["rmRetry"]["retryDelay"].as_f64(),
            Some(RM_RETRY_DELAY_MS as f64)
        );
        assert_eq!(Options::default().mode, Mode::Wait);
        assert_eq!(rules["defaultMode"], "wait");
        let re = regex::Regex::new(fx["record"]["match"].as_str().unwrap()).unwrap();
        let ours = record(std::process::id(), &random_uuid().unwrap());
        assert!(re.is_match(&ours), "{ours}");
        assert!(re.is_match(fx["record"]["example"].as_str().unwrap()));
        let example = parse_record(fx["record"]["example"].as_str().unwrap()).unwrap();
        assert_eq!(example.pid, 4242);
        let msg = |k: &str| rules["messages"][k].as_str().unwrap().to_string();
        let file = PathBuf::from("/x/y.lock");
        let timed = LockError::TimedOut {
            file: file.clone(),
            holder: Some(7),
        };
        let want = msg("timedOut")
            .replace("${file}", "/x/y.lock")
            .replace("${holder}", "7");
        assert_eq!(timed.to_string(), want);
        let not_got = LockError::NotGot { file };
        assert_eq!(not_got.to_string(), msg("notGot").replace("${file}", "/x/y.lock"));
    }

    #[test]
    fn pids_outside_32_bits_are_not_alive() {
        assert!(!pid_alive(0));
        assert!(!pid_alive(u64::from(i32::MAX as u32) + 1));
        assert!(!pid_alive(u64::MAX));
        assert!(pid_alive(u64::from(std::process::id())));
    }
}
