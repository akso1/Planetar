import {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  shell,
  dialog,
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

let mainWindow: BrowserWindow | null = null
let creatingWindow = false

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
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('main-error', payload)
    }
  }
}

function createWindow() {
  if (creatingWindow) return
  creatingWindow = true
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      frame: false,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 16 },
      vibrancy: 'under-window',
      backgroundColor: '#00000000',
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
      typeof creds.accessToken !== 'string'
    ) {
      return { ok: false as const, reason: 'invalid-credentials' }
    }
    return writeSessionCredentials(creds)
  },
)

ipcMain.handle('session-clear', () => {
  clearSessionCredentials()
})

ipcMain.handle('open-external', async (_event, url: string) => {
  await shell.openExternal(url)
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

type NotifPayload = {
  title?: string
  body?: string
  roomId?: string
  eventId?: string
}

ipcMain.handle('show-notification', (_event, payload: NotifPayload) => {
  if (!Notification.isSupported()) {
    console.warn('[notifications] Notification.isSupported() === false')
    return { ok: false as const, reason: 'unsupported' }
  }

  const title =
    typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Новое сообщение'
  const body =
    typeof payload?.body === 'string' ? payload.body.slice(0, 240) : ''
  const roomId =
    typeof payload?.roomId === 'string' ? payload.roomId : undefined
  const eventId =
    typeof payload?.eventId === 'string' ? payload.eventId : undefined

  try {
    const notif = new Notification({
      title,
      body,
      silent: false,
    })

    notif.on('show', () => {
      console.info('[notifications] shown:', title)
    })
    notif.on('failed', (_e, err) => {
      console.warn('[notifications] failed:', err)
    })

    notif.on('click', () => {
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
    })

    notif.show()
    if (process.platform === 'darwin' && app.dock) {
      app.dock.bounce('informational')
    }
    return { ok: true as const }
  } catch (err) {
    console.warn('[notifications] throw:', err)
    return {
      ok: false as const,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
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
  createWindow()

  // Keep main alive; surface errors to the renderer error log
  process.on('uncaughtException', (error) => {
    console.error('[main uncaughtException]', error)
    broadcastMainError(error, 'exception')
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[main unhandledRejection]', reason)
    broadcastMainError(reason, 'rejection')
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  }
})
