# UX scan: build phases

The 35 rows of "What to build first" in [the summary](../ux-scan-2026-11.md), plus the "Fix once,
everywhere" patterns, cut into phases. Each phase is one pull request into `v2`, with tests, and gets a
separate review before it merges. Ids are the ones in the six parts.

Order: things that can lose work first, then pages that say something untrue, then confirmations, then
errors and progress, then the shell and first-run screens, then wording, then the patterns, then the
missing features. A phase marked "needs a decision" will come with a question before it is built.

| Phase | What | Findings | Mostly in |
|---|---|---|---|
| 1 | Safety quick fixes | LV1, BK7, LV5, DB1, DB3, BK2, FI1, FI2, DB8, B8, LA5 | `src/manage.mjs`, `src/ui.html`, `src/ui.mjs`, `src/services.mjs`, `src/launcher.html` |
| 2 | Backups that tell the truth | BK1, WO1, WO3, BK17, LV2, BK6, BK12, BK13 | `src/backup.mjs`, `src/ui.mjs`, `src/ui.html` (Backups, Worlds) |
| 3 | Pages that follow the server | X1, PLY3, SCH3, SET1, SET5, SET4, F1, PLY4, PL10, LV3, PR2, SCH1 | `src/ui.html` (tools, Settings), `src/diagnose.mjs` |
| 4 | Confirm before it hurts | A3, SCH17, DB4, PLY5 | `src/ui.html` (header, Schedule, Databases, Players) |
| 5 | Plain errors and lasting progress | A1, HD2, LA3, LA4, DB9, A2, FI15, AD1, LA1, LA2, X4, F3, LV6 | `src/ui.html` (`api()`, toasts, dialogs), `src/launcher.html`, `src/ui.mjs` |
| 6 | Shell, sign-in and first run | SH1, SH2, SI1, LV25, WZ1, WZ2, PG1, PG2, LA7 | `rust/crates/spawnloft-shell`, `src/setup.html`, `src/ui.mjs` (sign-in page), `src/ui.html` |
| 7 | One word for each thing | B1, BK24, ACT1 to ACT4, LV15, LV18, C1 to C4, STA6, SET13, DB17, LV21 | `src/ui.html`, `src/activity.mjs`, messages in the core modules |
| 8 | Fix once, everywhere | focus after actions (X2, ACT9, PLY12, STA5), Escape in text boxes (X3, PG9, PG10), tooltip-only help (PG12, FI19, PLY16, B6), unnamed controls (BK14, BK21, WO8, SCH13, PLY17, STA4), one time format (A10, BK16, SCH19, OV5) | `src/ui.html` |
| 9 | Whitelist and adding players by name | PLY1, PLY2 | `src/ui.html`, `src/ui.mjs`, players module. Needs a decision. |
| 10 | "How friends join" | HD3 | `src/ui.html`, `src/ui.mjs`. Needs a decision. |
| 11 | Plugins: dependencies and version check | PL1, PL2, PL3 | plugins modules, `src/ui.html` |
| 12 | Backup history clean-up | BK4, BK5 | `src/backup.mjs`, `src/ui.html`. Needs a decision. |
| 13 | Files: row actions, large logs, find and wrap | FI4, FI7, FI8 | `src/ui.html`, `src/ui.mjs` |
| 14 | More game settings, explained | SET6, SET7 | `src/ui.html` (Settings) |

## Phase 1 in detail

- **LV1**: `reveal()` gets an `error` listener, so a missing file manager is a message, not a dead panel.
- **BK7**: Restore opens with the undoable choice selected and listed first.
- **LV5**: deleting from the top of a server's folder names what goes, and deleting everything needs the
  typed confirm.
- **DB1**: an external database is "forgotten", with no "delete the data" choice and a true message.
- **DB3**: copying a secret never puts it in a label, tooltip or toast.
- **BK2**: a backup that missed the database or was taken while the server wrote says so.
- **FI1**, **FI2**: an upload stays in the folder it started in; a file dropped outside a drop zone is
  ignored, not opened.
- **DB8**, **B8**: while a restore runs, its list is locked and the row shows progress.
- **LA5**: "Remove setup" puts focus on Cancel.

## What is left out

Rows that only make sense on the real desktop window (parts of SH1, SH2, PG1) are built in phase 6 but
can only be checked on Victor's Windows and Mac machines; those PRs will say what was not run.
