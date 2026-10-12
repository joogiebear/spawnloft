'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The only bridge between the page and the machine: named calls, nothing generic. Forwarding
// arbitrary IPC would hand the page the whole main process.
contextBridge.exposeInMainWorld('mcctlDesktop', {
  isDesktop: true,

  // resolves to an absolute path, or null if cancelled
  pickFolder: (title) => ipcRenderer.invoke('mcctl:pickFolder', { title }),

  // files only (world archives); null if cancelled
  pickFile: (title) => ipcRenderer.invoke('mcctl:pickFile', { title }),

  getSetup: () => ipcRenderer.invoke('mcctl:getSetup'),

  checkJava: () => ipcRenderer.invoke('mcctl:checkJava'),

  // https only
  openExternal: (url) => ipcRenderer.invoke('mcctl:openExternal', url),

  saveSetup: (choice) => ipcRenderer.invoke('mcctl:saveSetup', choice),

  appInfo: () => ipcRenderer.invoke('mcctl:appInfo'),

  checkUpdate: () => ipcRenderer.invoke('mcctl:checkUpdate'),

  // { beta, chosen, onBetaBuild, waitingFor }
  updateChannel: () => ipcRenderer.invoke('mcctl:updateChannel'),

  setUpdateChannel: (beta) => ipcRenderer.invoke('mcctl:setUpdateChannel', beta === true),

  // closes and reopens the app; warn about running servers first
  installUpdate: () => ipcRenderer.invoke('mcctl:installUpdate'),

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
