Databases for your servers

Plugins that want MySQL - LuckPerms, CoreProtect, Plan, AuthMe, Jobs, mcMMO - can have a database
of the server's own, made from the server's page in one click, with nothing to install. Redis too,
by way of Garnet. Everything here ran as two betas against real MariaDB on Windows first.

## Databases

- **Create a database from the server.** A server's Settings tab has a Databases card with a
  *Create a database* button: MariaDB's newest stable release is set up as that server's own
  database on the port after its game port - survival on 25565, its database on 25566 - or the
  next free port above it. Started and attached in the same step, credentials shown when it is
  done. From a terminal: `mcctl db create <server>`.
- **Or add one with choices in it.** *Add a server → A database* picks the engine and the version
  and makes a database several servers can share, under the same supervision a server gets: a card
  with a lamp, a console, start, stop and restart, crash recovery. MariaDB comes from its own mirror
  as the portable zip, hash-checked, and every database on that version shares one copy.
- **Attach and detach.** Attaching creates a database and a user named after the server, granted
  that one database and nothing else. Detach takes the user away and keeps the data unless you say
  otherwise. Credentials are one click away, with a Copy button, and never sent in a list.
- **Apply to a plugin.** LuckPerms, CoreProtect, Plan and AuthMe can take the credentials straight
  into their own config, in place, with the comments kept. Only on a click, and only once the
  plugin has started and written its config. The server restarts for the plugin to read it, and the
  card says which plugins point at which database.
- **Redis, by way of Garnet.** Redis ships no Windows build; Microsoft's Garnet speaks its protocol
  and does. A version, a password, loopback only. Redis has no per-server database or user, so an
  attachment is the shared password, a URL and a suggested key prefix. LuckPerms's messaging over
  Redis is the first helper for it.
- **One you already run.** *Connect to one I already run* registers a MariaDB or Redis by its
  address and admin credentials - XAMPP, an install, a Redis on the LAN. It is asked to answer
  before it is saved, so a wrong address or password is refused now with the engine's own reason.
  It attaches, hands out credentials and takes helpers like one run here, and is never started or
  stopped from here; the panel shows it reachable or not.
- **Snapshots carry the database.** A snapshot of an attached server includes a dump of each
  attached MariaDB database; verify checks for it, and restore imports it back into the database it
  came from, which has to be running. A database that is stopped at snapshot time is a warning in
  the manifest, not a failed backup.
- **Loopback only.** Every database listens on 127.0.0.1 and nowhere else. Exposing one is a
  decision a person makes.
- From a terminal: `mcctl db versions | list | add | create | connect | attach | detach | creds |
  root | plugins | apply | remove`; `start`, `stop`, `restart`, `logs` and `status` take a
  database's name as they take a server's.

## Uninstalling

- **The uninstaller now stops servers, removes their scheduled tasks, and can delete the data.**
  It used to remove the program folder and nothing else, leaving tasks firing at a program that
  was gone and servers running with nothing to stop them. It asks whether the data should go
  (default no). A server adopted from your own folder is never deleted. From a terminal:
  `mcctl uninstall --yes [--data]`.

## For contributors

- **A test build without the signing profile.** A push that bumps `desktop/package.json` to a
  version with a prerelease part, on `dev` or a working branch, builds an unsigned installer on a
  Windows runner and publishes it as a GitHub pre-release. Releases proper are still built and
  signed on the release machine.
