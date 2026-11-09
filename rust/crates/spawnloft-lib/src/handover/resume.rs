//! `handover resume` (design 2.5): starts again, through the 2.0 core, what `handover stop`
//! stopped. Databases first (each waits for ready), then servers, four at a time within a tier.
//! A failed start is recorded, never an error of the install. The scheduled tasks the stop
//! disabled are enabled again, once.

use std::collections::BTreeSet;
use std::time::Duration;

use super::{Entry, Kind, Log, PARALLEL, Record, Tasks, reenable_tasks};
use crate::time;

/// Entries younger than this may still be started by the shell's first run or `doctor --fix`.
pub const PENDING_WINDOW: Duration = Duration::from_secs(24 * 3600);

/// The 2.0 side: what starts a server and what is still registered.
pub trait Starter: Sync {
    /// Starts it and waits until it is ready (or failed).
    fn start(&self, name: &str, kind: Kind, log: &Log) -> Result<(), String>;
    /// The names in the registry now; `None` when it cannot be read (then every entry is tried).
    fn registered(&self) -> Option<BTreeSet<String>>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ResumeOptions {
    /// The shell's first run and `doctor --fix`: only entries resume never got to (or skipped),
    /// only while the record is younger than [`PENDING_WINDOW`].
    pub pending_only: bool,
    /// `/NORESUME`: mark them skipped and start nothing (tasks are still enabled again).
    pub skip_start: bool,
}

/// Which entries this run starts.
pub fn candidates(record: &Record, opts: ResumeOptions, now_ms: i64) -> Vec<usize> {
    if opts.pending_only && now_ms.saturating_sub(record.started_ms) >= PENDING_WINDOW.as_millis() as i64 {
        return Vec::new();
    }
    (0..record.servers.len())
        .filter(|&i| {
            let e = &record.servers[i];
            e.to_restart()
                && match e.start.as_deref() {
                    None => true,
                    Some("skipped") => opts.pending_only && !opts.skip_start,
                    _ => false,
                }
        })
        .collect()
}

/// Runs the resume on `record` in place.
pub fn run_resume(
    record: &mut Record,
    opts: ResumeOptions,
    starter: &dyn Starter,
    tasks: &dyn Tasks,
    log: &Log,
) {
    let picked = candidates(record, opts, time::now_ms());
    log.line(&format!(
        "handover resume{}: {} to start",
        if opts.pending_only { " (pending)" } else { "" },
        picked.len()
    ));
    if opts.skip_start {
        for &i in &picked {
            record.servers[i].start = Some("skipped".into());
        }
    } else {
        let registered = starter.registered();
        for kind in [Kind::Database, Kind::Server] {
            let tier: Vec<usize> = picked
                .iter()
                .copied()
                .filter(|&i| record.servers[i].kind == kind)
                .collect();
            for chunk in tier.chunks(PARALLEL) {
                let jobs: Vec<(usize, String)> = chunk
                    .iter()
                    .map(|&i| (i, record.servers[i].name.clone()))
                    .collect();
                let results: Vec<(usize, Result<(), String>, i64)> = std::thread::scope(|s| {
                    let handles: Vec<_> = jobs
                        .iter()
                        .map(|(i, name)| {
                            let registered = registered.as_ref();
                            s.spawn(move || {
                                let res = if registered.is_some_and(|r| !r.contains(name)) {
                                    Err("no longer registered".to_string())
                                } else {
                                    log.line(&format!("starting {} {name}", kind.as_str()));
                                    starter.start(name, kind, log)
                                };
                                (*i, res, time::now_ms())
                            })
                        })
                        .collect();
                    handles
                        .into_iter()
                        .zip(jobs.iter())
                        .map(|(h, (i, _))| {
                            h.join().unwrap_or_else(|_| {
                                (*i, Err("the start thread panicked".into()), time::now_ms())
                            })
                        })
                        .collect()
                });
                for (i, res, at) in results {
                    let e: &mut Entry = &mut record.servers[i];
                    e.started_at = Some(at);
                    match res {
                        Ok(()) => {
                            log.line(&format!("{} is running", e.name));
                            e.start = Some("running".into());
                            e.error = None;
                        }
                        Err(err) => {
                            log.line(&format!("{} did not start: {err}", e.name));
                            e.start = Some("failed".into());
                            e.error = Some(err);
                        }
                    }
                }
            }
        }
    }
    reenable_tasks(tasks, record, log);
    record.resume_exit = Some(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeStarter {
        events: Mutex<Vec<String>>,
        fails: &'static str,
        registered: Option<BTreeSet<String>>,
    }
    impl Starter for FakeStarter {
        fn start(&self, name: &str, _kind: Kind, _log: &Log) -> Result<(), String> {
            self.events.lock().unwrap().push(name.to_string());
            if name == self.fails {
                Err("port taken".into())
            } else {
                Ok(())
            }
        }
        fn registered(&self) -> Option<BTreeSet<String>> {
            self.registered.clone()
        }
    }
    struct NoTasks(Mutex<Vec<String>>);
    impl Tasks for NoTasks {
        fn enabled(&self) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("{name} {enabled}"));
            Ok(())
        }
    }

    fn record() -> Record {
        let mut r = Record::new("1.6.0-beta.413", "2.0.0", "silent", "/d");
        for (n, k, s) in [
            ("survival", Kind::Server, "stopped"),
            ("creative", Kind::Server, "was-stopped"),
            ("db", Kind::Database, "stopped"),
            ("lost", Kind::Server, "orphaned"),
            ("gone", Kind::Server, "stopped"),
        ] {
            r.servers.push(Entry::new(n, k, s));
        }
        r.tasks_disabled = vec!["backup".into()];
        r
    }

    fn starter(fails: &'static str) -> FakeStarter {
        FakeStarter {
            events: Mutex::new(Vec::new()),
            fails,
            registered: Some(
                ["survival", "creative", "db", "lost"]
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            ),
        }
    }

    #[test]
    fn databases_first_failures_recorded_tasks_back_on() {
        let mut r = record();
        let s = starter("creative");
        let t = NoTasks(Mutex::new(Vec::new()));
        run_resume(&mut r, ResumeOptions::default(), &s, &t, &Log::none());
        let ev = s.events.lock().unwrap().clone();
        assert_eq!(ev[0], "db");
        assert!(!ev.contains(&"lost".to_string()));
        assert!(!ev.contains(&"gone".to_string()), "unregistered: not started");
        let get = |n: &str| r.servers.iter().find(|e| e.name == n).unwrap().clone();
        assert_eq!(get("survival").start.as_deref(), Some("running"));
        assert_eq!(get("creative").start.as_deref(), Some("failed"));
        assert_eq!(get("creative").error.as_deref(), Some("port taken"));
        assert_eq!(get("gone").start.as_deref(), Some("failed"));
        assert_eq!(get("lost").start, None);
        assert!(get("db").started_at.unwrap() <= get("survival").started_at.unwrap());
        assert_eq!(*t.0.lock().unwrap(), vec!["backup true".to_string()]);
        assert_eq!(r.resume_exit, Some(0));

        // a second run starts nothing and does not touch the tasks again
        let s2 = starter("");
        run_resume(&mut r, ResumeOptions::default(), &s2, &t, &Log::none());
        assert!(s2.events.lock().unwrap().is_empty());
        assert_eq!(t.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn skipped_then_pending() {
        let mut r = record();
        let t = NoTasks(Mutex::new(Vec::new()));
        let s = starter("");
        run_resume(
            &mut r,
            ResumeOptions {
                skip_start: true,
                pending_only: false,
            },
            &s,
            &t,
            &Log::none(),
        );
        assert!(s.events.lock().unwrap().is_empty());
        assert!(
            r.servers
                .iter()
                .filter(|e| e.to_restart())
                .all(|e| e.start.as_deref() == Some("skipped"))
        );
        // the shell's first run picks the skipped ones up
        let pending = ResumeOptions {
            pending_only: true,
            skip_start: false,
        };
        assert_eq!(candidates(&r, pending, time::now_ms()).len(), 4);
        // but not a day later
        assert!(candidates(&r, pending, time::now_ms() + PENDING_WINDOW.as_millis() as i64).is_empty());
        // and an installer run does not restart skipped entries
        assert!(candidates(&r, ResumeOptions::default(), time::now_ms()).is_empty());
    }
}
