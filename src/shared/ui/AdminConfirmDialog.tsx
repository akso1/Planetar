import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Ban, Loader2, UserX, X } from 'lucide-react'
import { clsx } from 'clsx'
import type { MatrixClient } from 'matrix-js-sdk'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'

export type AdminConfirmAction = 'kick' | 'ban' | 'unban'

export type AdminConfirmTarget = {
  userId: string
  displayName: string
  avatarMxc?: string | null
}

type AdminConfirmDialogProps = {
  open: boolean
  action: AdminConfirmAction
  target: AdminConfirmTarget | null
  client: MatrixClient
  roomName?: string
  busy?: boolean
  error?: string | null
  onClose: () => void
  onConfirm: (reason: string) => void
}

const COPY: Record<
  AdminConfirmAction,
  {
    title: string
    blurb: (name: string) => string
    confirm: string
    icon: typeof UserX
    danger: boolean
    reason?: boolean
  }
> = {
  kick: {
    title: 'Исключить из чата',
    blurb: (name) =>
      `${name} сможет снова зайти по приглашению или если комната открыта.`,
    confirm: 'Исключить',
    icon: UserX,
    danger: true,
    reason: true,
  },
  ban: {
    title: 'Заблокировать',
    blurb: (name) =>
      `${name} не сможет вернуться, пока бан не снимут.`,
    confirm: 'Заблокировать',
    icon: Ban,
    danger: true,
    reason: true,
  },
  unban: {
    title: 'Разблокировать',
    blurb: (name) =>
      `${name} снова сможет вступить в чат (по правилам комнаты).`,
    confirm: 'Разблокировать',
    icon: Ban,
    danger: false,
    reason: false,
  },
}

export function AdminConfirmDialog({
  open,
  action,
  target,
  client,
  roomName,
  busy = false,
  error,
  onClose,
  onConfirm,
}: AdminConfirmDialogProps) {
  const titleId = useId()
  const [reason, setReason] = useState('')
  const meta = COPY[action]
  const Icon = meta.icon

  useEffect(() => {
    if (!open) setReason('')
  }, [open, action, target?.userId])

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
                <div
                  className={clsx(
                    'tg-admin-dialog-icon w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                    meta.danger
                      ? 'tg-admin-dialog-icon--danger'
                      : 'tg-admin-dialog-icon--soft',
                  )}
                >
                  <Icon className="w-5 h-5" strokeWidth={2.1} />
                </div>
                <div className="min-w-0">
                  <div
                    id={titleId}
                    className="tg-title text-[15px] font-semibold leading-tight"
                  >
                    {meta.title}
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

              <p className="tg-muted text-[12.5px] leading-relaxed mb-3">
                {meta.blurb(target.displayName)}
              </p>

              {meta.reason && (
                <label className="block">
                  <span className="tg-muted text-[11.5px] font-medium">
                    Причина{' '}
                    <span className="opacity-60">(необязательно)</span>
                  </span>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={250}
                    disabled={busy}
                    placeholder="Коротко, почему…"
                    className="tg-field tg-admin-dialog-reason mt-1.5 w-full rounded-xl px-3 py-2 text-[13px] outline-none resize-none"
                  />
                </label>
              )}

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
                className={clsx(
                  'h-9 px-3.5 rounded-xl text-[13px] font-semibold inline-flex items-center gap-1.5 border transition-colors disabled:opacity-50',
                  meta.danger
                    ? 'bg-red-500/20 hover:bg-red-500/30 border-red-500/40 text-red-100'
                    : 'bg-accent/45 hover:bg-accent/65 border-accent/55 text-chatText',
                )}
                disabled={busy}
                onClick={() => onConfirm(reason.trim())}
              >
                {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {meta.confirm}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
