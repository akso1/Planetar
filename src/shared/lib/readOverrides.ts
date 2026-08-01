import type { Room } from 'matrix-js-sdk'

const STORAGE_KEY = 'matrix-macos-read-overrides'

/** roomId → last fully-read tip (event id + ts for refresh-safe compare) */
export type ReadOverride = {
  eventId: string
  /** Event timestamp when marked; helps when tip leaves the live window */
  ts: number
}

type ReadOverrides = Record<string, ReadOverride>

let cache: ReadOverrides | null = null

function normalizeEntry(raw: unknown): ReadOverride | null {
  if (typeof raw === 'string' && raw.length > 0) {
    return { eventId: raw, ts: 0 }
  }
  if (raw && typeof raw === 'object') {
    const row = raw as { eventId?: unknown; ts?: unknown }
    if (typeof row.eventId === 'string' && row.eventId.length > 0) {
      return {
        eventId: row.eventId,
        ts: typeof row.ts === 'number' ? row.ts : 0,
      }
    }
  }
  return null
}

function readAll(): ReadOverrides {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      cache = {}
      return cache
    }
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: ReadOverrides = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = normalizeEntry(v)
        if (entry) out[k] = entry
      }
      cache = out
      return cache
    }
  } catch {
    /* ignore */
  }
  cache = {}
  return cache
}

function writeAll(next: ReadOverrides) {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore quota / private mode */
  }
}

export function getReadOverride(roomId: string): ReadOverride | null {
  return readAll()[roomId] ?? null
}

export function rememberReadOverride(
  roomId: string,
  eventId: string,
  ts = 0,
): void {
  if (!roomId || !eventId || eventId.startsWith('~')) return
  const all = {
    ...readAll(),
    [roomId]: { eventId, ts: ts > 0 ? ts : Date.now() },
  }
  writeAll(all)
}

export function clearReadOverride(roomId: string): void {
  const all = readAll()
  if (!(roomId in all)) return
  const next = { ...all }
  delete next[roomId]
  writeAll(next)
}

/**
 * Whether our stored mark still covers the live tip (no newer remote messages).
 * Used so E2EE rooms don't resurrect IndexedDB notification counts after refresh.
 */
export function isReadOverrideActive(
  room: Room,
  override: ReadOverride | string,
  myUserId: string | null | undefined,
): boolean {
  const markedEventId =
    typeof override === 'string' ? override : override.eventId
  const markedTs = typeof override === 'string' ? 0 : override.ts || 0
  if (!markedEventId) return false

  const events = room.getLiveTimeline().getEvents()
  let tipId: string | null = null
  let tipSender: string | null = null
  let tipTs = 0

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    const id = ev.getId()
    if (!id || id.startsWith('~')) continue
    if (ev.isRedacted()) continue
    const type = ev.getType()
    if (
      type !== 'm.room.message' &&
      type !== 'm.room.encrypted' &&
      type !== 'm.sticker'
    ) {
      continue
    }
    tipId = id
    tipSender = ev.getSender() ?? null
    tipTs = ev.getTs() || 0
    break
  }

  // Empty / not-yet-loaded timeline — trust the override until tip appears
  if (!tipId) return true
  if (tipId === markedEventId) return true
  if (myUserId && tipSender === myUserId) return true

  if (myUserId) {
    try {
      if (room.hasUserReadEvent(myUserId, tipId)) return true
    } catch {
      /* ignore */
    }
  }

  try {
    const cmp = room.compareEventOrdering(tipId, markedEventId)
    if (typeof cmp === 'number') return cmp <= 0
  } catch {
    /* ignore */
  }

  const marked = room.findEventById(markedEventId)
  if (marked) {
    const mTs = marked.getTs() || markedTs
    if (mTs > 0 && tipTs > 0) return tipTs <= mTs
  }

  // Marked tip left the window — compare against stored mark time
  if (markedTs > 0 && tipTs > 0) return tipTs <= markedTs

  // Cannot prove the tip is covered → drop override so real unreads can show
  return false
}
