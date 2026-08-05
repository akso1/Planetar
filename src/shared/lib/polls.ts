import {
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk'

export const POLL_START = 'org.matrix.msc3381.poll.start'
export const POLL_START_STABLE = 'm.poll.start'
export const POLL_RESPONSE = 'org.matrix.msc3381.poll.response'
export const POLL_RESPONSE_STABLE = 'm.poll.response'
export const POLL_END = 'org.matrix.msc3381.poll.end'
export const POLL_END_STABLE = 'm.poll.end'
export const POLL_KIND_DISCLOSED = 'org.matrix.msc3381.poll.disclosed'
export const TEXT_KEY = 'org.matrix.msc1767.text'
export const TEXT_KEY_STABLE = 'm.text'

export type PollAnswer = { id: string; text: string }

export type ParsedPollStart = {
  question: string
  answers: PollAnswer[]
  maxSelections: number
  kind: string
  ended: boolean
}

function readTextField(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    for (const part of value) {
      if (typeof part === 'string' && part.trim()) return part.trim()
      if (part && typeof part === 'object') {
        const body = (part as { body?: unknown }).body
        if (typeof body === 'string' && body.trim()) return body.trim()
      }
    }
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o[TEXT_KEY] === 'string') return String(o[TEXT_KEY]).trim()
    if (typeof o[TEXT_KEY_STABLE] === 'string')
      return String(o[TEXT_KEY_STABLE]).trim()
    if (typeof o.body === 'string') return o.body.trim()
  }
  return ''
}

export function isPollStartEvent(event: MatrixEvent): boolean {
  const t = event.getType()
  return t === POLL_START || t === POLL_START_STABLE
}

export function isPollResponseEvent(event: MatrixEvent): boolean {
  const t = event.getType()
  return t === POLL_RESPONSE || t === POLL_RESPONSE_STABLE
}

export function isPollEndEvent(event: MatrixEvent): boolean {
  const t = event.getType()
  return t === POLL_END || t === POLL_END_STABLE
}

export function parsePollStart(event: MatrixEvent): ParsedPollStart | null {
  if (!isPollStartEvent(event) && !looksLikePollInMessage(event)) return null
  const content = event.getContent() as Record<string, unknown>
  const block =
    (content[POLL_START] as Record<string, unknown> | undefined) ||
    (content[POLL_START_STABLE] as Record<string, unknown> | undefined) ||
    (content['m.poll'] as Record<string, unknown> | undefined)
  if (!block || typeof block !== 'object') return null

  const question = readTextField(block.question) || readTextField(content.body)
  const rawAnswers = Array.isArray(block.answers) ? block.answers : []
  const answers: PollAnswer[] = []
  for (const a of rawAnswers) {
    if (!a || typeof a !== 'object') continue
    const row = a as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : String(row['m.id'] || '')
    if (!id) continue
    const text =
      readTextField(row[TEXT_KEY]) ||
      readTextField(row[TEXT_KEY_STABLE]) ||
      readTextField(row) ||
      id
    answers.push({ id, text })
  }
  if (!question || answers.length < 2) return null

  const maxSelections =
    typeof block.max_selections === 'number' && block.max_selections > 0
      ? Math.floor(block.max_selections)
      : 1
  const kind =
    typeof block.kind === 'string' ? block.kind : POLL_KIND_DISCLOSED

  return { question, answers, maxSelections, kind, ended: false }
}

function looksLikePollInMessage(event: MatrixEvent): boolean {
  const c = event.getContent() as Record<string, unknown>
  return !!(c[POLL_START] || c[POLL_START_STABLE])
}

/** Poll start as `m.poll.start` or as `m.room.message` with poll payload. */
export function isPollMessageEvent(event: MatrixEvent): boolean {
  return isPollStartEvent(event) || looksLikePollInMessage(event)
}

export function buildPollStartContent(opts: {
  question: string
  answers: string[]
  maxSelections?: number
}): Record<string, unknown> {
  const question = opts.question.trim()
  const cleaned = opts.answers.map((a) => a.trim()).filter(Boolean).slice(0, 10)
  const maxSelections = opts.maxSelections && opts.maxSelections > 1 ? opts.maxSelections : 1
  const answers = cleaned.map((text, i) => ({
    id: `o${i + 1}`,
    [TEXT_KEY]: text,
    [TEXT_KEY_STABLE]: text,
  }))
  const fallback = [
    question,
    ...answers.map((a, i) => `${i + 1}. ${a[TEXT_KEY]}`),
  ].join('\n')

  const pollBlock = {
    question: {
      [TEXT_KEY]: question,
      [TEXT_KEY_STABLE]: question,
    },
    kind: POLL_KIND_DISCLOSED,
    max_selections: maxSelections,
    answers,
  }

  return {
    [POLL_START]: pollBlock,
    [POLL_START_STABLE]: pollBlock,
    [TEXT_KEY]: fallback,
    [TEXT_KEY_STABLE]: fallback,
    body: fallback,
    msgtype: 'm.text',
  }
}

export function buildPollResponseContent(
  pollEventId: string,
  answerIds: string[],
): Record<string, unknown> {
  const response = { answers: answerIds }
  return {
    'm.relates_to': {
      rel_type: 'm.reference',
      event_id: pollEventId,
    },
    [POLL_RESPONSE]: response,
    [POLL_RESPONSE_STABLE]: response,
  }
}

export function buildPollEndContent(pollEventId: string): Record<string, unknown> {
  return {
    'm.relates_to': {
      rel_type: 'm.reference',
      event_id: pollEventId,
    },
    [POLL_END]: {},
    [POLL_END_STABLE]: {},
    [TEXT_KEY]: 'Опрос завершён',
    body: 'Опрос завершён',
  }
}

export function pollResponseAnswerIds(event: MatrixEvent): string[] {
  const c = event.getContent() as Record<string, unknown>
  const block =
    (c[POLL_RESPONSE] as { answers?: unknown } | undefined) ||
    (c[POLL_RESPONSE_STABLE] as { answers?: unknown } | undefined)
  if (!block || !Array.isArray(block.answers)) return []
  return block.answers.filter((id): id is string => typeof id === 'string')
}

export function referencedEventId(event: MatrixEvent): string | null {
  const rel = event.getRelation?.()
  if (rel?.rel_type === 'm.reference' && typeof rel.event_id === 'string') {
    return rel.event_id
  }
  const c = event.getContent() as Record<string, unknown>
  const wire = c['m.relates_to'] as
    | { rel_type?: string; event_id?: string }
    | undefined
  if (wire?.rel_type === 'm.reference' && typeof wire.event_id === 'string') {
    return wire.event_id
  }
  return null
}

export type PollTally = {
  counts: Record<string, number>
  totalVoters: number
  myAnswers: string[]
  ended: boolean
}

/** Collect latest vote per sender from related response events. */
export function tallyPollVotes(
  responses: MatrixEvent[],
  myUserId: string | null,
  endTs?: number | null,
): PollTally {
  const bySender = new Map<string, MatrixEvent>()
  for (const ev of responses) {
    if (!isPollResponseEvent(ev)) continue
    if (endTs != null && ev.getTs() > endTs) continue
    const sender = ev.getSender()
    if (!sender) continue
    const prev = bySender.get(sender)
    if (!prev || ev.getTs() >= prev.getTs()) bySender.set(sender, ev)
  }

  const counts: Record<string, number> = {}
  let myAnswers: string[] = []
  for (const [sender, ev] of bySender) {
    const ids = pollResponseAnswerIds(ev)
    for (const id of ids) counts[id] = (counts[id] || 0) + 1
    if (myUserId && sender === myUserId) myAnswers = ids
  }
  return {
    counts,
    totalVoters: bySender.size,
    myAnswers,
    ended: endTs != null,
  }
}

export async function fetchPollRelatedEvents(
  client: MatrixClient,
  room: Room,
  pollEventId: string,
): Promise<{ responses: MatrixEvent[]; endEvent: MatrixEvent | null }> {
  const responses: MatrixEvent[] = []
  let endEvent: MatrixEvent | null = null

  // Local scan (fast, works offline / E2EE timeline)
  const scan = (events: MatrixEvent[]) => {
    for (const ev of events) {
      if (referencedEventId(ev) !== pollEventId) continue
      if (isPollResponseEvent(ev)) responses.push(ev)
      if (isPollEndEvent(ev)) {
        if (!endEvent || ev.getTs() >= endEvent.getTs()) endEvent = ev
      }
    }
  }
  // Live timeline + any paginated/orphan timelines on the unfiltered set
  const timelines = room.getUnfilteredTimelineSet().getTimelines()
  for (const tl of timelines) scan(tl.getEvents())

  try {
    const page = await client.relations(
      room.roomId,
      pollEventId,
      'm.reference',
      undefined,
      { limit: 100 },
    )
    for (const ev of page.events || []) {
      if (isPollResponseEvent(ev)) {
        const id = ev.getId()
        if (id && !responses.some((r) => r.getId() === id)) responses.push(ev)
      }
      if (isPollEndEvent(ev)) {
        if (!endEvent || ev.getTs() >= endEvent.getTs()) endEvent = ev
      }
    }
  } catch (err) {
    console.warn('Poll relations fetch failed', err)
  }

  return { responses, endEvent }
}

export function pollNotificationSnippet(event: MatrixEvent): string | null {
  const parsed = parsePollStart(event)
  if (!parsed) return null
  return `📊 Опрос: ${parsed.question}`
}
