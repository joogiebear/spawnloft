# Panel access: design for authenticating the local panel API

Status: **design for review, no code yet** (2026-11-13). Target: `v2` only, internal until Victor
says "push to beta". Answers the decision owed in `rust/beta-review/REVIEW.md` section 3.

## 1. The problem, as the code stands

The panel is an HTTP server on 127.0.0.1 that can create and start servers, type into consoles,
read and write files under any adopted folder, and start a Microsoft sign-in. Two processes serve
it:

| Listener | Where | Who talks to it |
| --- | --- | --- |
| `spawnloft-core ui` (Rust proxy) | random port per launch, `rust/crates/spawnloft-lib/src/panel.rs` | the Tauri window, and the shell's own `panel_get` (`spawnloft-shell/src/local.rs`) |
| Node panel behind the proxy | a second random port, `src/ui.mjs`, started by the proxy | meant for the proxy only, but any local program can connect to it directly |
| Node panel alone (`spawnloft ui`) | port 8770, `mcctl.mjs` `cmdUi` | the person's browser; README documents `ssh -L 8770:...` for a headless box |

Both apply one rule (`isLocalRequest`, `ui.mjs:1388`; `is_local_request`, `panel.rs:338`): Host
must name loopback, and an Origin, when present, must equal Host. That stops web pages and DNS
rebinding. A request with **no Origin** passes, so any program of any account on the machine has
the whole API. The review showed `adopt` plus the files API reading another directory, and `adopt`
plus `start` running a jar as the panel's user.

Everything else in the product is already per-user: the daemon pipe has a one-user DACL, the
control socket is 0600 in a 0700 folder, secret files are 0600 or ACL'd (`src/private-files.mjs`),
RCON and the databases have passwords, the game harness port has a token. The panel is the one
door without a lock.

What does **not** use the HTTP API today, checked: the CLI commands (they call the modules
in-process), the MCP server (stdio), task shims and server launchers, the bot host. So only four
kinds of caller need a credential: the window, a browser, the shell's two GETs, and the tests.

## 2. Who this protects against

In scope:

- another account on the same machine (family PC with fast user switching, shared Linux box);
- anything that shares loopback without sharing the user's files: a forwarded port (`ssh -L`,
  WSL2 mirrored networking, a container on host networking), a sandboxed app;
- web pages, including pages on other loopback ports (already covered; kept and tightened).

Out of scope, on purpose: a program running **as the same user**. It can read the key file, the
RCON passwords and the Microsoft tokens, and drive the daemon pipe directly. No local scheme stops
it, and the design does not pretend to.

## 3. Design

### 3.1 One secret per install, never sent anywhere

`<config>/panel.key`: 32 random bytes, base64url, one line. `<config>` is `%APPDATA%\spawnloft` or
`~/.config/spawnloft` (the folder of `settings.json`), not the data root, because the data root can
sit on a shared drive whose ACL lets every account read it, can be moved, and is what backups
copy. Created on first need by whichever side starts a panel first (Rust or Node), with
create-if-absent semantics and the existing private-file treatment (0600; on Windows the explicit
one-user ACL, which `private-files.mjs` and `platform/windows.rs` both already know how to make).
A reader that finds a short file treats it as not there yet and retries.

The key is **never put in a request, a URL, a cookie, an environment variable or a log**. It only
signs short tokens (HMAC-SHA256). That matters because port 8770 is a fixed, well-known port:
another account can bind it first and wait for a client to hand over whatever it sends.

The diagnostics bundle and `doctor` must never include the file (add it to the redaction test).

### 3.2 Signed tokens

One format, made by anything that can read the key, checked by both listeners:

```
v1.<purpose>.<port>.<expires>.<nonce>.<mac>
mac = HMAC-SHA256(key, "v1." purpose "." port "." expires "." nonce)
```

- `port` is the port of the listener the token is for. A token handed to an impostor on 8770 is
  worthless at the real panel on any other port, and the real panel cannot be on 8770 at the same
  time.
- `expires` is epoch seconds. Same machine, so one clock.
- Two purposes:
  - `login`: valid 5 minutes, **one use** (the listener remembers used nonces until they expire;
    only nonces with a valid MAC are stored, so this cannot be flooded). Exchanged for a session.
  - `api`: valid 60 seconds, reusable. Sent as `Authorization: SpawnLoft <token>` by non-browser
    callers. Cheap to make, so a caller makes one per request.

### 3.3 Sessions for pages

`GET /auth?t=<login token>[&to=/launcher|/setup]` checks the token, makes a session id (32 random
bytes, held in memory by that listener only), and answers `303` to `/` (or the allowlisted `to`)
with

```
Set-Cookie: spawnloft_<port>=<session id>; HttpOnly; SameSite=Strict; Path=/
Referrer-Policy: no-referrer
Cache-Control: no-store
```

A cookie, not a header the page adds, because the pages reach the API in ways that cannot carry a
header: 9 `EventSource` streams, 4 `a.download` links, the `/launcher` iframe, the console and
launcher windows, and the page load itself. With a cookie, `ui.html` and `launcher.html` need no
change to any of those call sites.

Sessions die with the listener process. No `Max-Age`, no "remember this browser": a session id is
never derived from the key, so nothing that outlives the process ever sits in a browser profile.
At most 32 sessions, oldest dropped.

Known limit, accepted and to be written in the README: cookies are scoped to the host, not the
port, so a browser sends this cookie to **any** server on `127.0.0.1` the person visits. Plugin web
maps run as the same user and are no new risk. A hostile server of *another account* on loopback,
visited in the same browser while a CLI panel is running, would receive a live session id. The
window is not affected (its webview only ever visits the panel, section 3.6). The only way to
close this fully is to move every stream and download off cookies, about 15 call sites; not
proposed for 2.0.

### 3.4 The request rule, in order

Both listeners apply the same rule; one shared fixture file (`test/fixtures/contracts/panel-auth.json`,
run by `node --test` and by `cargo test`, like the existing contract fixtures) keeps them the same.

1. **Host** names loopback (`127.0.0.1`, `localhost`, `[::1]`) **and this listener's own port**.
   Today any port passes; the port check is new and free.
2. **Origin**, when present, equals Host exactly. Unchanged.
3. **`Sec-Fetch-Site`**, when present, is `same-origin` or `none`. New. SameSite cookies treat
   every loopback port as the same site, so a plugin web map's page could otherwise make
   cookie-carrying GETs (`<img>`, `<script>`) to the panel. Every current browser and all three
   webviews send this header to loopback.
4. **Open routes**, which skip step 5 (and step 3 where noted):
   - `GET /auth` (carries its own token);
   - `GET /api/auth/probe?c=<nonce>`: answers `{ "spawnloft": true, "proof": HMAC(key, "probe." port "." nonce) }`,
     so the CLI can tell a real panel of this user from something else on the port before opening
     a browser at it (replaces the unauthenticated `isPanelAt` call to `/api/client/launcher`);
   - `GET /api/client/accounts/login/callback`: Microsoft's redirect arrives cross-site on
     `localhost` with no cookie; it is already authenticated by its one-time `state`. Skips step 3.
5. **A credential**: a live session cookie for this port, or a valid `api` token. Otherwise:
   - `/api/...`: `401 {"error": "...", "code": "auth"}`;
   - a page: `401` with a small static page ("Open SpawnLoft from the app, or run `spawnloft ui`
     to get a new link"), no script, the same strict CSP as the sign-in callback page.

`ui.html` and `launcher.html` get one change each: their `api()` wrapper shows "This panel session
has ended" with the same instruction when it sees `code: "auth"`, instead of a generic error.

### 3.5 Proxy to Node

The proxy authenticates the client (steps 1 to 5), then forwards with the client's `Authorization`
header replaced by a fresh `api` token for the **upstream port**, and the session cookie removed.
The Node panel runs the same rule as when it stands alone; there is no "trust the proxy" mode and
no second secret in an environment variable (which the Minecraft servers started later would
inherit). A program that connects straight to the Node port gets a 401 like anywhere else.

The routes the proxy answers itself (`/api/update...`, the handover routes) sit behind the same
check because it runs before the route split (`panel.rs:403`).

### 3.6 Shell handoff (the Tauri window)

- The shell reads the key through `spawnloft-lib` and makes tokens itself; nothing secret is added
  to the core's stdout line.
- `open_panel` (`main.rs`) navigates the main window to `/auth?t=...` (with `to=/setup` when the
  first-run check says so) instead of `/`. The first-run check and `open_profile_folder` send an
  `api` token through `local::panel_get`.
- The console and launcher windows are opened by the page (`window.open` on the panel origin) and
  share the app's cookie store, so they need nothing. **To prove before building on it**: that all
  three webviews (WebView2, WKWebView, webkit2gtk) share cookies between windows of the app and
  accept a `Set-Cookie` on a 303 from plain-http loopback. `smoke-tauri.cjs` covers Linux; Windows
  and the Mac mini need one manual run each. Fallback if one does not: the shell passes a login
  link to each child window (`open_child` already builds their URLs).
- A restarted core has a new port; the shell makes a new login token, as it already makes a new
  capability. `bridge.rs` logs URLs through `redact`, which must drop the `t` parameter.
- The navigation guard, the per-origin capability and the nine bridge commands do not change.

### 3.7 CLI handoff (`spawnloft ui`, a browser)

- `spawnloft ui` starts the panel, makes a login token and opens the browser. It does **not** put
  the link on a command line: on Linux and macOS every account can read other processes'
  arguments, and a login link there could be used by someone else first. It writes
  `<data root>/run/panel-open-<pid>.html` (private file, redirects to the link), opens that file,
  and deletes it when the token is used or after 5 minutes. Jupyter does the same for the same
  reason.
- `--no-open` prints the link to the terminal (the SSH-tunnel case in the README). The link works
  once, for 5 minutes.
- `spawnloft ui --link` (new): prints a fresh link for the panel **already running** on the port,
  after the probe proves it is this user's panel. This is how a lost tab or a second browser gets
  in without restarting the panel. `--launcher` with a panel already running does the same and
  opens `/launcher`.
- No new command prints the key itself. A script can still call the API: it reads the key file and
  signs an `api` token, which the README security section will describe in a few lines. See open
  question 3.

### 3.8 Upgrade from 1.x

- **Nothing to migrate and no data-format bump.** The key file appears on the first 2.0 panel
  start. 1.x ignores it, so a rollback is unaffected (and the 1.x panel is open again, as before).
- The installer needs no step. During the handover the 1.x panel is force-closed already (design
  2.3.1); a 1.x daemon keeps running but has no HTTP surface.
- 1.x task shims, server launchers, MCP configs and the `SpawnLoft.exe <...>\mcctl.mjs` argv form
  never touch the HTTP API, so the forwarders keep working unchanged.
- What a 1.x user notices after 2.0: a bookmark or open tab at `http://127.0.0.1:8770/` shows the
  "open SpawnLoft" page instead of the panel, and `curl` against the API returns 401. Both go in
  the release notes; the draft's known issue "The panel trusts programs on this computer"
  (`beta-review/RELEASE-NOTES-DRAFT.md:69`) is removed.
- `rust-internal.yml` still builds and smoke-tests the Electron window on `v2`.
  `desktop/main.js` calls `ui.serve` in-process, so `serve()` returns a `loginUrl()` function and
  `main.js` loads that (about 5 lines) for as long as that job exists.

### 3.9 What is rejected, and why

| Option | Why not |
| --- | --- |
| A per-launch secret only (the review's sketch) | Fine for the window, but a second process (`ui --link`, `--launcher` onto a running panel, a script) cannot get in without a runtime file per panel, which is the key file again with stale-file cleanup added. |
| The key as a bearer token or in a cookie | It would be sent to whatever listens on 8770, and would sit in a browser profile for as long as the install lives. |
| A header token kept in page storage, no cookie | Port-scoped, so it closes the limit in 3.3, but streams, downloads, the iframe and page loads cannot send headers; tokens would go in about 15 URLs. Reconsider when the panel moves to Rust (R6). |
| Node panel on a Unix socket or named pipe behind the proxy | Removes the second TCP listener, but `spawnloft ui` alone still needs TCP for a browser, so both paths would remain; and libuv's default pipe ACL on Windows is not ours to set. |
| Peer-credential checks on the TCP connection | No portable way to learn the peer's account for a loopback TCP connection on all three systems. |
| A password the person types | A prompt on every start for a local app; and nothing for the window to do with it. |
| An off switch (environment variable or flag) | It would be the first thing a troubleshooting guide says to set. Tests use real tokens. |

## 4. Size and order of work

New code, rough: Rust `panel_auth` module (key file, tokens, sessions, the rule) 250 lines plus
60 in `panel.rs`; Node the same logic in a new `src/panel-auth.mjs` 150 lines plus 40 in `ui.mjs`
and 40 in `mcctl.mjs`; shell 40; pages 20. Tests and fixtures about 400, and a mechanical edit of
the roughly 15 test files and 3 smoke scripts that call the panel over HTTP (`serve()` returns a helper
that adds the header). The review's "about 100 lines" covered the window only.

New direct Rust dependencies (each needs its `SUPPLY-CHAIN.md` row): `hmac` (RustCrypto, pairs
with the `sha2` already used) and `getrandom`. Both are in `Cargo.lock` today through rustls. No
hand-written HMAC or constant-time compare.

Proposed threads, in order, all into `v2`:

1. **Mechanism** (Opus builds, Fable reviews before merge; it is security work): the shared
   fixture first, then `panel_auth` in Rust and Node, the rule in both listeners, the proxy's
   upstream token, the 401 page, test helpers. The window still works at the end of this PR
   because it includes the minimal shell change (3.6 first two bullets).
2. **Handoffs and words** (Opus, Sonnet for the texts): the open-file flow, `--link`, the probe,
   the page's "session ended" notice, the Electron `main.js` line, README security section,
   CLIENT.md, release-notes draft, beta checklist line 16.
3. **Hardware checks** (Victor, with a thread driving): the cookie-sharing proof on Windows and
   the Mac mini, a second account on Desktop-Main or the Linux VM trying `curl` against both
   ports, and the SSH-tunnel flow on the Linux VM.

Acceptance, all scripted except thread 3: a request with no credential gets 401 on both
listeners, on every route of the contract fixture except the three open ones; a login link works
once and not on another port; an expired or altered token fails; the Node port refuses a direct
caller while the window keeps working; `smoke-tauri.cjs` passes with the console and launcher
windows open; the diagnostics bundle does not contain the key.

## 5. Open questions for Victor

1. **When.** The review said "before 2.0.0 stable, a beta blocker only if shared machines are a
   target". Recommendation: build it now, before the public beta. It changes what `spawnloft ui`
   prints and what a bookmark does, and a major version's first beta is the cheapest place for
   that; doing it between beta and stable means changing it under beta users.
2. **No "remember this browser".** With this design a browser tab works until the panel process
   stops; after a restart the person needs a new link (`spawnloft ui` opens one by itself). A
   remembered browser would be friendlier for the headless SSH-tunnel case and weaker on a shared
   machine. Recommendation: no remembering in 2.0.
3. **Scripts against the API.** The HTTP API was never documented as public, but `curl` worked.
   Options: (a) say in the README how to sign a token from the key file, no helper (recommended);
   (b) add `spawnloft ui --token` that prints a 60-second token for scripts; (c) say the API is
   internal and offer nothing.
4. **1.x.** 1.5.x has the same gap and keeps it. Recommendation: no backport; the Electron line
   is retired and 2.0 is the fix. Say so in the 2.0 release notes. Different answer only if 2.0
   stable is months away.
5. **The Electron job on `v2`.** If the Electron package and `smoke-desktop.cjs` jobs in
   `rust-internal.yml` are going away soon anyway, thread 2 skips the `main.js` change and removes
   the job's panel checks instead. Keep or drop?

## 6. Checked while reading, not part of this work

- The game harness port already has a per-launch token (`src/client-harness.mjs`), and the
  databases, RCON and the daemon control channel are per-user or password-protected. No other
  unauthenticated local listener was found; a dedicated sweep was not done.
- `README.md:425-432` describes the current rule ("an unauthenticated local HTTP server");
  it is rewritten in thread 2.
