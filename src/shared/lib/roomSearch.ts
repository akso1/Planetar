import type { MatrixClient } from 'matrix-js-sdk'

export type RoomSearchHit = {
  eventId: string
  senderId: string
  senderName: string
  snippet: string
  ts: number
}

function bodyFromContent(content: Record<string, unknown> | undefined | null): string {
  if (!content) return ''
  if (typeof content.body === 'string' && content.body) return content.body
  const newContent = content['m.new_content'] as Record<string, unknown> | undefined
  if (typeof newContent?.body === 'string' && newContent.body) return newContent.body
  return ''
}

function canonicalEventId(
  eventId: string,
  content: Record<string, unknown> | undefined | null,
): string | null {
  const rel = content?.['m.relates_to'] as
    | { rel_type?: string; event_id?: string }
    | undefined
  if (rel?.rel_type === 'm.annotation') return null
  if (rel?.rel_type === 'm.replace') {
    return typeof rel.event_id === 'string' && rel.event_id ? rel.event_id : null
  }
  return eventId
}

function hitsFromSearchResponse(
  client: MatrixClient,
  roomId: string,
  results: Awaited<ReturnType<MatrixClient['search']>>,
): { hits: RoomSearchHit[]; nextBatch: string | undefined } {
  const roomEvents = results.search_categories.room_events
  const hits: RoomSearchHit[] = []

  for (const item of roomEvents.results || []) {
    const ev = item.result
    if (!ev?.event_id || ev.room_id !== roomId) continue
    const content = (ev.content || {}) as Record<string, unknown>
    const jumpId = canonicalEventId(ev.event_id, content)
    if (!jumpId) continue
    const body = bodyFromContent(content).replace(/\s+/g, ' ').trim()
    if (!body) continue

    const room = client.getRoom(roomId)
    const profile = item.context?.profile_info?.[ev.sender]
    const member = room?.getMember(ev.sender)
    const senderName =
      profile?.displayname ||
      member?.name ||
      ev.sender?.split(':')[0]?.substring(1) ||
      ev.sender ||
      'Unknown'

    hits.push({
      eventId: jumpId,
      senderId: ev.sender || '',
      senderName,
      snippet: body.length > 120 ? `${body.slice(0, 117)}…` : body,
      ts: ev.origin_server_ts || 0,
    })
  }

  return {
    hits,
    nextBatch: roomEvents.next_batch || undefined,
  }
}

/**
 * Server-side search limited to one room.
 * Paginates via next_batch until `limit` hits or history is exhausted.
 * Note: encrypted ciphertext is usually invisible to the homeserver —
 * pair with local timeline / scrollback search for E2EE rooms.
 */
export async function searchRoomEventsServer(
  client: MatrixClient,
  roomId: string,
  query: string,
  limit = 200,
): Promise<RoomSearchHit[]> {
  const trimmed = query.trim()
  if (!trimmed || !roomId) return []

  const byId = new Map<string, RoomSearchHit>()
  let nextBatch: string | undefined

  for (let page = 0; page < 20; page++) {
    const results = await client.search({
      body: {
        search_categories: {
          room_events: {
            search_term: trimmed,
            order_by: 'recent' as const,
            filter: {
              rooms: [roomId],
            },
            event_context: {
              before_limit: 0,
              after_limit: 0,
              include_profile: true,
            },
          },
        },
      },
      ...(nextBatch ? { next_batch: nextBatch } : {}),
    })

    const parsed = hitsFromSearchResponse(client, roomId, results)
    for (const hit of parsed.hits) {
      if (!byId.has(hit.eventId)) byId.set(hit.eventId, hit)
    }

    if (byId.size >= limit) break
    if (!parsed.nextBatch || parsed.nextBatch === nextBatch) break
    nextBatch = parsed.nextBatch
  }

  return Array.from(byId.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}
