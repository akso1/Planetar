import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import { ru } from 'date-fns/locale'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'

type TimelineDateJumpPopoverProps = {
  open: boolean
  /** Currently shown sticky / separator day */
  selectedTs: number | null
  /** Days (startOfDay ms) that have messages in the loaded window */
  daysWithMessages: Set<number>
  loading?: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onSelectDay: (dayStartMs: number) => void
}

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

export function TimelineDateJumpPopover({
  open,
  selectedTs,
  daysWithMessages,
  loading = false,
  anchorRef,
  onClose,
  onSelectDay,
}: TimelineDateJumpPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [month, setMonth] = React.useState(() =>
    startOfMonth(selectedTs ? new Date(selectedTs) : new Date()),
  )
  const [pos, setPos] = React.useState({ top: 48, left: 0 })

  useEffect(() => {
    if (!open) return
    setMonth(startOfMonth(selectedTs ? new Date(selectedTs) : new Date()))
  }, [open, selectedTs])

  useEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = anchorRef.current
      const panel = panelRef.current
      if (!anchor) return
      const a = anchor.getBoundingClientRect()
      const pw = panel?.offsetWidth ?? 280
      const ph = panel?.offsetHeight ?? 320
      let left = a.left + a.width / 2 - pw / 2
      left = Math.max(12, Math.min(left, window.innerWidth - pw - 12))
      let top = a.bottom + 8
      if (top + ph > window.innerHeight - 12) {
        top = Math.max(12, a.top - ph - 8)
      }
      setPos({ top, left })
    }
    place()
    const raf = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, month])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [open, onClose, anchorRef])

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end })
  }, [month])

  const today = startOfDay(new Date())
  const selected = selectedTs ? startOfDay(new Date(selectedTs)) : null

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      className="tg-date-jump-popover"
      style={{ top: pos.top, left: pos.left }}
      role="dialog"
      aria-label="Перейти к дате"
    >
      <div className="tg-date-jump-head">
        <button
          type="button"
          className="tg-date-jump-nav"
          aria-label="Предыдущий месяц"
          onClick={() => setMonth((m) => subMonths(m, 1))}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="tg-date-jump-title">
          {format(month, 'LLLL yyyy', { locale: ru })}
        </div>
        <button
          type="button"
          className="tg-date-jump-nav"
          aria-label="Следующий месяц"
          disabled={
            isSameMonth(month, today) || isAfter(startOfMonth(month), today)
          }
          onClick={() => setMonth((m) => addMonths(m, 1))}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="tg-date-jump-close"
          aria-label="Закрыть"
          onClick={onClose}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="tg-date-jump-weekdays">
        {WEEKDAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>

      <div className="tg-date-jump-grid">
        {days.map((day) => {
          const dayStart = startOfDay(day).getTime()
          const inMonth = isSameMonth(day, month)
          const future = isAfter(day, today)
          const isSel = selected ? isSameDay(day, selected) : false
          const isTod = isToday(day)
          const hasMsg = daysWithMessages.has(dayStart)
          return (
            <button
              key={dayStart}
              type="button"
              disabled={future || loading}
              className={clsx(
                'tg-date-jump-day',
                !inMonth && 'tg-date-jump-day--muted',
                future && 'tg-date-jump-day--disabled',
                isSel && 'tg-date-jump-day--selected',
                isTod && 'tg-date-jump-day--today',
                hasMsg && 'tg-date-jump-day--has-msg',
              )}
              onClick={() => onSelectDay(dayStart)}
            >
              {format(day, 'd')}
              {hasMsg && <span className="tg-date-jump-dot" aria-hidden />}
            </button>
          )
        })}
      </div>

      <div className="tg-date-jump-footer">
        <button
          type="button"
          className="tg-date-jump-today-btn"
          disabled={loading}
          onClick={() => onSelectDay(today.getTime())}
        >
          Сегодня
        </button>
        {loading && (
          <span className="tg-date-jump-loading">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Переход…
          </span>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Collect start-of-day timestamps that appear in the loaded timeline. */
export function collectDaysWithMessages(
  events: Array<{ getTs: () => number }>,
): Set<number> {
  const days = new Set<number>()
  for (const ev of events) {
    const ts = ev.getTs()
    if (!ts) continue
    days.add(startOfDay(ts).getTime())
  }
  return days
}

/** Earliest timeline message on that local calendar day. */
export function findFirstEventIdOnDay(
  events: Array<{ getId: () => string | undefined; getTs: () => number }>,
  dayStartMs: number,
): string | null {
  const dayEnd = dayStartMs + 24 * 60 * 60 * 1000
  let onDayId: string | null = null
  let onDayTs = Number.POSITIVE_INFINITY

  for (const ev of events) {
    const ts = ev.getTs()
    const id = ev.getId()
    if (!id || !ts) continue
    if (ts >= dayStartMs && ts < dayEnd && ts < onDayTs) {
      onDayTs = ts
      onDayId = id
    }
  }
  return onDayId
}

/** Earliest timeline message on that local calendar day, else first after it. */
export function findFirstEventIdOnOrAfterDay(
  events: Array<{ getId: () => string | undefined; getTs: () => number }>,
  dayStartMs: number,
): string | null {
  const onDay = findFirstEventIdOnDay(events, dayStartMs)
  if (onDay) return onDay

  const dayEnd = dayStartMs + 24 * 60 * 60 * 1000
  let afterId: string | null = null
  let afterTs = Number.POSITIVE_INFINITY

  for (const ev of events) {
    const ts = ev.getTs()
    const id = ev.getId()
    if (!id || !ts) continue
    if (ts >= dayEnd && ts < afterTs) {
      afterTs = ts
      afterId = id
    }
  }
  return afterId
}
