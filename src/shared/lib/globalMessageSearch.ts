import {
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk'
import { ALBUM_CAPTION_KEY } from '@/shared/lib/sendMedia'

export type GlobalMessageHit = {
  eventId: string
  roomId: string
  roomName: string
  senderId: string
  senderName: string
  body: string
  ts: number
  highlights: string[]
}

export type GlobalSearchSnapshot = {
  hits: GlobalMessageHit[]
  /** Quick/server/deep phase still running for this batch */
  busy: boolean
  /** More history can be fetched (scrollback / server pages) */
  canDeepen: boolean
  status: string
}

/** How many results to show / fetch per "Ещё" click. */
export const GLOBAL_SEARCH_PAGE_SIZE = 20

const HIT_CAP = 2000
const SCROLLBACK_SIZE = 80
/** Scrollback calls per "load more" — keeps UI snappy. */
const SCROLLBACK_BATCH = 12
const MAX_PAGES_PER_ROOM = 60
/** Server pages during the initial quick pass. */
const QUICK_SERVER_PAGES = 3
/** Extra server pages per deepen. */
const DEEPEN_SERVER_PAGES = 4

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

function canonicalSearchEventId(
  eventId: string,
  content: Record<string, unknown> | undefined | null,
): string | null {
  const rel = content?.['m.relates_to'] as
    | { rel_type?: string; event_id?: string }
    | undefined
  if (rel?.rel_type === 'm.annotation') return null
  if (rel?.rel_type === 'm.replace') {
    return typeof rel.event_id === 'string' && rel.event_id
      ? rel.event_id
      : null
  }
  return eventId
}

function messageBodyFromContent(
  content: Record<string, unknown> | undefined | null,
): string {
  if (!content) return ''
  if (typeof content.body === 'string' && content.body) return content.body
  const newContent = content['m.new_content'] as
    | Record<string, unknown>
    | undefined
  if (typeof newContent?.body === 'string' && newContent.body) {
    return newContent.body
  }
  const poll =
    (content['org.matrix.msc3381.poll.start'] as
      | { question?: { 'org.matrix.msc3381.text'?: string; body?: string } }
      | undefined) ||
    (content['m.poll.start'] as
      | { question?: { 'm.text'?: string; body?: string } }
      | undefined)
  const qText =
    poll?.question?.['org.matrix.msc3381.text'] ||
    poll?.question?.['m.text'] ||
    poll?.question?.body
  if (typeof qText === 'string' && qText) return qText
  if (typeof content[ALBUM_CAPTION_KEY] === 'string') {
    return content[ALBUM_CAPTION_KEY] as string
  }
  return ''
}

function hitKey(roomId: string, eventId: string): string {
  return `${roomId}:${eventId}`
}

function sortedHits(map: Map<string, GlobalMessageHit>): GlobalMessageHit[] {
  return [...map.values()].sort((a, b) => b.ts - a.ts).slice(0, HIT_CAP)
}

function roomLastTs(room: Room): number {
  const ev = room.getLastLiveEvent?.() ?? null
  if (ev) return ev.getTs()
  const events = room.getLiveTimeline().getEvents()
  return events.at(-1)?.getTs() ?? 0
}

function eventToHit(
  room: Room,
  ev: MatrixEvent,
  q: string,
  highlights: string[],
): GlobalMessageHit | null {
  if (ev.isRedacted()) return null
  const type = ev.getType()
  if (
    type !== 'm.room.message' &&
    type !== 'm.room.encrypted' &&
    type !== 'm.sticker' &&
    type !== 'org.matrix.msc3381.poll.start' &&
    type !== 'm.poll.start'
  ) {
    return null
  }
  if (ev.isDecryptionFailure()) return null
  if (ev.isRelation?.('m.annotation')) return null
  if (ev.isRelation?.('m.replace')) return null

  const content = ev.getContent() as Record<string, unknown>
  const body = messageBodyFromContent(content)
  if (!body || !body.toLowerCase().includes(q)) return null

  const eventId = ev.getId()
  if (!eventId) return null
  const jumpId = canonicalSearchEventId(eventId, content)
  if (!jumpId) return null

  const senderId = ev.getSender() || ''
  const member = senderId ? room.getMember(senderId) : null
  return {
    eventId: jumpId,
    roomId: room.roomId,
    roomName: room.name || room.roomId,
    senderId,
    senderName:
      member?.name ||
      senderId.split(':')[0]?.substring(1) ||
      senderId ||
      'Unknown',
    body,
    ts: ev.getTs(),
    highlights,
  }
}

function scanEvents(
  room: Room,
  events: MatrixEvent[],
  q: string,
  highlights: string[],
  into: Map<string, GlobalMessageHit>,
): number {
  let added = 0
  for (const ev of events) {
    if (into.size >= HIT_CAP) break
    const hit = eventToHit(room, ev, q, highlights)
    if (!hit) continue
    const key = hitKey(hit.roomId, hit.eventId)
    if (into.has(key)) continue
    into.set(key, hit)
    added++
  }
  return added
}

type RoomScan = { room: Room; pages: number; done: boolean }

/**
 * Incremental global search session.
 * Quick phase = memory + a few server pages (no heavy scrollback).
 * deepen() = more server pages + a small scrollback batch (on demand).
 */
export class GlobalMessageSearchSession {
  readonly query: string
  private readonly client: MatrixClient
  private readonly q: string
  private readonly highlights: string[]
  private readonly byKey = new Map<string, GlobalMessageHit>()
  private readonly rooms: RoomScan[]
  private serverNextBatch: string | undefined
  private serverDone = false
  private aborted = false
  private busy = false

  constructor(client: MatrixClient, query: string) {
    this.client = client
    this.query = query.trim()
    this.q = this.query.toLowerCase()
    this.highlights = [this.query]
    this.rooms = client
      .getRooms()
      .filter((r) => r.getMyMembership() === 'join' && !r.isSpaceRoom())
      .sort((a, b) => roomLastTs(b) - roomLastTs(a))
      .map((room) => ({ room, pages: 0, done: false }))
  }

  abort() {
    this.aborted = true
  }

  snapshot(status: string, busy = this.busy): GlobalSearchSnapshot {
    return {
      hits: sortedHits(this.byKey),
      busy,
      canDeepen: this.computeCanDeepen(),
      status,
    }
  }

  private computeCanDeepen(): boolean {
    if (this.byKey.size >= HIT_CAP) return false
    if (!this.serverDone) return true
    return this.rooms.some(
      (s) => !s.done && s.pages < MAX_PAGES_PER_ROOM,
    )
  }

  private async fetchServerPages(maxPages: number): Promise<void> {
    if (this.serverDone || this.aborted) return

    for (let page = 0; page < maxPages; page++) {
      if (this.aborted || this.byKey.size >= HIT_CAP) break
      try {
        const results = await this.client.search({
          body: {
            search_categories: {
              room_events: {
                search_term: this.query,
                order_by: 'recent' as const,
                event_context: {
                  before_limit: 0,
                  after_limit: 0,
                  include_profile: true,
                },
              },
            },
          },
          ...(this.serverNextBatch
            ? { next_batch: this.serverNextBatch }
            : {}),
        })

        const roomEvents = results.search_categories.room_events
        const pageHighlights = roomEvents.highlights?.length
          ? roomEvents.highlights
          : this.highlights

        for (const item of roomEvents.results || []) {
          if (this.byKey.size >= HIT_CAP) break
          const ev = item.result
          if (!ev?.event_id || !ev.room_id) continue
          const content = (ev.content || {}) as Record<string, unknown>
          const jumpId = canonicalSearchEventId(ev.event_id, content)
          if (!jumpId) continue
          const body = messageBodyFromContent(content)
          if (!body) continue
          const key = hitKey(ev.room_id, jumpId)
          if (this.byKey.has(key)) continue

          const room = this.client.getRoom(ev.room_id)
          const profile = item.context?.profile_info?.[ev.sender]
          const member = room?.getMember(ev.sender)
          this.byKey.set(key, {
            eventId: jumpId,
            roomId: ev.room_id,
            roomName: room?.name || ev.room_id,
            senderId: ev.sender || '',
            senderName:
              profile?.displayname ||
              member?.name ||
              ev.sender?.split(':')[0]?.substring(1) ||
              ev.sender ||
              'Unknown',
            body,
            ts: ev.origin_server_ts || 0,
            highlights: pageHighlights,
          })
        }

        const nb = roomEvents.next_batch
        if (!nb || nb === this.serverNextBatch) {
          this.serverDone = true
          break
        }
        this.serverNextBatch = nb
        await yieldToUi()
      } catch (err) {
        console.warn('Global server message search failed', err)
        this.serverDone = true
        break
      }
    }
  }

  private async scrollbackBatch(maxCalls: number): Promise<number> {
    let calls = 0
    let guard = 0
    while (
      !this.aborted &&
      calls < maxCalls &&
      this.byKey.size < HIT_CAP &&
      guard < maxCalls * 3
    ) {
      guard++
      const scan = this.rooms.find(
        (s) => !s.done && s.pages < MAX_PAGES_PER_ROOM,
      )
      if (!scan) break

      const { room } = scan
      const before = room.getLiveTimeline().getEvents().length
      try {
        await this.client.scrollback(room, SCROLLBACK_SIZE)
      } catch (err) {
        console.warn('Global search scrollback failed', room.roomId, err)
        scan.done = true
        continue
      }
      calls++
      scan.pages++

      const all = room.getLiveTimeline().getEvents()
      const after = all.length
      if (after <= before) {
        scan.done = true
        continue
      }
      scanEvents(
        room,
        all.slice(0, after - before),
        this.q,
        this.highlights,
        this.byKey,
      )
      await yieldToUi()
    }
    return calls
  }

  /** Memory + limited server — no heavy history crawl. */
  async runQuick(
    onProgress?: (snap: GlobalSearchSnapshot) => void,
  ): Promise<GlobalSearchSnapshot> {
    if (!this.query) {
      return this.snapshot('', false)
    }
    this.busy = true
    onProgress?.(this.snapshot('В памяти…', true))

    for (const scan of this.rooms) {
      if (this.aborted) break
      scanEvents(
        scan.room,
        scan.room.getLiveTimeline().getEvents(),
        this.q,
        this.highlights,
        this.byKey,
      )
    }
    onProgress?.(
      this.snapshot(
        this.byKey.size
          ? `Найдено: ${this.byKey.size}`
          : 'Ищем на сервере…',
        true,
      ),
    )
    await yieldToUi()

    if (!this.aborted) {
      await this.fetchServerPages(QUICK_SERVER_PAGES)
    }

    this.busy = false
    const snap = this.snapshot(
      this.byKey.size
        ? `Показано из найденных · ${this.byKey.size}`
        : this.computeCanDeepen()
          ? 'В кэше пусто — можно искать в истории'
          : 'Ничего не найдено',
      false,
    )
    onProgress?.(snap)
    return snap
  }

  /** Fetch next batch of history / server pages (user-driven). */
  async deepen(
    onProgress?: (snap: GlobalSearchSnapshot) => void,
  ): Promise<GlobalSearchSnapshot> {
    if (this.aborted || this.busy || !this.computeCanDeepen()) {
      return this.snapshot(
        this.byKey.size ? `Найдено: ${this.byKey.size}` : '',
        false,
      )
    }

    this.busy = true
    const beforeCount = this.byKey.size
    onProgress?.(this.snapshot('Подгружаем историю…', true))

    if (!this.serverDone) {
      await this.fetchServerPages(DEEPEN_SERVER_PAGES)
    }

    if (!this.aborted && this.byKey.size < HIT_CAP) {
      await this.scrollbackBatch(SCROLLBACK_BATCH)
    }

    // Rescan memory for decrypt races after scrollback
    if (!this.aborted) {
      for (const scan of this.rooms) {
        scanEvents(
          scan.room,
          scan.room.getLiveTimeline().getEvents(),
          this.q,
          this.highlights,
          this.byKey,
        )
      }
    }

    this.busy = false
    const added = this.byKey.size - beforeCount
    const snap = this.snapshot(
      added > 0
        ? `+${added} · всего ${this.byKey.size}`
        : this.computeCanDeepen()
          ? `Ещё ищем… · ${this.byKey.size}`
          : `Всё · ${this.byKey.size}`,
      false,
    )
    onProgress?.(snap)
    return snap
  }
}
