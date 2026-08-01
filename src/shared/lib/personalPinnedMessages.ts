import { create } from 'zustand'

/**
 * Local "pin for myself" — not synced to the room (`m.room.pinned_events`).
 * Keyed by Matrix user id so accounts on the same device stay separate.
 */
const STORAGE_KEY = 'matrix-macos-personal-message-pins'

type PinsByRoom = Record<string, string[]>
type PinsByUser = Record<string, PinsByRoom>

function readAll(): PinsByUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as PinsByUser
  } catch {
    return {}
  }
}

function writeAll(data: PinsByUser) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.warn('Failed to persist personal pins', err)
  }
}

function normalizeIds(ids: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

type PersonalPinsState = {
  byUser: PinsByUser
  hydrated: boolean
  hydrate: () => void
  getRoomPins: (userId: string, roomId: string) => string[]
  isPinned: (userId: string, roomId: string, eventId: string) => boolean
  pin: (userId: string, roomId: string, eventId: string) => void
  unpin: (userId: string, roomId: string, eventId: string) => void
}

export const usePersonalPinnedStore = create<PersonalPinsState>((set, get) => ({
  byUser: {},
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return
    set({ byUser: readAll(), hydrated: true })
  },

  getRoomPins: (userId, roomId) => {
    if (!userId || !roomId) return []
    const room = get().byUser[userId]?.[roomId]
    return Array.isArray(room) ? normalizeIds(room) : []
  },

  isPinned: (userId, roomId, eventId) => {
    if (!eventId) return false
    return get().getRoomPins(userId, roomId).includes(eventId)
  },

  pin: (userId, roomId, eventId) => {
    if (!userId || !roomId || !eventId) return
    const byUser = { ...get().byUser }
    const byRoom: PinsByRoom = { ...(byUser[userId] || {}) }
    const prev = Array.isArray(byRoom[roomId]) ? byRoom[roomId] : []
    if (prev.includes(eventId)) return
    byRoom[roomId] = [...prev, eventId]
    byUser[userId] = byRoom
    writeAll(byUser)
    set({ byUser, hydrated: true })
  },

  unpin: (userId, roomId, eventId) => {
    if (!userId || !roomId || !eventId) return
    const byUser = { ...get().byUser }
    const byRoom: PinsByRoom = { ...(byUser[userId] || {}) }
    const prev = Array.isArray(byRoom[roomId]) ? byRoom[roomId] : []
    if (!prev.includes(eventId)) return
    const next = prev.filter((id) => id !== eventId)
    if (next.length === 0) delete byRoom[roomId]
    else byRoom[roomId] = next
    if (Object.keys(byRoom).length === 0) delete byUser[userId]
    else byUser[userId] = byRoom
    writeAll(byUser)
    set({ byUser, hydrated: true })
  },
}))

export function getPersonalPinnedIds(userId: string, roomId: string): string[] {
  usePersonalPinnedStore.getState().hydrate()
  return usePersonalPinnedStore.getState().getRoomPins(userId, roomId)
}

export function isPersonallyPinned(
  userId: string,
  roomId: string,
  eventId: string,
): boolean {
  return usePersonalPinnedStore.getState().isPinned(userId, roomId, eventId)
}

export function pinMessageForSelf(
  userId: string,
  roomId: string,
  eventId: string,
): void {
  usePersonalPinnedStore.getState().hydrate()
  usePersonalPinnedStore.getState().pin(userId, roomId, eventId)
}

export function unpinMessageForSelf(
  userId: string,
  roomId: string,
  eventId: string,
): void {
  usePersonalPinnedStore.getState().hydrate()
  usePersonalPinnedStore.getState().unpin(userId, roomId, eventId)
}
