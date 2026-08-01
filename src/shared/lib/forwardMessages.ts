import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { EventType } from 'matrix-js-sdk'
import { matrixService } from '@/shared/api/MatrixService'
import { downloadMessageAttachment } from '@/shared/lib/matrixMedia'
import {
  ALBUM_CAPTION_KEY,
  ALBUM_ID_KEY,
  createAlbumId,
  sendMediaMessage,
  sendStickerOrGif,
} from '@/shared/lib/sendMedia'

function canForwardEvent(event: MatrixEvent): boolean {
  if (event.isRedacted()) return false
  if (event.isDecryptionFailure()) return false
  const type = event.getType()
  if (type === 'm.sticker') return true
  if (type !== 'm.room.message' && type !== EventType.RoomMessage) return false
  const body = event.getContent()?.body
  if (typeof body === 'string' && body.startsWith('Unable to decrypt')) {
    return false
  }
  return true
}

function isImageEvent(event: MatrixEvent): boolean {
  if (event.getType() === 'm.sticker') return false
  return event.getContent()?.msgtype === 'm.image'
}

function isStickerEvent(event: MatrixEvent): boolean {
  return event.getType() === 'm.sticker'
}

function isMediaMsgtype(msgtype: unknown): boolean {
  return (
    msgtype === 'm.image' ||
    msgtype === 'm.file' ||
    msgtype === 'm.audio' ||
    msgtype === 'm.video'
  )
}

/** Display name + Matrix ID tag, e.g. `Ekaterina (@ekaterina.support:adw.team)` */
function senderAttribution(event: MatrixEvent): {
  name: string
  mxid: string
  line: string
} {
  const mxid = event.getSender() || ''
  const name =
    event.sender?.name ||
    (mxid.includes(':') ? mxid.split(':')[0].slice(1) : '') ||
    mxid ||
    'Unknown'
  const tag = mxid || name
  return { name, mxid: tag, line: `${name} (${tag})` }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Stable accent for HTML `<font color>` (works in Element / our client). */
function attributionColor(mxid: string): string {
  const colors = [
    '#e17076',
    '#faa774',
    '#e5b55d',
    '#7bc862',
    '#6ec9cb',
    '#65aadd',
    '#a695e7',
    '#ee7aae',
  ]
  let hash = 0
  for (let i = 0; i < mxid.length; i++) {
    hash = (hash << 5) - hash + mxid.charCodeAt(i)
    hash |= 0
  }
  return colors[Math.abs(hash) % colors.length]
}

/** HTML shell: colored name + matrix.to tag inside a blockquote. */
function attributionHtml(name: string, mxid: string): string {
  const color = attributionColor(mxid)
  const safeName = escapeHtml(name)
  const safeMxid = escapeHtml(mxid)
  const href = `https://matrix.to/#/${encodeURIComponent(mxid)}`
  return (
    `<blockquote data-mx-forward="1">` +
    `<font color="${color}"><strong>${safeName}</strong></font>` +
    ` (<a href="${href}">${safeMxid}</a>)` +
    `</blockquote>`
  )
}

async function prepareRoom(client: MatrixClient, room: Room): Promise<void> {
  if (!room.hasEncryptionStateEvent()) return
  await matrixService.ensureCryptoReady()
  if (!client.getCrypto()) {
    throw new Error(
      'Комната зашифрована, но E2EE не готов. Перезапустите приложение.',
    )
  }
  client.getCrypto()?.prepareToEncrypt(room)
}

async function blobToFile(
  blob: Blob,
  name: string,
  mime?: string,
): Promise<File> {
  const type = mime || blob.type || 'application/octet-stream'
  return new File([blob], name || 'file', { type })
}

/** Short header message: `Name (@mxid)` before media / stickers. */
async function sendAttributionHeader(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  albumId?: string,
): Promise<void> {
  const { name, mxid, line } = senderAttribution(event)
  await prepareRoom(client, room)
  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body: `↪ ${line}`,
    format: 'org.matrix.custom.html',
    formatted_body: attributionHtml(name, mxid),
  }
  if (albumId) content[ALBUM_ID_KEY] = albumId
  await client.sendMessage(room.roomId, content as any)
}

function withAttributionCaption(
  event: MatrixEvent,
  caption?: string,
): string {
  const { line } = senderAttribution(event)
  const extra = caption?.trim()
  return extra ? `↪ ${line}\n${extra}` : `↪ ${line}`
}

async function forwardTextOrEmote(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): Promise<void> {
  const content = event.getContent() as Record<string, unknown>
  const msgtype =
    content.msgtype === 'm.emote' ? 'm.emote' : 'm.text'
  const rawBody =
    typeof content.body === 'string' ? content.body : ''
  const { name, mxid, line } = senderAttribution(event)
  const body =
    msgtype === 'm.emote'
      ? `↪ ${line}\n* ${rawBody}`
      : `↪ ${line}\n\n${rawBody}`

  const next: Record<string, unknown> = {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
  }

  const header = attributionHtml(name, mxid)
  if (
    content.format === 'org.matrix.custom.html' &&
    typeof content.formatted_body === 'string'
  ) {
    next.formatted_body = `${header}${content.formatted_body}`
  } else {
    const safe = escapeHtml(rawBody).replace(/\n/g, '<br/>')
    next.formatted_body =
      msgtype === 'm.emote'
        ? `${header}<p><em>${safe}</em></p>`
        : `${header}<p>${safe}</p>`
  }

  await prepareRoom(client, room)
  await client.sendEvent(room.roomId, EventType.RoomMessage, next as any)
}

async function forwardSticker(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): Promise<void> {
  await sendAttributionHeader(client, room, event)
  const content = event.getContent() as {
    body?: string
    url?: string
    file?: any
    info?: { mimetype?: string; w?: number; h?: number }
  }
  const blob = await downloadMessageAttachment(
    client,
    content,
    content.info?.mimetype || 'image/png',
  )
  await sendStickerOrGif(client, room, blob, {
    body: content.body || 'sticker',
    asSticker: true,
    w: content.info?.w,
    h: content.info?.h,
  })
}

async function forwardMediaFile(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  albumId?: string,
  caption?: string,
  /** When true, caption already includes attribution (album header sent separately). */
  skipAttribution?: boolean,
): Promise<void> {
  const content = event.getContent() as {
    msgtype?: string
    body?: string
    url?: string
    file?: any
    info?: { mimetype?: string; w?: number; h?: number; size?: number }
  }
  const msgtype = content.msgtype || 'm.file'
  const mime =
    content.info?.mimetype ||
    (msgtype === 'm.image'
      ? 'image/jpeg'
      : msgtype === 'm.audio'
        ? 'audio/ogg'
        : msgtype === 'm.video'
          ? 'video/mp4'
          : 'application/octet-stream')
  const blob = await downloadMessageAttachment(client, content, mime)
  const name =
    (typeof content.body === 'string' && content.body.trim()) ||
    `file.${mime.split('/')[1] || 'bin'}`
  const file = await blobToFile(blob, name, mime)
  const attributedCaption = skipAttribution
    ? caption?.trim() || undefined
    : withAttributionCaption(event, caption)

  if (msgtype === 'm.image' || msgtype === 'm.file' || !isMediaMsgtype(msgtype)) {
    await sendMediaMessage(client, room.roomId, file, {
      albumId,
      caption: attributedCaption,
      encrypted: room.hasEncryptionStateEvent(),
      room,
    })
    return
  }

  await prepareRoom(client, room)
  const encrypted = room.hasEncryptionStateEvent()
  const info: Record<string, unknown> = {
    mimetype: mime,
    size: blob.size,
    ...(content.info?.w ? { w: content.info.w } : {}),
    ...(content.info?.h ? { h: content.info.h } : {}),
  }
  const out: Record<string, unknown> = {
    msgtype,
    body: name,
    info,
  }
  if (albumId) out[ALBUM_ID_KEY] = albumId
  if (attributedCaption) out[ALBUM_CAPTION_KEY] = attributedCaption

  if (encrypted) {
    const MatrixEncryptAttachment = await import('matrix-encrypt-attachment')
    const plaintext = await blob.arrayBuffer()
    const { data, info: encInfo } =
      await MatrixEncryptAttachment.encryptAttachment(plaintext)
    const encBlob = new Blob([data], { type: 'application/octet-stream' })
    const uploaded = await client.uploadContent(encBlob, {
      type: 'application/octet-stream',
      name,
    })
    out.file = {
      ...encInfo,
      url: uploaded.content_uri,
      mimetype: mime,
    }
  } else {
    const uploaded = await client.uploadContent(file, {
      type: mime,
      name,
    })
    out.url = uploaded.content_uri
  }
  await client.sendMessage(room.roomId, out as any)
}

async function forwardImageBatch(
  client: MatrixClient,
  room: Room,
  events: MatrixEvent[],
): Promise<void> {
  if (events.length === 0) return
  const root = events.find(isImageEvent) || events[0]

  if (events.filter(isImageEvent).length <= 1) {
    const imageEv = events.find(isImageEvent) || events[0]
    let caption =
      typeof (imageEv.getContent() as any)[ALBUM_CAPTION_KEY] === 'string'
        ? ((imageEv.getContent() as any)[ALBUM_CAPTION_KEY] as string)
        : undefined
    const textEv = events.find((e) => e.getContent()?.msgtype === 'm.text')
    if (!caption && textEv) {
      const body = textEv.getContent()?.body
      if (typeof body === 'string') caption = body
    }
    await forwardMediaFile(client, room, imageEv, undefined, caption)
    return
  }

  const albumId = createAlbumId()
  let caption =
    events
      .map((e) => (e.getContent() as any)[ALBUM_CAPTION_KEY])
      .find((c): c is string => typeof c === 'string' && !!c.trim()) || ''

  if (!caption) {
    const textEv = events.find((e) => e.getContent()?.msgtype === 'm.text')
    if (textEv) {
      const body = textEv.getContent()?.body
      if (typeof body === 'string') caption = body
    }
  }

  await sendAttributionHeader(client, room, root, albumId)

  const imageEvents = events.filter(isImageEvent)
  for (const imageEv of imageEvents) {
    await forwardMediaFile(client, room, imageEv, albumId, undefined, true)
  }
  if (caption.trim()) {
    await prepareRoom(client, room)
    await client.sendMessage(room.roomId, {
      msgtype: 'm.text',
      body: caption.trim(),
      [ALBUM_ID_KEY]: albumId,
    } as any)
  }
}

async function forwardEventsToRoom(
  client: MatrixClient,
  room: Room,
  events: MatrixEvent[],
): Promise<void> {
  await prepareRoom(client, room)
  let i = 0
  while (i < events.length) {
    const ev = events[i]
    if (isStickerEvent(ev)) {
      await forwardSticker(client, room, ev)
      i += 1
      continue
    }
    if (isImageEvent(ev)) {
      const batch: MatrixEvent[] = []
      while (i < events.length && isImageEvent(events[i])) {
        batch.push(events[i])
        i += 1
      }
      if (
        i < events.length &&
        events[i].getContent()?.msgtype === 'm.text' &&
        (events[i].getContent() as any)[ALBUM_ID_KEY]
      ) {
        batch.push(events[i])
        i += 1
      }
      await forwardImageBatch(client, room, batch)
      continue
    }
    const msgtype = ev.getContent()?.msgtype
    if (isMediaMsgtype(msgtype)) {
      await forwardMediaFile(client, room, ev)
      i += 1
      continue
    }
    if (msgtype === 'm.text' || msgtype === 'm.emote') {
      await forwardTextOrEmote(client, room, ev)
      i += 1
      continue
    }
    i += 1
  }
}

export type ForwardResult = {
  okRooms: string[]
  failed: Array<{ roomId: string; error: string }>
}

/** Re-send message copies into each target room (Matrix has no native forward). */
export async function forwardEventsToRooms(
  client: MatrixClient,
  events: MatrixEvent[],
  roomIds: string[],
): Promise<ForwardResult> {
  const usable = events.filter(canForwardEvent)
  if (!usable.length) {
    throw new Error('Нечего пересылать')
  }
  if (!roomIds.length) {
    throw new Error('Выберите хотя бы один чат')
  }

  const okRooms: string[] = []
  const failed: Array<{ roomId: string; error: string }> = []

  for (const roomId of roomIds) {
    const room = client.getRoom(roomId)
    if (!room) {
      failed.push({ roomId, error: 'Чат не найден' })
      continue
    }
    try {
      await forwardEventsToRoom(client, room, usable)
      okRooms.push(roomId)
    } catch (err) {
      failed.push({
        roomId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { okRooms, failed }
}

export { canForwardEvent }
