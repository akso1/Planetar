import { useRef } from 'react'
import { clsx } from 'clsx'
import { Room } from 'matrix-js-sdk'
import { Pencil, Pin, BellOff, Paperclip } from 'lucide-react'
import { useSessionStore } from '@/entities/session/model/session'
import { getRoomUnread, getSpaceChildUnreadTotal } from '@/entities/session/model/room.store'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { getRoomLastMessagePreview } from '@/shared/ui/FormattedPreview'
import type { ChatPeekAnchor } from '@/widgets/ChatPeekPopover'

const HOLD_MS = 430
const MOVE_CANCEL_PX = 10

interface RoomItemProps {
  room: Room
  isActive?: boolean
  isPinned?: boolean
  isMuted?: boolean
  /** Pre-truncated draft text. When set, replaces the last-message preview (Telegram-style). */
  draftPreview?: string
  /** Show a paperclip next to the draft when there are session-only attachments. */
  draftHasFiles?: boolean
  onContextMenu?: (e: React.MouseEvent, room: Room) => void
  /** Long-press on avatar → stealth peek (does not mark read). */
  onAvatarLongPress?: (room: Room, anchor: ChatPeekAnchor) => void
}

export function RoomItem({
  room,
  isActive,
  isPinned,
  isMuted,
  draftPreview,
  draftHasFiles,
  onContextMenu,
  onAvatarLongPress,
}: RoomItemProps) {
  const client = useSessionStore((state) => state.client)
  const roomName = room.name

  const myId = client?.getUserId() ?? null
  const unreadCount = room.isSpaceRoom()
    ? client
      ? getSpaceChildUnreadTotal(room, client, myId)
      : 0
    : getRoomUnread(room, myId)
  const avatarMxc = room.getMxcAvatarUrl?.() ?? null

  const { plain, node, time, edited } = getRoomLastMessagePreview(room)

  const holdTimer = useRef<number | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const openedPeek = useRef(false)
  const avatarWrapRef = useRef<HTMLDivElement>(null)

  const clearHold = () => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    startPos.current = null
  }

  const onAvatarPointerDown = (e: React.PointerEvent) => {
    if (!onAvatarLongPress) return
    if (e.button !== 0) return
    // Keep long-press from starting list reorder / click open
    e.stopPropagation()
    openedPeek.current = false
    startPos.current = { x: e.clientX, y: e.clientY }
    clearHold()
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      const el = avatarWrapRef.current
      if (!el || !onAvatarLongPress) return
      const r = el.getBoundingClientRect()
      openedPeek.current = true
      onAvatarLongPress(room, {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      })
      try {
        el.releasePointerCapture?.(e.pointerId)
      } catch {
        /* ignore */
      }
    }, HOLD_MS)
  }

  const onAvatarPointerMove = (e: React.PointerEvent) => {
    if (!startPos.current || holdTimer.current == null) return
    const dx = e.clientX - startPos.current.x
    const dy = e.clientY - startPos.current.y
    if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
      clearHold()
    }
  }

  const onAvatarPointerUp = () => {
    clearHold()
  }

  return (
    <div
      className={clsx(
        'tg-room-item flex items-center gap-3 p-2 mx-2 rounded-lg cursor-pointer transition-colors',
        isActive && 'tg-room-item--active',
      )}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu?.(e, room)
      }}
      onClickCapture={(e) => {
        // Swallow the click that follows a successful long-press
        if (openedPeek.current) {
          e.preventDefault()
          e.stopPropagation()
          openedPeek.current = false
        }
      }}
    >
      <div
        ref={avatarWrapRef}
        className="tg-room-avatar-hold shrink-0 relative touch-manipulation"
        onPointerDown={onAvatarPointerDown}
        onPointerMove={onAvatarPointerMove}
        onPointerUp={onAvatarPointerUp}
        onPointerCancel={onAvatarPointerUp}
        onPointerLeave={onAvatarPointerUp}
        onContextMenu={(e) => {
          // Prefer peek over OS menu on avatar; room menu stays on the row
          if (onAvatarLongPress) e.preventDefault()
        }}
        title={onAvatarLongPress ? 'Удерживайте для тайного просмотра' : undefined}
      >
        <MxcAvatar
          client={client}
          mxcUrl={avatarMxc}
          label={roomName}
          size={44}
        />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center gap-1">
          <div className="tg-room-name text-sm font-medium truncate min-w-0 flex items-center gap-1">
            {isPinned && (
              <Pin
                className="tg-room-pin w-3 h-3 shrink-0 opacity-55"
                strokeWidth={2.5}
                aria-label="Закреплён"
              />
            )}
            {isMuted && (
              <BellOff
                className="w-3 h-3 shrink-0 opacity-55"
                strokeWidth={2.5}
                aria-label="Без звука"
              />
            )}
            <span className="truncate">{roomName}</span>
          </div>
          <div className="tg-room-time text-xs shrink-0 ml-1">{time}</div>
        </div>
        <div className="flex justify-between items-start mt-0.5 gap-1">
          {draftPreview ? (
            <div
              className="tg-room-preview tg-room-preview--draft text-xs truncate mr-1 min-w-0 flex items-center gap-1"
              title={`Черновик: ${draftPreview}`}
            >
              <Pencil
                className="tg-room-preview-icon w-3 h-3 shrink-0"
                strokeWidth={2.5}
                aria-label="Черновик"
              />
              {draftHasFiles && (
                <Paperclip
                  className="w-3 h-3 shrink-0 opacity-70"
                  strokeWidth={2.5}
                  aria-label="Вложение"
                />
              )}
              <span className="tg-room-preview-rich truncate min-w-0">
                {draftPreview}
              </span>
            </div>
          ) : (
            <div
              className="tg-room-preview text-xs truncate mr-1 min-w-0 flex items-center gap-1"
              title={edited ? `изменено · ${plain}` : plain}
            >
              {edited && (
                <Pencil
                  className="tg-room-preview-icon w-3 h-3 shrink-0"
                  strokeWidth={2.5}
                  aria-label="Изменено"
                />
              )}
              <span className="tg-room-preview-rich truncate min-w-0">
                {node}
              </span>
            </div>
          )}
          {unreadCount > 0 && (
            <div
              className={clsx(
                'text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0',
                isMuted
                  ? 'bg-surface-inset text-ink-muted border border-hairline'
                  : isActive
                    ? 'tg-unread--on-active'
                    : 'tg-unread',
              )}
            >
              {unreadCount}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
