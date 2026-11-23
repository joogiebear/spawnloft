# Tailwind spike (2026-11-23)

A test, not part of the product. Nothing here is built, packaged or loaded by SpawnLoft. It answers
one question from the UX/UI plan: can Tailwind 4 sit on top of the panel's existing tokens, themes and
density tiers, and what does its output need from the web view?

## What is here

- `panel.css`: the Tailwind input. Tailwind's own palette, type sizes and radii are switched off and
  replaced by the panel's tokens (`--surface`, `--ink`, `--t-4`, `--r-lg` and so on), so a class can
  only name a value the panel already has. Three shared controls (`btn`, `btn-primary`, `card`) are
  defined once.
- `sample.html` and `sample.js`: a small page built the way `src/ui.html` builds its pages, with
  elements made in script and classes given as strings.
- `out.css`: the built stylesheet, committed, as the plan proposes for the real thing.

Rebuild: `tailwindcss -i panel.css -o out.css` (Tailwind 4.3.5).

## Results

| Question | Result |
|---|---|
| Do the two themes still work as a variable swap? | Yes. One attribute on `<html>` changes card colour, accent and corner radius; no class changes. |
| Do the density tiers still work? | Yes, as container queries on the pane: one column under 1280, two from 1280, three from 2000. |
| Does Tailwind find classes that only appear in script strings? | Yes. |
| Is the build repeatable? | Yes, two builds gave the same bytes. It takes about 40 ms. |
| How big is the output? | 6.9 KB for this page, because only the classes used are written. |
| Chromium (WebView2 uses the same engine) | Pass, both themes, at 1000, 1700 and 2560 wide. |
| WebKitGTK 2.52.6 (Ubuntu 24.04) | Pass, same values as Chromium. |

## What the output needs from the web view

- Cascade layers (`@layer`): Chrome 99, Safari 15.4.
- Container queries: Chrome 105, Safari 16.0. The panel already needs these today (28 of them in
  `src/ui.html`), and `:has()` as well.
- `color-mix()` for see-through colours such as `bg-live/15`: Chrome 111, Safari 16.2. Tailwind
  writes a plain fallback first, so an older engine gets the solid colour.
- `@property`: Safari 16.4. Tailwind writes a fallback for engines without it.

So Tailwind does not ask for more than the panel already asks for. The line is container queries,
which are in the panel now.

## Found on the way: macOS 11 and 12

`installer/mac-config.mjs` sets the minimum macOS to 11.0. A Tauri window on macOS uses the system web
view, and the system web view on macOS 11 and 12 is older than Safari 16, so it has no container
queries. On those versions today's panel would already lose its density tiers (and on macOS 11,
`:has()` too). This has nothing to do with Tailwind. Either the minimum should be macOS 13, or the
panel needs checking on a macOS 12 machine. Not verified on hardware: it is read from the engine
versions, not seen.

## Not done here

- **The standalone program.** This container cannot download from GitHub releases, so the build used
  the same Tailwind version from npm. The output is the same; pinning the standalone program and its
  checksum has to happen in CI or on a developer machine.
- **Real WebView2 on Windows and the real web view on macOS.** Chromium and WebKitGTK stand in for
  them here. A CI job on the Windows and macOS runners should load `sample.html` before the real
  wiring is merged.
- **Ubuntu 22.04 and Rocky 9.** Their WebKitGTK is expected to be a current 2.4x or 2.5x through
  updates, but it was not run.
