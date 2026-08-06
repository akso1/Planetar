const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Main validates https:/mailto: only — blocks file:/javascript:/custom schemes
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  ssoLogin: (ssoUrl, redirectUrlPrefix) =>
    ipcRenderer.invoke('sso-login', ssoUrl, redirectUrlPrefix),
  searchGifs: (query) => ipcRenderer.invoke('search-gifs', query),
  showNotification: (payload) =>
    ipcRenderer.invoke('show-notification', payload),
  /** Native OS banner via main process (preferred — avoids HTML5 Notification blocks). */
  showNativeNotification: (payload) =>
    ipcRenderer.send('show-native-notification', payload),
  setDockBadge: (count) => ipcRenderer.invoke('set-dock-badge', count),
  isWindowFocused: () => ipcRenderer.invoke('is-window-focused'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onWindowMaximized: (handler) => {
    const listener = (_event, maximized) => handler(!!maximized)
    ipcRenderer.on('window-maximized', listener)
    return () => ipcRenderer.removeListener('window-maximized', listener)
  },
  setMinimizeToTray: (enabled) =>
    ipcRenderer.invoke('set-minimize-to-tray', enabled),
  getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),
  showAppWindow: () => ipcRenderer.invoke('show-app-window'),
  setWindowAppearance: (mode, backgroundColor) =>
    ipcRenderer.invoke('set-window-appearance', mode, backgroundColor),
  setVibrancy: (enabled) => ipcRenderer.invoke('set-vibrancy', enabled),
  saveTextFile: (opts) => ipcRenderer.invoke('save-text-file', opts),
  getSessionCredentials: () => ipcRenderer.invoke('session-get'),
  // Persists only via OS safeStorage in main — no plaintext fallback
  setSessionCredentials: (creds) => ipcRenderer.invoke('session-set', creds),
  clearSessionCredentials: () => ipcRenderer.invoke('session-clear'),
  getSecretStorageKey: (opts) =>
    ipcRenderer.invoke('secret-storage-key-get', opts),
  setSecretStorageKey: (payload) =>
    ipcRenderer.invoke('secret-storage-key-set', payload),
  clearSecretStorageKey: (opts) =>
    ipcRenderer.invoke('secret-storage-key-clear', opts),
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
  openElementCall: (url) => ipcRenderer.invoke('open-element-call', url),
  elementCallIsOpen: () => ipcRenderer.invoke('element-call-is-open'),
  clearElementCallSession: () =>
    ipcRenderer.invoke('clear-element-call-session'),
  onElementCallClosed: (handler) => {
    const listener = () => handler()
    ipcRenderer.on('element-call-closed', listener)
    return () => ipcRenderer.removeListener('element-call-closed', listener)
  },
  performHaptic: () => ipcRenderer.invoke('perform-haptic'),
})

/**
 * Route HTML5 `new Notification(...)` → native main-process banners.
 * Must run in the page world (contextIsolation); contextBridge cannot replace
 * the Notification constructor with a real class.
 */
try {
  webFrame.executeJavaScript(
    `(function () {
  if (window.__planetarNotificationBridged) return;
  window.__planetarNotificationBridged = true;

  class BridgedNotification {
    constructor(title, options) {
      var opts = options && typeof options === 'object' ? options : {};
      var payload = {
        title: title == null ? 'Notification' : String(title),
        body: opts.body == null ? '' : String(opts.body),
      };
      try {
        if (window.electronAPI && typeof window.electronAPI.showNativeNotification === 'function') {
          window.electronAPI.showNativeNotification(payload);
        }
      } catch (_) {}
      this.title = payload.title;
      this.body = payload.body;
      this.dir = opts.dir || 'auto';
      this.lang = opts.lang || '';
      this.tag = opts.tag || '';
      this.icon = opts.icon || '';
      this.data = opts.data;
      this.silent = !!opts.silent;
      this.onclick = null;
      this.onshow = null;
      this.onerror = null;
      this.onclose = null;
    }
    close() {}
    addEventListener(type, listener) {
      if (type === 'click' && typeof listener === 'function') this.onclick = listener;
      if (type === 'show' && typeof listener === 'function') this.onshow = listener;
      if (type === 'error' && typeof listener === 'function') this.onerror = listener;
      if (type === 'close' && typeof listener === 'function') this.onclose = listener;
    }
    removeEventListener() {}
    dispatchEvent() { return false; }
    static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
    static get maxActions() { return 0; }
  }

  try {
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: BridgedNotification,
    });
  } catch (_) {
    window.Notification = BridgedNotification;
  }
})();`,
    true,
  )
} catch (err) {
  console.warn('[preload] Notification bridge failed', err)
}
