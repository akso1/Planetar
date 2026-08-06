import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import {
  Direction,
  EventType,
  MatrixClient,
  MatrixEvent,
  MatrixEventEvent,
  NotificationCountType,
  ReceiptType,
  RelationType,
  Room,
  RoomEvent,
  SyncState,
} from 'matrix-js-sdk'
import {
  getChatSortMode,
  useChatListPrefsStore,
} from '@/shared/lib/chatListPrefs'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import {
  clearReadOverride,
  getReadOverride,
  isReadOverrideActive,
  rememberReadOverride,
} from '@/shared/lib/readOverrides'

export type RoomFilter = 'all' | 'direct' | 'groups' | 'spaces'

/** Joined child rooms of a space (from m.space.child state). */
export function getSpaceChildRooms(
  space: Room,
  client: MatrixClient,
): Room[] {
  const childEvents = space.currentState.getStateEvents(EventType.SpaceChild)
  if (!childEvents?.length) return []

  const entries: { room: Room; order?: string }[] = []
  for (const ev of childEvents) {
    const childId = ev.getStateKey()
    if (!childId) continue
    const childRoom = client.getRoom(childId)
    if (!childRoom || childRoom.getMyMembership() !== 'join') continue
    const content = ev.getContent() as { order?: string }
    entries.push({ room: childRoom, order: content.order })
  }

  entries.sort((a, b) => {
    if (a.order && b.order) return a.order.localeCompare(b.order)
    if (a.order) return -1
    if (b.order) return 1
    return (a.room.name || a.room.roomId).localeCompare(
      b.room.name || b.room.roomId,
    )
  })

  return entries.map((e) => e.room)
}

/** Sum unread counts in child rooms of all joined spaces (deduped, nested). */
export function getSpacesChildUnreadTotal(
  spaceRooms: Room[],
  client: MatrixClient,
  myUserId?: string | null,
): number {
  const seen = new Set<string>()
  let sum = 0

  const walk = (space: Room, depth: number) => {
    if (depth > 4) return
    for (const child of getSpaceChildRooms(space, client)) {
      if (seen.has(child.roomId)) continue
      seen.add(child.roomId)
      if (child.isSpaceRoom()) {
        walk(child, depth + 1)
        continue
      }
      sum += getRoomUnread(child, myUserId)
    }
  }

  for (const space of spaceRooms) {
    if (seen.has(space.roomId)) continue
    seen.add(space.roomId)
    walk(space, 0)
  }
  return sum
}

/** Unread total for one space's joined child rooms (nested). */
export function getSpaceChildUnreadTotal(
  space: Room,
  client: MatrixClient,
  myUserId?: string | null,
): number {
  return getSpacesChildUnreadTotal([space], client, myUserId)
}

function isLocalEchoEventId(id: string | undefined | null): boolean {
  return !id || id.startsWith('~')
}

function isReplaceRelation(ev: MatrixEvent): boolean {
  if (ev.isRelation?.(RelationType.Replace)) return true
  const rel = ev.getRelation?.()
  return (
    rel?.rel_type === RelationType.Replace || rel?.rel_type === 'm.replace'
  )
}

/** Last timeline event safe to send as a read marker / receipt. */
function findLastValidReadMarkerEvent(room: Room): MatrixEvent | null {
  const events = room.getLiveTimeline().getEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (isLocalEchoEventId(ev.getId())) continue
    if (isReplaceRelation(ev)) continue
    if (ev.isRedacted()) continue
    const type = ev.getType()
    if (
      type === 'm.room.message' ||
      type === 'm.room.encrypted' ||
      type === 'm.sticker'
    ) {
      return ev
    }
  }
  // Fallback: any persisted event so fully_read can still advance
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (isLocalEchoEventId(ev.getId())) continue
    return ev
  }
  const tip = room.getLastLiveEvent?.()
  if (tip && !isLocalEchoEventId(tip.getId())) return tip
  return null
}

/**
 * Many unread rooms were never opened — live timeline can be empty.
 * Pull the latest event id from the server so read markers can persist.
 */
async function resolveLatestReadTarget(
  client: MatrixClient,
  room: Room,
): Promise<{ event: MatrixEvent | null; eventId: string | null }> {
  let event = findLastValidReadMarkerEvent(room)
  let eventId = event?.getId() ?? null
  if (eventId && !isLocalEchoEventId(eventId)) {
    return { event, eventId }
  }

  try {
    const timeline = await client.getLatestTimeline(
      room.getUnfilteredTimelineSet(),
    )
    if (timeline) {
      event = findLastValidReadMarkerEvent(room)
      eventId = event?.getId() ?? null
      if (eventId && !isLocalEchoEventId(eventId)) {
        return { event, eventId }
      }
      const events = timeline.getEvents()
      for (let i = events.length - 1; i >= 0; i--) {
        const id = events[i].getId()
        if (id && !isLocalEchoEventId(id)) {
          return { event: events[i], eventId: id }
        }
      }
    }
  } catch (err) {
    console.warn('[read] getLatestTimeline failed', room.roomId, err)
  }

  try {
    const res = await client.createMessagesRequest(
      room.roomId,
      null,
      10,
      Direction.Backward,
    )
    for (const raw of res.chunk || []) {
      const id = (raw as { event_id?: string }).event_id
      if (typeof id === 'string' && !isLocalEchoEventId(id)) {
        return {
          event: room.findEventById(id) ?? null,
          eventId: id,
        }
      }
    }
  } catch (err) {
    console.warn('[read] /messages failed', room.roomId, err)
  }

  return { event: null, eventId: null }
}

function readMarkerHttpStatus(err: unknown): number | undefined {
  return (
    (err as { httpStatus?: number })?.httpStatus ??
    (err as { statusCode?: number })?.statusCode ??
    (err as { status?: number })?.status
  )
}

function isIgnorableReadMarkerError(err: unknown): boolean {
  const status = readMarkerHttpStatus(err)
  return status === 400 || status === 404
}

function isRateLimitError(err: unknown): boolean {
  return readMarkerHttpStatus(err) === 429
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => window.setTimeout(r, ms))
}

function isReplaceOrReaction(ev: MatrixEvent): boolean {
  if (ev.getType() === 'm.reaction') return true
  if (ev.isRelation?.(RelationType.Annotation)) return true
  return isReplaceRelation(ev)
}

/** Timestamp of the last visible message (skips edits / reactions) */
const getRoomTimestamp = (room: Room) => {
  const events = room.getLiveTimeline().getEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (isReplaceOrReaction(ev) || ev.isRedacted()) continue
    const type = ev.getType()
    if (
      type === 'm.room.message' ||
      type === 'm.room.encrypted' ||
      type === 'm.sticker' ||
      ev.isDecryptionFailure()
    ) {
      return ev.getTs()
    }
  }
  return room.getLastActiveTimestamp?.() ?? 0
}

export const isDirectRoom = (room: Room) => {
  if (room.isSpaceRoom()) return false
  return room.getJoinedMemberCount() <= 2
}

export const isGroupRoom = (room: Room) => {
  if (room.isSpaceRoom()) return false
  return room.getJoinedMemberCount() > 2
}

export const getRoomUnread = (
  room: Room,
  myUserId?: string | null,
): number => {
  const base = room.getUnreadNotificationCount(NotificationCountType.Total) || 0
  if (base <= 0) return 0
  const marked = getReadOverride(room.roomId)
  if (!marked) return base
  const me =
    myUserId ??
    // Room keeps a client ref in matrix-js-sdk; fall back when caller omits me
    (room as Room & { client?: MatrixClient }).client?.getUserId?.() ??
    null
  if (isReadOverrideActive(room, marked, me)) return 0
  return base
}

/** First non-own timeline message after the user's read marker. */
export function findFirstUnreadEventId(
  room: Room,
  myUserId: string | null,
): string | null {
  if (!myUserId) return null
  if (getRoomUnread(room, myUserId) <= 0) return null

  const override = getReadOverride(room.roomId)
  const readUpTo =
    (override && isReadOverrideActive(room, override, myUserId)
      ? override.eventId
      : null) ||
    room.getEventReadUpTo(myUserId, true) ||
    override?.eventId ||
    null
  const events = room.getLiveTimeline().getEvents()
  let passed = !readUpTo

  for (const ev of events) {
    if (isReplaceOrReaction(ev) || ev.isRedacted()) continue
    const type = ev.getType()
    const isMsg =
      type === 'm.room.message' ||
      type === 'm.sticker' ||
      type === 'm.room.encrypted' ||
      ev.isDecryptionFailure()
    if (!isMsg) continue

    const id = ev.getId()
    if (!id) continue
    if (!passed) {
      if (id === readUpTo) passed = true
      continue
    }
    if (ev.getSender() === myUserId) continue
    return id
  }
  return null
}

interface RoomState {
  rooms: Room[]
  /** Joined Matrix spaces (excluded from `rooms`). */
  spaceRooms: Room[]
  status: 'initial' | 'loading' | 'ready' | 'error'
  activeRoomId: string | null
  roomFilter: RoomFilter
  /** Jump target from global message search / profile */
  pendingScrollEventId: string | null
  /** Bumps on every jump request so same eventId re-triggers effects */
  pendingScrollNonce: number
  /** First unread event id captured when opening a room */
  pendingUnreadEventId: string | null
  /** Open room profile panel for this room id */
  profileRoomId: string | null
  /** When opening profile from an @mention, scroll/highlight this member */
  profileFocusUserId: string | null
  /** Thread panel root event id (MSC3440), mutually exclusive with profile */
  threadRootId: string | null
  actions: {
    init: (client: MatrixClient) => void
    cleanup: () => void
    setActiveRoomId: (roomId: string | null) => void
    setRoomFilter: (filter: RoomFilter) => void
    openRoomAtEvent: (roomId: string, eventId: string) => void
    clearPendingScrollEvent: () => void
    clearPendingUnreadEvent: () => void
    openRoomProfile: (roomId: string, focusUserId?: string | null) => void
    closeRoomProfile: () => void
    openThread: (rootEventId: string) => void
    closeThread: () => void
    markRoomAsRead: (roomId: string) => Promise<void>
    /** Persist read markers for every unread joined room (sequential, retries). */
    markAllRoomsAsRead: () => Promise<void>
    refreshRooms: () => void
  }
}

export const useRoomStore = create<RoomState>()(
  immer((set, get) => {
    let client: MatrixClient | null = null
    const eventListeners: Map<string, (...args: any[]) => void> = new Map()

    /** Coalesce high-frequency timeline/receipt/decrypt storms into one list rebuild. */
    let updateRoomsTimer: ReturnType<typeof setTimeout> | null = null
    let updateRoomsLastRun = 0
    const UPDATE_ROOMS_MIN_MS = 120

    const clearLocalUnread = (room: Room) => {
      room.setUnreadNotificationCount(NotificationCountType.Total, 0)
      room.setUnreadNotificationCount(NotificationCountType.Highlight, 0)
    }

    /**
     * E2EE + IndexedDB: server/store may resurrect stale notification_count
     * after refresh. Re-apply local read overrides and trust receipts when
     * the live tip is already read.
     */
    const reconcileUnreadCounts = () => {
      if (!client) return
      const myId = client.getUserId()
      for (const room of client.getRooms()) {
        if (room.getMyMembership() !== 'join' || room.isSpaceRoom()) continue

        const marked = getReadOverride(room.roomId)
        if (marked) {
          if (isReadOverrideActive(room, marked, myId)) {
            clearLocalUnread(room)
            continue
          }
          clearReadOverride(room.roomId)
        }

        const count =
          room.getUnreadNotificationCount(NotificationCountType.Total) || 0
        if (count <= 0 || !myId) continue

        const tip = findLastValidReadMarkerEvent(room)
        const tipId = tip?.getId()
        if (!tipId) continue

        try {
          if (room.hasUserReadEvent(myId, tipId)) {
            clearLocalUnread(room)
            rememberReadOverride(room.roomId, tipId, tip?.getTs?.() || 0)
            continue
          }
        } catch {
          /* ignore */
        }

        // Incomplete live timeline: only ever reduce counts, never invent higher
        const events = room.getLiveTimeline().getEvents()
        if (events.length === 0) continue

        let total = 0
        let highlight = 0
        // Bound scan — very long live timelines (search scrollback) must not
        // walk tens of thousands of events on every room-list refresh.
        const scanFrom = Math.max(0, events.length - 400)
        for (let i = events.length - 1; i >= scanFrom; i--) {
          const ev = events[i]
          const id = ev.getId()
          if (!id || isLocalEchoEventId(id)) continue
          if (ev.getSender() === myId) break
          try {
            if (room.hasUserReadEvent(myId, id)) break
          } catch {
            break
          }
          if (isReplaceRelation(ev) || ev.isRedacted()) continue
          const type = ev.getType()
          if (
            type !== 'm.room.message' &&
            type !== 'm.room.encrypted' &&
            type !== 'm.sticker'
          ) {
            continue
          }
          const actions = client.getPushActionsForEvent(ev)
          if (actions?.notify) {
            total += 1
            if (actions.tweaks?.highlight) highlight += 1
          }
        }

        if (total < count) {
          room.setUnreadNotificationCount(NotificationCountType.Total, total)
          room.setUnreadNotificationCount(
            NotificationCountType.Highlight,
            highlight,
          )
        }
      }
    }

    const updateRoomsNow = () => {
      if (!client) return
      reconcileUnreadCounts()
      const allRooms = client.getRooms()
      const joinedRooms = allRooms.filter(
        (room) => room.getMyMembership() === 'join' && !room.isSpaceRoom(),
      )

      const mode = getChatSortMode()
      const prefs = useChatListPrefsStore.getState()
      const joinedIds = joinedRooms.map((r) => r.roomId)
      const pinnedIds = prefs.syncPinnedIds(joinedIds)
      const byId = new Map(joinedRooms.map((r) => [r.roomId, r]))
      const pinnedSet = new Set(pinnedIds)

      let rest: Room[]
      if (mode === 'static') {
        const order = prefs.syncStaticOrder(joinedIds)
        rest = order
          .filter((id) => !pinnedSet.has(id))
          .map((id) => byId.get(id))
          .filter((r): r is Room => !!r)
      } else {
        rest = joinedRooms
          .filter((r) => !pinnedSet.has(r.roomId))
          .sort((a, b) => getRoomTimestamp(b) - getRoomTimestamp(a))
      }

      const pinned = pinnedIds
        .map((id) => byId.get(id))
        .filter((r): r is Room => !!r)

      const joinedSpaces = allRooms
        .filter(
          (room) =>
            room.getMyMembership() === 'join' && room.isSpaceRoom(),
        )
        .sort((a, b) =>
          (a.name || a.roomId).localeCompare(b.name || b.roomId),
        )

      set({
        rooms: [...pinned, ...rest],
        spaceRooms: joinedSpaces,
        status: 'ready',
      })
      updateRoomsLastRun = Date.now()
    }

    const updateRooms = (opts?: { immediate?: boolean }) => {
      if (!client) return
      if (opts?.immediate) {
        if (updateRoomsTimer) {
          clearTimeout(updateRoomsTimer)
          updateRoomsTimer = null
        }
        updateRoomsNow()
        return
      }
      const elapsed = Date.now() - updateRoomsLastRun
      const wait = Math.max(0, UPDATE_ROOMS_MIN_MS - elapsed)
      if (updateRoomsTimer) return
      updateRoomsTimer = setTimeout(() => {
        updateRoomsTimer = null
        updateRoomsNow()
      }, wait)
    }

    const onSync = (state: SyncState) => {
      // PREPARED = first usable sync (often from IndexedDB cache on relaunch).
      // SYNCING/CATCHUP = keep list fresh during incremental sync.
      if (
        state === SyncState.Prepared ||
        state === SyncState.Syncing ||
        state === SyncState.Catchup
      ) {
        // First paint should not wait for debounce
        updateRooms({
          immediate:
            state === SyncState.Prepared || updateRoomsLastRun === 0,
        })
      }
    }

    const onRoomUpdate = (_room?: Room) => {
      updateRooms()
    }

    /**
     * Persist read position on the homeserver.
     * m.fully_read is what survives refresh; m.read clears notification_count.
     * For E2EE rooms the client also needs a local receipt so decrypt doesn't
     * re-increment unread counts.
     */
    const persistReadMarkers = async (
      roomId: string,
      eventId: string,
      event: MatrixEvent | null,
    ): Promise<boolean> => {
      let ok = false
      let lastErr: unknown

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          // Explicit HTTP: fully_read + m.read + m.read.private all on same tip
          await client!.setRoomReadMarkersHttpRequest(
            roomId,
            eventId,
            eventId,
            eventId,
          )
          ok = true
          break
        } catch (err) {
          lastErr = err
          if (isIgnorableReadMarkerError(err)) {
            ok = true
            break
          }
          if (isRateLimitError(err) && attempt < 3) {
            await sleep(400 * (attempt + 1))
            continue
          }
          break
        }
      }

      if (!ok) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client!.setRoomReadMarkersHttpRequest(
              roomId,
              eventId,
              eventId,
            )
            ok = true
            break
          } catch (err) {
            lastErr = err
            if (isIgnorableReadMarkerError(err)) {
              ok = true
              break
            }
            if (isRateLimitError(err) && attempt < 2) {
              await sleep(400 * (attempt + 1))
              continue
            }
            break
          }
        }
      }

      // Local echo / decrypt path — needs a MatrixEvent when available
      if (event) {
        try {
          await client!.sendReadReceipt(event, ReceiptType.Read, true)
        } catch {
          try {
            await client!.sendReadReceipt(event, ReceiptType.ReadPrivate, true)
          } catch {
            /* receipts are best-effort once HTTP markers succeeded */
          }
        }
      } else if (ok) {
        // No local event: still try SDK helper for echo if room has it now
        const room = client!.getRoom(roomId)
        const local = room?.findEventById(eventId) ?? null
        if (local) {
          try {
            await client!.sendReadReceipt(local, ReceiptType.Read, true)
          } catch {
            /* ignore */
          }
        }
      }

      if (!ok && lastErr) {
        console.warn('[read] persist failed', roomId, lastErr)
      }
      return ok
    }

    const markRoomAsRead = async (roomId: string) => {
      if (!client) return
      const room = client.getRoom(roomId)
      if (!room) return

      // Optimistic UI clear so badge disappears immediately
      clearLocalUnread(room)
      updateRooms()

      const { event, eventId } = await resolveLatestReadTarget(client, room)
      if (!eventId) {
        console.warn('[read] no event id for room', roomId)
        return
      }

      // Persist locally first so F5 before HTTP completes still keeps badge clear
      rememberReadOverride(roomId, eventId, event?.getTs?.() || Date.now())
      clearLocalUnread(room)
      updateRooms()

      const persisted = await persistReadMarkers(roomId, eventId, event)
      clearLocalUnread(room)
      updateRooms()

      if (!persisted) return

      // If the tip was still a local echo when we marked, re-mark once it
      // gets a real event id so the server unread count stays cleared.
      const tip = room.getLiveTimeline().getEvents().at(-1)
      const tipId = tip?.getId()
      if (tip && isLocalEchoEventId(tipId)) {
        const onEcho = (ev: MatrixEvent) => {
          if (ev.getRoomId() !== roomId) return
          if (isLocalEchoEventId(ev.getId())) return
          client?.removeListener(RoomEvent.LocalEchoUpdated, onEcho)
          void markRoomAsRead(roomId)
        }
        client.on(RoomEvent.LocalEchoUpdated, onEcho)
        window.setTimeout(() => {
          client?.removeListener(RoomEvent.LocalEchoUpdated, onEcho)
        }, 8000)
      }
    }

    const markAllRoomsAsRead = async () => {
      if (!client) return
      const targets = client
        .getRooms()
        .filter(
          (room) =>
            room.getMyMembership() === 'join' &&
            !room.isSpaceRoom() &&
            getRoomUnread(room) > 0,
        )

      console.info('[read] mark all:', targets.length, 'rooms')

      // Optimistic clear for snappy UI
      for (const room of targets) clearLocalUnread(room)
      updateRooms()

      // Sequential — parallel setRoomReadMarkers gets 429 and never persists
      let ok = 0
      let fail = 0
      for (const room of targets) {
        try {
          const { event, eventId } = await resolveLatestReadTarget(
            client,
            room,
          )
          if (!eventId) {
            fail += 1
            console.warn('[read] skip (no event)', room.roomId)
            continue
          }
          const persisted = await persistReadMarkers(
            room.roomId,
            eventId,
            event,
          )
          rememberReadOverride(
            room.roomId,
            eventId,
            event?.getTs?.() || Date.now(),
          )
          clearLocalUnread(room)
          if (persisted) ok += 1
          else fail += 1
        } catch (err) {
          fail += 1
          console.warn('[read] mark failed', room.roomId, err)
        }
        await sleep(60)
      }
      console.info('[read] mark all done', { ok, fail })
      updateRooms()
    }

    return {
      rooms: [],
      spaceRooms: [],
      status: 'initial',
      activeRoomId: null,
      roomFilter: 'all',
      pendingScrollEventId: null,
      pendingScrollNonce: 0,
      pendingUnreadEventId: null,
      profileRoomId: null,
      profileFocusUserId: null,
      threadRootId: null,
      actions: {
        setActiveRoomId: (roomId: string | null) => {
          let pendingUnreadEventId: string | null = null
          if (roomId && client) {
            const room = client.getRoom(roomId)
            const myId = client.getUserId()
            if (room && myId) {
              pendingUnreadEventId = findFirstUnreadEventId(room, myId)
            }
          }
          set((state) => {
            const keepProfile =
              !!roomId && state.profileRoomId === roomId
            return {
              activeRoomId: roomId,
              pendingUnreadEventId,
              // Clear stale jump when simply switching rooms via the list
              pendingScrollEventId: null,
              profileRoomId: keepProfile ? state.profileRoomId : null,
              profileFocusUserId: keepProfile
                ? state.profileFocusUserId
                : null,
              // Thread panel is room-scoped; close when switching away
              threadRootId:
                roomId && state.activeRoomId === roomId
                  ? state.threadRootId
                  : null,
            }
          })
          pushBreadcrumb('open_room', { roomId: roomId ?? null })
          // Only auto-mark when there is nothing unread. If there are unreads,
          // MessageTimeline marks read when the user actually reaches the bottom
          // (and flushes on leave only if they were pinned to bottom).
          if (roomId && !pendingUnreadEventId) void markRoomAsRead(roomId)
        },
        setRoomFilter: (filter: RoomFilter) => {
          set({ roomFilter: filter })
        },
        openRoomAtEvent: (roomId: string, eventId: string) => {
          set((state) => ({
            activeRoomId: roomId,
            pendingScrollEventId: eventId,
            pendingScrollNonce: state.pendingScrollNonce + 1,
            // Don't mix unread-open intent with an explicit event jump
            pendingUnreadEventId: null,
            profileRoomId: null,
            profileFocusUserId: null,
            threadRootId: null,
          }))
        },
        clearPendingScrollEvent: () => {
          set({ pendingScrollEventId: null })
        },
        clearPendingUnreadEvent: () => {
          set({ pendingUnreadEventId: null })
        },
        openRoomProfile: (roomId: string, focusUserId?: string | null) => {
          set({
            activeRoomId: roomId,
            profileRoomId: roomId,
            profileFocusUserId: focusUserId?.trim() || null,
            threadRootId: null,
            // Don't carry a jump/unread intent from another room into profile open
            pendingScrollEventId: null,
            pendingUnreadEventId: null,
          })
        },
        closeRoomProfile: () => {
          set({ profileRoomId: null, profileFocusUserId: null })
        },
        openThread: (rootEventId: string) => {
          if (!rootEventId) return
          set({
            threadRootId: rootEventId,
            profileRoomId: null,
            profileFocusUserId: null,
          })
        },
        closeThread: () => {
          set({ threadRootId: null })
        },
        markRoomAsRead,
        markAllRoomsAsRead,
        refreshRooms: () => {
          updateRooms()
        },
        init: (matrixClient: MatrixClient) => {
          if (client) {
            get().actions.cleanup()
          }
          client = matrixClient
          set({ status: 'loading' })
          useChatListPrefsStore.getState().hydrate()

          client.on('sync', onSync)
          eventListeners.set('sync', onSync)

          client.on(RoomEvent.Name, onRoomUpdate)
          eventListeners.set(RoomEvent.Name, onRoomUpdate)

          client.on(RoomEvent.Timeline, onRoomUpdate)
          eventListeners.set(RoomEvent.Timeline, onRoomUpdate)

          client.on(RoomEvent.LocalEchoUpdated, onRoomUpdate)
          eventListeners.set(RoomEvent.LocalEchoUpdated, onRoomUpdate)

          // Edits apply via makeReplaced — must refresh previews after content swaps
          const onEventReplaced = (event: MatrixEvent) => {
            if (!event.getRoomId()) return
            updateRooms()
          }
          client.on(MatrixEventEvent.Replaced, onEventReplaced)
          eventListeners.set(MatrixEventEvent.Replaced, onEventReplaced)

          const onEventDecrypted = (event: MatrixEvent) => {
            if (!event.getRoomId()) return
            updateRooms()
          }
          client.on(MatrixEventEvent.Decrypted, onEventDecrypted)
          eventListeners.set(MatrixEventEvent.Decrypted, onEventDecrypted)

          client.on(RoomEvent.Receipt, onRoomUpdate)
          eventListeners.set(RoomEvent.Receipt, onRoomUpdate)

          client.on(RoomEvent.UnreadNotifications, onRoomUpdate)
          eventListeners.set(RoomEvent.UnreadNotifications, onRoomUpdate)

          const onMyMembership = (room: Room, membership: string) => {
            if (
              membership === 'leave' ||
              membership === 'ban' ||
              membership === 'knock'
            ) {
              useChatListPrefsStore.getState().prunePinnedIds([room.roomId])
            }
            updateRooms({ immediate: true })
          }
          client.on(RoomEvent.MyMembership, onMyMembership)
          eventListeners.set(RoomEvent.MyMembership, onMyMembership)

          if (client.getRooms().length > 0) {
            // IndexedDBStore already hydrated rooms — paint list before network sync
            updateRooms({ immediate: true })
          } else if (
            client.getSyncState() === SyncState.Prepared ||
            client.getSyncState() === SyncState.Syncing
          ) {
            updateRooms({ immediate: true })
          }
        },
        cleanup: () => {
          if (updateRoomsTimer) {
            clearTimeout(updateRoomsTimer)
            updateRoomsTimer = null
          }
          if (!client) return
          eventListeners.forEach((listener, event) => {
            client!.removeListener(event, listener)
          })
          eventListeners.clear()
          client = null
          set({
            rooms: [],
            spaceRooms: [],
            status: 'initial',
            activeRoomId: null,
            roomFilter: 'all',
            pendingScrollEventId: null,
            pendingScrollNonce: 0,
            pendingUnreadEventId: null,
            profileRoomId: null,
            profileFocusUserId: null,
            threadRootId: null,
          })
        },
      },
    }
  }),
)
