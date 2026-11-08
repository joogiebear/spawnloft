'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The bridge is for the panel's own pages: the panel itself and its Play page, which is /launcher
// in a frame of the panel. Any other frame gets nothing. (The main process refuses other senders
// by their URL as well; this keeps the surface out of their reach to begin with.)
if (window.self !== window.top && window.location.pathname !== '/launcher') return

// The only bridge between the page and the machine: named calls, nothing generic. Forwarding
// arbitrary IPC would hand the page the whole main process.
contextBridge.exposeInMainWorld('spawnloftDesktop', {
  isDesktop: true,

  // resolves to an absolute path, or null if cancelled
  pickFolder: (title) => ipcRenderer.invoke('spawnloft:pickFolder', { title }),

  // files only (world archives); null if cancelled
  pickFile: (title) => ipcRenderer.invoke('spawnloft:pickFile', { title }),

  getSetup: () => ipcRenderer.invoke('spawnloft:getSetup'),

  // { setting, zoom }: setting is 'auto' or the chosen factor (1 is 100%), zoom the factor on
  // screen now. setZoom takes 'auto' or a factor and returns the same shape.
  getZoom: () => ipcRenderer.invoke('spawnloft:getZoom'),

  setZoom: (factor) => ipcRenderer.invoke('spawnloft:setZoom', factor),

  checkJava: () => ipcRenderer.invoke('spawnloft:checkJava'),

  // https only
  openExternal: (url) => ipcRenderer.invoke('spawnloft:openExternal', url),

  // the game launcher: a profile's folder in the file manager ({ ok }), and Microsoft's sign-in
  // page in a window of its own, for the panel's authorize URL only; resolves { ok } once it closes
  openProfileFolder: (name) => ipcRenderer.invoke('spawnloft:openProfileFolder', String(name ?? '')),

  openMicrosoftLogin: (url) => ipcRenderer.invoke('spawnloft:openMicrosoftLogin', String(url ?? '')),

  saveSetup: (choice) => ipcRenderer.invoke('spawnloft:saveSetup', choice),

  appInfo: () => ipcRenderer.invoke('spawnloft:appInfo'),

  checkUpdate: () => ipcRenderer.invoke('spawnloft:checkUpdate'),

  // { beta, chosen, onBetaBuild, waitingFor }
  updateChannel: () => ipcRenderer.invoke('spawnloft:updateChannel'),

  setUpdateChannel: (beta) => ipcRenderer.invoke('spawnloft:setUpdateChannel', beta === true),

  // closes and reopens the app; warn about running servers first
  installUpdate: () => ipcRenderer.invoke('spawnloft:installUpdate'),

  // returns an unsubscribe function. The raw IPC event is never passed on: a page that can see
  // `sender` can reach back into the main process.
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
