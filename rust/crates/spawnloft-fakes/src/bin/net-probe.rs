//! The C1 network checks (rust/PLAN-CORE-PORT.md, phase C1): fetches each URL given through
//! spawnloft-lib's download code, the same agent a download uses, and prints what came back. CI
//! runs it built static for musl, on x64 and arm64, on the runner and in containers with no CA
//! store, to show that name resolution and TLS (the bundled webpki roots) work there; and with
//! proxy variables pointing at a port that refuses, to show they are ignored as Node's fetch
//! ignores them. Test-only; never shipped.
//!
//!   net-probe <url>...     prints {"url":...,"bytes":n} for each; exits 1 on the first failure

use std::process::ExitCode;
use std::time::Duration;

fn main() -> ExitCode {
    let urls: Vec<String> = std::env::args().skip(1).collect();
    if urls.is_empty() {
        eprintln!("usage: net-probe <url>...");
        return ExitCode::from(2);
    }
    for url in &urls {
        match spawnloft_lib::download::fetch_capped(
            url,
            64 << 20,
            Duration::from_secs(30),
            2,
            Duration::from_secs(2),
            url,
        ) {
            Ok(body) => println!("{}", serde_json::json!({ "url": url, "bytes": body.len() })),
            Err(e) => {
                print!("{}", e.stderr_text());
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}
