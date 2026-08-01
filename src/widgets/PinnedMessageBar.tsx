import { Pin, X } from 'lucide-react'
import { clsx } from 'clsx'
import { format, isToday, isYesterday } from 'date-fns'
import { ru } from 'date-fns/locale'

type PinnedMessageBarProps = {
  preview: string
  /** Message timestamp (ms) for the date chip */
  ts?: number
  /** 1-based index in the cycle (newest = 1) */
  index: number
  total: number
  /** Personal-only pin (not room-wide) */
  personalOnly?: boolean
  canUnpin?: boolean
  onClick: () => void
  onUnpin?: () => void
}

function formatPinnedDate(ts: number): string {
  if (!ts) return ''
  if (isToday(ts)) return 'Сегодня'
  if (isYesterday(ts)) return 'Вчера'
  return format(ts, 'd MMMM yyyy', { locale: ru })
}

export function PinnedMessageBar({
  preview,
  ts,
  index,
  total,
  personalOnly,
  canUnpin,
  onClick,
  onUnpin,
}: PinnedMessageBarProps) {
  const safeTotal = Math.max(1, total)
  const safeIndex = Math.min(Math.max(1, index), safeTotal)
  const dateLabel = ts ? formatPinnedDate(ts) : ''
  const label = personalOnly ? 'Только для вас' : 'Закреплено'

  return (
    <div
      className={clsx(
        'tg-pinned-bar group w-full px-3 py-2 flex items-center gap-2.5 text-left',
        'border-t',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex-1 min-w-0 flex items-center gap-2.5 text-left rounded-md -my-1 -ml-1 pl-1 py-1 transition-colors"
        title="Перейти к закреплённому сообщению"
        aria-label={
          dateLabel
            ? `Закреплённое сообщение ${safeIndex} из ${safeTotal}, ${dateLabel}: ${preview}`
            : `Закреплённое сообщение ${safeIndex} из ${safeTotal}: ${preview}`
        }
      >
        <span className="tg-pinned-bar-accent shrink-0" aria-hidden />
        <span className="tg-pinned-bar-icon-wrap shrink-0" aria-hidden>
          <Pin className="tg-pinned-bar-icon w-3.5 h-3.5" strokeWidth={2.4} />
        </span>
        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="tg-pinned-bar-label shrink-0">{label}</span>
            {dateLabel && (
              <span className="tg-pinned-bar-date truncate">{dateLabel}</span>
            )}
          </div>
          <span className="tg-pinned-bar-preview truncate">
            {preview || 'Сообщение'}
          </span>
        </div>
        <span className="tg-pinned-bar-count shrink-0 tabular-nums">
          {safeIndex}
          <span className="tg-pinned-bar-count-sep">/</span>
          {safeTotal}
        </span>
      </button>
      {canUnpin && onUnpin && (
        <button
          type="button"
          className="tg-pinned-bar-unpin shrink-0"
          title="Открепить"
          aria-label="Открепить сообщение"
          onClick={(e) => {
            e.stopPropagation()
            onUnpin()
          }}
        >
          <X className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
      )}
    </div>
  )
}
