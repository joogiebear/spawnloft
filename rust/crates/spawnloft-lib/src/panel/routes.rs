//! Which route a request is: `route()` of `ui.mjs`, branch for branch and in its order, because a
//! path that fits two branches goes to the first.
//!
//! While the port is under way (rust/PLAN-CORE-PORT.md C8) a branch that has not moved yet is
//! [`Routed::NotPorted`], decided on the method and the path alone: the body has not been read,
//! so the listener can still send the request on to the Node panel whole.

use crate::failure::Failure;
use crate::software;

use super::Panel;
use super::basics;
use super::http::{Reply, Request, failure_reply};

pub enum Routed {
    Reply(Reply),
    /// A route the Node panel still answers.
    NotPorted,
}

/// Routes `req`. A failure is answered as `serve()` answers a throw.
pub fn route(panel: &Panel, req: &mut Request) -> Routed {
    match chain(panel, req) {
        Ok(routed) => routed,
        Err(f) => Routed::Reply(failure_reply(&f)),
    }
}

fn chain(panel: &Panel, req: &mut Request) -> Result<Routed, Failure> {
    // where the data is could not be read: the Node panel says why, as it did before
    let Some(layout) = &panel.layout else {
        return Ok(Routed::NotPorted);
    };
    let reply = |r: Reply| Ok(Routed::Reply(r));
    let get = req.method == "GET";
    let post = req.method == "POST";
    let n = req.seg.len();

    if req.path == "/" {
        return reply(basics::page_ui());
    }
    if req.path == "/launcher" {
        return reply(basics::page_launcher());
    }
    if req.path == "/setup" {
        return reply(basics::page_setup(panel));
    }
    if req.seg(0) != Some("api") {
        return reply(Reply::not_found());
    }
    let s1 = req.seg(1).unwrap_or("").to_string();
    let s2 = req.seg(2).unwrap_or("").to_string();

    if s1 == "setup" {
        return reply(basics::setup(panel, req)?);
    }
    if s1 == "appearance" && n == 2 {
        return reply(basics::appearance(req)?);
    }
    if s1 == "jars" && get {
        return reply(basics::jars(layout)?);
    }
    if s1 == "mcp" && n == 2 && get {
        return reply(basics::mcp());
    }
    if s1 == "client" {
        return Ok(Routed::NotPorted);
    }
    if s1 == "health" && get {
        return reply(basics::health(layout));
    }
    if s1 == "java" && s2 == "needs" && get {
        return reply(basics::java_needs(req));
    }
    if s1 == "java" && n == 2 && get {
        return reply(basics::java_list());
    }
    if s1 == "feedback" && get {
        return reply(basics::feedback(layout, req)?);
    }
    if s1 == "diagnostics" && get {
        return reply(basics::diagnostics(layout, req)?);
    }
    if s1 == "settings" && post {
        return reply(basics::settings_post(layout, req)?);
    }
    if s1 == "settings" && get {
        return reply(basics::settings_get(layout));
    }
    // scheduler/linger and the two job routes sit here in ui.mjs; none of them can be a path
    // the two below also fit, unless a software were named "scheduler" or "jobs"
    if (s1 == "scheduler" && s2 == "linger" && post) || s1 == "jobs" {
        return Ok(Routed::NotPorted);
    }
    if s1 == "software" && n == 2 && get {
        return reply(basics::software_list());
    }
    if s2 == "versions" && n == 3 && get && software::is_software(&s1) {
        return reply(basics::software_versions(&s1)?);
    }
    Ok(Routed::NotPorted)
}
