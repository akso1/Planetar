import { create } from 'zustand'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'

export const NOTIF_ENABLED_KEY = 'matrix-macos-notifications-enabled'
export const NOTIF_MUTED_ROOMS_KEY = 'matrix-macos-muted-rooms'

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
  mutedRoomIds: string[]
  hydrate: () => void
  setEnabled: (enabled: boolean) => void
  muteRoom: (roomId: string) => void
  unmuteRoom: (roomId: string) => void
  toggleMuteRoom: (roomId: string) => void
  isMuted: (roomId: string) => boolean
  pruneMutedIds: (leftRoomIds: string[]) => void
}

export const useNotificationPrefsStore = create<NotificationPrefsState>(
  (set, get) => ({
    enabled: true,
    mutedRoomIds: [],

    hydrate: () => {
      set({
        enabled: readEnabled(),
        mutedRoomIds: readMutedIds(),
      })
    },

    muteRoom: (roomId) => {
      const prev = get().mutedRoomIds
      if (prev.includes(roomId)) return
      const next = [...prev, roomId]
      persistMutedIds(next)
      set({ mutedRoomIds: next })
      pushBreadcrumb('mute_room', { roomId })
    },

    unmuteRoom: (roomId) => {
      const next = get().mutedRoomIds.filter((id) => id !== roomId)
      if (next.length === get().mutedRoomIds.length) return
      persistMutedIds(next)
      set({ mutedRoomIds: next })
      pushBreadcrumb('unmute_room', { roomId })
    },

    toggleMuteRoom: (roomId) => {
      if (get().mutedRoomIds.includes(roomId)) {
        get().unmuteRoom(roomId)
      } else {
        get().muteRoom(roomId)
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
  }),
)

/** Imperative helpers for non-React notification path */
export function areNotificationsEnabled(): boolean {
  return useNotificationPrefsStore.getState().enabled
}

export function isRoomMuted(roomId: string): boolean {
  return useNotificationPrefsStore.getState().mutedRoomIds.includes(roomId)
}
