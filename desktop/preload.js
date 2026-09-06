'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * The only bridge between the page and the machine.
 *
 * Three named calls, nothing generic. A preload that forwards arbitrary IPC would hand the page the
 * whole main process, and the page is a local web app that also runs in an ordinary browser — it
 * should be able to do exactly as much in one as the other, plus these.
 */
contextBridge.exposeInMainWorld('mcctlDesktop', {
  /** True when running inside the app rather than a browser tab, so the page can adapt. */
  isDesktop: true,

  /** Native folder chooser. Resolves to an absolute path, or null if cancelled. */
  pickFolder: (title) => ipcRenderer.invoke('mcctl:pickFolder', { title }),

  /** Native file-or-folder chooser (for world archives). Absolute path, or null if cancelled. */
  pickFile: (title) => ipcRenderer.invoke('mcctl:pickFile', { title }),

  /** Current and default locations, for the setup screen. */
  getSetup: () => ipcRenderer.invoke('mcctl:getSetup'),

  /** Whether a usable Java is installed. Asked before anything is downloaded. */
  checkJava: () => ipcRenderer.invoke('mcctl:checkJava'),

  /** Open an https link in the real browser. Refused for anything else. */
  openExternal: (url) => ipcRenderer.invoke('mcctl:openExternal', url),

  /** Save locations and restart into them. */
  saveSetup: (choice) => ipcRenderer.invoke('mcctl:saveSetup', choice),

  /** Version and how this copy is running, for the About/Updates area. */
  appInfo: () => ipcRenderer.invoke('mcctl:appInfo'),

  /** Ask GitHub whether a newer release exists. The app also asks on its own, every six hours. */
  checkUpdate: () => ipcRenderer.invoke('mcctl:checkUpdate'),

  /** Close, install silently, reopen on the new version. Warn about running servers first. */
  installUpdate: () => ipcRenderer.invoke('mcctl:installUpdate'),

  /**
   * Subscribe to update progress. Returns an unsubscribe function.
   *
   * Named events only, and the listener never receives the raw IPC event object - a page that can
   * see `sender` can reach back into the main process.
   */
  onUpdate: (handler) => {
    const channels = ['update:available', 'update:none', 'update:error', 'update:progress', 'update:ready']
    const wrapped = channels.map((c) => {
      const fn = (_e, payload) => handler(c.replace('update:', ''), payload)
      ipcRenderer.on(c, fn)
      return () => ipcRenderer.removeListener(c, fn)
    })
    return () => wrapped.forEach((off) => off())
  },
})
