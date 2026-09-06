# Plan: databases for servers

Status: **shipped in 0.13.0.** The first Windows run (0.13.0-beta.1) found the MariaDB version list empty. The
download API is three shapes deep - `major_releases` at the root, `releases` under a major,
`release_data` under a point release - and the code read one shape at the wrong level; fixed in
beta.2, with the shapes pinned in `test/mariadb.test.mjs` from a probe of the live API; beta.2 ran
a real MariaDB on Windows, created from the server on the game port plus one, and it answered. The
engine module, the daemon generalisation, attach/detach, the CLI group and the panel are in,
covered by a lifecycle test against a fake MariaDB (`test/fixtures/fake-mariadb`). What that
fake cannot prove, and the first Windows run has to: the download API's file list, the init
tool's flags, `--console` logging, `mariadb-admin shutdown`, and `mariadb-dump` against the
real binaries; and for Garnet, the release asset's name, the flags, the ready line and
SHUTDOWN over the protocol.

## The goal

`Add a server → A database`: pick MariaDB, pick a version, and get a database server
running on this machine under the same supervision a Minecraft server gets - a card
with a lamp, a console, start/stop/restart, crash recovery - with nothing to install.
Then `Attach` it to a server: a database and a user are created for that server, and
its connection details are one click away for whichever plugin wants them.

## Who this is for

Plugin testing, mostly. LuckPerms, CoreProtect, Plan, AuthMe, Jobs and mcMMO all have a
MySQL mode that authors want bugs reproduced against, and a Velocity network needs a
shared store. Redis is the narrower case, cross-server messaging, so it comes last.

## Why it fits

The daemon already does the hard part - detached launch, stdout captured to a console
log, a control pipe, restart on crash, ready detection - and the only Java-specific
step in its launch is one routing function. A database is another process with a
ready line and a way to be told to stop. So a database is another entry in the
registry, run by the same daemon, shown by the same panel.

Nothing to install, the way nobody installs Paper: MariaDB publishes a portable zip for
Windows with `mariadbd`, `mariadb-install-db`, `mariadb-admin`, the `mariadb` client and
`mariadb-dump` inside, and a REST API that lists releases with checksums. That is the
Paper download pattern exactly, and Windows's own `tar` unpacks zips.

## Phase 1 - MariaDB as a service (this phase)

- **Registry.** A database is an instance with `kind: "database"`, `engine: "mariadb"`,
  `version`, `dir` (under `<data>/services/<name>`), `port`, a generated root password,
  and `attachments`: one entry per server, holding that server's database name, user and
  password. Servers have no `kind`; every existing instance is a server, the whole
  migration. `listInstances()` keeps answering servers only, so nothing that iterates
  servers - launchers, backups, the panel's list - sees a database by accident;
  `listServices()` answers databases; ports are checked across both.
- **Engine store.** `<data>/engines/mariadb-<version>/`, downloaded once per version
  from the official mirror, hash-checked, unpacked with tar. Shared by every database on
  that version. Deleted with `--data` at uninstall.
- **Init and launch.** `mariadb-install-db` makes the data folder with the root password;
  a `my.ini` written by us pins the port, `bind-address=127.0.0.1`, `skip-name-resolve`
  and utf8mb4; `mariadbd --defaults-file=... --console` runs in the foreground with its
  log on stderr, which the daemon already captures. Ready is `ready for connections`;
  stop is `mariadb-admin shutdown` over TCP with the password in the environment, since
  a database takes no stdin. Kill is what it already is.
- **Daemon.** `launch` asks a `programFor(inst)` for the command, the ready pattern and
  the stop method instead of assuming Java. The lifecycle tests keep their fake JVM; a
  fake MariaDB engine (four scripts in `test/fixtures/fake-mariadb/bin`) drives the same
  daemon through init, ready, attach and shutdown. Crash diagnosis is skipped for a
  database - the patterns are Minecraft's.
- **One step from the server.** `mcctl db create <server>` / *Create a database* on the server's
  Databases card: the newest stable MariaDB, named `<server>-db`, on the game port plus one (or
  the next free port above it), started, attached, credentials shown. One rule a person can
  remember - survival on 25565, its database on 25566 - and no version list to pick from.
- **Attach.** `mcctl db attach <db> <server>` / the panel's Databases card on a server:
  creates ``<server>`` and `'<server>'@'localhost'` + `'<server>'@'127.0.0.1'` with a
  random password, grants that database only, records it on the database instance.
  Detach drops the user and keeps the data unless told to drop it. Credentials are shown
  on request and copied as a block, never sent in the list payload.
- **Loopback only.** Same stance as the panel. Exposing it is a decision a person makes.
- **Panel.** Databases listed under the servers in the sidebar; a database's page has
  Console (no input), Performance and Settings (root and attachments); a server's
  Settings gains a Databases card; the Add sheet gains "A database".
- **CLI.** `mcctl db versions | list | add | attach | detach | creds | remove`; `start`,
  `stop`, `restart`, `logs`, `status` work on a database as on a server.
- **Uninstall.** Databases stop with the servers; `--data` deletes their folders and the
  engine store.

## Phase 2 - backups (built)

A snapshot of a server with attachments runs `mariadb-dump --single-transaction` of each
attached database into a scratch folder and adds it to the archive as a `databases/`
member, so the server's own folder never holds a copy of its database. The manifest
lists each dump by file; verify looks for those files by name, the way it looks for a
world; restore imports each dump into the database it came from and removes the
extracted copy, and a dump it cannot import - the database gone, or stopped - stays on
disk and is named. A database that is not running when the snapshot is taken is a
warning in the manifest, not a failed backup. Only the standard and full scopes carry
dumps: plugins, worlds and config each name one kind of file. The scheduler needed
nothing new.

## Phase 3 - config helpers (built)

"Apply to a plugin": LuckPerms, CoreProtect, Plan and AuthMe, each a row in one table
(`src/dbconfig.mjs`) naming the config file, the keys that carry the connection and the
storage mode the plugin calls it. The keys are set in place by a comment-preserving YAML
line editor (`src/yamlpath.mjs`): it walks the document by indentation, changes only the
value on the line it wants, keeps a trailing comment, and adds a key that is missing under
its parent at the parent's own child indent. Only ever on a click, only when the config
exists - a plugin installed but never started is named with the reason, since a config
written before its first start would be replaced by its defaults - and what was written
is recorded on the attachment so the panel can say which plugins point at which database.
The server has to restart for the plugin to read it, and every surface says so.

## Phase 4 - Redis, and connecting to what you already run (built)

Redis itself ships no Windows binary. Microsoft's Garnet speaks the Redis protocol, is
MIT licensed and publishes a self-contained Windows build on its GitHub releases page,
the feed shape this program already reads for its own updates; it is the second engine.
Loopback, password auth, checkpoints and an append-only log in the data folder; ready on
"ready to accept connections"; stopped with SAVE then SHUTDOWN over the protocol itself,
by a forty-line Redis client of our own, since Garnet ships no admin tool. Redis has no
per-server database or user, so an attachment is the shared password, a URL and a
suggested key prefix, and the credentials say so. LuckPerms's messaging-over-Redis is the
first helper for it. A snapshot skips a Redis database with the reason: it keeps its own
checkpoints.

Each engine module fills one interface - versions, fetch, init, launch to run one here;
probe, newRecord, provision, deprovision, credentialsFor to attach servers to one wherever
it runs; dump and import where a dump is a thing the engine has - and services.mjs knows
nothing engine-specific beyond that table.

"Connect to one I already run": a database registered with its address and admin
credentials, for either engine. It is asked to answer before it is saved, so a wrong
address or password is refused with the engine's own reason. It attaches, hands out
credentials, takes helpers and dumps like one run here, and is never started or stopped
from here; the panel shows it as reachable or unreachable, asked each poll. MariaDB's
client tools for an external one come from a folder the person names, the usual install
places (XAMPP, a MariaDB or MySQL install), or any MariaDB already in the engine store.

## Decisions already taken

- MariaDB first, Garnet later; each phase shippable alone.
- One shared engine, many databases: a server attaches to a database instance, and one
  database instance serves as many servers as you like. Lighter than one engine per
  server, and how people already use MySQL locally.
- Managed engines are Windows-only, like the desktop app. The CLI on other platforms
  can still register and attach to a database someone runs themselves (phase 4).
- Engines are downloaded from their official mirrors at runtime, not bundled, exactly as
  Paper is; nothing is redistributed.
- The database name and user are the server's name. Predictable beats clever, and the
  name is already validated to be safe in an identifier.

## Open questions

- Whether a server's Start should start the database it is attached to first. Probably
  yes, with the order recorded rather than guessed; not in phase 1.
- Whether a stopped database should warn when a running server is attached to it.
- MariaDB's zip is 80-100 MB; whether to offer the smaller "minimal" builds if the
  mirror carries them for the chosen version.
