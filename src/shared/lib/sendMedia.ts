import * as MatrixEncryptAttachment from 'matrix-encrypt-attachment'
import type { MatrixClient, Room } from 'matrix-js-sdk'
import { matrixService } from '@/shared/api/MatrixService'

/** Custom field linking multi-attachment messages into one album */
export const ALBUM_ID_KEY = 'custom.album_id'
export const ALBUM_CAPTION_KEY = 'custom.album_caption'
/** Which album media event ids this message replies to (Telegram-style) */
export const REPLY_MEDIA_IDS_KEY = 'custom.reply_media_ids'

export function createAlbumId(): string {
  return `album_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/')
}

async function readImageSize(
  file: File,
): Promise<{ w?: number; h?: number }> {
  if (!isImageFile(file)) return {}
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Failed to load image'))
      el.src = objectUrl
    })
    return { w: img.naturalWidth, h: img.naturalHeight }
  } catch {
    return {}
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function readVideoMeta(
  file: File,
): Promise<{ w?: number; h?: number; duration?: number }> {
  if (!isVideoFile(file)) return {}
  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise((resolve) => {
      const el = document.createElement('video')
      el.preload = 'metadata'
      el.onloadedmetadata = () => {
        resolve({
          w: el.videoWidth || undefined,
          h: el.videoHeight || undefined,
          duration: Number.isFinite(el.duration)
            ? Math.round(el.duration * 1000)
            : undefined,
        })
      }
      el.onerror = () => resolve({})
      el.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/** Make sure Megolm crypto is available before encrypting room events. */
async function prepareEncryptedSend(
  client: MatrixClient,
  room: Room,
): Promise<void> {
  await matrixService.ensureCryptoReady()
  if (!client.getCrypto()) {
    throw new Error(
      'This room is encrypted, but end-to-end encryption failed to start. Try restarting the app or signing in again.',
    )
  }
  client.getCrypto()?.prepareToEncrypt(room)
}

/**
 * Upload one file (encrypt attachment when room is E2EE) and send as
 * m.image / m.video / m.file.
 * The Matrix event itself is Megolm-encrypted by the SDK when the room has encryption.
 */
export async function sendMediaMessage(
  client: MatrixClient,
  roomId: string,
  file: File,
  opts: {
    albumId?: string
    caption?: string
    encrypted: boolean
    room?: Room
    /** Attach m.in_reply_to when this is the first item in a reply */
    replyToEventId?: string
  },
): Promise<void> {
  const room = opts.room ?? client.getRoom(roomId) ?? undefined
  if (opts.encrypted && room) {
    await prepareEncryptedSend(client, room)
  }

  const dims = isImageFile(file)
    ? await readImageSize(file)
    : isVideoFile(file)
      ? await readVideoMeta(file)
      : {}
  const msgtype = isImageFile(file)
    ? 'm.image'
    : isVideoFile(file)
      ? 'm.video'
      : 'm.file'
  const info: Record<string, unknown> = {
    mimetype: file.type || 'application/octet-stream',
    size: file.size,
    ...dims,
  }

  const content: Record<string, unknown> = {
    msgtype,
    body: file.name,
    info,
  }

  if (opts.albumId) {
    content[ALBUM_ID_KEY] = opts.albumId
  }
  if (opts.caption) {
    content[ALBUM_CAPTION_KEY] = opts.caption
  }
  if (opts.replyToEventId) {
    content['m.relates_to'] = {
      'm.in_reply_to': { event_id: opts.replyToEventId },
    }
  }

  if (opts.encrypted) {
    const plaintext = await file.arrayBuffer()
    const { data, info: encInfo } =
      await MatrixEncryptAttachment.encryptAttachment(plaintext)
    const blob = new Blob([data], { type: 'application/octet-stream' })
    const uploaded = await client.uploadContent(blob, {
      type: 'application/octet-stream',
      name: file.name,
    })
    content.file = {
      ...encInfo,
      url: uploaded.content_uri,
      mimetype: file.type || 'application/octet-stream',
    }
  } else {
    const uploaded = await client.uploadContent(file, {
      type: file.type || undefined,
      name: file.name,
    })
    content.url = uploaded.content_uri
  }

  await client.sendMessage(roomId, content as any)
}

/** Send multiple files as one album + optional caption text. */
export async function sendAlbumMessages(
  client: MatrixClient,
  room: Room,
  files: File[],
  caption: string,
  replyToEventId?: string,
  captionHtml?: { format: string; formatted_body: string },
): Promise<void> {
  if (files.length === 0) return

  const roomId = room.roomId
  const encrypted = room.hasEncryptionStateEvent()
  if (encrypted) {
    await prepareEncryptedSend(client, room)
  }

  const albumId = files.length > 1 ? createAlbumId() : undefined
  const trimmedCaption = caption.trim()

  for (let i = 0; i < files.length; i++) {
    const isFirst = i === 0
    await sendMediaMessage(client, roomId, files[i], {
      albumId,
      caption:
        !albumId && isFirst && trimmedCaption ? trimmedCaption : undefined,
      encrypted,
      room,
      replyToEventId: isFirst ? replyToEventId : undefined,
    })
  }

  if (trimmedCaption && albumId) {
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: trimmedCaption,
      [ALBUM_ID_KEY]: albumId,
    }
    if (captionHtml?.format && captionHtml.formatted_body) {
      content.format = captionHtml.format
      content.formatted_body = captionHtml.formatted_body
    }
    await client.sendMessage(roomId, content as any)
  }
}

/**
 * Send a sticker (m.sticker) or GIF/image (m.image) from a Blob.
 */
export async function sendStickerOrGif(
  client: MatrixClient,
  room: Room,
  blob: Blob,
  opts: {
    body: string
    asSticker?: boolean
    w?: number
    h?: number
  },
): Promise<void> {
  const encrypted = room.hasEncryptionStateEvent()
  if (encrypted) {
    await prepareEncryptedSend(client, room)
  }

  const mime = blob.type || 'image/png'
  const file = new File([blob], opts.body || 'sticker', { type: mime })
  const dims =
    opts.w && opts.h
      ? { w: opts.w, h: opts.h }
      : await readImageSize(file)

  const info: Record<string, unknown> = {
    mimetype: mime,
    size: blob.size,
    ...dims,
  }

  let url: string | undefined
  let fileField: Record<string, unknown> | undefined

  if (encrypted) {
    const plaintext = await blob.arrayBuffer()
    const { data, info: encInfo } =
      await MatrixEncryptAttachment.encryptAttachment(plaintext)
    const encBlob = new Blob([data], { type: 'application/octet-stream' })
    const uploaded = await client.uploadContent(encBlob, {
      type: 'application/octet-stream',
      name: file.name,
    })
    fileField = {
      ...encInfo,
      url: uploaded.content_uri,
      mimetype: mime,
    }
  } else {
    const uploaded = await client.uploadContent(file, {
      type: mime,
      name: file.name,
    })
    url = uploaded.content_uri
  }

  if (opts.asSticker) {
    const content: Record<string, unknown> = {
      body: opts.body,
      info,
    }
    if (url) content.url = url
    if (fileField) content.file = fileField
    await client.sendEvent(room.roomId, 'm.sticker' as any, content as any)
    return
  }

  const content: Record<string, unknown> = {
    msgtype: 'm.image',
    body: opts.body,
    info,
  }
  if (url) content.url = url
  if (fileField) content.file = fileField
  await client.sendMessage(room.roomId, content as any)
}
