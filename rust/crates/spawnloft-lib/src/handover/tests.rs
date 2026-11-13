use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
struct Fake {
    kind: Kind,
    status: String,
    /// ignores `stop` (scenario 3's stuck server)
    refuses: bool,
    /// the CLI fails for it (pipe fallback)
    cli_broken: bool,
    /// still saving at the cutoff, stopped shortly after it
    late: bool,
    finish_at: Option<Instant>,
}

#[derive(Default)]
struct FakeLegacy {
    servers: Mutex<BTreeMap<String, Fake>>,
    events: Arc<Mutex<Vec<String>>>,
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
                    late: false,
                    finish_at: None,
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
    /// The same servers in the same states, with no history: the world as a later process finds it.
    fn again(servers: &BTreeMap<String, Fake>) -> FakeLegacy {
        let f = FakeLegacy::default();
        *f.servers.lock().unwrap() = servers.clone();
        f
    }
    fn running(&self) -> Vec<String> {
        let s = self.servers.lock().unwrap();
        s.iter()
            .filter(|(_, f)| f.status == "running")
            .map(|(n, _)| n.clone())
            .collect()
    }
}

impl Legacy for FakeLegacy {
    fn list(&self) -> Result<Vec<Listed>, String> {
        let mut servers = self.servers.lock().unwrap();
        for f in servers.values_mut() {
            if f.finish_at.is_some_and(|t| Instant::now() >= t) {
                f.status = "stopped".into();
                f.finish_at = None;
            }
        }
        Ok(servers
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
                    late: false,
                    finish_at: None,
                },
            );
        }
        if f.cli_broken {
            return CliStop::Exited {
                code: 1,
                output: "Error: something broke".into(),
            };
        }
        if f.late {
            while !cut.passed() {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.tweak(name, |f| {
                f.finish_at = Some(Instant::now() + Duration::from_millis(100))
            });
            return CliStop::DeadlinePassed;
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
    /// tasks Task Scheduler refuses to change for now
    refuses: Mutex<BTreeSet<String>>,
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
    fn again(state: &BTreeMap<String, bool>) -> FakeTasks {
        let t = FakeTasks::default();
        *t.state.lock().unwrap() = state.clone();
        t
    }
    fn on(&self) -> Vec<String> {
        self.enabled().unwrap()
    }
}

impl Tasks for FakeTasks {
    fn states(&self) -> Result<Vec<(String, bool)>, String> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .iter()
            .map(|(n, e)| (n.clone(), *e))
            .collect())
    }
    fn set_enabled(&self, name: &str, enabled: bool) -> Result<(), String> {
        if self.refuses.lock().unwrap().contains(name) {
            return Err("access denied".into());
        }
        match self.state.lock().unwrap().get_mut(name) {
            Some(e) => {
                *e = enabled;
                Ok(())
            }
            None => Err("the task does not exist".into()),
        }
    }
}

/// One save of the journal: the record as it went to disk, and the world at that moment.
#[derive(Clone)]
struct Shot {
    record: Record,
    servers: BTreeMap<String, Fake>,
    tasks: BTreeMap<String, bool>,
}

/// A journal that keeps every save with the world as it was then, so a test can end the
/// handover at any save ("the PC lost power here") and hand what is left to the next step.
struct Shots<'a> {
    legacy: &'a FakeLegacy,
    tasks: &'a FakeTasks,
    shots: RefCell<Vec<Shot>>,
}

impl<'a> Shots<'a> {
    fn new(legacy: &'a FakeLegacy, tasks: &'a FakeTasks) -> Shots<'a> {
        Shots {
            legacy,
            tasks,
            shots: RefCell::new(Vec::new()),
        }
    }
    fn now(&self, record: &Record) -> Shot {
        Shot {
            record: record.clone(),
            servers: self.legacy.servers.lock().unwrap().clone(),
            tasks: self.tasks.state.lock().unwrap().clone(),
        }
    }
}

impl Journal for Shots<'_> {
    fn save(&self, record: &Record) {
        self.shots.borrow_mut().push(self.now(record));
    }
}

fn ctx<'a>(l: &'a FakeLegacy, t: &'a FakeTasks, j: &'a dyn Journal, log: &'a Log) -> Ctx<'a> {
    Ctx {
        legacy: l,
        tasks: t,
        journal: j,
        log,
    }
}

fn opts(silent: bool, deadline_ms: u64) -> StopOptions {
    StopOptions {
        legacy_version: "1.6.0-beta.413".into(),
        to_version: "2.0.0".into(),
        deadline: Duration::from_millis(deadline_ms),
        silent,
        cancel_file: None,
        restore_wait: Duration::from_millis(300),
        installer_gone: None,
        session_ending: None,
    }
}

fn go(o: &StopOptions, l: &FakeLegacy, t: &FakeTasks, m: Option<Marker>) -> StopOutcome {
    go_on(o, l, t, m, None)
}

/// A stop that finds the record `unfinished` on disk.
fn go_on(
    o: &StopOptions,
    l: &FakeLegacy,
    t: &FakeTasks,
    marker: Option<Marker>,
    unfinished: Option<Record>,
) -> StopOutcome {
    run_stop(
        o,
        l.list().unwrap(),
        ctx(l, t, &NoJournal, &Log::none()),
        Found { marker, unfinished },
        "/d",
    )
}

fn put_back(r: &mut Record, l: &FakeLegacy, t: &FakeTasks) {
    restore_waiting(r, ctx(l, t, &NoJournal, &Log::none()), Duration::from_millis(40));
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
        ctx(&l, &FakeTasks::default(), &NoJournal, &Log::none()),
        Found::default(),
        "/d",
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

#[test]
fn a_server_still_saving_at_the_cutoff_is_started_again_when_it_finishes() {
    let l = FakeLegacy::with(&[
        ("big", Kind::Server, "running"),
        ("stuck", Kind::Server, "running"),
    ]);
    l.tweak("big", |f| f.late = true);
    l.tweak("stuck", |f| f.refuses = true);
    let out = go(&opts(true, 100), &l, &FakeTasks::default(), None);
    assert_eq!(out.code, EXIT_BLOCKED);
    assert_eq!(entry(&out.record, "big").stop, "was-stopped");
    assert_eq!(entry(&out.record, "big").start.as_deref(), Some("restored-1x"));
    assert_eq!(l.status("big"), "running");
    assert_eq!(entry(&out.record, "stuck").stop, "still-running");
    assert!(out.marker.unwrap().blocked_by.contains(&"stuck".to_string()));
}

#[test]
fn a_retry_starts_again_what_blocked_before_and_is_stopped_now() {
    let l = FakeLegacy::with(&[
        ("stuck", Kind::Server, "stopped"),
        ("other", Kind::Server, "running"),
    ]);
    let m = Marker {
        blocked_by: vec!["stuck".into()],
        at_ms: time::now_ms() - 60_000,
        attempts: 1,
    };
    let out = go(&opts(true, 5_000), &l, &FakeTasks::default(), Some(m));
    assert_eq!(out.code, EXIT_OK);
    assert_eq!(entry(&out.record, "stuck").stop, "was-stopped");
    assert!(entry(&out.record, "stuck").to_restart());
    assert_eq!(entry(&out.record, "other").stop, "stopped");
}

// ---------------------------------------------------------------------------------------------
// A handover that ends without warning (blocker B1 of the 2.0 beta review)

const RAN: [&str; 3] = ["creative", "db", "survival"];
const TASKS_ON: [&str; 2] = ["backup", "restart"];

/// Three things running (two servers and their database), one stopped, one orphaned; two tasks
/// on and one the person had switched off.
fn world() -> (FakeLegacy, FakeTasks) {
    (
        FakeLegacy::with(&[
            ("db", Kind::Database, "running"),
            ("survival", Kind::Server, "running"),
            ("creative", Kind::Server, "running"),
            ("idle", Kind::Server, "stopped"),
            ("lost", Kind::Server, "orphaned"),
        ]),
        FakeTasks::with(&[("backup", true), ("restart", true), ("off", false)]),
    )
}

/// Every state a power cut can leave: each record that reached the disk, with the world as it
/// was at that save and as it was at the next one (the record is written before the step it
/// announces, so the world can be one step ahead of it, never more).
fn cuts(l: &FakeLegacy, t: &FakeTasks) -> Vec<Shot> {
    let j = Shots::new(l, t);
    let out = run_stop(
        &opts(true, 5000),
        l.list().unwrap(),
        ctx(l, t, &j, &Log::none()),
        Found::default(),
        "/d",
    );
    assert_eq!(out.code, EXIT_OK);
    let mut shots = j.shots.borrow().clone();
    // the record the caller writes at the end
    shots.push(j.now(&out.record));
    let mut all = Vec::new();
    for k in 0..shots.len() {
        all.push(shots[k].clone());
        if let Some(next) = shots.get(k + 1) {
            all.push(Shot {
                record: shots[k].record.clone(),
                ..next.clone()
            });
        }
    }
    all
}

#[test]
fn the_record_says_what_is_about_to_change_before_it_changes() {
    let (l, t) = world();
    let j = Shots::new(&l, &t);
    run_stop(
        &opts(true, 5000),
        l.list().unwrap(),
        ctx(&l, &t, &j, &Log::none()),
        Found::default(),
        "/d",
    );
    let shots = j.shots.borrow();
    // the tasks are named on disk while every one of them is still on
    let first = &shots[0];
    assert_eq!(first.record.tasks_disabled, TASKS_ON);
    assert!(!first.record.tasks_reenabled);
    assert!(first.tasks["backup"] && first.tasks["restart"]);
    assert_eq!(first.record.stop_exit, None);
    // and each server is named, as `stopping`, while it still runs
    for name in RAN {
        assert!(
            shots.iter().any(|s| s.servers[name].status == "running"
                && s.record
                    .servers
                    .iter()
                    .any(|e| e.name == name && e.stop == "stopping")),
            "{name} was not on disk before its stop"
        );
    }
    // an unfinished record never reads as settled
    assert!(shots.iter().all(|s| !s.record.settled()));
}

#[test]
fn a_stop_cut_short_anywhere_is_put_back_by_restore() {
    let (l, t) = world();
    let cuts = cuts(&l, &t);
    assert!(cuts.len() >= 8, "{} cuts", cuts.len());
    for (i, cut) in cuts.iter().enumerate() {
        let l2 = FakeLegacy::again(&cut.servers);
        let t2 = FakeTasks::again(&cut.tasks);
        let mut rec = cut.record.clone();
        put_back(&mut rec, &l2, &t2);
        assert_eq!(l2.running(), RAN, "cut {i}: everything that ran runs again");
        assert_eq!(l2.status("idle"), "stopped", "cut {i}");
        assert_eq!(l2.status("lost"), "orphaned", "cut {i}");
        assert_eq!(
            t2.on(),
            TASKS_ON,
            "cut {i}: the tasks are on again, and only those"
        );
        assert!(rec.settled(), "cut {i}");
        // nothing that ran through the cut is started a second time
        let started: Vec<String> = l2
            .events()
            .into_iter()
            .filter(|e| e.starts_with("start "))
            .collect();
        for s in &started {
            let name = s.trim_start_matches("start ");
            assert_ne!(cut.servers[name].status, "running", "cut {i}: {name} ran already");
        }
        // databases before the servers that use them
        if let (Some(d), Some(s)) = (
            started.iter().position(|e| e == "start db"),
            started.iter().position(|e| e == "start survival"),
        ) {
            assert!(d < s, "cut {i}");
        }
        // a second restore (the sign-in after an abort that already ran) changes nothing
        let before = l2.events().len();
        put_back(&mut rec, &l2, &t2);
        assert_eq!(l2.events().len(), before, "cut {i}: restore twice");
        assert_eq!(t2.on(), TASKS_ON, "cut {i}");
    }
}

#[test]
fn a_restore_cut_short_is_finished_by_the_next_one() {
    let (l, t) = world();
    let cuts = cuts(&l, &t);
    let last = cuts.last().unwrap();
    // the restore itself loses power after each of its saves
    let l2 = FakeLegacy::again(&last.servers);
    let t2 = FakeTasks::again(&last.tasks);
    let j = Shots::new(&l2, &t2);
    let mut rec = last.record.clone();
    restore_waiting(
        &mut rec,
        ctx(&l2, &t2, &j, &Log::none()),
        Duration::from_millis(40),
    );
    let shots = j.shots.borrow().clone();
    assert!(shots.len() >= 3);
    for (i, shot) in shots.iter().enumerate() {
        let l3 = FakeLegacy::again(&shot.servers);
        let t3 = FakeTasks::again(&shot.tasks);
        let mut rec = shot.record.clone();
        put_back(&mut rec, &l3, &t3);
        assert_eq!(l3.running(), RAN, "restore cut {i}");
        assert_eq!(t3.on(), TASKS_ON, "restore cut {i}");
        assert!(rec.settled());
        for s in l3.events().iter().filter(|e| e.starts_with("start ")) {
            let name = s.trim_start_matches("start ");
            assert_ne!(
                shot.servers[name].status, "running",
                "restore cut {i}: {name} twice"
            );
        }
    }
}

#[test]
fn the_next_attempt_takes_over_what_a_cut_one_left() {
    let (l, t) = world();
    for (i, cut) in cuts(&l, &t).iter().enumerate() {
        // the update runs again and goes through: resume must get everything that ever ran
        let l2 = FakeLegacy::again(&cut.servers);
        let t2 = FakeTasks::again(&cut.tasks);
        let out = go_on(&opts(true, 5000), &l2, &t2, None, Some(cut.record.clone()));
        assert_eq!(out.code, EXIT_OK, "cut {i}");
        let mut again: Vec<&str> = out
            .record
            .servers
            .iter()
            .filter(|e| e.to_restart())
            .map(|e| e.name.as_str())
            .collect();
        again.sort_unstable();
        assert_eq!(again, RAN, "cut {i}: all three start again after the update");
        let mut off = out.record.tasks_disabled.clone();
        off.sort_unstable();
        assert_eq!(off, TASKS_ON, "cut {i}: resume enables both tasks again");
        assert!(!out.record.tasks_reenabled);
        assert!(
            l2.running().is_empty(),
            "cut {i}: nothing left for the 1.x uninstaller to end"
        );
        assert_eq!(entry(&out.record, "lost").stop, "orphaned");
        assert!(out.record.servers.iter().all(|e| e.name != "idle"));
        // no name twice
        let mut names: Vec<&str> = out.record.servers.iter().map(|e| e.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), out.record.servers.len(), "cut {i}");
    }
}

#[test]
fn a_taken_over_attempt_that_is_blocked_puts_everything_back() {
    // the first attempt stopped creative, was about to stop survival, and ended there
    let (l, t) = world();
    l.tweak("creative", |f| f.status = "stopped".into());
    l.tweak("survival", |f| f.refuses = true);
    t.set_enabled("backup", false).unwrap();
    t.set_enabled("restart", false).unwrap();
    let mut old = Record::new("1.6.0-beta.413", "2.0.0", "silent", "/d");
    old.servers.push(Entry::new("creative", Kind::Server, "stopped"));
    old.servers.push(Entry::new("survival", Kind::Server, "stopping"));
    old.tasks_disabled = vec!["backup".into(), "restart".into()];
    let out = go_on(&opts(true, 200), &l, &t, None, Some(old));
    assert_eq!(out.code, EXIT_BLOCKED);
    assert_eq!(l.running(), RAN);
    assert_eq!(
        entry(&out.record, "creative").start.as_deref(),
        Some("restored-1x")
    );
    assert_eq!(t.on(), TASKS_ON);
    assert!(out.record.settled());
    assert_eq!(out.marker.unwrap().blocked_by, vec!["survival".to_string()]);
}

#[test]
fn a_blocked_silent_retry_still_puts_back_what_a_cut_attempt_left() {
    // attempt 1 was blocked by stuck (marker); attempt 2, by hand, stopped fine and lost power;
    // attempt 3 is silent and held back by the marker: it stops nothing, but 1.x stays, so fine
    // and the task come back now
    let l = FakeLegacy::with(&[
        ("stuck", Kind::Server, "running"),
        ("fine", Kind::Server, "stopped"),
    ]);
    let t = FakeTasks::with(&[("backup", false)]);
    let mut old = Record::new("1.6.0-beta.413", "2.0.0", "ui", "/d");
    old.servers.push(Entry::new("fine", Kind::Server, "stopped"));
    old.servers.push(Entry::new("stuck", Kind::Server, "stopping"));
    old.tasks_disabled = vec!["backup".into()];
    let m = Marker {
        blocked_by: vec!["stuck".into()],
        at_ms: time::now_ms() - 60_000,
        attempts: 1,
    };
    let out = go_on(&opts(true, 1000), &l, &t, Some(m), Some(old));
    assert_eq!(out.code, EXIT_BLOCKED);
    assert_eq!(
        l.events(),
        vec!["start fine".to_string()],
        "nothing stopped, fine started"
    );
    assert!(t.get("backup"));
    assert!(out.record.settled());
    assert_eq!(out.marker.unwrap().attempts, 2);
}

#[test]
fn what_was_stopped_more_than_a_day_ago_is_left_alone_but_its_tasks_come_back() {
    let l = FakeLegacy::with(&[("old", Kind::Server, "stopped"), ("new", Kind::Server, "stopped")]);
    let t = FakeTasks::with(&[("backup", false)]);
    let mut rec = Record::new("1.5.0", "2.0.0", "silent", "/d");
    let mut e = Entry::new("old", Kind::Server, "stopped");
    e.stopped_at = Some(time::now_ms() - TAKEOVER_WINDOW.as_millis() as i64 - 1);
    rec.servers.push(e);
    let mut e = Entry::new("new", Kind::Server, "stopped");
    e.stopped_at = Some(time::now_ms() - 3_600_000);
    rec.servers.push(e);
    rec.tasks_disabled = vec!["backup".into()];

    // the next attempt carries the young one and the task, not the old one
    let out = go_on(&opts(true, 1000), &l, &t, None, Some(rec.clone()));
    assert_eq!(out.code, EXIT_OK);
    assert!(out.record.servers.iter().all(|e| e.name != "old"));
    assert!(entry(&out.record, "new").to_restart());
    assert_eq!(out.record.tasks_disabled, vec!["backup".to_string()]);
    // carried with the time of the real stop, so the day does not start over
    assert_eq!(
        entry(&out.record, "new").stopped_at,
        entry(&rec, "new").stopped_at
    );

    // and so does a restore
    put_back(&mut rec, &l, &t);
    assert_eq!(l.events(), vec!["start new".to_string()]);
    assert_eq!(entry(&rec, "old").start.as_deref(), Some("skipped"));
    assert!(t.get("backup"));
    assert!(rec.settled());
}

#[test]
fn a_task_that_cannot_be_enabled_is_tried_again_and_a_deleted_one_is_let_go() {
    let (l, t) = world();
    let mut rec = go(&opts(true, 5000), &l, &t, None).record;
    t.refuses.lock().unwrap().insert("backup".into());
    t.state.lock().unwrap().remove("restart");
    put_back(&mut rec, &l, &t);
    assert_eq!(l.running(), RAN);
    assert!(!rec.tasks_reenabled, "backup is still off");
    assert!(!rec.settled());
    assert!(!t.get("backup"));
    // the next step (a sign-in, the next attempt, resume) gets it; restart is gone for good
    t.refuses.lock().unwrap().clear();
    let before = l.events().len();
    put_back(&mut rec, &l, &t);
    assert!(t.get("backup"));
    assert!(rec.tasks_reenabled && rec.settled());
    assert_eq!(l.events().len(), before, "no server started twice");
}

#[test]
fn an_installer_that_is_gone_ends_the_stop_like_a_cancel() {
    // gone from the start: nothing is asked to stop
    let (l, t) = world();
    let o = StopOptions {
        installer_gone: Some(Watch::new(|| true)),
        ..opts(true, 5000)
    };
    let out = go(&o, &l, &t, None);
    assert_eq!(out.code, EXIT_BLOCKED);
    assert!(out.marker.is_none());
    assert!(l.events().is_empty());
    assert_eq!(l.running(), RAN);
    assert_eq!(t.on(), TASKS_ON);
    assert!(out.record.settled());

    // gone as the last stop goes through: "stopped" would be an answer to nobody
    let (l, t) = world();
    let ev = l.events.clone();
    let o = StopOptions {
        installer_gone: Some(Watch::new(move || {
            ev.lock().unwrap().iter().any(|e| e == "stop db")
        })),
        ..opts(false, 5000)
    };
    let out = go(&o, &l, &t, None);
    assert_eq!(out.code, EXIT_BLOCKED);
    assert!(out.marker.is_none());
    assert!(!out.interrupted);
    assert_eq!(l.running(), RAN, "everything was started again");
    assert_eq!(t.on(), TASKS_ON);
    assert!(out.record.settled());
}

#[test]
fn during_a_shutdown_nothing_is_started_and_the_sign_in_puts_it_back() {
    let (l, t) = world();
    let ev = l.events.clone();
    let j = Shots::new(&l, &t);
    let marker = Marker {
        blocked_by: vec!["elsewhere".into()],
        at_ms: 5,
        attempts: 2,
    };
    let out = run_stop(
        &StopOptions {
            installer_gone: Some(Watch::new(move || {
                ev.lock().unwrap().iter().any(|e| e == "stop db")
            })),
            session_ending: Some(Watch::new(|| true)),
            ..opts(false, 5000)
        },
        l.list().unwrap(),
        ctx(&l, &t, &j, &Log::none()),
        Found {
            marker: Some(marker.clone()),
            unfinished: None,
        },
        "/d",
    );
    assert!(out.interrupted);
    assert_eq!(out.code, EXIT_INTERNAL);
    assert_eq!(out.marker, Some(marker), "the marker file stays as it is");
    assert!(l.events().iter().all(|e| !e.starts_with("start ")));
    assert!(!out.record.settled());
    assert!(t.on().is_empty());
    // what is on disk is what the outcome holds
    let on_disk = j.shots.borrow().last().unwrap().record.clone();
    assert_eq!(on_disk, out.record);
    // the next sign-in
    let l2 = FakeLegacy::again(&l.servers.lock().unwrap());
    let mut rec = on_disk;
    put_back(&mut rec, &l2, &t);
    assert_eq!(l2.running(), RAN);
    assert_eq!(t.on(), TASKS_ON);
    assert!(rec.settled());
}

#[test]
fn settled_means_nothing_is_owed() {
    let mut r = Record::new("1.5.0", "2.0.0", "silent", "/d");
    assert!(r.settled(), "nothing stopped, nothing disabled");
    r.tasks_disabled = vec!["t".into()];
    assert!(!r.settled());
    r.tasks_reenabled = true;
    assert!(r.settled());
    for (stop, owed) in [
        ("stopped", true),
        ("was-stopped", true),
        ("stopping", true),
        ("stop-sent", true),
        ("still-running", false),
        ("orphaned", false),
        ("failed", false),
    ] {
        r.servers = vec![Entry::new("s", Kind::Server, stop)];
        assert_eq!(!r.settled(), owed, "{stop}");
        r.servers[0].start = Some("failed".into());
        assert!(r.settled(), "{stop}, start tried");
    }
    // an unfinished record survives the round trip as unfinished
    r.servers = vec![Entry::new("s", Kind::Server, "stopping")];
    r.tasks_reenabled = false;
    let back = Record::from_json(&r.to_json()).unwrap();
    assert_eq!(back, r);
    assert!(!back.settled() && back.stop_exit.is_none());
}
