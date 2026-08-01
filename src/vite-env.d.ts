export {}

export type MainErrorPayload = {
  title: string
  summary: string
  detail: string
  stack?: string
}

export type ElectronAPI = {
  openExternal: (url: string) => Promise<void>
  ssoLogin: (ssoUrl: string, redirectUrlPrefix: string) => Promise<string>
  searchGifs?: (query: string) => Promise<unknown>
  showNotification?: (payload: {
    title: string
    body: string
    roomId: string
    eventId?: string
  }) => Promise<{ ok: boolean } | void>
  setDockBadge?: (count: number) => Promise<void>
  isWindowFocused?: () => Promise<boolean>
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
  onMainError?: (handler: (payload: MainErrorPayload) => void) => () => void
  onNotificationClicked?: (
    handler: (payload: { roomId: string; eventId?: string }) => void,
  ) => () => void
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
