import type { MatrixEvent } from 'matrix-js-sdk'

/** Minimal row shape needed for jump / pin sync. */
export type TimelineJumpRow = {
  item:
    | { kind: 'album'; events: MatrixEvent[]; imageEvents: MatrixEvent[] }
    | { kind: 'single'; event: MatrixEvent }
  dayChanged: boolean
  showUnreadSep: boolean
  isContinuation: boolean
  firstEvent: MatrixEvent
}

export type JumpToEventOptions = {
  mediaIds?: string[]
  highlightMs?: number
  highlightText?: string
  align?: 'center' | 'start' | 'end'
}

export function findTimelineRowIndex(
  rows: TimelineJumpRow[],
  eventId: string,
): number {
  return rows.findIndex((row) => {
    if (row.item.kind === 'album') {
      return (
        row.item.events.some((e) => e.getId() === eventId) ||
        row.item.imageEvents.some((e) => e.getId() === eventId)
      )
    }
    return row.item.event.getId() === eventId
  })
}

/**
 * Stable virtualizer estimate. Prefer slight OVER-estimate so unmeasured
 * rows leave a gap instead of overlapping neighbours; TanStack corrects
 * estimate→actual on first measure with its built-in scroll adjust.
 */
export function estimateTimelineRowSize(row: TimelineJumpRow): number {
  let h = 0
  if (row.dayChanged) h += 40
  if (row.showUnreadSep) h += 44
  // Row spacing via padding inside the measured element
  h += row.isContinuation ? 8 : 14

  if (row.item.kind === 'album') {
    const n = Math.min(4, row.item.imageEvents.length)
    // Reserved media blocks — over-estimate
    h += n <= 1 ? 300 : n === 2 ? 220 : 320
    return h
  }

  const event = row.item.event
  const content = event.getContent() as Record<string, unknown>
  const msgtype = content.msgtype as string | undefined

  if (content['m.relates_to'] && typeof content['m.relates_to'] === 'object') {
    const rel = content['m.relates_to'] as Record<string, unknown>
    if (rel['m.in_reply_to']) h += 36
  }

  if (msgtype === 'm.image' || msgtype === 'm.video') {
    const info = content.info as
      | { w?: number; h?: number; thumbnail_info?: { w?: number; h?: number } }
      | undefined
    const w = info?.thumbnail_info?.w || info?.w
    const hMedia = info?.thumbnail_info?.h || info?.h
    if (w && hMedia && w > 0 && hMedia > 0) {
      const scale = Math.min(280 / w, 280 / hMedia, 1)
      h += Math.max(120, Math.round(hMedia * scale)) + 24
    } else {
      h += 300
    }
  } else if (event.getType() === 'm.sticker') {
    h += 160
  } else if (msgtype === 'm.audio') {
    h += 80
  } else if (msgtype === 'm.file') {
    h += 64
  } else {
    // Plain text — baseline ~60, grow with body length (still over-estimate)
    const body = typeof content.body === 'string' ? content.body : ''
    const lines = Math.min(10, Math.max(1, Math.ceil(body.length / 34)))
    h += Math.max(60, 28 + lines * 20)
  }

  // Soft pad for sender name / reactions / read strip
  if (!row.isContinuation) h += 16
  h += 16
  return h
}

export function findMsgDomEl(eventId: string): HTMLElement | null {
  return (
    document.getElementById(`message-${eventId}`) ||
    document.getElementById(`msg-${eventId}`) ||
    document.getElementById(`msg-media-${eventId}`)
  )
}
