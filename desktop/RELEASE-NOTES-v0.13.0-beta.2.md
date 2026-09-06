A database from the server, in one step

The second pre-release of the database work. Installs on beta.1 are offered this; installs on
0.12.1 are not.

## Databases

- **Create a database from the server.** A server's Settings tab, Databases card, now has a
  *Create a database* button: MariaDB's newest stable release is set up as that server's own
  database, on the port after its game port - survival on 25565, its database on 25566 - or the
  next free port above it if that one is taken. It is started and attached in the same step and
  the credentials are shown when it is done. No version to pick, no second trip to the sidebar.
  From a terminal: `mcctl db create <server>`.
- **The MariaDB version list was empty.** beta.1's *Add a server → A database* said "No stable
  release listed" for everyone, and a chosen version would not have downloaded either. MariaDB's
  download API answers a different shape at each of its three levels and the code read one shape
  at the wrong level. It now walks the stable series and lists every point release, newest first,
  with LTS marked; the download picks the Windows zip and not the debug-symbols zip beside it.

The Add sheet stays for the cases with choices in them: a version, Redis, a database several
servers share, or one you already run.
