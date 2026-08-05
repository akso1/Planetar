import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  dialog,
  session,
} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchGifsMain } from './gifSearch'
import {
  clearSessionCredentials,
  readSessionCredentials,
  writeSessionCredentials,
  type StoredSessionCredentials,
} from './sessionStore'
import {
  clearAllSecretStorageKeys,
  clearSecretStorageKey,
  readSecretStorageKey,
  writeSecretStorageKey,
  type StoredSecretStorageKey,
} from './secretStorageKeyStore'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
const APP_DISPLAY_NAME = 'Planetar'
/** Matches package.json build.appId — only for packaged builds (Windows toasts). */
const APP_USER_MODEL_ID = 'app.planetar.desktop'

// Name menu bar / About before windows are created.
app.setName(APP_DISPLAY_NAME)
// Dev (unpackaged) Electron must keep default ID (com.github.Electron on macOS);
// overriding it makes Notification Center drop banners.
if (app.isPackaged) {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

// Tray hide-on-close keeps the process alive. A second `npm run electron`
// would fight for the same persist-partition IndexedDB (LevelDB LOCK).
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
}

let mainWindow: BrowserWindow | null = null
let elementCallWindow: BrowserWindow | null = null
let creatingWindow = false
let tray: Tray | null = null
/** When true, red X hides to tray instead of quitting. */
let minimizeToTray = true
/** True only when user chose Quit from tray / Cmd+Q path that should exit. */
let isQuitting = false

function broadcastMainError(error: unknown, kind: 'exception' | 'rejection') {
  const err = error instanceof Error ? error : new Error(String(error))
  const payload = {
    title:
      kind === 'rejection'
        ? 'Сбой фоновой задачи (main)'
        : 'Сбой системного процесса',
    summary:
      'Ошибка в Electron main process. Окно приложения постарались сохранить.',
    detail: err.message,
    stack: err.stack,
  }
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('main-error', payload)
        } catch (sendErr) {
          console.error('[main-error] IPC send failed', sendErr)
        }
      }
    }
  } catch (err2) {
    console.error('[main-error] broadcast failed', err2)
  }
}

/**
 * Crash-proof main: never let uncaught errors kill the process silently.
 * Surfaces them to renderer → Settings → Errors UI via IPC.
 * Registered ASAP (not only after app.whenReady).
 */
function installMainProcessCrashGuards() {
  process.on('uncaughtException', (error) => {
    console.error('[main uncaughtException]', error)
    broadcastMainError(error, 'exception')
    // Do NOT process.exit — keep tray / windows alive
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[main unhandledRejection]', reason)
    broadcastMainError(reason, 'rejection')
  })
}

installMainProcessCrashGuards()

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function resolveAsset(...parts: string[]) {
  return path.join(__dirname, ...parts)
}

function loadAppIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined {
  const iconPath = resolveAsset('icon.png')
  const image = nativeImage.createFromPath(iconPath)
  return image.isEmpty() ? undefined : image
}

/**
 * Allow only https: and mailto: for OS-level opens.
 * Blocks file: / javascript: / data: / custom schemes (OS handler abuse, local file exfil).
 */
function sanitizeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  // Attack: https://user:pass@host leaks credentials into handlers/logs
  if (parsed.username || parsed.password) return null

  if (parsed.protocol === 'https:') {
    return parsed.toString()
  }
  if (parsed.protocol === 'mailto:') {
    return parsed.toString()
  }
  return null
}

async function openExternalSafe(
  raw: unknown,
): Promise<{ ok: boolean; reason?: string }> {
  const safe = sanitizeExternalUrl(raw)
  if (!safe) {
    console.warn('[openExternal] blocked unsafe URL:', raw)
    return { ok: false, reason: 'blocked-url' }
  }
  try {
    await shell.openExternal(safe)
    return { ok: true }
  } catch (err) {
    console.warn('[openExternal] failed:', err)
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'open-failed',
    }
  }
}

/**
 * Main BrowserWindow may only navigate inside the app shell.
 * Attack prevented: navigate/open to https://evil.com while keeping privileged preload → token theft via electronAPI.
 */
function isAllowedMainWindowNavigation(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  if (VITE_DEV_SERVER_URL) {
    try {
      const dev = new URL(VITE_DEV_SERVER_URL)
      return parsed.origin === dev.origin
    } catch {
      return false
    }
  }

  // Production: only file: under the packaged app directory (never arbitrary file://)
  if (parsed.protocol !== 'file:') return false
  try {
    const appRoot = path.resolve(path.join(__dirname, '..'))
    const target = path.resolve(fileURLToPath(parsed.href))
    return target === appRoot || target.startsWith(appRoot + path.sep)
  } catch {
    return false
  }
}

function wireMainWindowIsolation(win: BrowserWindow) {
  // Attack: window.open('https://attacker') inherits privileged preload → IPC session-get
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedMainWindowNavigation(url)) return
    event.preventDefault()
    void openExternalSafe(url)
  })

  win.webContents.on('will-redirect', (event, url) => {
    if (isAllowedMainWindowNavigation(url)) return
    event.preventDefault()
    void openExternalSafe(url)
  })
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Показать',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => quitApp(),
    },
  ])
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return
  // Prefer @2x template when present (Retina menu bar).
  const candidates = ['trayTemplate@2x.png', 'trayTemplate.png']
  let image = nativeImage.createEmpty()
  for (const name of candidates) {
    const iconPath = resolveAsset(name)
    image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) break
  }
  if (image.isEmpty()) {
    // Fallback 16x16 black square so tray still appears
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6aAAAAAElFTkSuQmCC',
    )
  }
  if (process.platform === 'darwin') {
    // macOS menu bar expects a template (black + alpha); system tints it.
    image.setTemplateImage(true)
  }
  tray = new Tray(image)
  tray.setToolTip(APP_DISPLAY_NAME)
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => showMainWindow())
  tray.on('double-click', () => showMainWindow())
}

function createWindow() {
  if (creatingWindow) return
  creatingWindow = true
  try {
    const appIcon = loadAppIcon()
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      frame: false,
      ...(process.platform === 'darwin'
        ? {
            titleBarStyle: 'hidden' as const,
            trafficLightPosition: { x: 16, y: 16 },
            // Required for setVibrancy / under-window glass to composite
            transparent: true,
            backgroundColor: '#00000000',
            visualEffectState: 'active' as const,
          }
        : {
            // Opaque chrome for Win/Linux frameless + custom TitleBar controls
            backgroundColor: '#070b14',
            autoHideMenuBar: true,
          }),
      ...(appIcon ? { icon: appIcon } : {}),
      webPreferences: {
        // Built as preload.cjs — required when package.json has "type": "module"
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Persist localStorage / IndexedDB across restarts
        partition: 'persist:matrix-macos-client',
      },
    })

    if (process.platform === 'darwin' && appIcon && app.dock) {
      app.dock.setIcon(appIcon)
    }

    mainWindow.setTitle(APP_DISPLAY_NAME)
    wireMainWindowIsolation(mainWindow)

    // Win/Linux frameless: keep renderer caption buttons in sync
    const sendMaximized = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('window-maximized', mainWindow.isMaximized())
    }
    mainWindow.on('maximize', sendMaximized)
    mainWindow.on('unmaximize', sendMaximized)

    if (VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(VITE_DEV_SERVER_URL)
      mainWindow.webContents.openDevTools()
    } else {
      mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    }

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      broadcastMainError(
        new Error(`Renderer crashed: ${details.reason} (exit ${details.exitCode})`),
        'exception',
      )
      // Recreate UI instead of leaving a dead shell
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy()
      }
      mainWindow = null
    })

    mainWindow.on('close', (event) => {
      if (!isQuitting && minimizeToTray) {
        event.preventDefault()
        mainWindow?.hide()
        ensureTray()
      }
    })

    mainWindow.on('closed', () => {
      mainWindow = null
    })
  } finally {
    creatingWindow = false
  }
}

/** Extract loginToken from an SSO redirect URL */
function extractLoginToken(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.searchParams.get('loginToken')
  } catch {
    const match = url.match(/[?&]loginToken=([^&]+)/)
    return match ? decodeURIComponent(match[1]) : null
  }
}

ipcMain.handle('session-get', () => {
  return readSessionCredentials()
})

ipcMain.handle(
  'session-set',
  (_event, creds: StoredSessionCredentials) => {
    if (
      !creds ||
      typeof creds.baseUrl !== 'string' ||
      typeof creds.userId !== 'string' ||
      typeof creds.accessToken !== 'string' ||
      typeof creds.deviceId !== 'string'
    ) {
      return { ok: false as const, reason: 'invalid-credentials' }
    }
    // Attack: store file:// or javascript: as "homeserver" for later SSRF-ish misuse
    try {
      const hs = new URL(creds.baseUrl)
      if (hs.protocol !== 'https:' && hs.protocol !== 'http:') {
        return { ok: false as const, reason: 'invalid-baseUrl' }
      }
    } catch {
      return { ok: false as const, reason: 'invalid-baseUrl' }
    }
    return writeSessionCredentials(creds)
  },
)

ipcMain.handle('session-clear', () => {
  clearSessionCredentials()
  clearAllSecretStorageKeys()
})

ipcMain.handle(
  'secret-storage-key-get',
  (_event, opts: { userId?: string; deviceId?: string }) => {
    if (
      !opts ||
      typeof opts.userId !== 'string' ||
      typeof opts.deviceId !== 'string'
    ) {
      return null
    }
    return readSecretStorageKey(opts.userId, opts.deviceId)
  },
)

ipcMain.handle(
  'secret-storage-key-set',
  (_event, payload: StoredSecretStorageKey) => {
    return writeSecretStorageKey(payload)
  },
)

ipcMain.handle(
  'secret-storage-key-clear',
  (_event, opts: { userId?: string; deviceId?: string }) => {
    if (
      opts &&
      typeof opts.userId === 'string' &&
      typeof opts.deviceId === 'string'
    ) {
      clearSecretStorageKey(opts.userId, opts.deviceId)
      return
    }
    clearAllSecretStorageKeys()
  },
)

ipcMain.handle('open-external', async (_event, url: unknown) => {
  // Attack: renderer passes file:/// or myapp:// → OS opens arbitrary handlers
  return openExternalSafe(url)
})

ipcMain.handle('open-element-call', async (_event, url: string) => {
  if (typeof url !== 'string') {
    return { ok: false as const, reason: 'Некорректный URL Element Call' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false as const, reason: 'Некорректный URL Element Call' }
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'call.element.io') {
    return { ok: false as const, reason: 'Некорректный URL Element Call' }
  }
  const safeUrl = parsed.toString()

  const isAllowedElementCallUrl = (next: string) => {
    try {
      const u = new URL(next)
      return u.protocol === 'https:' && u.hostname === 'call.element.io'
    } catch {
      return false
    }
  }

  const wireElementCallNavigation = (win: BrowserWindow) => {
    win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (isAllowedElementCallUrl(openUrl)) {
        return { action: 'allow' }
      }
      // Attack: EC page opens evil:// or file: via window.open — validate before OS
      void openExternalSafe(openUrl)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, nextUrl) => {
      if (!isAllowedElementCallUrl(nextUrl)) {
        event.preventDefault()
        void openExternalSafe(nextUrl)
      }
    })
  }

  const notifyClosed = () => {
    elementCallWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('element-call-closed')
    }
  }

  try {
    const appIcon = loadAppIcon()
    if (elementCallWindow && !elementCallWindow.isDestroyed()) {
      wireElementCallNavigation(elementCallWindow)
      elementCallWindow.focus()
      await elementCallWindow.loadURL(safeUrl)
      return { ok: true as const }
    }
    elementCallWindow = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      title: `${APP_DISPLAY_NAME} Call`,
      backgroundColor: '#0b141a',
      ...(appIcon ? { icon: appIcon } : {}),
      parent: mainWindow ?? undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:planetar-element-call',
      },
    })
    elementCallWindow.setTitle(`${APP_DISPLAY_NAME} Call`)
    wireElementCallNavigation(elementCallWindow)
    elementCallWindow.on('closed', notifyClosed)
    await elementCallWindow.loadURL(safeUrl)
    return { ok: true as const }
  } catch (err) {
    console.error('[element-call] open failed', err)
    return {
      ok: false as const,
      reason:
        err instanceof Error
          ? err.message
          : 'Не удалось открыть окно Element Call',
    }
  }
})

ipcMain.handle('element-call-is-open', () => {
  return !!(elementCallWindow && !elementCallWindow.isDestroyed())
})

ipcMain.handle('clear-element-call-session', async () => {
  try {
    if (elementCallWindow && !elementCallWindow.isDestroyed()) {
      elementCallWindow.close()
    }
    elementCallWindow = null
    const ses = session.fromPartition('persist:planetar-element-call')
    await ses.clearStorageData()
    await ses.clearCache()
    return { ok: true as const }
  } catch (err) {
    console.warn('[element-call] clear session failed', err)
    return {
      ok: false as const,
      reason: err instanceof Error ? err.message : 'clear failed',
    }
  }
})

ipcMain.handle(
  'save-text-file',
  async (
    _event,
    opts: { defaultPath?: string; content?: string },
  ): Promise<{ ok: boolean; path?: string; canceled?: boolean }> => {
    const content = typeof opts?.content === 'string' ? opts.content : ''
    const defaultPath =
      typeof opts?.defaultPath === 'string' && opts.defaultPath.trim()
        ? opts.defaultPath.trim()
        : `matrix-error-report-${Date.now()}.txt`

    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: 'Сохранить отчёт',
      defaultPath,
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true }
    }

    await fs.writeFile(result.filePath, content, 'utf8')
    return { ok: true, path: result.filePath }
  },
)

ipcMain.handle('search-gifs', async (_event, query: string) => {
  return searchGifsMain(typeof query === 'string' ? query : '')
})

ipcMain.handle('set-dock-badge', (_event, count: number | string) => {
  if (process.platform !== 'darwin' || !app.dock) return
  const n = typeof count === 'number' ? count : Number(count)
  if (!Number.isFinite(n) || n <= 0) {
    app.dock.setBadge('')
    return
  }
  app.dock.setBadge(n > 99 ? '99+' : String(Math.floor(n)))
})

ipcMain.handle('is-window-focused', () => {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()
})

ipcMain.handle('get-platform', () => process.platform)

/** Soft haptic ping for gesture feedback (best-effort; no-op if unsupported). */
ipcMain.handle('perform-haptic', () => {
  try {
    // Electron has no Force Touch API on macOS; acknowledge for future / OS hooks.
    return { ok: true as const }
  } catch {
    return { ok: false as const }
  }
})

ipcMain.handle('window-minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false as const }
  mainWindow.minimize()
  return { ok: true as const }
})

ipcMain.handle('window-maximize-toggle', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false as const, maximized: false }
  }
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
  return { ok: true as const, maximized: mainWindow.isMaximized() }
})

ipcMain.handle('window-close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false as const }
  mainWindow.close()
  return { ok: true as const }
})

ipcMain.handle('window-is-maximized', () => {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()
})

ipcMain.handle('set-minimize-to-tray', (_event, enabled: boolean) => {
  minimizeToTray = !!enabled
  if (minimizeToTray) ensureTray()
  return { ok: true as const }
})

ipcMain.handle('get-minimize-to-tray', () => minimizeToTray)

ipcMain.handle('show-app-window', () => {
  showMainWindow()
  return { ok: true as const }
})

/** Last theme chrome — kept so vibrancy toggle can restore a solid bg. */
let windowAppearanceMode: 'light' | 'dark' = 'dark'
let windowAppearanceBg: string | null = null
let windowVibrancyEnabled = false

function solidAppearanceBackground(): string {
  if (windowAppearanceBg) return windowAppearanceBg
  return windowAppearanceMode === 'light' ? '#eef1f5' : '#09090b'
}

function applyNativeWindowChrome() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const light = windowAppearanceMode === 'light'
  const solid = solidAppearanceBackground()
  if (process.platform === 'darwin') {
    if (windowVibrancyEnabled) {
      // under-window = blur desktop behind the app
      mainWindow.setVibrancy('under-window')
      mainWindow.setBackgroundColor('#00000000')
    } else {
      mainWindow.setVibrancy(null)
      // Solid fill behind opaque CSS when glass is off (window stays transparent:true)
      mainWindow.setBackgroundColor(solid)
    }
  } else {
    mainWindow.setBackgroundColor(
      light ? solid : windowAppearanceBg ?? '#070b14',
    )
  }
}

ipcMain.handle(
  'set-window-appearance',
  (_event, mode: 'light' | 'dark', backgroundColor?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false as const }
    windowAppearanceMode = mode === 'light' ? 'light' : 'dark'
    windowAppearanceBg =
      typeof backgroundColor === 'string' &&
      /^#[0-9a-fA-F]{6}$/.test(backgroundColor)
        ? backgroundColor
        : null
    try {
      applyNativeWindowChrome()
    } catch (err) {
      console.warn('[set-window-appearance]', err)
      return { ok: false as const }
    }
    return { ok: true as const }
  },
)

ipcMain.handle('set-vibrancy', (_event, enabled: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false as const }
  windowVibrancyEnabled = !!enabled
  if (process.platform !== 'darwin') {
    windowVibrancyEnabled = false
  }
  try {
    applyNativeWindowChrome()
  } catch (err) {
    console.warn('[set-vibrancy]', err)
    return { ok: false as const }
  }
  return { ok: true as const, enabled: windowVibrancyEnabled }
})

type NotifPayload = {
  title?: string
  body?: string
  roomId?: string
  eventId?: string
}

/**
 * Retain Notification instances until dismissed — otherwise V8 GC can collect
 * them before the OS banner appears (dock badge still works independently).
 */
const activeNotifications = new Set<InstanceType<typeof Notification>>()

function sanitizeNotifPayload(raw: unknown): {
  title: string
  body: string
  roomId?: string
  eventId?: string
} {
  const payload =
    raw && typeof raw === 'object' ? (raw as NotifPayload) : ({} as NotifPayload)
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim().slice(0, 120)
      : 'Новое сообщение'
  const body =
    typeof payload.body === 'string' ? payload.body.slice(0, 240) : ''
  const roomId =
    typeof payload.roomId === 'string' && payload.roomId.length < 256
      ? payload.roomId
      : undefined
  const eventId =
    typeof payload.eventId === 'string' && payload.eventId.length < 256
      ? payload.eventId
      : undefined
  return { title, body, roomId, eventId }
}

function showNativeOsNotification(raw: unknown): {
  ok: boolean
  reason?: string
} {
  if (!Notification.isSupported()) {
    return { ok: false, reason: 'unsupported' }
  }

  const { title, body, roomId, eventId } = sanitizeNotifPayload(raw)

  try {
    const icon = loadAppIcon()
    const notif = new Notification({
      title,
      body,
      silent: false,
      // On macOS the dock/app icon is already on the left; passing `icon`
      // duplicates it as the right-hand content image.
      ...(process.platform !== 'darwin' && icon && !icon.isEmpty()
        ? { icon }
        : {}),
    })

    activeNotifications.add(notif)
    const release = () => {
      activeNotifications.delete(notif)
    }

    notif.on('close', release)
    notif.on('failed', release)
    notif.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
          if (roomId) {
            mainWindow.webContents.send('notification-clicked', {
              roomId,
              eventId,
            })
          }
        }
      } finally {
        release()
      }
    })

    notif.show()
    if (process.platform === 'darwin' && app.dock) {
      app.dock.bounce('informational')
    }
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

ipcMain.handle('show-notification', (_event, payload: NotifPayload) => {
  const result = showNativeOsNotification(payload)
  return result.ok
    ? ({ ok: true as const })
    : ({ ok: false as const, reason: result.reason })
})

/** Fire-and-forget native banners (preferred from renderer). */
ipcMain.on('show-native-notification', (_event, data: unknown) => {
  showNativeOsNotification(data)
})

/**
 * Open SSO in a controlled BrowserWindow and resolve with loginToken
 * when the homeserver redirects back to redirectUrlPrefix.
 */
ipcMain.handle(
  'sso-login',
  async (_event, ssoUrl: string, redirectUrlPrefix: string) => {
    return new Promise<string>((resolve, reject) => {
      const authWin = new BrowserWindow({
        width: 560,
        height: 720,
        parent: mainWindow ?? undefined,
        modal: false,
        show: true,
        title: 'Sign in',
        backgroundColor: '#0e1621',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })

      let settled = false

      const finish = (token: string | null, error?: Error) => {
        if (settled) return
        settled = true
        if (!authWin.isDestroyed()) authWin.close()
        if (token) resolve(token)
        else reject(error ?? new Error('SSO cancelled'))
      }

      const tryCapture = (navUrl: string): boolean => {
        if (
          redirectUrlPrefix &&
          !navUrl.startsWith(redirectUrlPrefix) &&
          !navUrl.includes('loginToken=')
        ) {
          return false
        }
        const token = extractLoginToken(navUrl)
        if (token) {
          finish(token)
          return true
        }
        return false
      }

      authWin.webContents.on('will-redirect', (event, url) => {
        if (tryCapture(url)) event.preventDefault()
      })

      authWin.webContents.on('will-navigate', (event, url) => {
        if (tryCapture(url)) event.preventDefault()
      })

      authWin.webContents.on('did-navigate', (_event, url) => {
        tryCapture(url)
      })

      authWin.on('closed', () => {
        if (!settled) finish(null, new Error('SSO window closed'))
      })

      authWin.loadURL(ssoUrl).catch((err) => {
        finish(null, err instanceof Error ? err : new Error(String(err)))
      })
    })
  },
)

app.whenReady().then(() => {
  if (app.isPackaged) {
    app.setAppUserModelId(APP_USER_MODEL_ID)
  }

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: APP_DISPLAY_NAME,
      applicationVersion: app.getVersion(),
    })
  }

  const allowAppPermission = (permission: string) =>
    permission === 'media' ||
    permission === 'mediaKeySystem' ||
    permission === 'display-capture' ||
    // Frameless copy / context-menu paste support
    permission === 'clipboard-sanitized-write' ||
    permission === 'clipboard-read'

  const isAppOrigin = (rawUrl: string) => {
    try {
      const u = new URL(rawUrl)
      if (u.protocol === 'file:') return true
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
      return false
    } catch {
      return false
    }
  }

  const isElementCallOrigin = (rawUrl: string) => {
    try {
      const u = new URL(rawUrl)
      return u.protocol === 'https:' && u.hostname === 'call.element.io'
    } catch {
      return false
    }
  }

  const wireMediaPermissions = (
    ses: Electron.Session,
    kind: 'app' | 'element-call',
  ) => {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      // Do not special-case notifications here — OS / UNNotification
      // authorization is handled when main shows native Notification.
      if (!allowAppPermission(permission)) {
        callback(false)
        return
      }
      const requesting =
        (details && 'requestingUrl' in details
          ? String((details as { requestingUrl?: string }).requestingUrl || '')
          : '') || wc.getURL()
      const ok =
        kind === 'element-call'
          ? isElementCallOrigin(requesting)
          : isAppOrigin(requesting)
      callback(ok)
    })
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (!allowAppPermission(permission)) return false
      if (kind === 'element-call') {
        return isElementCallOrigin(requestingOrigin || '')
      }
      return isAppOrigin(requestingOrigin || '')
    })
  }

  wireMediaPermissions(session.defaultSession, 'app')
  try {
    wireMediaPermissions(
      session.fromPartition('persist:matrix-macos-client'),
      'app',
    )
    wireMediaPermissions(
      session.fromPartition('persist:planetar-element-call'),
      'element-call',
    )
  } catch (err) {
    console.warn('[permissions] partition setup failed', err)
  }

  createWindow()
  ensureTray()

  // Second launch (dev restart / double-click): focus the living tray instance.
  app.on('second-instance', () => {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // With tray, the process stays alive on all platforms until Quit.
  if (!minimizeToTray && process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else {
    showMainWindow()
  }
})
