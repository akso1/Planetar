import * as MatrixEncryptAttachment from 'matrix-encrypt-attachment'
import {
  EventStatus,
  EventType,
  MatrixEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk'
import { matrixService } from '@/shared/api/MatrixService'
import { buildThreadRelation } from '@/shared/lib/threads'
import {
  primeAttachmentObjectUrls,
  registerLocalMediaBlob,
  unregisterLocalMediaBlob,
} from '@/shared/lib/matrixMedia'

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
 * m.image / m.video / m.audio / m.file.
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
    /** MSC3440 thread root — when set, attaches m.thread relation */
    threadRootId?: string
    /** Override msgtype / info (e.g. voice notes) */
    msgtype?: 'm.image' | 'm.video' | 'm.audio' | 'm.file'
    extraInfo?: Record<string, unknown>
    body?: string
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
  const msgtype =
    opts.msgtype ??
    (isImageFile(file)
      ? 'm.image'
      : isVideoFile(file)
        ? 'm.video'
        : isAudioFile(file)
          ? 'm.audio'
          : 'm.file')
  const info: Record<string, unknown> = {
    mimetype: file.type || 'application/octet-stream',
    size: file.size,
    ...dims,
    ...opts.extraInfo,
  }

  const content: Record<string, unknown> = {
    msgtype,
    body: opts.body ?? file.name,
    info,
  }

  if (opts.albumId) {
    content[ALBUM_ID_KEY] = opts.albumId
  }
  if (opts.caption) {
    content[ALBUM_CAPTION_KEY] = opts.caption
  }
  if (opts.threadRootId) {
    Object.assign(
      content,
      buildThreadRelation(opts.threadRootId, opts.replyToEventId || opts.threadRootId),
    )
  } else if (opts.replyToEventId) {
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

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/')
}

/** Recorded voice note as m.audio (MSC3245-ish: info.duration + voice flag). */
export async function sendVoiceMessage(
  client: MatrixClient,
  room: Room,
  blob: Blob,
  opts: {
    durationMs: number
    mimeType: string
    fileName: string
    replyToEventId?: string
    threadRootId?: string | null
  },
): Promise<void> {
  const file = new File([blob], opts.fileName, {
    type: opts.mimeType || blob.type || 'audio/webm',
  })
  const encrypted = room.hasEncryptionStateEvent()
  await sendMediaMessage(client, room.roomId, file, {
    encrypted,
    room,
    replyToEventId: opts.replyToEventId,
    threadRootId: opts.threadRootId || undefined,
    msgtype: 'm.audio',
    body: 'Голосовое сообщение',
    extraInfo: {
      duration: Math.round(opts.durationMs),
      // Element / Telegram-like hint that this is a voice message
      ['org.matrix.msc3245.voice']: {},
    },
  })
}

/** Send multiple files as one album + optional caption text. */
export async function sendAlbumMessages(
  client: MatrixClient,
  room: Room,
  files: File[],
  caption: string,
  replyToEventId?: string,
  captionHtml?: { format: string; formatted_body: string },
  threadRootId?: string | null,
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
      // Single attachment: caption lives on the same event (one bubble).
      // Multi-file albums: caption is a follow-up m.text with the same album id.
      caption:
        isFirst && !albumId && trimmedCaption ? trimmedCaption : undefined,
      encrypted,
      room,
      replyToEventId: isFirst ? replyToEventId : undefined,
      threadRootId: isFirst ? threadRootId || undefined : undefined,
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
    if (threadRootId) {
      Object.assign(
        content,
        buildThreadRelation(threadRootId, replyToEventId || threadRootId),
      )
    }
    await client.sendMessage(roomId, content as any)
  }
}

/**
 * Send a sticker (m.sticker) or GIF/image (m.image) from a Blob.
 *
 * Shows a local echo immediately (synthetic mxc + media cache), then uploads
 * and completes the send — so animated stickers/GIFs do not wait on upload
 * before appearing in the timeline.
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
    replyToEventId?: string
    threadRootId?: string | null
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

  const attachThread = (content: Record<string, unknown>) => {
    if (opts.threadRootId) {
      Object.assign(
        content,
        buildThreadRelation(
          opts.threadRootId,
          opts.replyToEventId || opts.threadRootId,
        ),
      )
    } else if (opts.replyToEventId) {
      content['m.relates_to'] = {
        'm.in_reply_to': { event_id: opts.replyToEventId },
      }
    }
  }

  const localMxc = registerLocalMediaBlob(blob)
  primeAttachmentObjectUrls(localMxc, blob, mime)

  const content: Record<string, unknown> = opts.asSticker
    ? {
        body: opts.body,
        info,
        url: localMxc,
      }
    : {
        msgtype: 'm.image',
        body: opts.body,
        info,
        url: localMxc,
      }
  attachThread(content)

  const txnId = client.makeTxnId()
  const userId = client.getUserId()
  const localEvent = new MatrixEvent({
    type: opts.asSticker ? ('m.sticker' as const) : EventType.RoomMessage,
    content,
    event_id: `~${room.roomId}:${txnId}`,
    user_id: userId ?? undefined,
    sender: userId ?? undefined,
    room_id: room.roomId,
    origin_server_ts: Date.now(),
  })
  localEvent.setTxnId(txnId)
  localEvent.setStatus(EventStatus.SENDING)

  if (opts.threadRootId) {
    const thread = room.getThread(opts.threadRootId)
    if (thread) localEvent.setThread(thread)
  }

  // Local echo now — sticker/GIF paints from the in-memory blob while we upload.
  room.addPendingEvent(localEvent, txnId)
  if (localEvent.status === EventStatus.NOT_SENT) {
    unregisterLocalMediaBlob(localMxc)
    throw new Error('Event blocked by other events not yet sent')
  }

  try {
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

    const wire = localEvent.getWireContent() as Record<string, unknown>
    delete wire.url
    delete wire.file
    if (url) {
      wire.url = url
      primeAttachmentObjectUrls(url, blob, mime)
    }
    if (fileField) {
      wire.file = fileField
      const encMxc = typeof fileField.url === 'string' ? fileField.url : null
      if (encMxc) primeAttachmentObjectUrls(encMxc, blob, mime)
    }

    // Finish the same pending event (encrypt room event if needed + HTTP send).
    type EncryptSendClient = MatrixClient & {
      encryptAndSendEvent: (
        room: Room | null,
        event: MatrixEvent,
      ) => Promise<unknown>
    }
    await (client as EncryptSendClient).encryptAndSendEvent(room, localEvent)
  } catch (err) {
    try {
      // cancelPendingEvent only accepts QUEUED / NOT_SENT / ENCRYPTING — not SENDING
      if (localEvent.status === EventStatus.SENDING) {
        localEvent.setStatus(EventStatus.NOT_SENT)
      }
      if (
        localEvent.status === EventStatus.NOT_SENT ||
        localEvent.status === EventStatus.QUEUED ||
        localEvent.status === EventStatus.ENCRYPTING
      ) {
        client.cancelPendingEvent(localEvent)
      }
    } catch {
      /* already removed / sent */
    }
    throw err
  } finally {
    unregisterLocalMediaBlob(localMxc)
  }
}
