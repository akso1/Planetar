import { create } from 'zustand'
import {
  ClientEvent,
  EventType,
  KnownMembership,
  Room,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk'
import { useRoomStore } from './room.store'

export type RoomInviteInfo = {
  roomId: string
  name: string
  isDirect: boolean
  inviterId: string | null
  inviterName: string | null
  avatarMxc: string | null
  memberCount: number
  ts: number
}

type InvitesState = {
  invites: RoomInviteInfo[]
  busyRoomId: string | null
  error: string | null
  actions: {
    init: (client: MatrixClient) => void
    cleanup: () => void
    refresh: () => void
    accept: (roomId: string) => Promise<void>
    decline: (roomId: string) => Promise<void>
  }
}

function displayNameForUser(client: MatrixClient, userId: string): string {
  const user = client.getUser(userId)
  if (user?.displayName) return user.displayName
  const local = userId.split(':')[0]?.replace(/^@/, '')
  return local || userId
}

function memberInviteEvent(
  room: Room,
  myUserId: string,
): MatrixEvent | null {
  try {
    const ev = room.currentState.getStateEvents(EventType.RoomMember, myUserId)
    return (ev as MatrixEvent | null) ?? null
  } catch {
    return null
  }
}

function findInviterId(room: Room, myUserId: string | null): string | null {
  const dm = room.getDMInviter?.()
  if (dm) return dm
  if (!myUserId) return null
  const ev = memberInviteEvent(room, myUserId)
  const sender = ev?.getSender?.()
  if (sender && sender !== myUserId) return sender
  return null
}

function roomInviteTs(room: Room, myUserId: string | null): number {
  if (myUserId) {
    const ts = memberInviteEvent(room, myUserId)?.getTs?.()
    if (ts) return ts
  }
  return room.getLastActiveTimestamp?.() ?? Date.now()
}

export function collectRoomInvites(client: MatrixClient): RoomInviteInfo[] {
  const myId = client.getUserId()
  const out: RoomInviteInfo[] = []

  for (const room of client.getRooms()) {
    if (room.isSpaceRoom?.()) continue
    if (room.getMyMembership() !== KnownMembership.Invite) continue

    const inviterId = findInviterId(room, myId)
    const isDirect =
      !!room.getDMInviter?.() ||
      room.getInvitedAndJoinedMemberCount() <= 2

    const name =
      room.name?.trim() ||
      (inviterId ? displayNameForUser(client, inviterId) : null) ||
      'Приглашение в чат'

    out.push({
      roomId: room.roomId,
      name,
      isDirect,
      inviterId,
      inviterName: inviterId ? displayNameForUser(client, inviterId) : null,
      avatarMxc: room.getMxcAvatarUrl?.() ?? null,
      memberCount: room.getInvitedAndJoinedMemberCount?.() ?? 0,
      ts: roomInviteTs(room, myId),
    })
  }

  out.sort((a, b) => b.ts - a.ts)
  return out
}

export const useInvitesStore = create<InvitesState>((set, get) => {
  let client: MatrixClient | null = null
  const listeners: Array<{ event: string; handler: (...args: any[]) => void }> =
    []

  const refresh = () => {
    if (!client) {
      set({ invites: [] })
      return
    }
    set({ invites: collectRoomInvites(client), error: null })
  }

  const bind = (event: string, handler: (...args: any[]) => void) => {
    if (!client) return
    client.on(event as any, handler)
    listeners.push({ event, handler })
  }

  return {
    invites: [],
    busyRoomId: null,
    error: null,
    actions: {
      init: (matrixClient) => {
        get().actions.cleanup()
        client = matrixClient
        refresh()

        bind(ClientEvent.Sync, refresh)
        bind(ClientEvent.Room, refresh)
        bind(RoomEvent.MyMembership, refresh)
        bind(RoomEvent.Name, refresh)
      },
      cleanup: () => {
        if (client) {
          for (const { event, handler } of listeners) {
            client.removeListener(event as any, handler)
          }
        }
        listeners.length = 0
        client = null
        set({ invites: [], busyRoomId: null, error: null })
      },
      refresh,
      accept: async (roomId) => {
        if (!client || get().busyRoomId) return
        set({ busyRoomId: roomId, error: null })
        try {
          await client.joinRoom(roomId)
          refresh()
          useRoomStore.getState().actions.refreshRooms()
          useRoomStore.getState().actions.setActiveRoomId(roomId)
        } catch (err) {
          console.error('Failed to accept invite', err)
          set({
            error:
              err instanceof Error
                ? err.message
                : 'Не удалось принять приглашение',
          })
        } finally {
          set({ busyRoomId: null })
          refresh()
        }
      },
      decline: async (roomId) => {
        if (!client || get().busyRoomId) return
        set({ busyRoomId: roomId, error: null })
        try {
          await client.leave(roomId)
          refresh()
          useRoomStore.getState().actions.refreshRooms()
        } catch (err) {
          console.error('Failed to decline invite', err)
          set({
            error:
              err instanceof Error
                ? err.message
                : 'Не удалось отклонить приглашение',
          })
        } finally {
          set({ busyRoomId: null })
          refresh()
        }
      },
    },
  }
})
