import { Phone, Search, Users, Video } from 'lucide-react'
import { clsx } from 'clsx'
import type { Room } from 'matrix-js-sdk'

type ChatHeaderProps = {
  room: Room
  chatSearchOpen: boolean
  onToggleSearch: () => void
  onOpenDecrypt: () => void
  onOpenProfile: () => void
  /** Show Decrypt only when this device still needs key recovery / is unverified */
  showDecrypt?: boolean
  /** e.g. "печатает…" / "Аня и ещё 2 печатают" */
  typingLabel?: string | null
  /** Presence / last-seen for DMs when not typing */
  statusLabel?: string | null
  /** Native 1:1 call (DM) or Element Call (groups) */
  onVoiceCall?: () => void
  onVideoCall?: () => void
  /** MatrixRTC session active in this room */
  callActive?: boolean
  callBusy?: boolean
}

export function ChatHeader({
  room,
  chatSearchOpen,
  onToggleSearch,
  onOpenDecrypt,
  onOpenProfile,
  showDecrypt = false,
  typingLabel = null,
  statusLabel = null,
  onVoiceCall,
  onVideoCall,
  callActive = false,
  callBusy = false,
}: ChatHeaderProps) {
  const memberCount = room.getJoinedMemberCount()
  const isGroup = memberCount > 2
  const subtitle =
    typingLabel || statusLabel || (isGroup ? `${memberCount} участников` : null)

  return (
    <div className="h-12 px-4 flex items-center gap-3">
      <button
        type="button"
        onClick={onOpenProfile}
        className="flex-1 min-w-0 h-10 flex flex-col justify-center text-left rounded-lg px-2 -mx-1 tg-hover-surface transition-colors duration-ui"
        title="Профиль чата"
      >
        <div className="tg-title text-[15px] font-semibold truncate leading-tight">
          {room.name || 'Чат'}
        </div>
        {subtitle && (
          <div
            className={clsx(
              'text-[11px] truncate leading-tight mt-0.5',
              !(
                typingLabel ||
                statusLabel === 'в сети' ||
                statusLabel === 'отошёл'
              ) && 'tg-muted',
            )}
            style={
              typingLabel ||
              statusLabel === 'в сети' ||
              statusLabel === 'отошёл'
                ? { color: 'var(--accent-fg)' }
                : undefined
            }
          >
            {subtitle}
          </div>
        )}
      </button>

      <div className="flex items-center gap-2 shrink-0">
        {callActive && (
          <span
            className="h-7 px-2.5 rounded-full text-[11px] font-medium inline-flex items-center gap-1.5 border border-hairline"
            style={{
              color: 'var(--accent-fg)',
              background:
                'color-mix(in srgb, var(--accent-fg) 12%, transparent)',
            }}
            title="В комнате идёт звонок"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            В звонке
          </span>
        )}

        {onVoiceCall && (
          <button
            type="button"
            onClick={onVoiceCall}
            disabled={callBusy}
            className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full transition-colors duration-ui disabled:opacity-40"
            title={
              isGroup
                ? 'Групповой звонок (Element Call)'
                : 'Аудиозвонок'
            }
            aria-label={isGroup ? 'Групповой звонок' : 'Аудиозвонок'}
          >
            <Phone className="w-4 h-4" strokeWidth={2} />
          </button>
        )}
        {onVideoCall && !isGroup && (
          <button
            type="button"
            onClick={onVideoCall}
            disabled={callBusy}
            className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full transition-colors duration-ui disabled:opacity-40"
            title="Видеозвонок"
            aria-label="Видеозвонок"
          >
            <Video className="w-4 h-4" strokeWidth={2} />
          </button>
        )}

        {isGroup && (
          <button
            type="button"
            onClick={onOpenProfile}
            className="tg-icon-btn h-8 px-3 flex items-center justify-center gap-2 rounded-full transition-colors duration-ui"
            title="Участники"
            aria-label="Участники"
          >
            <Users className="w-4 h-4" />
            <span className="text-[12px] tabular-nums font-medium leading-none">
              {memberCount}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onToggleSearch}
          className={clsx(
            'w-8 h-8 flex items-center justify-center rounded-full transition-colors duration-ui',
            chatSearchOpen ? 'tg-icon-btn--active' : 'tg-icon-btn',
          )}
          title="Поиск в этом чате (⌘F)"
          aria-label="Поиск в этом чате"
          aria-pressed={chatSearchOpen}
        >
          <Search className="w-4 h-4 block" strokeWidth={2} />
        </button>
        {showDecrypt && (
          <button
            type="button"
            onClick={onOpenDecrypt}
            className="tg-link h-8 px-2 flex items-center text-[12px] hover:underline"
          >
            Decrypt
          </button>
        )}
      </div>
    </div>
  )
}

export function formatTypingLabel(
  names: string[],
  isDirect: boolean,
): string | null {
  if (!names.length) return null
  if (isDirect || names.length === 1) {
    return isDirect ? 'печатает…' : `${names[0]} печатает…`
  }
  if (names.length === 2) {
    return `${names[0]} и ${names[1]} печатают…`
  }
  return `${names[0]} и ещё ${names.length - 1} печатают…`
}
