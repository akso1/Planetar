import type { MatrixEvent, Room } from 'matrix-js-sdk'

export type MessageReader = {
  userId: string
  displayName: string
  /** Full Matrix ID, e.g. @user:server */
  mxid: string
  avatarMxc: string | null
}

function memberToReader(
  room: Room,
  userId: string,
): MessageReader {
  const member = room.getMember(userId)
  const displayName =
    member?.name ||
    userId.split(':')[0]?.substring(1) ||
    userId
  return {
    userId,
    displayName,
    mxid: userId,
    avatarMxc: member?.getMxcAvatarUrl?.() ?? null,
  }
}

/** Other joined members (excluding me). */
export function getOtherJoinedUserIds(
  room: Room,
  myUserId: string | null | undefined,
): string[] {
  if (!myUserId) return []
  return room
    .getJoinedMembers()
    .map((m) => m.userId)
    .filter((id): id is string => !!id && id !== myUserId)
}

/** Direct-like: exactly one other joined user. */
export function isDirectLikeRoom(
  room: Room,
  myUserId: string | null | undefined,
): boolean {
  return getOtherJoinedUserIds(room, myUserId).length === 1
}

export function getDirectPeerId(
  room: Room,
  myUserId: string | null | undefined,
): string | null {
  const others = getOtherJoinedUserIds(room, myUserId)
  if (others.length === 1) return others[0]
  // Soft fallback for quirky member lists in 1:1 rooms
  if (room.getJoinedMemberCount() <= 2 && others.length > 0) return others[0]
  return null
}

/**
 * Whether `userId` has publicly read at least up to `eventId`.
 * Uses SDK ordering + timestamp fallback for historical windows.
 */
export function hasUserReadMessage(
  room: Room,
  userId: string,
  eventId: string,
): boolean {
  if (!userId || !eventId || eventId.startsWith('~')) return false

  try {
    if (room.hasUserReadEvent(userId, eventId)) return true
  } catch {
    /* continue with fallbacks */
  }

  // Prefer real receipt, then synthesized
  let upTo: string | null = null
  try {
    upTo =
      room.getEventReadUpTo(userId, true) ||
      room.getEventReadUpTo(userId, false)
  } catch {
    upTo = null
  }
  if (!upTo) return false

  try {
    const cmp = room.compareEventOrdering?.(upTo, eventId)
    if (typeof cmp === 'number' && cmp >= 0) return true
  } catch {
    /* ignore */
  }

  const tip = room.findEventById(upTo)
  const ev = room.findEventById(eventId)
  if (tip && ev) {
    const tipTs = tip.getTs() || 0
    const evTs = ev.getTs() || 0
    if (tipTs > 0 && evTs > 0 && tipTs >= evTs) return true
  }
  return false
}

/**
 * Delivery ticks for own messages.
 * DM: based on the single peer. Groups: blue if ≥1 other has read.
 */
export function getOwnDeliveryStatus(
  room: Room,
  eventId: string | undefined,
  myUserId: string | null | undefined,
  isOwn: boolean,
): 'sent' | 'read' | null {
  if (!isOwn || !myUserId || !eventId || eventId.startsWith('~')) return null

  const others = getOtherJoinedUserIds(room, myUserId)
  if (others.length === 0) return 'sent'

  const peerId = getDirectPeerId(room, myUserId)
  if (peerId) {
    return hasUserReadMessage(room, peerId, eventId) ? 'read' : 'sent'
  }

  // Group: read if anyone else has read this far
  for (const id of others) {
    if (hasUserReadMessage(room, id, eventId)) return 'read'
  }
  return 'sent'
}

/** @deprecated use getOwnDeliveryStatus */
export function getOwnDmDeliveryStatus(
  room: Room,
  eventId: string | undefined,
  myUserId: string | null | undefined,
  isOwn: boolean,
): 'sent' | 'read' | null {
  return getOwnDeliveryStatus(room, eventId, myUserId, isOwn)
}

/**
 * Everyone (except me) who has read up to this event.
 */
export function getUsersWhoReadEvent(
  room: Room,
  eventId: string | undefined | null,
  myUserId: string | null | undefined,
): MessageReader[] {
  if (!eventId || eventId.startsWith('~')) return []
  const others = getOtherJoinedUserIds(room, myUserId)
  const out: MessageReader[] = []
  for (const userId of others) {
    if (hasUserReadMessage(room, userId, eventId)) {
      out.push(memberToReader(room, userId))
    }
  }
  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'ru', { sensitivity: 'base' }),
  )
  return out
}

/**
 * Users whose receipt tip is currently on this exact event
 * (avatar stack “docked” on this bubble).
 */
export function getReceiptTipReaders(
  room: Room,
  event: MatrixEvent | null | undefined,
  myUserId: string | null | undefined,
): MessageReader[] {
  if (!event) return []
  let tipUserIds: string[] = []
  try {
    tipUserIds = room.getUsersReadUpTo(event) || []
  } catch {
    return []
  }

  const seen = new Set<string>()
  const out: MessageReader[] = []
  for (const userId of tipUserIds) {
    if (!userId || userId === myUserId || seen.has(userId)) continue
    seen.add(userId)
    out.push(memberToReader(room, userId))
  }
  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, 'ru', { sensitivity: 'base' }),
  )
  return out
}

/** @deprecated alias */
export function getReadersForEvent(
  room: Room,
  event: MatrixEvent | null | undefined,
  myUserId: string | null | undefined,
): MessageReader[] {
  return getReceiptTipReaders(room, event, myUserId)
}
