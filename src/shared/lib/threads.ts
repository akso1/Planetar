import {
  RelationType,
  THREAD_RELATION_TYPE,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type Thread,
} from 'matrix-js-sdk'

/**
 * matrix-js-sdk strips `m.relates_to` on redaction and moves the event into the
 * main timeline (until MSC3389). Remember reply→root so:
 * - main room view does not grow a "message deleted" bubble
 * - the thread panel can still show «Сообщение удалено» after relaunch
 * - the thread chip stays available when the only reply was deleted
 */
const STORAGE_KEY = 'planetar-thread-reply-roots'
const MAX_PERSISTED = 8000

const knownThreadReplyIds = new Set<string>()
/** reply event id → thread root event id */
const knownThreadReplyRoot = new Map<string, string>()

let hydrated = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

function readPersisted(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function ensureHydrated(): void {
  if (hydrated) return
  hydrated = true
  try {
    const data = readPersisted()
    for (const [replyId, rootId] of Object.entries(data)) {
      knownThreadReplyIds.add(replyId)
      knownThreadReplyRoot.set(replyId, rootId)
    }
  } catch {
    /* ignore */
  }
}

function writePersistedNow(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const entries = [...knownThreadReplyRoot.entries()]
    const trimmed =
      entries.length > MAX_PERSISTED
        ? entries.slice(entries.length - MAX_PERSISTED)
        : entries
    if (trimmed.length !== entries.length) {
      knownThreadReplyIds.clear()
      knownThreadReplyRoot.clear()
      for (const [k, v] of trimmed) {
        knownThreadReplyIds.add(k)
        knownThreadReplyRoot.set(k, v)
      }
    }
    const obj: Record<string, string> = {}
    for (const [k, v] of trimmed) obj[k] = v
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch (err) {
    console.warn('[threads] failed to persist reply map', err)
  }
}

function schedulePersist(): void {
  if (typeof localStorage === 'undefined') return
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writePersistedNow()
  }, 120)
}

/** Flush pending reply-map writes (call before redact / app quit). */
export function flushThreadReplyPersist(): void {
  ensureHydrated()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  writePersistedNow()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushThreadReplyPersist())
  window.addEventListener('beforeunload', () => flushThreadReplyPersist())
}

/** Record that `eventId` is a reply under `rootId` (survives redaction + relaunch). */
export function rememberThreadReply(
  eventId: string,
  rootId?: string | null,
): void {
  ensureHydrated()
  if (!eventId) return
  const hadId = knownThreadReplyIds.has(eventId)
  const prevRoot = knownThreadReplyRoot.get(eventId)
  knownThreadReplyIds.add(eventId)
  if (rootId) knownThreadReplyRoot.set(eventId, rootId)
  if (knownThreadReplyRoot.size > MAX_PERSISTED * 1.25) {
    writePersistedNow()
  } else if (!hadId || (rootId && prevRoot !== rootId)) {
    schedulePersist()
  }
}

/** Reply event ids we have recorded under a given thread root. */
export function rememberedRepliesForRoot(rootEventId: string): string[] {
  ensureHydrated()
  if (!rootEventId) return []
  const out: string[] = []
  for (const [replyId, rootId] of knownThreadReplyRoot) {
    if (rootId === rootEventId) out.push(replyId)
  }
  return out
}

function hasLiveThreadRelation(event: MatrixEvent): boolean {
  if (event.isRelation?.(RelationType.Thread)) return true
  if (event.isRelation?.(THREAD_RELATION_TYPE.name)) return true
  const rel = event.getRelation?.()
  return (
    rel?.rel_type === RelationType.Thread ||
    rel?.rel_type === THREAD_RELATION_TYPE.name ||
    rel?.rel_type === 'io.element.thread'
  )
}

/** True when the event is a reply inside a thread (not the root). */
export function isThreadReplyEvent(event: MatrixEvent): boolean {
  ensureHydrated()
  const id = event.getId()
  if (hasLiveThreadRelation(event)) {
    const rel = event.getRelation?.()
    const root =
      (rel && typeof rel.event_id === 'string' ? rel.event_id : null) ||
      (typeof event.threadRootId === 'string' ? event.threadRootId : null)
    if (id) rememberThreadReply(id, root)
    return true
  }
  return !!(id && knownThreadReplyIds.has(id))
}

export function getThreadRootId(event: MatrixEvent): string | null {
  ensureHydrated()
  if (hasLiveThreadRelation(event)) {
    const rel = event.getRelation?.()
    if (rel && typeof rel.event_id === 'string') {
      const id = event.getId()
      if (id) rememberThreadReply(id, rel.event_id)
      return rel.event_id
    }
  }
  const id = event.getId()
  if (id) {
    const remembered = knownThreadReplyRoot.get(id)
    if (remembered) return remembered
  }
  if (event.threadRootId && isThreadReplyEvent(event)) {
    return event.threadRootId
  }
  return null
}

/**
 * Visible (non-deleted) reply count for the thread chip / panel header.
 * Known-deleted replies are excluded from the number but can still keep the
 * thread openable via {@link hasThreadReplies}.
 */
export function getThreadReplyCount(
  room: Room,
  rootEvent: MatrixEvent,
): number {
  ensureHydrated()
  const id = rootEvent.getId()
  if (!id) return 0

  const counted = new Set<string>()
  let live = 0
  const consider = (ev: MatrixEvent) => {
    const eid = ev.getId()
    if (!eid || eid === id || counted.has(eid)) return
    if (getThreadRootId(ev) !== id) return
    counted.add(eid)
    if (!ev.isRedacted()) live += 1
  }

  const thread = room.getThread(id)
  if (thread) {
    for (const ev of thread.timeline) consider(ev)
  }
  for (const ev of room.getLiveTimeline().getEvents()) consider(ev)

  const bundled =
    rootEvent.getServerAggregatedRelation?.(RelationType.Thread) ||
    rootEvent.getServerAggregatedRelation?.(THREAD_RELATION_TYPE.name)
  const fromBundled =
    bundled && typeof (bundled as { count?: number }).count === 'number'
      ? (bundled as { count: number }).count
      : 0

  // Server aggregate can lag after redact — subtract replies we know are gone
  const knownDeleted = rememberedRepliesForRoot(id).filter((rid) => {
    const ev = room.findEventById(rid)
    return !ev || ev.isRedacted()
  }).length
  const fromBundledAdjusted = Math.max(0, fromBundled - knownDeleted)

  return Math.max(live, fromBundledAdjusted)
}

/** True when the thread chip should stay available (live and/or deleted stubs). */
export function hasThreadReplies(
  room: Room,
  rootEvent: MatrixEvent,
): boolean {
  if (getThreadReplyCount(room, rootEvent) > 0) return true
  const id = rootEvent.getId()
  return !!id && rememberedRepliesForRoot(id).length > 0
}

/**
 * Load remembered replies for a root.
 * Always prefer `/event` from the homeserver — the local room store can still
 * hold pre-redaction cleartext for a few seconds after reload, which flashes
 * the old body before «Сообщение удалено».
 */
export async function loadRememberedThreadReplies(
  client: MatrixClient,
  room: Room,
  rootEventId: string,
): Promise<MatrixEvent[]> {
  ensureHydrated()
  const out: MatrixEvent[] = []
  const seen = new Set<string>()
  const mapper = client.getEventMapper()

  for (const replyId of rememberedRepliesForRoot(rootEventId)) {
    if (seen.has(replyId)) continue
    seen.add(replyId)

    let ev: MatrixEvent | null = null
    try {
      const raw = await client.fetchRoomEvent(room.roomId, replyId)
      ev = mapper(raw)
    } catch {
      // Fallback only when local copy is already redacted — never flash cleartext
      const local = room.findEventById(replyId)
      if (local?.isRedacted()) ev = local
    }

    if (!ev) continue
    rememberThreadReply(replyId, rootEventId)
    out.push(ev)
  }
  return out
}

/**
 * Ensure a Thread model exists for the root.
 * Do NOT pass the root into `events` — the SDK warns and rejects adding the
 * root via addEventToTimeline in some canContain paths.
 */
export function ensureRoomThread(
  room: Room,
  rootEvent: MatrixEvent,
): Thread | null {
  const id = rootEvent.getId()
  if (!id) return null
  const existing = room.getThread(id)
  if (existing) return existing
  try {
    return room.createThread(id, rootEvent, [], false)
  } catch (err) {
    console.warn('[threads] createThread failed', err)
    return room.getThread(id)
  }
}

/** MSC3440 relation payload for sending a thread reply. */
export function buildThreadRelation(
  rootEventId: string,
  fallbackReplyToId?: string | null,
): Record<string, unknown> {
  const inReplyTo = fallbackReplyToId || rootEventId
  return {
    'm.relates_to': {
      rel_type: THREAD_RELATION_TYPE.name,
      event_id: rootEventId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: inReplyTo },
    },
  }
}

export function sortThreadReplies(events: MatrixEvent[]): MatrixEvent[] {
  return [...events].sort((a, b) => a.getTs() - b.getTs())
}

export function mergeThreadReply(
  prev: MatrixEvent[],
  next: MatrixEvent,
  rootEventId: string,
): MatrixEvent[] {
  const id = next.getId()
  if (!id || id === rootEventId) return prev
  // ThreadPanel only merges events for this root (live timeline or /relations).
  // Redacted stubs lose m.relates_to — still record + keep «Сообщение удалено».
  rememberThreadReply(id, rootEventId)

  const existing = prev.find((e) => e.getId() === id)
  // Never replace a deleted placeholder with a stale clear-text copy from
  // local store / relations race after reload.
  if (existing?.isRedacted() && !next.isRedacted()) {
    return prev
  }

  const without = prev.filter((e) => e.getId() !== id)
  return sortThreadReplies([...without, next])
}
