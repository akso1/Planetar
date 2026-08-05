import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Loader2, Plus, Trash2, X } from 'lucide-react'
import { clsx } from 'clsx'

type CreatePollDialogProps = {
  open: boolean
  busy?: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (data: {
    question: string
    answers: string[]
    maxSelections: number
  }) => void
}

export function CreatePollDialog({
  open,
  busy = false,
  error,
  onClose,
  onSubmit,
}: CreatePollDialogProps) {
  const titleId = useId()
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState(['', ''])
  const [multi, setMulti] = useState(false)

  useEffect(() => {
    if (!open) return
    setQuestion('')
    setAnswers(['', ''])
    setMulti(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const cleaned = answers.map((a) => a.trim()).filter(Boolean)
  const canSend =
    question.trim().length > 0 && cleaned.length >= 2 && !busy

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
                  <BarChart3 className="w-5 h-5" strokeWidth={2.1} />
                </div>
                <div className="min-w-0">
                  <div
                    id={titleId}
                    className="tg-title text-[15px] font-semibold leading-tight"
                  >
                    Новый опрос
                  </div>
                  <div className="tg-muted text-[12px] mt-0.5">
                    Вопрос и минимум 2 варианта
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

            <div className="px-5 pb-4 space-y-3 max-h-[min(52vh,420px)] overflow-y-auto">
              <label className="block">
                <span className="tg-muted text-[11.5px] font-medium">
                  Вопрос
                </span>
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  disabled={busy}
                  maxLength={280}
                  placeholder="О чём спросить?"
                  className="tg-field tg-admin-dialog-reason mt-1.5 w-full rounded-xl px-3 py-2 text-[13px] outline-none"
                />
              </label>

              <div className="space-y-2">
                <span className="tg-muted text-[11.5px] font-medium">
                  Варианты
                </span>
                {answers.map((answer, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <input
                      value={answer}
                      onChange={(e) => {
                        const next = [...answers]
                        next[index] = e.target.value
                        setAnswers(next)
                      }}
                      disabled={busy}
                      maxLength={120}
                      placeholder={`Вариант ${index + 1}`}
                      className="tg-field tg-admin-dialog-reason flex-1 rounded-xl px-3 py-2 text-[13px] outline-none"
                    />
                    {answers.length > 2 && (
                      <button
                        type="button"
                        className="tg-icon-btn w-8 h-8 flex items-center justify-center rounded-full shrink-0"
                        aria-label="Удалить вариант"
                        disabled={busy}
                        onClick={() =>
                          setAnswers((prev) =>
                            prev.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {answers.length < 10 && (
                  <button
                    type="button"
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-accent-hover px-1 py-1"
                    onClick={() => setAnswers((prev) => [...prev, ''])}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Добавить вариант
                  </button>
                )}
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={multi}
                  disabled={busy}
                  onChange={(e) => setMulti(e.target.checked)}
                  className="rounded border-hairline-strong"
                />
                <span className="tg-title text-[13px]">
                  Можно выбрать несколько
                </span>
              </label>

              {error && (
                <div className="tg-admin-dialog-error text-[12.5px] rounded-xl px-3 py-2">
                  {error}
                </div>
              )}
            </div>

            <div className="tg-admin-dialog-footer flex items-center justify-end gap-2 px-5 py-3.5">
              <button
                type="button"
                className="h-9 px-3.5 rounded-xl text-[13px] font-medium border border-hairline bg-surface-inset text-ink hover:bg-surface-inset transition-colors disabled:opacity-50"
                disabled={busy}
                onClick={onClose}
              >
                Отмена
              </button>
              <button
                type="button"
                className={clsx(
                  'h-9 px-3.5 rounded-xl text-[13px] font-semibold inline-flex items-center gap-1.5 border transition-colors disabled:opacity-50',
                  'bg-accent/45 hover:bg-accent/65 border-accent/55 text-chatText',
                )}
                disabled={!canSend}
                onClick={() =>
                  onSubmit({
                    question: question.trim(),
                    answers: cleaned,
                    maxSelections: multi ? cleaned.length : 1,
                  })
                }
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Создать
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
