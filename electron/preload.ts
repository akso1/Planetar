// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import { ipcRenderer } from 'electron'

window.require = require
window.global = window

window.electronAPI = {
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  ssoLogin: (ssoUrl, redirectUrlPrefix) =>
    ipcRenderer.invoke('sso-login', ssoUrl, redirectUrlPrefix),
  searchGifs: (query) => ipcRenderer.invoke('search-gifs', query),
  showNotification: (payload) =>
    ipcRenderer.invoke('show-notification', payload),
  setDockBadge: (count) => ipcRenderer.invoke('set-dock-badge', count),
  isWindowFocused: () => ipcRenderer.invoke('is-window-focused'),
  saveTextFile: (opts) => ipcRenderer.invoke('save-text-file', opts),
  onMainError: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('main-error', listener)
    return () => ipcRenderer.removeListener('main-error', listener)
  },
  onNotificationClicked: (handler) => {
    const listener = (_event, payload) => handler(payload)
    ipcRenderer.on('notification-clicked', listener)
    return () => ipcRenderer.removeListener('notification-clicked', listener)
  },
}
