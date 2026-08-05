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

/**
 * Mentions alone (no text, no files) are NOT a real draft — they left ghost
 * "Черновик" rows in the sidebar after the user deleted the typed @mention.
 */
function isDraftEmpty(d: {
  text?: string
  mentionUserIds?: string[]
  files?: File[]
}): boolean {
  return !(d.text ?? '').trim() && !(d.files?.length)
}

function normalizeMentionsForText(
  text: string,
  mentionUserIds: string[],
): string[] {
  if (!text.trim()) return []
  if (!mentionUserIds.length) return []
  // Keep ids only while composer still has an @ token (localpart or full mxid-ish).
  return mentionUserIds.filter((id) => {
    const local = id.split(':')[0]?.replace(/^@/, '') || ''
    if (!local) return false
    return (
      text.includes(`@${local}`) ||
      text.includes(id) ||
      text.includes(`@${id}`)
    )
  })
}

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
    let needsRewrite = false
    for (const [roomId, v] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!v || typeof v !== 'object') continue
      const row = v as Partial<PersistedDraft>
      if (typeof row.text !== 'string') continue
      const text = row.text
      const mentionUserIds = Array.isArray(row.mentionUserIds)
        ? row.mentionUserIds.filter((id): id is string => typeof id === 'string')
        : []
      const normalizedMentions = normalizeMentionsForText(text, mentionUserIds)
      // Drop ghost mention-only / whitespace-only rows
      if (!text.trim()) {
        needsRewrite = true
        continue
      }
      if (normalizedMentions.length !== mentionUserIds.length) {
        needsRewrite = true
      }
      out[roomId] = {
        text,
        mentionUserIds: normalizedMentions,
        updatedAt:
          typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
      }
    }
    if (needsRewrite) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out))
      } catch {
        /* ignore */
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeTextStore(next: Record<string, PersistedDraft>): void {
  try {
    const pruned: Record<string, PersistedDraft> = {}
    for (const [id, d] of Object.entries(next)) {
      if (!d.text.trim()) continue
      pruned[id] = {
        text: d.text,
        mentionUserIds: normalizeMentionsForText(d.text, d.mentionUserIds),
        updatedAt: d.updatedAt,
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
  } catch {
    /* quota / private mode */
  }
}

/** Read persisted text draft for a room (localStorage source of truth). */
export function readPersistedComposerDraft(
  roomId: string,
): PersistedDraft | null {
  if (!roomId) return null
  return readTextStore()[roomId] ?? null
}

/**
 * Merge in-memory (files) + localStorage (text) so a wiped map still restores
 * after reload / empty-save races.
 */
export function getComposerDraft(roomId: string): ComposerDraft | null {
  if (!roomId) return null
  const live = useComposerDraftsStore.getState().map[roomId]
  const persisted = readTextStore()[roomId]
  if (!live && !persisted) return null

  const text =
    live?.text?.trim()
      ? live.text
      : (persisted?.text ?? live?.text ?? '')
  const mentionUserIds = normalizeMentionsForText(
    text,
    live?.mentionUserIds?.length
      ? live.mentionUserIds
      : (persisted?.mentionUserIds ?? live?.mentionUserIds ?? []),
  )
  const files = live?.files ?? []
  const updatedAt = Math.max(
    live?.updatedAt ?? 0,
    persisted?.updatedAt ?? 0,
  )

  if (isDraftEmpty({ text, mentionUserIds, files })) return null
  return { text, mentionUserIds, files, updatedAt }
}

/** If map lost a draft that still lives in localStorage, put it back. */
export function rehydrateComposerDraft(roomId: string): ComposerDraft | null {
  if (!roomId) return null
  const draft = getComposerDraft(roomId)
  const live = useComposerDraftsStore.getState().map[roomId]

  // Ghost map entries (mentions-only / empty) — drop them
  if (!draft) {
    if (live && isDraftEmpty(live)) {
      useComposerDraftsStore.getState().clear(roomId)
    } else if (live && !(live.text ?? '').trim() && !(live.files?.length)) {
      useComposerDraftsStore.getState().clear(roomId)
    }
    return null
  }

  if (
    !live ||
    isDraftEmpty(live) ||
    (!(live.text ?? '').trim() && (draft.text ?? '').trim())
  ) {
    useComposerDraftsStore.setState((s) => ({
      map: {
        ...s.map,
        [roomId]: {
          text: draft.text,
          mentionUserIds: draft.mentionUserIds,
          files: live?.files?.length ? live.files : draft.files,
          updatedAt: draft.updatedAt,
        },
      },
      rev: s.rev + 1,
    }))
  }
  return getComposerDraft(roomId)
}

/** One-shot: purge mention-only ghosts from map + localStorage. */
export function pruneGhostComposerDrafts(): void {
  const persisted = readTextStore() // already rewrites LS without ghosts
  const map = useComposerDraftsStore.getState().map
  const nextMap = { ...map }
  let changed = false
  for (const [roomId, d] of Object.entries(map)) {
    if (isDraftEmpty(d)) {
      delete nextMap[roomId]
      changed = true
      continue
    }
    // Drop map ghosts that aren't in cleaned LS and have no files
    if (!(d.text ?? '').trim() && !(d.files?.length)) {
      delete nextMap[roomId]
      changed = true
    } else if (!(roomId in persisted) && !(d.files?.length) && !(d.text ?? '').trim()) {
      delete nextMap[roomId]
      changed = true
    }
  }
  if (changed) {
    useComposerDraftsStore.setState((s) => ({
      map: nextMap,
      rev: s.rev + 1,
    }))
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

function initialMap(): Record<string, ComposerDraft> {
  const persisted = readTextStore()
  const map: Record<string, ComposerDraft> = {}
  for (const [roomId, d] of Object.entries(persisted)) {
    if (isDraftEmpty(d)) continue
    map[roomId] = {
      text: d.text,
      mentionUserIds: normalizeMentionsForText(d.text, d.mentionUserIds),
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
    const files = draft.files ?? []
    const mentionUserIds = normalizeMentionsForText(
      text,
      draft.mentionUserIds ?? [],
    )

    if (isDraftEmpty({ text, mentionUserIds, files })) {
      get().clear(roomId)
      return
    }

    const persisted = readTextStore()
    if (text.trim()) {
      persisted[roomId] = { text, mentionUserIds, updatedAt: Date.now() }
    } else {
      // File-only: keep out of localStorage but stay in the reactive map
      delete persisted[roomId]
    }
    writeTextStore(persisted)

    const now = Date.now()
    const nextMap = { ...get().map }
    nextMap[roomId] = { text, mentionUserIds, files, updatedAt: now }
    set({ map: nextMap, rev: get().rev + 1 })
  },
  clear: (roomId) => {
    if (!roomId) return
    const cur = get().map[roomId]
    const persisted = readTextStore()
    let mapChanged = false
    let lsChanged = false

    if (roomId in persisted) {
      const nextPersisted = { ...persisted }
      delete nextPersisted[roomId]
      writeTextStore(nextPersisted)
      lsChanged = true
    }

    if (cur) {
      const nextMap = { ...get().map }
      delete nextMap[roomId]
      set({ map: nextMap, rev: get().rev + 1 })
      mapChanged = true
    }

    if (lsChanged && !mapChanged) {
      set({ rev: get().rev + 1 })
    }
  },
}))

/** Read a draft synchronously (map + localStorage). */
export function loadComposerDraft(roomId: string): ComposerDraft | null {
  return getComposerDraft(roomId)
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

// Purge legacy mention-only ghosts as soon as this module loads
pruneGhostComposerDrafts()
