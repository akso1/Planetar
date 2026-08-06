export {}

export type MainErrorPayload = {
  title: string
  summary: string
  detail: string
  stack?: string
}

export type ElectronAPI = {
  /** Node process.platform from preload ('darwin' | 'win32' | 'linux' | …) */
  platform?: NodeJS.Platform
  openExternal: (
    url: string,
  ) => Promise<{ ok: boolean; reason?: string } | void>
  ssoLogin: (ssoUrl: string, redirectUrlPrefix: string) => Promise<string>
  searchGifs?: (query: string) => Promise<unknown>
  showNotification?: (payload: {
    title: string
    body: string
    roomId: string
    eventId?: string
  }) => Promise<{ ok: boolean; reason?: string } | void>
  /** Fire-and-forget native Electron Notification in main process */
  showNativeNotification?: (payload: {
    title: string
    body: string
    roomId: string
    eventId?: string
  }) => void
  setDockBadge?: (count: number) => Promise<void>
  isWindowFocused?: () => Promise<boolean>
  getPlatform?: () => Promise<NodeJS.Platform>
  getAppVersion?: () => Promise<string>
  checkForUpdates?: () => Promise<{
    ok: boolean
    status: 'up-to-date' | 'update-available' | 'no-release' | 'error'
    currentVersion: string
    latestVersion?: string
    releaseUrl: string
    downloadUrl?: string
    releaseName?: string
    message?: string
  }>
  windowMinimize?: () => Promise<{ ok: boolean }>
  windowMaximizeToggle?: () => Promise<{ ok: boolean; maximized: boolean }>
  windowClose?: () => Promise<{ ok: boolean }>
  windowIsMaximized?: () => Promise<boolean>
  onWindowMaximized?: (handler: (maximized: boolean) => void) => () => void
  setMinimizeToTray?: (enabled: boolean) => Promise<{ ok: boolean }>
  getMinimizeToTray?: () => Promise<boolean>
  showAppWindow?: () => Promise<{ ok: boolean }>
  setWindowAppearance?: (
    mode: 'light' | 'dark',
    backgroundColor?: string,
  ) => Promise<{ ok: boolean }>
  /** macOS only — enable/disable native under-window vibrancy */
  setVibrancy?: (
    enabled: boolean,
  ) => Promise<{ ok: boolean; enabled?: boolean }>
  saveTextFile?: (opts: {
    defaultPath: string
    content: string
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  getSessionCredentials?: () => Promise<{
    baseUrl: string
    userId: string
    accessToken: string
    deviceId?: string
  } | null>
  setSessionCredentials?: (creds: {
    baseUrl: string
    userId: string
    accessToken: string
    deviceId?: string
  }) => Promise<{ ok: boolean; reason?: string }>
  clearSessionCredentials?: () => Promise<void>
  getSecretStorageKey?: (opts: {
    userId: string
    deviceId: string
  }) => Promise<{
    userId: string
    deviceId: string
    keyId: string
    privateKeyBase64: string
  } | null>
  setSecretStorageKey?: (payload: {
    userId: string
    deviceId: string
    keyId: string
    privateKeyBase64: string
  }) => Promise<{ ok: boolean; reason?: string }>
  clearSecretStorageKey?: (opts?: {
    userId?: string
    deviceId?: string
  }) => Promise<void>
  onMainError?: (handler: (payload: MainErrorPayload) => void) => () => void
  onNotificationClicked?: (
    handler: (payload: { roomId: string; eventId?: string }) => void,
  ) => () => void
  /** Open Element Call in a separate BrowserWindow */
  openElementCall?: (
    url: string,
  ) => Promise<{ ok: boolean; reason?: string }>
  elementCallIsOpen?: () => Promise<boolean>
  clearElementCallSession?: () => Promise<{ ok: boolean; reason?: string }>
  onElementCallClosed?: (handler: () => void) => () => void
  /** Soft haptic feedback for swipe-to-reply (best-effort). */
  performHaptic?: () => Promise<{ ok: boolean } | void>
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
