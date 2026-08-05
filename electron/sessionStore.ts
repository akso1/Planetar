import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type StoredSessionCredentials = {
  baseUrl: string
  userId: string
  accessToken: string
  deviceId?: string
}

function sessionFilePath(): string {
  return path.join(app.getPath('userData'), 'matrix-session.enc')
}

/** Legacy path — never read or write tokens here; scrub on sight. */
function sessionPlainFallbackPath(): string {
  return path.join(app.getPath('userData'), 'matrix-session.json')
}

function scrubLegacyPlaintextSession(): void {
  const plainPath = sessionPlainFallbackPath()
  try {
    if (fs.existsSync(plainPath)) {
      fs.unlinkSync(plainPath)
      // Attack prevented: leftover plaintext access token on disk after upgrade
      console.warn('[sessionStore] removed legacy plaintext matrix-session.json')
    }
  } catch (err) {
    console.warn('[sessionStore] failed to scrub plaintext session:', err)
  }
}

function isValidCreds(parsed: StoredSessionCredentials | null): parsed is StoredSessionCredentials {
  return !!(
    parsed?.baseUrl &&
    parsed?.userId &&
    parsed?.accessToken &&
    parsed?.deviceId
  )
}

export function readSessionCredentials(): StoredSessionCredentials | null {
  // Always scrub plaintext fallback — never load tokens from it
  scrubLegacyPlaintextSession()

  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fail closed: cannot safely decrypt/store — force re-auth
      console.warn('[sessionStore] safeStorage unavailable — refusing plaintext session')
      return null
    }

    const encPath = sessionFilePath()
    if (!fs.existsSync(encPath)) return null

    const buf = fs.readFileSync(encPath)
    const json = safeStorage.decryptString(buf)
    const parsed = JSON.parse(json) as StoredSessionCredentials
    if (isValidCreds(parsed)) return parsed
    return null
  } catch (err) {
    console.warn('[sessionStore] read failed:', err)
  }
  return null
}

export function writeSessionCredentials(
  creds: StoredSessionCredentials,
): { ok: boolean; reason?: string } {
  scrubLegacyPlaintextSession()

  // Attack prevented: writing access token as matrix-session.json when Keychain/safeStorage is off
  if (!safeStorage.isEncryptionAvailable()) {
    console.error(
      '[sessionStore] safeStorage unavailable — refuse to persist access token',
    )
    return { ok: false, reason: 'safe-storage-unavailable' }
  }

  try {
    const json = JSON.stringify(creds)
    const encrypted = safeStorage.encryptString(json)
    // Restrictive mode: other local users cannot read the ciphertext blob
    fs.writeFileSync(sessionFilePath(), encrypted, { mode: 0o600 })
    scrubLegacyPlaintextSession()
    return { ok: true }
  } catch (err) {
    console.warn('[sessionStore] write failed:', err)
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

export function clearSessionCredentials(): void {
  for (const p of [sessionFilePath(), sessionPlainFallbackPath()]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
}
