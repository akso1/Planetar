import { create } from 'zustand'

export type ChatSortMode = 'activity' | 'static'

export const CHAT_SORT_STORAGE_KEY = 'matrix-macos-chat-sort'
export const CHAT_ORDER_STORAGE_KEY = 'matrix-macos-chat-order'
export const CHAT_PINNED_STORAGE_KEY = 'matrix-macos-chat-pinned'

export const CHAT_SORT_OPTIONS: {
  id: ChatSortMode
  label: string
  hint: string
}[] = [
  {
    id: 'activity',
    label: 'По последнему сообщению',
    hint: 'Чаты с новыми сообщениями поднимаются наверх',
  },
  {
    id: 'static',
    label: 'Фиксированный порядок',
    hint: 'Список не переставляется при входящих сообщениях',
  },
]

export function readStoredChatSortMode(): ChatSortMode {
  try {
    const v = localStorage.getItem(CHAT_SORT_STORAGE_KEY)
    if (v === 'activity' || v === 'static') return v
  } catch {
    /* ignore */
  }
  return 'activity'
}

export function readStoredChatOrder(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_ORDER_STORAGE_KEY)
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

export function readStoredPinnedIds(): string[] {
  try {
    const raw = localStorage.getItem(CHAT_PINNED_STORAGE_KEY)
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

function persistSortMode(mode: ChatSortMode) {
  try {
    localStorage.setItem(CHAT_SORT_STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

function persistChatOrder(ids: string[]) {
  try {
    localStorage.setItem(CHAT_ORDER_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

function persistPinnedIds(ids: string[]) {
  try {
    localStorage.setItem(CHAT_PINNED_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    /* ignore */
  }
}

type ChatListPrefsState = {
  sortMode: ChatSortMode
  /** Room ids in display order when sortMode === 'static' */
  staticOrder: string[]
  /** Pinned room ids (top of list, in this order) */
  pinnedIds: string[]
  hydrate: () => void
  setSortMode: (mode: ChatSortMode, currentRoomIds?: string[]) => void
  /** Merge joined rooms into static order (new rooms go to the top) */
  syncStaticOrder: (joinedRoomIds: string[]) => string[]
  /** Soft-filter pins to currently joined rooms for list layout (does not persist). */
  syncPinnedIds: (joinedRoomIds: string[]) => string[]
  /**
   * Persistently drop pins only when we know the room was left/forgotten —
   * never call this with a partial sync room list.
   */
  prunePinnedIds: (leftRoomIds: string[]) => void
  pinRoom: (roomId: string) => void
  unpinRoom: (roomId: string) => void
  /** Replace pinned order (ids must be a permutation of current pins, extras ignored) */
  reorderPinnedIds: (orderedIds: string[]) => void
  isPinned: (roomId: string) => boolean
}

export const useChatListPrefsStore = create<ChatListPrefsState>((set, get) => ({
  sortMode: 'activity',
  staticOrder: [],
  pinnedIds: [],

  hydrate: () => {
    set({
      sortMode: readStoredChatSortMode(),
      staticOrder: readStoredChatOrder(),
      pinnedIds: readStoredPinnedIds(),
    })
  },

  setSortMode: (mode, currentRoomIds) => {
    persistSortMode(mode)
    if (mode === 'static') {
      const seeded =
        currentRoomIds && currentRoomIds.length > 0
          ? currentRoomIds
          : get().staticOrder
      persistChatOrder(seeded)
      set({ sortMode: mode, staticOrder: seeded })
      return
    }
    set({ sortMode: mode })
  },

  syncStaticOrder: (joinedRoomIds) => {
    const prev = get().staticOrder
    const joined = new Set(joinedRoomIds)
    const kept = prev.filter((id) => joined.has(id))
    const newcomers = joinedRoomIds.filter((id) => !prev.includes(id))
    const next = [...newcomers, ...kept]
    if (
      next.length !== prev.length ||
      next.some((id, i) => id !== prev[i])
    ) {
      persistChatOrder(next)
      set({ staticOrder: next })
    }
    return next
  },

  syncPinnedIds: (joinedRoomIds) => {
    // Soft filter only — early / partial sync must not rewrite localStorage,
    // or pins for rooms not yet loaded get wiped permanently.
    const joined = new Set(joinedRoomIds)
    return get().pinnedIds.filter((id) => joined.has(id))
  },

  prunePinnedIds: (leftRoomIds) => {
    if (leftRoomIds.length === 0) return
    const left = new Set(leftRoomIds)
    const prev = get().pinnedIds
    const next = prev.filter((id) => !left.has(id))
    if (next.length === prev.length) return
    persistPinnedIds(next)
    set({ pinnedIds: next })
  },

  pinRoom: (roomId) => {
    const prev = get().pinnedIds
    if (prev.includes(roomId)) return
    const next = [roomId, ...prev]
    persistPinnedIds(next)
    set({ pinnedIds: next })
  },

  unpinRoom: (roomId) => {
    const next = get().pinnedIds.filter((id) => id !== roomId)
    persistPinnedIds(next)
    set({ pinnedIds: next })
  },

  reorderPinnedIds: (orderedIds) => {
    const prev = get().pinnedIds
    const prevSet = new Set(prev)
    const next = orderedIds.filter((id) => prevSet.has(id))
    for (const id of prev) {
      if (!next.includes(id)) next.push(id)
    }
    if (
      next.length === prev.length &&
      next.every((id, i) => id === prev[i])
    ) {
      return
    }
    persistPinnedIds(next)
    set({ pinnedIds: next })
  },

  isPinned: (roomId) => get().pinnedIds.includes(roomId),
}))

/** Non-hook read for the room store update path */
export function getChatSortMode(): ChatSortMode {
  return useChatListPrefsStore.getState().sortMode
}

export function getPinnedRoomIds(): string[] {
  return useChatListPrefsStore.getState().pinnedIds
}
