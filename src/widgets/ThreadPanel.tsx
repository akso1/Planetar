import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { format } from 'date-fns'
import { MessagesSquare, Pause, Play, X } from 'lucide-react'
import {
  EventType,
  RelationType,
  RoomEvent,
  ThreadEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk'
import { clsx } from 'clsx'
import { matrixService } from '@/shared/api/MatrixService'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { getUserColor } from '@/shared/lib/color'
import { matrixContentToComposerText } from '@/shared/lib/composerFormat'
import {
  downloadMessageAttachment,
  downloadMessageAttachmentPreview,
} from '@/shared/lib/matrixMedia'
import { getQuoteSelectionWithin, installMessageSelectionGuard, clearMessageSelectionSnap } from '@/shared/lib/messageQuote'
import { isPollStartEvent } from '@/shared/lib/polls'
import {
  ensureRoomThread,
  getThreadReplyCount,
  getThreadRootId,
  isThreadReplyEvent,
  loadRememberedThreadReplies,
  mergeThreadReply,
  rememberThreadReply,
  rememberedRepliesForRoot,
  flushThreadReplyPersist,
  sortThreadReplies,
} from '@/shared/lib/threads'
import { MessageBody } from '@/shared/ui/MessageBody'
import { MessageContextMenu } from '@/shared/ui/MessageContextMenu'
import type { BizTaskMessageRef } from '@/shared/lib/bizTasks'
import type { MentionMember } from '@/shared/ui/MessageMarkdown'
import type { MentionUserClickHandler } from '@/shared/lib/mentions'
import {
  MessageInput,
  messageSnippet,
  type EditTarget,
  type ReplyTarget,
} from './MessageInput'
import { PollCard } from './PollCard'
import { ImageViewer, type ViewerImage } from './ImageViewer'

type ThreadPanelProps = {
  isOpen: boolean
  room: Room
  client: MatrixClient
  rootEventId: string
  onClose: () => void
  members?: MentionMember[]
  onUserClick?: MentionUserClickHandler
}

function senderLabel(room: Room, event: MatrixEvent): string {
  const id = event.getSender() || ''
  const member = id ? room.getMember(id) : null
  if (member) {
    return (
      member.name ||
      member.rawDisplayName ||
      id.split(':')[0]?.substring(1) ||
      id
    )
  }
  return id.split(':')[0]?.substring(1) || id || 'Unknown'
}

function formatDurationMs(ms: unknown): string | null {
  const n = typeof ms === 'number' ? ms : Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  const sec = Math.round(n / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function threadMessagePlainText(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return ''
  const content = event.getContent() as Record<string, unknown>
  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  return body.trim()
}

function canEditThreadEvent(event: MatrixEvent, isOwn: boolean): boolean {
  if (!isOwn || event.isDecryptionFailure() || event.isRedacted()) return false
  if (isPollStartEvent(event)) return false
  const msgtype = event.getContent()?.msgtype
  return msgtype === 'm.text' || msgtype === 'm.emote'
}

async function toggleThreadReaction(
  room: Room,
  eventId: string,
  key: string,
  myUserId: string | null,
): Promise<void> {
  const client = room.client
  const relations = room.relations.getChildEventsForEvent(
    eventId,
    RelationType.Annotation,
    EventType.Reaction,
  )
  const grouped = relations?.getSortedAnnotationsByKey() ?? []
  for (const [reactionKey, events] of grouped) {
    if (reactionKey !== key) continue
    const mine = [...events].filter(
      (e) => !e.isRedacted() && e.getSender() === myUserId && e.getId(),
    )
    if (mine.length) {
      for (const e of mine) {
        try {
          await client.redactEvent(room.roomId, e.getId()!)
        } catch (err) {
          console.error('Failed to remove thread reaction', err)
        }
      }
      return
    }
  }

  if (room.hasEncryptionStateEvent()) {
    await matrixService.ensureCryptoReady()
    client.getCrypto()?.prepareToEncrypt(room)
  }
  await client.sendEvent(room.roomId, EventType.Reaction, {
    'm.relates_to': {
      rel_type: RelationType.Annotation,
      event_id: eventId,
      key,
    },
  })
}

function ThreadAudio({
  client,
  content,
}: {
  client: MatrixClient
  content: Record<string, unknown>
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const durationLabel = formatDurationMs(
    (content.info as { duration?: number } | undefined)?.duration,
  )

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    void downloadMessageAttachment(client, content as any, 'audio/ogg')
      .then((blob) => {
        if (cancelled) return
        const u = URL.createObjectURL(blob)
        revoked = u
        setUrl(u)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [client, content])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  if (error) {
    return (
      <div className="tg-bubble-text tg-msg-placeholder text-[13px]">
        Не удалось загрузить голосовое
      </div>
    )
  }
  if (!url) {
    return (
      <div className="h-9 w-[200px] rounded-lg bg-surface-inset animate-pulse" />
    )
  }

  return (
    <div className="flex items-center gap-2 min-w-[200px] py-0.5">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        className="w-8 h-8 rounded-full flex items-center justify-center bg-surface-inset shrink-0"
        aria-label={playing ? 'Пауза' : 'Слушать'}
      >
        {playing ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Play className="w-3.5 h-3.5 ml-0.5" />
        )}
      </button>
      <div className="tg-bubble-text text-[13px]">
        Голосовое{durationLabel ? ` · ${durationLabel}` : ''}
      </div>
    </div>
  )
}

function ThreadImage({
  client,
  content,
  onOpen,
}: {
  client: MatrixClient
  content: Record<string, unknown>
  onOpen?: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false
    void downloadMessageAttachmentPreview(client, content as any)
      .then((blob) => {
        if (cancelled) return
        const u = URL.createObjectURL(blob)
        revoked = u
        setUrl(u)
      })
      .catch(() => {
        /* keep placeholder */
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [client, content])

  if (!url) {
    return (
      <div className="h-28 w-40 rounded-lg bg-surface-inset animate-pulse" />
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpen?.()
      }}
      className="block cursor-zoom-in rounded-lg overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-fg)]"
      aria-label="Открыть изображение"
    >
      <img
        src={url}
        alt={typeof content.body === 'string' ? content.body : 'image'}
        className="max-w-[220px] max-h-[220px] rounded-lg object-cover"
        draggable={false}
      />
    </button>
  )
}

function ThreadReplyBody({
  event,
  room,
  client,
  myUserId,
  isOwn,
  onOpenImage,
  members = [],
  onUserClick,
}: {
  event: MatrixEvent
  room: Room
  client: MatrixClient
  myUserId: string | null
  isOwn: boolean
  onOpenImage?: (eventId: string) => void
  members?: MentionMember[]
  onUserClick?: MentionUserClickHandler
}) {
  const content = event.getContent() as Record<string, unknown>
  const msgtype = content.msgtype as string | undefined
  const isSticker = event.getType() === 'm.sticker'
  const eventId = event.getId() || ''

  if (event.isRedacted()) {
    return (
      <div className="tg-bubble-text tg-msg-placeholder text-[13px] italic">
        Сообщение удалено
      </div>
    )
  }
  if (event.isDecryptionFailure()) {
    return (
      <div className="tg-bubble-text tg-msg-placeholder text-[13px] italic">
        Не удалось расшифровать
      </div>
    )
  }
  if (isPollStartEvent(event)) {
    return (
      <PollCard
        event={event}
        room={room}
        client={client}
        myUserId={myUserId}
        isOwn={isOwn}
      />
    )
  }
  if (msgtype === 'm.audio') {
    return <ThreadAudio client={client} content={content} />
  }
  if (msgtype === 'm.image' || isSticker) {
    return (
      <ThreadImage
        client={client}
        content={content}
        onOpen={
          eventId && onOpenImage ? () => onOpenImage(eventId) : undefined
        }
      />
    )
  }
  if (msgtype === 'm.video' || msgtype === 'm.file') {
    return (
      <div className="tg-bubble-text text-[13.5px]">{messageSnippet(event)}</div>
    )
  }
  const body = typeof content.body === 'string' ? content.body : ''
  return (
    <div className="tg-bubble-text">
      <MessageBody
        content={content}
        plainText={body || undefined}
        members={members}
        onUserClick={onUserClick}
      />
    </div>
  )
}

function ThreadReplyRow({
  room,
  client,
  event,
  myUserId,
  onOpenImage,
  members = [],
  onUserClick,
  onContextMenu,
}: {
  room: Room
  client: MatrixClient
  event: MatrixEvent
  myUserId: string | null
  onOpenImage?: (eventId: string) => void
  members?: MentionMember[]
  onUserClick?: MentionUserClickHandler
  onContextMenu?: (e: React.MouseEvent, event: MatrixEvent) => void
}) {
  const senderId = event.getSender() || null
  const isOwn = !!myUserId && senderId === myUserId
  const name = senderLabel(room, event)
  const isMedia =
    !event.isRedacted() &&
    !event.isDecryptionFailure() &&
    (event.getType() === 'm.sticker' ||
      (event.getContent() as { msgtype?: string }).msgtype === 'm.image' ||
      (event.getContent() as { msgtype?: string }).msgtype === 'm.video')

  return (
    <div
      className={clsx(
        'tg-msg flex flex-col min-w-0',
        isOwn ? 'items-end' : 'items-start',
      )}
      onContextMenu={(e) => onContextMenu?.(e, event)}
    >
      {!isOwn && (
        <div
          className="tg-sender text-[12px] mb-0.5 px-1"
          style={senderId ? { color: getUserColor(senderId) } : undefined}
        >
          {name}
        </div>
      )}
      <div
        className={clsx(
          'tg-bubble max-w-[min(100%,22rem)]',
          isOwn ? 'tg-bubble--out' : 'tg-bubble--in',
          isMedia && 'tg-bubble--media overflow-hidden !p-[2px]',
        )}
      >
        <div className={clsx(!isMedia && 'tg-bubble-body')}>
          <ThreadReplyBody
            event={event}
            room={room}
            client={client}
            myUserId={myUserId}
            isOwn={isOwn}
            onOpenImage={onOpenImage}
            members={members}
            onUserClick={onUserClick}
          />
          {!isMedia && (
            <span className="tg-bubble-meta text-[10.5px] tabular-nums">
              {format(event.getTs(), 'HH:mm')}
            </span>
          )}
        </div>
      </div>
      {isMedia && (
        <span className="tg-muted text-[10.5px] tabular-nums mt-0.5 px-1">
          {format(event.getTs(), 'HH:mm')}
        </span>
      )}
    </div>
  )
}

export function ThreadPanel({
  isOpen,
  room,
  client,
  rootEventId,
  onClose,
  members = [],
  onUserClick,
}: ThreadPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [replies, setReplies] = useState<MatrixEvent[]>([])
  const [metaTick, setMetaTick] = useState(0)
  const [viewer, setViewer] = useState<{
    images: ViewerImage[]
    index: number
  } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    event: MatrixEvent
    isOwn: boolean
    quoteText?: string
  } | null>(null)
  const [composerReply, setComposerReply] = useState<ReplyTarget | null>(null)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const myUserId = client.getUserId()

  useEffect(() => installMessageSelectionGuard(), [])

  const rootEvent = useMemo(() => {
    return room.findEventById(rootEventId) ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, rootEventId, metaTick])

  const ingestEvents = useCallback(
    (events: MatrixEvent[]) => {
      setReplies((prev) => {
        let next = prev
        for (const ev of events) {
          next = mergeThreadReply(next, ev, rootEventId)
        }
        return next === prev ? prev : next
      })
    },
    [rootEventId],
  )

  const refreshFromThread = useCallback(() => {
    if (!rootEvent) return
    const thread = ensureRoomThread(room, rootEvent)
    if (!thread) return
    const remembered = new Set(rememberedRepliesForRoot(rootEventId))
    const fromTimeline = thread.timeline.filter((ev) => {
      const id = ev.getId()
      if (!id || id === rootEventId || !isThreadReplyEvent(ev)) return false
      // After reload local copies of deleted replies can still hold cleartext
      // until sync catches up — skip them here; /event restore is authoritative.
      if (remembered.has(id) && !ev.isRedacted()) return false
      return true
    })
    if (fromTimeline.length) ingestEvents(fromTimeline)

    // After redaction the SDK moves replies into the main live timeline.
    // Pull those stubs back so «Сообщение удалено» stays in the panel.
    const stubIds = new Set<string>()
    const redactedStubs: MatrixEvent[] = []
    const pushStub = (ev: MatrixEvent) => {
      const id = ev.getId()
      if (!id || id === rootEventId || stubIds.has(id)) return
      if (!ev.isRedacted()) return
      if (getThreadRootId(ev) !== rootEventId) return
      stubIds.add(id)
      redactedStubs.push(ev)
    }
    for (const ev of room.getLiveTimeline().getEvents()) {
      pushStub(ev)
    }
    if (redactedStubs.length) ingestEvents(redactedStubs)

    setMetaTick((t) => t + 1)
  }, [rootEvent, room, rootEventId, ingestEvents])

  const restoreRememberedReplies = useCallback(async () => {
    try {
      const remembered = await loadRememberedThreadReplies(
        client,
        room,
        rootEventId,
      )
      if (remembered.length) ingestEvents(remembered)
    } catch (err) {
      console.warn('[threads] remembered reply restore failed', err)
    }
    setMetaTick((t) => t + 1)
  }, [client, room, rootEventId, ingestEvents])

  const fetchRelations = useCallback(async () => {
    try {
      // Prefer stable m.thread; fall back to whatever the SDK currently prefers
      let events: MatrixEvent[] = []
      try {
        const rel = await client.relations(
          room.roomId,
          rootEventId,
          RelationType.Thread,
          null,
          { limit: 100 },
        )
        events = rel?.events ?? []
      } catch {
        /* try unstable below */
      }
      if (!events.length) {
        try {
          const rel = await client.relations(
            room.roomId,
            rootEventId,
            'io.element.thread',
            null,
            { limit: 100 },
          )
          events = rel?.events ?? []
        } catch {
          /* ignore */
        }
      }
      if (events.length) {
        const remembered = new Set(rememberedRepliesForRoot(rootEventId))
        for (const ev of events) {
          const id = ev.getId()
          if (id && id !== rootEventId) rememberThreadReply(id, rootEventId)
        }
        // Drop stale cleartext for replies we know may be deleted — restore path
        // already applied the homeserver redacted version.
        const usable = events.filter((ev) => {
          const id = ev.getId()
          if (!id || id === rootEventId) return false
          if (remembered.has(id) && !ev.isRedacted()) return false
          return true
        })
        if (usable.length) ingestEvents(usable)
        const thread = rootEvent ? ensureRoomThread(room, rootEvent) : null
        if (thread) {
          for (const ev of usable) {
            if (ev.getId() === rootEventId) continue
            if (!isThreadReplyEvent(ev)) continue
            if (thread.findEventById(ev.getId()!)) continue
            try {
              thread.addEvent(ev, false)
            } catch {
              /* ignore duplicate / canContain */
            }
          }
        }
      }
    } catch (err) {
      console.warn('[threads] relations fetch failed', err)
    }
    setMetaTick((t) => t + 1)
  }, [client, room, rootEventId, rootEvent, ingestEvents])

  useEffect(() => {
    if (!isOpen) return
    setReplies([])
    if (!rootEvent) return

    const thread = ensureRoomThread(room, rootEvent)
    refreshFromThread()
    // Server-authoritative restore first, then relations — avoids cleartext flash
    void (async () => {
      await restoreRememberedReplies()
      await fetchRelations()
    })()

    const onNewReply = (_t: unknown, event: MatrixEvent) => {
      ingestEvents([event])
      setMetaTick((n) => n + 1)
    }
    const onUpdate = () => refreshFromThread()
    const onRoomTimeline = (
      event: MatrixEvent,
      evRoom: Room | undefined,
    ) => {
      if (evRoom && evRoom.roomId !== room.roomId) return
      if (!isThreadReplyEvent(event)) return
      if (getThreadRootId(event) !== rootEventId) return
      ingestEvents([event])
    }
    const onLocalEcho = (event: MatrixEvent) => {
      if (!isThreadReplyEvent(event)) return
      if (getThreadRootId(event) !== rootEventId) return
      ingestEvents([event])
    }
    // SDK moves redacted replies out of the thread timeline — keep our local
    // bubble and re-render so it shows «Сообщение удалено» instead of vanishing
    // into the main room list.
    const onRedaction = (
      _redaction: MatrixEvent,
      evRoom: Room,
      threadRootId?: string,
    ) => {
      if (evRoom.roomId !== room.roomId) return
      if (threadRootId !== rootEventId) return
      setMetaTick((n) => n + 1)
      void restoreRememberedReplies()
    }

    thread?.on(ThreadEvent.NewReply, onNewReply)
    thread?.on(ThreadEvent.Update, onUpdate)
    // Thread re-emits its timeline as RoomEvent.Timeline on the Thread object
    thread?.on(RoomEvent.Timeline, onRoomTimeline as any)
    room.on(RoomEvent.Timeline, onRoomTimeline)
    room.on(RoomEvent.LocalEchoUpdated, onLocalEcho)
    room.on(RoomEvent.Redaction, onRedaction)

    return () => {
      thread?.off(ThreadEvent.NewReply, onNewReply)
      thread?.off(ThreadEvent.Update, onUpdate)
      thread?.off(RoomEvent.Timeline, onRoomTimeline as any)
      room.off(RoomEvent.Timeline, onRoomTimeline)
      room.off(RoomEvent.LocalEchoUpdated, onLocalEcho)
      room.off(RoomEvent.Redaction, onRedaction)
    }
  }, [
    isOpen,
    room,
    rootEvent,
    rootEventId,
    refreshFromThread,
    fetchRelations,
    restoreRememberedReplies,
    ingestEvents,
  ])

  useEffect(() => {
    if (!isOpen) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isOpen, replies.length])

  const rootSnippet = useMemo(() => {
    if (!rootEvent) return 'Сообщение'
    if (rootEvent.isRedacted()) return 'Сообщение удалено'
    const c = rootEvent.getContent() as Record<string, unknown>
    if (typeof c.body === 'string' && c.body.trim()) {
      return c.body.trim().slice(0, 160)
    }
    const mt = c.msgtype
    if (mt === 'm.image') return 'Фото'
    if (mt === 'm.video') return 'Видео'
    if (mt === 'm.audio') return 'Аудио'
    if (mt === 'm.file') return 'Файл'
    if (rootEvent.getType() === 'm.sticker') return 'Стикер'
    return 'Сообщение'
  }, [rootEvent])

  const replyCount = Math.max(
    rootEvent ? getThreadReplyCount(room, rootEvent) : 0,
    replies.filter((r) => !r.isRedacted()).length,
  )

  const lastReplyId =
    replies.length > 0
      ? replies[replies.length - 1]?.getId() || rootEventId
      : rootEventId

  const handleSent = useCallback(() => {
    // Local echo may land a moment later — refresh from thread + server
    refreshFromThread()
    window.setTimeout(() => {
      refreshFromThread()
      void fetchRelations()
    }, 400)
  }, [refreshFromThread, fetchRelations])

  const galleryImages: ViewerImage[] = useMemo(() => {
    const out: ViewerImage[] = []
    for (const ev of sortThreadReplies(replies)) {
      if (ev.isRedacted() || ev.isDecryptionFailure()) continue
      const content = ev.getContent() as Record<string, unknown>
      const isImage =
        content.msgtype === 'm.image' || ev.getType() === 'm.sticker'
      if (!isImage) continue
      const id = ev.getId()
      if (!id) continue
      out.push({
        id,
        content: content as ViewerImage['content'],
        name:
          typeof content.body === 'string' && content.body.trim()
            ? content.body
            : 'image.jpg',
      })
    }
    return out
  }, [replies])

  const openImage = useCallback(
    (eventId: string) => {
      const index = galleryImages.findIndex((img) => img.id === eventId)
      if (index < 0) return
      setViewer({ images: galleryImages, index })
    },
    [galleryImages],
  )

  const openContextMenu = useCallback(
    (e: React.MouseEvent, event: MatrixEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!event.getId() || event.isRedacted()) return
      const msgRoot =
        (e.target as HTMLElement | null)?.closest?.('.tg-msg') ?? null
      const quoteText = getQuoteSelectionWithin(msgRoot) || undefined
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        event,
        isOwn: event.getSender() === myUserId,
        quoteText,
      })
    },
    [myUserId],
  )

  const handleReplyFromMenu = useCallback(
    (event: MatrixEvent, quoteText?: string) => {
      const id = event.getId()
      if (!id) return
      setEditTarget(null)
      setComposerReply({
        eventId: id,
        senderName: senderLabel(room, event),
        senderId: event.getSender() || undefined,
        snippet: messageSnippet(event),
        quoteText,
      })
    },
    [room],
  )

  const handleEditFromMenu = useCallback((event: MatrixEvent) => {
    const id = event.getId()
    if (!id || !canEditThreadEvent(event, true)) return
    setComposerReply(null)
    const content = event.getContent() as Record<string, unknown>
    setEditTarget({
      eventId: id,
      body: matrixContentToComposerText(content),
      msgtype: typeof content.msgtype === 'string' ? content.msgtype : 'm.text',
    })
  }, [])

  const handleCopyFromMenu = useCallback(
    async (event: MatrixEvent, selectedText?: string) => {
      const text =
        selectedText?.trim() ||
        threadMessagePlainText(event) ||
        messageSnippet(event)
      if (!text) return
      await copyTextToClipboard(text)
      clearMessageSelectionSnap()
    },
    [],
  )

  const handleDeleteFromMenu = useCallback(
    async (event: MatrixEvent) => {
      const id = event.getId()
      if (!id) return
      if (!window.confirm('Удалить сообщение?')) return
      // Persist before redact — SDK will strip m.relates_to and move the event
      rememberThreadReply(id, rootEventId)
      flushThreadReplyPersist()
      try {
        await client.redactEvent(room.roomId, id)
        setMetaTick((n) => n + 1)
      } catch (err) {
        console.error('Failed to redact thread message', err)
      }
    },
    [client, room.roomId, rootEventId],
  )

  const handleReactFromMenu = useCallback(
    async (event: MatrixEvent, emoji: string) => {
      const id = event.getId()
      if (!id) return
      try {
        await toggleThreadReaction(room, id, emoji, myUserId)
      } catch (err) {
        console.error('Failed to react in thread', err)
      }
    },
    [room, myUserId],
  )

  // Reset composer intent when switching threads / closing
  useEffect(() => {
    if (!isOpen) {
      setCtxMenu(null)
      setComposerReply(null)
      setEditTarget(null)
    }
  }, [isOpen, rootEventId])

  const inputReplyTo: ReplyTarget =
    composerReply ??
    ({
      eventId: lastReplyId,
      senderName: 'ветке',
      snippet: '',
    } satisfies ReplyTarget)

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[900] flex justify-end"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-xs"
            aria-label="Закрыть"
            onClick={onClose}
          />
          <motion.aside
            className="tg-profile-panel relative z-10 mt-[38px] h-[calc(100%-38px)] w-full max-w-[400px] border-l shadow-panel flex flex-col"
            initial={{ x: 40, opacity: 0.85 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 28, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <div className="tg-profile-panel-header flex items-center justify-between px-4 h-12 border-b shrink-0">
              <div className="tg-title flex items-center gap-2 min-w-0">
                <MessagesSquare className="tg-muted w-4 h-4 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold truncate">Ветка</div>
                  <div className="tg-muted text-[11px] truncate">
                    {replyCount > 0
                      ? `${replyCount} ${
                          replyCount === 1
                            ? 'ответ'
                            : replyCount < 5
                              ? 'ответа'
                              : 'ответов'
                        }`
                      : 'Нет ответов'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full"
                aria-label="Закрыть"
                style={{ WebkitAppRegion: 'no-drag' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="tg-profile-panel-hero px-4 py-3 border-b shrink-0">
              <div className="tg-muted text-[11px] mb-1">
                {rootEvent ? senderLabel(room, rootEvent) : '…'}
              </div>
              <div className="tg-title text-[13.5px] leading-snug line-clamp-4 whitespace-pre-wrap break-words">
                {rootSnippet}
              </div>
            </div>

            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2.5"
            >
              {replies.length === 0 ? (
                <div className="tg-muted text-[13px] text-center py-8 px-4">
                  Ответьте в ветке — сообщение останется привязанным к этому
                  комментарию и не попадёт в основную ленту
                </div>
              ) : (
                sortThreadReplies(replies).map((ev) => (
                  <ThreadReplyRow
                    key={ev.getId() || `${ev.getTs()}`}
                    room={room}
                    client={client}
                    event={ev}
                    myUserId={myUserId}
                    onOpenImage={openImage}
                    members={members}
                    onUserClick={onUserClick}
                    onContextMenu={openContextMenu}
                  />
                ))
              )}
            </div>

            <div className="shrink-0 border-t border-hairline">
              <MessageInput
                activeRoom={room}
                threadRootId={rootEventId}
                replyTo={editTarget ? null : inputReplyTo}
                onClearReply={() => setComposerReply(null)}
                editTarget={editTarget}
                onClearEdit={() => setEditTarget(null)}
                onSent={handleSent}
              />
            </div>
          </motion.aside>

          {viewer && (
            <ImageViewer
              images={viewer.images}
              index={viewer.index}
              onClose={() => setViewer(null)}
              onIndexChange={(i) =>
                setViewer((v) => (v ? { ...v, index: i } : v))
              }
            />
          )}

          {ctxMenu && (
            <MessageContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              isOwn={ctxMenu.isOwn}
              canEdit={canEditThreadEvent(ctxMenu.event, ctxMenu.isOwn)}
              canCopy={
                !!ctxMenu.quoteText ||
                !!threadMessagePlainText(ctxMenu.event) ||
                !!messageSnippet(ctxMenu.event)
              }
              canDelete={ctxMenu.isOwn}
              canForward={false}
              quoteText={ctxMenu.quoteText}
              onClose={() => setCtxMenu(null)}
              onQuote={
                ctxMenu.quoteText
                  ? () =>
                      handleReplyFromMenu(ctxMenu.event, ctxMenu.quoteText)
                  : undefined
              }
              onReply={() => handleReplyFromMenu(ctxMenu.event)}
              onEdit={() => handleEditFromMenu(ctxMenu.event)}
              onCopy={() =>
                void handleCopyFromMenu(ctxMenu.event, ctxMenu.quoteText)
              }
              onDelete={() => void handleDeleteFromMenu(ctxMenu.event)}
              onReact={(emoji) =>
                void handleReactFromMenu(ctxMenu.event, emoji)
              }
              bizTaskRef={(() => {
                const ev = ctxMenu.event
                const eventId = ev?.getId()
                if (!ev || !eventId || eventId.startsWith('~')) return null
                const senderId = ev.getSender() ?? undefined
                const member = senderId ? room.getMember(senderId) : null
                const body =
                  threadMessagePlainText(ev) || messageSnippet(ev) || ''
                const ref: BizTaskMessageRef = {
                  roomId: room.roomId,
                  roomName: room.name || room.roomId,
                  eventId,
                  body,
                  senderId,
                  senderName: member?.name || senderId,
                  ts: ev.getTs() || Date.now(),
                }
                return ref
              })()}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
