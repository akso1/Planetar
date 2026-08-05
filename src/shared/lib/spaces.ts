import {
  EventType,
  Preset,
  RoomType,
  Visibility,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk'

function viaFor(client: MatrixClient): string[] {
  const domain = client.getDomain()
  return domain ? [domain] : []
}

/** May send m.space.child on this space. */
export function canManageSpaceChildren(
  space: Room,
  actorId: string | null | undefined,
): boolean {
  if (!actorId || !space.isSpaceRoom()) return false
  return space.currentState.maySendStateEvent(EventType.SpaceChild, actorId)
}

export function isRoomInSpace(space: Room, childRoomId: string): boolean {
  const ev = space.currentState.getStateEvents(EventType.SpaceChild, childRoomId)
  if (!ev) return false
  const content = ev.getContent() as { via?: string[] }
  return Array.isArray(content.via) && content.via.length > 0
}

/** Joined non-space rooms that are not already children of this space. */
export function roomsEligibleForSpace(
  client: MatrixClient,
  space: Room,
): Room[] {
  return client
    .getRooms()
    .filter(
      (r) =>
        r.getMyMembership() === 'join' &&
        !r.isSpaceRoom() &&
        r.roomId !== space.roomId &&
        !isRoomInSpace(space, r.roomId),
    )
    .sort((a, b) =>
      (a.name || a.roomId).localeCompare(b.name || b.roomId, undefined, {
        sensitivity: 'base',
      }),
    )
}

export async function createSpace(
  client: MatrixClient,
  opts: { name: string; topic?: string },
): Promise<string> {
  const name = opts.name.trim()
  if (!name) throw new Error('Укажите название пространства')

  const { room_id } = await client.createRoom({
    name,
    topic: opts.topic?.trim() || undefined,
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    creation_content: { type: RoomType.Space },
    power_level_content_override: {
      events_default: 100,
      invite: 50,
    },
  })
  return room_id
}

export async function createRoomInSpace(
  client: MatrixClient,
  space: Room,
  opts: { name: string; topic?: string },
): Promise<string> {
  const name = opts.name.trim()
  if (!name) throw new Error('Укажите название чата')
  if (!canManageSpaceChildren(space, client.getUserId())) {
    throw new Error('Недостаточно прав, чтобы добавить чат в пространство')
  }

  const { room_id } = await client.createRoom({
    name,
    topic: opts.topic?.trim() || undefined,
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
  })

  await addRoomToSpace(client, space, room_id)
  return room_id
}

export async function addRoomToSpace(
  client: MatrixClient,
  space: Room,
  childRoomId: string,
): Promise<void> {
  const me = client.getUserId()
  if (!canManageSpaceChildren(space, me)) {
    throw new Error('Недостаточно прав, чтобы изменить пространство')
  }
  if (childRoomId === space.roomId) {
    throw new Error('Нельзя добавить пространство в само себя')
  }

  const via = viaFor(client)
  await client.sendStateEvent(
    space.roomId,
    EventType.SpaceChild,
    { via },
    childRoomId,
  )

  // Best-effort parent link on the child (needs PL there).
  const child = client.getRoom(childRoomId)
  if (child && me && child.currentState.maySendStateEvent(EventType.SpaceParent, me)) {
    try {
      await client.sendStateEvent(
        childRoomId,
        EventType.SpaceParent,
        { via, canonical: true },
        space.roomId,
      )
    } catch {
      /* parent link is optional */
    }
  }
}

/** Remove child link (empty content without via). Parent link cleared best-effort. */
export async function removeRoomFromSpace(
  client: MatrixClient,
  space: Room,
  childRoomId: string,
): Promise<void> {
  const me = client.getUserId()
  if (!canManageSpaceChildren(space, me)) {
    throw new Error('Недостаточно прав, чтобы изменить пространство')
  }

  await client.sendStateEvent(space.roomId, EventType.SpaceChild, {}, childRoomId)

  const child = client.getRoom(childRoomId)
  if (child && me && child.currentState.maySendStateEvent(EventType.SpaceParent, me)) {
    try {
      await client.sendStateEvent(childRoomId, EventType.SpaceParent, {}, space.roomId)
    } catch {
      /* optional */
    }
  }
}
