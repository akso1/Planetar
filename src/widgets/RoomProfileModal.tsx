import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AtSign,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Play,
  Users,
  X,
} from 'lucide-react'
import {
  EventTimeline,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import { downloadMessageAttachment } from '@/shared/lib/matrixMedia'
import { isGifMessageContent } from '@/shared/lib/savedGifsStore'
import { openOrCreateDirectChat } from '@/shared/lib/openDm'
import { AppContextMenu } from '@/shared/ui/AppContextMenu'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { useRoomStore } from '@/entities/session/model/room.store'
import { ImageViewer, type ViewerImage } from './ImageViewer'

export type MentionRequest = {
  userId: string
  displayName: string
}

type RoomProfileModalProps = {
  isOpen: boolean
  room: Room
  client: MatrixClient
  onClose: () => void
  onMention: (mention: MentionRequest) => void
}

type ProfileTab = 'members' | 'media' | 'files' | 'links'

type SharedMediaItem = {
  eventId: string
  event: MatrixEvent
  kind: 'image' | 'video' | 'gif'
  content: Record<string, unknown>
  senderName: string
  ts: number
}

type SharedFileItem = {
  eventId: string
  event: MatrixEvent
  name: string
  size?: number
  mime?: string
  senderName: string
  ts: number
}

type SharedLinkItem = {
  eventId: string
  event: MatrixEvent
  url: string
  body: string
  senderName: string
  ts: number
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi

/** Keep decrypted shared-history across profile open/close to avoid decrypt spam. */
const profileHistoryCache = new Map<string, MatrixEvent[]>()

function memberDisplayName(m: RoomMember): string {
  return (
    m.name ||
    m.rawDisplayName ||
    m.userId.split(':')[0].substring(1) ||
    m.userId
  )
}

function senderLabel(room: Room, event: MatrixEvent): string {
  const id = event.getSender() || ''
  const member = id ? room.getMember(id) : null
  if (member) return memberDisplayName(member)
  return id.split(':')[0]?.substring(1) || id || 'Unknown'
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return `${n} Б`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} КБ`
  return `${(n / 1_000_000).toFixed(1)} МБ`
}

function isTimelineMessage(ev: MatrixEvent): boolean {
  if (ev.isRedacted()) return false
  const t = ev.getType()
  return (
    t === 'm.room.message' ||
    t === 'm.sticker' ||
    t === 'm.room.encrypted' ||
    ev.isDecryptionFailure()
  )
}

function isLocalEchoEventId(id: string | undefined | null): boolean {
  return !id || id.startsWith('~')
}

function isReplaceRelation(ev: MatrixEvent): boolean {
  if (ev.isRelation?.('m.replace')) return true
  const rel = ev.getRelation?.()
  return rel?.rel_type === 'm.replace'
}

function attachmentMxc(content: Record<string, unknown>): string | null {
  const file = content.file as { url?: string } | undefined
  const url = file?.url || (typeof content.url === 'string' ? content.url : null)
  return url || null
}

function collectShared(
  room: Room,
  events: MatrixEvent[],
): {
  media: SharedMediaItem[]
  files: SharedFileItem[]
  links: SharedLinkItem[]
} {
  const media: SharedMediaItem[] = []
  const files: SharedFileItem[] = []
  const links: SharedLinkItem[] = []
  const seenIds = new Set<string>()
  const seenMediaMxc = new Set<string>()
  const seenFileMxc = new Set<string>()

  // Newest first
  const ordered = [...events].sort((a, b) => b.getTs() - a.getTs())

  for (const event of ordered) {
    if (!isTimelineMessage(event)) continue
    if (event.isDecryptionFailure()) continue
    if (isReplaceRelation(event)) continue
    // Local echo of an outgoing send — server copy arrives with a real $id
    if (event.status != null || event.isSending?.()) continue
    const eventId = event.getId()
    if (isLocalEchoEventId(eventId) || seenIds.has(eventId!)) continue
    seenIds.add(eventId!)
    const content = event.getContent() as Record<string, unknown>
    const msgtype = content.msgtype as string | undefined
    const type = event.getType()
    const senderName = senderLabel(room, event)
    const ts = event.getTs()
    const mxc = attachmentMxc(content)

    // Stickers stay in the chat timeline only — not in Shared Media.
    if (type === 'm.sticker') continue

    if (msgtype === 'm.image' || isGifMessageContent(content)) {
      if (mxc && seenMediaMxc.has(mxc)) continue
      if (mxc) seenMediaMxc.add(mxc)
      media.push({
        eventId: eventId!,
        event,
        kind: isGifMessageContent(content) ? 'gif' : 'image',
        content,
        senderName,
        ts,
      })
      continue
    }

    if (msgtype === 'm.video') {
      if (mxc && seenMediaMxc.has(mxc)) continue
      if (mxc) seenMediaMxc.add(mxc)
      media.push({
        eventId: eventId!,
        event,
        kind: 'video',
        content,
        senderName,
        ts,
      })
      continue
    }

    if (msgtype === 'm.file') {
      if (mxc && seenFileMxc.has(mxc)) continue
      if (mxc) seenFileMxc.add(mxc)
      const info = content.info as { size?: number; mimetype?: string } | undefined
      files.push({
        eventId: eventId!,
        event,
        name: String(content.body || 'Файл'),
        size: info?.size,
        mime: info?.mimetype,
        senderName,
        ts,
      })
      continue
    }

    if (msgtype === 'm.text' || msgtype === 'm.emote' || typeof content.body === 'string') {
      const body = String(content.body || '')
      const found = body.match(URL_RE)
      if (found?.length) {
        const seen = new Set<string>()
        for (const raw of found) {
          const url = raw.replace(/[),.;!?]+$/g, '')
          if (seen.has(url)) continue
          seen.add(url)
          links.push({
            eventId: eventId!,
            event,
            url,
            body,
            senderName,
            ts,
          })
        }
      }
    }
  }

  return { media, files, links }
}

function previewContentFor(
  content: Record<string, unknown>,
): {
  url?: string
  file?: any
  info?: { mimetype?: string }
} {
  const info = content.info as
    | {
        mimetype?: string
        thumbnail_url?: string
        thumbnail_file?: any
        thumbnail_info?: { mimetype?: string }
      }
    | undefined

  if (info?.thumbnail_file || info?.thumbnail_url) {
    return {
      url: info.thumbnail_url,
      file: info.thumbnail_file,
      info: {
        mimetype: info.thumbnail_info?.mimetype || 'image/jpeg',
      },
    }
  }

  return {
    url: content.url as string | undefined,
    file: content.file,
    info: { mimetype: info?.mimetype || 'image/jpeg' },
  }
}

function MemberAvatar({
  member,
  client,
  size = 40,
}: {
  member: RoomMember
  client: MatrixClient
  size?: number
}) {
  const name = memberDisplayName(member)
  return (
    <MxcAvatar
      client={client}
      mxcUrl={member.getMxcAvatarUrl()}
      label={name}
      size={size}
    />
  )
}

function MediaThumb({
  client,
  content,
  kind,
}: {
  client: MatrixClient
  content: Record<string, unknown>
  kind: SharedMediaItem['kind']
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const preview = previewContentFor(content)
  const mxc = preview.file?.url || preview.url || null

  useEffect(() => {
    let alive = true
    let created: string | null = null
    setObjectUrl(null)
    setError(false)
    if (!mxc) {
      setError(true)
      return
    }
    void (async () => {
      try {
        const blob = await downloadMessageAttachment(
          client,
          preview,
          preview.info?.mimetype || 'image/jpeg',
        )
        if (!alive) return
        created = URL.createObjectURL(blob)
        setObjectUrl(created)
      } catch (err) {
        console.warn('Media thumb failed', err)
        if (alive) setError(true)
      }
    })()
    return () => {
      alive = false
      if (created) URL.revokeObjectURL(created)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, mxc])

  if (error && kind === 'video') {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black/30">
        <Film className="w-6 h-6 text-white/45" />
      </div>
    )
  }

  if (!objectUrl) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black/20 text-[10px] text-white/35">
        …
      </div>
    )
  }

  return (
    <>
      <img src={objectUrl} alt="" className="w-full h-full object-cover" />
      {kind === 'video' && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="w-8 h-8 rounded-full bg-black/55 flex items-center justify-center">
            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
          </span>
        </span>
      )}
      {kind === 'gif' && (
        <span className="absolute bottom-1 left-1 px-1 py-0.5 rounded text-[9px] font-bold uppercase bg-black/55 text-white/90">
          GIF
        </span>
      )}
    </>
  )
}

export function RoomProfileModal({
  isOpen,
  room,
  client,
  onClose,
  onMention,
}: RoomProfileModalProps) {
  const setActiveRoomId = useRoomStore((s) => s.actions.setActiveRoomId)
  const openRoomAtEvent = useRoomStore((s) => s.actions.openRoomAtEvent)
  const [tab, setTab] = useState<ProfileTab>('members')
  const [memberMenu, setMemberMenu] = useState<{
    x: number
    y: number
    member: RoomMember
  } | null>(null)
  const [itemMenu, setItemMenu] = useState<{
    x: number
    y: number
    eventId: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewer, setViewer] = useState<{
    images: ViewerImage[]
    index: number
  } | null>(null)
  const [tick, setTick] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyEvents, setHistoryEvents] = useState<MatrixEvent[]>([])

  const members = useMemo(() => {
    const list = room.getJoinedMembers()
    return [...list].sort((a, b) =>
      memberDisplayName(a).localeCompare(memberDisplayName(b), 'ru'),
    )
  }, [room, isOpen])

  const shared = useMemo(() => {
    const byId = new Map<string, MatrixEvent>()
    for (const ev of room.getLiveTimeline().getEvents()) {
      const id = ev.getId()
      if (isLocalEchoEventId(id) || ev.status != null || ev.isSending?.()) continue
      byId.set(id!, ev)
    }
    for (const ev of historyEvents) {
      const id = ev.getId()
      if (isLocalEchoEventId(id) || ev.status != null || ev.isSending?.()) continue
      // Prefer live-timeline instance when both exist
      if (!byId.has(id!)) byId.set(id!, ev)
    }
    return collectShared(room, [...byId.values()])
  }, [room, historyEvents, isOpen, tick])

  const roomAvatarMxc = room.getMxcAvatarUrl?.() ?? null
  const roomName = room.name || room.roomId
  const myId = client.getUserId()

  useEffect(() => {
    if (!isOpen) {
      setMemberMenu(null)
      setItemMenu(null)
      setViewer(null)
      setTab('members')
      setHistoryLoading(false)
      // Keep historyEvents in cache — don't wipe (re-decrypt spam on reopen)
      return
    }
    setTick((t) => t + 1)
    const cached = profileHistoryCache.get(room.roomId)
    if (cached?.length) {
      setHistoryEvents(cached)
    }
  }, [isOpen, room.roomId])

  // Load shared media via /messages — does NOT mutate the live chat timeline.
  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    const cached = profileHistoryCache.get(room.roomId)
    if (cached?.length) {
      setHistoryEvents(cached)
      setHistoryLoading(false)
      return
    }

    setHistoryLoading(true)
    setHistoryEvents([])

    const BATCH = 100
    const MAX_BATCHES = 40
    const mapper = client.getEventMapper({ preventReEmit: true })
    const accumulated: MatrixEvent[] = []

    const load = async () => {
      let from: string | null = null
      for (let i = 0; i < MAX_BATCHES; i++) {
        if (cancelled) return
        try {
          const res = await client.createMessagesRequest(
            room.roomId,
            from,
            BATCH,
            EventTimeline.BACKWARDS,
          )
          if (cancelled) return
          for (const raw of res.chunk) {
            const ev = mapper(raw)
            // Skip retries on known failures — SDK logs each decrypt error
            if (
              ev.isEncrypted() &&
              !ev.getClearContent() &&
              !ev.isDecryptionFailure()
            ) {
              try {
                await client.decryptEventIfNeeded(ev)
              } catch {
                // keep undecrypted; collectShared skips decrypt failures
              }
            }
            accumulated.push(ev)
          }
          if (!cancelled) setHistoryEvents([...accumulated])
          if (!res.chunk.length || !res.end || res.end === from) break
          from = res.end
          await new Promise((r) => window.setTimeout(r, 16))
        } catch (err) {
          console.warn('Shared media history load failed', err)
          break
        }
      }
      if (!cancelled) {
        profileHistoryCache.set(room.roomId, accumulated)
        setHistoryLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [isOpen, room.roomId, client])

  const mention = (member: RoomMember) => {
    onMention({
      userId: member.userId,
      displayName: memberDisplayName(member),
    })
    onClose()
  }

  const copyId = async (userId: string) => {
    try {
      await navigator.clipboard.writeText(userId)
    } catch (err) {
      console.error('Failed to copy user id', err)
    }
  }

  const openDm = async (userId: string) => {
    if (userId === myId || !myId) return
    setBusy(true)
    try {
      const roomId = await openOrCreateDirectChat(client, userId)
      setActiveRoomId(roomId)
      onClose()
    } catch (err) {
      console.error('Failed to open DM', err)
      alert('Не удалось открыть личный чат')
    } finally {
      setBusy(false)
    }
  }

  const goToMessage = (eventId: string) => {
    // Close profile after scheduling the jump so the timeline effect sees it
    openRoomAtEvent(room.roomId, eventId)
    onClose()
  }

  const openMediaAt = (index: number) => {
    const images: ViewerImage[] = shared.media
      .filter((m) => m.kind !== 'video')
      .map((m) => ({
        id: m.eventId,
        content: m.content as ViewerImage['content'],
        name: String((m.content.body as string) || 'image'),
      }))
    // If clicked a video, still try to open nearby images or skip
    const clicked = shared.media[index]
    if (!clicked) return
    if (clicked.kind === 'video') {
      // Jump to message for video (no video lightbox yet)
      goToMessage(clicked.eventId)
      return
    }
    const viewerIndex = images.findIndex((img) => img.id === clicked.eventId)
    if (viewerIndex < 0) return
    setViewer({ images, index: viewerIndex })
  }

  const tabs: { id: ProfileTab; label: string; icon: typeof Users; count?: number }[] =
    [
      { id: 'members', label: 'Участники', icon: Users, count: members.length },
      { id: 'media', label: 'Медиа', icon: ImageIcon, count: shared.media.length },
      { id: 'files', label: 'Файлы', icon: FileText, count: shared.files.length },
      { id: 'links', label: 'Ссылки', icon: Link2, count: shared.links.length },
    ]

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
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="Закрыть"
            onClick={onClose}
          />
          <motion.aside
            className="tg-profile-panel relative z-10 mt-[38px] h-[calc(100%-38px)] w-full max-w-[360px] border-l shadow-panel flex flex-col"
            initial={{ x: 40, opacity: 0.85 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 28, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <div className="tg-profile-panel-header flex items-center justify-between px-4 h-12 border-b shrink-0">
              <div className="tg-title flex items-center gap-2">
                <Users className="tg-muted w-4 h-4" />
                <span className="text-[14px] font-semibold">Профиль чата</span>
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

            <div className="tg-profile-panel-hero px-5 pt-5 pb-4 border-b shrink-0">
              <div className="flex items-center gap-3.5">
                <MxcAvatar
                  client={client}
                  mxcUrl={roomAvatarMxc}
                  label={roomName}
                  size={64}
                />
                <div className="min-w-0">
                  <div className="tg-title text-[16px] font-semibold truncate">
                    {roomName}
                  </div>
                  <div className="tg-muted text-[12.5px] mt-0.5">
                    {members.length}{' '}
                    {members.length === 1
                      ? 'участник'
                      : members.length < 5
                        ? 'участника'
                        : 'участников'}
                  </div>
                </div>
              </div>
            </div>

            <div className="tg-profile-tabs shrink-0 px-3 pt-3 pb-2 border-b">
              <div className="tg-tabs grid grid-cols-4">
                {tabs.map(({ id, label, icon: Icon, count }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={clsx(
                      'tg-tab relative flex flex-col items-center gap-1',
                      tab === id && 'tg-tab--active',
                    )}
                    title={label}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="truncate max-w-full text-[10.5px]">{label}</span>
                    {!!count && count > 0 && (
                      <span className="tg-profile-tab-count">{count > 99 ? '99+' : count}</span>
                    )}
                  </button>
                ))}
              </div>
              {historyLoading && (
                <div className="tg-muted text-center text-[11px] pt-1.5 pb-0.5">
                  Подгружаем историю материалов…
                </div>
              )}
            </div>

            <div className="tg-profile-scroll flex-1 overflow-y-auto px-2 py-2">
              {tab === 'members' && (
                <ul className="space-y-0.5">
                  {members.map((member) => {
                    const name = memberDisplayName(member)
                    const isMe = member.userId === myId
                    return (
                      <li key={member.userId}>
                        <div
                          className="tg-profile-member group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors cursor-pointer"
                          onClick={() => {
                            if (!isMe) mention(member)
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setMemberMenu({
                              x: e.clientX,
                              y: e.clientY,
                              member,
                            })
                          }}
                        >
                          <MemberAvatar member={member} client={client} />
                          <div className="min-w-0 flex-1">
                            <div className="tg-title text-[13.5px] font-medium truncate">
                              {name}
                              {isMe && (
                                <span className="tg-muted font-normal">
                                  {' '}
                                  (вы)
                                </span>
                              )}
                            </div>
                            <div className="tg-muted text-[11.5px] truncate">
                              {member.userId}
                            </div>
                          </div>
                          {!isMe && (
                            <button
                              type="button"
                              title="Упомянуть в чате"
                              aria-label="Упомянуть в чате"
                              className={clsx(
                                'tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full shrink-0',
                                'opacity-0 group-hover:opacity-100 transition-all',
                              )}
                              onClick={(e) => {
                                e.stopPropagation()
                                mention(member)
                              }}
                            >
                              <AtSign className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}

              {tab === 'media' && (
                <>
                  {shared.media.length === 0 ? (
                    <div className="tg-muted px-3 py-10 text-center text-[12.5px] leading-relaxed">
                      Пока нет общих фото, видео или GIF
                      <br />
                      в загруженной истории чата.
                    </div>
                  ) : (
                    <div className="tg-profile-media-grid">
                      {shared.media.map((item, index) => (
                        <div
                          key={item.eventId}
                          className="tg-profile-media-cell group relative aspect-square rounded-lg overflow-hidden"
                        >
                          <button
                            type="button"
                            className="absolute inset-0 w-full h-full"
                            onClick={() => openMediaAt(index)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setItemMenu({
                                x: e.clientX,
                                y: e.clientY,
                                eventId: item.eventId,
                              })
                            }}
                            title={item.senderName}
                          >
                            <MediaThumb
                              client={client}
                              content={item.content}
                              kind={item.kind}
                            />
                          </button>
                          <button
                            type="button"
                            className="tg-profile-goto absolute top-1 right-1 w-7 h-7 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Перейти к сообщению"
                            aria-label="Перейти к сообщению"
                            onClick={(e) => {
                              e.stopPropagation()
                              goToMessage(item.eventId)
                            }}
                          >
                            <CornerDownRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {tab === 'files' && (
                <>
                  {shared.files.length === 0 ? (
                    <div className="tg-muted px-3 py-10 text-center text-[12.5px]">
                      Общих файлов пока нет.
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {shared.files.map((f) => (
                        <li key={f.eventId}>
                          <div
                            className="tg-profile-member group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors cursor-pointer"
                            onClick={() => goToMessage(f.eventId)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setItemMenu({
                                x: e.clientX,
                                y: e.clientY,
                                eventId: f.eventId,
                              })
                            }}
                          >
                            <div className="tg-profile-file-icon w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                              <FileText className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="tg-title text-[13.5px] font-medium truncate">
                                {f.name}
                              </div>
                              <div className="tg-muted text-[11.5px] truncate">
                                {[formatBytes(f.size), f.senderName, format(f.ts, 'd MMM')]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            </div>
                            <CornerDownRight className="tg-muted w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100" />
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              {tab === 'links' && (
                <>
                  {shared.links.length === 0 ? (
                    <div className="tg-muted px-3 py-10 text-center text-[12.5px]">
                      Ссылок в истории пока нет.
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {shared.links.map((l, i) => (
                        <li key={`${l.eventId}_${i}`}>
                          <div
                            className="tg-profile-member group rounded-xl px-3 py-2.5 transition-colors"
                            onContextMenu={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setItemMenu({
                                x: e.clientX,
                                y: e.clientY,
                                eventId: l.eventId,
                              })
                            }}
                          >
                            <div className="flex items-start gap-2.5">
                              <div className="tg-profile-file-icon w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5">
                                <ExternalLink className="w-4 h-4" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <a
                                  href={l.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="tg-link text-[13px] font-medium break-all hover:underline"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {l.url}
                                </a>
                                <div className="tg-muted text-[11.5px] mt-1 line-clamp-2">
                                  {l.body}
                                </div>
                                <div className="tg-muted text-[11px] mt-1 flex items-center gap-2">
                                  <span>{l.senderName}</span>
                                  <span>·</span>
                                  <span>{format(l.ts, 'd MMM HH:mm')}</span>
                                  <button
                                    type="button"
                                    className="tg-link ml-auto text-[11px] opacity-0 group-hover:opacity-100 inline-flex items-center gap-1"
                                    onClick={() => goToMessage(l.eventId)}
                                  >
                                    <CornerDownRight className="w-3 h-3" />
                                    В чат
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>

            {busy && (
              <div className="tg-profile-busy absolute inset-0 flex items-center justify-center text-[13px]">
                Открываем чат…
              </div>
            )}
          </motion.aside>

          {memberMenu && (
            <AppContextMenu
              x={memberMenu.x}
              y={memberMenu.y}
              onClose={() => setMemberMenu(null)}
              items={[
                {
                  id: 'mention',
                  label: 'Упомянуть в чате',
                  icon: <AtSign className="w-4 h-4" />,
                  disabled: memberMenu.member.userId === myId,
                  onSelect: () => mention(memberMenu.member),
                },
                {
                  id: 'copy',
                  label: 'Копировать Matrix ID',
                  icon: <Copy className="w-4 h-4" />,
                  onSelect: () => void copyId(memberMenu.member.userId),
                },
                {
                  id: 'dm',
                  label: 'Написать личное сообщение',
                  icon: <MessageSquare className="w-4 h-4" />,
                  disabled: memberMenu.member.userId === myId,
                  onSelect: () => void openDm(memberMenu.member.userId),
                },
              ]}
            />
          )}

          {itemMenu && (
            <AppContextMenu
              x={itemMenu.x}
              y={itemMenu.y}
              onClose={() => setItemMenu(null)}
              items={[
                {
                  id: 'goto',
                  label: 'Перейти к сообщению',
                  icon: <CornerDownRight className="w-4 h-4" />,
                  onSelect: () => goToMessage(itemMenu.eventId),
                },
              ]}
            />
          )}

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
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
