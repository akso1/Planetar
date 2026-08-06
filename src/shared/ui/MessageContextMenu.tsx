import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import {
  ArrowLeft,
  Ban,
  BookmarkPlus,
  CheckSquare,
  ChevronRight,
  ClipboardList,
  Copy,
  Forward,
  ListPlus,
  MessagesSquare,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Quote,
  Reply,
  Search,
  Trash2,
  UserX,
} from 'lucide-react'
import {
  clampMenuPosition,
  type MenuPos,
} from '@/shared/lib/clampMenuPosition'
import {
  useBizTasksStore,
  type BizTaskLinkKind,
  type BizTaskMessageRef,
} from '@/shared/lib/bizTasks'
import {
  ALL_CONTEXT_EMOJIS,
  QUICK_CONTEXT_REACTIONS,
} from '@/shared/lib/contextEmojis'
import { TwemojiImg } from '@/shared/ui/twemoji'

export { ALL_CONTEXT_EMOJIS, QUICK_CONTEXT_REACTIONS }

type EmojiEntry = { emoji: string; keywords: string }

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
  canKickSender?: boolean
  canBanSender?: boolean
  /** Selected text inside the message — enables «Цитировать» */
  quoteText?: string | null
  onClose: () => void
  onReply: () => void
  /** Open MSC3440 thread panel for this message */
  onReplyInThread?: () => void
  /** Reply with quoted selection (shown when quoteText is set) */
  onQuote?: () => void
  onForward?: () => void
  onSelect?: () => void
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
  onKickSender?: () => void
  onBanSender?: () => void
  onPinForEveryone?: () => void
  onUnpinForEveryone?: () => void
  onPinForSelf?: () => void
  onUnpinForSelf?: () => void
  onSaveGif?: () => void
  onReact: (emoji: string) => void
  /** When set, shows BizDev task actions for this message */
  bizTaskRef?: BizTaskMessageRef | null
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
  canKickSender = false,
  canBanSender = false,
  quoteText,
  onClose,
  onReply,
  onReplyInThread,
  onQuote,
  onForward,
  onSelect,
  onEdit,
  onCopy,
  onDelete,
  onKickSender,
  onBanSender,
  onPinForEveryone,
  onUnpinForEveryone,
  onPinForSelf,
  onUnpinForSelf,
  onSaveGif,
  onReact,
  bizTaskRef,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const taskSearchRef = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState<Pos>({ left: x, top: y })
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<
    'actions' | 'emoji' | 'pin' | 'unpin' | 'addRequest' | 'addReply'
  >('actions')
  const [query, setQuery] = useState('')
  const [taskQuery, setTaskQuery] = useState('')
  const tasks = useBizTasksStore((s) => s.tasks)
  const createTaskFromMessage = useBizTasksStore((s) => s.createTaskFromMessage)
  const addMessageToTask = useBizTasksStore((s) => s.addMessageToTask)
  const hydrateTasks = useBizTasksStore((s) => s.hydrate)
  const showTaskActions = !!bizTaskRef?.eventId

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
  }, [
    x,
    y,
    view,
    query,
    taskQuery,
    canEdit,
    canCopy,
    canDelete,
    canSaveGif,
    isOwn,
    showPinEntry,
    pinnedAny,
    quoteText,
    showTaskActions,
    tasks.length,
  ])

  useEffect(() => {
    if (view !== 'emoji') return
    const t = window.setTimeout(() => searchRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [view])

  useEffect(() => {
    if (view !== 'addRequest' && view !== 'addReply') return
    hydrateTasks()
    const t = window.setTimeout(() => taskSearchRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [view, hydrateTasks])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (
          view === 'emoji' ||
          view === 'pin' ||
          view === 'unpin' ||
          view === 'addRequest' ||
          view === 'addReply'
        ) {
          setView('actions')
          setQuery('')
          setTaskQuery('')
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

  const filteredTasks = useMemo(() => {
    const activeOnly = tasks.filter((t) => t.status !== 'archived')
    const q = taskQuery.trim().toLowerCase()
    if (!q) return activeOnly
    return activeOnly.filter(
      (t) =>
        t.tag.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.links.some((l) => l.body.toLowerCase().includes(q)),
    )
  }, [tasks, taskQuery])

  const pick = (emoji: string) => {
    onReact(emoji)
    onClose()
  }

  const goBack = () => {
    setView('actions')
    setQuery('')
    setTaskQuery('')
  }

  const openTaskPicker = (kind: BizTaskLinkKind) => {
    hydrateTasks()
    setTaskQuery('')
    setView(kind === 'reply' ? 'addReply' : 'addRequest')
  }

  const handleCreateTask = () => {
    if (!bizTaskRef) return
    createTaskFromMessage(bizTaskRef)
    onClose()
  }

  const handlePickTask = (taskId: string, kind: BizTaskLinkKind) => {
    if (!bizTaskRef) return
    addMessageToTask(taskId, kind, bizTaskRef)
    onClose()
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
        'tg-ctx-menu fixed z-[1000] rounded-xl border border-hairline',
        'bg-[var(--menu-surface-solid)] overflow-hidden',
        'animate-[tg-ctx-pop_160ms_cubic-bezier(0.22,1,0.36,1)_both]',
        view === 'emoji'
          ? 'w-[300px]'
          : view === 'addRequest' || view === 'addReply'
            ? 'w-[280px]'
            : 'min-w-[220px] w-[240px]',
      )}
      style={{
        left: pos.left,
        top: pos.top,
        visibility: ready ? 'visible' : 'hidden',
        overflowY:
          view === 'emoji' || view === 'addRequest' || view === 'addReply'
            ? 'auto'
            : undefined,
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
                className="flex-1 h-9 rounded-lg text-[18px] hover:bg-surface-inset active:scale-95 transition-colors inline-flex items-center justify-center"
                onClick={() => pick(emoji)}
                title={emoji}
              >
                <TwemojiImg emoji={emoji} />
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="w-9 h-9 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
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

          <div className="mx-2 h-px bg-surface-inset" />

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
            {onReplyInThread && (
              <MenuItem
                icon={<MessagesSquare className="w-4 h-4" />}
                label="Ответить в ветке"
                onClick={() => {
                  onReplyInThread()
                  onClose()
                }}
              />
            )}
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
                label={quoteText ? 'Копировать выделенное' : 'Копировать текст'}
                onClick={() => {
                  onCopy()
                  onClose()
                }}
              />
            )}
            {showTaskActions && (
              <>
                <div className="mx-1 my-1 h-px bg-surface-inset" />
                <MenuItem
                  icon={<ClipboardList className="w-4 h-4" />}
                  label="Создать задачу"
                  onClick={handleCreateTask}
                />
                <MenuItem
                  icon={<ListPlus className="w-4 h-4" />}
                  label="Добавить к задаче…"
                  trailing={<ChevronRight className="w-3.5 h-3.5 text-ink-muted" />}
                  onClick={() => openTaskPicker('request')}
                />
                <MenuItem
                  icon={<MessageSquareReply className="w-4 h-4" />}
                  label="Добавить как ответ в задачу…"
                  trailing={<ChevronRight className="w-3.5 h-3.5 text-ink-muted" />}
                  onClick={() => openTaskPicker('reply')}
                />
              </>
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
                <div className="mx-1 my-1 h-px bg-surface-inset" />
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
            {!isOwn && (canKickSender || canBanSender) && (
              <>
                <div className="mx-1 my-1 h-px bg-surface-inset" />
                {canKickSender && onKickSender && (
                  <MenuItem
                    icon={<UserX className="w-4 h-4" />}
                    label="Исключить из чата"
                    danger
                    onClick={() => {
                      onKickSender()
                      onClose()
                    }}
                  />
                )}
                {canBanSender && onBanSender && (
                  <MenuItem
                    icon={<Ban className="w-4 h-4" />}
                    label="Заблокировать"
                    danger
                    onClick={() => {
                      onBanSender()
                      onClose()
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      ) : view === 'pin' ? (
        <div key="pin" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
              aria-label="Назад"
              title="Назад"
              onClick={goBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-medium text-ink">Закрепить</span>
          </div>
          <div className="mx-2 h-px bg-surface-inset" />
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
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
              aria-label="Назад"
              title="Назад"
              onClick={goBack}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-medium text-ink">Открепить</span>
          </div>
          <div className="mx-2 h-px bg-surface-inset" />
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
      ) : view === 'addRequest' || view === 'addReply' ? (
        <div key={view} className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
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
                  className="block w-3.5 h-3.5 text-ink-muted"
                  strokeWidth={2}
                />
              </span>
              <input
                ref={taskSearchRef}
                type="text"
                value={taskQuery}
                onChange={(e) => setTaskQuery(e.target.value)}
                placeholder={
                  view === 'addReply' ? 'Ответ в задачу…' : 'Добавить к задаче…'
                }
                className="tg-ctx-field w-full h-8 rounded-lg pl-8 pr-2.5 text-[13px] leading-none"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    goBack()
                  }
                }}
              />
            </div>
          </div>
          <div className="mx-2 h-px bg-surface-inset" />
          <div className="max-h-56 overflow-y-auto py-1.5 px-1.5">
            {filteredTasks.length === 0 ? (
              <div className="py-6 px-2 text-center text-[12.5px] text-ink-faint">
                {tasks.filter((t) => t.status !== 'archived').length === 0
                  ? 'Нет задач. Создайте первую.'
                  : 'Ничего не найдено'}
              </div>
            ) : (
              filteredTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  role="menuitem"
                  className="flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-inset"
                  onClick={() =>
                    handlePickTask(
                      task.id,
                      view === 'addReply' ? 'reply' : 'request',
                    )
                  }
                >
                  <span className="text-[12px] font-semibold text-[color:var(--accent)]">
                    #{task.tag}
                  </span>
                  <span className="text-[13px] text-ink line-clamp-2">
                    {task.title}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <div key="emoji" className="animate-[tg-ctx-fade_120ms_ease-out]">
          <div className="flex items-center gap-1.5 px-2 pt-2 pb-1.5">
            <button
              type="button"
              className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
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
                  className="block w-3.5 h-3.5 text-ink-muted"
                  strokeWidth={2}
                />
              </span>
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск"
                className="tg-ctx-field w-full h-8 rounded-lg pl-8 pr-2.5 text-[13px] leading-none"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    goBack()
                  }
                }}
              />
            </div>
          </div>

          <div className="tg-ctx-emoji-scroll max-h-72 overflow-y-auto px-2 pb-2">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-[12.5px] text-ink-faint">
                Ничего не найдено
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-0.5">
                {filtered.map(({ emoji }) => (
                  <button
                    key={emoji}
                    type="button"
                    className="aspect-square flex items-center justify-center rounded-lg text-2xl leading-none hover:bg-surface-inset active:scale-95 transition-colors"
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
  trailing,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  trailing?: React.ReactNode
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
          : 'text-ink hover:bg-surface-inset',
      )}
    >
      <span className={clsx('shrink-0', danger ? 'text-red-400' : 'text-ink-muted')}>
        {icon}
      </span>
      <span className="flex-1 min-w-0">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  )
}
