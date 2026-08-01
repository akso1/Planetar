import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { ArrowLeft, BookmarkPlus, CheckSquare, Copy, Forward, Pencil, Pin, PinOff, Plus, Quote, Reply, Search, Trash2 } from 'lucide-react'
import {
  clampMenuPosition,
  type MenuPos,
} from '@/shared/lib/clampMenuPosition'
import { TwemojiImg } from '@/shared/ui/twemoji'

export const QUICK_CONTEXT_REACTIONS = ['👍', '❤️', '🔥', '😂', '😢'] as const

type EmojiEntry = { emoji: string; keywords: string }

/** Popular emoji grid with search keywords (ru/en) */
export const ALL_CONTEXT_EMOJIS: EmojiEntry[] = [
  { emoji: '👍', keywords: 'like thumb up лайк плюс' },
  { emoji: '👎', keywords: 'dislike thumb down дизлайк минус' },
  { emoji: '❤️', keywords: 'heart love сердце любовь' },
  { emoji: '🔥', keywords: 'fire огонь огнь круто' },
  { emoji: '🥰', keywords: 'love smile hearts влюблен' },
  { emoji: '👏', keywords: 'clap applause аплодисменты' },
  { emoji: '😁', keywords: 'grin smile улыбка радость' },
  { emoji: '🤔', keywords: 'thinking думаю хм' },
  { emoji: '🤯', keywords: 'mind blown шок взрыв' },
  { emoji: '😱', keywords: 'scream fear ужас крик' },
  { emoji: '🤬', keywords: 'angry swear злость мат' },
  { emoji: '😢', keywords: 'cry sad слезы грусть' },
  { emoji: '🎉', keywords: 'party confetti праздник ура' },
  { emoji: '🤩', keywords: 'star eyes восторг' },
  { emoji: '🤮', keywords: 'vomit тошнота фу' },
  { emoji: '💩', keywords: 'poop какашка' },
  { emoji: '🙏', keywords: 'pray thanks пожалуйста спасибо' },
  { emoji: '👌', keywords: 'ok okay окей' },
  { emoji: '🕊', keywords: 'dove peace голубь мир' },
  { emoji: '🤡', keywords: 'clown клоун' },
  { emoji: '🥱', keywords: 'yawn зевота скука' },
  { emoji: '🥴', keywords: 'woozy пьяный' },
  { emoji: '😍', keywords: 'heart eyes влюблен' },
  { emoji: '🐳', keywords: 'whale кит' },
  { emoji: '❤️‍🔥', keywords: 'heart on fire страсть' },
  { emoji: '🌚', keywords: 'moon лицо луна' },
  { emoji: '🌭', keywords: 'hotdog хотдог' },
  { emoji: '💯', keywords: 'hundred сто процент' },
  { emoji: '🤣', keywords: 'rofl смех ржу' },
  { emoji: '⚡', keywords: 'zap lightning молния' },
  { emoji: '🍌', keywords: 'banana банан' },
  { emoji: '🏆', keywords: 'trophy кубок победа' },
  { emoji: '💔', keywords: 'broken heart разбитое сердце' },
  { emoji: '🤨', keywords: 'raised eyebrow сомнение' },
  { emoji: '😐', keywords: 'neutral мех' },
  { emoji: '🍓', keywords: 'strawberry клубника' },
  { emoji: '🍾', keywords: 'champagne шампанское' },
  { emoji: '💋', keywords: 'kiss поцелуй' },
  { emoji: '🖕', keywords: 'middle finger фак' },
  { emoji: '😈', keywords: 'devil smile демон' },
  { emoji: '😴', keywords: 'sleep сон' },
  { emoji: '😭', keywords: 'sob плач реву' },
  { emoji: '🤓', keywords: 'nerd очкарик' },
  { emoji: '👻', keywords: 'ghost призрак' },
  { emoji: '👨‍💻', keywords: 'coder programmer разработчик' },
  { emoji: '👀', keywords: 'eyes глаза смотрю' },
  { emoji: '🎃', keywords: 'pumpkin halloween тыква' },
  { emoji: '🙈', keywords: 'see no evil обезьяна' },
  { emoji: '😇', keywords: 'angel innocent ангел' },
  { emoji: '😨', keywords: 'fearful страх' },
  { emoji: '🤝', keywords: 'handshake рукопожатие' },
  { emoji: '✍️', keywords: 'writing пишу' },
  { emoji: '🤗', keywords: 'hug обнимашки' },
  { emoji: '🫡', keywords: 'salute салют' },
  { emoji: '🎅', keywords: 'santa дед мороз' },
  { emoji: '🎄', keywords: 'tree christmas елка' },
  { emoji: '☃️', keywords: 'snowman снеговик' },
  { emoji: '💅', keywords: 'nails маникюр' },
  { emoji: '🤪', keywords: 'zany crazy безумный' },
  { emoji: '🗿', keywords: 'moai статуя' },
  { emoji: '🆒', keywords: 'cool круто' },
  { emoji: '💘', keywords: 'cupid стрела сердце' },
  { emoji: '🙉', keywords: 'hear no evil обезьяна' },
  { emoji: '🦄', keywords: 'unicorn единорог' },
  { emoji: '😘', keywords: 'kiss wink поцелуй' },
  { emoji: '💊', keywords: 'pill таблетка' },
  { emoji: '🙊', keywords: 'speak no evil обезьяна' },
  { emoji: '😎', keywords: 'cool sunglasses крутой' },
  { emoji: '👾', keywords: 'alien invader инопланетянин' },
  { emoji: '🤷‍♂️', keywords: 'shrug мужчина хз' },
  { emoji: '🤷', keywords: 'shrug хз незнаю' },
  { emoji: '🤷‍♀️', keywords: 'shrug женщина хз' },
  { emoji: '😡', keywords: 'rage angry злость' },
  { emoji: '😂', keywords: 'joy tears смех слезы' },
  { emoji: '✨', keywords: 'sparkles блеск' },
  { emoji: '💪', keywords: 'muscle сила' },
]

// Dedupe by emoji (last wins for keywords merge is fine; keep unique)
const EMOJI_LIST: EmojiEntry[] = (() => {
  const map = new Map<string, string>()
  for (const e of ALL_CONTEXT_EMOJIS) {
    map.set(e.emoji, `${map.get(e.emoji) ?? ''} ${e.keywords}`.trim())
  }
  return [...map.entries()].map(([emoji, keywords]) => ({ emoji, keywords }))
})()

export type MessageContextMenuProps = {
  x: number
  y: number
  isOwn: boolean
  canEdit: boolean
  canCopy: boolean
  canDelete: boolean
  /** May send `m.room.pinned_events` (pin for everyone) */
  canPinForEveryone?: boolean
  isPinnedForEveryone?: boolean
  isPinnedForSelf?: boolean
  canSaveGif?: boolean
  canForward?: boolean
  /** Selected text inside the message — enables «Цитировать» */
  quoteText?: string | null
  onClose: () => void
  onReply: () => void
  /** Reply with quoted selection (shown when quoteText is set) */
  onQuote?: () => void
  onForward?: () => void
  onSelect?: () => void
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
  onPinForEveryone?: () => void
  onUnpinForEveryone?: () => void
  onPinForSelf?: () => void
  onUnpinForSelf?: () => void
  onSaveGif?: () => void
  onReact: (emoji: string) => void
}

type Pos = MenuPos

export function MessageContextMenu({
  x,
  y,
  isOwn,
  canEdit,
  canCopy,
  canDelete,
  canPinForEveryone,
  isPinnedForEveryone,
  isPinnedForSelf,
  canSaveGif,
  canForward = true,
  quoteText,
  onClose,
  onReply,
  onQuote,
  onForward,
  onSelect,
  onEdit,
  onCopy,
  onDelete,
  onPinForEveryone,
  onUnpinForEveryone,
  onPinForSelf,
  onUnpinForSelf,
  onSaveGif,
  onReact,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<Pos>({ left: x, top: y })
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<'actions' | 'emoji' | 'pin' | 'unpin'>('actions')
  const [query, setQuery] = useState('')

  const showPinEntry =
    !!onPinForSelf ||
    !!onPinForEveryone ||
    !!onUnpinForSelf ||
    !!onUnpinForEveryone
  const pinnedAny = !!isPinnedForEveryone || !!isPinnedForSelf

  useLayoutEffect(() => {
    setReady(false)
    const el = menuRef.current
    if (!el) return

    const place = () => {
      const rect = el.getBoundingClientRect()
      // Cap height so tall emoji view still fits
      const maxH = (window.visualViewport?.height ?? window.innerHeight) - 20
      if (rect.height > maxH) {
        el.style.maxHeight = `${maxH}px`
      } else {
        el.style.maxHeight = ''
      }
      const size = el.getBoundingClientRect()
      setPos(clampMenuPosition(x, y, size.width, size.height))
      setReady(true)
    }

    place()
    // Re-measure after paint (fonts / emoji metrics)
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [x, y, view, query, canEdit, canCopy, canDelete, canSaveGif, isOwn, showPinEntry, pinnedAny, quoteText])

  useEffect(() => {
    if (view !== 'emoji') return
    const t = window.setTimeout(() => searchRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (view === 'emoji' || view === 'pin' || view === 'unpin') {
          setView('actions')
          setQuery('')
        } else {
          onClose()
        }
      }
    }
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const onScroll = (e: Event) => {
      // Don't close when scrolling inside the emoji palette
      if (menuRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const onResize = () => onClose()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [onClose, view])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return EMOJI_LIST
    return EMOJI_LIST.filter(
      (e) => e.emoji.includes(q) || e.keywords.toLowerCase().includes(q),
    )
  }, [query])

  const pick = (emoji: string) => {
    onReact(emoji)
    onClose()
  }

  const goBack = () => {
    setView('actions')
    setQuery('')
  }

  const handlePinClick = () => {
    if (pinnedAny) {
      const canUnpinRoom = !!isPinnedForEveryone && !!canPinForEveryone && !!onUnpinForEveryone
      const canUnpinSelf = !!isPinnedForSelf && !!onUnpinForSelf
      if (canUnpinRoom && canUnpinSelf) {
        setView('unpin')
        return
      }
      if (canUnpinRoom) {
        onUnpinForEveryone?.()
        onClose()
        return
      }
      if (canUnpinSelf) {
        onUnpinForSelf?.()
        onClose()
        return
      }
      return
    }

    const canEveryone = !!canPinForEveryone && !!onPinForEveryone
    const canSelf = !!onPinForSelf
    if (canEveryone && canSelf) {
      setView('pin')
      return
    }
    if (canEveryone) {
      onPinForEveryone?.()
      onClose()
      return
    }
    if (canSelf) {
      onPinForSelf?.()
      onClose()
    }
  }

  const pinLabel = pinnedAny ? 'Открепить' : 'Закрепить'
  const pinIcon = pinnedAny ? (
    <PinOff className="w-4 h-4" />
  ) : (
    <Pin className="w-4 h-4" />
  )
  const canShowPinAction =
    showPinEntry &&
    (!pinnedAny ||
      (!!isPinnedForEveryone && !!canPinForEveryone && !!onUnpinForEveryone) ||
      (!!isPinnedForSelf && !!onUnpinForSelf))

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={clsx(
        'tg-ctx-menu fixed z-[1000] rounded-xl border border-white/12',
        'bg-[#1c2733]/92 shadow-2xl shadow-black/50 backdrop-blur-xl overflow-hidden',
        view === 'emoji' ? 'w-[280px]' : 'min-w-[220px] w-[240px]',
      )}
      style={{
        left: pos.left,
        top: pos.top,
        visibility: ready ? 'visible' : 'hidden',
        overflowY: view === 'emoji' ? 'auto' : undefined,
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view === 'actions' ? (
        <div key="actions" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-0.5 px-2 pt-2 pb-1.5">
            {QUICK_CONTEXT_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="menuitem"
                className="flex-1 h-9 rounded-lg text-[18px] hover:bg-white/10 active:scale-95 transition-colors inline-flex items-center justify-center"
                onClick={() => pick(emoji)}
                title={emoji}
              >
                <TwemojiImg emoji={emoji} />
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="w-9 h-9 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Все реакции"
              title="Все реакции"
              onClick={(e) => {
                e.stopPropagation()
                setView('emoji')
              }}
            >
              <Plus className="w-4 h-4" strokeWidth={2.25} />
            </button>
          </div>

          <div className="mx-2 h-px bg-white/10" />

          <div className="py-1.5 px-1.5">
            {quoteText && onQuote && (
              <MenuItem
                icon={<Quote className="w-4 h-4" />}
                label="Цитировать"
                onClick={() => {
                  onQuote()
                  onClose()
                }}
              />
            )}
            <MenuItem
              icon={<Reply className="w-4 h-4" />}
              label="Ответить"
              onClick={() => {
                onReply()
                onClose()
              }}
            />
            {canForward && onForward && (
              <MenuItem
                icon={<Forward className="w-4 h-4" />}
                label="Переслать"
                onClick={() => {
                  onForward()
                  onClose()
                }}
              />
            )}
            {onSelect && (
              <MenuItem
                icon={<CheckSquare className="w-4 h-4" />}
                label="Выбрать"
                onClick={() => {
                  onSelect()
                  onClose()
                }}
              />
            )}
            {isOwn && canEdit && (
              <MenuItem
                icon={<Pencil className="w-4 h-4" />}
                label="Редактировать"
                onClick={() => {
                  onEdit()
                  onClose()
                }}
              />
            )}
            {canCopy && (
              <MenuItem
                icon={<Copy className="w-4 h-4" />}
                label="Копировать текст"
                onClick={() => {
                  onCopy()
                  onClose()
                }}
              />
            )}
            {canShowPinAction && (
              <MenuItem
                icon={pinIcon}
                label={pinLabel}
                onClick={handlePinClick}
              />
            )}
            {canSaveGif && onSaveGif && (
              <MenuItem
                icon={<BookmarkPlus className="w-4 h-4" />}
                label="Сохранить GIF"
                onClick={() => {
                  onSaveGif()
                  onClose()
                }}
              />
            )}
            {isOwn && canDelete && (
              <>
                <div className="mx-1 my-1 h-px bg-white/10" />
                <MenuItem
                  icon={<Trash2 className="w-4 h-4" />}
                  label="Удалить"
                  danger
                  onClick={() => {
                    onDelete()
                    onClose()
                  }}
                />
              </>
            )}
          </div>
        </div>
      ) : view === 'pin' ? (
        <div key="pin" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Назад"
              title="Назад"
              onClick={goBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-medium text-white/80">Закрепить</span>
          </div>
          <div className="mx-2 h-px bg-white/10" />
          <div className="py-1.5 px-1.5">
            {canPinForEveryone && onPinForEveryone && (
              <MenuItem
                icon={<Pin className="w-4 h-4" />}
                label="Для всех"
                onClick={() => {
                  onPinForEveryone()
                  onClose()
                }}
              />
            )}
            {onPinForSelf && (
              <MenuItem
                icon={<Pin className="w-4 h-4" />}
                label="Для себя"
                onClick={() => {
                  onPinForSelf()
                  onClose()
                }}
              />
            )}
          </div>
        </div>
      ) : view === 'unpin' ? (
        <div key="unpin" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Назад"
              title="Назад"
              onClick={goBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-medium text-white/80">Открепить</span>
          </div>
          <div className="mx-2 h-px bg-white/10" />
          <div className="py-1.5 px-1.5">
            {canPinForEveryone && isPinnedForEveryone && onUnpinForEveryone && (
              <MenuItem
                icon={<PinOff className="w-4 h-4" />}
                label="Для всех"
                onClick={() => {
                  onUnpinForEveryone()
                  onClose()
                }}
              />
            )}
            {isPinnedForSelf && onUnpinForSelf && (
              <MenuItem
                icon={<PinOff className="w-4 h-4" />}
                label="Для себя"
                onClick={() => {
                  onUnpinForSelf()
                  onClose()
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <div key="emoji" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Назад"
              title="Назад"
              onClick={goBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="relative flex-1 min-w-0">
              <span
                className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center justify-center"
                aria-hidden
              >
                <Search
                  className="block w-3.5 h-3.5 text-white/35"
                  strokeWidth={2}
                />
              </span>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск"
                className="w-full h-8 rounded-lg bg-black/30 border border-white/10 pl-8 pr-2.5 text-[13px] leading-none text-white/90 placeholder:text-white/35 outline-none focus:border-white/20"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    goBack()
                  }
                }}
              />
            </div>
          </div>

          <div className="tg-ctx-emoji-scroll max-h-60 overflow-y-auto px-2 pb-2">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-[12.5px] text-white/40">
                Ничего не найдено
              </div>
            ) : (
              <div className="grid grid-cols-6 gap-1">
                {filtered.map(({ emoji }) => (
                  <button
                    key={emoji}
                    type="button"
                    className="aspect-square flex items-center justify-center rounded-lg text-2xl leading-none hover:bg-white/10 active:scale-95 transition-colors"
                    onClick={() => pick(emoji)}
                    title={emoji}
                  >
                    <TwemojiImg emoji={emoji} className="tg-twemoji tg-twemoji--lg" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] text-left transition-colors',
        danger
          ? 'text-red-400 hover:bg-red-500/15'
          : 'text-white/90 hover:bg-white/10',
      )}
    >
      <span className={clsx('shrink-0', danger ? 'text-red-400' : 'text-white/55')}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
}
