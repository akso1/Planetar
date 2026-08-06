import * as MatrixEncryptAttachment from 'matrix-encrypt-attachment';
import type { MatrixClient } from 'matrix-js-sdk';

/** Encrypted file info from an m.room.message content.file field */
export type EncryptedAttachmentInfo = {
  url: string;
  mimetype?: string;
  key?: unknown;
  iv?: string;
  hashes?: Record<string, string>;
  v?: string;
};

type ObjectUrlCacheEntry = {
  url: string
  refs: number
  revokeTimer: ReturnType<typeof setTimeout> | null
}

/** Shared blob: URLs so scroll/remount does not revoke while <img> still uses them. */
const objectUrlCache = new Map<string, ObjectUrlCacheEntry>()
const objectUrlInflight = new Map<string, Promise<string>>()

/** In-memory blobs keyed by synthetic `mxc://planetar.local/…` for optimistic send. */
const localMediaBlobs = new Map<string, Blob>()

const OBJECT_URL_REVOKE_DELAY_MS = 180_000

const LOCAL_MEDIA_MXC_PREFIX = 'mxc://planetar.local/'

/** Register a blob for optimistic sticker/GIF paint before HS upload finishes. */
export function registerLocalMediaBlob(blob: Blob): string {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const mxc = `${LOCAL_MEDIA_MXC_PREFIX}${id}`
  localMediaBlobs.set(mxc, blob)
  return mxc
}

export function unregisterLocalMediaBlob(mxc: string): void {
  localMediaBlobs.delete(mxc)
}

export function getLocalMediaBlob(mxc: string): Blob | null {
  return localMediaBlobs.get(mxc) ?? null
}

export function isLocalMediaMxc(mxc: string): boolean {
  return mxc.startsWith(LOCAL_MEDIA_MXC_PREFIX)
}

/**
 * Seed the object-URL cache so timeline media can paint without re-downloading.
 * Does not bump refs — unused primes are revoked after the idle delay.
 */
export function primeCachedObjectUrl(cacheKey: string, blob: Blob): void {
  const existing = objectUrlCache.get(cacheKey)
  if (existing) {
    if (existing.revokeTimer) {
      clearTimeout(existing.revokeTimer)
      existing.revokeTimer = null
    }
    if (existing.refs <= 0) scheduleIdleRevoke(cacheKey)
    return
  }
  objectUrlCache.set(cacheKey, {
    url: URL.createObjectURL(blob),
    refs: 0,
    revokeTimer: null,
  })
  scheduleIdleRevoke(cacheKey)
}

function scheduleIdleRevoke(cacheKey: string): void {
  const entry = objectUrlCache.get(cacheKey)
  if (!entry || entry.refs > 0) return
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer)
  entry.revokeTimer = setTimeout(() => {
    const cur = objectUrlCache.get(cacheKey)
    if (!cur || cur.refs > 0) return
    URL.revokeObjectURL(cur.url)
    objectUrlCache.delete(cacheKey)
  }, OBJECT_URL_REVOKE_DELAY_MS)
}

/** Prime preview + full keys used by MediaImage / viewers. */
export function primeAttachmentObjectUrls(
  mxcUrl: string,
  blob: Blob,
  mime: string,
): void {
  const keys = [
    `preview:${mxcUrl}|${mime}`,
    `full:${mxcUrl}|${mime}`,
    `viewer:${mxcUrl}|${mime}`,
  ]
  for (const key of keys) primeCachedObjectUrl(key, blob)
}

/** Cap parallel media downloads so visible images are not starved. */
const MAX_MEDIA_DOWNLOADS = 3
let activeMediaDownloads = 0
const mediaWaitQueue: Array<() => void> = []

async function withMediaDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeMediaDownloads >= MAX_MEDIA_DOWNLOADS) {
    await new Promise<void>((resolve) => {
      mediaWaitQueue.push(resolve)
    })
  }
  activeMediaDownloads += 1
  try {
    return await fn()
  } finally {
    activeMediaDownloads -= 1
    mediaWaitQueue.shift()?.()
  }
}

/**
 * Get or create a cached object URL for `cacheKey`. Call `releaseCachedObjectUrl`
 * from effect cleanup (delayed revoke survives Strict Mode / virtualized remounts).
 */
export async function acquireCachedObjectUrl(
  cacheKey: string,
  factory: () => Promise<Blob>,
): Promise<string> {
  const existing = objectUrlCache.get(cacheKey)
  if (existing) {
    existing.refs += 1
    if (existing.revokeTimer) {
      clearTimeout(existing.revokeTimer)
      existing.revokeTimer = null
    }
    return existing.url
  }

  let pending = objectUrlInflight.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const blob = await withMediaDownloadSlot(factory)
      const url = URL.createObjectURL(blob)
      objectUrlCache.set(cacheKey, { url, refs: 0, revokeTimer: null })
      return url
    })().finally(() => {
      objectUrlInflight.delete(cacheKey)
    })
    objectUrlInflight.set(cacheKey, pending)
  }

  const url = await pending
  const entry = objectUrlCache.get(cacheKey)
  if (entry) {
    entry.refs += 1
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer)
      entry.revokeTimer = null
    }
  }
  return url
}

export function releaseCachedObjectUrl(cacheKey: string): void {
  const entry = objectUrlCache.get(cacheKey)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs > 0) return
  scheduleIdleRevoke(cacheKey)
}

/** Drop a broken blob URL immediately (e.g. browser reported load error). */
export function dropCachedObjectUrl(cacheKey: string): void {
  const entry = objectUrlCache.get(cacheKey)
  if (!entry) return
  if (entry.revokeTimer) clearTimeout(entry.revokeTimer)
  try {
    URL.revokeObjectURL(entry.url)
  } catch {
    /* ignore */
  }
  objectUrlCache.delete(cacheKey)
}

/**
 * Resolve an MXC URI to an authenticated HTTP URL (MSC3916) and download bytes.
 * If `encryptedFile` is provided, decrypt with matrix-encrypt-attachment.
 */
export async function downloadMatrixMedia(
  client: MatrixClient,
  mxcUrl: string,
  encryptedFile?: EncryptedAttachmentInfo | null,
  fallbackMime = 'application/octet-stream',
): Promise<Blob> {
  const local = getLocalMediaBlob(mxcUrl)
  if (local) return local

  const httpUrl = client.mxcUrlToHttp(
    mxcUrl,
    undefined,
    undefined,
    undefined,
    false,
    true, // allowRedirects
    true, // useAuthentication (MSC3916)
  );
  if (!httpUrl) {
    throw new Error('Invalid media URL');
  }

  const headers = { Authorization: 'Bearer ' + client.getAccessToken() };
  const response = await fetch(httpUrl, { headers });
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}`);
  }

  const buffer = await response.arrayBuffer();

  if (encryptedFile?.key) {
    const decrypted = await MatrixEncryptAttachment.decryptAttachment(
      buffer,
      encryptedFile as any,
    );
    return new Blob([decrypted], {
      type: encryptedFile.mimetype || fallbackMime,
    });
  }

  return new Blob([buffer], { type: fallbackMime });
}

/** Download MXC avatar/thumbnail bytes with auth (MSC3916). */
export async function downloadAuthenticatedMxc(
  client: MatrixClient,
  mxcUrl: string,
  size = 96,
): Promise<Blob> {
  const headers = { Authorization: 'Bearer ' + client.getAccessToken() }
  // Thumbnail first; fall back to full media (federated thumbs often 500).
  const candidates = [
    client.mxcUrlToHttp(mxcUrl, size, size, 'crop', false, true, true),
    client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true, true),
  ].filter((u): u is string => !!u)

  let lastError: Error | null = null
  for (const httpUrl of candidates) {
    try {
      const response = await fetch(httpUrl, { headers })
      if (response.ok) return response.blob()
      lastError = new Error(`Avatar HTTP ${response.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('Invalid avatar MXC URL')
}

export function mxcAvatarCacheKey(mxcUrl: string, size = 96): string {
  return `mxc-avatar:${mxcUrl}|${size}`
}

/** Cached authenticated avatar object URL — pair with `releaseAuthenticatedMxcObjectUrl`. */
export async function loadAuthenticatedMxcObjectUrl(
  client: MatrixClient,
  mxcUrl: string,
  size = 96,
): Promise<string> {
  return acquireCachedObjectUrl(mxcAvatarCacheKey(mxcUrl, size), () =>
    downloadAuthenticatedMxc(client, mxcUrl, size),
  )
}

export function releaseAuthenticatedMxcObjectUrl(
  mxcUrl: string,
  size = 96,
): void {
  releaseCachedObjectUrl(mxcAvatarCacheKey(mxcUrl, size))
}

export type MessageAttachmentContent = {
  url?: string
  file?: EncryptedAttachmentInfo
  info?: {
    mimetype?: string
    thumbnail_url?: string
    thumbnail_file?: EncryptedAttachmentInfo
    thumbnail_info?: { mimetype?: string }
  }
}

/** Prefer embedded thumbnail fields for fast chat previews. */
export function timelinePreviewContent(
  content: MessageAttachmentContent,
): MessageAttachmentContent {
  const info = content.info
  if (info?.thumbnail_file) {
    return {
      file: info.thumbnail_file,
      info: {
        mimetype: info.thumbnail_info?.mimetype || 'image/jpeg',
      },
    }
  }
  if (info?.thumbnail_url) {
    return {
      url: info.thumbnail_url,
      info: {
        mimetype: info.thumbnail_info?.mimetype || 'image/jpeg',
      },
    }
  }
  return content
}

/** Download media from message content (encrypted `file` or plaintext `url`). */
export async function downloadMessageAttachment(
  client: MatrixClient,
  content: MessageAttachmentContent,
  fallbackMime = 'application/octet-stream',
): Promise<Blob> {
  const encrypted = content.file
  const mxc = encrypted?.url || content.url
  if (!mxc) {
    throw new Error('No media URL in message content')
  }
  const mime =
    encrypted?.mimetype || content.info?.mimetype || fallbackMime
  return downloadMatrixMedia(client, mxc, encrypted ?? null, mime)
}

/**
 * Smaller/faster blob for timeline bubbles: thumbnail when present,
 * else server-scaled plaintext MXC; encrypted full file as last resort.
 */
export async function downloadMessageAttachmentPreview(
  client: MatrixClient,
  content: MessageAttachmentContent,
  maxEdge = 720,
  fallbackMime = 'image/jpeg',
): Promise<Blob> {
  const preview = timelinePreviewContent(content)
  const encrypted = preview.file

  const previewMxc = encrypted?.url || preview.url || content.url
  if (previewMxc && getLocalMediaBlob(previewMxc)) {
    return getLocalMediaBlob(previewMxc)!
  }

  if (encrypted?.key) {
    return downloadMessageAttachment(client, preview, fallbackMime)
  }

  const mxc = preview.url || content.url
  if (!mxc) {
    throw new Error('No media URL in message content')
  }

  const headers = { Authorization: 'Bearer ' + client.getAccessToken() }
  const candidates = [
    client.mxcUrlToHttp(mxc, maxEdge, maxEdge, 'scale', false, true, true),
    client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true, true),
  ].filter((u): u is string => !!u)

  let lastError: Error | null = null
  for (const httpUrl of candidates) {
    try {
      const response = await fetch(httpUrl, { headers })
      if (response.ok) {
        const mime =
          preview.info?.mimetype || content.info?.mimetype || fallbackMime
        return new Blob([await response.arrayBuffer()], { type: mime })
      }
      lastError = new Error(`HTTP error ${response.status}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('Invalid media URL')
}
