//! `cmdUi` of mcctl.mjs: `spawnloft ui` (and `panel`) from a terminal. It starts the panel on
//! 127.0.0.1 and hands a browser a one-use sign-in link; `--link` starts nothing and prints a
//! fresh link for the panel already running. The window's form (`ui --exit-with-stdin`) is
//! `cli::ui`: it signs its own requests and no link is made.

use spawnloft_lib::failure::Failure;
use spawnloft_lib::panel::{self, StartError};
use spawnloft_lib::{panel_auth, panel_open};

use super::Ctx;
use super::args::Flag;

/// `loginLink(key, port, to)`.
struct Link {
    url: String,
    nonce: String,
}

fn login_link(key: &panel_auth::Key, port: u16, to: Option<&str>) -> Result<Link, Failure> {
    let (url, nonce) = panel_auth::login_link(key, port, to).map_err(Failure::user)?;
    Ok(Link { url, nonce })
}

/// `handOver(link, { open, what })`: gives a browser a one-use sign-in link. Opening it goes
/// through a private page in the config folder (`panel_open`), never through a command line
/// other accounts can read. The link is printed as well: a browser installed as a Snap or
/// Flatpak cannot read that folder, and over SSH there is no browser to open.
fn hand_over(ctx: &mut Ctx<'_>, link: &Link, open: bool, what: &str) {
    if open {
        match panel_open::write_open_file(&link.url, &link.nonce) {
            Ok(file) => {
                panel_open::open_in_browser(&file);
                ctx.out.line(&format!(
                    "Opening {what} in your browser. If it does not open, use this link (it works once, for 5 minutes):"
                ));
                ctx.out.line(&format!("  {}", link.url));
                return;
            }
            Err(e) => ctx.out.line(&format!("Could not open a browser for you ({e}).")),
        }
    }
    ctx.out.line(&format!(
        "Open this link in your browser to sign in to {what} (it works once, for 5 minutes):"
    ));
    ctx.out.line(&format!("  {}", link.url));
}

pub fn ui(ctx: &mut Ctx<'_>) -> Result<(), Failure> {
    // `Number(flags.port ?? 8770)`; what is not a port is refused before anything listens
    let port = match ctx.args.get("port") {
        None => 8770,
        Some(flag) => {
            let n = flag.number();
            if n.fract() != 0.0 || !(0.0..=65535.0).contains(&n) {
                return Err(Failure::user(format!(
                    "`{}` is not a port number. Pick one with --port <n>.",
                    flag.text()
                )));
            }
            n as u16
        }
    };
    let is = |key: &str, value: bool| ctx.args.get(key) == Some(&Flag::Bool(value));
    // --launcher signs in to the game launcher's page instead of the panel's. --no-open only
    // prints the link (a machine reached over SSH). --link starts nothing: it prints a fresh
    // link for the panel already running on the port.
    let launcher = is("launcher", true);
    let link = is("link", true);
    // a machine with no display has no browser to open: only print
    let open = !is("open", false) && !link && panel_open::can_open();
    let to = launcher.then_some("/launcher");
    let other_port = if port == 8770 {
        String::new()
    } else {
        format!(" --port {port}")
    };
    let key = || panel_auth::load_key().map_err(Failure::user);

    if link {
        if !panel::is_panel_at(port) {
            return Err(Failure::user(format!(
                "no SpawnLoft panel of yours is running on port {port}. Start one with: spawnloft ui{other_port}"
            )));
        }
        let made = login_link(&key()?, port, to)?;
        hand_over(
            ctx,
            &made,
            false,
            if launcher { "the launcher" } else { "the panel" },
        );
        return Ok(());
    }
    let listening = match panel::listen(port, Ok(ctx.layout.clone())) {
        Ok(l) => l,
        Err(StartError::InUse) => {
            // this user's own panel holds the port: sign this browser in to it rather than
            // start another
            if panel::is_panel_at(port) {
                ctx.out
                    .line(&format!("A SpawnLoft panel is already running on port {port}."));
                let made = login_link(&key()?, port, to)?;
                hand_over(ctx, &made, open, if launcher { "its launcher" } else { "it" });
                return Ok(());
            }
            return Err(Failure::user(format!(
                "port {port} is already in use by another program. Pick another with --port <n>."
            )));
        }
        Err(StartError::Other(e)) => return Err(Failure::user(e)),
    };
    let bound = listening.port();
    ctx.out
        .line(&format!("{}http://127.0.0.1:{bound}/", panel::READY_PREFIX));
    let made = login_link(listening.key(), bound, to)?;
    hand_over(
        ctx,
        &made,
        open,
        if launcher { "the launcher" } else { "the panel" },
    );
    ctx.out
        .line("Bound to 127.0.0.1 only — it can start servers and type console commands, so it is");
    ctx.out
        .line("for this machine, not the network. Ctrl+C to stop the panel (servers keep running).");
    ctx.out.line(&format!(
        "Lost the tab, or want another browser in? Run: spawnloft ui --link{other_port}"
    ));
    listening.serve();
    Ok(())
}
