# Phase 1 brief: split the panel pages into files

For the build thread. Read [PLAN.md](PLAN.md) first; this is phase 1 of it. Victor approved the plan
and "start building" on 2026-11-23. The pre-beta fixes (#271, #272) are merged, so `src/ui.html` is
quiet. Start from `v2` at `ab9796b` or later.

## Goal

`src/ui.html` (17,012 lines), `src/launcher.html` (3,787) and `src/setup.html` (718) each hold their
CSS, markup and script in one file. Cut them into separate stylesheet and script files that the Rust
panel serves, with the design tokens in one shared file instead of three copies.

**Nothing a person sees or does may change.** This is a move, not a rewrite. No renaming, no
reformatting, no "while I am here" fixes: they make the proof below impossible.

## Shape

```
src/panel/
  ui.html  launcher.html  setup.html     markup, plus <link> and <script src> tags
  css/tokens.css                         the one copy of the tokens and the two themes
  css/ui/NN-<section>.css                one file per "/* ---- section ---- */" heading, in order
  css/launcher.css  css/setup.css
  js/shared/session.js                   the "session ended" block both pages hold word for word
  js/ui/NN-<section>.js                  one file per "// ---- section ----" heading, in order
  js/launcher/…  js/setup.js
```

The section headings already in the files are the cut lines (about 30 in the stylesheet, about 45 in
the script). Number the files so the order is the order they load.

## Decisions already made

- **Plain `<script src>` files in the same order, not ES modules.** The 345 functions and the
  top-level `const`/`let` in `ui.html` share one scope. Ordinary scripts loaded in order keep exactly
  that; modules would mean wiring imports and exports through 13,500 lines, which is a rewrite. Each
  file starts with `'use strict';`. Modules can come later, page by page.
- **No bundler, no build tool.** The files are compiled into the binary the way the three pages are
  now (`rust/crates/spawnloft-lib/src/panel/pages.rs`, `include_str!`). A generated table in
  `build.rs`, or a hand-written list with a test that fails when a file in `src/panel/` is missing
  from it, are both fine. Pure Rust either way.
- **One new route family**, for example `/assets/<path>`, in `panel/routes.rs`:
  - only exact names from the compiled-in table are answered, never a path on disk in a release build;
  - it goes through the same `panel_auth` verdict as `/`, before any route, with no exception for
    assets;
  - correct `Content-Type`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (the desktop
    app gets a new port every start, so caching buys nothing);
  - the debug and `test-hooks` behaviour of `SPAWNLOFT_CORE_DIR` (read from the checkout) keeps
    working for the new files, with the same "exact names only" rule.
- **The marks the core fills in stay in the HTML files**: `data-theme="classic"`, the two
  `spawnloft-*` meta tags, and the `get('theme')` expression in setup (which moves to `setup.js`; the
  test in `pages.rs` must still find and replace it).
- **Tighten the script policy if it falls out.** Neither `ui.html` nor `launcher.html` has an inline
  event handler (`onclick=` and so on: 0 found). Once no inline `<script>` is left, `script-src` can
  drop `'unsafe-inline'`. Do it only if every page still works; otherwise leave it and say so.
  `style-src` keeps `'unsafe-inline'` (60 inline `style=` attributes and 79 script style writes).
- **Tests keep lifting functions by name**, now from the script files instead of from the HTML
  (`test/panel.test.mjs`, `test/launcher-page.test.mjs`, `test/panel-session.test.mjs`). Change the
  loader, not the tests. Windows checks files out with CRLF: nothing may depend on line endings.
- The pages the Rust core writes itself (sign-in, session ended, could not start) are not touched.

## Proof it is only a move

1. **Byte check.** A throwaway script joins the new CSS files in load order and compares the result
   with the old `<style>` block, and the same for the scripts (ignoring the added `'use strict';`
   lines) and for the tokens against each page's old copy. Where the three token copies differ today,
   stop and list the differences in the pull request instead of picking one silently. Put the
   script's output in the pull request; do not commit the script.
2. **Pictures.** Before and after, the 21-screen set from
   the `current/` folder of the plan in the project files (how to run the Rust panel on a test world is
   in project memory `ux-ui-overhaul-plan.md`), compared pixel for pixel. Save both sets under
   `/mnt/project-files/ux-ui-plan-2026-11-23/phase1/`.
3. **Tests.** `npm test`, `cargo test` in `rust/`, and the smoke scripts that read the page
   (`desktop/smoke-panel.cjs`, `desktop/smoke-tauri.cjs`).
4. **The real window.** The Tauri window driven under xvfb (recipe in memory `ux-scan-2026-11.md`),
   including the Play page in its frame and the first-run page.
5. **Load time.** First paint of `/` before and after on the test world; about forty small requests
   to localhost should not be visible, but measure it.

## Review

Fable, read-only, before merge, on the Rust side only: the new routes, the auth order, path handling,
the policy headers. The move itself is covered by the byte check.

## Rules

- Branch `v2-ui-split` off `v2`, one pull request into `v2`. Never force-push.
- `git config user.name joogiebear` and the noreply email before any commit. No attribution of any
  kind in commits, the pull request title or body, or comments. Remove the footer GitHub adds to the
  body right after creating it (`update_pull_request` with the full body).
- Conventional commit prefixes (`refactor:`).
- While this is open nobody else should edit `src/ui.html`, `src/launcher.html` or `src/setup.html`;
  tell the coordinator when it is opened and when it is merged.
- Out of scope: Tailwind (phase 2), any visual change, renaming classes or ids, ES modules.
