//! The server lifecycle (C2): `start`, `stop`, `restart`, `kill`, `cmd` (and `rcon`), `send`,
//! `players` and `console` (and `attach`): `cmdStart` to `cmdConsole` in mcctl.mjs.

use std::path::Path;
use std::sync::mpsc;

use spawnloft_lib::activity::{self, Actor};
use spawnloft_lib::control::Status;
use spawnloft_lib::failure::Failure;
use spawnloft_lib::paths::Roots;
use spawnloft_lib::registry::{self, Instance};
use spawnloft_lib::supervisor::{self, StartOptions};
use spawnloft_lib::{js, platform, rcon};

use super::Ctx;
use super::args::Flag;

/// The command line's actor in the activity log (`{ kind: 'cli' }`).
pub fn cli() -> Actor {
    Actor::new("cli", None)
}

fn lookup(ctx: &Ctx<'_>, name: &str) -> Result<Instance, Failure> {
    registry::lookup(Path::new(&ctx.layout.registry_file), name)
}

fn flag_is(ctx: &Ctx<'_>, key: &str, value: bool) -> bool {
    ctx.args.get(key) == Some(&Flag::Bool(value))
}

fn truthy(ctx: &Ctx<'_>, key: &str) -> bool {
    ctx.args.get(key).is_some_and(Flag::truthy)
}

/// `Number(flags[key] ?? fallback) * 1000`.
fn seconds_ms(ctx: &Ctx<'_>, key: &str, fallback: f64) -> f64 {
    ctx.args.get(key).map_or(fallback, Flag::number) * 1000.0
}

fn not_running(name: &str) -> Failure {
    Failure::user(format!("instance \"{name}\" is not running"))
}

pub fn start(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "start")?.to_string();
    let wait = !flag_is(ctx, "wait", false) && !truthy(ctx, "detach");
    let timeout = seconds_ms(ctx, "timeout", 180.0);
    ctx.out.line(&format!("Starting \"{name}\"..."));
    let opts = StartOptions {
        wait,
        timeout,
        sync: !flag_is(ctx, "sync", false),
        force: truthy(ctx, "force"),
    };
    let res = supervisor::start(ctx.layout, &cli(), &name, opts)?;
    let inst = lookup(ctx, &name)?;
    let kind = if inst.is_database() { "database" } else { "java" };
    let pid = js::string(Some(&res.java_pid));

    if !wait {
        ctx.out
            .line(&format!("Launched ({kind} pid {pid}). Not waiting for ready."));
        ctx.out.line(&format!("Follow with: spawnloft logs {name} -f"));
        return Ok(());
    }
    if res.ready {
        ctx.out.line(&format!(
            "Ready - {}",
            res.ready_line.as_deref().unwrap_or("undefined")
        ));
        let rcon = if inst.is_database() {
            String::new()
        } else {
            format!("   rcon {}", rcon_port_text(&inst)?)
        };
        ctx.out.line(&format!(
            "  {kind} pid {pid}   port {}{rcon}",
            js::string(inst.get("port"))
        ));
        return Ok(());
    }
    if res.failed {
        ctx.out.line(&format!(
            "Server did not reach ready state: {}",
            res.reason.as_deref().unwrap_or("undefined")
        ));
        super::why::print_findings(ctx, &name)?;
        ctx.out.line("");
        ctx.out.line("Last 25 console lines:");
        let file = ctx.layout.console_log(&name);
        for line in supervisor::tail_log(Path::new(&file), 25.0)? {
            ctx.out.line(&format!("  {line}"));
        }
        ctx.out.set_code(1);
        return Ok(());
    }
    ctx.out.line(&format!(
        "Timed out after {}s waiting for ready. The server may still be loading.",
        js::number_to_string(timeout / 1000.0)
    ));
    ctx.out.line(&format!("Follow with: spawnloft logs {name} -f"));
    ctx.out.set_code(1);
    Ok(())
}

/// `inst.rcon.port` in a template: a record with no `rcon` crashes the Node core here.
fn rcon_port_text(inst: &Instance) -> Result<String, Failure> {
    match inst.get("rcon") {
        None | Some(serde_json::Value::Null) => Err(Failure::type_error(format!(
            "Cannot read properties of {} (reading 'port')",
            js::string(inst.get("rcon"))
        ))),
        Some(r) => Ok(js::string(r.get("port"))),
    }
}

pub fn stop(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "stop")?.to_string();
    let timeout = seconds_ms(ctx, "timeout", 90.0);
    ctx.out.line(&format!("Stopping \"{name}\"..."));
    let res = supervisor::stop(ctx.layout, &cli(), &name, timeout)?;
    if res.already_stopped {
        ctx.out.line(&format!("\"{name}\" was not running."));
    } else if res.forced {
        ctx.out.line(&format!(
            "\"{name}\" did not shut down gracefully and was killed."
        ));
    } else {
        // `res.code ?? 0`
        let code = match res.reply.as_ref().and_then(|r| r.get("code")) {
            None | Some(serde_json::Value::Null) => "0".to_string(),
            v => js::string(v),
        };
        ctx.out.line(&format!("\"{name}\" stopped (exit code {code})."));
    }
    Ok(())
}

pub fn restart(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "restart")?.to_string();
    let (status, _) = supervisor::read_state(ctx.layout, &name)?;
    if matches!(status, Status::Running | Status::Stopping) {
        ctx.out.line(&format!("Stopping \"{name}\"..."));
        supervisor::stop(ctx.layout, &cli(), &name, seconds_ms(ctx, "timeout", 90.0))?;
    }
    start(ctx)
}

pub fn kill(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "kill")?.to_string();
    let res = supervisor::kill(ctx.layout, &cli(), &name)?;
    if res.already_stopped {
        ctx.out.line(&format!("\"{name}\" was not running."));
    } else {
        ctx.out.line(&format!("\"{name}\" force-killed."));
    }
    Ok(())
}

fn rcon_failure(e: rcon::ExecError) -> Failure {
    Failure::user(e.message)
}

pub fn cmd(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "cmd")?.to_string();
    let command = js::trim(&ctx.args.positional[1..].join(" ")).to_string();
    if command.is_empty() {
        return Err(Failure::user(
            "cmd requires a command, e.g. spawnloft cmd survival \"tps\"",
        ));
    }
    let inst = lookup(ctx, &name)?;
    if !supervisor::is_running(ctx.layout, &name)? {
        return Err(not_running(&name));
    }
    let opts = rcon::ExecOptions {
        retry_sent: false,
        ..rcon::ExecOptions::default()
    };
    let response = rcon::exec(&inst, &[&command], opts)
        .map_err(rcon_failure)?
        .remove(0);
    activity::record_by(
        &Roots::new(&ctx.layout.data_root),
        &cli(),
        &name,
        "command",
        Some(&command),
        None,
        true,
    );
    let text = if truthy(ctx, "raw") {
        response
    } else {
        rcon::strip_colors(&response)
    };
    if js::trim(&text).is_empty() {
        ctx.out.line("(no output)");
    } else {
        ctx.out.line(js::trim_end(&text));
    }
    Ok(())
}

pub fn send(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "send")?.to_string();
    let line = ctx.args.positional[1..].join(" ");
    if js::trim(&line).is_empty() {
        return Err(Failure::user(
            "send requires a line to write to the server console",
        ));
    }
    supervisor::send_console(ctx.layout, &cli(), &name, &line)?;
    ctx.out.line(&format!("> {line}"));
    Ok(())
}

pub fn players(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    let name = super::require_name(&ctx.args.positional, "players")?.to_string();
    let inst = lookup(ctx, &name)?;
    if !supervisor::is_running(ctx.layout, &name)? {
        return Err(not_running(&name));
    }
    let res = rcon::exec(&inst, &["list"], rcon::ExecOptions::default())
        .map_err(rcon_failure)?
        .remove(0);
    ctx.out.line(js::trim(&rcon::strip_colors(&res)));
    Ok(())
}

enum Event {
    Log(String),
    Input(String),
    Closed,
}

/// `console <name>`: the console's tail and new lines, with typed lines sent to the server until
/// `/detach`, `/exit`, the end of input or (at a terminal) Ctrl-C.
pub fn console(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    use std::io::{BufRead, IsTerminal};

    let name = super::require_name(&ctx.args.positional, "console")?.to_string();
    lookup(ctx, &name)?;
    if !supervisor::is_running(ctx.layout, &name)? {
        return Err(not_running(&name));
    }
    ctx.out.line(&format!(
        "--- attached to \"{name}\" (ctrl-c or \"/detach\" to leave; the server keeps running) ---"
    ));
    let file = ctx.layout.console_log(&name);
    for line in supervisor::tail_log(Path::new(&file), 20.0)? {
        ctx.out.line(&line);
    }

    let (tx, rx) = mpsc::channel::<Event>();
    let logs = tx.clone();
    let log_file = std::path::PathBuf::from(&file);
    // the follower and the reader are left to end with the process
    std::thread::spawn(move || {
        supervisor::follow_log(&log_file, |line| logs.send(Event::Log(line.to_string())).is_ok());
    });
    // readline's SIGINT, which it has only when it reads a terminal; elsewhere Ctrl-C ends the
    // process as Node's default does
    let terminal = std::io::stdin().is_terminal();
    if terminal {
        platform::watch_interrupts();
    }
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match stdin.lock().read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(Event::Closed);
                    return;
                }
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.strip_suffix('\n').unwrap_or(&text);
                    let line = line.strip_suffix('\r').unwrap_or(line);
                    if tx.send(Event::Input(line.to_string())).is_err() {
                        return;
                    }
                }
            }
        }
    });

    loop {
        if terminal && let Some(code) = platform::interrupted() {
            if code != 130 {
                // SIGTERM: Node ends there, with nothing more printed
                ctx.out.set_code(code);
                return Ok(());
            }
            break;
        }
        let event = match rx.recv_timeout(std::time::Duration::from_millis(50)) {
            Ok(e) => e,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match event {
            Event::Log(line) => ctx.out.line(&line),
            Event::Closed => break,
            Event::Input(line) => {
                let trimmed = js::trim(&line);
                if trimmed == "/detach" || trimmed == "/exit" {
                    break;
                }
                if trimmed.is_empty() {
                    continue;
                }
                if let Err(e) = supervisor::send_console(ctx.layout, &cli(), &name, trimmed) {
                    ctx.out.line(&format!("[spawnloft] {}", e.message()));
                }
            }
        }
    }
    ctx.out
        .line(&format!("--- detached from \"{name}\" (still running) ---"));
    Ok(())
}
