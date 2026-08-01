import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { Search, X } from 'lucide-react'
import type { Room } from 'matrix-js-sdk'
import { useRoomStore } from '@/entities/session/model/room.store'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'

type ForwardRoomPickerProps = {
  open: boolean
  onClose: () => void
  onConfirm: (roomIds: string[]) => void | Promise<void>
  /** Exclude current chat from the list */
  excludeRoomId?: string | null
  title?: string
  busy?: boolean
}

export function ForwardRoomPicker({
  open,
  onClose,
  onConfirm,
  excludeRoomId,
  title = 'Переслать в…',
  busy = false,
}: ForwardRoomPickerProps) {
  const rooms = useRoomStore((s) => s.rooms)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelected(new Set())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rooms
      .filter((r) => r.roomId !== excludeRoomId)
      .filter((r) => {
        if (!q) return true
        const name = (r.name || r.roomId).toLowerCase()
        return name.includes(q)
      })
      .sort((a, b) =>
        (a.name || a.roomId).localeCompare(b.name || b.roomId, 'ru'),
      )
  }, [rooms, query, excludeRoomId])

  const toggle = (roomId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(roomId)) next.delete(roomId)
      else next.add(roomId)
      return next
    })
  }

  const handleConfirm = () => {
    if (selected.size === 0 || busy) return
    void onConfirm([...selected])
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        aria-label="Закрыть"
        disabled={busy}
        onClick={() => {
          if (!busy) onClose()
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-picker-title"
        className="relative w-full max-w-md max-h-[min(88vh,560px)] rounded-2xl border border-hairline bg-chatSidebar shadow-panel backdrop-blur-md overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3 border-b border-white/5 shrink-0">
          <h2
            id="forward-picker-title"
            className="text-[16px] font-semibold text-white/95 truncate"
          >
            {title}
          </h2>
          <button
            type="button"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white transition-colors"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 pt-3 pb-2 shrink-0">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center">
              <Search className="w-4 h-4 text-white/35" strokeWidth={2} />
            </span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск чатов"
              autoFocus
              className="w-full h-10 rounded-xl bg-black/30 border border-white/10 pl-9 pr-3 text-[14px] text-white/90 placeholder:text-white/35 outline-none focus:border-white/25"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-[13px] text-white/40">
              Ничего не найдено
            </div>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((room) => (
                <ForwardRoomRow
                  key={room.roomId}
                  room={room}
                  selected={selected.has(room.roomId)}
                  onToggle={() => toggle(room.roomId)}
                  disabled={busy}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-t border-white/5 bg-[#15202b]">
          <span className="text-[13px] text-white/50">
            {selected.size > 0
              ? `Выбрано: ${selected.size}`
              : 'Выберите чаты'}
          </span>
          <button
            type="button"
            disabled={selected.size === 0 || busy}
            onClick={handleConfirm}
            className={clsx(
              'px-4 py-2 rounded-full text-[13.5px] font-medium transition-colors',
              selected.size === 0 || busy
                ? 'bg-white/10 text-white/35 cursor-not-allowed'
                : 'bg-accent hover:bg-accent-hover text-white',
            )}
          >
            {busy ? 'Отправка…' : 'Переслать'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ForwardRoomRow({
  room,
  selected,
  onToggle,
  disabled,
}: {
  room: Room
  selected: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  const name = room.name || room.roomId
  const mxc = room.getMxcAvatarUrl() || undefined

  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={clsx(
          'w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
          selected ? 'bg-accent/35' : 'hover:bg-white/6',
          disabled && 'opacity-60',
        )}
      >
        <span
          className={clsx(
            'shrink-0 w-[18px] h-[18px] rounded-md border flex items-center justify-center',
            selected
              ? 'bg-[#5b9fd4] border-[#5b9fd4]'
              : 'border-white/25 bg-transparent',
          )}
          aria-hidden
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M2.5 6.2L4.8 8.5L9.5 3.5"
                stroke="#0b1520"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
        <MxcAvatar mxcUrl={mxc} name={name} size={40} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[14px] text-white/90">
          {name}
        </span>
      </button>
    </li>
  )
}
