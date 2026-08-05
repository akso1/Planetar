import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, ShieldCheck, X } from 'lucide-react'
import type { MatrixClient } from 'matrix-js-sdk'
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  canAcceptVerificationRequest,
  type ShowSasCallbacks,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api'
import { matrixService } from '@/shared/api/MatrixService'
import { useVerificationUiStore } from '@/shared/lib/verificationUi'
import { reportAppError } from '@/shared/lib/errorLog'
import { clsx } from 'clsx'

type DeviceVerificationModalProps = {
  client: MatrixClient
  onVerified?: () => void
}

const SAS_METHOD = 'm.sas.v1'

export function DeviceVerificationModal({
  client,
  onVerified,
}: DeviceVerificationModalProps) {
  const request = useVerificationUiStore((s) => s.request)
  const pendingOutgoing = useVerificationUiStore((s) => s.pendingOutgoing)
  const setRequest = useVerificationUiStore((s) => s.setRequest)
  const close = useVerificationUiStore((s) => s.close)
  const markVerified = useVerificationUiStore((s) => s.markVerified)

  const isOpen = pendingOutgoing || !!request

  const [phase, setPhase] = useState<VerificationPhase | null>(null)
  const [sas, setSas] = useState<ShowSasCallbacks | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const requestRef = useRef<VerificationRequest | null>(null)
  const verifierWired = useRef(false)
  const startingSas = useRef(false)
  const verifiedOnce = useRef(false)

  const notifyVerified = useCallback(() => {
    if (verifiedOnce.current) return
    verifiedOnce.current = true
    markVerified()
    onVerified?.()
  }, [markVerified, onVerified])

  const resetLocal = useCallback(() => {
    setPhase(null)
    setSas(null)
    setBusy(false)
    setError(null)
    setDone(false)
    verifierWired.current = false
    startingSas.current = false
    verifiedOnce.current = false
    requestRef.current = null
  }, [])

  const handleClose = useCallback(async () => {
    const req = requestRef.current
    if (req && req.pending) {
      try {
        await req.cancel()
      } catch {
        /* ignore */
      }
    }
    resetLocal()
    close()
  }, [close, resetLocal])

  const wireVerifier = useCallback(
    (verifier: Verifier) => {
      if (verifierWired.current) return
      verifierWired.current = true

      verifier.on(VerifierEvent.ShowSas, (callbacks) => {
        setSas(callbacks)
      })
      const existing = verifier.getShowSasCallbacks()
      if (existing) setSas(existing)

      void verifier
        .verify()
        .then(() => {
          setDone(true)
          setSas(null)
          notifyVerified()
        })
        .catch((err) => {
          if (verifier.hasBeenCancelled) {
            setError('Проверка отменена')
            return
          }
          const msg =
            err instanceof Error ? err.message : 'Не удалось завершить проверку'
          setError(msg)
          reportAppError({
            error: err,
            source: 'promise',
            title: 'Ошибка подтверждения устройства',
            summary: 'SAS-проверка не завершилась успешно.',
          })
        })
    },
    [notifyVerified],
  )

  const tryStartSas = useCallback(
    async (req: VerificationRequest) => {
      if (startingSas.current || verifierWired.current) return
      if (req.phase === VerificationPhase.Started && req.verifier) {
        wireVerifier(req.verifier)
        return
      }
      if (req.phase !== VerificationPhase.Ready) return
      if (req.verifier) {
        wireVerifier(req.verifier)
        return
      }
      startingSas.current = true
      setBusy(true)
      try {
        const verifier = await req.startVerification(SAS_METHOD)
        wireVerifier(verifier)
      } catch (err) {
        startingSas.current = false
        const msg =
          err instanceof Error
            ? err.message
            : 'Не удалось начать сравнение эмодзи'
        setError(msg)
      } finally {
        setBusy(false)
      }
    },
    [wireVerifier],
  )

  const syncPhase = useCallback(
    (req: VerificationRequest) => {
      setPhase(req.phase)
      if (
        req.phase === VerificationPhase.Ready ||
        req.phase === VerificationPhase.Started
      ) {
        void tryStartSas(req)
      }
      if (req.phase === VerificationPhase.Done) {
        setDone(true)
        setSas(null)
        notifyVerified()
      }
      if (req.phase === VerificationPhase.Cancelled) {
        setError('Проверка отменена')
        setSas(null)
      }
    },
    [notifyVerified, tryStartSas],
  )

  // Start outgoing verification
  useEffect(() => {
    if (!isOpen || !pendingOutgoing || request) return
    let cancelled = false

    const run = async () => {
      setBusy(true)
      setError(null)
      try {
        await matrixService.ensureCryptoReady()
        const crypto = client.getCrypto()
        if (!crypto) throw new Error('Шифрование не инициализировано')
        const req = await crypto.requestOwnUserVerification()
        if (cancelled) {
          await req.cancel().catch(() => undefined)
          return
        }
        requestRef.current = req
        setRequest(req)
        syncPhase(req)
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Не удалось отправить запрос на другое устройство'
        setError(msg)
        reportAppError({
          error: err,
          source: 'promise',
          title: 'Не удалось начать подтверждение',
          summary:
            'Запрос verification к другим устройствам не отправился. Нужен cross-signing на аккаунте.',
        })
      } finally {
        if (!cancelled) setBusy(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [isOpen, pendingOutgoing, request, client, setRequest, syncPhase])

  // Bind Change listener for active request
  useEffect(() => {
    if (!request) return
    requestRef.current = request
    syncPhase(request)

    const onChange = () => syncPhase(request)
    request.on(VerificationRequestEvent.Change, onChange)
    return () => {
      request.off(VerificationRequestEvent.Change, onChange)
    }
  }, [request, syncPhase])

  // Reset when fully closed
  useEffect(() => {
    if (!isOpen) resetLocal()
  }, [isOpen, resetLocal])

  const acceptIncoming = async () => {
    if (!request || !canAcceptVerificationRequest(request)) return
    setBusy(true)
    setError(null)
    try {
      await request.accept()
      syncPhase(request)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось принять запрос',
      )
    } finally {
      setBusy(false)
    }
  }

  const confirmSas = async () => {
    if (!sas) return
    setBusy(true)
    try {
      await sas.confirm()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось подтвердить эмодзи',
      )
    } finally {
      setBusy(false)
    }
  }

  const mismatchSas = () => {
    sas?.mismatch()
    setError('Эмодзи не совпали — проверка отменена')
    setSas(null)
  }

  const showAccept =
    !!request &&
    !request.initiatedByMe &&
    canAcceptVerificationRequest(request) &&
    !done

  const showWaiting =
    !done &&
    !sas &&
    !showAccept &&
    !error &&
    (pendingOutgoing ||
      phase === VerificationPhase.Requested ||
      phase === VerificationPhase.Unsent ||
      (phase === VerificationPhase.Ready && busy))

  const title = done
    ? 'Устройство подтверждено'
    : showAccept
      ? 'Входящий запрос'
      : 'Подтверждение устройства'

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[960] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-xs"
            aria-label="Закрыть"
            onClick={() => void handleClose()}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="device-verif-title"
            className="relative w-full max-w-md rounded-2xl border border-hairline bg-chatSidebar shadow-panel backdrop-blur-md overflow-hidden"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-hairline">
              <h2
                id="device-verif-title"
                className="text-[16px] font-semibold text-chatText"
              >
                {title}
              </h2>
              <button
                type="button"
                onClick={() => void handleClose()}
                className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-surface-inset"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-5 space-y-4">
              {done ? (
                <div className="flex flex-col items-center text-center gap-3 py-2">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
                    <ShieldCheck className="w-6 h-6 text-emerald-400" />
                  </div>
                  <p className="text-[13.5px] text-ink-muted leading-relaxed">
                    Это устройство подтверждено через другое. Ключи
                    cross-signing синхронизированы.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      resetLocal()
                      close()
                    }}
                    className="w-full rounded-lg bg-accent/45 hover:bg-accent/65 border border-accent/55 text-chatText text-sm font-medium py-2.5"
                  >
                    Готово
                  </button>
                </div>
              ) : (
                <>
                  {showAccept && (
                    <>
                      <p className="text-[13.5px] text-ink-muted leading-relaxed">
                        Другое ваше устройство хочет подтвердить эту сессию.
                        Примите запрос, затем сравните эмодзи.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleClose()}
                          className="flex-1 rounded-lg bg-surface-inset hover:bg-surface-inset border border-hairline text-chatText text-sm font-medium py-2.5 disabled:opacity-50"
                        >
                          Отклонить
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void acceptIncoming()}
                          className="flex-1 rounded-lg bg-accent/45 hover:bg-accent/65 border border-accent/55 text-chatText text-sm font-medium py-2.5 disabled:opacity-50"
                        >
                          {busy ? '…' : 'Принять'}
                        </button>
                      </div>
                    </>
                  )}

                  {showWaiting && (
                    <>
                      <p className="text-[13.5px] text-ink-muted leading-relaxed">
                        Примите запрос на другом устройстве (например, в
                        Element), затем сравните эмодзи здесь и там.
                      </p>
                      <div className="flex items-center gap-2 text-[13px] text-ink-faint">
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                        Ожидаем подтверждения на другом устройстве…
                      </div>
                    </>
                  )}

                  {sas && (
                    <>
                      <p className="text-[13.5px] text-ink-muted leading-relaxed">
                        Сверьте эмодзи с другим устройством. Они должны
                        полностью совпадать и идти в том же порядке.
                      </p>
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                        {(sas.sas.emoji ?? []).map(([emoji, name], i) => (
                          <div
                            key={`${name}-${i}`}
                            className="rounded-xl bg-black/30 border border-hairline px-1.5 py-2 flex flex-col items-center gap-1"
                            title={name}
                          >
                            <span className="text-[22px] leading-none">
                              {emoji}
                            </span>
                            <span className="text-[9px] text-ink-faint truncate w-full text-center">
                              {name}
                            </span>
                          </div>
                        ))}
                      </div>
                      {sas.sas.decimal && (
                        <div className="text-center text-[13px] tabular-nums text-ink-muted tracking-wider">
                          {sas.sas.decimal.join(' · ')}
                        </div>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={mismatchSas}
                          className="flex-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/35 text-red-200 text-sm font-medium py-2.5 disabled:opacity-50"
                        >
                          Не совпадают
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void confirmSas()}
                          className={clsx(
                            'flex-1 rounded-lg text-sm font-medium py-2.5 disabled:opacity-50',
                            'tg-btn-emerald',
                          )}
                        >
                          {busy ? '…' : 'Совпадают'}
                        </button>
                      </div>
                    </>
                  )}

                  {error && (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12.5px] text-red-200/90">
                      {error}
                    </div>
                  )}

                  {!showAccept && !done && (
                    <button
                      type="button"
                      onClick={() => void handleClose()}
                      className="w-full rounded-lg bg-surface-inset hover:bg-surface-inset border border-hairline text-ink-muted text-[12.5px] font-medium py-2"
                    >
                      Отмена
                    </button>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
