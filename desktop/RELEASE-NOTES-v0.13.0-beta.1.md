Databases

A beta, for one reason: everything below has been run against stand-ins for MariaDB
and Garnet, never yet the real binaries on Windows. Install it by hand; the app will
follow later betas and then the stable release on its own.

## Databases

- **A database for plugins that want one, with nothing to install.** *Add a server →
  A database* downloads MariaDB from its own mirror, once per version, and runs it on
  this machine under the same supervision a server gets: a card with a lamp, a
  console, start, stop and restart, crash recovery. Reachable only from this machine.
- **Redis too, by way of Garnet.** Redis ships no Windows build; Microsoft's Garnet
  speaks its protocol and does. Same card, same supervision, one password and one key
  space that every attached server shares.
- **Attach a server.** Its Settings tab has a Databases card. Attaching creates a
  database and a user named after the server, granted that database and nothing
  else, and shows the connection details with a Copy button. Detach takes the user
  away and keeps the data unless you say otherwise.
- **Write them into the plugin.** *Apply to a plugin* sets LuckPerms, CoreProtect,
  Plan or AuthMe's own config to the database, in place, comments kept; for Redis,
  LuckPerms messaging. Only when the plugin has written its config, and the server
  restarts for it to take.
- **Connect to one you already run.** XAMPP, a MariaDB or MySQL install, a Redis
  somewhere: registered with its address and admin credentials, asked to answer
  before it is saved, attached to like one run here, never started or stopped from
  here.
- **Backups carry it.** A snapshot of an attached server includes a dump of its
  database; verify looks for it, and restore imports it back, which needs the
  database running. A stopped database is a warning on the snapshot, not a failure.
- From a terminal: `mcctl db` - versions, add, connect, attach, detach, creds,
  plugins, apply, root, remove.

## Uninstalling

- **The uninstaller now stops every server and removes every scheduled task**, and
  asks whether to delete your servers, worlds, backups, jars and settings. No is the
  default, and a server you added from your own folder is never deleted either way.
  An update never does any of this.

## What this beta has to prove

The first run on a real machine settles what the stand-ins could not: the MariaDB
download list, its init tool's flags, `--console` logging, `mariadb-admin shutdown`
and `mariadb-dump`; for Garnet, the release asset's name, its flags, the line it
prints when ready and SHUTDOWN over the protocol. Each of those failing would show in
the database's console or the daemon log, and each is a small fix. Please attach the
console when reporting one.
