import React, { useState } from 'react'
import { Room, RoomEvent, MatrixClient } from 'matrix-js-sdk'
import {
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
} from 'matrix-js-sdk/lib/crypto-api'
import { matrixService } from '@/shared/api/MatrixService'

type DecryptHistoryModalProps = {
  isOpen: boolean
  onClose: () => void
  client: MatrixClient
  /** If provided, failed events in this room are re-decrypted after restore */
  room?: Room | null
}

export function DecryptHistoryModal({
  isOpen,
  onClose,
  client,
  room,
}: DecryptHistoryModalProps) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key) return
    setIsLoading(true)
    setError('')
    try {
      const crypto = client.getCrypto()
      if (!crypto) {
        throw new Error('Encryption is not initialised on this device.')
      }

      const keyTuple = await client.secretStorage.getKey()
      if (!keyTuple) {
        throw new Error('Secret storage is not set up on this account.')
      }
      const [keyId, keyInfo] = keyTuple

      let privateKey: Uint8Array<ArrayBuffer>
      try {
        privateKey = decodeRecoveryKey(key.trim())
      } catch {
        const passphraseInfo = keyInfo.passphrase
        if (!passphraseInfo) {
          throw new Error('Invalid recovery key.')
        }
        privateKey = await deriveRecoveryKeyFromPassphrase(
          key,
          passphraseInfo.salt,
          passphraseInfo.iterations,
          passphraseInfo.bits,
        )
      }

      const matches = await client.secretStorage.checkKey(privateKey, keyInfo)
      if (!matches) {
        throw new Error('Invalid security key.')
      }

      matrixService.cacheSecretStorageKey(keyId, privateKey)

      await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
      await crypto.restoreKeyBackup()

      if (room) {
        const events = room.getLiveTimeline().getEvents()
        for (const event of events) {
          if (event.isEncrypted() && event.isDecryptionFailure()) {
            try {
              await event.attemptDecryption(crypto as any, { isRetry: true })
            } catch (err) {
              console.warn('Failed to re-decrypt event', event.getId(), err)
            }
          }
        }

        if (events.length > 0) {
          room.emit(
            RoomEvent.Timeline,
            events[events.length - 1],
            room,
            false,
            false,
            { liveEvent: false } as any,
          )
        }
      }

      onClose()
      setKey('')
    } catch (err) {
      console.error('Ошибка верификации истории:', err)
      setError(
        err instanceof Error
          ? err.message
          : 'Invalid security key or failed to restore backup.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-chatSidebar border border-hairline p-6 rounded-2xl shadow-panel backdrop-blur-md w-full max-w-sm">
        <h2 className="text-lg font-bold text-chatText mb-2">
          Восстановить доступ к истории
        </h2>
        <p className="text-sm text-white/45 mb-4">
          Введите ключ восстановления, чтобы открыть старые зашифрованные
          сообщения на этом устройстве.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Ключ восстановления"
            className="w-full bg-black/25 border border-white/10 rounded-lg px-3 py-2 text-chatText mb-4 focus:outline-none focus:ring-1 focus:ring-accent"
            disabled={isLoading}
          />
          {error && <p className="text-red-400 text-sm mb-4">{error}</p>}
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15"
              disabled={isLoading}
            >
              Отмена
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white"
              disabled={isLoading}
            >
              {isLoading ? 'Восстановление…' : 'Восстановить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
