import { useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Link2, Loader2, Search, X } from 'lucide-react'
import { clsx } from 'clsx'
import type { MatrixClient, Room } from 'matrix-js-sdk'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { roomsEligibleForSpace } from '@/shared/lib/spaces'

type AddRoomToSpaceDialogProps = {
  open: boolean
  space: Room | null
  client: MatrixClient | null
  busy?: boolean
  error?: string | null
  onClose: () => void
  onSelect: (roomId: string) => void
}

export function AddRoomToSpaceDialog({
  open,
  space,
  client,
  busy = false,
  error,
  onClose,
  onSelect,
}: AddRoomToSpaceDialogProps) {
  const titleId = useId()
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    setQuery('')
  }, [open, space?.roomId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const rooms = useMemo(() => {
    if (!open || !client || !space) return []
    return roomsEligibleForSpace(client, space)
  }, [open, client, space])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rooms
    return rooms.filter((r) => {
      const name = (r.name || '').toLowerCase()
      return name.includes(q) || r.roomId.toLowerCase().includes(q)
    })
  }, [rooms, query])

  return createPortal(
    <AnimatePresence>
      {open && space && client && (
        <motion.div
          className="fixed inset-0 z-[960] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="Закрыть"
            disabled={busy}
            onClick={() => {
              if (!busy) onClose()
            }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="tg-admin-dialog relative z-10 w-full max-w-[420px] rounded-2xl border shadow-panel overflow-hidden"
            initial={{ y: 12, scale: 0.97, opacity: 0.9 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="tg-admin-dialog-icon tg-admin-dialog-icon--soft w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                  <Link2 className="w-5 h-5" strokeWidth={2.1} />
                </div>
                <div className="min-w-0">
                  <div
                    id={titleId}
                    className="tg-title text-[15px] font-semibold leading-tight"
                  >
                    Добавить чат
                  </div>
                  <div className="tg-muted text-[12px] mt-0.5 truncate">
                    В «{space.name || 'пространство'}»
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full shrink-0"
                aria-label="Закрыть"
                disabled={busy}
                onClick={onClose}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 pb-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={busy}
                  placeholder="Найти чат…"
                  className="tg-field w-full rounded-xl pl-8 pr-3 py-2 text-[13px] outline-none"
                />
              </div>
            </div>

            <div className="px-3 pb-3 max-h-[min(46vh,360px)] overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-center text-ink-faint text-[13px] py-8 px-3">
                  {rooms.length === 0
                    ? 'Нет чатов, которые можно добавить'
                    : 'Ничего не найдено'}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {filtered.map((room) => (
                    <li key={room.roomId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onSelect(room.roomId)}
                        className={clsx(
                          'w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-left transition-colors',
                          busy
                            ? 'opacity-50 cursor-wait'
                            : 'hover:bg-surface-inset active:bg-surface-inset',
                        )}
                      >
                        <MxcAvatar
                          client={client}
                          mxcUrl={room.getMxcAvatarUrl?.() ?? null}
                          label={room.name || room.roomId}
                          size={36}
                          className="shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="tg-title text-[13.5px] truncate">
                            {room.name || room.roomId}
                          </div>
                          <div className="text-[11.5px] text-ink-faint truncate">
                            {room.getJoinedMemberCount()} участников
                          </div>
                        </div>
                        {busy && (
                          <Loader2 className="w-4 h-4 animate-spin text-ink-faint shrink-0" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && (
              <p className="px-5 pb-3 text-[12.5px] text-red-300/90 leading-snug">
                {error}
              </p>
            )}

            <div className="px-5 pb-5 flex items-center justify-end">
              <button
                type="button"
                className="tg-icon-btn px-3.5 py-2 rounded-xl text-[13px]"
                disabled={busy}
                onClick={onClose}
              >
                Отмена
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
