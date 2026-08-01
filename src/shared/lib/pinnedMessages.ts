import {
  EventType,
  MatrixEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk'
import { ALBUM_CAPTION_KEY } from '@/shared/lib/sendMedia'

export type PinScope = {
  /** Room state `m.room.pinned_events` — visible to everyone */
  room: boolean
  /** Local personal pin — only this client/account */
  self: boolean
}

export type ResolvedPinnedMessage = {
  eventId: string
  ts: number
  preview: string
  scope: PinScope
}

export function mergePinnedEventIds(
  roomIds: string[],
  selfIds: string[],
): Array<{ eventId: string; scope: PinScope }> {
  const map = new Map<string, PinScope>()
  for (const id of roomIds) {
    if (!id) continue
    const prev = map.get(id)
    map.set(id, { room: true, self: prev?.self ?? false })
  }
  for (const id of selfIds) {
    if (!id) continue
    const prev = map.get(id)
    map.set(id, { room: prev?.room ?? false, self: true })
  }
  return [...map.entries()].map(([eventId, scope]) => ({ eventId, scope }))
}

export function getPinnedEventIds(room: Room): string[] {
  const ev = room.currentState.getStateEvents(EventType.RoomPinnedEvents, '')
  if (!ev) return []
  const content = ev.getContent() as { pinned?: unknown }
  if (!Array.isArray(content.pinned)) return []
  return content.pinned.filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  )
}

export function canPinMessages(
  room: Room,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false
  return room.currentState.maySendStateEvent(
    EventType.RoomPinnedEvents,
    userId,
  )
}

export function isEventPinned(room: Room, eventId: string): boolean {
  return getPinnedEventIds(room).includes(eventId)
}

export async function setPinnedEventIds(
  client: MatrixClient,
  room: Room,
  pinned: string[],
): Promise<void> {
  await client.sendStateEvent(
    room.roomId,
    EventType.RoomPinnedEvents,
    { pinned },
    '',
  )
}

export async function pinMessage(
  client: MatrixClient,
  room: Room,
  eventId: string,
): Promise<void> {
  const current = getPinnedEventIds(room)
  if (current.includes(eventId)) return
  await setPinnedEventIds(client, room, [...current, eventId])
}

export async function unpinMessage(
  client: MatrixClient,
  room: Room,
  eventId: string,
): Promise<void> {
  const current = getPinnedEventIds(room)
  if (!current.includes(eventId)) return
  await setPinnedEventIds(
    client,
    room,
    current.filter((id) => id !== eventId),
  )
}

export function pinnedMessagePreview(event: MatrixEvent): string {
  if (event.isRedacted()) return 'Сообщение удалено'
  if (event.isDecryptionFailure()) return 'Зашифрованное сообщение'
  const content = event.getContent() as Record<string, unknown>
  const msgtype = content.msgtype as string | undefined
  switch (msgtype) {
    case 'm.image':
      return '🖼 Фото'
    case 'm.sticker':
      return '🎟 Стикер'
    case 'm.audio':
      return '🎤 Голосовое'
    case 'm.video':
      return '🎬 Видео'
    case 'm.file':
      return `📄 ${(content.body as string) || 'Файл'}`
    default:
      break
  }
  if (event.getType() === 'm.sticker') return '🎟 Стикер'
  const caption = content[ALBUM_CAPTION_KEY]
  if (typeof caption === 'string' && caption.trim()) {
    const t = caption.replace(/\s+/g, ' ').trim()
    return t.length > 140 ? `${t.slice(0, 140)}…` : t
  }
  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  body = body.replace(/\s+/g, ' ').trim()
  if (!body) return 'Сообщение'
  return body.length > 140 ? `${body.slice(0, 140)}…` : body
}

async function resolveEvent(
  client: MatrixClient,
  room: Room,
  eventId: string,
): Promise<MatrixEvent | null> {
  const local = room.findEventById(eventId)
  if (local) {
    try {
      await client.decryptEventIfNeeded(local)
    } catch {
      /* ignore */
    }
    return local
  }

  try {
    const raw = await client.fetchRoomEvent(room.roomId, eventId)
    const ev = new MatrixEvent(raw)
    try {
      await client.decryptEventIfNeeded(ev)
    } catch {
      /* ignore */
    }
    return ev
  } catch {
    return null
  }
}

function sortPinsNewestFirst(
  resolved: ResolvedPinnedMessage[],
  ids: string[],
): ResolvedPinnedMessage[] {
  return [...resolved].sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts
    return ids.indexOf(b.eventId) - ids.indexOf(a.eventId)
  })
}

/** Instant local resolve (no network) so the pin bar appears immediately. */
export function resolvePinnedMessagesLocal(
  room: Room,
  selfIds: string[] = [],
): ResolvedPinnedMessage[] {
  const merged = mergePinnedEventIds(getPinnedEventIds(room), selfIds)
  if (merged.length === 0) return []
  const ids = merged.map((m) => m.eventId)
  const scopeById = new Map(merged.map((m) => [m.eventId, m.scope]))

  const resolved = merged.map(({ eventId, scope }) => {
    const event = room.findEventById(eventId)
    if (!event) {
      return {
        eventId,
        ts: 0,
        preview: 'Сообщение',
        scope,
      } satisfies ResolvedPinnedMessage
    }
    return {
      eventId,
      ts: event.getTs() || 0,
      preview: pinnedMessagePreview(event),
      scope: scopeById.get(eventId) ?? scope,
    } satisfies ResolvedPinnedMessage
  })

  return sortPinsNewestFirst(resolved, ids)
}

/**
 * Resolve pinned event previews, ordered newest-first (by event timestamp).
 * Fetches missing events from the server when needed.
 */
export async function resolvePinnedMessagesNewestFirst(
  client: MatrixClient,
  room: Room,
  selfIds: string[] = [],
): Promise<ResolvedPinnedMessage[]> {
  const merged = mergePinnedEventIds(getPinnedEventIds(room), selfIds)
  if (merged.length === 0) return []
  const ids = merged.map((m) => m.eventId)

  const resolved = await Promise.all(
    merged.map(async ({ eventId, scope }) => {
      const event = await resolveEvent(client, room, eventId)
      if (!event) {
        return {
          eventId,
          ts: 0,
          preview: 'Сообщение',
          scope,
        } satisfies ResolvedPinnedMessage
      }
      return {
        eventId,
        ts: event.getTs() || 0,
        preview: pinnedMessagePreview(event),
        scope,
      } satisfies ResolvedPinnedMessage
    }),
  )

  return sortPinsNewestFirst(resolved, ids)
}

/** Chronological (oldest → newest) for scroll-sync against the timeline. */
export function pinsChronological(
  newestFirst: ResolvedPinnedMessage[],
): ResolvedPinnedMessage[] {
  return [...newestFirst].reverse()
}

export type PinScrollDirection = 'up' | 'down' | 'none'

export type PinDomStatus = 'past' | 'active' | 'below'

/**
 * Classify a pinned message relative to the sticky pin-bar line and viewport.
 * - past: fully above the bar (toward older history / top of chat)
 * - below: entirely under the fold (toward newer / bottom)
 * - active: intersects the visible area under the bar
 */
export function classifyPinDom(
  rect: { top: number; bottom: number },
  stickyY: number,
  viewBottom: number,
): PinDomStatus {
  if (rect.bottom <= stickyY + 4) return 'past'
  if (rect.top >= viewBottom - 24) return 'below'
  return 'active'
}

export type PinStatusEntry = {
  eventId: string
  status: PinDomStatus
  newestFirstIndex: number
}

/**
 * When a pin isn't mounted (common after TimelineWindow jump), infer past/below
 * from row order, timestamps vs the loaded window, or relative to mounted pins.
 */
export function inferMissingPinStatus(args: {
  pin: ResolvedPinnedMessage
  /** Index of pin in loaded timeline rows, or -1 */
  rowIndex: number
  /** First timeline row whose bottom is below stickyY, or -1 */
  firstVisibleRow: number
  /** Last timeline row whose top is above viewBottom, or -1 */
  lastVisibleRow: number
  /** Oldest loaded message ts (>0) */
  windowOldestTs: number
  /** Newest loaded message ts (>0) */
  windowNewestTs: number
  /** Mounted pins with known DOM status (for relative placement) */
  anchors?: Array<{ ts: number; status: PinDomStatus }>
}): PinDomStatus | null {
  const {
    pin,
    rowIndex,
    firstVisibleRow,
    lastVisibleRow,
    windowOldestTs,
    windowNewestTs,
    anchors,
  } = args

  if (rowIndex >= 0 && firstVisibleRow >= 0 && lastVisibleRow >= 0) {
    if (rowIndex < firstVisibleRow) return 'past'
    if (rowIndex > lastVisibleRow) return 'below'
    return 'active'
  }

  if (pin.ts > 0 && anchors && anchors.length > 0) {
    const newer = anchors.filter((a) => a.ts > pin.ts)
    const older = anchors.filter((a) => a.ts > 0 && a.ts < pin.ts)
    // Newer pin is on screen or still below → this older pin is above the bar
    if (
      newer.some((a) => a.status === 'active' || a.status === 'below')
    ) {
      return 'past'
    }
    // Older pin is on screen or already above → this newer pin is below
    if (
      older.some((a) => a.status === 'active' || a.status === 'past')
    ) {
      return 'below'
    }
  }

  if (pin.ts > 0 && windowOldestTs > 0 && windowNewestTs > 0) {
    // Chat top = older. Older than window → above viewport.
    if (pin.ts < windowOldestTs) return 'past'
    // Newer than window → below viewport.
    if (pin.ts > windowNewestTs) return 'below'
  }

  return null
}

function pickMinIndex(entries: PinStatusEntry[]): number {
  return entries.reduce((a, b) =>
    a.newestFirstIndex < b.newestFirstIndex ? a : b,
  ).newestFirstIndex
}

function pickMaxIndex(entries: PinStatusEntry[]): number {
  return entries.reduce((a, b) =>
    a.newestFirstIndex > b.newestFirstIndex ? a : b,
  ).newestFirstIndex
}

/**
 * Newest-first index for the pin bar from DOM (+ inferred) statuses + direction.
 *
 * Scroll up (toward older): advance 1→2→3, including the gap between pins
 * (when the older pin is already above the bar and the newer is still below).
 * Scroll down / idle: show the pin on screen or the newest one just passed.
 */
export function computePinnedBarIndex(args: {
  pinsNewestFirst: ResolvedPinnedMessage[]
  stickyY: number
  viewBottom: number
  getRect: (eventId: string) => { top: number; bottom: number } | null
  direction?: PinScrollDirection
  /** Optional: fill in pins that aren't mounted yet */
  inferStatus?: (
    pin: ResolvedPinnedMessage,
    newestFirstIndex: number,
  ) => PinDomStatus | null
}): number | null {
  const {
    pinsNewestFirst,
    stickyY,
    viewBottom,
    getRect,
    direction = 'none',
    inferStatus,
  } = args
  const n = pinsNewestFirst.length
  if (n === 0) return null
  if (n === 1) return 0

  const statuses: PinStatusEntry[] = []
  const anchors: Array<{ ts: number; status: PinDomStatus }> = []

  // Pass 1: real DOM measurements
  pinsNewestFirst.forEach((pin, newestFirstIndex) => {
    const rect = getRect(pin.eventId)
    if (!rect) return
    const status = classifyPinDom(rect, stickyY, viewBottom)
    statuses.push({ eventId: pin.eventId, status, newestFirstIndex })
    if (pin.ts > 0) anchors.push({ ts: pin.ts, status })
  })

  // Pass 2: infer missing pins (after jump many neighbors aren't mounted)
  if (inferStatus) {
    pinsNewestFirst.forEach((pin, newestFirstIndex) => {
      if (statuses.some((s) => s.eventId === pin.eventId)) return
      const status = inferStatus(pin, newestFirstIndex)
      // Re-call path: sync provides inferStatus that already has anchors —
      // also try relative placement here if infer returned null
      if (!status) return
      statuses.push({ eventId: pin.eventId, status, newestFirstIndex })
    })
  }

  // Pass 2b: relative inference for anything still missing
  if (anchors.length > 0) {
    pinsNewestFirst.forEach((pin, newestFirstIndex) => {
      if (statuses.some((s) => s.eventId === pin.eventId)) return
      const status = inferMissingPinStatus({
        pin,
        rowIndex: -1,
        firstVisibleRow: -1,
        lastVisibleRow: -1,
        windowOldestTs: 0,
        windowNewestTs: 0,
        anchors,
      })
      if (!status) return
      statuses.push({ eventId: pin.eventId, status, newestFirstIndex })
    })
  }

  if (statuses.length === 0) return null

  const active = statuses.filter((s) => s.status === 'active')
  const past = statuses.filter((s) => s.status === 'past')
  const below = statuses.filter((s) => s.status === 'below')

  // --- Scroll up (toward older messages / top of chat) ---
  if (direction === 'up') {
    // Pins still "docked" under the bar vs already sliding away downward
    const atTop: PinStatusEntry[] = []
    const leaving: PinStatusEntry[] = []
    for (const entry of active) {
      const rect = getRect(entry.eventId)
      if (rect && rect.top > stickyY + 72) leaving.push(entry)
      else atTop.push(entry)
    }

    // Still reading a pin under the header
    if (atTop.length > 0) return pickMaxIndex(atTop)

    // Leaving pin 2 upward while pin 3 is already above → show 3 (also covers gaps)
    if (past.length > 0 && (leaving.length > 0 || below.length > 0)) {
      return pickMinIndex(past)
    }

    if (leaving.length > 0) return pickMaxIndex(leaving)
    if (below.length > 0) return pickMaxIndex(below)
    if (past.length > 0) return pickMinIndex(past)
    return 0
  }

  // --- Scroll down / idle: pin on screen or just left above ---
  if (active.length > 0) return pickMinIndex(active)
  if (past.length > 0) return pickMinIndex(past)
  if (below.length > 0) return pickMaxIndex(below)
  return 0
}
