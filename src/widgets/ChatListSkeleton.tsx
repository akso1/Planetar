import { clsx } from 'clsx'
import { usePanelLayoutStore } from '@/shared/lib/panelLayout'
import { ChatListResizeHandle } from './ChatListResizeHandle'

/** Animated placeholder rows for the chat list while rooms hydrate / first sync. */
export function ChatListSkeleton({
  rows = 9,
  className,
}: {
  rows?: number
  className?: string
}) {
  const width = usePanelLayoutStore((s) => s.chatListWidth)

  return (
    <div
      className={clsx(
        'tg-chatlist relative shrink-0 flex flex-col border-r overflow-hidden',
        className,
      )}
      style={{ width }}
      aria-busy="true"
      aria-label="Загрузка чатов"
    >
      <div className="px-3 pt-3 pb-2 shrink-0 space-y-3">
        <div className="tg-skel h-9 w-full rounded-xl" />
        <div className="flex gap-1.5">
          <div className="tg-skel h-7 flex-1 rounded-lg" />
          <div className="tg-skel h-7 flex-1 rounded-lg opacity-80" />
          <div className="tg-skel h-7 flex-1 rounded-lg opacity-60" />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden px-1.5 pb-3 space-y-0.5">
        {Array.from({ length: rows }, (_, i) => (
          <ChatListSkeletonRow key={i} index={i} />
        ))}
      </div>
      <ChatListResizeHandle />
    </div>
  )
}

function ChatListSkeletonRow({ index }: { index: number }) {
  // Stagger shimmer + varied widths so it feels like a real list, not a grid
  const titleW = [58, 72, 48, 64, 55, 70, 52, 66, 60][index % 9]
  const previewW = [78, 62, 88, 55, 74, 68, 82, 50, 71][index % 9]
  const delay = `${(index % 6) * 70}ms`
  const delayStyle = { ['--tg-skel-delay' as string]: delay }

  return (
    <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
      <div
        className="tg-skel tg-skel--circle h-11 w-11 shrink-0 rounded-full"
        style={delayStyle}
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div
            className="tg-skel h-3 rounded-full"
            style={{ width: `${titleW}%`, ...delayStyle }}
          />
          <div
            className="tg-skel h-2.5 w-8 shrink-0 rounded-full opacity-70"
            style={delayStyle}
          />
        </div>
        <div
          className="tg-skel h-2.5 rounded-full opacity-80"
          style={{ width: `${previewW}%`, ...delayStyle }}
        />
      </div>
    </div>
  )
}
