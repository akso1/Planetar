import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk'

type PowerLevelsContent = {
  ban?: number
  kick?: number
  events?: Record<string, number>
  state_default?: number
  users?: Record<string, number>
  users_default?: number
}

export type MemberRole = 'owner' | 'admin' | 'mod' | 'member'

export type PowerRolePreset = {
  id: 'member' | 'mod' | 'admin'
  label: string
  level: number
}

export const POWER_ROLE_PRESETS: PowerRolePreset[] = [
  { id: 'member', label: 'Участник', level: 0 },
  { id: 'mod', label: 'Модер', level: 50 },
  { id: 'admin', label: 'Админ', level: 100 },
]

export function getRoomPowerLevels(room: Room): PowerLevelsContent {
  const ev = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')
  return (ev?.getContent() as PowerLevelsContent) || {}
}

export function getUserPowerLevel(room: Room, userId: string): number {
  const member = room.getMember(userId)
  if (member && typeof member.powerLevel === 'number') return member.powerLevel
  const pl = getRoomPowerLevels(room)
  return pl.users?.[userId] ?? pl.users_default ?? 0
}

/** Kick/ban requires enough PL for the action and strictly higher PL than the target. */
export function canModerateMember(
  room: Room,
  actorId: string | null | undefined,
  targetId: string,
  action: 'kick' | 'ban',
): boolean {
  if (!actorId || !targetId || actorId === targetId) return false
  const pl = getRoomPowerLevels(room)
  const myLevel = getUserPowerLevel(room, actorId)
  const theirLevel = getUserPowerLevel(room, targetId)
  const needed = action === 'kick' ? (pl.kick ?? 50) : (pl.ban ?? 50)
  return myLevel >= needed && myLevel > theirLevel
}

export function canUnbanMembers(
  room: Room,
  actorId: string | null | undefined,
): boolean {
  if (!actorId) return false
  const pl = getRoomPowerLevels(room)
  return getUserPowerLevel(room, actorId) >= (pl.ban ?? 50)
}

/** May edit m.room.power_levels and set target to a level strictly below own. */
export function canChangePowerLevel(
  room: Room,
  actorId: string | null | undefined,
  targetId: string,
  nextLevel: number,
): boolean {
  if (!actorId || !targetId || actorId === targetId) return false
  if (!Number.isFinite(nextLevel) || nextLevel < 0) return false
  const pl = getRoomPowerLevels(room)
  const myLevel = getUserPowerLevel(room, actorId)
  const theirLevel = getUserPowerLevel(room, targetId)
  const eventsPl = pl.events?.[EventType.RoomPowerLevels]
  const needed =
    typeof eventsPl === 'number' ? eventsPl : (pl.state_default ?? 50)
  if (myLevel < needed) return false
  if (myLevel <= theirLevel) return false
  // Cannot grant equal/higher than own level
  if (nextLevel >= myLevel) return false
  return true
}

export function availablePowerPresets(
  room: Room,
  actorId: string | null | undefined,
  targetId: string,
): PowerRolePreset[] {
  const defaults = getRoomPowerLevels(room).users_default ?? 0
  return POWER_ROLE_PRESETS.map((p) =>
    p.id === 'member' ? { ...p, level: defaults } : p,
  ).filter((p) => canChangePowerLevel(room, actorId, targetId, p.level))
}

export async function setMemberPowerLevel(
  client: MatrixClient,
  room: Room,
  targetId: string,
  level: number,
): Promise<void> {
  const current = getRoomPowerLevels(room)
  const users = { ...(current.users || {}) }
  const defaults = current.users_default ?? 0
  if (level === defaults) {
    delete users[targetId]
  } else {
    users[targetId] = level
  }
  await client.sendStateEvent(
    room.roomId,
    EventType.RoomPowerLevels,
    {
      ...current,
      users,
    },
    '',
  )
}

export function memberRoleInfo(
  room: Room,
  userId: string,
): { role: MemberRole; label: string } {
  const level = getUserPowerLevel(room, userId)
  const defaults = getRoomPowerLevels(room).users_default ?? 0
  if (level >= 100) return { role: 'owner', label: 'Владелец' }
  if (level >= 50) return { role: 'admin', label: 'Админ' }
  if (level > defaults) return { role: 'mod', label: 'Модер' }
  return { role: 'member', label: '' }
}

export function formatModerationError(err: unknown, fallback: string): string {
  const msg =
    err && typeof err === 'object' && 'message' in err
      ? String((err as { message?: unknown }).message || '')
      : String(err || '')
  const lower = msg.toLowerCase()
  if (lower.includes('m_forbidden') || lower.includes('forbidden')) {
    return 'Недостаточно прав для этого действия'
  }
  if (lower.includes('m_not_found') || lower.includes('not found')) {
    return 'Пользователь не найден в комнате'
  }
  return msg.trim() || fallback
}
