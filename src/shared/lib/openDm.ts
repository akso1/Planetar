import type { MatrixClient } from 'matrix-js-sdk'
import { Preset } from 'matrix-js-sdk'
import { isDirectRoom } from '@/entities/session/model/room.store'

/** Find existing DM or create a new one; returns room id. */
export async function openOrCreateDirectChat(
  client: MatrixClient,
  userId: string,
): Promise<string> {
  const myId = client.getUserId()
  if (!userId || userId === myId) {
    throw new Error('Cannot open DM with yourself')
  }

  const existing = client.getRooms().find((room) => {
    if (!isDirectRoom(room)) return false
    return room.getJoinedMembers().some((m) => m.userId === userId)
  })
  if (existing) return existing.roomId

  const { room_id } = await client.createRoom({
    preset: Preset.TrustedPrivateChat,
    invite: [userId],
    is_direct: true,
  })
  return room_id
}

/** Parse @user:server from matrix.to URL or raw mxid. */
export function userIdFromMatrixTo(href: string | undefined | null): string | null {
  if (!href) return null
  try {
    if (href.startsWith('@') && href.includes(':')) return href
    const u = new URL(href)
    if (u.hostname !== 'matrix.to') return null
    const hash = decodeURIComponent(u.hash.replace(/^#\/?/, ''))
    if (hash.startsWith('@') && hash.includes(':')) {
      return hash.split('?')[0]
    }
  } catch {
    /* ignore */
  }
  return null
}
