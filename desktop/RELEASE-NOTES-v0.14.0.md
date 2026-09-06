No installer, just a restart

Updating used to be three presses and end in a Windows installer window. Now SpawnLoft finds a new
version on its own, fetches it in the background, and asks for one thing: a restart. No wizard, no
progress dialog, no elevation prompt.

## Updates

- **New versions arrive on their own.** SpawnLoft asks the release feed twenty seconds after it
  starts and every six hours it stays open, and downloads anything newer in the background. Only
  the changed parts of the installer are sent, so an update is usually a fraction of its size.
- **The button in the header reports rather than asks.** It used to be a press to check, a press
  to download and a press to install. Now it counts the download up and then reads **Restart to
  update**. Nothing to press until there is something worth pressing.
- **Installing shows no installer.** The window closes and reopens on the new version, and that is
  the whole of it - the package runs silently, and because SpawnLoft installs for you rather than
  for the whole machine, Windows has nothing to ask permission for. Closing the app with an update
  waiting applies it on the way out instead.
- **The restart is still yours to ask for.** Downloading and installing are different promises and
  are kept differently: fetching a few megabytes costs nothing anyone notices, but replacing the
  running program interrupts, and this app sits beside servers that stay up for weeks. So it waits,
  and it still says first that running servers survive the restart - only the window goes away.
- **A check that fails quietly fails quietly.** A laptop that is offline should not raise a warning
  every six hours about a check nobody asked for. A check you pressed still answers either way.

## Upgrading to this one

- **This update still arrives the old way.** The version doing the updating is the one already
  installed, so the last installer window you see is the one that brings you here. From 0.14.0 on
  there are no more.
- **You may need to ask for it.** Automatic checking is what this release adds, so a copy on 0.13.0
  or earlier will not go looking by itself. Press *Check for updates* in the header once, and the
  ones after this arrive on their own.

## For contributors

- **A local test installer is one command.** `node build-test.mjs` in `desktop/` builds without the
  signing profile, at a version below the latest release so the update path has somewhere to go and
  can actually be tried end to end. `package.json` is restored even when the build fails.
