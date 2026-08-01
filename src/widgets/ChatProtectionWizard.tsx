import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  ClipboardCopy,
  KeyRound,
  Loader2,
  Shield,
  X,
} from 'lucide-react'
import type { MatrixClient } from 'matrix-js-sdk'
import { encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api'
import { matrixService } from '@/shared/api/MatrixService'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import { reportAppError } from '@/shared/lib/errorLog'
import { checkChatProtectionNeeded } from '@/shared/lib/chatProtection'
import { clsx } from 'clsx'

type Step = 'intro' | 'auth' | 'working' | 'show-key' | 'done' | 'ready'

type ChatProtectionWizardProps = {
  client: MatrixClient
  open: boolean
  onClose: () => void
  /** Called when protection is already OK or just set up */
  onComplete?: () => void
}

/**
 * Telegram-style chat protection setup (cross-signing + recovery key + key backup).
 * UI copy avoids Matrix jargon.
 */
export function ChatProtectionWizard({
  client,
  open,
  onClose,
  onComplete,
}: ChatProtectionWizardProps) {
  const [step, setStep] = useState<Step>('intro')
  const [password, setPassword] = useState('')
  const [recoveryKey, setRecoveryKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('intro')
    setPassword('')
    setRecoveryKey('')
    setCopied(false)
    setConfirmed(false)
    setError(null)
    setBusy(false)
    pushBreadcrumb('chat_protection_open')

    let cancelled = false
    void (async () => {
      const needed = await checkChatProtectionNeeded(client)
      if (cancelled) return
      if (!needed) setStep('ready')
    })()
    return () => {
      cancelled = true
    }
  }, [open, client])

  const finish = useCallback(() => {
    onComplete?.()
    onClose()
  }, [onClose, onComplete])

  const runSetup = useCallback(
    async (authPassword?: string) => {
      setBusy(true)
      setError(null)
      setStep('working')
      try {
        await matrixService.ensureCryptoReady()
        const crypto = client.getCrypto()
        if (!crypto) {
          throw new Error('Не удалось включить защиту на этом устройстве.')
        }

        const generated = await crypto.createRecoveryKeyFromPassphrase()
        const encoded =
          generated.encodedPrivateKey ||
          encodeRecoveryKey(generated.privateKey) ||
          ''
        if (!encoded) {
          throw new Error('Не удалось создать ключ восстановления.')
        }

        const userId = client.getUserId()
        if (!userId) throw new Error('Сессия недействительна. Войдите снова.')

        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => {
            try {
              await makeRequest({})
              return
            } catch {
              /* need interactive auth */
            }
            const pwd = authPassword?.trim()
            if (!pwd) {
              const err = new Error('NEED_PASSWORD')
              throw err
            }
            await makeRequest({
              type: 'm.login.password',
              identifier: { type: 'm.id.user', user: userId },
              user: userId,
              password: pwd,
            })
          },
        })

        await crypto.bootstrapSecretStorage({
          createSecretStorageKey: async () => generated,
          setupNewSecretStorage: true,
          setupNewKeyBackup: true,
        })

        // Cache for immediate restore/decrypt in this session
        try {
          const keyTuple = await client.secretStorage.getKey()
          if (keyTuple) {
            matrixService.cacheSecretStorageKey(
              keyTuple[0],
              generated.privateKey,
            )
          }
        } catch {
          /* optional */
        }

        setRecoveryKey(encoded)
        setStep('show-key')
        pushBreadcrumb('chat_protection_created')
      } catch (err) {
        if (err instanceof Error && err.message === 'NEED_PASSWORD') {
          setStep('auth')
          setError(null)
          return
        }
        const msg =
          err instanceof Error ? err.message : 'Не удалось настроить защиту'
        setError(msg)
        setStep(authPassword ? 'auth' : 'intro')
        reportAppError({
          title: 'Защита чатов',
          summary: msg,
          detail: err instanceof Error ? err.stack : String(err),
        })
      } finally {
        setBusy(false)
      }
    },
    [client],
  )

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Не удалось скопировать. Выделите ключ вручную.')
    }
  }

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/60 backdrop-blur-xs"
          aria-label="Закрыть"
          onClick={onClose}
        />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-protection-title"
          className="relative w-full max-w-md rounded-2xl border border-hairline bg-chatSidebar shadow-panel overflow-hidden text-chatText"
          initial={{ opacity: 0, y: 16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.96 }}
        >
          <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-hairline">
            <h2
              id="chat-protection-title"
              className="text-lg font-semibold text-ink flex items-center gap-2"
            >
              <Shield className="w-5 h-5 text-emerald-400" />
              Защита чатов
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-5 py-5 space-y-4">
            {step === 'ready' && (
              <>
                <p className="text-sm text-ink-muted leading-relaxed">
                  Защита чатов уже настроена на этом аккаунте. Можете подтвердить
                  устройство через другое или восстановить историю ключом.
                </p>
                <button
                  type="button"
                  onClick={finish}
                  className="w-full rounded-lg bg-accent/50 hover:bg-accent/70 border border-accent/50 text-ink text-sm font-medium py-2.5"
                >
                  Понятно
                </button>
              </>
            )}

            {step === 'intro' && (
              <>
                <p className="text-sm text-ink leading-relaxed">
                  Сообщения в личных чатах защищены сквозным шифрованием. Создайте
                  ключ восстановления — он понадобится на новом устройстве, чтобы
                  читать старую переписку.
                </p>
                <p className="text-xs text-ink-muted leading-relaxed">
                  Ключ показывается один раз. Сохраните его в надёжном месте —
                  мы не сможем восстановить его за вас.
                </p>
                {error && (
                  <div className="text-[13px] text-red-300/90">{error}</div>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runSetup()}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-100 text-sm font-medium py-2.5 disabled:opacity-50"
                >
                  <KeyRound className="w-4 h-4" />
                  Включить защиту
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full text-sm text-ink-muted hover:text-ink py-1"
                >
                  Позже
                </button>
              </>
            )}

            {step === 'auth' && (
              <>
                <p className="text-sm text-ink-muted leading-relaxed">
                  Чтобы подтвердить это устройство, введите пароль аккаунта.
                </p>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Пароль"
                  autoFocus
                  className="w-full rounded-xl bg-surface-inset border border-hairline px-3 py-2.5 text-sm text-ink outline-none focus:border-accent/60"
                />
                {error && (
                  <div className="text-[13px] text-red-300/90">{error}</div>
                )}
                <button
                  type="button"
                  disabled={busy || !password.trim()}
                  onClick={() => void runSetup(password)}
                  className="w-full rounded-lg bg-accent/50 hover:bg-accent/70 border border-accent/50 text-ink text-sm font-medium py-2.5 disabled:opacity-50"
                >
                  Продолжить
                </button>
              </>
            )}

            {step === 'working' && (
              <div className="flex flex-col items-center gap-3 py-8 text-ink-muted">
                <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
                <div className="text-sm">Настраиваем защиту…</div>
              </div>
            )}

            {step === 'show-key' && (
              <>
                <p className="text-sm text-ink leading-relaxed">
                  Ваш ключ восстановления. Скопируйте и сохраните его сейчас.
                </p>
                <div className="rounded-xl bg-surface-inset border border-hairline p-3 font-mono text-[12.5px] leading-relaxed break-all select-all text-ink">
                  {recoveryKey}
                </div>
                <button
                  type="button"
                  onClick={() => void copyKey()}
                  className="w-full flex items-center justify-center gap-2 rounded-lg bg-black/20 hover:bg-black/30 border border-hairline text-sm py-2.5"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ClipboardCopy className="w-4 h-4" />
                  )}
                  {copied ? 'Скопировано' : 'Скопировать ключ'}
                </button>
                <label className="flex items-start gap-2 text-[13px] text-ink-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  Я сохранил ключ в надёжном месте
                </label>
                <button
                  type="button"
                  disabled={!confirmed}
                  onClick={() => setStep('done')}
                  className={clsx(
                    'w-full rounded-lg text-sm font-medium py-2.5 border',
                    confirmed
                      ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/40 text-emerald-100'
                      : 'opacity-40 border-hairline',
                  )}
                >
                  Готово
                </button>
              </>
            )}

            {step === 'done' && (
              <>
                <div className="flex flex-col items-center gap-2 py-4">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <Check className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div className="text-sm font-medium text-ink">
                    Защита чатов включена
                  </div>
                  <p className="text-xs text-ink-muted text-center leading-relaxed max-w-[280px]">
                    На новом устройстве введите этот ключ, чтобы открыть историю
                    переписки.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={finish}
                  className="w-full rounded-lg bg-accent/50 hover:bg-accent/70 border border-accent/50 text-ink text-sm font-medium py-2.5"
                >
                  Закрыть
                </button>
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
