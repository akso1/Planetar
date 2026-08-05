import { formatDistanceToNowStrict } from 'date-fns'
import { ru } from 'date-fns/locale'
import type { User } from 'matrix-js-sdk'

/** Telegram-style presence / last-seen line for a DM peer. */
export function formatPresenceLabel(user: User | null | undefined): string | null {
  if (!user) return null

  const presence = (user.presence || '').toLowerCase()
  if (user.currentlyActive || presence === 'online') {
    return 'в сети'
  }
  if (presence === 'unavailable') {
    return 'отошёл'
  }

  let lastActiveTs = 0
  try {
    lastActiveTs = user.getLastActiveTs?.() ?? 0
  } catch {
    lastActiveTs = 0
  }
  if (!lastActiveTs && user.lastPresenceTs && user.lastActiveAgo != null) {
    lastActiveTs = user.lastPresenceTs - user.lastActiveAgo
  }
  if (!lastActiveTs || lastActiveTs <= 0) {
    if (presence === 'offline') return 'не в сети'
    return null
  }

  const ageMs = Date.now() - lastActiveTs
  if (ageMs < 60_000) return 'был(а) только что'
  if (ageMs < 0) return 'не в сети'

  try {
    const rel = formatDistanceToNowStrict(lastActiveTs, {
      addSuffix: true,
      locale: ru,
    })
    return `был(а) ${rel}`
  } catch {
    return 'не в сети'
  }
}

/** Other joined member in a 1:1 / notes-style room (not us). */
export function getDmPeerUserId(
  memberIds: string[],
  myUserId: string | null | undefined,
): string | null {
  if (!myUserId) return null
  const others = memberIds.filter((id) => id && id !== myUserId)
  if (others.length === 1) return others[0]
  return null
}
