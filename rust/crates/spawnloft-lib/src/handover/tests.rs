use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct Fake {
    kind: Kind,
    status: String,
    /// ignores `stop` (scenario 3's stuck server)
    refuses: bool,
    /// the CLI fails for it (pipe fallback)
    cli_broken: bool,
}

#[derive(Default)]
struct FakeLegacy {
    servers: Mutex<BTreeMap<String, Fake>>,
    events: Mutex<Vec<String>>,
    /// a server that appears (running) after the first stop, as a task would start one
    appears: Mutex<Option<(String, Kind)>>,
}

impl FakeLegacy {
    fn with(list: &[(&str, Kind, &str)]) -> FakeLegacy {
        let f = FakeLegacy::default();
        for (n, k, s) in list {
            f.servers.lock().unwrap().insert(
                n.to_string(),
                Fake {
                    kind: *k,
                    status: s.to_string(),
                    refuses: false,
                    cli_broken: false,
                },
            );
        }
        f
    }
    fn tweak(&self, name: &str, f: impl FnOnce(&mut Fake)) {
        f(self.servers.lock().unwrap().get_mut(name).unwrap());
    }
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
    fn status(&self, name: &str) -> String {
        self.servers.lock().unwrap()[name].status.clone()
    }
}

impl Legacy for FakeLegacy {
    fn list(&self) -> Result<Vec<Listed>, String> {
        Ok(self
            .servers
            .lock()
            .unwrap()
            .iter()
            .map(|(n, f)| Listed {
                name: n.clone(),
                kind: f.kind,
                status: f.status.clone(),
                java_pid: Some(1),
                daemon_pid: Some(2),
            })
            .collect())
    }
    fn stop(&self, name: &str, cut: &Cutoff, _log: &Log) -> CliStop {
        self.events.lock().unwrap().push(format!("stop {name}"));
        let f = self.servers.lock().unwrap()[name].clone();
        if let Some((n, k)) = self.appears.lock().unwrap().take() {
            self.servers.lock().unwrap().insert(
                n,
                Fake {
                    kind: k,
                    status: "running".into(),
                    refuses: false,
                    cli_broken: false,
                },
            );
        }
        if f.cli_broken {
            return CliStop::Exited {
                code: 1,
                output: "Error: something broke".into(),
            };
        }
        if f.refuses {
            while !cut.passed() {
                std::thread::sleep(Duration::from_millis(5));
            }
            return CliStop::DeadlinePassed;
        }
        if f.status != "running" {
            return CliStop::Exited {
                code: 0,
                output: format!("\"{name}\" was not running."),
            };
        }
        self.tweak(name, |f| f.status = "stopped".into());
        CliStop::Exited {
            code: 0,
            output: format!("\"{name}\" stopped (exit code 0)."),
        }
    }
    fn pipe_stop(&self, entry: &Listed, _cut: &Cutoff, _log: &Log) -> PipeStop {
        self.events.lock().unwrap().push(format!("pipe {}", entry.name));
        self.tweak(&entry.name, |f| f.status = "stopped".into());
        PipeStop::Stopped
    }
    fn start(&self, name: &str, _log: &Log) -> Result<(), String> {
        self.events.lock().unwrap().push(format!("start {name}"));
        self.tweak(name, |f| f.status = "running".into());
        Ok(())
    }
}

#[derive(Default)]
struct FakeTasks {
    state: Mutex<BTreeMap<String, bool>>,
}

impl FakeTasks {
    fn with(list: &[(&str, bool)]) -> FakeTasks {
        let t = FakeTasks::default();
        for (n, e) in list {
            t.state.lock().unwrap().insert(n.to_string(), *e);
        }
        t
    }
    fn get(&self, n: &str) -> bool {
        self.state.lock().unwrap()[n]
    }
}

impl Tasks for FakeTasks {
    fn enabled(&self) -> Result<Vec<String>, String> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, e)| **e)
            .map(|(n, _)| n.clone())
            .collect())
    }
    fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
        self.state.lock().unwrap().insert(name.into(), enabled);
        Ok(())
    }
}

fn opts(silent: bool, deadline_ms: u64) -> StopOptions {
    StopOptions {
        legacy_version: "1.6.0-beta.413".into(),
        to_version: "2.0.0".into(),
        deadline: Duration::from_millis(deadline_ms),
        silent,
        cancel_file: None,
    }
}

fn go(o: &StopOptions, l: &FakeLegacy, t: &FakeTasks, m: Option<Marker>) -> StopOutcome {
    run_stop(o, l.list().unwrap(), l, t, m, "/d", &Log::none())
}

fn entry<'a>(r: &'a Record, n: &str) -> &'a Entry {
    r.servers.iter().find(|e| e.name == n).unwrap()
}

#[test]
fn servers_before_databases_orphans_left_alone_tasks_off() {
    let l = FakeLegacy::with(&[
        ("db", Kind::Database, "running"),
        ("survival", Kind::Server, "running"),
        ("creative", Kind::Server, "running"),
        ("old", Kind::Server, "stopped"),
        ("lost", Kind::Server, "orphaned"),
    ]);
    let t = FakeTasks::with(&[("backup", true), ("off", false)]);
    let out = go(&opts(true, 5000), &l, &t, None);
    assert_eq!(out.code, EXIT_OK);
    assert!(out.marker.is_none());
    let ev = l.events();
    let db = ev.iter().position(|e| e == "stop db").unwrap();
    assert!(ev.iter().position(|e| e == "stop survival").unwrap() < db);
    assert!(ev.iter().position(|e| e == "stop creative").unwrap() < db);
    assert!(!ev.iter().any(|e| e.contains("old") || e.contains("lost")));
    let r = &out.record;
    assert_eq!(entry(r, "lost").stop, "orphaned");
    assert_eq!(entry(r, "survival").stop, "stopped");
    assert_eq!(entry(r, "db").stop, "stopped");
    assert!(r.servers.iter().all(|e| e.name != "old"));
    assert_eq!(r.tasks_disabled, vec!["backup".to_string()]);
    assert!(!t.get("backup"), "the task folder stays off until resume");
    assert_eq!(r.stop_exit, Some(0));
    assert!(entry(r, "survival").stopped_at.unwrap() <= entry(r, "db").stopped_at.unwrap());
}

#[test]
fn nothing_running_touches_no_task() {
    let l = FakeLegacy::with(&[("a", Kind::Server, "stopped")]);
    let t = FakeTasks::with(&[("backup", true)]);
    let out = go(&opts(true, 1000), &l, &t, None);
    assert_eq!(out.code, EXIT_OK);
    assert!(out.record.servers.is_empty());
    assert!(t.get("backup"));
}

#[test]
fn a_stuck_server_aborts_and_everything_else_is_put_back() {
    let l = FakeLegacy::with(&[
        ("db", Kind::Database, "running"),
        ("stuck", Kind::Server, "running"),
        ("fine", Kind::Server, "running"),
    ]);
    l.tweak("stuck", |f| f.refuses = true);
    let t = FakeTasks::with(&[("backup", true)]);
    let started = Instant::now();
    let out = go(&opts(true, 300), &l, &t, None);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(out.code, EXIT_BLOCKED);
    let r = &out.record;
    assert_eq!(entry(r, "stuck").stop, "still-running");
    assert_eq!(entry(r, "fine").start.as_deref(), Some("restored-1x"));
    // the database was never reached (its turn came after the deadline) or was put back first
    let ev = l.events();
    if let Some(db) = ev.iter().position(|e| e == "start db") {
        assert!(db < ev.iter().position(|e| e == "start fine").unwrap());
    }
    assert_eq!(l.status("fine"), "running");
    assert_eq!(l.status("db"), "running");
    assert!(!ev.contains(&"start stuck".to_string()));
    assert!(t.get("backup"), "tasks enabled again on abort");
    let m = out.marker.unwrap();
    assert_eq!(m.blocked_by, vec!["stuck".to_string()]);
    assert_eq!(m.attempts, 1);
}

#[test]
fn a_silent_retry_while_blocked_stops_nothing() {
    let l = FakeLegacy::with(&[
        ("stuck", Kind::Server, "running"),
        ("fine", Kind::Server, "running"),
    ]);
    let t = FakeTasks::with(&[("backup", true)]);
    let m = Marker {
        blocked_by: vec!["stuck".into()],
        at_ms: time::now_ms() - 60_000,
        attempts: 1,
    };
    let out = go(&opts(true, 1000), &l, &t, Some(m.clone()));
    assert_eq!(out.code, EXIT_BLOCKED);
    assert!(l.events().is_empty());
    assert_eq!(out.marker.unwrap().attempts, 2);
    assert!(t.get("backup"));

    // the person running the installer: full stop
    let out = go(&opts(false, 1000), &l, &t, Some(m.clone()));
    assert_eq!(out.code, EXIT_OK);
    assert!(l.events().contains(&"stop stuck".to_string()));

    // a day later, or once the server is gone, the marker no longer holds
    let old = Marker {
        at_ms: time::now_ms() - MARKER_HOLD.as_millis() as i64 - 1,
        ..m.clone()
    };
    assert!(!old.holds(time::now_ms(), &l.list().unwrap()));
    assert!(
        !m.holds(time::now_ms(), &l.list().unwrap()),
        "stuck is stopped now"
    );
}

#[test]
fn a_server_started_meanwhile_is_stopped_too() {
    let l = FakeLegacy::with(&[("a", Kind::Server, "running")]);
    *l.appears.lock().unwrap() = Some(("late".into(), Kind::Server));
    let t = FakeTasks::default();
    let out = go(&opts(true, 2000), &l, &t, None);
    assert_eq!(out.code, EXIT_OK);
    assert_eq!(entry(&out.record, "late").stop, "stopped");
}

#[test]
fn a_broken_cli_falls_back_to_the_pipe() {
    let l = FakeLegacy::with(&[("a", Kind::Server, "running")]);
    l.tweak("a", |f| f.cli_broken = true);
    let out = go(&opts(true, 2000), &l, &FakeTasks::default(), None);
    assert_eq!(out.code, EXIT_OK);
    assert!(l.events().contains(&"pipe a".to_string()));
    assert_eq!(entry(&out.record, "a").stop, "stopped");
}

#[test]
fn cancel_puts_everything_back_and_leaves_no_marker() {
    let l = FakeLegacy::with(&[
        ("stuck", Kind::Server, "running"),
        ("fine", Kind::Server, "running"),
    ]);
    l.tweak("stuck", |f| f.refuses = true);
    let dir = std::env::temp_dir().join(format!("sl-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cancel = dir.join("handover-cancel");
    let c2 = cancel.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(c2, "").unwrap();
    });
    let started = Instant::now();
    let out = run_stop(
        &StopOptions {
            cancel_file: Some(cancel),
            ..opts(false, 60_000)
        },
        l.list().unwrap(),
        &l,
        &FakeTasks::default(),
        None,
        "/d",
        &Log::none(),
    );
    t.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(out.code, EXIT_BLOCKED);
    assert!(out.marker.is_none());
    assert_eq!(l.status("fine"), "running");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn record_and_marker_round_trip() {
    let mut r = Record::new("1.5.0", "2.0.0", "silent", "C:/d");
    let mut e = Entry::new("s", Kind::Database, "stopped");
    e.stop_ms = Some(12);
    e.stopped_at = Some(5);
    e.start = Some("running".into());
    e.error = Some("x".into());
    r.servers.push(e);
    r.tasks_disabled = vec!["t".into()];
    r.stop_exit = Some(0);
    let dir = std::env::temp_dir().join(format!("sl-handover-{}", std::process::id()));
    let f = Files::new(&dir);
    r.write(&f.record()).unwrap();
    assert_eq!(Record::read(&f.record()).unwrap(), r);
    let m = Marker {
        blocked_by: vec!["a".into()],
        at_ms: 99,
        attempts: 3,
    };
    m.write(&f.marker()).unwrap();
    assert_eq!(Marker::read(&f.marker()).unwrap(), m);
    std::fs::remove_dir_all(&dir).unwrap();
}
