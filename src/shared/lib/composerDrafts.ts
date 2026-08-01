/** Per-room composer drafts: text survives refresh; files stay in-session.
 *  Reactive: mutations go through a Zustand store so the sidebar re-renders. */

import { create } from 'zustand'

export type ComposerDraft = {
  text: string
  mentionUserIds: string[]
  /** Session-only — File objects cannot survive reload */
  files: File[]
  updatedAt: number
}

type PersistedDraft = {
  text: string
  mentionUserIds: string[]
  updatedAt: number
}

const STORAGE_KEY = 'matrix-macos-composer-drafts'

// ——— localStorage layer (text + mentions only; files cannot be JSON-encoded) ———

function readTextStore(): Record<string, PersistedDraft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, PersistedDraft> = {}
    for (const [roomId, v] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!v || typeof v !== 'object') continue
      const row = v as Partial<PersistedDraft>
      if (typeof row.text !== 'string') continue
      out[roomId] = {
        text: row.text,
        mentionUserIds: Array.isArray(row.mentionUserIds)
          ? row.mentionUserIds.filter((id): id is string => typeof id === 'string')
          : [],
        updatedAt:
          typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeTextStore(next: Record<string, PersistedDraft>): void {
  try {
    // Drop empty drafts to keep storage small
    const pruned: Record<string, PersistedDraft> = {}
    for (const [id, d] of Object.entries(next)) {
      if (d.text.trim() || d.mentionUserIds.length) pruned[id] = d
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
  } catch {
    /* quota / private mode */
  }
}

// ——— Reactive store ———

type DraftsState = {
  /** roomId → draft (includes session-only files) */
  map: Record<string, ComposerDraft>
  /** Bumped on every mutation so subscribers re-derive views. */
  rev: number
  save: (
    roomId: string,
    draft: {
      text: string
      mentionUserIds?: string[]
      files?: File[]
    },
  ) => void
  clear: (roomId: string) => void
}

/** Seed the map once at import time so drafts appear without an explicit hydrate call. */
function initialMap(): Record<string, ComposerDraft> {
  const persisted = readTextStore()
  const map: Record<string, ComposerDraft> = {}
  for (const [roomId, d] of Object.entries(persisted)) {
    map[roomId] = {
      text: d.text,
      mentionUserIds: d.mentionUserIds,
      files: [],
      updatedAt: d.updatedAt,
    }
  }
  return map
}

export const useComposerDraftsStore = create<DraftsState>((set, get) => ({
  map: initialMap(),
  rev: 0,
  save: (roomId, draft) => {
    if (!roomId) return
    const text = draft.text ?? ''
    const mentionUserIds = draft.mentionUserIds ?? []
    const files = draft.files ?? []

    if (!text.trim() && mentionUserIds.length === 0 && files.length === 0) {
      get().clear(roomId)
      return
    }

    // 1) Persist text + mentions to localStorage (files cannot survive reload)
    const persisted = readTextStore()
    if (text.trim() || mentionUserIds.length > 0) {
      persisted[roomId] = { text, mentionUserIds, updatedAt: Date.now() }
    } else {
      delete persisted[roomId]
    }
    writeTextStore(persisted)

    // 2) Update reactive map (includes session-only files)
    const now = Date.now()
    const nextMap = { ...get().map }
    nextMap[roomId] = { text, mentionUserIds, files, updatedAt: now }
    set({ map: nextMap, rev: get().rev + 1 })
  },
  clear: (roomId) => {
    if (!roomId) return
    const cur = get().map[roomId]
    const persisted = readTextStore()
    let changed = false

    if (roomId in persisted) {
      const nextPersisted = { ...persisted }
      delete nextPersisted[roomId]
      writeTextStore(nextPersisted)
      changed = true
    }

    if (cur) {
      const nextMap = { ...get().map }
      delete nextMap[roomId]
      set({ map: nextMap, rev: get().rev + 1 })
      changed = true
    }

    void changed
  },
}))

// ——— Backwards-compatible helpers ———

/** Read a draft synchronously (reflects latest in-memory state, incl. files). */
export function loadComposerDraft(roomId: string): ComposerDraft | null {
  if (!roomId) return null
  const d = useComposerDraftsStore.getState().map[roomId]
  if (!d) return null
  return { ...d }
}

/** Save a draft (reactive — updates the sidebar). */
export function saveComposerDraft(
  roomId: string,
  draft: {
    text: string
    mentionUserIds?: string[]
    files?: File[]
  },
): void {
  useComposerDraftsStore.getState().save(roomId, draft)
}

/** Clear a draft (reactive — updates the sidebar). */
export function clearComposerDraft(roomId: string): void {
  useComposerDraftsStore.getState().clear(roomId)
}
