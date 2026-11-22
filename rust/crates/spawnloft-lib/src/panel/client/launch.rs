//! `POST /api/client/profiles/<name>/launch`, and `launchJob` / `startServerForLaunch` of
//! `ui.mjs`. Without a `jobId` the launch is the request; with one it is a job the page watches
//! on its job stream, answered 202 at once, so every refusal from there on (the launch lock among
//! them) arrives on the stream as the job's error.

use std::sync::Arc;
use std::sync::mpsc::channel;

use serde_json::{Value, json};

use crate::client::launch::{self, EnsureServer, LaunchOpts, Launched, PanelOpts};
use crate::client::paths::Paths;
use crate::client::{install, profiles};
use crate::failure::Failure;
use crate::settings::Layout;
use crate::{cancel, js, supervisor};

use super::super::Panel;
use super::super::http::{Reply, Request, opt_field};
use super::super::jobs::{Field, Jobs, is_job_id};
use super::body_or_empty;

/// How long "Start server and launch" waits for the server before giving up on the launch.
const LAUNCH_SERVER_WAIT_MS: f64 = 120_000.0;

/// What the body asks for.
struct Asked {
    /// `server: false` is the title screen even when the profile names a server.
    server_off: bool,
    server: Option<String>,
    account: Option<String>,
    /// a server SpawnLoft does not run, host[:port]; launch checks it
    address: Option<String>,
}

fn nonempty(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

pub fn launch(
    panel: &Panel,
    layout: &Layout,
    paths: &Paths,
    req: &mut Request,
    name: &str,
) -> Result<Reply, Failure> {
    let body = body_or_empty(req)?;
    let asked = Asked {
        server_off: opt_field(&body, "server") == Some(&json!(false)),
        server: nonempty(opt_field(&body, "server")),
        account: nonempty(opt_field(&body, "account")),
        address: match opt_field(&body, "address") {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        },
    };
    let job = match opt_field(&body, "jobId") {
        None | Some(Value::Null) => None,
        v => Some(js::string(v)),
    };
    let Some(job_id) = job else {
        let (pid, version, account, warnings) = run(
            layout,
            paths,
            name,
            &asked,
            &Hear {
                launched_by: "panel",
                on_stage: &|_, _| {},
                on_progress: &|_| {},
                ensure_server: None,
            },
        )?;
        return Ok(Reply::ok(json!({
            "pid": pid,
            "version": version,
            "account": account,
            "warnings": warnings,
        })));
    };
    if !is_job_id(&job_id) {
        return Err(Failure::user(
            "jobId must be 1 to 64 letters, digits, dashes or underscores",
        ));
    }
    // Node saw that no such job runs and made it one in a single turn. Here two requests are two
    // threads: the second waits until the first's job is one it can see.
    static STARTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _starting = STARTING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if panel.jobs.running(&job_id) {
        return Err(Failure::user("that job is already running"));
    }
    profiles::get(paths, name)?;
    let start_server = opt_field(&body, "startServer") == Some(&json!(true));
    launch_job(&panel.jobs, layout, paths, &job_id, name, asked, start_server);
    Ok(Reply::json(202, json!({ "jobId": job_id })))
}

/// What a launch answers the page: `{ pid, version, account, warnings }`.
type Out = (u32, String, Value, Vec<String>);

/// `client.launch(name, opts)`, and the game's exit heard as the Node panel hears it: the exit
/// record and the time played are written when the game it started ends.
/// Who asked, and what hears the launch's steps.
struct Hear<'a> {
    launched_by: &'static str,
    on_stage: &'a (dyn Fn(&str, &str) + Sync),
    on_progress: install::OnProgress<'a>,
    ensure_server: Option<EnsureServer<'a>>,
}

fn run(layout: &Layout, paths: &Paths, name: &str, asked: &Asked, hear: &Hear<'_>) -> Result<Out, Failure> {
    let out = launch::launch_with(
        paths,
        layout,
        name,
        &LaunchOpts {
            player_name: None,
            account: asked.account.clone(),
            server: asked.server.clone(),
            on_progress: hear.on_progress,
            on_warning: &|_| {},
            assistant: false,
            fake_java: launch::fake_client_java(),
        },
        &PanelOpts {
            server_off: asked.server_off,
            address: asked.address.clone(),
            launched_by: hear.launched_by,
            on_stage: hear.on_stage,
            ensure_server: hear.ensure_server,
        },
    )?;
    let Launched {
        mut started,
        version,
        account,
        warnings,
        ..
    } = out;
    let pid = started.pid;
    let (paths, name) = (paths.clone(), name.to_string());
    std::thread::spawn(move || {
        if let Ok(status) = started.child.wait() {
            launch::note_exit(&paths, &name, &started, status);
        }
    });
    Ok((pid, version, account, warnings))
}

/// `toLocaleString('en-US')` for a count: thousands separated by commas.
fn grouped(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `launchJob(jobId, profileName, { startServer, ...opts })`: the launch on a thread of its own,
/// its steps and downloads told to the job, cancellable until the game is started.
fn launch_job(
    jobs: &Arc<Jobs>,
    layout: &Layout,
    paths: &Paths,
    id: &str,
    name: &str,
    asked: Asked,
    start_server: bool,
) {
    // a reused id must not carry the last run's outcome into this one
    jobs.update(
        Some(id),
        vec![
            ("stage", json!("start").into()),
            ("percent", Value::Null.into()),
            ("message", json!("Preparing").into()),
            ("done", json!(false).into()),
            ("pid", Field::Unset),
            ("version", Field::Unset),
            ("account", Field::Unset),
            ("warnings", Field::Unset),
            ("code", Field::Unset),
            ("cancelling", Field::Unset),
        ],
    );
    let (jobs, layout, paths, id, name) = (
        Arc::clone(jobs),
        layout.clone(),
        paths.clone(),
        id.to_string(),
        name.to_string(),
    );
    let (registered, wait) = channel::<()>();
    std::thread::spawn(move || {
        let stage = |stage: &str, message: &str| jobs.stage(Some(&id), stage, None, message);
        let progress = |p: &install::Progress| {
            let phase = if p.phase == "harness mod" {
                "harness"
            } else {
                p.phase
            };
            // nothing fetched so far in this step: the files on disk are being checked
            let message = if p.bytes > 0.0 || p.fetching {
                let size = if p.bytes > 0.0 {
                    format!(" · {}", crate::text::human_bytes(Some(p.bytes)))
                } else {
                    String::new()
                };
                format!(
                    "Downloading {} · {} of {} files{size}",
                    p.phase,
                    grouped(p.done),
                    grouped(p.total)
                )
            } else {
                format!(
                    "Checking {} · {} of {} files",
                    p.phase,
                    grouped(p.done),
                    grouped(p.total)
                )
            };
            let percent =
                (p.total > 0).then(|| (100.0f64).min((p.done as f64 / p.total as f64 * 100.0).round()));
            jobs.stage(Some(&id), phase, percent, &message);
        };
        let ensure = |server: &str| start_server_for_launch(&layout, server);
        // without "Start server and launch" a stopped server is only a warning
        let ensure_server: Option<EnsureServer<'_>> = start_server.then_some(&ensure);
        let result = jobs.cancellable(Some(&id), || {
            let _ = registered.send(());
            let hear = Hear {
                launched_by: "launcher",
                on_stage: &stage,
                on_progress: &progress,
                ensure_server,
            };
            run(&layout, &paths, &name, &asked, &hear)
        });
        match result {
            Ok((pid, version, account, warnings)) => jobs.update(
                Some(&id),
                vec![
                    ("stage", json!("running").into()),
                    ("percent", json!(100).into()),
                    ("message", json!(format!("Running · pid {pid}")).into()),
                    ("done", json!(true).into()),
                    ("cancelling", Field::Unset),
                    ("pid", json!(pid).into()),
                    ("version", json!(version).into()),
                    ("account", account.into()),
                    ("warnings", json!(warnings).into()),
                ],
            ),
            Err(err) if cancel::is_cancelled(&err) => jobs.update(
                Some(&id),
                vec![
                    ("stage", json!("cancelled").into()),
                    ("percent", Value::Null.into()),
                    ("message", json!("Cancelled").into()),
                    ("done", json!(true).into()),
                    ("code", json!("cancelled").into()),
                    ("cancelling", Field::Unset),
                ],
            ),
            // the code (unknown-variable, java-too-old, ...) tells refusals apart
            Err(err) => {
                let code = match &err {
                    Failure::User { code: Some(c), .. } | Failure::Internal { code: Some(c), .. } => {
                        Field::Set(json!(c))
                    }
                    _ => Field::Unset,
                };
                jobs.update(
                    Some(&id),
                    vec![
                        ("stage", json!("error").into()),
                        ("percent", Value::Null.into()),
                        ("message", json!(err.message()).into()),
                        ("done", json!(true).into()),
                        ("code", code),
                        ("cancelling", Field::Unset),
                    ],
                );
            }
        }
    });
    // answered once the job can be cancelled, as Node's cancellable registers it at once
    let _ = wait.recv();
}

/// `startServerForLaunch(name)`: a cancelled launch stops waiting; the server, once asked to
/// start, is left to.
fn start_server_for_launch(layout: &Layout, name: &str) -> Result<(), Failure> {
    let (send, answer) = channel();
    let (layout_for, name_for) = (layout.clone(), name.to_string());
    std::thread::spawn(move || {
        let out = supervisor::start(
            &layout_for,
            &super::super::Panel::actor(),
            &name_for,
            supervisor::StartOptions {
                timeout: LAUNCH_SERVER_WAIT_MS,
                ..supervisor::StartOptions::default()
            },
        );
        let _ = send.send(out);
    });
    let Some(out) = cancel::or_cancelled(&answer)? else {
        return Err(Failure::user(format!("server \"{name}\" could not be started")));
    };
    let out = out?;
    if out.failed {
        return Err(Failure::user(format!(
            "server \"{name}\" started but stopped again: {}; the game was not launched",
            out.reason.as_deref().unwrap_or("undefined")
        )));
    }
    if out.timed_out {
        return Err(Failure::user(format!(
            "server \"{name}\" had not finished starting after about 2 minutes, so the game was not launched; watch its console, then launch again"
        )));
    }
    Ok(())
}
