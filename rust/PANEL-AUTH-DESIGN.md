# Panel access: design for authenticating the local panel API

Status: **design accepted, no code yet** (2026-11-13, revised after a second-look review). Target: `v2` only, internal until Victor
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
the existing private-file treatment (0600; on Windows the explicit one-user ACL, which
`private-files.mjs` and `platform/windows.rs` both already know how to make).

Creation must be exclusive, which `writePrivateFile` is not today (it truncates and writes): write
the key to a private temporary file in the same folder, hard-link it to `panel.key` (which fails if
the name exists), delete the temporary file, then **always read the key back from `panel.key`**.
Two first starters (the core and the Node panel, or parallel test files on a fresh runner) then
end with the same key. Specified identically for Rust and Node.

The key is **never put in a request, a URL, a cookie, an environment variable or a log**. It only
signs short tokens (HMAC-SHA256). That matters because port 8770 is a fixed, well-known port:
another account can bind it first and wait for a client to hand over whatever it sends.

The diagnostics bundle and `doctor` must never include the file (add it to the redaction test).

### 3.2 Signed tokens

One format, made by anything that can read the key, checked by both listeners:

```
v1.<purpose>.<port>.<issued>.<nonce>.<mac>
mac = HMAC-SHA256(key, "v1." purpose "." port "." issued "." nonce)
```

- `port` is the port of the listener the token is for. A token handed to an impostor on 8770 is
  worthless at the real panel on any other port, and the real panel cannot be on 8770 at the same
  time.
- `issued` is epoch milliseconds. Same machine, so one clock. A listener refuses a token issued
  **before the listener itself started**, so nothing made for an earlier panel on the same port
  (a used login link, a captured `api` token) works after a restart.
- Two purposes:
  - `login`: valid 5 minutes, **one use** (the listener remembers used nonces until they expire;
    only nonces with a valid MAC are stored, so this cannot be flooded). Exchanged for a session.
  - `api`: valid 60 seconds, reusable, no nonce. Sent as `Authorization: SpawnLoft <token>` by
    non-browser callers. Cheap to make, so a caller makes one per request.

### 3.3 Sessions for pages

`GET /auth?t=<login token>[&to=/launcher|/setup]` checks the token, makes a session id (32 random
bytes, held in memory by that listener only), and answers `200` with a page that has no script
and one `<meta http-equiv="refresh">` to `/` (or the allowlisted `to`), with

```
Set-Cookie: spawnloft_<port>=<session id>; HttpOnly; SameSite=Strict; Path=/
Referrer-Policy: no-referrer
Cache-Control: no-store
```

A page and not a `303`, because the link is often opened from outside the origin (a local file,
section 3.7): a redirect would stay a cross-site navigation, on which a `SameSite=Strict` cookie
is not sent, and the person would land on the 401 page. The refresh starts a new, same-origin
navigation.

A cookie, not a header the page adds, because the pages reach the API in ways that cannot carry a
header: 9 `EventSource` streams, 4 `a.download` links, the `/launcher` iframe, the console and
launcher windows, and the page load itself. With a cookie, `ui.html` and `launcher.html` need no
change to any of those call sites.

Sessions die with the listener process, and after 15 minutes without a request (an open tab
polls and holds streams, so it never idles out; a closed one does). No `Max-Age`, no "remember
this browser": a session id is never derived from the key, so nothing that outlives the process
ever sits in a browser profile.

Known limit, accepted and to be written in the README: cookies are scoped to the host, not the
port, so a browser sends this cookie to **any** server on `127.0.0.1` the person visits. Plugin web
maps run as the same user and are no new risk. A server of *another account* on loopback, visited
in the same browser while a CLI panel is running, would receive a live session id. That includes
the ordinary case of that account binding the port of a stopped dynmap or BlueMap server whose
bookmark the person then opens. The idle expiry keeps a leaked id short-lived only once the tab is
closed. Any loopback server can also overwrite the cookie, which logs the person out. The window
is not affected (its webview only ever visits the panel, section 3.6). The only way to close this
fully is to move every stream and download off cookies, about 15 call sites; not proposed for 2.0.

### 3.4 The request rule, in order

Both listeners apply the same rule; one shared fixture file (`test/fixtures/contracts/panel-auth.json`,
run by `node --test` and by `cargo test`, like the existing contract fixtures) keeps them the same.

1. **Host** names loopback (`127.0.0.1`, `localhost`, `[::1]`). Unchanged. The port is not
   checked: a tunnel to a different local port (`ssh -L 9000:127.0.0.1:8770`) must keep working,
   and tokens and the cookie name already carry the port.
2. **Origin**, when present, equals Host exactly. Unchanged.
3. **`Sec-Fetch-Site`**, when present, is `same-origin` or `none`. New. SameSite cookies treat
   every loopback port as the same site, so a plugin web map's page could otherwise make
   cookie-carrying GETs (`<img>`, `<script>`) to the panel. When the header is absent (WebKit
   before Safari 16.4, older webkit2gtk) the request passes: such a GET cannot be read by the
   other page, and no GET changes state. That second fact becomes a tested rule (a test walks the
   route table and fails on a GET that writes). Refusing cookie requests without the header was
   considered and rejected: it would lock the window out on those systems.
4. **Open routes**, which skip steps 3 and 5:
   - `GET /auth` (carries its own token; reached from a local file or a pasted link);
   - `GET /api/client/accounts/login/callback`: Microsoft's redirect arrives cross-site on
     `localhost` with no cookie; it is already authenticated by its one-time `state`.
5. **A credential**: a live session cookie for this port, or a valid `api` token. Otherwise:
   - `/api/...`: `401 {"error": "...", "code": "auth"}`;
   - a page: `401` with a small static page ("Open SpawnLoft from the app, or run `spawnloft ui`
     to get a new link"), no script, the same strict CSP as the sign-in callback page.

There is no unauthenticated "is this a panel" route. The CLI's `isPanelAt` (today a plain GET of
`/api/client/launcher`) becomes an authenticated GET with an `api` token: only this user's panel
answers 200.

The pages need one behaviour, in more than one place: on `code: "auth"` show "This panel session
has ended" with the same instruction, and stop retrying. That is the two `api()` wrappers, the
five direct `fetch` calls in `ui.html` (near lines 9620, 13627, 14016, 14192, 14254), `setup.html`,
and the nine `EventSource` streams, which would otherwise reconnect for ever against a 401 (their
`onerror` asks an authenticated route once and closes the stream if that says `auth`).

### 3.5 Proxy to Node

The proxy authenticates the client (steps 1 to 5), then forwards with the client's `Authorization`
header replaced by a fresh `api` token for the **upstream port**, and the session cookie removed.
The Node panel runs the same rule as when it stands alone; there is no "trust the proxy" mode and
no second secret in an environment variable (which the Minecraft servers started later would
inherit). A program that connects straight to the Node port gets a 401 like anywhere else. The Node panel
started by the proxy (`ui --no-open --exit-with-stdin`, `panel.rs:214`) makes and prints no login
link.

The routes the proxy answers itself (`/api/update...`, the handover routes) sit behind the same
check because it runs before the route split (`panel.rs:403`).

### 3.6 Shell handoff (the Tauri window)

- The shell reads the key through `spawnloft-lib` and makes tokens itself; nothing secret is added
  to the core's stdout line.
- `open_panel` (`main.rs`) navigates the main window to `/auth?t=...` (with `to=/setup` when the
  first-run check says so) instead of `/`. The first-run check and `open_profile_folder` send an
  `api` token through `local::panel_get`.
- The console and launcher windows are not page popups: `on_new_window` denies the request and
  the shell builds a new window itself (`bridge.rs:519`, `open_child`). They get the session only
  if the app's windows share one cookie store. **To prove before building on it**: that all
  three webviews (WebView2, WKWebView, webkit2gtk) share cookies between windows of the app and
  accept a `Set-Cookie` from plain-http loopback. `smoke-tauri.cjs` covers Linux; Windows
  and the Mac mini need one manual run each. Fallback if one does not: the shell passes a login
  link to each child window (`open_child` already builds their URLs).
- A restarted core has a new port; the shell makes a new login token, as it already makes a new
  capability. `bridge.rs` logs URLs through `redact`, which already drops the whole query.
- The navigation guard, the per-origin capability and the nine bridge commands do not change.

### 3.7 CLI handoff (`spawnloft ui`, a browser)

- `spawnloft ui` starts the panel, makes a login token and opens the browser. It does **not** put
  the link on a command line: on Linux and macOS every account can read other processes'
  arguments, and a login link there could be used by someone else first. It writes a small
  redirect file and opens that instead, as Jupyter does for the same reason. The file goes in
  `<config>/open/` (0700, never the data root, which may be shared), under a random name, created
  exclusively, and is deleted when the token is used or after 5 minutes.
- The link is **always printed to the terminal as well**. Snap and Flatpak browsers (Ubuntu's
  default Firefox) cannot read files in dot-folders, so there the opened tab shows an error and
  the person uses the printed link. `--no-open` only prints (the SSH-tunnel case in the README).
  The link works once, for 5 minutes.
- `spawnloft ui --link` (new): prints a fresh link for the panel **already running** on the port,
  after the authenticated check in 3.4 shows it is this user's panel. This is how a lost tab or a
  second browser gets in without restarting the panel. `--launcher` with a panel already running
  does the same and opens `/launcher`.
- No new command prints the key itself. A script can still call the API: it reads the key file and
  signs an `api` token, which the README security section will describe in a few lines. See decision 3.

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
- `rust-internal.yml` still builds and smoke-tests the Electron window on `v2`, and
  `desktop/main.js` calls `ui.serve` in-process. That job is removed rather than taught to sign in
  (decision 5).

### 3.9 What is rejected, and why

| Option | Why not |
| --- | --- |
| A per-launch secret only (the review's sketch) | Fine for the window, but a second process (`ui --link`, `--launcher` onto a running panel, a script) cannot get in without a runtime file per panel, which is the key file again with stale-file cleanup added. |
| The key as a bearer token or in a cookie | It would be sent to whatever listens on 8770, and would sit in a browser profile for as long as the install lives. |
| A header token kept in page storage, no cookie | Port-scoped, so it closes the limit in 3.3, but streams, downloads, the iframe and page loads cannot send headers; tokens would go in about 15 URLs. Reconsider when the panel moves to Rust (R6). |
| Node panel on a Unix socket or named pipe behind the proxy | Removes the second TCP listener, but `spawnloft ui` alone still needs TCP for a browser, so both paths would remain; and libuv's default pipe ACL on Windows is not ours to set. |
| Peer-credential checks on the TCP connection | No portable way to learn the peer's account for a loopback TCP connection on all three systems. |
| A password the person types | A prompt on every start for a local app; and nothing for the window to do with it. |
| Checking the Host port, an open probe route with an HMAC proof, a nonce in `api` tokens, a cap on sessions | Each was in the first draft and bought nothing the port-bound token, the authenticated check and the idle expiry do not already give; the port check also broke tunnels to another local port. |
| An off switch (environment variable or flag) | It would be the first thing a troubleshooting guide says to set. Tests use real tokens. |

## 4. Size and order of work

New code, rough: Rust `panel_auth` module (key file, tokens, sessions, the rule) 250 lines plus
60 in `panel.rs`; Node the same logic in a new `src/panel-auth.mjs` 150 lines plus 40 in `ui.mjs`
and 40 in `mcctl.mjs`; shell 40; pages 20. Tests and fixtures about 400, and a mechanical edit of
the 11 test files and 3 smoke scripts that call the panel over HTTP (`serve()` returns a helper
that adds the header; `smoke-tauri.cjs:229` sends a DELETE from Node that needs one too). The review's "about 100 lines" covered the window only.

New direct Rust dependencies (each needs its `SUPPLY-CHAIN.md` row): `hmac` (RustCrypto) and `getrandom`. `getrandom` is in `Cargo.lock` already. The `hmac` there is
an older release that arrives through another crate and is built on a different `digest` than the
`sha2` 0.11 that `spawnloft-lib` uses, so this adds the `hmac` release that pairs with it as a new
lock entry. No hand-written HMAC or constant-time compare.

Proposed threads, in order, all into `v2`:

1. **Mechanism** (Opus builds, Fable reviews before merge; it is security work): the shared
   fixture first, then `panel_auth` in Rust and Node, the rule in both listeners, the proxy's
   upstream token, the 401 page, test helpers. The window still works at the end of this PR
   because it includes the minimal shell change (3.6 first two bullets).
2. **Handoffs and words** (Opus, Sonnet for the texts): the open-file flow, `--link`,
   the page's "session ended" notice, removing the Electron job (decision 5), README security section,
   CLIENT.md, release-notes draft, beta checklist line 16.
3. **Hardware checks** (Victor, with a thread driving): the cookie-sharing proof on Windows and
   the Mac mini, a second account on Desktop-Main or the Linux VM trying `curl` against both
   ports, the SSH-tunnel flow on the Linux VM, and whether each webview sends `Sec-Fetch-Site`.

Acceptance, all scripted except thread 3: a request with no credential gets 401 on both
listeners, on every route of the contract fixture except the two open ones; a login link works
once, not on another port and not after the panel restarted; an expired or altered token fails; the
open-file flow logs a real browser in (scripted, since it is the one place a cross-site navigation
is expected); no GET route writes; the Node port refuses a direct
caller while the window keeps working; `smoke-tauri.cjs` passes with the console and launcher
windows open; the diagnostics bundle does not contain the key.

## 5. Decisions (Victor, 2026-11-13)

1. **When: now**, before the public beta.
2. **No "remember this browser".** The browser path exists only for `spawnloft ui` without the
   desktop app (a headless Linux box, usually through an SSH tunnel); people using the app never
   see it. A tab works until the panel stops, and `spawnloft ui` gives a new link.
3. **Scripts against the API**: the README says in a few lines how to sign a token from the key
   file. No helper command.
4. **1.x: no backport.** 2.0 is the fix; the release notes say so.
5. **The Electron job on `v2`** (`rust-internal.yml` package job and `smoke-desktop.cjs`): 2.0
   does not ship Electron and the workflow itself calls the line retired. Recommended and
   assumed unless Victor says otherwise: thread 2 removes the job after confirming no check in it
   is the only cover for something 2.0 ships, and `desktop/main.js` is left alone.

## 6. Checked while reading, not part of this work

- The game harness port already has a per-launch token (`src/client-harness.mjs`), and the
  databases, RCON and the daemon control channel are per-user or password-protected. No other
  unauthenticated local listener was found; a dedicated sweep was not done.
- The Microsoft sign-in comes back to `http://localhost:<port>/...`, and the panel listens on
  127.0.0.1 only. Another account can listen on `[::1]:<port>` and may receive the `code` and
  `state` when the browser tries IPv6 first. This exists in 1.x, is inside the threat model of
  section 2, and is not fixed by this design. Follow-up: also listen on `::1`, or refuse to start
  a sign-in when `[::1]:<port>` is taken. Worth its own small task.
- `README.md:425-432` describes the current rule ("an unauthenticated local HTTP server");
  it is rewritten in thread 2.
