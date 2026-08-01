import type { MatrixClient } from 'matrix-js-sdk'
import { matrixService } from '@/shared/api/MatrixService'

/** True if cross-signing / recovery are not ready yet. */
export async function checkChatProtectionNeeded(
  client: MatrixClient,
): Promise<boolean> {
  try {
    await matrixService.ensureCryptoReady()
  } catch {
    return true
  }
  const crypto = client.getCrypto()
  if (!crypto) return true
  try {
    const [xsReady, ssReady] = await Promise.all([
      crypto.isCrossSigningReady(),
      crypto.isSecretStorageReady(),
    ])
    return !(xsReady && ssReady)
  } catch {
    return true
  }
}
