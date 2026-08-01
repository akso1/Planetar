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

function sessionPlainFallbackPath(): string {
  return path.join(app.getPath('userData'), 'matrix-session.json')
}

export function readSessionCredentials(): StoredSessionCredentials | null {
  try {
    const encPath = sessionFilePath()
    if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
      const buf = fs.readFileSync(encPath)
      const json = safeStorage.decryptString(buf)
      const parsed = JSON.parse(json) as StoredSessionCredentials
      if (
        parsed?.baseUrl &&
        parsed?.userId &&
        parsed?.accessToken &&
        parsed?.deviceId
      ) {
        return parsed
      }
      return null
    }

    const plainPath = sessionPlainFallbackPath()
    if (fs.existsSync(plainPath)) {
      const json = fs.readFileSync(plainPath, 'utf8')
      const parsed = JSON.parse(json) as StoredSessionCredentials
      if (
        parsed?.baseUrl &&
        parsed?.userId &&
        parsed?.accessToken &&
        parsed?.deviceId
      ) {
        return parsed
      }
    }
  } catch (err) {
    console.warn('[sessionStore] read failed:', err)
  }
  return null
}

export function writeSessionCredentials(
  creds: StoredSessionCredentials,
): { ok: boolean; reason?: string } {
  try {
    const json = JSON.stringify(creds)
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json)
      fs.writeFileSync(sessionFilePath(), encrypted)
      // Remove any legacy plaintext fallback
      try {
        fs.unlinkSync(sessionPlainFallbackPath())
      } catch {
        /* ignore */
      }
      return { ok: true }
    }

    // Rare: encryption unavailable — still persist off localStorage
    fs.writeFileSync(sessionPlainFallbackPath(), json, 'utf8')
    return { ok: true, reason: 'plain-fallback' }
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
