//! Progress for the long jobs the panel starts (a create, an install, a game launch), sent to the
//! page as an event stream: `jobs`, `cancels`, `jobUpdate`, `cancellable` and `cancelJob` of
//! `ui.mjs`. In memory and keyed by an id the page chose; losing them at a restart is fine.

use std::collections::HashMap;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};

use serde_json::{Map, Value, json};

use super::http::Reply;
use super::sse;
use crate::cancel::{self, Token};
use crate::failure::Failure;

/// The most jobs remembered; the oldest goes first.
pub const JOB_LIMIT: usize = 32;

/// `JOB_ID`: what a page may name a job.
pub fn is_job_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// One job's fields in the order JavaScript keeps them. `None` is a key set to `undefined`
/// (`cancelling: undefined`): it is not sent, but it holds its place for when it is set.
struct Job {
    fields: Vec<(String, Option<Value>)>,
    listeners: Vec<(u64, Sender<String>)>,
}

impl Job {
    fn new(id: &str) -> Job {
        let field = |k: &str, v: Value| (k.to_string(), Some(v));
        Job {
            fields: vec![
                field("id", json!(id)),
                field("stage", json!("start")),
                field("percent", Value::Null),
                field("message", json!("")),
                field("done", json!(false)),
            ],
            listeners: Vec::new(),
        }
    }

    /// `job[key] = value`: a key already there keeps its place.
    fn set(&mut self, key: &str, value: Option<Value>) {
        match self.fields.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.fields.push((key.to_string(), value)),
        }
    }

    fn shown(&self) -> Value {
        let mut out = Map::new();
        for (k, v) in &self.fields {
            if let Some(v) = v {
                out.insert(k.clone(), v.clone());
            }
        }
        Value::Object(out)
    }
}

#[derive(Default)]
struct State {
    /// Oldest first, as a `Map` keeps them.
    jobs: Vec<(String, Job)>,
    cancels: HashMap<String, Token>,
    next_listener: u64,
}

/// The panel's jobs. One per panel, shared by every request.
#[derive(Default)]
pub struct Jobs {
    state: Mutex<State>,
}

/// A value for [`Jobs::update`]: `Set` is `key: value`, `Unset` is `key: undefined`.
pub enum Field {
    Set(Value),
    Unset,
}

impl From<Value> for Field {
    fn from(v: Value) -> Field {
        Field::Set(v)
    }
}

impl State {
    /// `jobs.get(id) ?? { id, stage: 'start', ... }`, kept.
    fn job(&mut self, id: &str) -> &mut Job {
        let at = match self.jobs.iter().position(|(k, _)| k == id) {
            Some(at) => at,
            None => {
                self.jobs.push((id.to_string(), Job::new(id)));
                self.jobs.len() - 1
            }
        };
        &mut self.jobs[at].1
    }
}

impl Jobs {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `jobUpdate(id, patch)`: nothing without an id.
    pub fn update(&self, id: Option<&str>, patch: Vec<(&str, Field)>) {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return;
        };
        let mut state = self.lock();
        let job = state.job(id);
        for (k, v) in patch {
            job.set(
                k,
                match v {
                    Field::Set(v) => Some(v),
                    Field::Unset => None,
                },
            );
        }
        let event = sse::event(&job.shown());
        // a listener whose page has gone is dropped by its stream; a send to it fails quietly
        for (_, send) in &job.listeners {
            let _ = send.send(event.clone());
        }
        while state.jobs.len() > JOB_LIMIT {
            state.jobs.remove(0);
        }
    }

    /// `jobUpdate` with the fields every stage sets.
    pub fn stage(&self, id: Option<&str>, stage: &str, percent: Option<f64>, message: &str) {
        self.update(
            id,
            vec![
                ("stage", json!(stage).into()),
                ("percent", percent.map_or(Value::Null, |p| json!(p)).into()),
                ("message", json!(message).into()),
            ],
        );
    }

    /// Whether a job by this id is running and can be cancelled (`cancels.has(id)`).
    pub fn running(&self, id: &str) -> bool {
        self.lock().cancels.contains_key(id)
    }

    /// `cancellable(id, fn)`: runs `f` as the job `id`, which [`Jobs::cancel`] can then stop.
    /// Without an id it is just run.
    pub fn cancellable<T>(
        &self,
        id: Option<&str>,
        f: impl FnOnce() -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return f();
        };
        let token = Token::new();
        {
            let mut state = self.lock();
            if state.cancels.contains_key(id) {
                return Err(Failure::user("that job is already running"));
            }
            state.cancels.insert(id.to_string(), token.clone());
        }
        // removed however `f` ends, a panic included
        struct Running<'a>(&'a Jobs, &'a str);
        impl Drop for Running<'_> {
            fn drop(&mut self) {
                self.0.lock().cancels.remove(self.1);
            }
        }
        let _running = Running(self, id);
        cancel::with_cancel(Some(token), f)
    }

    /// `cancelJob(id)`: asks a running job to stop. False when there is none by that id:
    /// finished, or never started.
    pub fn cancel(&self, id: &str) -> bool {
        let token = match self.lock().cancels.get(id) {
            Some(t) => t.clone(),
            None => return false,
        };
        // said at once, so the page shows it is being stopped while the step in hand winds up
        if !token.is_cancelled() {
            self.update(
                Some(id),
                vec![
                    ("message", json!("Cancelling").into()),
                    ("cancelling", json!(true).into()),
                ],
            );
        }
        token.cancel();
        true
    }

    /// `GET /api/jobs/<id>/stream`: what the job says now, then each change. A job nobody has
    /// started yet is listened to all the same: the page opens the stream as it starts the work.
    pub fn stream(self: &std::sync::Arc<Jobs>, id: &str) -> Reply {
        let (send, events) = channel();
        let (first, listener) = {
            let mut state = self.lock();
            state.next_listener += 1;
            let listener = state.next_listener;
            let job = state.job(id);
            let first = sse::event(&job.shown());
            job.listeners.push((listener, send));
            (first, listener)
        };
        let jobs = std::sync::Arc::clone(self);
        let id = id.to_string();
        sse::stream(vec![first], events, move || {
            if let Some((_, job)) = jobs.lock().jobs.iter_mut().find(|(k, _)| *k == id) {
                job.listeners.retain(|(n, _)| *n != listener);
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(jobs: &Jobs, id: &str) -> String {
        crate::jsjson::stringify(&jobs.lock().job(id).shown())
    }

    #[test]
    fn a_job_keeps_its_fields_in_the_order_javascript_would() {
        let jobs = Jobs::default();
        jobs.update(None, vec![("stage", json!("x").into())]);
        assert!(jobs.lock().jobs.is_empty(), "no id, no job");
        jobs.update(
            Some("a"),
            vec![
                ("stage", json!("start").into()),
                ("percent", Value::Null.into()),
                ("message", json!("Starting").into()),
                ("done", json!(false).into()),
                ("cancelling", Field::Unset),
            ],
        );
        assert_eq!(
            shown(&jobs, "a"),
            r#"{"id":"a","stage":"start","percent":null,"message":"Starting","done":false}"#
        );
        jobs.update(Some("a"), vec![("extra", json!(1).into())]);
        jobs.update(
            Some("a"),
            vec![
                ("message", json!("Cancelling").into()),
                ("cancelling", json!(true).into()),
            ],
        );
        // `cancelling` was a key before `extra` was, so it is sent before it
        assert_eq!(
            shown(&jobs, "a"),
            r#"{"id":"a","stage":"start","percent":null,"message":"Cancelling","done":false,"cancelling":true,"extra":1}"#
        );
    }

    #[test]
    fn the_oldest_job_goes_when_there_are_too_many() {
        let jobs = Jobs::default();
        for n in 0..=JOB_LIMIT {
            jobs.update(Some(&format!("j{n}")), vec![]);
        }
        // an update to a job already there does not make it newer
        jobs.update(Some("j1"), vec![("stage", json!("late").into())]);
        let state = jobs.lock();
        assert_eq!(state.jobs.len(), JOB_LIMIT);
        assert!(state.jobs.iter().all(|(k, _)| k != "j0"));
        assert_eq!(state.jobs.first().map(|(k, _)| k.as_str()), Some("j1"));
    }

    #[test]
    fn a_job_runs_once_at_a_time_and_can_be_cancelled_while_it_runs() {
        let jobs = Jobs::default();
        assert!(!jobs.cancel("a"), "nothing to cancel");
        let out = jobs.cancellable(Some("a"), || {
            assert!(jobs.running("a"));
            let again = jobs.cancellable(Some("a"), || Ok(()));
            assert_eq!(again.unwrap_err().message(), "that job is already running");
            assert!(cancel::check_cancelled().is_ok());
            assert!(jobs.cancel("a"));
            let stopped = cancel::check_cancelled().unwrap_err();
            assert!(cancel::is_cancelled(&stopped));
            Ok(7)
        });
        assert_eq!(out.unwrap(), 7);
        assert!(!jobs.running("a"));
        assert!(!jobs.cancel("a"), "it has ended");
        assert_eq!(
            shown(&jobs, "a"),
            r#"{"id":"a","stage":"start","percent":null,"message":"Cancelling","done":false,"cancelling":true}"#
        );
        // without an id it is just run
        assert_eq!(jobs.cancellable(None, || Ok(1)).unwrap(), 1);
    }

    #[test]
    fn job_ids() {
        for ok in ["a", "A-b_9", &"x".repeat(64)] {
            assert!(is_job_id(ok), "{ok}");
        }
        for bad in ["", "a b", "a/b", "é", &"x".repeat(65)] {
            assert!(!is_job_id(bad), "{bad}");
        }
    }
}
