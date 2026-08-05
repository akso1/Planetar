import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** Persisted Matrix secret-storage (recovery) key for one account+device. */
export type StoredSecretStorageKey = {
  userId: string
  deviceId: string
  keyId: string
  /** Raw private key bytes as base64 */
  privateKeyBase64: string
}

function storeDir(): string {
  return path.join(app.getPath('userData'), 'secret-storage-keys')
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function keyFilePath(userId: string, deviceId: string): string {
  return path.join(
    storeDir(),
    `${safeFilePart(userId)}__${safeFilePart(deviceId)}.enc`,
  )
}

function keyPlainFallbackPath(userId: string, deviceId: string): string {
  return path.join(
    storeDir(),
    `${safeFilePart(userId)}__${safeFilePart(deviceId)}.json`,
  )
}

function ensureDir(): void {
  const dir = storeDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function readSecretStorageKey(
  userId: string,
  deviceId: string,
): StoredSecretStorageKey | null {
  if (!userId || !deviceId) return null
  try {
    const encPath = keyFilePath(userId, deviceId)
    if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
      const buf = fs.readFileSync(encPath)
      const json = safeStorage.decryptString(buf)
      const parsed = JSON.parse(json) as StoredSecretStorageKey
      if (
        parsed?.userId === userId &&
        parsed?.deviceId === deviceId &&
        parsed?.keyId &&
        parsed?.privateKeyBase64
      ) {
        return parsed
      }
      return null
    }

    const plainPath = keyPlainFallbackPath(userId, deviceId)
    if (fs.existsSync(plainPath)) {
      const json = fs.readFileSync(plainPath, 'utf8')
      const parsed = JSON.parse(json) as StoredSecretStorageKey
      if (
        parsed?.userId === userId &&
        parsed?.deviceId === deviceId &&
        parsed?.keyId &&
        parsed?.privateKeyBase64
      ) {
        return parsed
      }
    }
  } catch (err) {
    console.warn('[secretStorageKeyStore] read failed:', err)
  }
  return null
}

export function writeSecretStorageKey(
  payload: StoredSecretStorageKey,
): { ok: boolean; reason?: string } {
  try {
    if (
      !payload?.userId ||
      !payload?.deviceId ||
      !payload?.keyId ||
      !payload?.privateKeyBase64
    ) {
      return { ok: false, reason: 'invalid-payload' }
    }
    ensureDir()
    const json = JSON.stringify(payload)
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json)
      fs.writeFileSync(keyFilePath(payload.userId, payload.deviceId), encrypted, {
        mode: 0o600,
      })
      try {
        fs.unlinkSync(keyPlainFallbackPath(payload.userId, payload.deviceId))
      } catch {
        /* ignore */
      }
      return { ok: true }
    }

    fs.writeFileSync(
      keyPlainFallbackPath(payload.userId, payload.deviceId),
      json,
      { encoding: 'utf8', mode: 0o600 },
    )
    return { ok: true, reason: 'plain-fallback' }
  } catch (err) {
    console.warn('[secretStorageKeyStore] write failed:', err)
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export function clearSecretStorageKey(userId: string, deviceId: string): void {
  if (!userId || !deviceId) return
  for (const p of [
    keyFilePath(userId, deviceId),
    keyPlainFallbackPath(userId, deviceId),
  ]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
}

/** Wipe every persisted recovery key (logout / full scrub). */
export function clearAllSecretStorageKeys(): void {
  const dir = storeDir()
  if (!fs.existsSync(dir)) return
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name))
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[secretStorageKeyStore] clearAll failed:', err)
  }
}
