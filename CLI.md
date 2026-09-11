# SpawnLoft command line

`spawnloft` is the preferred command. `mcctl` runs the same implementation and remains
supported for existing scripts, scheduled tasks, and shortcuts. Settings, data directories,
application identity, and the Windows updater have not been renamed.

## Run the installed command

Desktop packages contain both launchers and use their bundled runtime. No separate Node
installation is needed. On Mac, after dragging SpawnLoft into Applications:

```sh
"/Applications/SpawnLoft.app/Contents/Resources/bin/spawnloft" status royalplugins --json

# Optional: make both commands available in this terminal session.
export PATH="/Applications/SpawnLoft.app/Contents/Resources/bin:$PATH"
spawnloft status royalplugins --json
```

To make that PATH addition permanent, add the export line to your shell configuration.
The app does not edit it automatically. If you move the app, update that PATH entry.
Avoid symlinking the launcher alone: it resolves the runtime relative to its own directory.
An installer/settings option for PATH setup is a separate follow-up.

On Windows, run `resources\bin\spawnloft.cmd` inside the installed SpawnLoft directory,
or add that `resources\bin` directory to your user PATH. `mcctl.cmd` remains available there.
From a source checkout, use `node spawnloft.mjs ...` or the root Windows `.cmd` launchers;
source usage requires Node 20 or later.

## JSON contract, version 1

```sh
spawnloft list --json
spawnloft status royalplugins --json
spawnloft plugins royalplugins --json
spawnloft backups royalplugins --json
spawnloft diagnostics royalplugins --json
spawnloft doctor --json
spawnloft backup royalplugins --scope plugins --json
```

Each command writes one JSON object followed by a newline to stdout. There are no progress
messages, tables, ANSI colors, or stack traces mixed into that output:

```json
{"schemaVersion":1,"command":"status","ok":true,"data":{"name":"royalplugins","status":"stopped"}}
```

The example shows only two data fields. Clients should check `schemaVersion`, accept
additional fields, and use `error.code` plus the process exit code when an operation fails:

```json
{"schemaVersion":1,"command":"status","ok":false,"type":"error","error":{"code":"COMMAND_FAILED","message":"no instance named missing"}}
```

Structured commands and metrics use the following exit codes. Other existing commands
retain their current exit behavior.

| Exit | Meaning |
| --- | --- |
| 0 | Command completed. A stopped server or an empty inventory is valid data. |
| 1 | Operation failed, or `doctor` found environment problems (`CHECK_FAILED`). |
| 2 | Invalid usage or an unsupported JSON operation (`INVALID_USAGE`). No command action ran. |
| 130 / 143 | A metrics follower was interrupted with Ctrl+C / SIGTERM. |

`status` without a name returns the same instance/database inventory as `list`. `ls`,
`snapshots`, `why`, and `snapshot` remain aliases for `list`, `backups`, `diagnostics`,
and backup creation respectively. The JSON `command` field uses the canonical name.

Status records exclude configured RCON/database passwords, webhook URLs, and JVM arguments.
Diagnostics contain matching console lines and crash-report summaries; review those before
sharing them. A historical diagnostic finding is not a failed command or a plugin-health
verdict. `doctor --json` is read-only and returns `ok:false` plus its findings when checks
fail. The existing plain-text `doctor` retains its stale-state repair behavior.

Plugin JSON is inventory only: `plugins ... enable/disable --json` is rejected before
changing a JAR. Other commands without JSON support reject the option before taking action.
Backup creation reports warnings, skipped database dumps, mirror errors, and pruning results;
exit 0 means the archive was created, not that all optional operations succeeded. Read these
fields before considering an automated backup fully successful.

## Performance readings and export

```sh
spawnloft metrics royalplugins --json
spawnloft metrics royalplugins --seconds 1800 --json
spawnloft metrics royalplugins --follow --json
spawnloft metrics royalplugins --csv --output royalplugins-run.csv
spawnloft metrics royalplugins --follow --csv
```

The default snapshot includes all retained history for the current/last server run.
`--seconds` selects a recent window. These are the same ten-second measurements used by
the Performance tab, not a second collector. CPU is a percentage of the whole machine;
`rssMiB` is resident process memory in MiB, including memory outside the Java heap.
An empty `samples` array is valid before the first measurement or outside the selected range.
Actual collection is available on Windows and Mac; export can still read saved history elsewhere.

`--follow --json` writes **JSON Lines**: first a `snapshot` envelope containing history and
metadata, then a `sample` envelope for each new reading. A server restart or clock rollback
emits `reset`; use `runId` to keep test runs separate. The follower stays open while a server
is stopped and follows its next start. It checks the recorded file once per second and does
not repeat unchanged samples. Use Ctrl+C to stop. Runtime failures produce an error envelope
and exit 1. Closing the output pipe ends the follower cleanly.

CSV uses `instance,run_id,timestamp,cpu_percent,rss_mib,cores` with UTC ISO timestamps.
`--output` creates a new file exclusively; an existing file is never overwritten. Without
`--output`, CSV goes to stdout for piping. `--output` is for finite CSV snapshots; redirect
stdout yourself when capturing an ongoing stream. JSON and CSV are mutually exclusive.

Safe local JAR deployment, required-plugin readiness checks, and automatic PATH installation
are separate planned additions. Mac Scheduler and automatic backups remain separate work too.

## Managed databases on Mac

On macOS 15 or later, `spawnloft db create royalplugins` downloads the verified MySQL 8.4 LTS
engine for your Mac, creates and starts a database, and prints the server's credentials.
Use `spawnloft db add testdb` for a standalone database, then `spawnloft start testdb` and
`spawnloft db attach testdb royalplugins`. Both `spawnloft` and `mcctl` work.

`spawnloft db creds testdb royalplugins` shows connection details again. Plugin configuration
is always manual. Existing databases are never silently upgraded to another engine/version.
The Mac app remains ad-hoc signed; notarization is a separate release milestone.
