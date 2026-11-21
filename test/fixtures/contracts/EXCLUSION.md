# Locks and other exclusive-create files

Every file SpawnLoft creates to keep two processes (CLI, panel, MCP server, scheduled tasks, the
daemon) out of each other's way, as the Node source has them at `61e38a6`. A Rust writer has to
take the same file with the same record, or it and a Node writer will not exclude each other.
Plan: `rust/PLAN-CORE-PORT.md` section 3.4, first two rows.

`locks.json` beside this file is the machine-readable form: the record, the rules, and every
site by its source line. `test/contracts-locks.test.mjs` scans `src/*.mjs` and `mcctl.mjs` for
`acquireLock(`, `acquireLockAsync(`, `withLock(`, `lockHolder(`, `'wx'`, `COPYFILE_EXCL`,
`O_EXCL`, `'EEXIST'` and `pid: process.pid`, and fails on a line `locks.json` does not list (or
lists but the source no longer has). A new site needs an entry there, a row here, and its Rust
twin. Line numbers below are for orientation and drift; the test matches lines by their text.

## The lock (`util.mjs:210-360`)

Ported in `rust/crates/spawnloft-lib/src/lock.rs`; cross-checked by
`test/lock-cross-process.test.mjs` (Node and Rust in both directions).

- **Create:** `fs.writeFileSync(lock, body, { flag: 'wx' })`, after
  `mkdirSync(dirname, { recursive: true })`.
- **Record:** `JSON.stringify({ pid, token })`, so `{"pid":4242,"token":"<uuid>"}` with no
  whitespace and no newline. The token is `crypto.randomUUID()` (lowercase RFC 4122 v4), new on
  every try.
- **Reading:** utf8, `String.prototype.trim` (strips a BOM). Text matching `^\d+$` is the 1.x
  bare pid, with no token. Otherwise JSON whose `pid` is an integer above 0; anything else, and an
  empty file, is "unwritten".
- **Alive:** the pid only, never the program (`process.kill(pid, 0)`, EPERM counts as alive). The
  reader's own pid is always alive, so a second taker in the same process is refused (the panel's
  two Play clicks).
- **Stale:** a record whose pid is dead is taken over at once. An unwritten lock is held for
  2000 ms from its mtime (its owner may be between create and write), then taken over.
- **Taking over:** exclusive itself. The taker creates `<lock>.break` (`'wx'`, its pid as decimal
  text), removes the lock only if it still reads byte for byte as when judged dead, then removes
  the breaker. A breaker present means someone else is clearing: this try reports held. A breaker
  older than 10000 ms is removed by whoever meets it, and that try still reports held. Only the
  first five tries of one `tryLock` may break.
- **Busy:** EPERM, EACCES, EBUSY on create (Windows: a just-deleted file that is not gone yet)
  pause 5 ms and retry, at most 60 tries, then "held by null". An unreadable lock after EEXIST
  pauses 2 ms and retries.
- **Release:** token-checked. The file is removed (`rmSync` force, 10 retries, 10 ms steps) only
  while it parses to a record with the holder's token; a legacy record never matches.
- **Wait:** `acquireLock` mode `wait` (default, 10000 ms) polls every 20 ms by blocking the thread;
  `acquireLockAsync` polls on a timer so a holder in the same process can finish. Timeout:
  `timed out waiting for lock <file> (held by pid <pid|null>)`. Mode `fail` returns null.
  `withLock` in fail mode: `could not get a lock on <file>`.
- **`lockHolder`:** null when absent or stale, -1 when unwritten and younger than 2000 ms, else
  the live pid. Read-only.

### Lock sites

| Where | Lock file | How | Protects |
| --- | --- | --- | --- |
| `registry.mjs:70,78,98` (`putInstance`, `updateInstance`, `removeInstance`) | `instances.json.lock` beside the registry | `withLock`, wait, 10 s | read-modify-write of `instances.json` (the daemon reads it unlocked) |
| `data-move.mjs:133` | `instances.json.lock` | `lockHolder` (truthy, so -1 counts) | data move refuses while the registry is being changed |
| `players.mjs:58` (`updateList`) | `<server dir>/ops.json.lock`, `banned-players.json.lock`, `whitelist.json.lock` | `withLock`, wait, 10 s | read-modify-write of the player lists of a stopped server |
| `schedule.mjs:35` (`withTasksLock`) | `<dataRoot>/schedules.lock` | `acquireLock`, wait, 10 s; re-entrant by a depth counter | read-modify-write of `schedules.json`; a timeout becomes "another change to the scheduled tasks is still in progress" |
| `supervisor.mjs:112` (`start`) | `<run>/<name>/start.lock` | `acquireLock`, fail | two starts both reading "not running"; held until the daemon publishes `state.json` |
| `data-move.mjs:135` | `<run>/<name>/start.lock` | `lockHolder` | data move refuses while a server is being started |
| `backup.mjs:259` (`createSnapshot`) | `<backups>/<name>/.snapshot.lock` | `acquireLockAsync`, 30 min | one snapshot per server at a time (save-off/save-on pairing); the second queues |
| `data-move.mjs:136` | `<backups>/<name>/.snapshot.lock` | `lockHolder` | data move refuses while a backup runs |
| `client.mjs:538` (`launch`) | `<dataRoot>/client/run/<profile>/launch.lock` | `acquireLock`, fail | two launches of one profile; held until `state.json` names the game |
| `client.mjs:249` (`removeProfile`) | `launch.lock` | `acquireLock`, fail | a launch recreating the run folder after a purge |
| `client.mjs:281` (`renameProfile`) | `launch.lock` | `acquireLock`, fail | a rename during a launch |
| `client.mjs:223` (`updateProfile`) | `launch.lock` | `lockHolder !== null` | changing launch-relevant keys during a launch |
| `client.mjs:388` (`holderText`) | `launch.lock` | `lockHolder` | the pid in "is being launched (pid N)"; null and -1 print `?` |
| `client-java.mjs:117` (`updateRuntimeIndex`) | `<dataRoot>/client/runtime/index.lock` | `acquireLock`, wait, 10 s | read-modify-write of `client/runtime/index.json` |
| `client-java.mjs:167` (`ensureRuntime`) | `<dataRoot>/client/runtime/<component>/<platform>.lock` | `acquireLockAsync`, 15 min | laying out one Mojang Java runtime |
| `client-install.mjs:482` | `<dataRoot>/client/natives/<version>.lock` | `acquireLockAsync`, 60 s | extracting one version's natives |
| `client-forge-install.mjs:402` (`lockFor`) | `<dataRoot>/client/cache/loader-steps/<mc>.lock` | `acquireLockAsync` in 500 ms turns, up to 30 min | Forge/NeoForge builds for one Minecraft version; the short turns let a cancel end the wait |
| `util.mjs:352` (`withLock`), `:316-317,321` (`tryLock`), `:290-293` (`breakStaleLock`) | any | the implementation | |

`mcctl.mjs` takes no lock itself.

## Other exclusive-create files and pid markers

None of these use `acquireLock`, so a search for it misses them.

| Where | File | Record | Stale rule | Read by |
| --- | --- | --- | --- | --- |
| `garnet.mjs:140-144`, released `:180` | `<engines>/garnet-<version>.install-lock` | empty, `'wx'` mode 0600, held open for the install, unlinked in `finally` | none: a crash leaves it, and the message tells the user to remove it | nobody; its existence refuses a second install ("Redis installation is already in progress") |
| `mysql.mjs:81-85`, released `:121` | `<engines>/mysql-<version>-<platform>-<arch>.install-lock` | as above | none | nobody ("MySQL installation is already in progress") |
| `backup.mjs:131-150` (`reserveSnapshot`) | `<backups>/<name>/<label>_<stamp>[_N].tar.gz.pending` | `openSync('wx')`, empty; then tar's output; renamed to `.tar.gz` when verified, removed on failure | EEXIST, or an existing `.tar.gz`/`.json`, moves on to the next `_N` | the reservation loop; `uninstall.mjs:94` removes stamped leftovers |
| `services.mjs:451-466` (`backupDatabase`) | `<backups>/<database>/<label>_<stamp>[_N].sql.pending`, parts `.pending.<i>` | `createWriteStream({ flags: 'wx' })`, the joined dump; renamed to `.sql`, all removed in `finally` | the name is chosen by `existsSync` on `.sql` first; an existing `.pending` fails the dump | its writer; uninstall removes leftovers |
| `services.mjs:114-117` | `<services>/<database>/` | `mkdirSync` without `recursive`, mode 0700: a directory claim | none ("A database folder already exists") | `createDatabase` |
| `control.mjs:92-125` (`beginRestore`) | `<run>/<name>/restoring.json` (servers and databases) | `JSON.stringify({ pid, at })`: `{"pid":N,"at":"<ISO>"}`, no whitespace, no newline. A plain write, **not** exclusive: `beginRestore` checks `isRestoring` first, so two restores in the same instant can both pass | ignored unless `pid` is an integer and `pidAlive(pid)`; readers never remove it; the restorer unlinks it when done | `isRestoring`, `restoreBlock`, `activeBlock` (start, delete, rename, restore, database backup and delete), the panel |
| `client-launch.mjs:230,352` (`stopMark`) | `<dataRoot>/client/run/<profile>/stop-asked.json` | `writeJson` (pretty, newline, via `.tmp` and rename), `{ pid: <the game's pid>, at }` | matches only the game whose pid it names; removed before a new game starts (`:177`), when the game exits (`:193`), and by a stop that failed (`:368`) | the launching process's exit handler (`lastExit.stopped`) |
| `panel-auth.mjs:88-125` (`createKey`) | `<config>/spawnloft/panel.key`, via `panel.key.<pid>.<hex>.tmp` | base64url of 32 random bytes and a newline, made private (`'wx'` 0600 plus ACL) before the key goes in, published by `linkSync`, or `'wx'` where links fail; EEXIST means another process won | none: everyone reads the winner (a reader waits up to 2 s for an empty file) | `loadKey`, `rust panel_auth` |
| `panel-open.mjs:93-108` (`writeOpenFile`) | `<config>/spawnloft/open/<sha256 of open.v1.nonce, 32 hex>.html` | `'wx'` 0600, private before the one-time login link is written | swept by mtime after the login lifetime | the browser |
| `mysql.mjs:182-186` | `<services>/<database>/bootstrap.sql` | `'wx'` 0600, the root password SQL; removed after init (`:215`) | none | `mysqld --init-file` |
| `garnet.mjs:165,296`, `mysql.mjs:106` | downloads inside a fresh `mkdtemp` folder | `createWriteStream({ flags: 'wx' })` | the folder is removed in `finally` | their writer |
| `cli-metrics.mjs:66` | the user's `--output` file | `'wx'`: never overwrite | n/a | the user |
| `settings.mjs:120` | `settings.json.unreadable-<stamp>` | `COPYFILE_EXCL` copy of a damaged settings file | n/a | the user |
| `tree.mjs:54` | any tree-copy destination | `COPYFILE_EXCL`: never overwrite somebody's data | n/a | n/a |
| `files.mjs:370` | | only an error message naming EEXIST | | |

Not exclusion, and so not listed: temp files named with the pid and random bytes
(`writeAtomic`, `writeJson`'s fixed `<file>.tmp`, downloads' `.part`), `session.lock` (Minecraft's
own, only excluded from archives), and the daemon's `state.json` (`daemonPid`), whose contract is
`state.json` in this folder.

## What Rust matches, and where it cannot exactly

- The record, the breaker text, the constants and the messages are byte for byte; the Rust tests
  read `locks.json` too.
- A legacy pid longer than a `u64` reads as `u64::MAX` (Node: a float such as `1e+25`). Both treat
  it as dead; only the number in a timeout message for such a file could differ.
- A JSON record with a lone surrogate in a string (`"\ud800"`) parses in Node and not in
  `serde_json`, so Rust reads it as unwritten. Nothing writes one.
- `fs.rmSync` retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM, and which of those a Windows
  access-denied or sharing violation becomes has varied between Node versions. Rust retries all
  of them (Windows: errors 4, 5, 32, 33). Only the timing of a contested delete can differ.
- On Windows libuv deletes with POSIX semantics where it can (the name is free at once), while
  `std::fs::remove_file` may leave a delete pending until the last handle closes. A taker that
  meets the pending file gets access denied, which both sides treat as busy and retry.
- Rust has no event loop: `acquire` in wait mode is both `acquireLock` and `acquireLockAsync`;
  another thread of the same process is refused (own pid is alive) and waits, as a second async
  caller in Node does.
