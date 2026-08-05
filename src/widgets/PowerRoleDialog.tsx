import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Shield, X } from 'lucide-react'
import { clsx } from 'clsx'
import type { MatrixClient } from 'matrix-js-sdk'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import type { PowerRolePreset } from '@/shared/lib/roomModeration'

export type PowerRoleTarget = {
  userId: string
  displayName: string
  avatarMxc?: string | null
  currentLevel: number
}

type PowerRoleDialogProps = {
  open: boolean
  target: PowerRoleTarget | null
  presets: PowerRolePreset[]
  client: MatrixClient
  roomName?: string
  busy?: boolean
  error?: string | null
  onClose: () => void
  onConfirm: (level: number) => void
}

export function PowerRoleDialog({
  open,
  target,
  presets,
  client,
  roomName,
  busy = false,
  error,
  onClose,
  onConfirm,
}: PowerRoleDialogProps) {
  const titleId = useId()
  const [selected, setSelected] = useState<number | null>(null)

  useEffect(() => {
    if (!open || !target) {
      setSelected(null)
      return
    }
    const match = presets.find((p) => p.level === target.currentLevel)
    setSelected(match?.level ?? presets[0]?.level ?? null)
  }, [open, target?.userId, target?.currentLevel, presets])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  return createPortal(
    <AnimatePresence>
      {open && target && (
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
            className="tg-admin-dialog relative z-10 w-full max-w-[380px] rounded-2xl border shadow-panel overflow-hidden"
            initial={{ y: 12, scale: 0.97, opacity: 0.9 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.98, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="tg-admin-dialog-icon tg-admin-dialog-icon--soft w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
                  <Shield className="w-5 h-5" strokeWidth={2.1} />
                </div>
                <div className="min-w-0">
                  <div
                    id={titleId}
                    className="tg-title text-[15px] font-semibold leading-tight"
                  >
                    Назначить роль
                  </div>
                  {roomName && (
                    <div className="tg-muted text-[12px] mt-0.5 truncate">
                      {roomName}
                    </div>
                  )}
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

            <div className="px-5 pb-4">
              <div className="tg-admin-dialog-target flex items-center gap-3 rounded-xl px-3 py-2.5 mb-3">
                <MxcAvatar
                  client={client}
                  mxcUrl={target.avatarMxc || null}
                  label={target.displayName}
                  size={40}
                />
                <div className="min-w-0">
                  <div className="tg-title text-[13.5px] font-medium truncate">
                    {target.displayName}
                  </div>
                  <div className="tg-muted text-[11.5px] truncate">
                    {target.userId}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                {presets.map((preset) => {
                  const active = selected === preset.level
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      disabled={busy}
                      onClick={() => setSelected(preset.level)}
                      className={clsx(
                        'w-full text-left rounded-xl px-3 py-2.5 border transition-colors',
                        active
                          ? 'border-accent/45 bg-accent/15'
                          : 'border-hairline bg-surface-inset hover:bg-surface-inset',
                      )}
                    >
                      <div className="tg-title text-[13.5px] font-medium">
                        {preset.label}
                      </div>
                      <div className="tg-muted text-[11.5px] mt-0.5">
                        Уровень {preset.level}
                        {preset.level === target.currentLevel ? ' · сейчас' : ''}
                      </div>
                    </button>
                  )
                })}
              </div>

              {error && (
                <div className="tg-admin-dialog-error mt-3 text-[12.5px] rounded-xl px-3 py-2">
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
                className="h-9 px-3.5 rounded-xl text-[13px] font-semibold inline-flex items-center gap-1.5 border bg-accent/45 hover:bg-accent/65 border-accent/55 text-chatText disabled:opacity-50"
                disabled={
                  busy ||
                  selected == null ||
                  selected === target.currentLevel
                }
                onClick={() => {
                  if (selected != null) onConfirm(selected)
                }}
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Сохранить
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
