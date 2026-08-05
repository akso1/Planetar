import { create } from 'zustand'
import {
  ClientEvent,
  EventType,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import {
  listMutedRoomIdsFromPushRules,
  setRoomMutedOnServer,
} from '@/shared/lib/roomMute'

export const NOTIF_ENABLED_KEY = 'matrix-macos-notifications-enabled'
export const NOTIF_MUTED_ROOMS_KEY = 'matrix-macos-muted-rooms'
export const NOTIF_MINIMIZE_TO_TRAY_KEY = 'matrix-macos-minimize-to-tray'

function readEnabled(): boolean {
  try {
    const v = localStorage.getItem(NOTIF_ENABLED_KEY)
    if (v === '0' || v === 'false') return false
    if (v === '1' || v === 'true') return true
  } catch {
    /* ignore */
  }
  return true
}

function readMinimizeToTray(): boolean {
  try {
    const v = localStorage.getItem(NOTIF_MINIMIZE_TO_TRAY_KEY)
    if (v === '0' || v === 'false') return false
    if (v === '1' || v === 'true') return true
  } catch {
    /* ignore */
  }
  return true
}

function persistMinimizeToTray(enabled: boolean) {
  try {
    localStorage.setItem(NOTIF_MINIMIZE_TO_TRAY_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
  void window.electronAPI?.setMinimizeToTray?.(enabled)
}

function readMutedIds(): string[] {
  try {
    const raw = localStorage.getItem(NOTIF_MUTED_ROOMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string')
    }
  } catch {
    /* ignore */
  }
  return []
}

function persistEnabled(enabled: boolean) {
  try {
    localStorage.setItem(NOTIF_ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
}

function persistMutedIds(ids: string[]) {
  try {
    localStorage.setItem(NOTIF_MUTED_ROOMS_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

type NotificationPrefsState = {
  enabled: boolean
  minimizeToTray: boolean
  mutedRoomIds: string[]
  hydrate: () => void
  /** Sync mute list from Matrix push rules; migrate local-only mutes once. */
  syncFromClient: (client: MatrixClient) => Promise<void>
  bindPushRulesListener: (client: MatrixClient) => () => void
  setEnabled: (enabled: boolean) => void
  setMinimizeToTray: (enabled: boolean) => void
  muteRoom: (roomId: string, client?: MatrixClient | null) => Promise<void>
  unmuteRoom: (roomId: string, client?: MatrixClient | null) => Promise<void>
  toggleMuteRoom: (roomId: string, client?: MatrixClient | null) => Promise<void>
  isMuted: (roomId: string) => boolean
  pruneMutedIds: (leftRoomIds: string[]) => void
}

let migratingLocal = false

export const useNotificationPrefsStore = create<NotificationPrefsState>(
  (set, get) => ({
    enabled: true,
    minimizeToTray: true,
    mutedRoomIds: [],

    hydrate: () => {
      const minimizeToTray = readMinimizeToTray()
      set({
        enabled: readEnabled(),
        minimizeToTray,
        mutedRoomIds: readMutedIds(),
      })
      void window.electronAPI?.setMinimizeToTray?.(minimizeToTray)
    },

    syncFromClient: async (client) => {
      let serverIds: string[] = []
      try {
        if (!client.pushRules) {
          client.pushRules = await client.getPushRules()
        }
        serverIds = listMutedRoomIdsFromPushRules(client)
      } catch (err) {
        console.error('Failed to read push rules for mute sync', err)
        return
      }

      // One-shot migration: local-only mutes → Matrix push rules
      const localIds = readMutedIds()
      const missing = localIds.filter((id) => !serverIds.includes(id))
      if (missing.length > 0 && !migratingLocal) {
        migratingLocal = true
        try {
          for (const roomId of missing) {
            try {
              await setRoomMutedOnServer(client, roomId, true)
            } catch (err) {
              console.error('Failed to migrate local mute to push rules', roomId, err)
            }
          }
          serverIds = listMutedRoomIdsFromPushRules(client)
        } finally {
          migratingLocal = false
        }
      }

      persistMutedIds(serverIds)
      set({ mutedRoomIds: serverIds })
    },

    bindPushRulesListener: (client) => {
      const onAccountData = (event: MatrixEvent) => {
        if (event.getType() !== EventType.PushRules) return
        try {
          const ids = listMutedRoomIdsFromPushRules(client)
          persistMutedIds(ids)
          set({ mutedRoomIds: ids })
        } catch {
          /* ignore */
        }
      }
      client.on(ClientEvent.AccountData, onAccountData)
      return () => {
        client.removeListener(ClientEvent.AccountData, onAccountData)
      }
    },

    muteRoom: async (roomId, client) => {
      const prev = get().mutedRoomIds
      if (!prev.includes(roomId)) {
        const next = [...prev, roomId]
        persistMutedIds(next)
        set({ mutedRoomIds: next })
      }
      pushBreadcrumb('mute_room', { roomId })
      if (!client) return
      try {
        await setRoomMutedOnServer(client, roomId, true)
        const ids = listMutedRoomIdsFromPushRules(client)
        persistMutedIds(ids)
        set({ mutedRoomIds: ids })
      } catch (err) {
        console.error('Failed to mute room on server', err)
        // Keep optimistic local mute so desktop notifications still respect it.
      }
    },

    unmuteRoom: async (roomId, client) => {
      const next = get().mutedRoomIds.filter((id) => id !== roomId)
      if (next.length !== get().mutedRoomIds.length) {
        persistMutedIds(next)
        set({ mutedRoomIds: next })
      }
      pushBreadcrumb('unmute_room', { roomId })
      if (!client) return
      try {
        await setRoomMutedOnServer(client, roomId, false)
        const ids = listMutedRoomIdsFromPushRules(client)
        persistMutedIds(ids)
        set({ mutedRoomIds: ids })
      } catch (err) {
        console.error('Failed to unmute room on server', err)
      }
    },

    toggleMuteRoom: async (roomId, client) => {
      if (get().mutedRoomIds.includes(roomId)) {
        await get().unmuteRoom(roomId, client)
      } else {
        await get().muteRoom(roomId, client)
      }
    },

    isMuted: (roomId) => get().mutedRoomIds.includes(roomId),

    pruneMutedIds: (leftRoomIds) => {
      if (leftRoomIds.length === 0) return
      const left = new Set(leftRoomIds)
      const prev = get().mutedRoomIds
      const next = prev.filter((id) => !left.has(id))
      if (next.length === prev.length) return
      persistMutedIds(next)
      set({ mutedRoomIds: next })
    },

    setEnabled: (enabled) => {
      persistEnabled(enabled)
      set({ enabled })
      pushBreadcrumb('notifications_toggle', { enabled })
    },

    setMinimizeToTray: (enabled) => {
      persistMinimizeToTray(enabled)
      set({ minimizeToTray: enabled })
      pushBreadcrumb('minimize_to_tray', { enabled })
    },
  }),
)

/** Imperative helpers for non-React notification path */
export function areNotificationsEnabled(): boolean {
  return useNotificationPrefsStore.getState().enabled
}

export function isRoomMuted(roomId: string): boolean {
  return useNotificationPrefsStore.getState().mutedRoomIds.includes(roomId)
}
