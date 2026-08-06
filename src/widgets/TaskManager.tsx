import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  Clock3,
  MessageSquareReply,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  BIZ_TASK_STATUSES,
  BIZ_TASK_STATUS_LABEL,
  collectReplyRoomNames,
  filterBizTasks,
  normalizeBizTaskListStatus,
  normalizeBizTaskStatus,
  useBizTasksStore,
  type BizTask,
  type BizTaskLinkedMessage,
  type BizTaskListTab,
  type BizTaskStatus,
} from '@/shared/lib/bizTasks'
import { usePanelLayoutStore } from '@/shared/lib/panelLayout'
import { useRoomStore } from '@/entities/session/model/room.store'

/** Soft glass tint + left rail — matches app accent-soft pattern. */
function statusTone(status: BizTaskStatus): {
  fg: string
  soft: string
  border: string
} {
  switch (status) {
    case 'done':
      return {
        fg: 'var(--status-done)',
        soft: 'var(--status-done-soft)',
        border: 'var(--status-done-border)',
      }
    case 'waiting':
      return {
        fg: 'var(--status-waiting)',
        soft: 'var(--status-waiting-soft)',
        border: 'var(--status-waiting-border)',
      }
    case 'no_offers':
      return {
        fg: 'var(--status-alert)',
        soft: 'var(--status-alert-soft)',
        border: 'var(--status-alert-border)',
      }
    case 'active':
    default:
      return {
        fg: 'var(--accent)',
        soft: 'var(--accent-softer)',
        border: 'var(--accent-border)',
      }
  }
}

function StatusIcon({
  status,
  className,
}: {
  status: BizTaskStatus
  className?: string
}) {
  const cn = className ?? 'w-3.5 h-3.5'
  switch (status) {
    case 'done':
      return <CheckCircle2 className={cn} strokeWidth={2} />
    case 'waiting':
      return <Clock3 className={cn} strokeWidth={2} />
    case 'no_offers':
      return <TriangleAlert className={cn} strokeWidth={2} />
    case 'active':
    default:
      return <CircleDashed className={cn} strokeWidth={2} />
  }
}

function StatusChip({ status }: { status: BizTaskStatus }) {
  const tone = statusTone(status)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: tone.fg,
        background: tone.soft,
        boxShadow: `inset 0 0 0 1px ${tone.border}`,
      }}
    >
      <StatusIcon status={status} className="w-3 h-3" />
      {BIZ_TASK_STATUS_LABEL[status]}
    </span>
  )
}

export function TaskManager() {
  const tasks = useBizTasksStore((s) => s.tasks)
  const selectedTaskId = useBizTasksStore((s) => s.selectedTaskId)
  const selectTask = useBizTasksStore((s) => s.selectTask)
  const deleteTask = useBizTasksStore((s) => s.deleteTask)
  const archiveTask = useBizTasksStore((s) => s.archiveTask)
  const restoreTask = useBizTasksStore((s) => s.restoreTask)
  const setTaskStatus = useBizTasksStore((s) => s.setTaskStatus)
  const setPanelOpen = useBizTasksStore((s) => s.setPanelOpen)
  const hydrate = useBizTasksStore((s) => s.hydrate)
  const chatListWidth = usePanelLayoutStore((s) => s.chatListWidth)
  const openRoomAtEvent = useRoomStore((s) => s.actions.openRoomAtEvent)

  const [listTab, setListTab] = useState<BizTaskListTab>('active')
  const [query, setQuery] = useState('')
  const [roomFilter, setRoomFilter] = useState('')

  useEffect(() => {
    hydrate()
  }, [hydrate])

  const activeCount = useMemo(
    () =>
      tasks.filter((t) => normalizeBizTaskListStatus(t.status) === 'active')
        .length,
    [tasks],
  )
  const archivedCount = useMemo(
    () =>
      tasks.filter((t) => normalizeBizTaskListStatus(t.status) === 'archived')
        .length,
    [tasks],
  )

  const roomOptions = useMemo(() => collectReplyRoomNames(tasks), [tasks])

  const filtered = useMemo(
    () =>
      filterBizTasks(tasks, {
        list: listTab,
        query,
        roomName: roomFilter,
      }),
    [tasks, listTab, query, roomFilter],
  )

  const selected: BizTask | null = useMemo(() => {
    if (selectedTaskId) {
      const hit = filtered.find((t) => t.id === selectedTaskId)
      if (hit) return hit
      // Keep selection if task exists but filtered out? Prefer visible list.
      const raw = tasks.find((t) => t.id === selectedTaskId)
      if (raw && normalizeBizTaskListStatus(raw.status) === listTab) {
        return null
      }
    }
    return filtered[0] ?? null
  }, [selectedTaskId, filtered, tasks, listTab])

  useEffect(() => {
    if (!selected) {
      if (selectedTaskId) selectTask(null)
      return
    }
    if (selectedTaskId !== selected.id) selectTask(selected.id)
  }, [selected, selectedTaskId, selectTask])

  // Drop room filter if it disappeared
  useEffect(() => {
    if (roomFilter && !roomOptions.includes(roomFilter)) {
      setRoomFilter('')
    }
  }, [roomFilter, roomOptions])

  const selectedPipeline = selected
    ? normalizeBizTaskStatus(selected.pipelineStatus)
    : 'active'
  const selectedTone = statusTone(selectedPipeline)
  const selectedList = selected
    ? normalizeBizTaskListStatus(selected.status)
    : 'active'

  const requests = selected?.links.filter((l) => l.kind === 'request') ?? []
  const replies = selected?.links.filter((l) => l.kind === 'reply') ?? []

  const openLinkedMessage = (link: BizTaskLinkedMessage) => {
    if (!link.roomId || !link.eventId) return
    setPanelOpen(false)
    openRoomAtEvent(link.roomId, link.eventId)
  }

  const switchTab = (tab: BizTaskListTab) => {
    setListTab(tab)
    selectTask(null)
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      <aside
        className="tg-chatlist relative shrink-0 flex flex-col border-r min-h-0"
        style={{ width: chatListWidth }}
      >
        <div className="shrink-0 px-3 pt-3 pb-2 border-b border-hairline space-y-2.5">
          <div className="flex items-center gap-2">
            <ClipboardList
              className="w-4 h-4 text-[color:var(--accent)]"
              strokeWidth={1.75}
            />
            <h2 className="text-[15px] font-semibold text-ink flex-1">
              Задачи
            </h2>
            <button
              type="button"
              className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
              title="Закрыть"
              aria-label="Закрыть"
              onClick={() => setPanelOpen(false)}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            className="flex p-0.5 rounded-xl border border-hairline"
            style={{ background: 'var(--segment-track)' }}
            role="tablist"
            aria-label="Список задач"
          >
            {(
              [
                { id: 'active', label: 'Активные', count: activeCount },
                { id: 'archived', label: 'Архив', count: archivedCount },
              ] as const
            ).map((tab) => {
              const on = listTab === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => switchTab(tab.id)}
                  className={clsx(
                    'flex-1 h-8 rounded-[10px] text-[12.5px] font-medium transition-colors',
                    on
                      ? 'text-ink bg-[var(--surface-glass-strong)] shadow-sm'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {tab.label}
                  {tab.count > 0 ? (
                    <span className="ml-1 text-ink-faint">{tab.count}</span>
                  ) : null}
                </button>
              )
            })}
          </div>

          <div className="space-y-1.5">
            <div className="relative">
              <span
                className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center"
                aria-hidden
              >
                <Search
                  className="w-3.5 h-3.5 text-ink-muted"
                  strokeWidth={2}
                />
              </span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по ID или названию"
                className="w-full h-9 rounded-xl pl-9 pr-3 text-[13px] bg-[var(--surface-inset)] text-ink placeholder:text-ink-faint border border-hairline outline-none focus:border-[color:var(--accent)]"
              />
            </div>

            <select
              value={roomFilter}
              onChange={(e) => setRoomFilter(e.target.value)}
              className="w-full h-9 rounded-xl px-3 text-[13px] bg-[var(--surface-inset)] text-ink border border-hairline outline-none focus:border-[color:var(--accent)]"
              aria-label="Фильтр по чату ответов"
              title="Чат с ответами"
            >
              <option value="">Все чаты (ответы)</option>
              {roomOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-[13px] text-ink-faint">
              {listTab === 'archived'
                ? archivedCount === 0
                  ? 'Архив пуст'
                  : 'Ничего не найдено'
                : tasks.length === 0
                  ? 'ПКМ по сообщению → «Создать задачу»'
                  : 'Ничего не найдено'}
            </div>
          ) : (
            filtered.map((task) => {
              const pipeline = normalizeBizTaskStatus(task.pipelineStatus)
              const tone = statusTone(pipeline)
              const replyCount = task.links.filter(
                (l) => l.kind === 'reply',
              ).length
              const active = selected?.id === task.id
              return (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => selectTask(task.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2.5 transition-colors border-l-2',
                    active
                      ? 'bg-[var(--hover-surface)]'
                      : 'hover:bg-[var(--hover-surface)]',
                  )}
                  style={{
                    borderLeftColor: tone.fg,
                    background: active
                      ? `color-mix(in srgb, ${tone.soft} 70%, var(--hover-surface))`
                      : undefined,
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="text-[12px] font-semibold shrink-0"
                      style={{ color: tone.fg }}
                    >
                      #{task.tag}
                    </span>
                    <StatusChip status={pipeline} />
                    {replyCount > 0 && (
                      <span className="text-[11px] text-ink-faint ml-auto shrink-0">
                        {replyCount} отв.
                      </span>
                    )}
                  </div>
                  <p
                    className={clsx(
                      'mt-1 text-[13.5px] line-clamp-2 leading-snug',
                      pipeline === 'done' ? 'text-ink-muted' : 'text-ink',
                    )}
                  >
                    {task.title}
                  </p>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <section className="tg-main relative flex-1 min-w-0 flex flex-col overflow-hidden bg-chatBg">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center tg-chat-bg">
            <p className="text-ink-faint text-[15px]">
              Выберите задачу слева
            </p>
          </div>
        ) : (
          <>
            <header
              className="shrink-0 px-5 py-4 border-b border-hairline backdrop-blur-md"
              style={{
                background: `color-mix(in srgb, ${selectedTone.soft} 55%, var(--surface-glass))`,
                boxShadow: `inset 3px 0 0 ${selectedTone.fg}`,
              }}
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-[12px] font-semibold tracking-wide"
                      style={{ color: selectedTone.fg }}
                    >
                      #{selected.tag}
                    </span>
                    <StatusChip status={selectedPipeline} />
                    {selectedList === 'archived' && (
                      <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-muted bg-[var(--surface-inset)]">
                        <Archive className="w-3 h-3" />
                        Архив
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1 text-[17px] font-semibold text-ink leading-snug">
                    {selected.title}
                  </h3>
                  <p className="mt-1 text-[12px] text-ink-faint">
                    Создано{' '}
                    {format(selected.createdAt, 'd MMM yyyy, HH:mm', {
                      locale: ru,
                    })}
                    {' · '}
                    {selected.links.length} привязок
                  </p>
                </div>

                <div className="shrink-0 flex items-center gap-1">
                  {selectedList === 'archived' ? (
                    <button
                      type="button"
                      className="h-9 px-3 inline-flex items-center gap-1.5 rounded-xl text-[13px] text-[color:var(--accent)] hover:bg-[var(--accent-softer)] transition-colors"
                      title="Вернуть из архива"
                      onClick={() => {
                        restoreTask(selected.id)
                        setListTab('active')
                      }}
                    >
                      <ArchiveRestore className="w-3.5 h-3.5" />
                      Из архива
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="h-9 px-3 inline-flex items-center gap-1.5 rounded-xl text-[13px] text-ink-muted hover:text-ink hover:bg-[var(--hover-surface)] transition-colors"
                      title="В архив"
                      onClick={() => {
                        archiveTask(selected.id)
                        setListTab('archived')
                        selectTask(selected.id)
                      }}
                    >
                      <Archive className="w-3.5 h-3.5" />
                      В архив
                    </button>
                  )}
                  <button
                    type="button"
                    className="h-9 px-3 inline-flex items-center gap-1.5 rounded-xl text-[13px] text-[color:var(--status-alert)] hover:bg-[var(--status-alert-soft)] transition-colors"
                    title="Удалить задачу навсегда"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Удалить задачу #${selected.tag} навсегда?`,
                        )
                      ) {
                        deleteTask(selected.id)
                      }
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Удалить
                  </button>
                </div>
              </div>

              <div
                className="mt-3 flex flex-wrap gap-1.5 p-1 rounded-xl border border-hairline"
                style={{ background: 'var(--surface-inset)' }}
                role="group"
                aria-label="Статус задачи"
              >
                {BIZ_TASK_STATUSES.map((status) => {
                  const tone = statusTone(status)
                  const isOn = selectedPipeline === status
                  return (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setTaskStatus(selected.id, status)}
                      className={clsx(
                        'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
                        isOn ? 'text-ink' : 'text-ink-muted hover:text-ink',
                      )}
                      style={
                        isOn
                          ? {
                              color: tone.fg,
                              background: 'var(--surface-glass-strong)',
                              boxShadow: `inset 0 0 0 1px ${tone.border}`,
                            }
                          : undefined
                      }
                      title={BIZ_TASK_STATUS_LABEL[status]}
                    >
                      <StatusIcon status={status} />
                      {BIZ_TASK_STATUS_LABEL[status]}
                    </button>
                  )
                })}
              </div>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
              {requests.length > 0 && (
                <div>
                  <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted mb-2">
                    Исходные сообщения
                  </h4>
                  <div className="space-y-2">
                    {requests.map((link) => (
                      <LinkCard
                        key={link.id}
                        link={link}
                        onOpenMessage={() => openLinkedMessage(link)}
                      />
                    ))}
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted mb-2">
                  Ответы
                </h4>
                {replies.length === 0 ? (
                  <div className="rounded-2xl border border-hairline bg-[var(--surface-glass)] px-4 py-8 text-center text-[13px] text-ink-faint">
                    Пока нет ответов. ПКМ по сообщению → «Добавить как ответ
                    в задачу…»
                  </div>
                ) : (
                  <div className="space-y-2">
                    {replies.map((link) => (
                      <LinkCard
                        key={link.id}
                        link={link}
                        onOpenMessage={() => openLinkedMessage(link)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function LinkCard({
  link,
  onOpenMessage,
}: {
  link: BizTaskLinkedMessage
  onOpenMessage: () => void
}) {
  const isReply = link.kind === 'reply'
  return (
    <button
      type="button"
      onClick={onOpenMessage}
      title="Перейти к сообщению"
      className={clsx(
        'w-full text-left rounded-2xl border border-hairline px-3.5 py-3',
        'bg-[var(--surface-glass)] backdrop-blur-md',
        'transition-colors hover:bg-[var(--hover-surface)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]',
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className={clsx(
            'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            isReply
              ? 'bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-[color:var(--accent)]'
              : 'bg-[var(--surface-inset)] text-ink-muted',
          )}
        >
          {isReply ? (
            <MessageSquareReply className="w-3 h-3" />
          ) : (
            <Send className="w-3 h-3" />
          )}
          {isReply ? 'Ответ' : 'Сообщение'}
        </span>
        <span className="text-[12px] text-[color:var(--accent)] truncate">
          {link.roomName}
        </span>
        <span className="ml-auto text-[11px] text-ink-faint shrink-0">
          {format(link.ts, 'd MMM, HH:mm', { locale: ru })}
        </span>
      </div>
      {link.senderName && (
        <div className="text-[12px] text-ink-muted mb-1 truncate">
          {link.senderName}
        </div>
      )}
      <p className="text-[13.5px] text-ink whitespace-pre-wrap break-words leading-relaxed">
        {link.body}
      </p>
    </button>
  )
}
