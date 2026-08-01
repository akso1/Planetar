import { create } from 'zustand'
import { matrixService, SSO_REDIRECT_URL, normalizeHomeserverUrl } from "@/shared/api/MatrixService";
import { MatrixClient, SyncState } from 'matrix-js-sdk'
import { useRoomStore } from './room.store'
import { useInvitesStore } from './invites.store'

function bindClientSession(client: MatrixClient, set: (partial: Partial<SessionState>) => void) {
  set({ client, isAuthenticated: true, authStatus: 'authenticated' })
  useRoomStore.getState().actions.init(client)
  useInvitesStore.getState().actions.init(client)
  matrixService.listenToSync((state) => {
    set({ syncState: state })
  })
}

export type AuthStatus = 'booting' | 'authenticated' | 'unauthenticated'

interface SessionState {
  client: MatrixClient | null
  syncState: SyncState | null
  isAuthenticated: boolean
  /** booting = restoring session from disk; avoid flashing the login screen */
  authStatus: AuthStatus
  login: (baseUrl: string, userId: string, password: string) => Promise<void>
  loginWithSsoToken: (baseUrl: string, loginToken: string) => Promise<void>
  startSsoLogin: (baseUrl: string) => Promise<void>
  logout: () => Promise<void>
  startup: () => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  client: null,
  syncState: null,
  isAuthenticated: false,
  authStatus: 'booting',

  login: async (baseUrl, userId, password) => {
    const client = await matrixService.login(baseUrl, userId, password)
    bindClientSession(client, set)
  },

  loginWithSsoToken: async (baseUrl, loginToken) => {
    const client = await matrixService.loginWithToken(baseUrl, loginToken)
    bindClientSession(client, set)
  },

  startSsoLogin: async (baseUrl) => {
    const normalized = normalizeHomeserverUrl(baseUrl)
    const flows = await matrixService.getLoginFlows(normalized)
    if (!matrixService.hasSsoFlow(flows)) {
      throw new Error('This homeserver does not support SSO login.')
    }

    const idp = matrixService.pickPreferredIdp(flows)
    const ssoUrl = matrixService.getSsoLoginUrl(normalized, idp?.id)
    matrixService.rememberSsoBaseUrl(normalized)

    if (window.electronAPI?.ssoLogin) {
      const loginToken = await window.electronAPI.ssoLogin(ssoUrl, SSO_REDIRECT_URL)
      await get().loginWithSsoToken(normalized, loginToken)
      return
    }

    if (window.electronAPI?.openExternal) {
      await window.electronAPI.openExternal(ssoUrl)
    } else {
      window.open(ssoUrl, '_blank', 'noopener,noreferrer')
    }
  },

  logout: async () => {
    useInvitesStore.getState().actions.cleanup()
    useRoomStore.getState().actions.cleanup()
    set({
      client: null,
      isAuthenticated: false,
      syncState: null,
      authStatus: 'unauthenticated',
    })
    await matrixService.logout()
  },

  startup: async () => {
    set({ authStatus: 'booting' })
    try {
      const params = new URLSearchParams(window.location.search)
      const loginToken = params.get('loginToken')
      if (loginToken) {
        const baseUrl =
          matrixService.getPendingSsoBaseUrl() || 'https://matrix.org'
        window.history.replaceState({}, '', window.location.pathname)
        const client = await matrixService.loginWithToken(baseUrl, loginToken)
        bindClientSession(client, set)
        return
      }

      const wasStarted = await matrixService.startup()
      if (wasStarted && matrixService.client) {
        bindClientSession(matrixService.client, set)
        return
      }

      set({
        client: null,
        isAuthenticated: false,
        authStatus: 'unauthenticated',
      })
    } catch (err) {
      console.error('Session restore failed:', err)
      // Keep credentials on disk — user can retry; show login if we couldn't start
      set({
        client: null,
        isAuthenticated: false,
        authStatus: 'unauthenticated',
      })
    }
  },
}))
