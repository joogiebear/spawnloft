//! Which route a request is: `route()` of `ui.mjs`, branch for branch and in its order, because a
//! path that fits two branches goes to the first.
//!
//! While the port is under way (rust/PLAN-CORE-PORT.md C8) a branch that has not moved yet is
//! [`Routed::NotPorted`], decided on the method and the path alone: the body has not been read,
//! so the listener can still send the request on to the Node panel whole.

use serde_json::json;

use crate::failure::Failure;
use crate::{services, software};

use super::Panel;
use super::http::{Reply, Request, failure_reply};
use super::{
    backups, basics, client, creates, databases, players, plugins, schedules, server_files, server_props,
    servers, worlds,
};

/// Whether the routes that start a job are answered here; see `chain`.
const JOBS_MOVED: bool = true;

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
        return client::route(panel, layout, req);
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
    if s1 == "scheduler" && s2 == "linger" && post {
        return servers::linger(panel, layout);
    }
    let s3 = req.seg(3).unwrap_or("").to_string();
    // A job's progress is kept by the process that runs the job. Until every route that starts
    // one has moved (creates, plugin and modpack installs, a database for a server, a game
    // launch), the jobs are the Node panel's and so are these two.
    if s1 == "jobs" && !JOBS_MOVED {
        return Ok(Routed::NotPorted);
    }
    if s1 == "jobs" && s3 == "cancel" && n == 4 && post {
        return reply(Reply::ok(json!({ "cancelling": panel.jobs.cancel(&s2) })));
    }
    if s1 == "jobs" && s3 == "stream" && get {
        return reply(panel.jobs.stream(&s2));
    }
    if s1 == "software" && n == 2 && get {
        return reply(basics::software_list());
    }
    if s2 == "versions" && n == 3 && get && software::is_software(&s1) {
        return reply(basics::software_versions(&s1)?);
    }
    if s1 == "modpacks" && s2 == "search" && get {
        return plugins::modpack_search(panel, layout, req);
    }
    // databases are kept out of the server list so nothing that iterates servers sees one
    // (with nothing after it and another method it is, as in ui.mjs, a server with no name)
    if s1 == "databases" && (n > 2 || get || post) {
        return databases::route(panel, layout, req);
    }
    if s1 == "instances" && n == 2 && get {
        return servers::list(panel, layout);
    }
    if s1 == "activity" && n == 2 && get {
        return servers::activity(panel, layout, req);
    }
    if s1 == "overview" && n == 2 && get {
        return servers::overview(panel, layout);
    }
    if s1 == "instances" && s2 == "adopt" && post {
        return creates::adopt(panel, layout, req);
    }
    if s1 == "instances" && post && n == 2 {
        return creates::create(panel, layout, req);
    }

    // everything below is about one server (or one database, which the registry also holds)
    let name = s2;
    if name.is_empty() || !services::has_instance(layout, &name)? {
        return reply(Reply::error(404, "no such instance"));
    }
    if s3 == "stream" && get {
        return servers::console_stream(panel, layout, &name);
    }
    // these take GET and POST, so they sit above the POST-only gate below
    match s3.as_str() {
        "join" if req.seg(4).is_none() => return servers::join(panel, layout, req, &name),
        "props" | "icon" => return server_props::route(panel, layout, req, &name),
        "backups" => return backups::route(panel, layout, req, &name),
        "schedules" => return schedules::route(panel, layout, req, &name),
        "players" => return players::route(panel, layout, req, &name),
        "plugins" | "upgrade" | "pack" => return plugins::route(panel, layout, req, &name),
        "worlds" => return worlds::route(panel, layout, req, &name),
        "files" => return server_files::route(panel, layout, req, &name),
        "activity" | "console" | "diag" | "metrics" => return servers::reads(panel, layout, req, &name),
        "diagnose" | "databases" if get => return servers::reads(panel, layout, req, &name),
        _ => {}
    }
    if !post {
        return reply(Reply::method_not_allowed());
    }
    if s3 == "databases" && req.seg(4) == Some("create") {
        return databases::create_for_server(panel, layout, req, &name);
    }
    servers::act(panel, layout, req, &name)
}
