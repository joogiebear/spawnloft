'use strict'

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { autoUpdater } = require('electron-updater')
const windowState = require('./window-state')
const uiZoom = require('./ui-zoom')
const updateChannel = require('./update-channel')
const launcherWindow = require('./launcher-window')
const loginWindow = require('./login-window')
// ad-hoc packages can't take Squirrel.Mac updates; signed betas use the normal updater,
// and missing provenance fails closed on mac
const manualUpdates = process.platform === 'darwin' && (!app.isPackaged || buildInfo()?.macSigningMode !== 'signed')
const previewDownloadUrl = 'https://github.com/joogiebear/spawnloft/releases'

// Window around the panel the CLI serves, plus a native folder picker and first-run setup.
// The core runs in this process (imported directly), so there is no second Node to ship
// and no orphaned child if the window dies.

// packaged: core sits in resources. dev: the checkout, or --core <dir> / MCCTL_CORE.
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

function loadCore(rel) {
  return import(pathToFileURL(path.join(core.dir, rel)).href)
}

let panelUrl = null
let win = null
// the game launcher's window while it is open; one at a time
let launcher = null

async function startPanel() {
  const ui = await loadCore('src/ui.mjs')
  // port 0: a fixed port would collide with a CLI panel already running
  const { url } = await ui.serve({ port: 0, host: '127.0.0.1', open: false })
  return url
}

async function needsSetup() {
  const settings = await loadCore('src/settings.mjs')
  const saved = settings.load()
  // settings.json survives an uninstall and the data folder may be on an unplugged drive,
  // so a saved root only counts if it still exists
  if (saved.dataRoot && fs.existsSync(saved.dataRoot)) return false
  // a checkout that already has instances.json is configured
  return !fs.existsSync(path.join(core.dir, 'instances.json'))
}

// electron-builder stamps icon.ico on the packaged exe, but unpackaged runs and the BrowserWindow
// need it passed explicitly. Linux can't read .ico; packaged, icon.png is copied to
// resources/ because build/ is not inside app.asar.
const ICON = process.platform === 'linux'
  ? (app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, 'build', 'icon.png'))
  : path.join(__dirname, 'build', 'icon.ico')

// kept in Electron's userData, not the core's settings
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function launcherStateFile() {
  return path.join(app.getPath('userData'), 'launcher-window-state.json')
}

function uiZoomFile() {
  return path.join(app.getPath('userData'), 'ui-zoom.json')
}

// Applied to every window and remembered. Electron resets a page's zoom on navigation and the panel
// port changes between launches, so the browser's own per-site memory would not hold it.
// `setting` is what was chosen ('auto' or a step); `zoom` is the factor on screen right now.
let setting = uiZoom.AUTO
let zoom = 1
// the display under the main window; before it exists, the one the saved position falls on
function currentDisplay(bounds) {
  const { screen } = require('electron')
  const rect = bounds || (win && !win.isDestroyed() ? win.getBounds() : null)
  return rect ? screen.getDisplayMatching(rect) : screen.getPrimaryDisplay()
}
function applyZoom(bounds) {
  zoom = uiZoom.resolve(setting, currentDisplay(bounds))
  for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(zoom)
  return { setting, zoom }
}
function setZoom(value) {
  setting = uiZoom.normalize(value)
  uiZoom.save(uiZoomFile(), setting)
  return applyZoom()
}
// Auto follows the window: dragged to another monitor, or that monitor's scaling changed.
let lastDisplayId = null
let watchingDisplays = false
function followDisplay() {
  if (setting !== uiZoom.AUTO) return
  const d = currentDisplay()
  if (d.id === lastDisplayId) return
  lastDisplayId = d.id
  applyZoom()
}
function trackZoom(contents) {
  contents.setZoomFactor(zoom)
  contents.on('did-finish-load', () => contents.setZoomFactor(zoom))
  // the default menu, and with it Ctrl+= and Ctrl+-, is removed below on Windows and Linux
  contents.on('before-input-event', (event, input) => {
    // a keyboard step is a fixed choice; it steps from the size on screen, so Auto at 125% goes to 150%
    const next = uiZoom.zoomForKey(input, zoom)
    if (next === null) return
    event.preventDefault()
    setZoom(next)
  })
}

// the app was called mcctl until 0.11.x and Electron keys userData by product name, so copy the
// saved window state across once or the first SpawnLoft start opens at the default size
function carryOverWindowState() {
  const to = windowStateFile()
  if (fs.existsSync(to)) return
  const from = path.join(path.dirname(app.getPath('userData')), 'mcctl-desktop', 'window-state.json')
  if (!fs.existsSync(from)) return
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
  } catch {
    // a lost window position is not worth a dialog
  }
}

function displayAreas() {
  return require('electron').screen.getAllDisplays().map((d) => d.workArea)
}

function createWindow(loadUrl, theme = 'classic') {
  const state = windowState.load(windowStateFile(), displayAreas())
  setting = uiZoom.load(uiZoomFile())
  const startDisplay = currentDisplay({ x: state.x ?? 0, y: state.y ?? 0, width: state.width, height: state.height })
  lastDisplayId = startDisplay.id
  zoom = uiZoom.resolve(setting, startDisplay)
  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: windowState.MIN_WIDTH,
    minHeight: windowState.MIN_HEIGHT,
    backgroundColor: theme === 'spawnloft' ? '#090d0d' : '#0c0e14',
    title: 'SpawnLoft',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    // hidden until ready-to-show, to avoid a white flash and a jumping layout
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // the page gets no Node; preload exposes a few named calls. sandbox is already the
      // default since Electron 20, set explicitly
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // the preload runs in the Play page's frame (/launcher, preload.js keeps it out of any
      // other frame) as well as the panel; Node stays off everywhere, this only says where the
      // preload runs
      nodeIntegrationInSubFrames: true,
      // the saved size from the first paint; setting it after load shows a 100% frame first
      zoomFactor: zoom,
    },
  })
  // maximise before showing so it doesn't appear at the restored size and jump
  if (state.maximized) win.maximize()
  windowState.track(win, windowStateFile())
  trackZoom(win.webContents)
  win.on('move', followDisplay)
  if (!watchingDisplays) {
    // once: on mac the window is recreated on activate
    watchingDisplays = true
    require('electron').screen.on('display-metrics-changed', () => { lastDisplayId = null; followDisplay() })
  }

  win.loadURL(loadUrl)
  win.once('ready-to-show', () => win.show())
  // otherwise a failed load leaves a hidden window and no UI
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // ERR_ABORTED: navigation superseded or cancelled, not a failure
    if (code === -3) return
    if (win && !win.isDestroyed()) win.show()
    dialog.showErrorBox('SpawnLoft could not open its panel', `${desc} (${code})\n\n${loadUrl}`)
  })

  // external links go to the real browser. https only, same as the IPC bridge, so window.open
  // can't launch a file: or ms-settings: handler
  const external = ({ url }) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  }
  // the windows the panel may open itself: a server console at ?console=<name>, and the game
  // launcher at exactly /launcher (launcher-window.js)
  const childPrefs = {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  }
  const launcherUrl = loadUrl + 'launcher'
  let launcherState = null
  win.webContents.setWindowOpenHandler((details) => {
    const kind = launcherWindow.windowKind(details.url, loadUrl)
    if (kind === 'console') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 980,
          height: 660,
          minWidth: 520,
          minHeight: 360,
          backgroundColor: theme === 'spawnloft' ? '#090d0d' : '#0c0e14',
          icon: fs.existsSync(ICON) ? ICON : undefined,
          autoHideMenuBar: true,
          webPreferences: { ...childPrefs, zoomFactor: zoom },
        },
      }
    }
    if (kind === 'launcher') {
      // Chromium hands a second window.open with the same name to the open window itself (see
      // will-navigate below); this catches the cases where it cannot find it by name
      if (focusLauncher()) return { action: 'deny' }
      // the first size follows the zoom on the panel's screen; after that the saved size wins
      const size = launcherWindow.launcherBounds(zoom, currentDisplay().workArea)
      const min = { width: size.minWidth, height: size.minHeight }
      launcherState = windowState.load(launcherStateFile(), displayAreas(), size, min)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: launcherState.width,
          height: launcherState.height,
          x: launcherState.x,
          y: launcherState.y,
          minWidth: min.width,
          minHeight: min.height,
          title: launcherWindow.LAUNCHER_TITLE,
          backgroundColor: theme === 'spawnloft' ? '#090d0d' : '#0c0e14',
          icon: fs.existsSync(ICON) ? ICON : undefined,
          autoHideMenuBar: true,
          webPreferences: { ...childPrefs, zoomFactor: zoom },
        },
      }
    }
    return external(details)
  })
  // child windows follow the same rules as the main window; the launcher also remembers its place
  win.webContents.on('did-create-window', (child, details) => {
    child.webContents.setWindowOpenHandler(external)
    trackZoom(child.webContents)
    const isLauncher = details?.url === launcherUrl
    child.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(loadUrl)) return e.preventDefault()
      // the panel opening the launcher again by name: bring it forward instead of reloading it,
      // which would drop a sign-in or a form in progress. Not the window's first load, which comes
      // through here too.
      if (isLauncher && url === launcherUrl && child.webContents.getURL().startsWith(launcherUrl)) {
        e.preventDefault()
        focusLauncher()
      }
    })
    if (!isLauncher) return
    launcher = child
    child.on('closed', () => { if (launcher === child) launcher = null })
    if (launcherState?.maximized) child.maximize()
    windowState.track(child, launcherStateFile())
  })
  // the top frame must stay on the loopback URL it was opened at, and so must every frame in it
  // (the Play page is /launcher in a frame of the panel)
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(loadUrl)) e.preventDefault()
  })
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return
    const url = String(e.url)
    if (url !== launcherUrl && !url.startsWith(launcherUrl + '#')) e.preventDefault()
  })
  return win
}

function focusLauncher() {
  if (!launcher || launcher.isDestroyed()) return false
  if (launcher.isMinimized()) launcher.restore()
  launcher.show()
  launcher.focus()
  return true
}

// The macOS menu item: the panel's Play page, as the sidebar's Play shows it. Nothing to do while
// the setup wizard is up. (The launcher window rules above stay for a page that opens /launcher
// in a window of its own; the panel no longer does.)
function showPlay() {
  if (!panelUrl || !win || win.isDestroyed() || !win.webContents.getURL().startsWith(panelUrl)) return
  win.webContents.executeJavaScript("typeof showPlay === 'function' && void showPlay()", true).catch(() => {})
}

// The calls below are for the panel's own pages. The login window has no preload, so it cannot
// make them; this also refuses a frame that has navigated off the panel.
function fromPanel(e) {
  const url = e.senderFrame?.url
  return Boolean(panelUrl) && typeof url === 'string' && url.startsWith(panelUrl)
}

// Opens a launcher profile's folder in the file manager. The page gets { ok } and nothing else.
ipcMain.handle('mcctl:openProfileFolder', async (e, name) => {
  if (!fromPanel(e)) return { ok: false }
  try {
    const client = await loadCore('src/client.mjs')
    const paths = await loadCore('src/client-paths.mjs')
    return await launcherWindow.openProfileFolder(name, { getProfile: client.getProfile, profileDir: paths.profileDir, openPath: (dir) => shell.openPath(dir) })
  } catch {
    return { ok: false }
  }
})

// Microsoft's sign-in page in its own window (login-window.js). Only the authorize URL the panel
// made for this app and this panel's callback is accepted. Resolves once the window has closed.
ipcMain.handle('mcctl:openMicrosoftLogin', async (e, url) => {
  if (!fromPanel(e)) return { ok: false }
  const auth = await loadCore('src/client-auth.mjs')
  const port = Number(new URL(panelUrl).port)
  if (!loginWindow.isAuthorizeUrl(url, { authorizeUrl: auth.AUTHORIZE_URL, clientId: auth.MSA_CLIENT_ID, port })) return { ok: false }
  await loginWindow.open(url, {
    port,
    near: BrowserWindow.fromWebContents(e.sender),
    icon: fs.existsSync(ICON) ? ICON : undefined,
  })
  return { ok: true }
})

ipcMain.handle('mcctl:pickFolder', async (_e, { title } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return res.canceled ? null : res.filePaths[0]
})

// for world archives. Windows can't offer files and folders in one native dialog, so this
// picks files; the page has a text field for pasting a folder path.
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

ipcMain.handle('mcctl:getZoom', async () => ({ setting, zoom }))
ipcMain.handle('mcctl:setZoom', async (_e, value) => setZoom(value))

// asked by the first-run wizard: Java is the one prerequisite we can't supply
ipcMain.handle('mcctl:checkJava', async () => {
  const java = await loadCore('src/java.mjs')
  return { ...(await java.health()), downloadUrl: java.DOWNLOAD_URL }
})

// https only, so a compromised page can't launch a local executable or reach a file:// path
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
    // nobody sees stderr in the desktop app, so an unreadable settings file is reported to the wizard
    settingsProblem: settings.inspect(),
  }
})

ipcMain.handle('mcctl:saveSetup', async (_e, { dataRoot, instancesDir, separate }) => {
  const settings = await loadCore('src/settings.mjs')

  // write-test the folders: unplugged drives, read-only mounts and network shares look fine
  // until the first write
  for (const dir of [dataRoot, separate ? instancesDir : null].filter(Boolean)) {
    const check = settings.checkWritable(dir)
    if (!check.ok) return { ok: false, error: `Cannot write to ${dir}\n${check.error}` }
  }

  // a damaged settings file is set aside (kept beside the new one) so the wizard isn't stuck on it;
  // a failed write is returned so the real reason is shown, not Electron's wrapper
  try {
    settings.save({
      dataRoot,
      separateInstances: Boolean(separate),
      instancesDir: separate ? instancesDir : null,
    }, { replaceUnreadable: true, onSetAside: (kept) => console.warn(`SpawnLoft: the settings file could not be read, so it was kept as ${kept}`) })
  } catch (err) {
    return { ok: false, error: err.message }
  }

  // read back before relaunching: the core resolves its data root once at import, so the choice
  // only survives via this file. If the write didn't land (read-only roaming profile, sync client
  // holding the file) the relaunch silently falls back to the default location.
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

  // the new layout only takes effect on a fresh start
  app.relaunch({ args: process.argv.slice(1) })
  app.exit(0)
  return { ok: true }
})

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

// keeps the first check from competing with opening the panel
const UPDATE_FIRST_DELAY_MS = 20 * 1000

// which releases this copy follows; kept in userData because it is about this install, not the servers
function updateChannelFile() {
  return path.join(app.getPath('userData'), 'update-channel.json')
}

// Downloads happen in the background; installing waits for the user, or for the window closing
// (the updater applies it on quit). Packaged builds only, so a dev run never touches a checkout.
// The NSIS install runs with /S, per-user, so there is no UAC prompt.
function setupUpdates() {
  if (manualUpdates) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // mac updates use complete signed zips; windows keeps differential updates
  if (process.platform === 'darwin') autoUpdater.disableDifferentialDownload = true
  autoUpdater.logger = null
  updateChannel.apply(autoUpdater, updateChannel.describe(updateChannelFile(), app.getVersion()).beta)

  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }))
  autoUpdater.on('update-not-available', () => send('update:none', {}))
  autoUpdater.on('error', (err) => send('update:error', { error: String(err?.message ?? err) }))
  autoUpdater.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }))

  setTimeout(checkForUpdatesQuietly, UPDATE_FIRST_DELAY_MS).unref?.()
  // periodic because this app is left open for days
  setInterval(checkForUpdatesQuietly, UPDATE_INTERVAL_MS).unref?.()
}

// The renderer decides whether to show a result, since only it knows if the user pressed the
// button. checkForUpdates rejects as well as emitting 'error'; swallow it so a missing network
// doesn't crash the process.
function checkForUpdatesQuietly() {
  if (!app.isPackaged || manualUpdates) return
  autoUpdater.checkForUpdates().catch(() => {})
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

ipcMain.handle('mcctl:updateChannel', async () => updateChannel.describe(updateChannelFile(), app.getVersion()))

// takes effect on the next check, which runs immediately so opting in shows something happening;
// opting out is never a downgrade (see update-channel.js)
ipcMain.handle('mcctl:setUpdateChannel', async (_e, beta) => {
  if (typeof beta !== 'boolean') return { ok: false }
  try {
    updateChannel.save(updateChannelFile(), beta)
  } catch (err) {
    return { ok: false, message: String(err?.message ?? err) }
  }
  updateChannel.apply(autoUpdater, beta)
  checkForUpdatesQuietly()
  return { ok: true, ...updateChannel.describe(updateChannelFile(), app.getVersion()) }
})

ipcMain.handle('mcctl:checkUpdate', async () => {
  if (manualUpdates) {
    return { ok: false, reason: 'manual', message: 'Mac previews update manually. Download the current build from the beta release page.' }
  }
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

// quitAndInstall(true, true): silent NSIS install (/S), then reopen on the new version.
// Servers survive (detached daemons) but the panel goes away mid-restart, so the caller should
// warn about running servers first.
ipcMain.handle('mcctl:installUpdate', async () => {
  if (manualUpdates || !app.isPackaged) return { ok: false }
  autoUpdater.quitAndInstall(true, true)
  return { ok: true }
})

// written into resources at build time so a bug report can name the exact commit
function buildInfo() {
  try {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'build-info.json')
      : path.join(__dirname, 'dist', 'build-info.json')
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // running from a checkout, or a build without build-info
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
    manualUpdates,
    downloadUrl: manualUpdates ? previewDownloadUrl : null,
  }
})

// must match appId in package.json, or the running app gets its own taskbar button with the
// wrong icon instead of sharing the installer's shortcut identity
if (process.platform === 'win32') app.setAppUserModelId('io.github.joogiebear.mcctl')

// no menu bar elsewhere: the default one is for a text editor, and copy/paste still work without
// it. macOS routes editing shortcuts and Quit through the application menu.
// The game launcher's entry on macOS is also Window > Game launcher; elsewhere it is the sidebar's
// Play, which every platform has.
Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
  { role: 'appMenu' },
  { role: 'editMenu' },
  {
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      { label: 'Play', click: () => showPlay() },
      { type: 'separator' },
      { role: 'front' },
    ],
  },
]) : null)

// two copies would bind two panels, and two supervisors could race the same instance's control pipe
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
    // the wizard can't ask the panel for the theme yet, so it goes in the setup URL to avoid a
    // wrong-coloured first frame
    const appearance = await loadCore('src/appearance.mjs')
    const openApp = async () => {
      if (await needsSetup()) {
        const theme = appearance.readTheme()
        const setupUrl = pathToFileURL(path.join(__dirname, 'setup.html'))
        setupUrl.searchParams.set('theme', theme)
        createWindow(setupUrl.href, theme)
      } else {
        if (!panelUrl) {
          panelUrl = await startPanel()
          setupUpdates()
        }
        createWindow(panelUrl, appearance.readTheme())
      }
    }
    await openApp()

    app.on('activate', () => {
      // closing the last window keeps a mac app alive, including during first setup
      if (BrowserWindow.getAllWindows().length === 0) {
        openApp().catch(err => dialog.showErrorBox('SpawnLoft could not reopen', String(err?.message ?? err)))
      }
    })
  }).catch((err) => {
    // otherwise a startup failure is silent: no window, just a stray process. Quarantined
    // resources and security software blocking the loopback listen both land here.
    dialog.showErrorBox(
      'SpawnLoft could not start',
      `${err?.message ?? err}\n\n${err?.stack ?? ''}`.trim(),
    )
    app.exit(1)
  })
}

app.on('window-all-closed', () => {
  // servers are detached daemons, not children of this process; quitting must not stop them
  if (process.platform !== 'darwin') app.quit()
})
