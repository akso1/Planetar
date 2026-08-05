import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { AtSign, Copy, MessageSquare, UserRound, X } from 'lucide-react'
import type { MatrixClient, Room } from 'matrix-js-sdk'
import { useSessionStore } from '@/entities/session/model/session'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import {
  clampMenuPosition,
  viewportBounds,
  type MenuPos,
} from '@/shared/lib/clampMenuPosition'
import { getUserColor, getUserColorAlpha } from '@/shared/lib/color'
import {
  mentionComposerLabel,
  mxidLocalpart,
  type MentionClickAnchor,
} from '@/shared/lib/mentions'
import { formatPresenceLabel } from '@/shared/lib/presenceLabel'
import { memberRoleInfo } from '@/shared/lib/roomModeration'
import { openOrCreateDirectChat } from '@/shared/lib/openDm'
import { showAppToast } from '@/shared/lib/appToast'
import { useRoomStore } from '@/entities/session/model/room.store'

function clampToAnchor(
  anchor: MentionClickAnchor,
  width: number,
  height: number,
  pad = 10,
): MenuPos {
  const { vw, vh, ox, oy } = viewportBounds()
  let left = anchor.left
  let top = anchor.bottom + 8

  // Prefer below the pill; flip above when it would leave the viewport
  if (top + height > oy + vh - pad) {
    top = anchor.top - height - 8
  }
  if (top < oy + pad) top = oy + pad
  if (top + height > oy + vh - pad) {
    top = Math.max(oy + pad, oy + vh - pad - height)
  }

  if (left + width > ox + vw - pad) {
    left = ox + vw - pad - width
  }
  if (left < ox + pad) left = ox + pad

  // Final safety — never hang past edges even on tiny windows
  return clampMenuPosition(left, top, width, height, pad)
}

export type MentionUserCardProps = {
  room: Room
  client: MatrixClient
  userId: string
  /** Text shown on the mention pill (e.g. @name) */
  visibleLabel?: string
  anchor: MentionClickAnchor
  onClose: () => void
  onMention: (payload: { userId: string; displayName: string }) => void
  onOpenProfile: () => void
}

/**
 * Compact popover when clicking an @mention — who is this, mention / profile / DM.
 * Portal + viewport clamp; does not touch timeline scroll / virtualization.
 */
export function MentionUserCard({
  room,
  client,
  userId,
  visibleLabel,
  anchor,
  onClose,
  onMention,
  onOpenProfile,
}: MentionUserCardProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 8 })
  const [ready, setReady] = useState(false)
  const setActiveRoomId = useRoomStore((s) => s.actions.setActiveRoomId)
  const myId = useSessionStore((s) => s.client?.getUserId?.() ?? null)

  const member = room.getMember(userId)
  const inRoom = Boolean(member && member.membership === 'join')
  const displayName =
    member?.name ||
    member?.rawDisplayName ||
    visibleLabel?.replace(/^@+/, '') ||
    mxidLocalpart(userId) ||
    userId
  const handle = mentionComposerLabel(userId, visibleLabel)
  const avatarMxc = member?.getMxcAvatarUrl?.() ?? null
  const role = inRoom
    ? memberRoleInfo(room, userId)
    : { role: 'member' as const, label: '' }
  const presence = useMemo(() => {
    try {
      return formatPresenceLabel(client.getUser(userId))
    } catch {
      return null
    }
  }, [client, userId])
  const isSelf = !!myId && myId === userId
  const accent = getUserColor(userId)

  useLayoutEffect(() => {
    setReady(false)
    const el = panelRef.current
    if (!el) return
    const place = () => {
      const rect = el.getBoundingClientRect()
      // Prefer just below the pill; clampMenuPosition flips above if needed
      setPos(
        clampToAnchor(anchor, rect.width, rect.height, 10),
      )
      setReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [anchor.left, anchor.top, anchor.bottom, anchor.right, userId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const openedAt = performance.now()
    const onPointer = (e: MouseEvent) => {
      // Ignore the opening click / late bubble from the mention pill
      if (performance.now() - openedAt < 160) return
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onResize = () => onClose()

    document.addEventListener('keydown', onKey)
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer, true)
    }, 120)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('scroll', onResize)

    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('scroll', onResize)
    }
  }, [onClose])

  const copyId = async () => {
    await copyTextToClipboard(userId)
  }

  const openDm = async () => {
    if (isSelf) return
    try {
      const roomId = await openOrCreateDirectChat(client, userId)
      if (roomId) {
        setActiveRoomId(roomId)
        onClose()
        return
      }
      showAppToast('Не удалось открыть ЛС', { duration: 2600 })
    } catch (err) {
      console.error('Failed to open DM from mention card', err)
      showAppToast('Не удалось открыть ЛС', { duration: 2600 })
    }
  }

  // Keep card within visual viewport width if clamp left edge needs a max width
  const { vw } = viewportBounds()
  const maxW = Math.min(300, Math.max(220, vw - 20))

  return createPortal(
    <div
      ref={panelRef}
      className="tg-mention-card fixed z-[1200]"
      style={{
        left: pos.left,
        top: pos.top,
        width: maxW,
        visibility: ready ? 'visible' : 'hidden',
        ['--mention-accent' as string]: accent,
        ['--mention-accent-soft' as string]: getUserColorAlpha(userId, 0.16),
      }}
      role="dialog"
      aria-label={`Участник ${displayName}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="tg-mention-card-inner">
        <header className="flex items-start gap-2.5 px-3 pt-3 pb-2">
          <div
            className="tg-mention-card-avatar shrink-0 rounded-full ring-2"
            style={{ boxShadow: `0 0 0 2px ${getUserColorAlpha(userId, 0.35)}` }}
          >
            <MxcAvatar
              client={client}
              mxcUrl={avatarMxc}
              label={displayName}
              size={44}
            />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ink truncate leading-tight">
                  {displayName}
                </div>
                <div className="tg-mention-card-handle text-[12px] truncate mt-0.5">
                  @{handle}
                </div>
              </div>
              <button
                type="button"
                className="tg-icon-btn w-7 h-7 flex items-center justify-center rounded-lg shrink-0 -mr-1 -mt-0.5"
                aria-label="Закрыть"
                onClick={onClose}
              >
                <X className="w-3.5 h-3.5" strokeWidth={2.25} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {role.label ? (
                <span className="tg-mention-card-chip">{role.label}</span>
              ) : null}
              {!inRoom && !isSelf ? (
                <span className="tg-mention-card-chip tg-mention-card-chip--muted">
                  Не в комнате
                </span>
              ) : null}
              {presence ? (
                <span className="text-[11px] text-ink-faint truncate">
                  {presence}
                </span>
              ) : null}
              {isSelf ? (
                <span className="tg-mention-card-chip tg-mention-card-chip--muted">
                  Вы
                </span>
              ) : null}
            </div>
          </div>
        </header>

        <button
          type="button"
          className="tg-mention-card-mxid mx-3 mb-2 w-[calc(100%-1.5rem)] text-left"
          title="Скопировать Matrix ID"
          onClick={() => void copyId()}
        >
          <span className="truncate">{userId}</span>
          <Copy className="w-3 h-3 shrink-0 opacity-70" strokeWidth={2.25} />
        </button>

        <div className="tg-mention-card-actions grid grid-cols-2 gap-1.5 px-3 pb-3">
          <button
            type="button"
            className="tg-mention-card-btn tg-mention-card-btn--primary"
            onClick={() => {
              onMention({ userId, displayName: handle })
              onClose()
            }}
          >
            <AtSign className="w-3.5 h-3.5" strokeWidth={2.25} />
            Упомянуть
          </button>
          <button
            type="button"
            className="tg-mention-card-btn"
            onClick={() => {
              onOpenProfile()
              onClose()
            }}
          >
            <UserRound className="w-3.5 h-3.5" strokeWidth={2.25} />
            Профиль
          </button>
          {!isSelf && (
            <button
              type="button"
              className="tg-mention-card-btn col-span-2"
              onClick={() => void openDm()}
            >
              <MessageSquare className="w-3.5 h-3.5" strokeWidth={2.25} />
              Написать в ЛС
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
