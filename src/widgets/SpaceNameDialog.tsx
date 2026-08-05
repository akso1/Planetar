import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { FolderPlus, Hash, Loader2, X } from 'lucide-react'
import { clsx } from 'clsx'

type SpaceNameDialogProps = {
  open: boolean
  mode: 'space' | 'room'
  busy?: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (data: { name: string; topic?: string }) => void
}

export function SpaceNameDialog({
  open,
  mode,
  busy = false,
  error,
  onClose,
  onSubmit,
}: SpaceNameDialogProps) {
  const titleId = useId()
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')

  useEffect(() => {
    if (!open) return
    setName('')
    setTopic('')
  }, [open, mode])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const canSend = name.trim().length > 0 && !busy
  const Icon = mode === 'space' ? FolderPlus : Hash
  const title = mode === 'space' ? 'Новое пространство' : 'Новый чат в пространстве'
  const blurb =
    mode === 'space'
      ? 'Папка для связанных чатов'
      : 'Чат сразу появится внутри текущего пространства'
  const confirm = mode === 'space' ? 'Создать' : 'Создать чат'
  const nameLabel = mode === 'space' ? 'Название пространства' : 'Название чата'
  const namePlaceholder =
    mode === 'space' ? 'Команда, проект…' : 'Общий чат, новости…'

  return createPortal(
    <AnimatePresence>
      {open && (
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
            className="tg-admin-dialog relative z-10 w-full max-w-[400px] rounded-2xl border shadow-panel overflow-hidden"
            initial={{ y: 12, scale: 0.97, opacity: 0.9 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="tg-admin-dialog-icon tg-admin-dialog-icon--soft w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                  <Icon className="w-5 h-5" strokeWidth={2.1} />
                </div>
                <div className="min-w-0">
                  <div
                    id={titleId}
                    className="tg-title text-[15px] font-semibold leading-tight"
                  >
                    {title}
                  </div>
                  <div className="tg-muted text-[12px] mt-0.5">{blurb}</div>
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

            <div className="px-5 pb-4 space-y-3">
              <label className="block">
                <span className="tg-muted text-[11.5px] font-medium">
                  {nameLabel}
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  maxLength={120}
                  autoFocus
                  placeholder={namePlaceholder}
                  className="tg-field tg-admin-dialog-reason mt-1.5 w-full rounded-xl px-3 py-2 text-[13px] outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSend) {
                      e.preventDefault()
                      onSubmit({
                        name: name.trim(),
                        topic: topic.trim() || undefined,
                      })
                    }
                  }}
                />
              </label>
              <label className="block">
                <span className="tg-muted text-[11.5px] font-medium">
                  Описание (необязательно)
                </span>
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  disabled={busy}
                  maxLength={280}
                  placeholder="Кратко, о чём это"
                  className="tg-field tg-admin-dialog-reason mt-1.5 w-full rounded-xl px-3 py-2 text-[13px] outline-none"
                />
              </label>
              {error && (
                <p className="text-[12.5px] text-red-300/90 leading-snug">
                  {error}
                </p>
              )}
            </div>

            <div className="px-5 pb-5 flex items-center justify-end gap-2">
              <button
                type="button"
                className="tg-icon-btn px-3.5 py-2 rounded-xl text-[13px]"
                disabled={busy}
                onClick={onClose}
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={!canSend}
                onClick={() =>
                  onSubmit({
                    name: name.trim(),
                    topic: topic.trim() || undefined,
                  })
                }
                className={clsx(
                  'inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium transition-colors',
                  canSend
                    ? 'tg-btn-primary'
                    : 'opacity-40 cursor-not-allowed tg-btn-primary',
                )}
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                {confirm}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
