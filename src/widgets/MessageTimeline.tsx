import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  findMsgDomEl,
  findTimelineRowIndex as findRowIndexInRows,
  type JumpToEventOptions,
} from '@/shared/lib/timelineJump'
import {
  useRoomStore,
} from '@/entities/session/model/room.store'
import { useSessionStore } from '@/entities/session/model/session'
import {
  EventTimeline,
  EventType,
  Direction,
  MatrixEvent,
  MatrixEventEvent,
  RelationType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  TimelineWindow,
  type Room,
} from 'matrix-js-sdk'
import { format, isSameDay, isToday, isYesterday, startOfDay } from 'date-fns'
import { ru } from 'date-fns/locale'
import { clsx } from 'clsx'
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Forward,
  Loader2,
  Pencil,
  Reply,
  Search,
  Smile,
  X,
} from 'lucide-react'
import {
  acquireCachedObjectUrl,
  downloadMessageAttachment,
  downloadMessageAttachmentPreview,
  releaseCachedObjectUrl,
  timelinePreviewContent,
} from '@/shared/lib/matrixMedia'
import { getUserColor } from '@/shared/lib/color'
import {
  isGifMessageContent,
  useSavedGifsStore,
} from '@/shared/lib/savedGifsStore'
import {
  ALBUM_CAPTION_KEY,
  ALBUM_ID_KEY,
  REPLY_MEDIA_IDS_KEY,
} from '@/shared/lib/sendMedia'
import { matrixService } from '@/shared/api/MatrixService'
import { MessageBody } from '@/shared/ui/MessageBody'
import { MessageMarkdown } from '@/shared/ui/MessageMarkdown'
import { TwemojiImg } from '@/shared/ui/twemoji'
import { MessageContextMenu } from '@/shared/ui/MessageContextMenu'
import { ReadByAvatars, DeliveryTicksButton } from '@/shared/ui/ReadByAvatars'
import {
  getOwnDeliveryStatus,
  getReceiptTipReaders,
  getUsersWhoReadEvent,
} from '@/shared/lib/readReceipts'
import { extractEmbeddedQuote, getQuoteSelectionWithin } from '@/shared/lib/messageQuote'
import { matrixContentToComposerText } from '@/shared/lib/composerFormat'
import {
  clearQuoteTextHighlights,
  highlightQuoteInMessageRetry,
} from '@/shared/lib/highlightQuoteInDom'
import {
  canForwardEvent,
  forwardEventsToRooms,
} from '@/shared/lib/forwardMessages'
import { ForwardRoomPicker } from './ForwardRoomPicker'
import { DecryptHistoryModal } from './DecryptHistoryModal'
import {
  MessageInput,
  messageSnippet,
  type EditTarget,
  type PendingMention,
  type ReplyTarget,
} from './MessageInput'
import { openOrCreateDirectChat } from '@/shared/lib/openDm'
import { useVerificationUiStore } from '@/shared/lib/verificationUi'
import {
  canPinMessages,
  computePinnedBarIndex,
  inferMissingPinStatus,
  isEventPinned,
  pinMessage,
  resolvePinnedMessagesLocal,
  resolvePinnedMessagesNewestFirst,
  unpinMessage,
  type PinScrollDirection,
  type ResolvedPinnedMessage,
} from '@/shared/lib/pinnedMessages'
import {
  pinMessageForSelf,
  unpinMessageForSelf,
  usePersonalPinnedStore,
} from '@/shared/lib/personalPinnedMessages'
import { ChatHeader, formatTypingLabel } from './ChatHeader'
import { PinnedMessageBar } from './PinnedMessageBar'
import { RoomProfileModal } from './RoomProfileModal'
import { ImageViewer, type ViewerImage } from './ImageViewer'
import { VideoViewer, type ViewerVideo } from './VideoViewer'
import { formatBytes } from '@/shared/lib/stickersStore'
import {
  TimelineDateJumpPopover,
  collectDaysWithMessages,
  findFirstEventIdOnDay,
  findFirstEventIdOnOrAfterDay,
} from './TimelineDateJumpPopover'

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

type ReactionSummary = {
  key: string
  count: number
  reactedByMe: boolean
  myEventIds: string[]
}

function getInReplyToId(event: MatrixEvent): string | undefined {
  const content = event.getContent() as Record<string, unknown>
  const wire = event.getWireContent?.() as Record<string, unknown> | undefined
  const relates =
    (content['m.relates_to'] as Record<string, unknown> | undefined) ||
    (wire?.['m.relates_to'] as Record<string, unknown> | undefined)
  const inReply = relates?.['m.in_reply_to'] as { event_id?: string } | undefined
  return inReply?.event_id
}

function getReplyMediaIds(event: MatrixEvent): string[] {
  const content = event.getContent() as Record<string, unknown>
  const raw = content[REPLY_MEDIA_IDS_KEY]
  if (Array.isArray(raw)) {
    return raw.filter((id): id is string => typeof id === 'string' && !!id)
  }
  const parentId = getInReplyToId(event)
  return parentId ? [parentId] : []
}

function messageSearchText(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return ''
  const content = event.getContent() as Record<string, unknown>
  const parts: string[] = []
  if (typeof content.body === 'string') parts.push(content.body)
  const caption = content[ALBUM_CAPTION_KEY]
  if (typeof caption === 'string') parts.push(caption)
  return parts.join(' ').toLowerCase()
}

function eventMatchesSearch(event: MatrixEvent, query: string): boolean {
  if (!query) return false
  return messageSearchText(event).includes(query)
}

const CONTINUATION_MS = 10 * 60 * 1000

function formatDaySeparator(ts: number): string {
  if (isToday(ts)) return 'Сегодня'
  if (isYesterday(ts)) return 'Вчера'
  return format(ts, 'd MMMM yyyy', { locale: ru })
}

function DateSeparator({
  ts,
  onJumpClick,
}: {
  ts: number
  onJumpClick?: (dayStartMs: number) => void
}) {
  const dayStart = startOfDay(ts).getTime()
  return (
    <div className="tg-date-sep" data-tg-date-sep data-ts={dayStart}>
      <button
        type="button"
        onClick={() => onJumpClick?.(dayStart)}
        title="Перейти к дате"
      >
        {formatDaySeparator(ts)}
      </button>
    </div>
  )
}

function UnreadSeparator() {
  return (
    <div className="tg-unread-sep" id="tg-unread-anchor" role="separator">
      <span className="tg-unread-sep-line" />
      <span className="tg-unread-sep-label">Непрочитанные</span>
      <span className="tg-unread-sep-line" />
    </div>
  )
}

function getReactionsForEvent(
  room: Room,
  eventId: string,
  myUserId: string | null,
): ReactionSummary[] {
  const relations = room.relations.getChildEventsForEvent(
    eventId,
    RelationType.Annotation,
    EventType.Reaction,
  )
  const fromRelations = relations?.getSortedAnnotationsByKey()
  if (fromRelations?.length) {
    return fromRelations
      .map(([key, events]) => {
        const live = [...events].filter((e) => !e.isRedacted())
        if (!live.length) return null
        const bySender = new Map<string, MatrixEvent>()
        for (const e of live) {
          const s = e.getSender() || ''
          if (!bySender.has(s)) bySender.set(s, e)
        }
        const unique = [...bySender.values()]
        const myEventIds = live
          .filter((e) => e.getSender() === myUserId)
          .map((e) => e.getId()!)
          .filter(Boolean)
        return {
          key,
          count: unique.length,
          reactedByMe: myEventIds.length > 0,
          myEventIds,
        }
      })
      .filter(Boolean) as ReactionSummary[]
  }

  const byKey = new Map<
    string,
    { senders: Set<string>; myEventIds: string[] }
  >()
  for (const ev of room.getLiveTimeline().getEvents()) {
    if (ev.isRedacted()) continue
    const type = ev.getType()
    if (type !== EventType.Reaction && type !== 'm.room.encrypted') continue
    const content = ev.getContent() as Record<string, unknown>
    const rel = content['m.relates_to'] as
      | { rel_type?: string; event_id?: string; key?: string }
      | undefined
    if (
      !rel ||
      rel.rel_type !== RelationType.Annotation ||
      rel.event_id !== eventId ||
      !rel.key
    ) {
      continue
    }
    const cur = byKey.get(rel.key) || {
      senders: new Set<string>(),
      myEventIds: [],
    }
    const sender = ev.getSender() || ''
    cur.senders.add(sender)
    if (sender === myUserId && ev.getId()) cur.myEventIds.push(ev.getId()!)
    byKey.set(rel.key, cur)
  }
  return [...byKey.entries()].map(([key, v]) => ({
    key,
    count: v.senders.size,
    reactedByMe: v.myEventIds.length > 0,
    myEventIds: v.myEventIds,
  }))
}

async function toggleReaction(
  room: Room,
  eventId: string,
  key: string,
  myUserId: string | null,
): Promise<void> {
  const client = room.client
  const existing = getReactionsForEvent(room, eventId, myUserId).find(
    (r) => r.key === key,
  )

  if (existing?.reactedByMe && existing.myEventIds.length) {
    for (const id of existing.myEventIds) {
      try {
        await client.redactEvent(room.roomId, id)
      } catch (err) {
        console.error('Failed to remove reaction', err)
      }
    }
    return
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

type OpenImageFn = (imageId: string) => void
type OpenVideoFn = (videoId: string) => void
const ImageOpenContext = createContext<OpenImageFn | null>(null)
const VideoOpenContext = createContext<OpenVideoFn | null>(null)
const TimelineScrollContext =
  createContext<React.RefObject<HTMLDivElement | null> | null>(null)

function useOpenImage() {
  return useContext(ImageOpenContext)
}

function useOpenVideo() {
  return useContext(VideoOpenContext)
}

/** Load media when the row mounts (virtual list unmounts off-screen rows). */
function useNearViewport(_rootMargin = '200px') {
  const ref = useRef<HTMLDivElement | null>(null)
  // Virtualized rows only exist near the viewport — start loading immediately.
  return { ref, near: true as const }
}

function getSenderName(event: MatrixEvent): string {
  const senderId = event.getSender()
  if (!senderId) return 'Unknown'
  const member = event.sender
  if (member?.name) return member.name
  return senderId.split(':')[0].substring(1) || senderId
}

/** Plain body for copy / edit (strips reply quote prefix when present) */
function messagePlainText(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return ''
  const content = event.getContent() as Record<string, unknown>
  const caption = content[ALBUM_CAPTION_KEY]
  if (typeof caption === 'string' && caption.trim()) return caption.trim()
  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  return body.trim()
}

function canEditEvent(event: MatrixEvent, isOwn: boolean): boolean {
  if (!isOwn || event.isDecryptionFailure() || event.isRedacted()) return false
  const msgtype = event.getContent()?.msgtype
  return msgtype === 'm.text' || msgtype === 'm.emote'
}

/** Events that belong in the chat timeline (not reactions / edits) */
function isTimelineMessageEvent(e: MatrixEvent): boolean {
  if (e.getType() === EventType.Reaction) return false
  // Prefer SDK helpers — covers wire content for E2EE
  if (e.isRelation?.(RelationType.Annotation)) return false
  if (e.isRelation?.(RelationType.Replace)) return false
  const relation = e.getRelation?.()
  if (
    relation?.rel_type === RelationType.Replace ||
    relation?.rel_type === 'm.replace'
  ) {
    return false
  }
  return (
    e.getType() === 'm.room.message' ||
    e.getType() === 'm.sticker' ||
    e.getType() === 'm.room.encrypted' ||
    e.isDecryptionFailure()
  )
}

function isMessageEdited(event: MatrixEvent): boolean {
  return !!(event.replacingEvent() || event.replacingEventId())
}

function BubbleTime({
  ts,
  edited,
  delivery,
  ticks,
}: {
  ts: number
  edited?: boolean
  /** Own delivery: sent / read (Telegram-style ticks) */
  delivery?: 'sent' | 'read' | null
  /** Custom ticks control (clickable); overrides default static icon */
  ticks?: React.ReactNode
}) {
  return (
    <span className="tg-bubble-meta">
      {edited && (
        <span className="tg-bubble-edited" title="Изменено">
          <Pencil className="w-2.5 h-2.5 opacity-80" strokeWidth={2.5} />
          изменено
        </span>
      )}
      {format(ts, 'HH:mm')}
      {ticks}
      {!ticks && delivery && (
        <span
          className={clsx(
            'tg-bubble-ticks',
            delivery === 'read'
              ? 'tg-bubble-ticks--read'
              : 'tg-bubble-ticks--sent',
          )}
          title={delivery === 'read' ? 'Прочитано' : 'Доставлено'}
          aria-label={delivery === 'read' ? 'Прочитано' : 'Доставлено'}
        >
          <CheckCheck className="w-[14px] h-[14px]" strokeWidth={2.4} />
        </span>
      )}
    </span>
  )
}

function formatDurationMs(duration?: number): string | null {
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return null
  // Voice notes under 1s still show 0:01 (round-down made them look like 0:00)
  const totalSec = Math.max(1, Math.round(duration / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getAlbumId(event: MatrixEvent): string | undefined {
  const content = event.getContent() as Record<string, unknown>
  const id = content[ALBUM_ID_KEY]
  return typeof id === 'string' ? id : undefined
}

function isImageEvent(event: MatrixEvent): boolean {
  if (event.isDecryptionFailure()) return false
  return event.getContent()?.msgtype === 'm.image'
}

function isVideoEvent(event: MatrixEvent): boolean {
  if (event.isDecryptionFailure()) return false
  const content = event.getContent() as Record<string, unknown>
  if (content.msgtype === 'm.video') return true
  if (content.msgtype === 'm.file') {
    const info = content.info as { mimetype?: string } | undefined
    const file = content.file as { mimetype?: string } | undefined
    const mime = (info?.mimetype || file?.mimetype || '').toLowerCase()
    return mime.startsWith('video/')
  }
  return false
}

function isMediaEvent(event: MatrixEvent): boolean {
  if (event.isDecryptionFailure()) return false
  const t = event.getContent()?.msgtype
  return t === 'm.image' || t === 'm.file' || t === 'm.video'
}

/** Hook: download (+decrypt) attachment → cached object URL (delayed revoke). */
function useAttachmentObjectUrl(
  content: { url?: string; file?: any; info?: { mimetype?: string } } | null,
  fallbackMime: string,
  enabled = true,
  mode: 'full' | 'preview' = 'full',
) {
  const client = useSessionStore((state) => state.client)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const preview =
    mode === 'preview' && content ? timelinePreviewContent(content) : content
  const mxcUrl = preview?.file?.url || preview?.url || null
  const cacheKey = mxcUrl ? `${mode}:${mxcUrl}|${fallbackMime}` : null

  useEffect(() => {
    if (!enabled) return
    if (!client || !preview || !cacheKey) {
      setObjectUrl(null)
      setError(false)
      return
    }

    let cancelled = false
    let acquired = false
    let released = false
    const releaseOnce = () => {
      if (!acquired || released) return
      released = true
      releaseCachedObjectUrl(cacheKey)
    }

    const load = async () => {
      try {
        const url = await acquireCachedObjectUrl(cacheKey, () =>
          mode === 'preview'
            ? downloadMessageAttachmentPreview(
                client,
                preview,
                720,
                fallbackMime,
              )
            : downloadMessageAttachment(client, preview, fallbackMime),
        )
        acquired = true
        if (cancelled) {
          releaseOnce()
          return
        }
        setObjectUrl(url)
        setError(false)
      } catch (err) {
        console.error('Error loading media attachment:', err)
        if (!cancelled) setError(true)
      }
    }

    void load()

    return () => {
      cancelled = true
      releaseOnce()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cacheKey, fallbackMime, enabled, mode])

  return { objectUrl, error }
}

function MediaSkeleton({
  fill,
  width,
  height,
}: {
  fill?: boolean
  width?: number
  height?: number
}) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-gray-800/20',
        fill ? 'w-full h-full min-h-[200px] rounded-lg' : 'rounded-xl min-h-[200px]',
      )}
      style={
        fill
          ? undefined
          : {
              width: width ?? 208,
              height: height ?? 200,
            }
      }
      aria-hidden
    />
  )
}

/** Display size for timeline images — keeps skeleton and final img identical. */
function mediaDisplaySize(
  content: {
    info?: {
      w?: number
      h?: number
      thumbnail_info?: { w?: number; h?: number }
    }
  } | null,
  maxW = 280,
  maxH = 280,
  fallback = { width: 208, height: 200 },
): { width: number; height: number } {
  const info = content?.info
  const w = info?.thumbnail_info?.w || info?.w
  const h = info?.thumbnail_info?.h || info?.h
  if (w && h && w > 0 && h > 0) {
    const scale = Math.min(maxW / w, maxH / h, 1)
    return {
      width: Math.max(48, Math.round(w * scale)),
      height: Math.max(48, Math.round(h * scale)),
    }
  }
  return fallback
}

/** CSS aspect-ratio string from m.image / m.video info (for reserved layout). */
function mediaAspectRatio(
  content: {
    info?: {
      w?: number
      h?: number
      thumbnail_info?: { w?: number; h?: number }
    }
  } | null,
): string | undefined {
  const info = content?.info
  const w = info?.thumbnail_info?.w || info?.w
  const h = info?.thumbnail_info?.h || info?.h
  if (w && h && w > 0 && h > 0) return `${w} / ${h}`
  return undefined
}

const MediaImage: React.FC<{
  content: any
  imageId?: string
  className?: string
  fill?: boolean
  /** Compact sticker look: smaller, contain, no crop */
  variant?: 'image' | 'sticker'
}> = ({ content, imageId, className, fill, variant = 'image' }) => {
  const { ref, near } = useNearViewport()
  const isSticker = variant === 'sticker'
  const { objectUrl, error } = useAttachmentObjectUrl(
    content,
    content?.info?.mimetype ||
      content?.file?.mimetype ||
      (isSticker ? 'image/png' : 'image/jpeg'),
    near,
    'preview',
  )
  const openImage = useOpenImage()
  const size = isSticker
    ? mediaDisplaySize(content, 140, 140, { width: 120, height: 120 })
    : mediaDisplaySize(content)
  const aspect = mediaAspectRatio(content) ?? `${size.width} / ${size.height}`
  const hasKnownDims = (() => {
    const info = content?.info
    const w = info?.thumbnail_info?.w || info?.w
    const h = info?.thumbnail_info?.h || info?.h
    return !!(w && h && w > 0 && h > 0)
  })()

  if (fill) {
    return (
      <div
        ref={ref}
        className="w-full h-full min-h-[200px] rounded-lg bg-gray-800/20"
      >
        {error ? (
          <div className="text-[13px] text-white/50 p-2">
            Не удалось загрузить {isSticker ? 'стикер' : 'фото'}
          </div>
        ) : !objectUrl ? (
          <MediaSkeleton fill width={size.width} height={size.height} />
        ) : (
          <button
            type="button"
            className="block p-0 m-0 border-0 bg-transparent cursor-pointer w-full h-full"
            onClick={() => imageId && openImage?.(imageId)}
            aria-label={isSticker ? 'Стикер' : 'Открыть изображение'}
          >
            <img
              src={objectUrl}
              alt={content.body || (isSticker ? 'Sticker' : 'Image')}
              className={className || 'w-full h-full object-cover'}
              draggable={false}
            />
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className={clsx(
        'relative overflow-hidden bg-gray-800/20',
        !isSticker && 'min-h-[200px] rounded-[14px]',
      )}
      style={{
        width: size.width,
        maxWidth: isSticker ? 140 : 'min(280px, 100%)',
        aspectRatio: aspect,
        // Pin pixel height when Matrix info has dims so load can't reflow.
        height: !isSticker && hasKnownDims ? size.height : undefined,
        minHeight: isSticker ? undefined : Math.max(200, size.height),
        borderRadius: isSticker ? undefined : 14,
      }}
    >
      {error ? (
        <div className="absolute inset-0 flex items-center text-[13px] text-white/50 p-2">
          Не удалось загрузить {isSticker ? 'стикер' : 'фото'}
        </div>
      ) : !objectUrl ? (
        <MediaSkeleton fill width={size.width} height={size.height} />
      ) : (
        <button
          type="button"
          className="absolute inset-0 block p-0 m-0 border-0 bg-transparent cursor-pointer"
          onClick={() => imageId && openImage?.(imageId)}
          aria-label={isSticker ? 'Стикер' : 'Открыть изображение'}
        >
          <img
            src={objectUrl}
            alt={content.body || (isSticker ? 'Sticker' : 'Image')}
            className={
              className ||
              (isSticker
                ? 'tg-sticker-img w-full h-full'
                : 'w-full h-full hover:opacity-95 transition-opacity object-cover')
            }
            style={{ objectFit: isSticker ? 'contain' : 'cover' }}
            draggable={false}
          />
        </button>
      )}
    </div>
  )
}

const MediaVideo: React.FC<{
  content: any
  videoId?: string
}> = ({ content, videoId }) => {
  const { ref, near } = useNearViewport()
  const openVideo = useOpenVideo()
  const thumbContent = timelinePreviewContent(content)
  const hasThumb = !!(
    thumbContent &&
    (thumbContent.url || thumbContent.file?.url) &&
    thumbContent !== content
  )
  const { objectUrl: thumbUrl, error: thumbError } = useAttachmentObjectUrl(
    hasThumb ? thumbContent : null,
    'image/jpeg',
    near && hasThumb,
    'preview',
  )
  const size = mediaDisplaySize(content, 280, 200, { width: 240, height: 200 })
  const aspect = mediaAspectRatio(content) ?? `${size.width} / ${size.height}`
  const durationLabel = formatDurationMs(content.info?.duration)
  const bytes =
    typeof content.info?.size === 'number' ? content.info.size : undefined

  return (
    <div ref={ref}>
      <button
        type="button"
        className="tg-video-thumb relative block p-0 m-0 border-0 bg-transparent cursor-pointer rounded-[14px] overflow-hidden group min-h-[200px] bg-gray-800/20"
        style={{
          width: size.width,
          maxWidth: 'min(280px, 100%)',
          aspectRatio: aspect,
          minHeight: Math.max(200, size.height),
        }}
        onClick={() => videoId && openVideo?.(videoId)}
        aria-label="Открыть видео"
      >
        {hasThumb && thumbUrl && !thumbError ? (
          <img
            src={thumbUrl}
            alt={content.body || 'Video'}
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <div className="tg-video-thumb-fallback absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3">
            <span className="text-[28px] leading-none opacity-80">🎬</span>
            <span className="text-[12px] text-white/70 truncate max-w-full">
              {content.body || 'Видео'}
            </span>
          </div>
        )}
        <span className="tg-video-thumb-play absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/50 group-hover:bg-black/65 text-white flex items-center justify-center transition-colors shadow-lg">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
        <span className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1 pointer-events-none">
          {durationLabel && (
            <span className="tg-video-thumb-badge">{durationLabel}</span>
          )}
          <span className="flex-1" />
          {bytes != null && bytes > 0 && (
            <span className="tg-video-thumb-badge">{formatBytes(bytes)}</span>
          )}
        </span>
      </button>
    </div>
  )
}

const MediaAudio: React.FC<{ content: any }> = memo(function MediaAudio({
  content,
}) {
  const { ref, near } = useNearViewport()
  const { objectUrl, error } = useAttachmentObjectUrl(
    content,
    content.info?.mimetype || content.file?.mimetype || 'audio/ogg',
    near,
    'full',
  )
  const durationLabel = formatDurationMs(content.info?.duration)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentLabel, setCurrentLabel] = useState('0:00')

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => {
      const d = el.duration
      setProgress(Number.isFinite(d) && d > 0 ? el.currentTime / d : 0)
      setCurrentLabel(formatDurationMs(el.currentTime * 1000) || '0:00')
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => {
      setPlaying(false)
      setProgress(0)
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
    }
  }, [objectUrl])

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }

  return (
    <div
      ref={ref}
      className="tg-audio flex items-center gap-2.5 min-w-[220px] max-w-[280px] py-0.5"
    >
      {error ? (
        <div className="text-[13px] text-white/50">
          Не удалось загрузить голосовое
        </div>
      ) : !objectUrl ? (
        <div className="h-10 w-full rounded-lg bg-white/10 animate-pulse" />
      ) : (
        <>
          <audio ref={audioRef} src={objectUrl} preload="metadata" className="hidden" />
          <button
            type="button"
            onClick={toggle}
            className="tg-audio-play shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-white/15 hover:bg-white/25 transition-colors"
            aria-label={playing ? 'Пауза' : 'Слушать'}
          >
            {playing ? (
              <span className="flex gap-0.5">
                <span className="w-[3px] h-3.5 bg-current rounded-sm" />
                <span className="w-[3px] h-3.5 bg-current rounded-sm" />
              </span>
            ) : (
              <span className="ml-0.5 w-0 h-0 border-y-[6px] border-y-transparent border-l-[10px] border-l-current" />
            )}
          </button>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="tg-audio-track h-1.5 rounded-full bg-white/15 overflow-hidden">
              <div
                className="h-full rounded-full bg-white/70 transition-[width] duration-100"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[11px] text-white/55 tabular-nums">
              <span>{currentLabel}</span>
              <span>{durationLabel || 'Голосовое'}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )
})

const MediaFile: React.FC<{ content: any }> = ({ content }) => {
  const { ref, near } = useNearViewport()
  const { objectUrl, error } = useAttachmentObjectUrl(
    content,
    content.info?.mimetype ||
      content.file?.mimetype ||
      'application/octet-stream',
    near,
    'full',
  )

  return (
    <div ref={ref}>
      {error ? (
        <div className="flex items-center gap-2 text-[13px]">
          <span className="opacity-70">📄</span>
          <span>{content.body || 'Файл'} (ошибка загрузки)</span>
        </div>
      ) : !objectUrl ? (
        <div className="h-9 w-48 rounded-xl bg-white/10 animate-pulse" />
      ) : (
        <a
          href={objectUrl}
          download={content.body || 'file'}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2.5 rounded-xl bg-black/15 px-2.5 py-2 no-underline hover:bg-black/25 transition-colors"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-base">
            📄
          </span>
          <span className="text-[13px] text-ink underline-offset-2 hover:underline truncate max-w-[200px]">
            {content.body || 'Файл'}
          </span>
        </a>
      )}
    </div>
  )
}

type TimelineItem =
  | { kind: 'single'; event: MatrixEvent }
  | {
      kind: 'album'
      events: MatrixEvent[]
      imageEvents: MatrixEvent[]
      caption?: string
      albumId?: string
    }

type TimelineRow = {
  key: string
  item: TimelineItem
  dayChanged: boolean
  showUnreadSep: boolean
  isContinuation: boolean
  isOwn: boolean
  firstEvent: MatrixEvent
}

const ALBUM_GAP_MS = 3000

function groupTimelineItems(messages: MatrixEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let i = 0

  while (i < messages.length) {
    const event = messages[i]
    const albumId = getAlbumId(event)
    const content = event.getContent() as Record<string, unknown>

    // Explicit album (media or caption text with album id)
    if (albumId && (isMediaEvent(event) || content.msgtype === 'm.text')) {
      const group: MatrixEvent[] = [event]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]
        if (next.getSender() !== event.getSender()) break
        if (getAlbumId(next) !== albumId) break
        const nt = next.getContent()?.msgtype
        if (nt === 'm.image' || nt === 'm.file' || nt === 'm.video' || nt === 'm.text') {
          group.push(next)
          j++
          continue
        }
        break
      }

      const imageEvents = group.filter(isImageEvent)
      if (imageEvents.length >= 2) {
        const captionFromField = imageEvents
          .map((e) => (e.getContent() as any)[ALBUM_CAPTION_KEY])
          .find((c) => typeof c === 'string' && c.trim())
        const captionFromText = group
          .find((e) => e.getContent()?.msgtype === 'm.text')
          ?.getContent()?.body
        items.push({
          kind: 'album',
          events: group,
          imageEvents,
          caption: (captionFromField as string) || captionFromText,
          albumId,
        })
        i = j
        continue
      }
    }

    // Heuristic: consecutive images, same sender, within 3s
    if (isImageEvent(event)) {
      const group: MatrixEvent[] = [event]
      let j = i + 1
      while (j < messages.length) {
        const next = messages[j]
        const prev = group[group.length - 1]
        if (next.getSender() !== event.getSender()) break
        if (!isImageEvent(next)) break
        // Prefer not to merge different explicit album ids
        const nextAlbum = getAlbumId(next)
        const prevAlbum = getAlbumId(prev)
        if (nextAlbum && prevAlbum && nextAlbum !== prevAlbum) break
        if (nextAlbum && !prevAlbum) break
        if (!nextAlbum && prevAlbum) break
        if (next.getTs() - prev.getTs() > ALBUM_GAP_MS) break
        group.push(next)
        j++
      }

      if (group.length >= 2) {
        items.push({
          kind: 'album',
          events: group,
          imageEvents: group,
          caption: group
            .map((e) => (e.getContent() as any)[ALBUM_CAPTION_KEY])
            .find((c) => typeof c === 'string' && c.trim()) as string | undefined,
        })
        i = j
        continue
      }
    }

    // Skip orphan album caption texts already consumed — if alone, show as text
    items.push({ kind: 'single', event })
    i++
  }

  return items
}

function albumGridClass(count: number): string {
  if (count <= 1) return 'tg-album-grid tg-album-grid--1'
  if (count === 2) return 'tg-album-grid tg-album-grid--2'
  if (count === 3) return 'tg-album-grid tg-album-grid--3'
  if (count === 4) return 'tg-album-grid tg-album-grid--4'
  return 'tg-album-grid tg-album-grid--many'
}

const MessageHoverActions: React.FC<{
  isOwn: boolean
  onReply: () => void
  onPickReaction: (emoji: string) => void
}> = ({ isOwn, onReply, onPickReaction }) => {
  const [pickerOpen, setPickerOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [pickerOpen])

  return (
    <div
      ref={wrapRef}
      className={clsx(
        'tg-msg-actions absolute top-0 z-20 flex items-center gap-0.5 rounded-full bg-[#1a2733]/95 border border-white/10 shadow-lg px-0.5 py-0.5',
        isOwn ? 'tg-msg-actions--out right-full' : 'tg-msg-actions--in left-full',
      )}
    >
      <button
        type="button"
        onClick={onReply}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] text-white/75 hover:bg-white/10 hover:text-white transition-colors"
        title="Ответить"
      >
        <Reply className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Ответить</span>
      </button>
      <div className="relative">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="flex items-center justify-center w-7 h-7 rounded-full text-white/75 hover:bg-white/10 hover:text-white transition-colors"
          title="Реакция"
          aria-label="Реакция"
        >
          <Smile className="w-3.5 h-3.5" />
        </button>
        {pickerOpen && (
          <div
            className={clsx(
              'absolute bottom-full mb-1.5 flex gap-0.5 rounded-2xl bg-[#1a2733] border border-white/12 shadow-xl p-1',
              isOwn ? 'right-0' : 'left-0',
            )}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="w-8 h-8 rounded-full text-[16px] hover:bg-white/10 transition-colors inline-flex items-center justify-center"
                onClick={() => {
                  setPickerOpen(false)
                  onPickReaction(emoji)
                }}
              >
                <TwemojiImg emoji={emoji} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const ReactionBar: React.FC<{
  reactions: ReactionSummary[]
  onToggle: (key: string) => void
}> = ({ reactions, onToggle }) => {
  if (!reactions.length) return null
  return (
    <div className="tg-reaction-bar flex flex-wrap gap-1 pt-1">
      {reactions.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onToggle(r.key)}
          className={clsx(
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] border transition-colors',
            r.reactedByMe
              ? 'bg-accent/70 border-accent-hover/40 text-white'
              : 'bg-black/25 border-white/10 text-white/80 hover:bg-black/40',
          )}
        >
          <TwemojiImg emoji={r.key} />
          <span className="tabular-nums text-white/60">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

const ReplyChip: React.FC<{
  parent: MatrixEvent | null
  parentId: string
  mediaIds: string[]
  /** Selection quote — replaces full-message snippet when set */
  quoteText?: string
  onScrollTo: (
    eventId: string,
    mediaIds?: string[],
    highlightMs?: number,
    behavior?: ScrollBehavior,
    highlightText?: string,
  ) => void
}> = ({ parent, parentId, mediaIds, quoteText, onScrollTo }) => {
  const sender = parent ? getSenderName(parent) : 'Сообщение'
  const senderId = parent?.getSender() || ''
  const accent = senderId ? getUserColor(senderId) : '#65aadd'
  const count = mediaIds.length
  const snippet = quoteText
    ? quoteText.replace(/\s+/g, ' ')
    : count > 1
      ? `🖼 ${count} фото`
      : parent
        ? messageSnippet(parent)
        : 'Оригинал недоступен'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onScrollTo(
          parentId,
          mediaIds,
          quoteText ? 2200 : undefined,
          'auto',
          quoteText,
        )
      }}
      className={clsx('tg-reply-chip', quoteText && 'tg-reply-chip--quote')}
      title="Перейти к сообщению"
    >
      <span
        className="tg-reply-chip-bar"
        aria-hidden
        style={{ background: accent }}
      />
      <span className="min-w-0 flex-1 py-0.5">
        <span
          className="block text-[12px] font-semibold truncate leading-tight"
          style={{ color: accent }}
        >
          {sender}
        </span>
        <span
          className={clsx(
            'block text-[12.5px] text-white/55 leading-snug',
            quoteText ? 'line-clamp-3 whitespace-pre-wrap break-words' : 'truncate',
          )}
        >
          {snippet}
        </span>
      </span>
    </button>
  )
}

type BubbleChromeProps = {
  eventId: string
  isOwn: boolean
  showSender: boolean
  isContinuation: boolean
  afterDaySep?: boolean
  senderName: string
  senderId?: string | null
  room: Room
  myUserId: string | null
  reactionTick: number
  receiptTick?: number
  /** Event id used for read receipts (defaults to eventId; albums use tip) */
  readEventId?: string
  replyParentId?: string
  replyMediaIds?: string[]
  /** Quoted selection shown in the reply chip (hides duplicate in body) */
  replyQuoteText?: string
  searchHit?: boolean
  /** No bubble background — for stickers */
  bare?: boolean
  /** Only one message in the virtual list may show hover chrome at a time */
  showHoverActions?: boolean
  onHoverActionsChange?: (eventId: string | null) => void
  onReply: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  onScrollTo: (
    eventId: string,
    mediaIds?: string[],
    highlightMs?: number,
    behavior?: ScrollBehavior,
    highlightText?: string,
  ) => void
  children: React.ReactNode
  bubbleClassName?: string
}

const BubbleChrome: React.FC<BubbleChromeProps> = ({
  eventId,
  isOwn,
  showSender,
  isContinuation,
  afterDaySep,
  senderName,
  senderId,
  room,
  myUserId,
  reactionTick,
  receiptTick = 0,
  readEventId,
  replyParentId,
  replyMediaIds,
  replyQuoteText,
  searchHit,
  bare,
  showHoverActions = false,
  onHoverActionsChange,
  onReply,
  onContextMenu,
  onScrollTo,
  children,
  bubbleClassName,
}) => {
  const client = useSessionStore((s) => s.client)
  const parent = replyParentId ? room.findEventById(replyParentId) ?? null : null
  const reactions = useMemo(
    () => getReactionsForEvent(room, eventId, myUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, eventId, myUserId, reactionTick],
  )

  const receiptId = readEventId || eventId
  const tipReaders = useMemo(() => {
    const ev = room.findEventById(receiptId)
    return getReceiptTipReaders(room, ev, myUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, receiptId, myUserId, receiptTick])

  // Own: anyone whose receipt tip is at or past this event (Matrix inference).
  // Others: only users whose tip is currently docked on this event.
  const ownReaders = useMemo(() => {
    if (!isOwn) return []
    return getUsersWhoReadEvent(room, receiptId, myUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, receiptId, myUserId, isOwn, receiptTick])

  const stripReaders = isOwn ? ownReaders : tipReaders
  const showReadStrip = stripReaders.length > 0

  const handleReact = async (key: string) => {
    try {
      await toggleReaction(room, eventId, key, myUserId)
    } catch (err) {
      console.error('Failed to toggle reaction', err)
    }
  }

  return (
    <div
      id={`msg-${eventId}`}
      className={clsx(
        // No `group` on the full-width row — virtualized rows are 100% wide, so
        // hovering empty space left of own bubbles would light up the wrong actions.
        'tg-msg relative flex w-full min-w-0 scroll-mt-8',
        isOwn ? 'justify-end pl-12' : 'justify-start pr-12',
        // Top padding only — bottom spacing lives on .tg-timeline-row
        afterDaySep ? 'pt-0' : isContinuation ? 'pt-1' : 'pt-1.5',
        searchHit && 'tg-msg-search-hit',
      )}
      onContextMenu={onContextMenu}
    >
      <div
        className={clsx(
          'flex flex-col min-w-0',
          isOwn ? 'items-end' : 'items-start',
          bare ? 'max-w-[160px]' : 'max-w-[min(72%,28rem)]',
        )}
      >
        {showSender && !isOwn && !isContinuation && (
          <div
            className="tg-sender"
            style={senderId ? { color: getUserColor(senderId) } : undefined}
          >
            {senderName}
          </div>
        )}
        <div
          className="relative w-fit max-w-full min-w-0"
          onMouseEnter={() => onHoverActionsChange?.(eventId)}
          onMouseLeave={() => onHoverActionsChange?.(null)}
        >
          <div
            className={clsx(
              bare
                ? 'tg-sticker'
                : clsx(
                    'tg-bubble',
                    isOwn ? 'tg-bubble--out' : 'tg-bubble--in',
                    isContinuation && 'tg-bubble--continued',
                  ),
              bubbleClassName,
            )}
          >
            {replyParentId && (
              <ReplyChip
                parent={parent}
                parentId={replyParentId}
                mediaIds={
                  replyMediaIds?.length ? replyMediaIds : [replyParentId]
                }
                quoteText={replyQuoteText}
                onScrollTo={onScrollTo}
              />
            )}
            {children}
          </div>
          {showHoverActions && (
            <MessageHoverActions
              isOwn={isOwn}
              onReply={onReply}
              onPickReaction={handleReact}
            />
          )}
        </div>
        <ReactionBar reactions={reactions} onToggle={handleReact} />
        {showReadStrip && (
          <ReadByAvatars
            client={client}
            readers={stripReaders}
            align={isOwn ? 'end' : 'start'}
          />
        )}
      </div>
    </div>
  )
}

const AlbumBubble = memo(function AlbumBubble({
  item,
  isOwn,
  showSender,
  isContinuation,
  afterDaySep,
  room,
  myUserId,
  reactionTick,
  receiptTick = 0,
  selectedIds,
  highlightIds,
  selecting,
  searchHit,
  onToggleSelect,
  onReply,
  onContextMenu,
  onScrollTo,
  mentionMembers,
  onUserClick,
  showHoverActions = false,
  onHoverActionsChange,
}: {
  item: Extract<TimelineItem, { kind: 'album' }>
  isOwn: boolean
  showSender: boolean
  isContinuation: boolean
  afterDaySep?: boolean
  room: Room
  myUserId: string | null
  reactionTick: number
  receiptTick?: number
  selectedIds: Set<string>
  highlightIds: Set<string>
  selecting: boolean
  searchHit?: boolean
  onToggleSelect: (eventId: string) => void
  onReply: (events: MatrixEvent[]) => void
  onContextMenu: (e: React.MouseEvent, events: MatrixEvent[]) => void
  onScrollTo: (
    eventId: string,
    mediaIds?: string[],
    highlightMs?: number,
    behavior?: ScrollBehavior,
    highlightText?: string,
  ) => void
  mentionMembers: { userId: string; displayName: string }[]
  onUserClick: (userId: string) => void
  showHoverActions?: boolean
  onHoverActionsChange?: (eventId: string | null) => void
}) {
  const root = item.imageEvents[0]
  const eventId = root.getId() || ''
  const tipEvent = item.events[item.events.length - 1] ?? root
  const tipEventId = tipEvent.getId() || eventId
  const senderName = getSenderName(root)
  const senderId = root.getSender() || null
  const ts = tipEvent.getTs()
  const count = item.imageEvents.length
  const visible = item.imageEvents.slice(0, 4)
  const extra = count - visible.length
  const replyParentId = getInReplyToId(root)
  const replyMediaIds = getReplyMediaIds(root)
  const delivery = useMemo(
    () => getOwnDeliveryStatus(room, tipEventId, myUserId, isOwn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, tipEventId, myUserId, isOwn, receiptTick],
  )
  const deliveryReaders = useMemo(
    () => getUsersWhoReadEvent(room, tipEventId, myUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, tipEventId, myUserId, receiptTick],
  )
  const client = useSessionStore((s) => s.client)

  const handleAlbumReply = () => {
    const selected = item.imageEvents.filter((e) => {
      const id = e.getId()
      return id && selectedIds.has(id)
    })
    onReply(selected.length > 0 ? selected : item.imageEvents)
  }

  return (
    <BubbleChrome
      eventId={eventId}
      isOwn={isOwn}
      showSender={showSender}
      isContinuation={isContinuation}
      afterDaySep={afterDaySep}
      senderName={senderName}
      senderId={senderId}
      room={room}
      myUserId={myUserId}
      reactionTick={reactionTick}
      receiptTick={receiptTick}
      readEventId={tipEventId}
      replyParentId={replyParentId}
      replyMediaIds={replyMediaIds}
      searchHit={searchHit}
      showHoverActions={showHoverActions}
      onHoverActionsChange={onHoverActionsChange}
      onReply={handleAlbumReply}
      onContextMenu={(e) => onContextMenu(e, item.events)}
      onScrollTo={onScrollTo}
      bubbleClassName="overflow-hidden !p-[2px]"
    >
      <div
        className={clsx(
          albumGridClass(Math.min(count, 4)),
          selecting && 'tg-selecting',
        )}
      >
        {visible.map((ev, idx) => {
          const id = ev.getId() || ''
          const isSelected = !!id && selectedIds.has(id)
          const isFlash = !!id && highlightIds.has(id)
          return (
            <div
              key={id || idx}
              id={id ? `msg-media-${id}` : undefined}
              className={clsx(
                'tg-album-cell',
                isSelected && 'tg-album-cell--selected',
                isFlash && 'tg-album-cell--flash',
              )}
              style={{
                aspectRatio:
                  mediaAspectRatio(ev.getContent() as { info?: { w?: number; h?: number } }) ||
                  undefined,
              }}
            >
              <MediaImage
                content={ev.getContent()}
                imageId={selecting ? undefined : id || undefined}
                fill
              />
              <button
                type="button"
                className={clsx(
                  'tg-album-check',
                  isSelected && 'tg-album-check--on',
                )}
                aria-label={isSelected ? 'Снять выделение' : 'Выделить фото'}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  if (id) onToggleSelect(id)
                }}
              >
                {isSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
              </button>
              {selecting && (
                <button
                  type="button"
                  className="absolute inset-0 z-[2] cursor-pointer"
                  aria-label="Выделить фото"
                  onClick={() => {
                    if (id) onToggleSelect(id)
                  }}
                />
              )}
              {idx === visible.length - 1 && extra > 0 && (
                <div className="absolute inset-0 bg-black/45 flex items-center justify-center text-white text-xl font-semibold pointer-events-none">
                  +{extra}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {item.caption && (
        <div className="px-0.5 pt-1.5 pb-1 text-[14px]">
          <MessageMarkdown
            text={item.caption}
            members={mentionMembers}
            onUserClick={onUserClick}
          />
        </div>
      )}
      <BubbleTime
        ts={ts}
        delivery={delivery}
        ticks={
          delivery ? (
            <DeliveryTicksButton
              client={client}
              delivery={delivery}
              readers={deliveryReaders}
            />
          ) : null
        }
      />
    </BubbleChrome>
  )
})

const MessageBubble = memo(function MessageBubble({
  event,
  isOwn,
  showSender,
  isContinuation,
  afterDaySep,
  room,
  myUserId,
  reactionTick,
  receiptTick = 0,
  highlightIds,
  searchHit,
  selecting,
  selected,
  onToggleSelect,
  mentionMembers,
  onUserClick,
  onReply,
  onContextMenu,
  onScrollTo,
  showHoverActions = false,
  onHoverActionsChange,
}: {
  event: MatrixEvent
  isOwn: boolean
  showSender: boolean
  isContinuation: boolean
  afterDaySep?: boolean
  room: Room
  myUserId: string | null
  reactionTick: number
  receiptTick?: number
  highlightIds: Set<string>
  searchHit?: boolean
  selecting?: boolean
  selected?: boolean
  onToggleSelect?: (eventId: string) => void
  mentionMembers: { userId: string; displayName: string }[]
  onUserClick: (userId: string) => void
  onReply: (events: MatrixEvent[]) => void
  onContextMenu: (e: React.MouseEvent, events: MatrixEvent[]) => void
  onScrollTo: (
    eventId: string,
    mediaIds?: string[],
    highlightMs?: number,
    behavior?: ScrollBehavior,
    highlightText?: string,
  ) => void
  showHoverActions?: boolean
  onHoverActionsChange?: (eventId: string | null) => void
}) {
  const content = event.getContent() as Record<string, unknown>
  const senderName = getSenderName(event)
  const senderId = event.getSender() || null
  const isStickerEvent = event.getType() === 'm.sticker'
  const isPhoto =
    !event.isDecryptionFailure() && content.msgtype === 'm.image'
  const isFlushMedia =
    !isStickerEvent &&
    !event.isDecryptionFailure() &&
    (isPhoto ||
      content.msgtype === 'm.video' ||
      (content.msgtype === 'm.file' && isVideoEvent(event)))
  const eventId = event.getId() || ''
  const replyParentId = getInReplyToId(event)
  const replyMediaIds = getReplyMediaIds(event)
  const embeddedQuote = useMemo(() => {
    if (!replyParentId) return null
    if (content.msgtype !== 'm.text' && content.msgtype !== 'm.emote') {
      return null
    }
    return extractEmbeddedQuote(content)
  }, [content, replyParentId])
  const displayContent = embeddedQuote?.contentWithoutQuote ?? content
  const replyQuoteText = embeddedQuote?.quoteText
  const isFlash = !!eventId && highlightIds.has(eventId)
  const edited = isMessageEdited(event)
  const delivery = useMemo(
    () => getOwnDeliveryStatus(room, eventId, myUserId, isOwn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, eventId, myUserId, isOwn, receiptTick],
  )
  const deliveryReaders = useMemo(
    () => getUsersWhoReadEvent(room, eventId, myUserId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, eventId, myUserId, receiptTick],
  )
  const client = useSessionStore((s) => s.client)

  let messageContent: React.ReactNode

  if (event.isDecryptionFailure()) {
      messageContent = (
      <div className="tg-bubble-text tg-decrypt-fail text-[13.5px] italic leading-[1.35]">
        Не удалось расшифровать
      </div>
    )
  } else if (isStickerEvent) {
    messageContent = (
      <div
        id={eventId ? `msg-media-${eventId}` : undefined}
        className={clsx(
          'tg-sticker-wrap',
          isFlash && 'tg-sticker-wrap--flash',
        )}
      >
        <MediaImage
          content={content}
          imageId={event.getId() || undefined}
          variant="sticker"
        />
      </div>
    )
  } else {
    switch (content.msgtype) {
      case 'm.text':
      case 'm.emote': {
        const hasBody =
          !!(
            (typeof displayContent.body === 'string' &&
              displayContent.body.trim()) ||
            (typeof displayContent.formatted_body === 'string' &&
              displayContent.formatted_body.trim())
          )
        messageContent = hasBody ? (
          <div className="tg-bubble-text">
            <MessageBody
              content={displayContent}
              plainText={
                content.msgtype === 'm.emote'
                  ? `* ${
                      typeof displayContent.body === 'string'
                        ? displayContent.body
                        : ''
                    }`
                  : undefined
              }
              members={mentionMembers}
              onUserClick={onUserClick}
            />
          </div>
        ) : null
        break
      }
      case 'm.image':
        messageContent = (
          <div
            id={eventId ? `msg-media-${eventId}` : undefined}
            className={clsx(
              'min-h-[200px] rounded-lg bg-gray-800/20',
              isFlash && 'tg-album-cell--flash rounded-xl overflow-hidden',
            )}
          >
            <MediaImage content={content} imageId={event.getId() || undefined} />
            {typeof (content as any)[ALBUM_CAPTION_KEY] === 'string' &&
              (content as any)[ALBUM_CAPTION_KEY].trim() && (
                <div className="px-0.5 pt-1">
                  <MessageMarkdown
                    text={(content as any)[ALBUM_CAPTION_KEY]}
                    members={mentionMembers}
                    onUserClick={onUserClick}
                  />
                </div>
              )}
          </div>
        )
        break
      case 'm.audio':
        messageContent = <MediaAudio content={content} />
        break
      case 'm.video':
        messageContent = (
          <div
            id={eventId ? `msg-media-${eventId}` : undefined}
            className={clsx(isFlash && 'tg-album-cell--flash rounded-xl overflow-hidden')}
          >
            <MediaVideo content={content} videoId={event.getId() || undefined} />
            {typeof (content as any)[ALBUM_CAPTION_KEY] === 'string' &&
              (content as any)[ALBUM_CAPTION_KEY].trim() && (
                <div className="px-0.5 pt-1">
                  <MessageMarkdown
                    text={(content as any)[ALBUM_CAPTION_KEY]}
                    members={mentionMembers}
                    onUserClick={onUserClick}
                  />
                </div>
              )}
          </div>
        )
        break
      case 'm.file':
        messageContent = isVideoEvent(event) ? (
          <div
            id={eventId ? `msg-media-${eventId}` : undefined}
            className={clsx(isFlash && 'tg-album-cell--flash rounded-xl overflow-hidden')}
          >
            <MediaVideo content={content} videoId={event.getId() || undefined} />
          </div>
        ) : (
          <MediaFile content={content} />
        )
        break
      default:
        if (content.body || content.formatted_body) {
          messageContent = (
            <div className="tg-bubble-text">
              <MessageBody
                content={content}
                members={mentionMembers}
                onUserClick={onUserClick}
              />
            </div>
          )
        } else {
          return null
        }
    }
  }

  return (
    <div
      className={clsx(
        'relative w-full',
        selecting && 'tg-msg-selecting',
        selected && 'tg-msg-selected',
      )}
    >
      {selecting && eventId && onToggleSelect && (
        <button
          type="button"
          className={clsx(
            'tg-msg-check',
            isOwn ? 'tg-msg-check--own' : 'tg-msg-check--in',
            selected && 'tg-msg-check--on',
          )}
          aria-label={selected ? 'Снять выделение' : 'Выделить'}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggleSelect(eventId)
          }}
        >
          {selected && (
            <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
          )}
        </button>
      )}
      <BubbleChrome
        eventId={eventId}
        isOwn={isOwn}
        showSender={showSender}
        isContinuation={isContinuation}
        afterDaySep={afterDaySep}
        senderName={senderName}
        senderId={senderId}
        room={room}
        myUserId={myUserId}
        reactionTick={reactionTick}
        receiptTick={receiptTick}
        replyParentId={replyParentId}
        replyMediaIds={replyMediaIds}
        replyQuoteText={replyQuoteText}
        searchHit={searchHit}
        bare={isStickerEvent}
        showHoverActions={showHoverActions}
        onHoverActionsChange={onHoverActionsChange}
        onReply={() => onReply([event])}
        onContextMenu={(e) => {
          if (selecting && eventId && onToggleSelect) {
            e.preventDefault()
            e.stopPropagation()
            onToggleSelect(eventId)
            return
          }
          onContextMenu(e, [event])
        }}
        onScrollTo={onScrollTo}
        bubbleClassName={clsx(
          isFlushMedia && 'tg-bubble--media overflow-hidden !p-[2px]',
          isFlash && !isFlushMedia && !isStickerEvent && 'tg-msg-highlight',
          selected && 'tg-msg-bubble-selected',
        )}
      >
        {selecting && eventId && onToggleSelect && (
          <button
            type="button"
            className="absolute inset-0 z-[3] cursor-pointer rounded-[inherit]"
            aria-label="Выделить сообщение"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onToggleSelect(eventId)
            }}
          />
        )}
        {isStickerEvent ? (
          <>
            {messageContent}
            <span className="tg-sticker-time">
              {format(event.getTs(), 'HH:mm')}
              {delivery && (
                <DeliveryTicksButton
                  client={client}
                  delivery={delivery}
                  readers={deliveryReaders}
                />
              )}
            </span>
          </>
        ) : isFlushMedia ? (
          <>
            {messageContent}
            <BubbleTime
              ts={event.getTs()}
              edited={edited}
              delivery={delivery}
              ticks={
                delivery ? (
                  <DeliveryTicksButton
                    client={client}
                    delivery={delivery}
                    readers={deliveryReaders}
                  />
                ) : null
              }
            />
          </>
        ) : (
          <div className="tg-bubble-body">
            {messageContent ?? <span className="tg-bubble-text" />}
            <BubbleTime
              ts={event.getTs()}
              edited={edited}
              delivery={delivery}
              ticks={
                delivery ? (
                  <DeliveryTicksButton
                    client={client}
                    delivery={delivery}
                    readers={deliveryReaders}
                  />
                ) : null
              }
            />
          </div>
        )}
      </BubbleChrome>
    </div>
  )
})

export function MessageTimeline() {
  const [messages, setMessages] = useState<MatrixEvent[]>([])
  const [reactionTick, setReactionTick] = useState(0)
  const [receiptTick, setReceiptTick] = useState(0)
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [pendingMention, setPendingMention] = useState<PendingMention | null>(
    null,
  )
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    events: MatrixEvent[]
    isOwn: boolean
    quoteText?: string
  } | null>(null)
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([])
  const [selectionMode, setSelectionMode] = useState(false)
  const [forwardEvents, setForwardEvents] = useState<MatrixEvent[] | null>(
    null,
  )
  const [forwardBusy, setForwardBusy] = useState(false)
  const [highlightMediaIds, setHighlightMediaIds] = useState<string[]>([])
  const [chatSearchOpen, setChatSearchOpen] = useState(false)
  const [chatSearchQuery, setChatSearchQuery] = useState('')
  const [searchResultsOpen, setSearchResultsOpen] = useState(false)
  const [searchCursor, setSearchCursor] = useState(-1)
  const [typingNames, setTypingNames] = useState<string[]>([])
  const timelineRef = useRef<HTMLDivElement>(null)
  const chatSearchRef = useRef<HTMLInputElement>(null)
  const searchPanelRef = useRef<HTMLDivElement>(null)
  const [isDecryptModalOpen, setDecryptModalOpen] = useState(false)
  const [showDecrypt, setShowDecrypt] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [viewer, setViewer] = useState<{ images: ViewerImage[]; index: number } | null>(null)
  const [videoViewer, setVideoViewer] = useState<{
    videos: ViewerVideo[]
    index: number
  } | null>(null)
  const [showJumpDown, setShowJumpDown] = useState(false)
  const [jumpBadge, setJumpBadge] = useState(0)
  /** Only one message may mount hover reply/react chrome (virtual rows overlap) */
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null)
  const hoverClearTimer = useRef<number | null>(null)

  const clearHoveredEventId = useCallback(() => {
    if (hoverClearTimer.current != null) {
      window.clearTimeout(hoverClearTimer.current)
      hoverClearTimer.current = null
    }
    setHoveredEventId(null)
  }, [])

  const setHoveredEventIdDelayed = useCallback((eventId: string | null) => {
    if (hoverClearTimer.current != null) {
      window.clearTimeout(hoverClearTimer.current)
      hoverClearTimer.current = null
    }
    if (eventId) {
      setHoveredEventId(eventId)
      return
    }
    // Grace period so the cursor can cross into the side actions
    hoverClearTimer.current = window.setTimeout(() => {
      hoverClearTimer.current = null
      setHoveredEventId(null)
    }, 280)
  }, [])
  const [unreadBeforeId, setUnreadBeforeId] = useState<string | null>(null)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  /** Forward (newer) pagination in flight — drives auto-continue near bottom. */
  const [isLoadingNewer, setIsLoadingNewer] = useState(false)
  /** Hide timeline until first measure + scroll settle (anti-flicker on room open). */
  const [isReady, setIsReady] = useState(false)
  /** First live/scrollback hydrate finished for this room (empty room ≠ forever spinner). */
  const [initialHydrated, setInitialHydrated] = useState(false)
  const [stickyDateLabel, setStickyDateLabel] = useState<string | null>(null)
  const [stickyDateTs, setStickyDateTs] = useState<number | null>(null)
  const [stickyDateVisible, setStickyDateVisible] = useState(false)
  const stickyDateHideTimer = useRef<number | null>(null)
  const stickyDatePillRef = useRef<HTMLButtonElement>(null)
  const [dateJumpOpen, setDateJumpOpen] = useState(false)
  const [dateJumpLoading, setDateJumpLoading] = useState(false)
  const dateJumpOpenRef = useRef(false)
  dateJumpOpenRef.current = dateJumpOpen
  const dateJumpGenRef = useRef(0)
  const dragDepth = useRef(0)
  const stickToBottom = useRef(true)
  const highlightTimer = useRef<number | null>(null)
  /** Initial open positioning: bottom | unread | event */
  const openIntent = useRef<'bottom' | 'unread' | 'event'>('bottom')
  const didInitialPosition = useRef(false)
  const prevMsgCount = useRef(0)
  const prevLastMsgId = useRef<string | null>(null)
  const prevFirstMsgId = useRef<string | null>(null)
  const loadingHistory = useRef(false)
  const loadingNewer = useRef(false)
  const historyExhausted = useRef(false)
  /** Throttle upward pagination — at most once per 500ms. */
  const lastLoadOlderAtRef = useRef(0)
  /** Throttle downward (forward) pagination — at most once per 500ms. */
  const lastLoadNewerAtRef = useRef(0)
  /** Prepend anti-loop: first id + scrollHeight when stuck near top. */
  const prevFirstIdRef = useRef<string | undefined>(undefined)
  const prevScrollHeightRef = useRef(0)
  /** Skip jump-down badge when older messages are prepended */
  const ignoreHistoryGrowth = useRef(false)
  /** True while the user is actively scrolling the timeline */
  const isTimelineScrolling = useRef(false)
  const pendingReceiptTick = useRef(false)
  const scrollIdleTimer = useRef<number | null>(null)
  const decryptRefreshTimer = useRef<number | null>(null)
  /** Load history only after scroll settles (avoids mid-inertia jump) */
  const pendingLoadOlder = useRef(false)
  const pendingLoadNewer = useRef(false)
  const timelineRowsRef = useRef<TimelineRow[]>([])
  /** Cancels in-flight programmatic scroll-to-message animations */
  const scrollAnimRef = useRef<number | null>(null)
  const scrollAnimGen = useRef(0)
  /** Preserve quote highlight across history load for reply-chip jumps */
  const pendingReplyHighlightRef = useRef<{
    eventId: string
    mediaIds?: string[]
    highlightMs: number
    highlightText?: string
  } | null>(null)
  /** Non-live window when jumping to an older event (profile / search) */
  const timelineWindowRef = useRef<TimelineWindow | null>(null)
  /** Bumps on every room switch — stale async must not write messages */
  const timelineEpochRef = useRef(0)
  const activeRoomIdRef = useRef<string | null>(null)

  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  activeRoomIdRef.current = activeRoomId
  const rooms = useRoomStore((state) => state.rooms)
  const pendingScrollEventId = useRoomStore(
    (state) => state.pendingScrollEventId,
  )
  const pendingScrollNonce = useRoomStore((state) => state.pendingScrollNonce)
  const pendingUnreadEventId = useRoomStore(
    (state) => state.pendingUnreadEventId,
  )
  const clearPendingScrollEvent = useRoomStore(
    (state) => state.actions.clearPendingScrollEvent,
  )
  const clearPendingUnreadEvent = useRoomStore(
    (state) => state.actions.clearPendingUnreadEvent,
  )
  const markRoomAsRead = useRoomStore((state) => state.actions.markRoomAsRead)
  const profileRoomId = useRoomStore((state) => state.profileRoomId)
  const openRoomProfile = useRoomStore((state) => state.actions.openRoomProfile)
  const closeRoomProfile = useRoomStore(
    (state) => state.actions.closeRoomProfile,
  )

  /** Only apply timeline events if this room is still the active one. */
  const commitTimelineMessages = useCallback(
    (roomId: string, events: MatrixEvent[], epoch?: number) => {
      if (activeRoomIdRef.current !== roomId) return
      if (epoch != null && epoch !== timelineEpochRef.current) return
      const next = events.filter((e) => {
        const rid = e.getRoomId?.()
        return !rid || rid === roomId
      })
      setMessages(next)
    },
    [],
  )

  const [pinnedMessages, setPinnedMessages] = useState<ResolvedPinnedMessage[]>(
    [],
  )
  const [activePinIndex, setActivePinIndex] = useState(0)
  const [pinStateTick, setPinStateTick] = useState(0)
  const pinJumpLockRef = useRef(false)
  const pinJumpGenRef = useRef(0)
  /** After click: briefly keep "next" pin until the user scrolls manually */
  const pinHoldJumpIdRef = useRef<string | null>(null)
  /** Ignore hold-clear from scroll events caused by our own jump */
  const pinIgnoreScrollHoldUntilRef = useRef(0)
  const pinScrollDirRef = useRef<PinScrollDirection>('none')
  const pinLastScrollTopRef = useRef(0)
  const pinSyncRafRef = useRef<number | null>(null)
  const pinBarRef = useRef<HTMLDivElement>(null)
  const pinnedMessagesRef = useRef(pinnedMessages)
  pinnedMessagesRef.current = pinnedMessages
  const activePinIndexRef = useRef(activePinIndex)
  activePinIndexRef.current = activePinIndex

  const setActivePinIndexSynced = useCallback((index: number) => {
    activePinIndexRef.current = index
    setActivePinIndex(index)
  }, [])

  const client = useSessionStore((state) => state.client)
  const myUserId = client?.getUserId() ?? null
  const verifiedTick = useVerificationUiStore((s) => s.verifiedTick)

  // Prefer SDK room map — the sidebar `rooms` array can rebuild on sync without
  // the active room briefly disappearing (that used to unmount the timeline).
  const activeRoom =
    (activeRoomId && client?.getRoom(activeRoomId)) ||
    rooms.find((r) => r.roomId === activeRoomId) ||
    undefined

  const personalPinsHydrate = usePersonalPinnedStore((s) => s.hydrate)
  const personalPinsByUser = usePersonalPinnedStore((s) => s.byUser)
  useEffect(() => {
    personalPinsHydrate()
  }, [personalPinsHydrate])

  const personalPinnedIds = useMemo(() => {
    if (!myUserId || !activeRoomId) return [] as string[]
    const roomPins = personalPinsByUser[myUserId]?.[activeRoomId]
    return Array.isArray(roomPins) ? roomPins : []
  }, [myUserId, activeRoomId, personalPinsByUser])

  // Who's typing in the active room
  useEffect(() => {
    if (!client || !activeRoom || !myUserId) {
      setTypingNames([])
      return
    }
    const room = activeRoom
    const refresh = () => {
      const names: string[] = []
      for (const m of room.getJoinedMembers()) {
        if (!m.typing || m.userId === myUserId) continue
        names.push(m.name || m.userId.split(':')[0]?.slice(1) || m.userId)
      }
      setTypingNames(names)
    }
    refresh()
    const onTyping = (_ev: MatrixEvent, member: { roomId?: string }) => {
      if (member?.roomId && member.roomId !== room.roomId) return
      refresh()
    }
    client.on(RoomMemberEvent.Typing, onTyping)
    return () => {
      client.removeListener(RoomMemberEvent.Typing, onTyping)
    }
  }, [client, activeRoom, myUserId, activeRoomId])

  const typingLabel = useMemo(() => {
    if (!activeRoom || typingNames.length === 0) return null
    const isDirect = activeRoom.getJoinedMemberCount() <= 2
    return formatTypingLabel(typingNames, isDirect)
  }, [activeRoom, typingNames])

  // ⌘F / Ctrl+F — search in current chat
  useEffect(() => {
    if (!activeRoomId) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'f') return
      const target = e.target as HTMLElement | null
      if (target?.closest?.('aside')) return
      e.preventDefault()
      setChatSearchOpen(true)
      window.setTimeout(() => {
        chatSearchRef.current?.focus()
        chatSearchRef.current?.select()
      }, 20)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeRoomId])

  useEffect(() => {
    if (!client) {
      setShowDecrypt(false)
      return
    }
    let cancelled = false
    const check = async () => {
      try {
        await matrixService.ensureCryptoReady()
        const crypto = client.getCrypto()
        const userId = client.getUserId()
        const deviceId = client.getDeviceId()
        if (!crypto || !userId || !deviceId) {
          if (!cancelled) setShowDecrypt(true)
          return
        }
        const status = await crypto.getDeviceVerificationStatus(
          userId,
          deviceId,
        )
        if (cancelled) return
        // Hide after this session is verified; keep for recovery while unverified
        setShowDecrypt(!status?.isVerified())
      } catch {
        if (!cancelled) setShowDecrypt(true)
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [client, verifiedTick])

  const selectedSet = useMemo(() => new Set(selectedMediaIds), [selectedMediaIds])
  const highlightSet = useMemo(() => new Set(highlightMediaIds), [highlightMediaIds])
  const chatSearchQ = chatSearchQuery.trim().toLowerCase()

  /** Local search corpus: live timeline ∪ current view (historical window). */
  const searchCorpus = useMemo(() => {
    const byId = new Map<string, MatrixEvent>()
    const add = (events: MatrixEvent[]) => {
      for (const event of events) {
        const id = event.getId()
        if (id) byId.set(id, event)
      }
    }
    if (activeRoom) {
      add(
        activeRoom
          .getLiveTimeline()
          .getEvents()
          .filter(isTimelineMessageEvent),
      )
    }
    add(messages)
    return Array.from(byId.values()).sort((a, b) => a.getTs() - b.getTs())
    // reactionTick: decrypt / window reshuffle may mutate event bodies in place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoom, messages, reactionTick])

  const searchHitCount = useMemo(() => {
    if (!chatSearchQ) return 0
    return searchCorpus.filter((e) => eventMatchesSearch(e, chatSearchQ)).length
  }, [searchCorpus, chatSearchQ])

  const searchResults = useMemo(() => {
    if (!chatSearchQ) return []
    const out: {
      eventId: string
      senderId: string
      senderName: string
      snippet: string
      ts: number
    }[] = []
    for (let i = searchCorpus.length - 1; i >= 0; i--) {
      const event = searchCorpus[i]
      if (!eventMatchesSearch(event, chatSearchQ)) continue
      const eventId = event.getId()
      if (!eventId) continue
      const snippet = (
        messagePlainText(event) ||
        messageSnippet(event) ||
        'Сообщение'
      ).replace(/\s+/g, ' ')
      out.push({
        eventId,
        senderId: event.getSender() || '',
        senderName: getSenderName(event),
        snippet: snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet,
        ts: event.getTs(),
      })
      if (out.length >= 40) break
    }
    return out
  }, [searchCorpus, chatSearchQ])

  // Keep cursor valid when the result list changes
  useEffect(() => {
    if (!chatSearchQ || searchResults.length === 0) {
      setSearchCursor(-1)
      return
    }
    setSearchCursor((i) =>
      i < 0 ? -1 : Math.min(i, searchResults.length - 1),
    )
  }, [chatSearchQ, searchResults])

  const scrollToBottom = useCallback((_smooth = false) => {
    const el = timelineRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  /** Pin to bottom after a layout-affecting commit (send / jump to latest). */
  const scrollToBottomAfterLayout = useCallback(() => {
    scrollToBottom(false)
  }, [scrollToBottom])

  const scrollRowIntoView = useCallback(
    (eventId: string, align: 'start' | 'center' | 'end' = 'center') => {
      const node =
        document.getElementById(`message-${eventId}`) ||
        findMsgDomEl(eventId) ||
        document.getElementById('tg-unread-anchor')
      if (!node) return false
      node.scrollIntoView({ block: align, behavior: 'auto' })
      return true
    },
    [],
  )

  const revealTimeline = useCallback(() => {
    setIsReady(true)
  }, [])

  /**
   * Place the viewport for a freshly opened room:
   * 1) pending search jump → that event
   * 2) unread divider → first unread
   * 3) otherwise → latest (bottom)
   */
  const applyInitialPosition = useCallback(() => {
    if (didInitialPosition.current) return
    if (!timelineRef.current || messages.length === 0) return

    if (openIntent.current === 'event' && pendingScrollEventId) {
      if (scrollRowIntoView(pendingScrollEventId, 'center')) {
        stickToBottom.current = false
        didInitialPosition.current = true
        setShowJumpDown(true)
        revealTimeline()
        return
      }
      // Event not in DOM yet — wait for more history / decrypt
      return
    }

    if (openIntent.current === 'unread' && unreadBeforeId) {
      if (scrollRowIntoView(unreadBeforeId, 'center')) {
        stickToBottom.current = false
        didInitialPosition.current = true
        setShowJumpDown(true)
        revealTimeline()
        return
      }
      const inTimeline = messages.some((e) => e.getId() === unreadBeforeId)
      if (!inTimeline) {
        openIntent.current = 'bottom'
        stickToBottom.current = true
        setUnreadBeforeId(null)
        clearPendingUnreadEvent()
      } else {
        return
      }
    }

    // Default: bottom — native scrollHeight effect reveals after first paint.
    stickToBottom.current = true
    didInitialPosition.current = true
    setShowJumpDown(false)
    setJumpBadge(0)
  }, [
    messages,
    pendingScrollEventId,
    unreadBeforeId,
    clearPendingUnreadEvent,
    scrollRowIntoView,
    revealTimeline,
  ])

  // Hard-reset readiness when the room changes (also covered by
  // key={activeRoomId} remount, but keep explicit for safety).
  useLayoutEffect(() => {
    setIsReady(false)
    setInitialHydrated(false)
    didInitialPosition.current = false
    lastLoadOlderAtRef.current = 0
    lastLoadNewerAtRef.current = 0
    prevFirstIdRef.current = undefined
    prevScrollHeightRef.current = 0
  }, [activeRoomId])

  // Reset composer / open intent when switching rooms
  useEffect(() => {
    timelineEpochRef.current += 1
    setReplyTo(null)
    setEditTarget(null)
    setCtxMenu(null)
    setPendingMention(null)
    setSelectedMediaIds([])
    setSelectionMode(false)
    setForwardEvents(null)
    setHighlightMediaIds([])
    setChatSearchOpen(false)
    setChatSearchQuery('')
    setSearchResultsOpen(false)
    setSearchCursor(-1)
    setTypingNames([])
    setShowJumpDown(false)
    setJumpBadge(0)
    setMessages([])
    setIsReady(false)
    setInitialHydrated(false)
    if (scrollAnimRef.current != null) {
      cancelAnimationFrame(scrollAnimRef.current)
      scrollAnimRef.current = null
    }
    scrollAnimGen.current += 1
    timelineWindowRef.current = null
    didInitialPosition.current = false
    prevMsgCount.current = 0
    prevLastMsgId.current = null
    prevFirstMsgId.current = null
    loadingHistory.current = false
    loadingNewer.current = false
    historyExhausted.current = false
    lastLoadOlderAtRef.current = 0
    lastLoadNewerAtRef.current = 0
    prevFirstIdRef.current = undefined
    prevScrollHeightRef.current = 0
    pendingLoadOlder.current = false
    pendingLoadNewer.current = false
    setIsLoadingHistory(false)
    setIsLoadingNewer(false)
    if (scrollIdleTimer.current != null) {
      window.clearTimeout(scrollIdleTimer.current)
      scrollIdleTimer.current = null
    }
    isTimelineScrolling.current = false
    setJumpBadge(0)
    setShowJumpDown(false)
    clearHoveredEventId()

    if (pendingScrollEventId) {
      openIntent.current = 'event'
      stickToBottom.current = false
      setUnreadBeforeId(null)
    } else if (pendingUnreadEventId) {
      openIntent.current = 'unread'
      stickToBottom.current = false
      setUnreadBeforeId(pendingUnreadEventId)
    } else {
      openIntent.current = 'bottom'
      stickToBottom.current = true
      setUnreadBeforeId(null)
    }
    // Only re-run on room switch — intent is read once from store at open time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId])

  // Flush read for the room we're leaving — only if we were actually at the
  // bottom. Must run before other effects reset stickToBottom for the new room.
  const prevActiveForReadRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const prevId = prevActiveForReadRef.current
    const wasAtBottom = stickToBottom.current
    if (prevId && prevId !== activeRoomId && wasAtBottom) {
      void markRoomAsRead(prevId)
    }
    prevActiveForReadRef.current = activeRoomId
  }, [activeRoomId, markRoomAsRead])

  // If unread/event intent arrives with the same room tick, sync it
  useLayoutEffect(() => {
    if (!activeRoomId || didInitialPosition.current) return
    if (pendingScrollEventId) {
      openIntent.current = 'event'
      stickToBottom.current = false
      return
    }
    if (pendingUnreadEventId) {
      openIntent.current = 'unread'
      setUnreadBeforeId(pendingUnreadEventId)
      stickToBottom.current = false
    }
  }, [activeRoomId, pendingUnreadEventId, pendingScrollEventId])

  // Mark read while pinned to bottom; flush immediately on leave so a
  // cancelled 400ms timer cannot leave a ghost unread badge in the list.
  useEffect(() => {
    if (!activeRoomId || messages.length === 0) return
    const roomId = activeRoomId
    if (!stickToBottom.current) return
    const t = window.setTimeout(() => {
      void markRoomAsRead(roomId)
      clearPendingUnreadEvent()
      setUnreadBeforeId(null)
    }, 400)
    return () => {
      window.clearTimeout(t)
      // Room-switch flush is handled by the layout effect above (while
      // stickToBottom still reflects the previous room). Here only flush
      // when the dependency change is not a room switch (e.g. messages).
      if (
        stickToBottom.current &&
        prevActiveForReadRef.current === roomId &&
        activeRoomIdRef.current === roomId
      ) {
        void markRoomAsRead(roomId)
      }
    }
  }, [activeRoomId, messages.length, markRoomAsRead, clearPendingUnreadEvent])

  useEffect(() => {
    if (chatSearchOpen) chatSearchRef.current?.focus()
  }, [chatSearchOpen])

  // Click outside closes results (keeps query in the field)
  useEffect(() => {
    if (!searchResultsOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (searchPanelRef.current?.contains(t)) return
      if (chatSearchRef.current?.contains(t)) return
      setSearchResultsOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [searchResultsOpen])

  useEffect(() => {
    if (!activeRoomId || !client) return
    const roomId = activeRoomId
    const room = client.getRoom(roomId)
    if (!room) return

    const epoch = timelineEpochRef.current
    let cancelled = false
    const stillHere = () =>
      !cancelled &&
      epoch === timelineEpochRef.current &&
      activeRoomIdRef.current === roomId

    historyExhausted.current = false
    loadingHistory.current = false
    loadingNewer.current = false
    setIsLoadingHistory(false)

    const refreshFromLive = () => {
      if (!stillHere()) return
      commitTimelineMessages(
        roomId,
        room.getLiveTimeline().getEvents().filter(isTimelineMessageEvent),
        epoch,
      )
      setReactionTick((t) => t + 1)
    }

    const refresh = () => {
      if (!stillHere()) return
      // Keep jumped historical window until user returns to latest
      if (timelineWindowRef.current) {
        // Window reshuffles during timeline joins must not bump the jump badge
        ignoreHistoryGrowth.current = true
        commitTimelineMessages(
          roomId,
          timelineWindowRef.current
            .getEvents()
            .filter(isTimelineMessageEvent),
          epoch,
        )
        setReactionTick((t) => t + 1)
        return
      }
      refreshFromLive()
    }

    const handleTimelineEvent = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      const type = event.getType()
      if (
        type === 'm.room.message' ||
        type === 'm.sticker' ||
        type === 'm.room.encrypted' ||
        type === EventType.Reaction ||
        event.isDecryptionFailure()
      ) {
        // Don't clobber an in-flight history anchor restore
        if (
          loadingHistory.current ||
          loadingNewer.current
        ) {
          if (timelineWindowRef.current) return
          // Live timeline: still ignore while anchoring upward load
          if (loadingHistory.current) return
        }
        refresh()
      }
    }
    room.on(RoomEvent.Timeline, handleTimelineEvent)
    room.on(RoomEvent.Redaction, refresh)

    const onReceipt = () => {
      if (!stillHere()) return
      // Receipts only change the read-strip under bubbles — defer during scroll
      // so we don't remount virtual rows mid-gesture.
      if (isTimelineScrolling.current) {
        pendingReceiptTick.current = true
        return
      }
      setReceiptTick((t) => t + 1)
    }
    room.on(RoomEvent.Receipt, onReceipt)

    const onStateEvent = (event: MatrixEvent) => {
      if (!stillHere()) return
      if (event.getType() === EventType.RoomPinnedEvents) {
        setPinStateTick((t) => t + 1)
      }
    }
    room.on(RoomStateEvent.Events, onStateEvent)

    const onDecrypted = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      // MatrixEvent mutates in place. Avoid remounting the virtual list on
      // every decrypt mid-scroll (kills trackpad inertia). Coalesce updates.
      if (decryptRefreshTimer.current != null) {
        window.clearTimeout(decryptRefreshTimer.current)
      }
      const delay = isTimelineScrolling.current ? 240 : 90
      decryptRefreshTimer.current = window.setTimeout(() => {
        decryptRefreshTimer.current = null
        if (!stillHere()) return
        setReactionTick((t) => t + 1)
        // Full timeline recommit while anchoring / loading history teleports
        // the viewport — in-place mutation + reactionTick is enough to paint.
        if (
          loadingHistory.current ||
          loadingNewer.current ||
          isTimelineScrolling.current
        ) {
          return
        }
        refresh()
      }, delay)
    }
    client.on(MatrixEventEvent.Decrypted, onDecrypted)

    const onReplaced = (event: MatrixEvent) => {
      if (event.getRoomId() !== roomId) return
      refresh()
    }
    client.on(MatrixEventEvent.Replaced, onReplaced)

    // Don't clobber an in-flight jump-to-event window
    if (!timelineWindowRef.current) {
      commitTimelineMessages(
        roomId,
        room.getLiveTimeline().getEvents().filter(isTimelineMessageEvent),
        epoch,
      )
      setReactionTick((t) => t + 1)
    }

    // Sync only keeps a short live window — warm older history on open.
    // Keep this modest so opening a busy room still paginates on scroll-up
    // (full warm of hundreds at once fights the first scroll).
    ignoreHistoryGrowth.current = true
    void client
      .scrollback(room, 40)
      .then(() => {
        if (!stillHere()) return
        if (!timelineWindowRef.current) refreshFromLive()
      })
      .catch((err) => {
        if (!stillHere()) return
        console.warn('Initial scrollback failed', err)
        ignoreHistoryGrowth.current = false
      })
      .finally(() => {
        if (stillHere()) setInitialHydrated(true)
      })

    return () => {
      cancelled = true
      room.removeListener(RoomEvent.Timeline, handleTimelineEvent)
      room.removeListener(RoomEvent.Redaction, refresh)
      room.removeListener(RoomEvent.Receipt, onReceipt)
      room.removeListener(RoomStateEvent.Events, onStateEvent)
      client.removeListener(MatrixEventEvent.Decrypted, onDecrypted)
      client.removeListener(MatrixEventEvent.Replaced, onReplaced)
      if (decryptRefreshTimer.current != null) {
        window.clearTimeout(decryptRefreshTimer.current)
        decryptRefreshTimer.current = null
      }
    }
  }, [activeRoomId, client, commitTimelineMessages])

  // Load / refresh pinned messages for the active room
  useEffect(() => {
    if (!activeRoomId || !client) {
      setPinnedMessages([])
      setActivePinIndexSynced(0)
      return
    }
    const room = client.getRoom(activeRoomId)
    if (!room) {
      setPinnedMessages([])
      setActivePinIndexSynced(0)
      return
    }
    let cancelled = false
    const selfIds = personalPinnedIds

    // Show bar immediately from local cache, then enrich from network
    const local = resolvePinnedMessagesLocal(room, selfIds)
    setPinnedMessages(local)
    if (local.length === 0) setActivePinIndexSynced(0)

    void resolvePinnedMessagesNewestFirst(client, room, selfIds).then((pins) => {
      if (cancelled) return
      setPinnedMessages(pins)
      const prevId =
        pinnedMessagesRef.current[activePinIndexRef.current]?.eventId
      const keep = prevId ? pins.findIndex((p) => p.eventId === prevId) : -1
      setActivePinIndexSynced(
        pins.length === 0 ? 0 : keep >= 0 ? keep : 0,
      )
    })
    return () => {
      cancelled = true
    }
  }, [
    activeRoomId,
    client,
    pinStateTick,
    personalPinnedIds,
    setActivePinIndexSynced,
  ])

  // Reset pin cycle when switching rooms
  useEffect(() => {
    setActivePinIndexSynced(0)
    pinJumpLockRef.current = false
    pinHoldJumpIdRef.current = null
    pinIgnoreScrollHoldUntilRef.current = 0
    pinScrollDirRef.current = 'none'
    pinLastScrollTopRef.current = 0
    pinJumpGenRef.current += 1
    if (pinSyncRafRef.current != null) {
      cancelAnimationFrame(pinSyncRafRef.current)
      pinSyncRafRef.current = null
    }
    setStickyDateVisible(false)
    setStickyDateLabel(null)
    setStickyDateTs(null)
    setDateJumpOpen(false)
    setDateJumpLoading(false)
    dateJumpGenRef.current += 1
    if (stickyDateHideTimer.current != null) {
      window.clearTimeout(stickyDateHideTimer.current)
      stickyDateHideTimer.current = null
    }
  }, [activeRoomId, setActivePinIndexSynced])

  const findPinDomEl = useCallback((eventId: string) => {
    return findMsgDomEl(eventId)
  }, [])

  const findTimelineRowIndex = useCallback((eventId: string) => {
    return findRowIndexInRows(timelineRowsRef.current, eventId)
  }, [])

  const getPinRect = useCallback((eventId: string) => {
    const el =
      document.getElementById(`msg-${eventId}`) ||
      document.getElementById(`msg-media-${eventId}`)?.closest('.tg-msg') ||
      document.getElementById(`msg-media-${eventId}`)
    if (!el) return null
    const r = (el as HTMLElement).getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  }, [])

  const releasePinHoldOnUserScroll = useCallback(() => {
    if (Date.now() < pinIgnoreScrollHoldUntilRef.current) return
    if (pinHoldJumpIdRef.current) {
      pinHoldJumpIdRef.current = null
    }
  }, [])

  const syncPinnedBarFromScroll = useCallback(() => {
    if (pinJumpLockRef.current) return
    if (pinHoldJumpIdRef.current) return

    const pins = pinnedMessagesRef.current
    if (pins.length <= 1) return

    const scroller = timelineRef.current
    if (!scroller) return

    const stickyY =
      pinBarRef.current?.getBoundingClientRect().bottom ??
      scroller.getBoundingClientRect().top
    const viewBottom = scroller.getBoundingClientRect().bottom

    // Bounds of the loaded window — pins outside still get past/below via ts
    let windowOldestTs = 0
    let windowNewestTs = 0
    const rows = timelineRowsRef.current
    for (const row of rows) {
      const ts = row.firstEvent.getTs() || 0
      if (!ts) continue
      if (!windowOldestTs || ts < windowOldestTs) windowOldestTs = ts
      if (ts > windowNewestTs) windowNewestTs = ts
    }

    // Native list: all rows are mounted — derive visible range from DOM rects.
    const viewTop = scroller.getBoundingClientRect().top
    let firstVisibleRow = -1
    let lastVisibleRow = -1
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].firstEvent.getId()
      if (!id) continue
      const el =
        document.getElementById(`message-${id}`) || findMsgDomEl(id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.bottom > viewTop && r.top < viewBottom) {
        if (firstVisibleRow < 0) firstVisibleRow = i
        lastVisibleRow = i
      }
    }

    const syncedIndex = computePinnedBarIndex({
      pinsNewestFirst: pins,
      stickyY,
      viewBottom,
      getRect: getPinRect,
      direction: pinScrollDirRef.current,
      inferStatus: (pin) =>
        inferMissingPinStatus({
          pin,
          rowIndex: findTimelineRowIndex(pin.eventId),
          firstVisibleRow,
          lastVisibleRow,
          windowOldestTs,
          windowNewestTs,
        }),
    })

    if (syncedIndex == null) return
    if (syncedIndex !== activePinIndexRef.current) {
      setActivePinIndexSynced(syncedIndex)
    }
  }, [findTimelineRowIndex, getPinRect, setActivePinIndexSynced])

  const schedulePinnedBarSync = useCallback(() => {
    if (pinSyncRafRef.current != null) return
    pinSyncRafRef.current = requestAnimationFrame(() => {
      pinSyncRafRef.current = null
      syncPinnedBarFromScroll()
    })
  }, [syncPinnedBarFromScroll])

  const updateStickyDateFromScroll = useCallback(() => {
    const scroller = timelineRef.current
    if (!scroller) return

    const line = scroller.getBoundingClientRect().top + 10
    const seps = scroller.querySelectorAll<HTMLElement>('[data-tg-date-sep]')
    if (seps.length === 0) {
      if (!dateJumpOpenRef.current && !isTimelineScrolling.current) {
        setStickyDateVisible(false)
      }
      return
    }

    let bestTs = -1
    let inlineAtTop = false
    for (const el of seps) {
      const ts = Number(el.dataset.ts)
      if (!Number.isFinite(ts)) continue
      const top = el.getBoundingClientRect().top
      // Last separator that has reached / crossed the sticky line
      if (top <= line + 6 && ts >= bestTs) {
        bestTs = ts
      }
      // Real chip is sitting in the sticky slot — no need for a floating twin
      if (Math.abs(top - line) < 20) {
        inlineAtTop = true
      }
    }

    // Scrolled above every separator → show the oldest loaded day
    if (bestTs < 0) {
      const firstTs = Number(seps[0].dataset.ts)
      bestTs = Number.isFinite(firstTs) ? firstTs : -1
    }

    if (bestTs < 0) return

    const label = formatDaySeparator(bestTs)
    setStickyDateLabel(label)
    setStickyDateTs(bestTs)

    if (stickyDateHideTimer.current != null) {
      window.clearTimeout(stickyDateHideTimer.current)
      stickyDateHideTimer.current = null
    }

    // Keep visible while the date picker is open
    if (dateJumpOpenRef.current) {
      setStickyDateVisible(true)
      return
    }

    // Real chip is sitting in the sticky slot — never show a floating twin
    // (including mid-scroll; the old "keep visible while scrolling" path
    // stacked two identical day pills and read as a hitch).
    if (inlineAtTop) {
      setStickyDateVisible(false)
      return
    }

    setStickyDateVisible(true)
    stickyDateHideTimer.current = window.setTimeout(() => {
      stickyDateHideTimer.current = null
      if (!dateJumpOpenRef.current) setStickyDateVisible(false)
    }, 2200)
  }, [])

  const openDateJump = useCallback((dayStartMs?: number) => {
    if (dayStartMs != null) {
      setStickyDateTs(dayStartMs)
      setStickyDateLabel(formatDaySeparator(dayStartMs))
    }
    setStickyDateVisible(true)
    if (stickyDateHideTimer.current != null) {
      window.clearTimeout(stickyDateHideTimer.current)
      stickyDateHideTimer.current = null
    }
    setDateJumpOpen(true)
  }, [])

  const scrollToDayStart = useCallback(
    (dayStartMs: number, eventId: string) => {
      const scroller = timelineRef.current
      if (!scroller) return false

      const seps = scroller.querySelectorAll<HTMLElement>('[data-tg-date-sep]')
      let sep: HTMLElement | null = null
      for (const el of seps) {
        if (Number(el.dataset.ts) === dayStartMs) {
          sep = el
          break
        }
      }

      stickToBottom.current = false
      setShowJumpDown(true)

      const target =
        sep ||
        document.getElementById(`msg-${eventId}`) ||
        document.getElementById(`msg-media-${eventId}`)?.closest('.tg-msg')

      if (!target) return false

      const sRect = scroller.getBoundingClientRect()
      const tRect = (target as HTMLElement).getBoundingClientRect()
      // Put the start of the day near the top under the sticky slot
      const delta = tRect.top - (sRect.top + 12)
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta)
      pinLastScrollTopRef.current = scroller.scrollTop
      return true
    },
    [],
  )

  const loadOlderMessages = useCallback(async () => {
    if (!client || !activeRoom) return
    // Instant lock — never overlap / never fire when history is exhausted
    if (loadingHistory.current || historyExhausted.current) {
      if (!historyExhausted.current) pendingLoadOlder.current = true
      return
    }
    if (pinJumpLockRef.current) {
      pendingLoadOlder.current = true
      return
    }
    // Hard rate limit: at most one older-page request per 500ms
    const now = Date.now()
    if (now - lastLoadOlderAtRef.current < 500) {
      pendingLoadOlder.current = true
      return
    }

    const roomId = activeRoom.roomId
    const epoch = timelineEpochRef.current
    const stillHere = () =>
      epoch === timelineEpochRef.current &&
      activeRoomIdRef.current === roomId

    const beforeMsgLen = messages.length
    const win = timelineWindowRef.current
    if (win && !win.canPaginate(EventTimeline.BACKWARDS)) {
      historyExhausted.current = true
      pendingLoadOlder.current = false
      return
    }

    lastLoadOlderAtRef.current = now
    // Lock BEFORE any await so onScroll cannot re-enter mid-flight.
    loadingHistory.current = true
    ignoreHistoryGrowth.current = true
    // Defer loading indicator so we don't re-render mid-scroll gesture
    const loadingUi = window.setTimeout(() => {
      if (stillHere()) setIsLoadingHistory(true)
    }, 180)

    try {
      if (win) {
        const before = win.getEvents().length
        const got = await win.paginate(
          EventTimeline.BACKWARDS,
          50,
          true,
          5,
        )
        if (!stillHere()) return
        const afterEvents = win.getEvents()
        const after = afterEvents.length
        const filtered = afterEvents.filter(isTimelineMessageEvent)
        if (filtered.length <= beforeMsgLen && after <= before) {
          if (!got && !win.canPaginate(EventTimeline.BACKWARDS)) {
            historyExhausted.current = true
          }
          return
        }
        commitTimelineMessages(roomId, filtered, epoch)
        setReactionTick((t) => t + 1)

        if (after > before) return
        if (!got && !win.canPaginate(EventTimeline.BACKWARDS)) {
          historyExhausted.current = true
        }
        return
      }

      const beforeCount = activeRoom.getLiveTimeline().getEvents().length
      await client.scrollback(activeRoom, 50)
      if (!stillHere()) return
      const afterCount = activeRoom.getLiveTimeline().getEvents().length
      const filtered = activeRoom
        .getLiveTimeline()
        .getEvents()
        .filter(isTimelineMessageEvent)
      if (afterCount <= beforeCount && filtered.length <= beforeMsgLen) {
        historyExhausted.current = true
        return
      }
      commitTimelineMessages(roomId, filtered, epoch)
      setReactionTick((t) => t + 1)
    } catch (err) {
      console.warn('Failed to load older messages', err)
      if (stillHere()) ignoreHistoryGrowth.current = false
    } finally {
      window.clearTimeout(loadingUi)
      if (stillHere()) setIsLoadingHistory(false)
      else setIsLoadingHistory(false)

      // Keep the lock until after React has committed + layout effects
      // (prepend heightDiff) have run — otherwise onScroll re-enters at scrollTop~0.
      requestAnimationFrame(() => {
        loadingHistory.current = false

        if (
          stillHere() &&
          !historyExhausted.current &&
          !pinJumpLockRef.current &&
          (pendingLoadOlder.current ||
            (timelineRef.current != null &&
              timelineRef.current.scrollTop < 30))
        ) {
          pendingLoadOlder.current = false
          const wait = Math.max(
            0,
            500 - (Date.now() - lastLoadOlderAtRef.current),
          )
          window.setTimeout(() => {
            void loadOlderMessages()
          }, wait)
        }
      })
    }
  }, [client, activeRoom, commitTimelineMessages, messages.length])

  /** Extend a historical TimelineWindow toward live / exit to live when caught up. */
  const loadNewerMessages = useCallback(async () => {
    if (!client || !activeRoom) return
    const win = timelineWindowRef.current
    if (!win) return
    // Hard in-flight guard — never overlap forward pagination
    if (loadingNewer.current || loadingHistory.current) {
      pendingLoadNewer.current = true
      return
    }
    if (pinJumpLockRef.current) {
      pendingLoadNewer.current = true
      return
    }
    // Hard rate limit: at most one newer-page request per 500ms
    const now = Date.now()
    if (now - lastLoadNewerAtRef.current < 500) {
      pendingLoadNewer.current = true
      return
    }

    const roomId = activeRoom.roomId
    const epoch = timelineEpochRef.current
    const stillHere = () =>
      epoch === timelineEpochRef.current &&
      activeRoomIdRef.current === roomId

    const beforeMsgLen = messages.length

    lastLoadNewerAtRef.current = now
    loadingNewer.current = true
    setIsLoadingNewer(true)
    ignoreHistoryGrowth.current = true
    let progressed = false

    try {
      if (!win.canPaginate(EventTimeline.FORWARDS)) {
        // Caught up with live. Hand off only near the end so a mid-window
        // viewport isn't replaced by a shorter live scrollback.
        const el = timelineRef.current
        const nearLiveEnd =
          el != null &&
          el.scrollHeight - el.scrollTop - el.clientHeight < 900
        if (nearLiveEnd) {
          timelineWindowRef.current = null
          historyExhausted.current = false
          commitTimelineMessages(
            roomId,
            activeRoom
              .getLiveTimeline()
              .getEvents()
              .filter(isTimelineMessageEvent),
            epoch,
          )
          setReactionTick((t) => t + 1)
          progressed = true
        }
        return
      }

      const before = win.getEvents().length
      const got = await win.paginate(EventTimeline.FORWARDS, 80, true, 5)
      if (!stillHere() || timelineWindowRef.current !== win) return

      const afterEvents = win.getEvents()
      const filtered = afterEvents.filter(isTimelineMessageEvent)
      if (filtered.length <= beforeMsgLen && afterEvents.length <= before) {
        if (!got && !win.canPaginate(EventTimeline.FORWARDS)) {
          const el = timelineRef.current
          const nearLiveEnd =
            el != null &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 900
          if (nearLiveEnd) {
            timelineWindowRef.current = null
            historyExhausted.current = false
            commitTimelineMessages(
              roomId,
              activeRoom
                .getLiveTimeline()
                .getEvents()
                .filter(isTimelineMessageEvent),
              epoch,
            )
            setReactionTick((t) => t + 1)
            progressed = true
          }
        }
        return
      }
      commitTimelineMessages(roomId, filtered, epoch)
      setReactionTick((t) => t + 1)
      progressed = true
    } catch (err) {
      console.warn('Failed to paginate timeline window forwards', err)
    } finally {
      loadingNewer.current = false
      ignoreHistoryGrowth.current = false
      if (stillHere()) setIsLoadingNewer(false)
      else setIsLoadingNewer(false)

      // Keep walking forward while near the bottom edge — respect 500ms throttle.
      if (
        progressed &&
        stillHere() &&
        timelineWindowRef.current &&
        !pinJumpLockRef.current &&
        (pendingLoadNewer.current ||
          (timelineRef.current != null &&
            timelineRef.current.scrollHeight -
              timelineRef.current.scrollTop -
              timelineRef.current.clientHeight <
              50))
      ) {
        pendingLoadNewer.current = false
        const wait = Math.max(
          0,
          500 - (Date.now() - lastLoadNewerAtRef.current),
        )
        window.setTimeout(() => {
          void loadNewerMessages()
        }, wait)
      }
    }
  }, [client, activeRoom, commitTimelineMessages, messages.length])

  const timelineItems = useMemo(() => {
    const scoped = activeRoomId
      ? messages.filter((e) => {
          const rid = e.getRoomId?.()
          return !rid || rid === activeRoomId
        })
      : messages
    return groupTimelineItems(scoped)
  }, [messages, activeRoomId])

  const timelineRows = useMemo(() => {
    const rows: TimelineRow[] = []
    for (let index = 0; index < timelineItems.length; index++) {
      const item = timelineItems[index]
      const prev = index > 0 ? timelineItems[index - 1] : null
      const firstEvent =
        item.kind === 'album' ? item.imageEvents[0] : item.event
      const prevFirst =
        prev?.kind === 'album' ? prev.imageEvents[0] : prev?.event
      const isOwn = firstEvent.getSender() === myUserId
      const dayChanged =
        !prevFirst || !isSameDay(prevFirst.getTs(), firstEvent.getTs())
      const isContinuation =
        !!prevFirst &&
        !dayChanged &&
        prevFirst.getSender() === firstEvent.getSender() &&
        firstEvent.getTs() - prevFirst.getTs() < CONTINUATION_MS

      const c = item.kind === 'single' ? item.event.getContent() : null
      const hideAlbumCaption =
        item.kind === 'single' &&
        c?.msgtype === 'm.text' &&
        getAlbumId(item.event) &&
        prev?.kind === 'album' &&
        prev.albumId === getAlbumId(item.event)
      if (hideAlbumCaption) continue

      const key =
        item.kind === 'album'
          ? item.albumId ||
            item.imageEvents.map((e) => e.getId()).join('-')
          : item.event.getId() || `row-${index}`

      const eventId = firstEvent.getId()
      rows.push({
        key,
        item,
        dayChanged,
        showUnreadSep: !!unreadBeforeId && eventId === unreadBeforeId,
        isContinuation,
        isOwn,
        firstEvent,
      })
    }
    return rows
  }, [timelineItems, myUserId, unreadBeforeId])

  timelineRowsRef.current = timelineRows

  const daysWithMessages = useMemo(
    () => collectDaysWithMessages(messages),
    [messages],
  )

  useEffect(() => {
    schedulePinnedBarSync()
  }, [pinnedMessages, timelineRows.length, schedulePinnedBarSync])

  useLayoutEffect(() => {
    applyInitialPosition()
  }, [applyInitialPosition, timelineRows.length])

  // Native pin-to-bottom on room open / first hydrate (no virtualizer).
  useLayoutEffect(() => {
    if (isReady) return
    if (messages.length === 0) return
    if (openIntent.current !== 'bottom') return
    if (!didInitialPosition.current) return

    requestAnimationFrame(() => {
      const el = timelineRef.current
      if (!el || openIntent.current !== 'bottom') return
      el.scrollTop = el.scrollHeight
      stickToBottom.current = true
      setIsReady(true)
    })
  }, [activeRoomId, messages.length, isReady])

  // After prepend: let overflow-anchor hold the viewport; if still in the
  // near-top trigger zone (< 50), push scrollTop by the added block height.
  useLayoutEffect(() => {
    const scrollEl = timelineRef.current
    if (!scrollEl) return

    const currentFirstId = messages[0]?.getId()
    const currentScrollHeight = scrollEl.scrollHeight

    if (
      prevFirstIdRef.current &&
      currentFirstId &&
      currentFirstId !== prevFirstIdRef.current
    ) {
      if (scrollEl.scrollTop < 50) {
        const heightDiff = currentScrollHeight - prevScrollHeightRef.current
        if (heightDiff > 0) {
          scrollEl.scrollTop += heightDiff
        }
      }
    }

    prevFirstIdRef.current = currentFirstId
    prevScrollHeightRef.current = currentScrollHeight
  }, [messages])

  // After newer pagination settles, keep walking if still glued to the bottom
  // edge (avoids needing a manual flick to load the next page).
  useEffect(() => {
    const scrollEl = timelineRef.current
    if (!scrollEl || isLoadingNewer) return
    if (!timelineWindowRef.current) return
    if (pinJumpLockRef.current) return
    if (loadingNewer.current || loadingHistory.current) return

    const isAtBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 50
    if (isAtBottom) {
      void loadNewerMessages()
    }
  }, [messages.length, isLoadingNewer, loadNewerMessages])

  // Jump-down badge + stick-to-bottom backup on append (not prepend).
  useEffect(() => {
    const prev = prevMsgCount.current
    const next = messages.length
    const firstId = messages[0]?.getId() ?? null
    const lastId = messages[messages.length - 1]?.getId() ?? null
    const prevFirst = prevFirstMsgId.current
    const prevLast = prevLastMsgId.current

    prevMsgCount.current = next
    prevFirstMsgId.current = firstId
    prevLastMsgId.current = lastId

    if (!didInitialPosition.current) return

    const prepended =
      next > prev &&
      prev > 0 &&
      lastId !== null &&
      lastId === prevLast &&
      firstId !== prevFirst

    const appendedNew =
      next > prev &&
      prev > 0 &&
      lastId !== null &&
      lastId !== prevLast

    if (ignoreHistoryGrowth.current || prepended) {
      ignoreHistoryGrowth.current = false
      if (stickToBottom.current) {
        setJumpBadge(0)
        setShowJumpDown(false)
      }
      return
    }

    // Historical pin/search window: count churn from joins must not fake "44 new"
    if (timelineWindowRef.current) {
      return
    }

    if (stickToBottom.current) {
      // Backup when stickToBottom disagrees briefly with virtualizer isAtEnd
      // (measure lag). Append-only — never force on prepend/reaction churn.
      if (appendedNew) {
        scrollToBottomAfterLayout()
      }
      setJumpBadge(0)
      setShowJumpDown(false)
      return
    }

    // Only real new messages at the end bump the jump-down badge
    if (appendedNew) {
      setJumpBadge((n) => n + Math.max(1, next - prev))
      setShowJumpDown(true)
    }
  }, [messages, scrollToBottomAfterLayout])

  const galleryImages: ViewerImage[] = useMemo(
    () =>
      messages
        .filter(
          (e) =>
            isImageEvent(e) ||
            (!e.isDecryptionFailure() && e.getType() === 'm.sticker'),
        )
        .map((e) => ({
          id: e.getId() || `${e.getTs()}`,
          content: e.getContent(),
          name: e.getContent()?.body || 'image.jpg',
        })),
    [messages],
  )

  const galleryVideos: ViewerVideo[] = useMemo(
    () =>
      messages.filter(isVideoEvent).map((e) => ({
        id: e.getId() || `${e.getTs()}`,
        content: e.getContent(),
        name: e.getContent()?.body || 'video.mp4',
      })),
    [messages],
  )

  const openImage = useCallback(
    (imageId: string) => {
      if (selectedMediaIds.length > 0) return
      const index = galleryImages.findIndex((img) => img.id === imageId)
      if (index < 0) return
      setVideoViewer(null)
      setViewer({ images: galleryImages, index })
    },
    [galleryImages, selectedMediaIds.length],
  )

  const openVideo = useCallback(
    (videoId: string) => {
      if (selectedMediaIds.length > 0) return
      const index = galleryVideos.findIndex((v) => v.id === videoId)
      if (index < 0) return
      setViewer(null)
      setVideoViewer({ videos: galleryVideos, index })
    },
    [galleryVideos, selectedMediaIds.length],
  )

  const onExternalFilesConsumed = useCallback(() => {
    setDroppedFiles([])
  }, [])

  const handleReply = useCallback(
    (events: MatrixEvent[], quoteText?: string) => {
      const usable = events.filter((e) => e.getId())
      if (!usable.length) return
      const mediaIds = usable.map((e) => e.getId()!)
      const first = usable[0]
      const quote = quoteText?.trim() || undefined
      setEditTarget(null)
      setReplyTo({
        eventId: mediaIds[0],
        mediaIds,
        senderName: getSenderName(first),
        senderId: first.getSender() || undefined,
        snippet:
          mediaIds.length > 1
            ? `🖼 ${mediaIds.length} фото`
            : messageSnippet(first),
        quoteText: quote,
      })
      setSelectedMediaIds([])
      setSelectionMode(false)
    },
    [],
  )

  const openContextMenu = useCallback(
    (e: React.MouseEvent, events: MatrixEvent[]) => {
      e.preventDefault()
      e.stopPropagation()
      const usable = events.filter((ev) => ev.getId())
      if (!usable.length) return
      const isOwn = usable[0].getSender() === myUserId
      const msgRoot =
        (e.target as HTMLElement | null)?.closest?.('.tg-msg') ?? null
      // Capture before menu focus clears the selection
      const quoteText = getQuoteSelectionWithin(msgRoot) || undefined
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        events: usable,
        isOwn,
        quoteText,
      })
    },
    [myUserId],
  )

  const handleEditFromMenu = useCallback((events: MatrixEvent[]) => {
    const event = events[0]
    if (!event?.getId() || !canEditEvent(event, true)) return
    setReplyTo(null)
    const content = event.getContent() as Record<string, unknown>
    const composerText = matrixContentToComposerText(content)
    setEditTarget({
      eventId: event.getId()!,
      body: composerText,
      msgtype: typeof content.msgtype === 'string' ? content.msgtype : 'm.text',
    })
  }, [])

  const handleCopyFromMenu = useCallback(async (events: MatrixEvent[]) => {
    const text =
      events.length > 1
        ? events.map(messagePlainText).filter(Boolean).join('\n') ||
          messageSnippet(events[0])
        : messagePlainText(events[0]) || messageSnippet(events[0])
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('Failed to copy', err)
    }
  }, [])

  const handleSaveGifFromMenu = useCallback(
    async (events: MatrixEvent[]) => {
      if (!client) return
      const event = events.find((e) => {
        if (e.isDecryptionFailure()) return false
        const c = e.getContent() as Record<string, unknown>
        return isGifMessageContent(c)
      })
      if (!event) return
      const content = event.getContent() as {
        body?: string
        url?: string
        file?: any
        info?: { mimetype?: string; w?: number; h?: number }
      }
      try {
        const blob = await downloadMessageAttachment(
          client,
          content,
          content.info?.mimetype || 'image/gif',
        )
        await useSavedGifsStore.getState().hydrate()
        await useSavedGifsStore.getState().addFromBlob(blob, {
          title: content.body || 'gif',
          w: content.info?.w,
          h: content.info?.h,
        })
      } catch (err) {
        console.error('Failed to save GIF', err)
        alert(
          err instanceof Error
            ? err.message
            : 'Не удалось сохранить GIF',
        )
      }
    },
    [client],
  )

  const handleDeleteFromMenu = useCallback(
    async (events: MatrixEvent[]) => {
      if (!activeRoom || !client) return
      const ids = events.map((e) => e.getId()).filter(Boolean) as string[]
      if (!ids.length) return
      const ok = window.confirm(
        ids.length > 1
          ? `Удалить ${ids.length} сообщений?`
          : 'Удалить сообщение?',
      )
      if (!ok) return
      for (const id of ids) {
        try {
          await client.redactEvent(activeRoom.roomId, id)
        } catch (err) {
          console.error('Failed to redact', err)
        }
      }
    },
    [activeRoom, client],
  )

  const handlePinForEveryone = useCallback(
    async (events: MatrixEvent[]) => {
      if (!activeRoom || !client) return
      const eventId = events[0]?.getId()
      if (!eventId) return
      try {
        await pinMessage(client, activeRoom, eventId)
        setPinStateTick((t) => t + 1)
      } catch (err) {
        console.error('Failed to pin message for everyone', err)
        alert(
          err instanceof Error
            ? err.message
            : 'Не удалось закрепить сообщение',
        )
      }
    },
    [activeRoom, client],
  )

  const handleUnpinForEveryone = useCallback(
    async (events: MatrixEvent[]) => {
      if (!activeRoom || !client) return
      const eventId = events[0]?.getId()
      if (!eventId) return
      try {
        await unpinMessage(client, activeRoom, eventId)
        setPinStateTick((t) => t + 1)
      } catch (err) {
        console.error('Failed to unpin message for everyone', err)
        alert(
          err instanceof Error
            ? err.message
            : 'Не удалось открепить сообщение',
        )
      }
    },
    [activeRoom, client],
  )

  const handlePinForSelf = useCallback(
    (events: MatrixEvent[]) => {
      if (!activeRoom || !myUserId) return
      const eventId = events[0]?.getId()
      if (!eventId) return
      pinMessageForSelf(myUserId, activeRoom.roomId, eventId)
    },
    [activeRoom, myUserId],
  )

  const handleUnpinForSelf = useCallback(
    (events: MatrixEvent[]) => {
      if (!activeRoom || !myUserId) return
      const eventId = events[0]?.getId()
      if (!eventId) return
      unpinMessageForSelf(myUserId, activeRoom.roomId, eventId)
    },
    [activeRoom, myUserId],
  )

  const handleUnpinFromBar = useCallback(async () => {
    if (!activeRoom || !client) return
    const pin =
      pinnedMessages[
        Math.min(activePinIndex, Math.max(0, pinnedMessages.length - 1))
      ]
    if (!pin) return
    const canRoom =
      pin.scope.room && canPinMessages(activeRoom, myUserId)
    try {
      if (canRoom) {
        await unpinMessage(client, activeRoom, pin.eventId)
        setPinStateTick((t) => t + 1)
      }
      if (pin.scope.self && myUserId) {
        unpinMessageForSelf(myUserId, activeRoom.roomId, pin.eventId)
      }
    } catch (err) {
      console.error('Failed to unpin from bar', err)
      alert(
        err instanceof Error
          ? err.message
          : 'Не удалось открепить сообщение',
      )
    }
  }, [
    activeRoom,
    activePinIndex,
    client,
    myUserId,
    pinnedMessages,
  ])

  const handleReactFromMenu = useCallback(
    async (events: MatrixEvent[], emoji: string) => {
      if (!activeRoom) return
      const eventId = events[0]?.getId()
      if (!eventId) return
      try {
        await toggleReaction(activeRoom, eventId, emoji, myUserId)
      } catch (err) {
        console.error('Failed to react', err)
      }
    },
    [activeRoom, myUserId],
  )

  const clearSelection = useCallback(() => {
    setSelectedMediaIds([])
    setSelectionMode(false)
  }, [])

  const toggleSelectMedia = useCallback((eventId: string) => {
    setSelectionMode(true)
    setSelectedMediaIds((prev) =>
      prev.includes(eventId)
        ? prev.filter((id) => id !== eventId)
        : [...prev, eventId],
    )
  }, [])

  const beginSelectFromMenu = useCallback((events: MatrixEvent[]) => {
    const ids = events
      .map((e) => e.getId())
      .filter((id): id is string => !!id)
    if (!ids.length) return
    setSelectionMode(true)
    setSelectedMediaIds((prev) => {
      const set = new Set(prev)
      for (const id of ids) set.add(id)
      return [...set]
    })
  }, [])

  const openForwardPicker = useCallback((events: MatrixEvent[]) => {
    const usable = events.filter(canForwardEvent)
    if (!usable.length) {
      alert('Нечего пересылать')
      return
    }
    setForwardEvents(usable)
  }, [])

  const forwardSelection = useCallback(() => {
    if (!activeRoom || selectedMediaIds.length === 0) return
    const events = selectedMediaIds
      .map((id) => activeRoom.findEventById(id))
      .filter((e): e is MatrixEvent => !!e)
      .filter(canForwardEvent)
    if (!events.length) {
      alert('Нечего пересылать')
      return
    }
    setForwardEvents(events)
  }, [activeRoom, selectedMediaIds])

  const handleForwardConfirm = useCallback(
    async (roomIds: string[]) => {
      if (!client || !forwardEvents?.length) return
      setForwardBusy(true)
      try {
        const result = await forwardEventsToRooms(
          client,
          forwardEvents,
          roomIds,
        )
        setForwardEvents(null)
        clearSelection()
        if (result.failed.length && result.okRooms.length === 0) {
          alert(
            result.failed[0]?.error ||
              'Не удалось переслать сообщения',
          )
        } else if (result.failed.length) {
          alert(
            `Переслано в ${result.okRooms.length} чат(ов). Ошибки: ${result.failed.length}`,
          )
        }
      } catch (err) {
        console.error('Forward failed', err)
        alert(
          err instanceof Error ? err.message : 'Не удалось переслать',
        )
      } finally {
        setForwardBusy(false)
      }
    },
    [client, forwardEvents, clearSelection],
  )

  const replyToSelection = useCallback(() => {
    if (!activeRoom || selectedMediaIds.length === 0) return
    const events = selectedMediaIds
      .map((id) => activeRoom.findEventById(id))
      .filter((e): e is MatrixEvent => !!e)
    if (!events.length) return
    handleReply(events)
  }, [activeRoom, selectedMediaIds, handleReply])

  /** Apply the pulse / quote highlight to an already-rendered event or media group. */
  const applyEventHighlight = useCallback(
    (
      eventId: string,
      mediaIds: string[] | undefined,
      highlightMs: number,
      highlightText?: string,
    ): boolean => {
      const ids = mediaIds?.length ? mediaIds : [eventId]
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current)

      const mediaEls = ids
        .map((id) => document.getElementById(`msg-media-${id}`))
        .filter((el): el is HTMLElement => !!el)

      const albumGrid = mediaEls[0]?.closest('.tg-album-grid')
      const albumCellCount = albumGrid
        ? albumGrid.querySelectorAll('[id^="msg-media-"]').length
        : 0

      const isPartialAlbum =
        !!albumGrid && mediaEls.length > 0 && mediaEls.length < albumCellCount

      const msgRoot =
        (mediaEls[0]?.closest('.tg-msg') as HTMLElement | null) ||
        document.getElementById(`msg-${eventId}`)

      if (!msgRoot && mediaEls.length === 0) return false

      document
        .querySelectorAll('.tg-msg-highlight')
        .forEach((n) => n.classList.remove('tg-msg-highlight'))

      if (isPartialAlbum) {
        setHighlightMediaIds([])
        requestAnimationFrame(() => {
          setHighlightMediaIds(ids)
        })
      } else if (msgRoot) {
        setHighlightMediaIds([])
        void msgRoot.offsetWidth
        if (highlightText?.trim()) {
          const targetId = eventId
          highlightQuoteInMessageRetry(
            () =>
              (document.getElementById(`msg-${targetId}`) as HTMLElement | null) ||
              (document
                .getElementById(`msg-media-${targetId}`)
                ?.closest('.tg-msg') as HTMLElement | null),
            highlightText,
            Math.max(highlightMs, 2200),
          )
        } else {
          clearQuoteTextHighlights()
          msgRoot.classList.add('tg-msg-highlight')
          window.setTimeout(
            () => msgRoot.classList.remove('tg-msg-highlight'),
            highlightMs,
          )
        }
      }

      highlightTimer.current = window.setTimeout(() => {
        setHighlightMediaIds([])
        highlightTimer.current = null
      }, highlightMs)

      return true
    },
    [],
  )

  const waitForPinDom = useCallback(
    async (eventId: string, maxMs: number, gen: number) => {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        if (gen !== pinJumpGenRef.current) return false
        // Row data existing is enough to consider the event "rendered" —
        // with virtualization the DOM node itself may not mount until the
        // caller scrolls the virtualizer to that row's index.
        if (findTimelineRowIndex(eventId) >= 0 || findPinDomEl(eventId)) {
          return true
        }
        await new Promise<void>((r) => window.setTimeout(r, 32))
      }
      return findTimelineRowIndex(eventId) >= 0 || !!findPinDomEl(eventId)
    },
    [findPinDomEl, findTimelineRowIndex],
  )

  /** Load a historical event fast — TimelineWindow, not N× scrollback. */
  const ensureEventRendered = useCallback(
    async (eventId: string, gen: number): Promise<boolean> => {
      if (!client || !activeRoomId) return false
      if (findTimelineRowIndex(eventId) >= 0 || findPinDomEl(eventId)) {
        return true
      }

      const room = client.getRoom(activeRoomId)
      if (!room) return false

      openIntent.current = 'event'
      stickToBottom.current = false
      setShowJumpDown(true)
      setJumpBadge(0)
      setUnreadBeforeId(null)
      historyExhausted.current = false

      if (scrollAnimRef.current != null) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }
      scrollAnimGen.current += 1

      const liveEvents = room.getLiveTimeline().getEvents()
      if (liveEvents.some((e) => e.getId() === eventId)) {
        timelineWindowRef.current = null
        ignoreHistoryGrowth.current = true
        commitTimelineMessages(
          activeRoomId,
          liveEvents.filter(isTimelineMessageEvent),
        )
        return waitForPinDom(eventId, 1500, gen)
      }

      const prevWin = timelineWindowRef.current
      if (prevWin?.getEvents().some((e) => e.getId() === eventId)) {
        ignoreHistoryGrowth.current = true
        setJumpBadge(0)
        commitTimelineMessages(
          activeRoomId,
          prevWin.getEvents().filter(isTimelineMessageEvent),
        )
        return waitForPinDom(eventId, 1500, gen)
      }

      try {
        const win = new TimelineWindow(
          client,
          room.getUnfilteredTimelineSet(),
          { windowLimit: 500 },
        )
        await win.load(eventId, 80)
        if (gen !== pinJumpGenRef.current) return false
        if (activeRoomIdRef.current !== activeRoomId) return false
        await Promise.all([
          win.paginate(EventTimeline.BACKWARDS, 40, true, 3),
          win.paginate(EventTimeline.FORWARDS, 60, true, 4),
        ])
        if (gen !== pinJumpGenRef.current) return false
        if (activeRoomIdRef.current !== activeRoomId) return false

        timelineWindowRef.current = win
        ignoreHistoryGrowth.current = true
        setJumpBadge(0)
        commitTimelineMessages(
          activeRoomId,
          win.getEvents().filter(isTimelineMessageEvent),
        )
        return waitForPinDom(eventId, 2000, gen)
      } catch (err) {
        console.warn('Could not load timeline for pinned jump', err)
        return false
      }
    },
    [
      activeRoomId,
      client,
      commitTimelineMessages,
      findPinDomEl,
      findTimelineRowIndex,
      waitForPinDom,
    ],
  )

  /**
   * Core teleport: caller already owns `gen` (bumped via `pinJumpGenRef`).
   * Ensures the event is loaded, scrolls the virtualizer to its row, then
   * applies the highlight once the row has mounted.
   */
  const runJumpToEvent = useCallback(
    async (
      eventId: string,
      gen: number,
      opts: JumpToEventOptions = {},
    ): Promise<boolean> => {
      pendingLoadNewer.current = false
      pendingLoadOlder.current = false

      const ready = await ensureEventRendered(eventId, gen)
      if (!ready || gen !== pinJumpGenRef.current) return false

      pinIgnoreScrollHoldUntilRef.current = Date.now() + 480

      const scrollToTarget = () => {
        const element =
          document.getElementById(`message-${eventId}`) ||
          findMsgDomEl(eventId)
        if (!element) return false
        const block =
          opts.align === 'start'
            ? 'start'
            : opts.align === 'end'
              ? 'end'
              : 'center'
        element.scrollIntoView({ block, behavior: 'auto' })
        return true
      }

      if (!scrollToTarget()) {
        // Context may have just landed — wait 1-2 frames for React commit.
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        if (gen !== pinJumpGenRef.current) return false
        if (!scrollToTarget()) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()))
          if (gen !== pinJumpGenRef.current) return false
          scrollToTarget()
        }
      } else {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        if (gen !== pinJumpGenRef.current) return false
        // Re-assert after layout (images / decrypt)
        scrollToTarget()
      }

      return applyEventHighlight(
        eventId,
        opts.mediaIds,
        opts.highlightMs ?? 1600,
        opts.highlightText,
      )
    },
    [applyEventHighlight, ensureEventRendered],
  )

  /**
   * Unified teleport used by every "jump to message" caller — replies,
   * search results, pinned bar, date jump, deep links. Signature matches
   * the legacy `onScrollTo` prop passed down to MessageBubble / AlbumBubble.
   */
  const jumpToEvent = useCallback(
    (
      eventId: string,
      mediaIds?: string[],
      highlightMs = 1600,
      _behavior: ScrollBehavior = 'auto',
      highlightText?: string,
    ): void => {
      if (scrollAnimRef.current != null) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }
      pinJumpGenRef.current += 1
      scrollAnimGen.current += 1
      const gen = pinJumpGenRef.current

      stickToBottom.current = false
      setShowJumpDown(true)

      void runJumpToEvent(eventId, gen, { mediaIds, highlightMs, highlightText })
    },
    [runJumpToEvent],
  )

  /** Legacy name kept for the many existing call sites — same function. */
  const scrollToEvent = jumpToEvent

  const jumpToDay = useCallback(
    async (dayStartMs: number) => {
      if (!client || !activeRoomId) return
      // Share cancel generation with pin jumps / ensureEventRendered
      const gen = ++pinJumpGenRef.current
      dateJumpGenRef.current = gen
      setDateJumpLoading(true)
      setStickyDateTs(dayStartMs)
      setStickyDateLabel(formatDaySeparator(dayStartMs))

      try {
        let eventId = findFirstEventIdOnDay(messages, dayStartMs)

        if (!eventId) {
          try {
            const res = await client.timestampToEvent(
              activeRoomId,
              dayStartMs,
              Direction.Forward,
            )
            if (gen !== pinJumpGenRef.current) return
            eventId = res.event_id
          } catch (err) {
            console.warn('timestampToEvent failed for date jump', err)
            eventId = findFirstEventIdOnOrAfterDay(messages, dayStartMs)
          }
        }

        if (!eventId || gen !== pinJumpGenRef.current) return

        // Prefer the virtualizer — it aligns the target row (and its date
        // separator, when present) to the top even before that separator
        // node exists in the DOM. Manual DOM-offset scroll is a fallback
        // for the rare case the row never resolves.
        const jumped = await runJumpToEvent(eventId, gen, { align: 'start' })
        if (gen !== pinJumpGenRef.current) return

        if (!jumped) {
          let ok = scrollToDayStart(dayStartMs, eventId)
          if (!ok) {
            await new Promise<void>((r) => window.setTimeout(r, 40))
            if (gen !== pinJumpGenRef.current) return
            ok = scrollToDayStart(dayStartMs, eventId)
          }
        }

        setDateJumpOpen(false)
        updateStickyDateFromScroll()
      } finally {
        if (gen === pinJumpGenRef.current) {
          setDateJumpLoading(false)
        }
      }
    },
    [
      activeRoomId,
      client,
      messages,
      runJumpToEvent,
      scrollToDayStart,
      updateStickyDateFromScroll,
    ],
  )

  const handlePinnedBarClick = useCallback(async () => {
    const pins = pinnedMessagesRef.current
    if (!pins.length || !activeRoomId) return

    const idx = activePinIndexRef.current
    const target = pins[idx]
    if (!target) return

    // New click always cancels an in-flight jump (no multi-second lockout)
    const gen = ++pinJumpGenRef.current
    pinJumpLockRef.current = true

    // Advance the bar immediately so rapid taps cycle 1→2→3 without waiting
    if (pins.length > 1) {
      setActivePinIndexSynced((idx + 1) % pins.length)
      pinHoldJumpIdRef.current = target.eventId
    }

    try {
      pinScrollDirRef.current = 'none'
      await runJumpToEvent(target.eventId, gen, { highlightMs: 1600 })
    } finally {
      if (gen === pinJumpGenRef.current) {
        pinJumpLockRef.current = false
      }
    }
  }, [activeRoomId, runJumpToEvent, setActivePinIndexSynced])

  const jumpToSearchIndex = useCallback(
    (index: number) => {
      if (index < 0 || index >= searchResults.length) return
      const hit = searchResults[index]
      if (!hit) return
      setSearchCursor(index)
      setSearchResultsOpen(false)
      stickToBottom.current = false
      setShowJumpDown(true)
      scrollToEvent(hit.eventId, undefined, 2000)
    },
    [searchResults, scrollToEvent],
  )

  const goSearchPrev = useCallback(() => {
    if (searchResults.length === 0) return
    if (searchCursor < 0) {
      jumpToSearchIndex(0)
      return
    }
    jumpToSearchIndex(Math.max(0, searchCursor - 1))
  }, [searchResults.length, searchCursor, jumpToSearchIndex])

  const goSearchNext = useCallback(() => {
    if (searchResults.length === 0) return
    if (searchCursor < 0) {
      jumpToSearchIndex(0)
      return
    }
    jumpToSearchIndex(Math.min(searchResults.length - 1, searchCursor + 1))
  }, [searchResults.length, searchCursor, jumpToSearchIndex])

  // Jump from profile / global message search / deep links
  useEffect(() => {
    if (!pendingScrollEventId || !activeRoomId || !client) return

    let cancelled = false
    const targetId = pendingScrollEventId
    const room = client.getRoom(activeRoomId)
    if (!room) return

    const findRowIndex = (eventId: string) =>
      findRowIndexInRows(timelineRowsRef.current, eventId)

    const finishJump = () => {
      didInitialPosition.current = true
      stickToBottom.current = false
      setShowJumpDown(true)
      clearPendingScrollEvent()
    }

    const run = async () => {
      openIntent.current = 'event'
      stickToBottom.current = false
      setShowJumpDown(true)
      setUnreadBeforeId(null)
      historyExhausted.current = false

      // Abort any in-flight scroll animation from a previous jump
      if (scrollAnimRef.current != null) {
        cancelAnimationFrame(scrollAnimRef.current)
        scrollAnimRef.current = null
      }
      scrollAnimGen.current += 1

      // Fast path: event already rendered (common on 2nd jump in same window)
      if (findRowIndex(targetId) >= 0) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        if (cancelled) return
        const pendingHl = pendingReplyHighlightRef.current
        const hl =
          pendingHl?.eventId === targetId ? pendingHl : null
        if (hl) pendingReplyHighlightRef.current = null
        scrollToEvent(
          targetId,
          hl?.mediaIds,
          hl?.highlightMs ?? 2000,
          'auto',
          hl?.highlightText,
        )
        finishJump()
        return
      }

      const liveEvents = room.getLiveTimeline().getEvents()
      const inLive = liveEvents.some((e) => e.getId() === targetId)
      const prevWin = timelineWindowRef.current
      const inPrevWin = !!prevWin
        ?.getEvents()
        .some((e) => e.getId() === targetId)

      try {
        if (cancelled || activeRoomIdRef.current !== room.roomId) return
        if (inLive) {
          timelineWindowRef.current = null
          ignoreHistoryGrowth.current = true
          commitTimelineMessages(
            room.roomId,
            liveEvents.filter(isTimelineMessageEvent),
          )
        } else if (inPrevWin && prevWin) {
          timelineWindowRef.current = prevWin
          ignoreHistoryGrowth.current = true
          commitTimelineMessages(
            room.roomId,
            prevWin.getEvents().filter(isTimelineMessageEvent),
          )
        } else {
          timelineWindowRef.current = null
          const win = new TimelineWindow(
            client,
            room.getUnfilteredTimelineSet(),
            { windowLimit: 500 },
          )
          await win.load(targetId, 100)
          if (cancelled || activeRoomIdRef.current !== room.roomId) return
          await win.paginate(EventTimeline.BACKWARDS, 50, true, 3)
          if (cancelled || activeRoomIdRef.current !== room.roomId) return
          await win.paginate(EventTimeline.FORWARDS, 80, true, 4)
          if (cancelled || activeRoomIdRef.current !== room.roomId) return

          const windowEvents = win.getEvents().filter(isTimelineMessageEvent)
          if (!windowEvents.some((e) => e.getId() === targetId)) {
            console.warn('Jump target missing after filter', targetId)
          }
          timelineWindowRef.current = win
          ignoreHistoryGrowth.current = true
          setJumpBadge(0)
          commitTimelineMessages(room.roomId, windowEvents)
        }
      } catch (err) {
        console.warn('Could not load timeline for event jump', err)
        timelineWindowRef.current = null
      }

      for (let attempt = 0; attempt < 40; attempt++) {
        if (cancelled) return
        await new Promise<void>((r) => {
          window.setTimeout(r, attempt === 0 ? 32 : 80)
        })
        if (cancelled) return
        if (findRowIndex(targetId) < 0) continue
        const pendingHl = pendingReplyHighlightRef.current
        const hl =
          pendingHl?.eventId === targetId ? pendingHl : null
        if (hl) pendingReplyHighlightRef.current = null
        scrollToEvent(
          targetId,
          hl?.mediaIds,
          hl?.highlightMs ?? 2000,
          'auto',
          hl?.highlightText,
        )
        finishJump()
        return
      }

      pendingReplyHighlightRef.current = null
      finishJump()
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [
    pendingScrollEventId,
    pendingScrollNonce,
    activeRoomId,
    client,
    scrollToEvent,
    clearPendingScrollEvent,
    commitTimelineMessages,
  ])

  const clearReply = useCallback(() => {
    setReplyTo(null)
  }, [])

  const clearEdit = useCallback(() => {
    setEditTarget(null)
  }, [])

  const handleTimelineScroll = () => {
    const el = timelineRef.current
    if (!el) return

    const top = el.scrollTop
    const prevTop = pinLastScrollTopRef.current
    // Ignore trackpad jitter — only dismiss hover on a real scroll
    if (Math.abs(top - prevTop) > 14) {
      clearHoveredEventId()
    }
    if (top > prevTop + 2) pinScrollDirRef.current = 'down'
    else if (top < prevTop - 2) pinScrollDirRef.current = 'up'
    pinLastScrollTopRef.current = top

    // Keyboard / scrollbar / trackpad: release click-hold once the user moves
    if (
      !pinJumpLockRef.current &&
      pinHoldJumpIdRef.current &&
      Date.now() >= pinIgnoreScrollHoldUntilRef.current &&
      Math.abs(top - prevTop) > 2
    ) {
      pinHoldJumpIdRef.current = null
    }

    isTimelineScrolling.current = true
    if (scrollIdleTimer.current != null) {
      window.clearTimeout(scrollIdleTimer.current)
    }
    scrollIdleTimer.current = window.setTimeout(() => {
      scrollIdleTimer.current = null
      isTimelineScrolling.current = false
      // Resolve sticky visibility now that chips are stable.
      updateStickyDateFromScroll()
      if (pendingReceiptTick.current) {
        pendingReceiptTick.current = false
        setReceiptTick((t) => t + 1)
      }

      const scroller = timelineRef.current
      const nearTop = scroller != null && scroller.scrollTop < 30
      const needOlder = pendingLoadOlder.current || nearTop
      if (needOlder) {
        if (loadingHistory.current || historyExhausted.current) {
          // Keep the ask alive until the in-flight request finishes
          if (!historyExhausted.current) pendingLoadOlder.current = true
        } else {
          pendingLoadOlder.current = false
          void loadOlderMessages()
        }
      } else {
        pendingLoadOlder.current = false
      }

      const needNewer =
        pendingLoadNewer.current ||
        (timelineWindowRef.current != null &&
          !pinJumpLockRef.current &&
          Date.now() >= pinIgnoreScrollHoldUntilRef.current &&
          scroller != null &&
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
            900)
      if (needNewer) {
        if (loadingNewer.current || loadingHistory.current) {
          pendingLoadNewer.current = true
        } else {
          pendingLoadNewer.current = false
          void loadNewerMessages()
        }
      } else {
        pendingLoadNewer.current = false
      }
    }, 200)

    schedulePinnedBarSync()
    updateStickyDateFromScroll()

    // Historical jump view: keep "down to latest" visible; never treat as live bottom
    if (timelineWindowRef.current) {
      stickToBottom.current = false
      setShowJumpDown(true)
      // Window reshuffles are not unread messages
      setJumpBadge(0)
      if (
        el.scrollTop < 30 &&
        !historyExhausted.current
      ) {
        pendingLoadOlder.current = true
        if (!loadingHistory.current && !pinJumpLockRef.current) {
          pendingLoadOlder.current = false
          void loadOlderMessages()
        }
      }
      const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // Prefetch early so a long flick down never runs out of rows.
      if (
        distBottom < 900 &&
        !pinJumpLockRef.current &&
        Date.now() >= pinIgnoreScrollHoldUntilRef.current
      ) {
        pendingLoadNewer.current = true
        if (!loadingNewer.current && !loadingHistory.current) {
          pendingLoadNewer.current = false
          void loadNewerMessages()
        }
      }
      return
    }

    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = dist < 100
    stickToBottom.current = atBottom
    // Hysteresis so the jump button doesn't flicker at the threshold.
    setShowJumpDown((prev) => {
      if (prev) return dist > 120
      return dist > 220
    })
    if (atBottom) {
      setJumpBadge(0)
      setUnreadBeforeId(null)
      clearPendingUnreadEvent()
      if (activeRoomId) void markRoomAsRead(activeRoomId)
    }
    // Prefetch older history while still scrolling — don't wait for idle.
    if (el.scrollTop < 30 && !historyExhausted.current) {
      pendingLoadOlder.current = true
      if (!loadingHistory.current && !pinJumpLockRef.current) {
        pendingLoadOlder.current = false
        void loadOlderMessages()
      }
    }
  }

  const jumpToLatest = () => {
    timelineWindowRef.current = null
    historyExhausted.current = false
    loadingNewer.current = false
    pendingLoadNewer.current = false
    openIntent.current = 'bottom'
    stickToBottom.current = true
    didInitialPosition.current = true
    setShowJumpDown(false)
    setJumpBadge(0)
    setUnreadBeforeId(null)
    clearPendingUnreadEvent()
    if (activeRoom) {
      commitTimelineMessages(
        activeRoom.roomId,
        activeRoom
          .getLiveTimeline()
          .getEvents()
          .filter(isTimelineMessageEvent),
      )
    }
    // Rows update on next paint — scroll after layout commits live length
    scrollToBottomAfterLayout()
    requestAnimationFrame(() => {
      scrollToBottom(false)
    })
    if (activeRoomId) void markRoomAsRead(activeRoomId)
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current += 1
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length) setDroppedFiles(files)
  }

  const mentionMembers = useMemo(() => {
    if (!activeRoom) return []
    return activeRoom.getJoinedMembers().map((m) => ({
      userId: m.userId,
      displayName:
        m.name ||
        m.rawDisplayName ||
        m.userId.split(':')[0].substring(1) ||
        m.userId,
    }))
  }, [activeRoom, messages.length, reactionTick])

  const handleUserClick = useCallback(
    async (userId: string) => {
      if (!client || userId === myUserId) return
      try {
        const roomId = await openOrCreateDirectChat(client, userId)
        useRoomStore.getState().actions.setActiveRoomId(roomId)
      } catch (err) {
        console.error('Failed to open DM from mention', err)
        alert('Не удалось открыть личный чат')
      }
    },
    [client, myUserId],
  )

  if (!activeRoomId || !client) {
    return (
      <div className="flex-1 flex items-center justify-center tg-chat-bg">
        <p className="text-white/40 text-[15px]">Выберите чат, чтобы начать переписку</p>
      </div>
    )
  }

  // Room id is selected but SDK hasn't handed us the Room yet — keep shell,
  // never blank the whole main pane mid-sync.
  if (!activeRoom) {
    return (
      <div className="flex-1 flex items-center justify-center tg-chat-bg">
        <div className="flex flex-col items-center gap-2 text-white/45">
          <Loader2 className="w-5 h-5 animate-spin" />
          <p className="text-[13px]">Загрузка комнаты…</p>
        </div>
      </div>
    )
  }

  const isGroup = activeRoom.getJoinedMemberCount() > 2
  // Fullscreen spinner ONLY before the first hydrate when there is nothing to show.
  // Pagination must never take this branch — messages.length > 0 keeps the scroller mounted.
  const isInitialLoading = messages.length === 0 && !initialHydrated
  const isPaginatingOlder = isLoadingHistory && messages.length > 0

  return (
    <ImageOpenContext.Provider value={openImage}>
    <VideoOpenContext.Provider value={openVideo}>
    <TimelineScrollContext.Provider value={timelineRef}>
      <div
        className="flex-1 flex flex-col tg-chat-bg overflow-hidden relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="tg-drop-overlay">Отпустите файлы, чтобы прикрепить</div>
        )}

        <div className="tg-header-bar border-b shrink-0 relative z-30">
          <ChatHeader
            room={activeRoom}
            chatSearchOpen={chatSearchOpen}
            showDecrypt={showDecrypt}
            typingLabel={typingLabel}
            onToggleSearch={() => {
              setChatSearchOpen((v) => {
                if (v) {
                  setChatSearchQuery('')
                  setSearchResultsOpen(false)
                  setSearchCursor(-1)
                } else {
                  requestAnimationFrame(() => chatSearchRef.current?.focus())
                }
                return !v
              })
            }}
            onOpenDecrypt={() => setDecryptModalOpen(true)}
            onOpenProfile={() => openRoomProfile(activeRoom.roomId)}
          />
          {chatSearchOpen && (
            <div className="px-4 pb-3 relative" ref={searchPanelRef}>
              <div className="relative flex items-center">
                <span className="tg-field-icon-slot" aria-hidden>
                  <Search className="tg-field-icon" strokeWidth={2} />
                </span>
                <input
                  ref={chatSearchRef}
                  type="text"
                  value={chatSearchQuery}
                  onChange={(e) => {
                    setChatSearchQuery(e.target.value)
                    setSearchCursor(-1)
                    setSearchResultsOpen(e.target.value.trim().length > 0)
                  }}
                  onFocus={() => {
                    if (chatSearchQuery.trim()) setSearchResultsOpen(true)
                  }}
                  onClick={() => {
                    if (chatSearchQuery.trim()) setSearchResultsOpen(true)
                  }}
                  onKeyDown={(e) => {
                    if (!chatSearchQ || searchResults.length === 0) return
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (e.altKey) goSearchPrev()
                      else goSearchNext()
                    } else if (e.key === 'ArrowDown' && !searchResultsOpen) {
                      e.preventDefault()
                      goSearchNext()
                    } else if (e.key === 'ArrowUp' && !searchResultsOpen) {
                      e.preventDefault()
                      goSearchPrev()
                    } else if (e.key === 'Escape' && searchResultsOpen) {
                      e.preventDefault()
                      setSearchResultsOpen(false)
                    }
                  }}
                  placeholder="Поиск текста в этом чате…"
                  className="tg-field w-full h-10 rounded-xl pl-10 pr-10 outline-none text-[13.5px] leading-none"
                />
                <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                  {chatSearchQuery ? (
                    <button
                      type="button"
                      onClick={() => {
                        setChatSearchQuery('')
                        setSearchResultsOpen(false)
                        setSearchCursor(-1)
                        chatSearchRef.current?.focus()
                      }}
                      className="tg-icon-btn w-7 h-7 flex items-center justify-center rounded-full"
                      aria-label="Очистить"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setChatSearchOpen(false)
                        setChatSearchQuery('')
                        setSearchResultsOpen(false)
                        setSearchCursor(-1)
                      }}
                      className="tg-icon-btn w-7 h-7 flex items-center justify-center rounded-full"
                      aria-label="Закрыть поиск"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {chatSearchQ &&
                !searchResultsOpen &&
                searchResults.length > 0 && (
                  <div className="mt-2 flex items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={goSearchPrev}
                      disabled={searchCursor === 0}
                      className="tg-icon-btn w-7 h-7 flex items-center justify-center rounded-lg disabled:opacity-30"
                      aria-label="Предыдущий результат"
                      title="Предыдущий (↑)"
                    >
                      <ChevronUp className="w-4 h-4" strokeWidth={2.25} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setSearchResultsOpen(true)}
                      className="tg-search-nav-count min-w-[4.5rem] px-2 h-7 rounded-lg text-[12px] tabular-nums font-medium transition-colors"
                      title="Открыть список результатов"
                    >
                      {searchCursor >= 0 ? searchCursor + 1 : '—'}
                      <span className="tg-search-nav-sep"> / </span>
                      {searchResults.length}
                    </button>
                    <button
                      type="button"
                      onClick={goSearchNext}
                      disabled={
                        searchCursor >= 0 &&
                        searchCursor >= searchResults.length - 1
                      }
                      className="tg-icon-btn w-7 h-7 flex items-center justify-center rounded-lg disabled:opacity-30"
                      aria-label="Следующий результат"
                      title="Следующий (↓ / Enter)"
                    >
                      <ChevronDown className="w-4 h-4" strokeWidth={2.25} />
                    </button>
                  </div>
                )}

              {chatSearchQ &&
                !searchResultsOpen &&
                searchResults.length === 0 && (
                  <div className="tg-search-nav-empty mt-2 text-center text-[12px]">
                    Ничего не найдено
                  </div>
                )}

              {searchResultsOpen && chatSearchQ && (
                <div
                  className="tg-search-results absolute left-4 right-4 top-[calc(100%-0.25rem)] z-50 max-h-[min(42vh,360px)] overflow-y-auto rounded-xl border origin-top animate-[tg-search-pop_0.14s_ease-out]"
                  role="listbox"
                  aria-label="Результаты поиска"
                >
                  {searchResults.length === 0 ? (
                    <div className="tg-search-results-empty px-3 py-3 text-[13px] text-center">
                      Ничего не найдено в загруженной истории
                    </div>
                  ) : (
                    <ul className="py-1">
                      {searchResults.map((hit, index) => (
                        <li key={hit.eventId}>
                          <button
                            type="button"
                            className={clsx(
                              'tg-search-results-item w-full text-left px-3 py-2',
                              index === searchCursor &&
                                'tg-search-results-item--active',
                            )}
                            onMouseDown={(e) => {
                              e.preventDefault()
                            }}
                            onClick={() => jumpToSearchIndex(index)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className="text-[12.5px] font-semibold truncate"
                                style={{
                                  color: getUserColor(
                                    hit.senderId || hit.senderName,
                                  ),
                                }}
                              >
                                {hit.senderName}
                              </span>
                              <span className="tg-muted text-[11px] shrink-0 tabular-nums">
                                {format(hit.ts, 'd MMM HH:mm', { locale: ru })}
                              </span>
                            </div>
                            <div className="tg-search-results-snippet text-[13px] truncate mt-0.5">
                              {hit.snippet}
                            </div>
                          </button>
                        </li>
                      ))}
                      {searchHitCount > searchResults.length && (
                        <li className="tg-search-results-more px-3 py-2 text-[11px] text-center border-t">
                          Показаны первые {searchResults.length} из{' '}
                          {searchHitCount}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Pin bar lives ABOVE the scroll container — never overlays virtual rows */}
        {pinnedMessages.length > 0 && (
          <div
            ref={pinBarRef}
            className="tg-pinned-bar-slot shrink-0 border-b relative z-30"
          >
            <PinnedMessageBar
              preview={
                pinnedMessages[
                  Math.min(activePinIndex, pinnedMessages.length - 1)
                ]?.preview ?? ''
              }
              ts={
                pinnedMessages[
                  Math.min(activePinIndex, pinnedMessages.length - 1)
                ]?.ts
              }
              index={Math.min(activePinIndex, pinnedMessages.length - 1) + 1}
              total={pinnedMessages.length}
              personalOnly={(() => {
                const pin =
                  pinnedMessages[
                    Math.min(activePinIndex, pinnedMessages.length - 1)
                  ]
                return !!pin && pin.scope.self && !pin.scope.room
              })()}
              canUnpin={(() => {
                const pin =
                  pinnedMessages[
                    Math.min(activePinIndex, pinnedMessages.length - 1)
                  ]
                if (!pin || !activeRoom) return false
                if (pin.scope.self) return true
                return pin.scope.room && canPinMessages(activeRoom, myUserId)
              })()}
              onClick={() => void handlePinnedBarClick()}
              onUnpin={() => void handleUnpinFromBar()}
            />
          </div>
        )}

        <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Pagination only — never replaces / unmounts the scroll list */}
          {isPaginatingOlder && (
            <div
              className="pointer-events-none absolute top-2 left-0 right-0 z-10 flex justify-center [overflow-anchor:none]"
              style={{ overflowAnchor: 'none' }}
            >
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 text-[11px] text-white/55 backdrop-blur-xs [overflow-anchor:none]"
                style={{ overflowAnchor: 'none' }}
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                Загрузка истории…
              </span>
            </div>
          )}
          <div
            className={clsx(
              'tg-sticky-date absolute top-2 left-0 right-0 z-20 flex justify-center',
              (stickyDateVisible || dateJumpOpen) &&
                stickyDateLabel &&
                'tg-sticky-date--visible',
              !(stickyDateVisible || dateJumpOpen) && 'pointer-events-none',
            )}
            aria-hidden={!(stickyDateVisible || dateJumpOpen)}
          >
            {stickyDateLabel && (
              <button
                ref={stickyDatePillRef}
                type="button"
                className="tg-sticky-date-pill"
                title="Перейти к дате"
                onClick={() => openDateJump(stickyDateTs ?? undefined)}
              >
                {stickyDateLabel}
              </button>
            )}
          </div>
          <TimelineDateJumpPopover
            open={dateJumpOpen}
            selectedTs={stickyDateTs}
            daysWithMessages={daysWithMessages}
            loading={dateJumpLoading}
            anchorRef={stickyDatePillRef}
            onClose={() => {
              setDateJumpOpen(false)
              updateStickyDateFromScroll()
            }}
            onSelectDay={(dayStartMs) => {
              void jumpToDay(dayStartMs)
            }}
          />
          {/*
            Initial empty room: fullscreen spinner is OK.
            Once messages exist, the scroller stays mounted across pagination
            so native overflow-anchor can keep the viewport stable.
          */}
          {isInitialLoading ? (
            <div className="flex-1 flex items-center justify-center min-h-0">
              <div className="flex flex-col items-center gap-2 text-white/45">
                <Loader2 className="w-5 h-5 animate-spin" />
                <p className="text-[13px]">Загрузка сообщений…</p>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center min-h-0">
              <p className="text-white/40 text-[14px]">Нет сообщений</p>
            </div>
          ) : (
          <div
            ref={timelineRef}
            className={clsx(
              'tg-timeline-scroll flex-1 px-4 pt-3 pb-2 overflow-y-auto overflow-x-hidden min-w-0 min-h-0 flex flex-col [overflow-anchor:auto] scroll-pt-14 [scroll-behavior:auto]',
              isReady ? 'opacity-100' : 'opacity-0 pointer-events-none',
            )}
            style={{ overflowAnchor: 'auto' }}
            tabIndex={-1}
            onScroll={handleTimelineScroll}
            onWheel={() => {
              releasePinHoldOnUserScroll()
              schedulePinnedBarSync()
            }}
            onTouchMove={() => {
              releasePinHoldOnUserScroll()
              schedulePinnedBarSync()
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'ArrowUp' ||
                e.key === 'ArrowDown' ||
                e.key === 'PageUp' ||
                e.key === 'PageDown' ||
                e.key === 'Home' ||
                e.key === 'End' ||
                e.key === ' '
              ) {
                releasePinHoldOnUserScroll()
              }
            }}
            onPointerDown={(e) => {
              if (e.button === 0) releasePinHoldOnUserScroll()
            }}
          >
              {timelineRows.map((row) => {
                const { item, dayChanged, showUnreadSep, isContinuation, isOwn } =
                  row
                const rowEventId = row.firstEvent.getId()

                return (
                  <div
                    key={row.key}
                    id={rowEventId ? `message-${rowEventId}` : undefined}
                    data-tg-row-key={row.key}
                    className="tg-timeline-row shrink-0"
                    style={{
                      // Spacing via padding (never margin) — plays nicer with overflow-anchor
                      paddingBottom: isContinuation ? 6 : 10,
                    }}
                  >
                    {dayChanged && (
                      <DateSeparator
                        ts={row.firstEvent.getTs()}
                        onJumpClick={openDateJump}
                      />
                    )}
                    {showUnreadSep && <UnreadSeparator />}
                    {item.kind === 'album' ? (
                      <AlbumBubble
                        item={item}
                        isOwn={isOwn}
                        showSender={isGroup && !isOwn}
                        isContinuation={isContinuation}
                        afterDaySep={dayChanged}
                        room={activeRoom}
                        myUserId={myUserId}
                        reactionTick={reactionTick}
                        receiptTick={receiptTick}
                        selectedIds={selectedSet}
                        highlightIds={highlightSet}
                        selecting={selectionMode || selectedMediaIds.length > 0}
                        searchHit={
                          !!chatSearchQ &&
                          item.events.some((e) =>
                            eventMatchesSearch(e, chatSearchQ),
                          )
                        }
                        onToggleSelect={toggleSelectMedia}
                        onReply={handleReply}
                        onContextMenu={openContextMenu}
                        onScrollTo={scrollToEvent}
                        mentionMembers={mentionMembers}
                        onUserClick={handleUserClick}
                        showHoverActions={
                          !!item.imageEvents[0]?.getId() &&
                          hoveredEventId === item.imageEvents[0].getId()
                        }
                        onHoverActionsChange={setHoveredEventIdDelayed}
                      />
                    ) : (
                      <MessageBubble
                        event={item.event}
                        isOwn={isOwn}
                        showSender={isGroup && !isOwn}
                        isContinuation={isContinuation}
                        afterDaySep={dayChanged}
                        room={activeRoom}
                        myUserId={myUserId}
                        reactionTick={reactionTick}
                        receiptTick={receiptTick}
                        highlightIds={highlightSet}
                        selecting={selectionMode || selectedMediaIds.length > 0}
                        selected={
                          !!item.event.getId() &&
                          selectedSet.has(item.event.getId()!)
                        }
                        onToggleSelect={toggleSelectMedia}
                        searchHit={
                          !!chatSearchQ &&
                          eventMatchesSearch(item.event, chatSearchQ)
                        }
                        mentionMembers={mentionMembers}
                        onUserClick={handleUserClick}
                        onReply={handleReply}
                        onContextMenu={openContextMenu}
                        onScrollTo={scrollToEvent}
                        showHoverActions={
                          !!item.event.getId() &&
                          hoveredEventId === item.event.getId()
                        }
                        onHoverActionsChange={setHoveredEventIdDelayed}
                      />
                    )}
                  </div>
                )
              })}
          </div>
          )}

          {showJumpDown && (
            <button
              type="button"
              className="tg-jump-down"
              onClick={jumpToLatest}
              aria-label="К новым сообщениям"
              title="К новым сообщениям"
            >
              <ChevronDown className="w-5 h-5" strokeWidth={2.25} />
              {jumpBadge > 0 && (
                <span className="tg-jump-down-badge">
                  {jumpBadge > 99 ? '99+' : jumpBadge}
                </span>
              )}
            </button>
          )}
        </div>

        {(selectionMode || selectedMediaIds.length > 0) && (
          <div className="px-3 py-2 flex items-center justify-between gap-3 border-t border-white/8 bg-[#1a2733]">
            <span className="text-[13px] text-white/70">
              Выбрано: {selectedMediaIds.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearSelection}
                className="text-[13px] text-white/45 hover:text-white px-2 py-1 rounded-lg hover:bg-white/10"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={replyToSelection}
                disabled={selectedMediaIds.length === 0}
                className="text-[13px] font-medium text-white/90 bg-white/10 hover:bg-white/15 disabled:opacity-40 px-3 py-1.5 rounded-full"
              >
                Ответить
              </button>
              <button
                type="button"
                onClick={forwardSelection}
                disabled={selectedMediaIds.length === 0}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-40 px-3 py-1.5 rounded-full"
              >
                <Forward className="w-3.5 h-3.5" strokeWidth={2.25} />
                Переслать
              </button>
            </div>
          </div>
        )}

        <MessageInput
          activeRoom={activeRoom}
          externalFiles={droppedFiles}
          onExternalFilesConsumed={onExternalFilesConsumed}
          replyTo={replyTo}
          onClearReply={clearReply}
          editTarget={editTarget}
          onClearEdit={clearEdit}
          pendingMention={pendingMention}
          onMentionConsumed={() => setPendingMention(null)}
          onSent={() => {
            stickToBottom.current = true
            timelineWindowRef.current = null
            historyExhausted.current = false
            openIntent.current = 'bottom'
            setShowJumpDown(false)
            setJumpBadge(0)
            setUnreadBeforeId(null)
            clearPendingUnreadEvent()
            if (activeRoom) {
              commitTimelineMessages(
                activeRoom.roomId,
                activeRoom
                  .getLiveTimeline()
                  .getEvents()
                  .filter(isTimelineMessageEvent),
              )
            }
            scrollToBottomAfterLayout()
            if (activeRoomId) void markRoomAsRead(activeRoomId)
          }}
        />
        <DecryptHistoryModal
          isOpen={isDecryptModalOpen}
          onClose={() => setDecryptModalOpen(false)}
          client={client}
          room={activeRoom}
        />

        {client && (
          <RoomProfileModal
            isOpen={!!profileRoomId && profileRoomId === activeRoom.roomId}
            room={activeRoom}
            client={client}
            onClose={closeRoomProfile}
            onMention={(m) => {
              setPendingMention({
                userId: m.userId,
                displayName: m.displayName,
                nonce: Date.now(),
              })
            }}
          />
        )}

        {ctxMenu && (
          <MessageContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            isOwn={ctxMenu.isOwn}
            canEdit={canEditEvent(ctxMenu.events[0], ctxMenu.isOwn)}
            canCopy={
              ctxMenu.events.some((e) => !!messagePlainText(e)) ||
              ctxMenu.events.some((e) => !!messageSnippet(e))
            }
            canDelete={ctxMenu.isOwn}
            canForward={ctxMenu.events.some(canForwardEvent)}
            canPinForEveryone={
              !!activeRoom && canPinMessages(activeRoom, myUserId)
            }
            isPinnedForEveryone={
              !!activeRoom &&
              !!ctxMenu.events[0]?.getId() &&
              isEventPinned(activeRoom, ctxMenu.events[0].getId()!)
            }
            isPinnedForSelf={
              !!activeRoom &&
              !!myUserId &&
              !!ctxMenu.events[0]?.getId() &&
              personalPinnedIds.includes(ctxMenu.events[0].getId()!)
            }
            canSaveGif={ctxMenu.events.some((e) => {
              if (e.isDecryptionFailure()) return false
              return isGifMessageContent(
                e.getContent() as Record<string, unknown>,
              )
            })}
            onClose={() => setCtxMenu(null)}
            quoteText={ctxMenu.quoteText}
            onQuote={
              ctxMenu.quoteText
                ? () => handleReply(ctxMenu.events, ctxMenu.quoteText)
                : undefined
            }
            onReply={() => handleReply(ctxMenu.events)}
            onForward={() => openForwardPicker(ctxMenu.events)}
            onSelect={() => beginSelectFromMenu(ctxMenu.events)}
            onEdit={() => handleEditFromMenu(ctxMenu.events)}
            onCopy={() => void handleCopyFromMenu(ctxMenu.events)}
            onDelete={() => void handleDeleteFromMenu(ctxMenu.events)}
            onPinForEveryone={() => void handlePinForEveryone(ctxMenu.events)}
            onUnpinForEveryone={() =>
              void handleUnpinForEveryone(ctxMenu.events)
            }
            onPinForSelf={() => handlePinForSelf(ctxMenu.events)}
            onUnpinForSelf={() => handleUnpinForSelf(ctxMenu.events)}
            onSaveGif={() => void handleSaveGifFromMenu(ctxMenu.events)}
            onReact={(emoji) =>
              void handleReactFromMenu(ctxMenu.events, emoji)
            }
          />
        )}

        <ForwardRoomPicker
          open={!!forwardEvents?.length}
          onClose={() => {
            if (!forwardBusy) setForwardEvents(null)
          }}
          onConfirm={handleForwardConfirm}
          excludeRoomId={activeRoom?.roomId}
          busy={forwardBusy}
          title={
            forwardEvents && forwardEvents.length > 1
              ? `Переслать (${forwardEvents.length})…`
              : 'Переслать в…'
          }
        />

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

        {videoViewer && (
          <VideoViewer
            videos={videoViewer.videos}
            index={videoViewer.index}
            onClose={() => setVideoViewer(null)}
            onIndexChange={(i) =>
              setVideoViewer((v) => (v ? { ...v, index: i } : v))
            }
          />
        )}
      </div>
    </TimelineScrollContext.Provider>
    </VideoOpenContext.Provider>
    </ImageOpenContext.Provider>
  )
}
