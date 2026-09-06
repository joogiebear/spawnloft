'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { autoUpdater } = require('electron-updater')
const windowState = require('./window-state')

/**
 * mcctl desktop.
 *
 * A window around the same panel the CLI serves, plus the two things a browser cannot do: a native
 * folder picker, and a first-run setup that happens before anything exists.
 *
 * The core runs IN THIS PROCESS rather than as a spawned server. Electron already is a Node
 * runtime, so importing mcctl directly is what "bundled" actually means here - one process, no
 * second Node to ship, and no orphaned child if the window dies.
 */

/**
 * Where the mcctl core lives.
 *
 * Packaged: alongside the app in resources. Development: the checkout, so the app under test is the
 * code being edited rather than a copy that drifts from it.
 *
 *   npm start -- --core S:\Claude\mcctl        (or set MCCTL_CORE)
 */
function resolveCore() {
  const flagIndex = process.argv.indexOf('--core')
  const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : null
  const dev = fromFlag || process.env.MCCTL_CORE
  if (dev) return { dir: path.resolve(dev), mode: 'dev' }

  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'core')
    : path.resolve(__dirname, '..')
  return { dir: bundled, mode: app.isPackaged ? 'bundled' : 'checkout' }
}

const core = resolveCore()

/** Import an ESM module out of the resolved core by file URL, so the path can vary at runtime. */
function loadCore(rel) {
  return import(pathToFileURL(path.join(core.dir, rel)).href)
}

let panelUrl = null
let win = null

async function startPanel() {
  const ui = await loadCore('src/ui.mjs')
  // Port 0: let the OS pick. A fixed port would collide with a CLI panel already running, and the
  // desktop app has no reason to be reachable at a predictable address.
  const { url } = await ui.serve({ port: 0, host: '127.0.0.1', open: false })
  return url
}

/** Whether the first-run wizard should be shown: nothing configured, and no existing layout found. */
async function needsSetup() {
  const settings = await loadCore('src/settings.mjs')
  const saved = settings.load()
  // A saved root only counts if it is still there. Uninstalling leaves settings.json behind, so a
  // reinstall - or a data folder that lived on a drive which is no longer plugged in - would
  // otherwise skip the wizard and open a panel pointed at nothing.
  if (saved.dataRoot && fs.existsSync(saved.dataRoot)) return false
  // An existing checkout already holding instances.json is a configured install in all but name;
  // asking that person where to put their servers would be asking about servers they already have.
  return !fs.existsSync(path.join(core.dir, 'instances.json'))
}

/**
 * The app icon.
 *
 * <p>electron-builder stamps build/icon.ico onto the packaged executable and the installer, but an
 * unpackaged `npm start` gets Electron's own atom - and so does the BrowserWindow unless it is
 * told. Pointing at the same file keeps development, the taskbar and the installer showing one
 * icon rather than three.
 */
const ICON = path.join(__dirname, 'build', 'icon.ico')

// ---- window size and position ------------------------------------------------

/** Where the window was last time. Kept with Electron's own state, not in the core's settings. */
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

/**
 * The app was called mcctl until 0.11.x, and Electron keys its per-app folder by product name, so
 * the first SpawnLoft start would otherwise open at the default size and place. The saved window
 * state is copied across once; the old folder is left where it is.
 */
function carryOverWindowState() {
  const to = windowStateFile()
  if (fs.existsSync(to)) return
  const from = path.join(path.dirname(app.getPath('userData')), 'mcctl-desktop', 'window-state.json')
  if (!fs.existsSync(from)) return
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  } catch {
    // A lost window position is not worth a dialog.
  }
}

/** The work area of every attached display, as plain rectangles. */
function displayAreas() {
  return require('electron').screen.getAllDisplays().map((d) => d.workArea)
}

function createWindow(loadUrl) {
  const state = windowState.load(windowStateFile(), displayAreas())
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: windowState.MIN_WIDTH,
    minHeight: windowState.MIN_HEIGHT,
    backgroundColor: '#0c0e14',
    title: 'SpawnLoft',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    // Painting a half-built page is worse than painting nothing. The window is created hidden and
    // shown once the panel has actually rendered, so the first frame anyone sees is the finished
    // one rather than a white flash and a jumping layout.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The page is local and trusted, but there is no reason for it to hold Node: everything it
      // needs comes through preload as a handful of named calls. sandbox is the Electron default
      // since 20; stated so the posture is in the config rather than in a version's defaults.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  // Maximise before showing, so a window that was left maximised does not appear at its restored
  // size and then jump.
  if (state.maximized) win.maximize()
  windowState.track(win, windowStateFile())

  win.loadURL(loadUrl)
  win.once('ready-to-show', () => win.show())
  // A page that fails to load would otherwise leave a hidden window and a process with no UI.
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // ERR_ABORTED is Chromium's word for a navigation that was superseded or cancelled, not one
    // that failed; it must not pop a modal.
    if (code === -3) return
    if (win && !win.isDestroyed()) win.show()
    dialog.showErrorBox('SpawnLoft could not open its panel', `${desc} (${code})\n\n${loadUrl}`)
  })

  // Links to anywhere else belong in the real browser, not in a chrome-less app window the person
  // cannot navigate back out of. Held to the same rule as the IPC bridge: https only, so a page
  // cannot use window.open to launch a file: or ms-settings: handler that the bridge would refuse.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // And the panel itself must stay on the panel. Nothing legitimate navigates the top frame away
  // from the loopback URL it was opened at.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(loadUrl)) e.preventDefault()
  })
  return win
}

// ---- IPC: the things a web page cannot do for itself -------------------------

ipcMain.handle('mcctl:pickFolder', async (_e, { title } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    // createDirectory lets someone make the folder in the dialog instead of alt-tabbing to
    // Explorer to make it and coming back.
    properties: ['openDirectory', 'createDirectory'],
  })
  return res.canceled ? null : res.filePaths[0]
})

// A file chooser, for world archives. Windows cannot offer files AND folders in one native
// dialog, so this picks files; the page keeps its text field for pasting a folder path.
ipcMain.handle('mcctl:pickFile', async (_e, { title } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a file',
    properties: ['openFile'],
    filters: [
      { name: 'World archives', extensions: ['zip', 'gz', 'tgz'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return res.canceled ? null : res.filePaths[0]
})

/**
 * Is Java installed?
 *
 * <p>Asked by the first-run wizard before anything is downloaded. Java is the one prerequisite
 * mcctl cannot supply, and finding out at the first press of Start - after setup and a fifty-
 * megabyte download - is the difference between a missing dependency and a broken application.
 */
ipcMain.handle('mcctl:checkJava', async () => {
  const java = await loadCore('src/java.mjs')
  return { ...(await java.health()), downloadUrl: java.DOWNLOAD_URL }
})

/**
 * Open a link in the real browser.
 *
 * <p>Allowlisted to https, so a compromised page cannot use this to launch a local executable or
 * reach a file:// path.
 */
ipcMain.handle('mcctl:openExternal', async (_e, url) => {
  if (typeof url !== 'string' || !url.startsWith('https://')) return { ok: false }
  await shell.openExternal(url)
  return { ok: true }
})

ipcMain.handle('mcctl:getSetup', async () => {
  const settings = await loadCore('src/settings.mjs')
  const roots = settings.resolveRoots()
  return {
    defaultDataRoot: settings.defaultDataRoot(),
    current: roots,
    coreDir: core.dir,
    coreMode: core.mode,
  }
})

ipcMain.handle('mcctl:saveSetup', async (_e, { dataRoot, instancesDir, separate }) => {
  const settings = await loadCore('src/settings.mjs')

  // Written to, not merely inspected. A drive that has been unplugged, a read-only mount and a
  // network share all look fine until the first write.
  for (const dir of [dataRoot, separate ? instancesDir : null].filter(Boolean)) {
    const check = settings.checkWritable(dir)
    if (!check.ok) return { ok: false, error: `Cannot write to ${dir}\n${check.error}` }
  }

  settings.save({
    dataRoot,
    separateInstances: Boolean(separate),
    instancesDir: separate ? instancesDir : null,
  })

  // Read it back before relaunching into it.
  //
  // The app resolves its data root once, at import, so the choice made here only survives via this
  // file. If the write did not land - a roaming profile that is read-only, a sync client holding
  // the file, anything - the relaunched app silently falls back to the default location and shows
  // the wizard again, while the servers created in the meantime sit in a folder it no longer looks
  // at. Failing here is recoverable; relaunching into a lost setting is not obviously anything.
  const written = settings.load()
  if (path.resolve(written.dataRoot ?? '') !== path.resolve(dataRoot)) {
    return {
      ok: false,
      error:
        `SpawnLoft could not remember that location.\n\n` +
        `It saved to ${settings.settingsFile()} but read back ` +
        `${written.dataRoot ? `"${written.dataRoot}"` : 'nothing'}. ` +
        `Check that file is writable, then try again.`,
    }
  }

  // The core resolves its locations once at import, so the new layout only takes effect on a fresh
  // start. Relaunching is honest about that rather than leaving a half-configured process running.
  app.relaunch({ args: process.argv.slice(1) })
  app.exit(0)
  return { ok: true }
})


// ---- updates -----------------------------------------------------------------

/** How often a running copy asks GitHub whether there is anything newer. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Long enough after start that the first check never competes with opening the panel. */
const UPDATE_FIRST_DELAY_MS = 20 * 1000

/**
 * Updates: fetched in the background, applied on restart, with no installer ever on screen.
 *
 * <p>Only ever runs from a packaged build. In development the version is whatever package.json says
 * and there is no installer to replace, so a check would either do nothing or try to overwrite a
 * checkout — the guard is not politeness, it is what stops the updater touching source.
 *
 * <p>Downloading and installing are different promises and are kept differently. The download is
 * automatic: it is a few megabytes over a connection nobody is watching, electron-updater sends
 * only the changed blocks, and doing it ahead of time means the only thing left when an update
 * matters is a restart. Replacing the running program is the part that interrupts, so it waits for
 * the person to ask — or for them to close the window, which the updater treats as the same
 * permission and uses to apply the update on the way out.
 *
 * <p>The install runs the NSIS package with `/S`: no wizard, no progress dialog, no UAC prompt —
 * the app installs per-user, so there is nothing to elevate. The window closes and comes back on
 * the new version. That is the whole visible update.
 */
function setupUpdates() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }))
  autoUpdater.on('update-not-available', () => send('update:none', {}))
  autoUpdater.on('error', (err) => send('update:error', { error: String(err?.message ?? err) }))
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }))

  setTimeout(checkForUpdatesQuietly, UPDATE_FIRST_DELAY_MS).unref?.()
  // Six-hourly rather than once at start, because this app is left open for days next to servers
  // that are left running for weeks.
  setInterval(checkForUpdatesQuietly, UPDATE_INTERVAL_MS).unref?.()
}

/**
 * A check nobody asked for.
 *
 * <p>Whether anyone wants to hear about the result is the renderer's business, not this process's:
 * the window knows whether a person pressed the button, because they pressed it there. Deciding it
 * here would mean one shared flag standing for every check at once, and a background check landing
 * on top of someone's would answer the wrong question - their "Up to date" swallowed as though
 * nobody had asked, or a quiet failure raised at them as a toast.
 *
 * <p>checkForUpdates rejects as well as emitting 'error'. Unhandled, that rejection would take the
 * process down over a missing network, so it is swallowed here.
 */
function checkForUpdatesQuietly() {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch(() => {})
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

ipcMain.handle('mcctl:checkUpdate', async () => {
  if (!app.isPackaged) {
    return { ok: false, reason: 'dev', message: 'Updates only apply to an installed build.' }
  }
  try {
    const res = await autoUpdater.checkForUpdates()
    return { ok: true, version: res?.updateInfo?.version ?? null, current: app.getVersion() }
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err?.message ?? err) }
  }
})

/**
 * Install now: close, replace, reopen.
 *
 * <p>Silent, and restarted afterwards. `/S` means the NSIS package never draws a window, and
 * `--force-run` brings the app back on the new version rather than leaving someone looking at an
 * empty desktop wondering whether it worked.
 *
 * <p>The caller is expected to have warned about running servers first. Servers survive this — they
 * are detached daemons — but the panel disappears mid-restart, and being told that beforehand is the
 * difference between an update and a glitch.
 */
ipcMain.handle('mcctl:installUpdate', async () => {
  autoUpdater.quitAndInstall(true, true)
  return { ok: true }
})

/**
 * What this copy is, precisely.
 *
 * <p>A version number is a label someone typed; the commit is what actually produced the binary.
 * Written into resources at build time, so a bug report can name the exact code rather than
 * "0.2.7", of which there could be several.
 */
function buildInfo() {
  try {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'build-info.json')
      : path.join(__dirname, 'dist', 'build-info.json')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // Running from a checkout, or a build that predates this. Neither is worth an error.
    return null
  }
}

ipcMain.handle('mcctl:appInfo', async () => {
  const build = buildInfo()
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    coreMode: core.mode,
    commit: build?.shortCommit ?? null,
    dirty: build?.dirty ?? null,
    builtAt: build?.builtAt ?? null,
  }
})

// ---- lifecycle ---------------------------------------------------------------

/**
 * Windows groups taskbar buttons, jump lists and notifications by AppUserModelID. Without this
 * call the running app is a different identity from the shortcut the installer wrote, so it gets
 * its own taskbar button with the wrong icon and cannot be pinned usefully. It must match the
 * appId in package.json.
 */
if (process.platform === 'win32') app.setAppUserModelId('io.github.joogiebear.mcctl')

/**
 * No menu bar.
 *
 * <p>Electron's default menu is File / Edit / View / Window / Help built for a text editor, and on
 * a control panel it is a strip of items that either do nothing useful or open developer tools.
 * Copy, paste and select-all keep working - Chromium handles those in the renderer on Windows
 * without a menu to hang them off.
 */
Menu.setApplicationMenu(null)

/**
 * One instance.
 *
 * <p>Not a nicety here: two copies of this process would bind two panels and, worse, two
 * supervisors could race the same instance's control pipe. A second launch raises the window that
 * already exists, which is also what someone double-clicking the shortcut again meant.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(async () => {
    carryOverWindowState()
    if (await needsSetup()) {
      createWindow(pathToFileURL(path.join(__dirname, 'setup.html')).href)
    } else {
      panelUrl = await startPanel()
      createWindow(panelUrl)
      setupUpdates()
    }

    app.on('activate', () => {
      // panelUrl is still null on the setup branch; reopening into `null` would load about:blank.
      if (BrowserWindow.getAllWindows().length === 0 && panelUrl) createWindow(panelUrl)
    })
  }).catch((err) => {
    // Without this, a failure in here rejects silently: no window, no message, and an mcctl.exe in
    // Task Manager that the person can only find by looking for it. Quarantined resources and a
    // security product blocking the loopback listen both land here, and both are plausible for an
    // unsigned build on a stranger's machine.
    dialog.showErrorBox(
      'SpawnLoft could not start',
      `${err?.message ?? err}\n\n${err?.stack ?? ''}`.trim(),
    )
    app.exit(1)
  })
}

app.on('window-all-closed', () => {
  // Closing the window closes the app, but the SERVERS keep running: mcctl starts each one as a
  // detached daemon that does not belong to this process. Quitting a control panel must never take
  // a running Minecraft server down with it.
  if (process.platform !== 'darwin') app.quit()
})
