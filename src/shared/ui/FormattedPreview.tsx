import React, { type ReactNode } from 'react'
import { RelationType, type MatrixEvent, type Room } from 'matrix-js-sdk'
import { format } from 'date-fns'
import { SpoilerText } from '@/shared/ui/SpoilerText'
import { isThreadReplyEvent } from '@/shared/lib/threads'
import {
  buildCallHistoryMap,
  callHistoryPreviewText,
  getCallId,
  isCallLifecycleEvent,
} from '@/shared/lib/callTimeline'

function stripMxReply(html: string): string {
  return html.replace(/<mx-reply[\s\S]*?<\/mx-reply>/gi, '')
}

/**
 * Render Matrix HTML as a one-line rich preview (spoilers stay hidden).
 */
export function renderFormattedPreview(
  rawHtml: string,
  maxChars = 140,
): ReactNode {
  if (typeof DOMParser === 'undefined') return null
  const cleaned = stripMxReply(rawHtml).trim()
  if (!cleaned) return null

  try {
    const doc = new DOMParser().parseFromString(cleaned, 'text/html')
    const root = doc.body
    if (!root) return null

    let used = 0
    const out: ReactNode[] = []
    let key = 0

    const pushText = (text: string) => {
      if (!text || used >= maxChars) return
      const left = maxChars - used
      const slice = text.length > left ? `${text.slice(0, left)}…` : text
      used += slice.length
      out.push(<React.Fragment key={`t${key++}`}>{slice}</React.Fragment>)
    }

    const walk = (node: Node): void => {
      if (used >= maxChars) return
      if (node.nodeType === 3) {
        pushText(node.textContent ?? '')
        return
      }
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      const tag = el.tagName.toUpperCase()

      if (tag === 'MX-REPLY') return
      if (tag === 'BR') {
        pushText(' ')
        return
      }

      if (tag === 'SPAN' && el.hasAttribute('data-mx-spoiler')) {
        const plain = (el.textContent ?? '').replace(/\s+/g, ' ').trim() || '•••'
        const left = maxChars - used
        const shown = plain.length > left ? `${plain.slice(0, left)}…` : plain
        used += shown.length
        out.push(
          <SpoilerText key={`s${key++}`} mode="preview">
            {shown}
          </SpoilerText>,
        )
        return
      }

      const wrap = (
        Wrapper: 'strong' | 'em' | 'u' | 'del' | 'code' | 'span',
        className?: string,
      ) => {
        const before = out.length
        const beforeUsed = used
        Array.from(el.childNodes).forEach(walk)
        const nodes = out.splice(before)
        if (!nodes.length) {
          used = beforeUsed
          return
        }
        out.push(
          <Wrapper key={`w${key++}`} className={className}>
            {nodes}
          </Wrapper>,
        )
      }

      if (tag === 'STRONG' || tag === 'B') {
        wrap('strong', 'font-semibold')
        return
      }
      if (tag === 'EM' || tag === 'I') {
        wrap('em', 'italic')
        return
      }
      if (tag === 'U') {
        wrap('u', 'underline underline-offset-1')
        return
      }
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
        wrap('del', 'line-through opacity-80')
        return
      }
      if (tag === 'CODE' || tag === 'PRE') {
        wrap('code', 'tg-preview-code')
        return
      }
      if (tag === 'BLOCKQUOTE') {
        pushText('«')
        Array.from(el.childNodes).forEach(walk)
        pushText('» ')
        return
      }
      if (tag === 'A') {
        Array.from(el.childNodes).forEach(walk)
        return
      }

      Array.from(el.childNodes).forEach(walk)
    }

    Array.from(root.childNodes).forEach(walk)
    if (!out.length) return null
    return <>{out}</>
  } catch {
    return null
  }
}

function isReplaceEvent(ev: MatrixEvent): boolean {
  if (ev.isRelation?.(RelationType.Replace)) return true
  const relation = ev.getRelation?.()
  if (
    relation?.rel_type === RelationType.Replace ||
    relation?.rel_type === 'm.replace'
  ) {
    return true
  }
  const rel = (
    ev.getContent() as { 'm.relates_to'?: { rel_type?: string } }
  )?.['m.relates_to']
  return rel?.rel_type === RelationType.Replace || rel?.rel_type === 'm.replace'
}

function isMessageEdited(ev: MatrixEvent): boolean {
  return !!(ev.replacingEvent?.() || ev.replacingEventId?.())
}

function effectiveContent(ev: MatrixEvent): Record<string, unknown> {
  const replacing = ev.replacingEvent?.()
  if (replacing) {
    const c = replacing.getContent() as Record<string, unknown>
    const neu = c['m.new_content']
    if (neu && typeof neu === 'object') return neu as Record<string, unknown>
    return c
  }
  return ev.getContent() as Record<string, unknown>
}

function plainBodyFromContent(content: Record<string, unknown>): string {
  const formatted =
    typeof content.formatted_body === 'string' ? content.formatted_body : ''
  if (formatted.trim()) {
    let s = stripMxReply(formatted)
    s = s.replace(
      /<span[^>]*data-mx-spoiler[^>]*>[\s\S]*?<\/span>/gi,
      'скрыто',
    )
    s = s.replace(/<br\s*\/?>/gi, ' ')
    s = s.replace(/<[^>]+>/g, '')
    s = s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim()
    if (s) return s
  }

  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  return body.replace(/^([•*]\s+)/, '').replace(/\s+/g, ' ').trim()
}

export type RoomLastPreview = {
  plain: string
  node: ReactNode
  time: string
  edited: boolean
}

export function getRoomLastMessagePreview(room: Room): RoomLastPreview {
  const events = room.getLiveTimeline().getEvents()
  const myUserId = room.client?.getUserId?.() || ''
  let callMap: ReturnType<typeof buildCallHistoryMap> | null = null

  let lastEvent: MatrixEvent | null = null
  let callPreview: string | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    const type = ev.getType()

    if (type === 'm.reaction' || ev.isRelation?.(RelationType.Annotation)) {
      continue
    }
    if (isReplaceEvent(ev) || ev.isRedacted()) continue
    // Thread replies belong in the thread panel, not the room list tip
    if (isThreadReplyEvent(ev)) continue

    if (isCallLifecycleEvent(ev)) {
      const callId = getCallId(ev)
      if (!callId || !myUserId) continue
      if (!callMap) callMap = buildCallHistoryMap(events, myUserId)
      const summary = callMap.get(callId)
      if (!summary) continue
      callPreview = callHistoryPreviewText(summary)
      lastEvent = summary.anchorEvent
      break
    }

    if (
      type === 'm.room.message' ||
      type === 'm.sticker' ||
      type === 'm.room.encrypted' ||
      type === 'org.matrix.msc3381.poll.start' ||
      type === 'm.poll.start' ||
      ev.isDecryptionFailure()
    ) {
      lastEvent = ev
      break
    }
  }

  if (!lastEvent) {
    return { plain: '', node: null, time: '', edited: false }
  }

  const content = effectiveContent(lastEvent)
  const sender = lastEvent.getSender() || ''
  const edited = isMessageEdited(lastEvent)
  const time = lastEvent.getTs()
    ? format(new Date(lastEvent.getTs()), 'HH:mm')
    : ''
  const body = plainBodyFromContent(content)

  let text = ''
  let rich: ReactNode = null

  if (callPreview) {
    text = callPreview
  } else if (
    lastEvent.isDecryptionFailure() ||
    body.startsWith('Unable to decrypt')
  ) {
    text = '🔒 Зашифрованное сообщение'
  } else if (lastEvent.getType() === 'm.sticker') {
    text = '🎟 Стикер'
  } else if (
    lastEvent.getType() === 'org.matrix.msc3381.poll.start' ||
    lastEvent.getType() === 'm.poll.start' ||
    !!(content as any)['org.matrix.msc3381.poll.start'] ||
    !!(content as any)['m.poll.start']
  ) {
    text = '📊 Опрос'
  } else if (content.msgtype === 'm.image') {
    text = '📷 Фотография'
  } else if (content.msgtype === 'm.audio') {
    text = '🎤 Голосовое сообщение'
  } else if (content.msgtype === 'm.video') {
    text = '🎬 Видео'
  } else if (content.msgtype === 'm.file') {
    text = '📄 Файл'
  } else if (content.msgtype === 'm.emote') {
    text = body ? `* ${body}` : '* действие'
  } else if (body || content.formatted_body) {
    text = body || 'Сообщение'
    const formatted =
      typeof content.formatted_body === 'string' ? content.formatted_body : ''
    if (
      (content.format === 'org.matrix.custom.html' || formatted) &&
      formatted.trim()
    ) {
      rich = renderFormattedPreview(formatted)
    }
  } else if (lastEvent.isEncrypted()) {
    text = '🔒 Зашифрованное сообщение'
  } else {
    text = 'Сообщение'
  }

  const isGroupChat = room.getJoinedMemberCount() > 2
  let authorPrefix = ''

  // Call history is a system-style tip — no sender prefix
  if (!callPreview && isGroupChat && sender) {
    const member = lastEvent.sender
    const shortName =
      member?.name || sender.split(':')[0].substring(1) || 'Кто-то'
    authorPrefix = `${shortName}: `
  }

  const plain = `${authorPrefix}${text}`
  const node = (
    <>
      {authorPrefix}
      {rich ?? text}
    </>
  )

  return { plain, node, time, edited }
}
