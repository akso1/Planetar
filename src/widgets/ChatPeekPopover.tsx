import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import {
  RelationType,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk'
import { EyeOff, X } from 'lucide-react'
import { format } from 'date-fns'
import { useSessionStore } from '@/entities/session/model/session'
import { getRoomUnread } from '@/entities/session/model/room.store'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { MessageBody } from '@/shared/ui/MessageBody'
import { getUserColor } from '@/shared/lib/color'
import {
  clampMenuPosition,
  viewportBounds,
} from '@/shared/lib/clampMenuPosition'

export type ChatPeekAnchor = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

type ChatPeekPopoverProps = {
  room: Room
  anchor: ChatPeekAnchor
  onClose: () => void
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

function isPeekMessage(ev: MatrixEvent): boolean {
  if (ev.isRedacted()) return false
  if (ev.getType() === 'm.reaction' || ev.isRelation?.(RelationType.Annotation)) {
    return false
  }
  if (isReplaceEvent(ev)) return false
  const t = ev.getType()
  return (
    t === 'm.room.message' ||
    t === 'm.sticker' ||
    t === 'm.room.encrypted' ||
    ev.isDecryptionFailure()
  )
}

function collectPeekEvents(room: Room, limit = 40): MatrixEvent[] {
  const events = room.getLiveTimeline().getEvents()
  const out: MatrixEvent[] = []
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const ev = events[i]
    if (isPeekMessage(ev)) out.push(ev)
  }
  return out.reverse()
}

function senderLabel(ev: MatrixEvent): string {
  return (
    ev.sender?.name ||
    ev.getSender()?.split(':')[0]?.replace(/^@/, '') ||
    'Участник'
  )
}

function PeekBubble({
  event,
  isOwn,
  showSender,
  mentionMembers,
}: {
  event: MatrixEvent
  isOwn: boolean
  showSender: boolean
  mentionMembers: { userId: string; displayName: string }[]
}) {
  const content = event.getContent() as Record<string, unknown>
  const ts = event.getTs()
  const time = ts ? format(new Date(ts), 'HH:mm') : ''
  const senderId = event.getSender() || ''
  const name = senderLabel(event)

  let body: React.ReactNode
  if (event.isDecryptionFailure()) {
    body = (
      <span className="italic opacity-70">Не удалось расшифровать</span>
    )
  } else if (event.getType() === 'm.sticker' || content.msgtype === 'm.sticker') {
    body = '🎟 Стикер'
  } else if (content.msgtype === 'm.image') {
    body = '📷 Фото'
  } else if (content.msgtype === 'm.video') {
    body = '🎬 Видео'
  } else if (content.msgtype === 'm.audio') {
    body = '🎤 Голосовое'
  } else if (content.msgtype === 'm.file') {
    body = `📄 ${(content.body as string) || 'Файл'}`
  } else if (content.msgtype === 'm.emote') {
    body = (
      <MessageBody
        content={content}
        members={mentionMembers}
        className="text-[13px]"
      />
    )
  } else if (content.body || content.formatted_body) {
    body = (
      <MessageBody
        content={content}
        members={mentionMembers}
        className="text-[13px]"
      />
    )
  } else if (event.isEncrypted()) {
    body = (
      <span className="italic opacity-70">Зашифрованное сообщение</span>
    )
  } else {
    body = <span className="opacity-50">Сообщение</span>
  }

  return (
    <div
      className={clsx(
        'tg-peek-row flex w-full',
        isOwn ? 'justify-end' : 'justify-start',
      )}
    >
      <div
        className={clsx(
          'tg-peek-bubble max-w-[88%] rounded-[14px] px-2.5 py-1.5',
          isOwn ? 'tg-peek-bubble--out' : 'tg-peek-bubble--in',
        )}
      >
        {showSender && !isOwn && (
          <div
            className="text-[11.5px] font-semibold mb-0.5 truncate"
            style={{ color: getUserColor(senderId) }}
          >
            {name}
          </div>
        )}
        <div className="tg-peek-bubble-text leading-snug">{body}</div>
        {time && (
          <div
            className={clsx(
              'tg-peek-time text-[10px] mt-0.5 text-right',
              isOwn ? 'opacity-70' : 'opacity-45',
            )}
          >
            {time}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Stealth room preview — does NOT mark the room as read / send receipts.
 */
export function ChatPeekPopover({ room, anchor, onClose }: ChatPeekPopoverProps) {
  const client = useSessionStore((s) => s.client)
  const myId = client?.getUserId() ?? null
  const panelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [ready, setReady] = useState(false)

  const events = useMemo(() => collectPeekEvents(room), [room])
  const isGroup = room.getJoinedMemberCount() > 2

  const mentionMembers = useMemo(() => {
    return room.getJoinedMembers().map((m) => ({
      userId: m.userId,
      displayName: m.name || m.userId,
    }))
  }, [room])

  const unread =
    getRoomUnread(room) || 0

  useLayoutEffect(() => {
    setReady(false)
    const el = panelRef.current
    if (!el) return
    const place = () => {
      const { vw, vh, ox, oy } = viewportBounds()
      const pad = 12
      const rect = el.getBoundingClientRect()
      // Prefer to the right of the avatar (into the chat area)
      let left = anchor.right + 12
      if (left + rect.width > ox + vw - pad) {
        left = anchor.left - rect.width - 12
      }
      if (left < ox + pad) left = ox + pad

      let top = anchor.top - 8
      if (top + rect.height > oy + vh - pad) {
        top = oy + vh - pad - rect.height
      }
      if (top < oy + pad) top = oy + pad

      setPos(clampMenuPosition(left, top, rect.width, rect.height, pad))
      setReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, events.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length, ready])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    // Delay so the releasing pointer from long-press doesn't instantly close
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer)
    }, 60)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const avatarMxc = room.getMxcAvatarUrl?.() ?? null

  return createPortal(
    <div
      ref={panelRef}
      className="tg-chat-peek fixed z-[1200] flex flex-col"
      style={{
        left: pos.left,
        top: pos.top,
        visibility: ready ? 'visible' : 'hidden',
      }}
      role="dialog"
      aria-label={`Тайный просмотр: ${room.name}`}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="tg-chat-peek-card flex flex-col overflow-hidden">
        <header className="tg-chat-peek-header flex items-center gap-2.5 px-3 py-2.5 shrink-0">
          <MxcAvatar
            client={client}
            mxcUrl={avatarMxc}
            label={room.name}
            size={34}
          />
          <div className="min-w-0 flex-1">
            <div className="tg-chat-peek-title text-[13.5px] font-semibold truncate">
              {room.name}
            </div>
            <div className="tg-chat-peek-sub flex items-center gap-1 text-[11px]">
              <EyeOff className="w-3 h-3 shrink-0" strokeWidth={2.25} />
              <span className="truncate">Тайный просмотр</span>
              {unread > 0 && (
                <span className="tg-chat-peek-unread ml-1 shrink-0">
                  {unread}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full shrink-0"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div
          ref={scrollRef}
          className="tg-chat-peek-body flex-1 min-h-0 overflow-y-auto overscroll-contain px-2.5 py-2 space-y-1.5"
        >
          {events.length === 0 ? (
            <div className="text-center text-[12.5px] text-white/40 py-10 px-4">
              Пока нет сообщений для превью
            </div>
          ) : (
            events.map((ev, i) => {
              const id = ev.getId() || `${i}`
              const isOwn = !!myId && ev.getSender() === myId
              const prev = events[i - 1]
              const showSender =
                isGroup &&
                !isOwn &&
                (!prev || prev.getSender() !== ev.getSender())
              return (
                <PeekBubble
                  key={id}
                  event={ev}
                  isOwn={isOwn}
                  showSender={showSender}
                  mentionMembers={mentionMembers}
                />
              )
            })
          )}
        </div>

        <footer className="tg-chat-peek-footer px-3 py-2 text-[11px] text-white/40 shrink-0">
          Не отмечается как прочитанное
        </footer>
      </div>
    </div>,
    document.body,
  )
}
