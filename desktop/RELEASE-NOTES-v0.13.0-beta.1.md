Databases for your servers

A pre-release for trying databases before they ship. Install it by hand once; later betas arrive
through the app, and so does 0.13.0 when it is released. Installs on 0.12.1 are not offered this.

This is the first build of the database work to run against real MariaDB and Garnet on Windows.
The test suite drives every path through fakes of both engines; what a fake cannot prove - the
download's file list, the init tool's flags, the ready line, the shutdown over TCP - this build is
for finding out. Something that does not work is worth a **Feedback → Something broke**.

## Databases

- **A MySQL database, with nothing to install.** *Add a server → A database* picks MariaDB and a
  version and sets one up on this machine, under the same supervision a server gets: a card with a
  lamp, a console, start, stop and restart, crash recovery. MariaDB comes from its own mirror as
  the portable zip, hash-checked, and every database on that version shares one copy.
- **Attach it to a server.** A database and a user of that server's name are created, granted
  that one database and nothing else, and the credentials are one click away in a Databases card
  on the server's Settings tab. Detach takes the user away and keeps the data unless told to drop it.
- **Apply to a plugin.** LuckPerms, CoreProtect, Plan and AuthMe can take the credentials straight
  into their own config, in place, with the comments kept. Only on a click, and only once the
  plugin has started and written its config. The server restarts for the plugin to read it, and the
  card says which plugins point at which database.
- **Redis, by way of Garnet.** Microsoft's Redis-compatible server is the second engine, the same
  way: a version, a password, loopback only. Redis has no per-server database or user, so an
  attachment is the shared password, a URL and a suggested key prefix. LuckPerms's messaging over
  Redis is the first helper for it.
- **One you already run.** *Connect to one I already run* registers a MariaDB or Redis by its
  address and admin credentials - XAMPP, an install, a Redis on the LAN. It is asked to answer
  before it is saved, so a wrong address or password is refused now with the engine's own reason.
  It attaches, hands out credentials and takes helpers like one run here, and is never started
  or stopped from here; the panel shows it reachable or not.
- **Snapshots carry the database.** A snapshot of an attached server includes a dump of each
  attached MariaDB database; verify checks for it, and restore imports it back into the database
  it came from, which has to be running. A database that is stopped at snapshot time is a warning
  in the manifest, not a failed backup.
- **Loopback only.** Every database listens on 127.0.0.1 and nowhere else. Exposing one is a
  decision a person makes.
- From a terminal: `mcctl db versions | list | add | connect | attach | detach | creds | root |
  plugins | apply | remove`; `start`, `stop`, `restart`, `logs` and `status` take a database's
  name as they take a server's.

## Uninstalling

- **The uninstaller now stops servers, removes their scheduled tasks, and can delete the data.**
  It used to remove the program folder and nothing else, leaving tasks firing at a program that
  was gone and servers running with nothing to stop them. It asks whether the data should go
  (default no). A server adopted from your own folder is never deleted. From a terminal:
  `mcctl uninstall --yes [--data]`.
