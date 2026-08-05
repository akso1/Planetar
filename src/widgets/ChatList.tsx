import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Reorder } from 'framer-motion'
import {
  Search,
  Loader2,
  UserPlus,
  Hash,
  X,
  LogOut,
  CheckCheck,
  Info,
  Pin,
  PinOff,
  Bell,
  BellOff,
  ChevronLeft,
  Copy,
  FolderPlus,
  Link2,
  FolderMinus,
  Plus,
} from 'lucide-react'
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { EventType, Preset, RoomStateEvent } from 'matrix-js-sdk'
import { copyTextToClipboard } from '@/shared/lib/clipboard'
import { format } from 'date-fns'
import { clsx } from 'clsx'
import {
  useRoomStore,
  isDirectRoom,
  isGroupRoom,
  getSpaceChildRooms,
} from '@/entities/session/model/room.store'
import { useSessionStore } from '@/entities/session/model/session'
import { getGradient } from '@/shared/lib/color'
import { AppContextMenu } from '@/shared/ui/AppContextMenu'
import { useChatListPrefsStore } from '@/shared/lib/chatListPrefs'
import { useNotificationPrefsStore } from '@/shared/lib/notificationPrefs'
import {
  useComposerDraftsStore,
  type ComposerDraft,
} from '@/shared/lib/composerDrafts'
import {
  GlobalMessageSearchSession,
  GLOBAL_SEARCH_PAGE_SIZE,
  type GlobalMessageHit,
} from '@/shared/lib/globalMessageSearch'
import { ChatListSkeleton } from './ChatListSkeleton'
import { ChatListResizeHandle } from './ChatListResizeHandle'
import { RoomItem } from './RoomItem'
import {
  ChatPeekPopover,
  type ChatPeekAnchor,
} from './ChatPeekPopover'
import { SpaceNameDialog } from './SpaceNameDialog'
import { AddRoomToSpaceDialog } from './AddRoomToSpaceDialog'
import {
  addRoomToSpace,
  canManageSpaceChildren,
  createRoomInSpace,
  createSpace,
  removeRoomFromSpace,
} from '@/shared/lib/spaces'
import { usePanelLayoutStore } from '@/shared/lib/panelLayout'

const MXID_RE = /^@[A-Za-z0-9._=\-/]+:.+$/

type SearchTab = 'chats' | 'messages' | 'people'

type UserHit = {
  userId: string
  displayName?: string
  avatarUrl?: string
}

type PublicRoomHit = {
  roomId: string
  name?: string
  topic?: string
  avatarUrl?: string
  numJoinedMembers?: number
  alias?: string
}

type MessageHit = GlobalMessageHit

function roomMatchesQuery(room: Room, q: string): boolean {
  if (!q) return true
  const name = (room.name || '').toLowerCase()
  if (name.includes(q)) return true
  for (const m of room.getJoinedMembers()) {
    if ((m.name || '').toLowerCase().includes(q)) return true
    if ((m.userId || '').toLowerCase().includes(q)) return true
  }
  return false
}

/** Compose a single-line, length-limited preview for a draft (Telegram-style). */
function draftPreviewText(d: ComposerDraft | undefined): string | undefined {
  if (!d) return undefined
  const raw = d.text.replace(/\s+/g, ' ').trim()
  if (raw) return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
  if (d.files.length > 0) return 'Вложение'
  return undefined
}

async function copyToClipboard(text: string): Promise<boolean> {
  return copyTextToClipboard(text)
}

async function lookupPeople(
  client: MatrixClient,
  query: string,
): Promise<UserHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const hits: UserHit[] = []
  const seen = new Set<string>()

  if (MXID_RE.test(trimmed)) {
    const local = client.getUser(trimmed)
    try {
      const profile = await client.getProfileInfo(trimmed)
      hits.push({
        userId: trimmed,
        displayName: profile.displayname || local?.displayName || undefined,
        avatarUrl: profile.avatar_url,
      })
      seen.add(trimmed)
    } catch {
      if (local) {
        hits.push({
          userId: trimmed,
          displayName: local.displayName || undefined,
        })
        seen.add(trimmed)
      }
    }
  }

  try {
    const dir = await client.searchUserDirectory({ term: trimmed, limit: 8 })
    for (const r of dir.results || []) {
      if (!r.user_id || seen.has(r.user_id)) continue
      seen.add(r.user_id)
      hits.push({
        userId: r.user_id,
        displayName: r.display_name || undefined,
        avatarUrl: r.avatar_url,
      })
    }
  } catch {
    // directory may be disabled
  }

  return hits
}

async function lookupPublicRooms(
  client: MatrixClient,
  query: string,
): Promise<PublicRoomHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  try {
    const res = await client.publicRooms({
      limit: 12,
      filter: { generic_search_term: trimmed },
    })
    return (res.chunk || []).map((r) => ({
      roomId: r.room_id,
      name: r.name || r.canonical_alias || r.room_id,
      topic: r.topic,
      avatarUrl: r.avatar_url,
      numJoinedMembers: r.num_joined_members,
      alias: r.canonical_alias || undefined,
    }))
  } catch (err) {
    console.error('publicRooms search failed', err)
    return []
  }
}

function HighlightedSnippet({
  text,
  highlights,
}: {
  text: string
  highlights: string[]
}) {
  const snippet =
    text.length > 160 ? `${text.slice(0, 160).trim()}…` : text

  if (!highlights.length) {
    return <>{snippet}</>
  }

  const escaped = highlights
    .filter(Boolean)
    .map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return <>{snippet}</>

  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = snippet.split(re)

  return (
    <>
      {parts.map((part, i) => {
        const isHit = highlights.some(
          (h) => part.toLowerCase() === h.toLowerCase(),
        )
        return isHit ? (
          <mark
            key={i}
            className="bg-yellow-400/35 text-ink rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        )
      })}
    </>
  )
}

const TABS: { id: SearchTab; label: string; title: string }[] = [
  { id: 'chats', label: 'Чаты', title: 'Поиск по чатам' },
  { id: 'messages', label: 'Сообщения', title: 'Поиск по тексту сообщений' },
  { id: 'people', label: 'Люди', title: 'Люди и публичные комнаты' },
]

export function ChatList() {
  const rooms = useRoomStore((state) => state.rooms)
  const spaceRooms = useRoomStore((state) => state.spaceRooms)
  const status = useRoomStore((state) => state.status)
  const roomFilter = useRoomStore((state) => state.roomFilter)
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const setActiveRoomId = useRoomStore((state) => state.actions.setActiveRoomId)
  const openRoomAtEvent = useRoomStore(
    (state) => state.actions.openRoomAtEvent,
  )
  const openRoomProfile = useRoomStore((state) => state.actions.openRoomProfile)
  const markRoomAsRead = useRoomStore((state) => state.actions.markRoomAsRead)
  const refreshRooms = useRoomStore((state) => state.actions.refreshRooms)
  const client = useSessionStore((state) => state.client)
  const pinnedIds = useChatListPrefsStore((s) => s.pinnedIds)
  const pinRoom = useChatListPrefsStore((s) => s.pinRoom)
  const unpinRoom = useChatListPrefsStore((s) => s.unpinRoom)
  const reorderPinnedIds = useChatListPrefsStore((s) => s.reorderPinnedIds)
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const mutedRoomIds = useNotificationPrefsStore((s) => s.mutedRoomIds)
  const muteRoom = useNotificationPrefsStore((s) => s.muteRoom)
  const unmuteRoom = useNotificationPrefsStore((s) => s.unmuteRoom)
  const pruneMutedIds = useNotificationPrefsStore((s) => s.pruneMutedIds)
  const mutedSet = useMemo(() => new Set(mutedRoomIds), [mutedRoomIds])
  const draftsMap = useComposerDraftsStore((s) => s.map)
  const chatListWidth = usePanelLayoutStore((s) => s.chatListWidth)

  useEffect(() => {
    useNotificationPrefsStore.getState().hydrate()
  }, [])

  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SearchTab>('chats')
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchCursor, setSearchCursor] = useState(-1)

  useEffect(() => {
    setSearchCursor(-1)
  }, [activeRoomId])

  const [remoteLoading, setRemoteLoading] = useState(false)
  const [people, setPeople] = useState<UserHit[]>([])
  const [publicRooms, setPublicRooms] = useState<PublicRoomHit[]>([])
  const [messageHits, setMessageHits] = useState<MessageHit[]>([])
  const [messageVisibleCount, setMessageVisibleCount] = useState(
    GLOBAL_SEARCH_PAGE_SIZE,
  )
  const [messageSearchBusy, setMessageSearchBusy] = useState(false)
  const [messageCanDeepen, setMessageCanDeepen] = useState(false)
  const [messageSearchStatus, setMessageSearchStatus] = useState('')
  const messageSearchRef = useRef<GlobalMessageSearchSession | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [roomMenu, setRoomMenu] = useState<{
    x: number
    y: number
    room: Room
  } | null>(null)
  const [searchMenu, setSearchMenu] = useState<
    | { kind: 'message'; x: number; y: number; hit: MessageHit }
    | { kind: 'person'; x: number; y: number; user: UserHit }
    | null
  >(null)
  const [peek, setPeek] = useState<{
    room: Room
    anchor: ChatPeekAnchor
  } | null>(null)
  const [pinDragOrder, setPinDragOrder] = useState<string[] | null>(null)
  /** Stack of space room ids: root → … → current. Empty = top-level spaces list. */
  const [spacePath, setSpacePath] = useState<string[]>([])
  const [spaceChildrenTick, setSpaceChildrenTick] = useState(0)
  const [spaceDialog, setSpaceDialog] = useState<
    null | 'create-space' | 'create-room' | 'add-room'
  >(null)
  const [spaceActionBusy, setSpaceActionBusy] = useState(false)
  const [spaceActionError, setSpaceActionError] = useState<string | null>(null)
  const pinDragOrderRef = useRef<string[] | null>(null)
  const pinDragMovedRef = useRef(false)

  const openAvatarPeek = useCallback((room: Room, anchor: ChatPeekAnchor) => {
    setRoomMenu(null)
    setPeek({ room, anchor })
  }, [])

  useEffect(() => {
    setSpacePath([])
  }, [roomFilter])

  const openSpaceId = spacePath.length ? spacePath[spacePath.length - 1] : null

  const openSpace = useMemo(() => {
    if (!openSpaceId || !client) return null
    return client.getRoom(openSpaceId)
  }, [openSpaceId, client])

  const spaceBreadcrumb = useMemo(() => {
    if (!client || spacePath.length === 0) return []
    return spacePath.map((id) => {
      const room = client.getRoom(id)
      return { id, name: room?.name || 'Пространство' }
    })
  }, [client, spacePath])

  const enterSpace = useCallback((roomId: string) => {
    setSpacePath((prev) => [...prev, roomId])
    setQuery('')
    setSearchCursor(-1)
  }, [])

  const popSpace = useCallback(() => {
    setSpacePath((prev) => prev.slice(0, -1))
    setSearchCursor(-1)
  }, [])

  const jumpSpaceTo = useCallback((index: number) => {
    setSpacePath((prev) => prev.slice(0, index + 1))
    setSearchCursor(-1)
  }, [])

  const filteredByFolder = useMemo(() => {
    switch (roomFilter) {
      case 'direct':
        return rooms.filter(isDirectRoom)
      case 'groups':
        return rooms.filter(isGroupRoom)
      case 'spaces':
        return spaceRooms
      default:
        return rooms
    }
  }, [rooms, spaceRooms, roomFilter])

  const q = query.trim().toLowerCase()

  const matchedSpaces = useMemo(() => {
    if (roomFilter !== 'spaces' || openSpaceId) return []
    return filteredByFolder.filter((r) => roomMatchesQuery(r, q))
  }, [filteredByFolder, roomFilter, openSpaceId, q])

  const matchedSpaceChildren = useMemo(() => {
    if (roomFilter !== 'spaces' || !openSpace || !client) return []
    void spaceChildrenTick
    return getSpaceChildRooms(openSpace, client).filter((r) =>
      roomMatchesQuery(r, q),
    )
  }, [roomFilter, openSpace, client, q, spaceChildrenTick])

  const canEditOpenSpace = useMemo(() => {
    if (!openSpace || !client) return false
    return canManageSpaceChildren(openSpace, client.getUserId())
  }, [openSpace, client, spaceChildrenTick])

  useEffect(() => {
    if (!openSpace || roomFilter !== 'spaces') return
    const bump = () => {
      setSpaceChildrenTick((n) => n + 1)
      refreshRooms()
    }
    const onState = (event: MatrixEvent) => {
      if (event.getType() === EventType.SpaceChild) bump()
    }
    openSpace.on(RoomStateEvent.Events, onState)
    return () => {
      openSpace.removeListener(RoomStateEvent.Events, onState)
    }
  }, [openSpace, roomFilter, refreshRooms])

  const showTabs = searchFocused || query.length > 0
  const canReorderPins =
    tab === 'chats' && !q && roomFilter !== 'spaces' && !openSpaceId

  const matchedRooms = useMemo(() => {
    if (tab !== 'chats' || roomFilter === 'spaces') return filteredByFolder
    return filteredByFolder.filter((r) => roomMatchesQuery(r, q))
  }, [filteredByFolder, q, tab, roomFilter])

  const { pinnedMatched, unpinnedMatched } = useMemo(() => {
    const pinned: Room[] = []
    const unpinned: Room[] = []
    for (const room of matchedRooms) {
      if (pinnedSet.has(room.roomId)) pinned.push(room)
      else unpinned.push(room)
    }
    // Keep store pin order (matchedRooms already has pins first, but filter
    // folders may scramble — re-sort pinned by pinnedIds).
    const order = new Map(pinnedIds.map((id, i) => [id, i]))
    pinned.sort(
      (a, b) => (order.get(a.roomId) ?? 0) - (order.get(b.roomId) ?? 0),
    )
    return { pinnedMatched: pinned, unpinnedMatched: unpinned }
  }, [matchedRooms, pinnedIds, pinnedSet])

  const pinReorderValues = pinDragOrder ?? pinnedMatched.map((r) => r.roomId)
  const pinnedById = useMemo(() => {
    const map = new Map(pinnedMatched.map((r) => [r.roomId, r]))
    return map
  }, [pinnedMatched])

  type SelectableRow =
    | { kind: 'room'; key: string; room: Room }
    | { kind: 'message'; key: string; hit: MessageHit }
    | { kind: 'person'; key: string; user: UserHit }
    | { kind: 'public'; key: string; room: PublicRoomHit }

  const selectableRows = useMemo((): SelectableRow[] => {
    if (tab === 'chats' && roomFilter === 'spaces') {
      const list = openSpaceId ? matchedSpaceChildren : matchedSpaces
      return list.map((room) => ({
        kind: 'room' as const,
        key: room.roomId,
        room,
      }))
    }
    if (tab === 'chats') {
      return [...pinnedMatched, ...unpinnedMatched].map((room) => ({
        kind: 'room' as const,
        key: room.roomId,
        room,
      }))
    }
    if (tab === 'messages') {
      return messageHits.slice(0, messageVisibleCount).map((hit) => ({
        kind: 'message' as const,
        key: `${hit.roomId}:${hit.eventId}`,
        hit,
      }))
    }
    return [
      ...people.map((user) => ({
        kind: 'person' as const,
        key: `u:${user.userId}`,
        user,
      })),
      ...publicRooms.map((room) => ({
        kind: 'public' as const,
        key: `p:${room.roomId}`,
        room,
      })),
    ]
  }, [
    tab,
    roomFilter,
    openSpaceId,
    matchedSpaces,
    matchedSpaceChildren,
    pinnedMatched,
    unpinnedMatched,
    messageHits,
    messageVisibleCount,
    people,
    publicRooms,
  ])

  useEffect(() => {
    setSearchCursor(-1)
  }, [tab, q])

  useEffect(() => {
    if (searchCursor < 0) return
    if (selectableRows.length === 0) {
      setSearchCursor(-1)
      return
    }
    if (searchCursor >= selectableRows.length) {
      setSearchCursor(selectableRows.length - 1)
    }
  }, [selectableRows, searchCursor])

  useEffect(() => {
    if (!client || tab !== 'people' || !q) {
      if (tab !== 'people') {
        setPeople([])
        setPublicRooms([])
      }
      return
    }

    let cancelled = false
    setRemoteLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const [users, pubs] = await Promise.all([
          lookupPeople(client, query.trim()),
          lookupPublicRooms(client, query.trim()),
        ])
        if (!cancelled) {
          setPeople(users)
          setPublicRooms(pubs)
        }
      } finally {
        if (!cancelled) setRemoteLoading(false)
      }
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [client, q, query, tab])

  // Global message search — quick first page, deepen on demand
  useEffect(() => {
    if (!client || tab !== 'messages' || !q) {
      messageSearchRef.current?.abort()
      messageSearchRef.current = null
      if (tab !== 'messages') setMessageHits([])
      if (tab === 'messages' && !q) setMessageHits([])
      setMessageVisibleCount(GLOBAL_SEARCH_PAGE_SIZE)
      setMessageSearchBusy(false)
      setMessageCanDeepen(false)
      setMessageSearchStatus('')
      return
    }

    messageSearchRef.current?.abort()
    const session = new GlobalMessageSearchSession(client, query.trim())
    messageSearchRef.current = session
    setRemoteLoading(true)
    setMessageSearchBusy(true)
    setMessageVisibleCount(GLOBAL_SEARCH_PAGE_SIZE)
    setMessageHits([])
    setMessageCanDeepen(false)
    setMessageSearchStatus('Ищем…')

    const t = window.setTimeout(() => {
      void session
        .runQuick((snap) => {
          if (messageSearchRef.current !== session) return
          setMessageHits(snap.hits)
          setMessageCanDeepen(snap.canDeepen)
          setMessageSearchBusy(snap.busy)
          setMessageSearchStatus(snap.status)
          if (snap.hits.length > 0 || !snap.busy) setRemoteLoading(false)
        })
        .then((snap) => {
          if (messageSearchRef.current !== session) return
          setMessageHits(snap.hits)
          setMessageCanDeepen(snap.canDeepen)
          setMessageSearchBusy(false)
          setMessageSearchStatus(snap.status)
        })
        .catch((err) => {
          if (messageSearchRef.current !== session) return
          console.error('Global message search failed', err)
          setMessageHits([])
          setMessageCanDeepen(false)
          setMessageSearchBusy(false)
          setMessageSearchStatus('')
        })
        .finally(() => {
          if (messageSearchRef.current === session) setRemoteLoading(false)
        })
    }, 280)

    return () => {
      window.clearTimeout(t)
      session.abort()
      if (messageSearchRef.current === session) {
        messageSearchRef.current = null
      }
    }
  }, [client, q, query, tab])

  const visibleMessageHits = useMemo(
    () => messageHits.slice(0, messageVisibleCount),
    [messageHits, messageVisibleCount],
  )

  const messageHasMoreUi =
    messageVisibleCount < messageHits.length || messageCanDeepen

  const loadMoreMessages = useCallback(async () => {
    // First reveal already-found hits without network work
    if (messageVisibleCount < messageHits.length) {
      setMessageVisibleCount((n) =>
        Math.min(n + GLOBAL_SEARCH_PAGE_SIZE, messageHits.length),
      )
      return
    }
    const session = messageSearchRef.current
    if (!session || messageSearchBusy || !messageCanDeepen) return

    setMessageSearchBusy(true)
    try {
      const snap = await session.deepen((s) => {
        if (messageSearchRef.current !== session) return
        setMessageHits(s.hits)
        setMessageCanDeepen(s.canDeepen)
        setMessageSearchBusy(s.busy)
        setMessageSearchStatus(s.status)
      })
      if (messageSearchRef.current !== session) return
      setMessageHits(snap.hits)
      setMessageCanDeepen(snap.canDeepen)
      setMessageSearchBusy(false)
      setMessageSearchStatus(snap.status)
      setMessageVisibleCount((n) =>
        Math.min(n + GLOBAL_SEARCH_PAGE_SIZE, Math.max(snap.hits.length, n)),
      )
    } catch (err) {
      console.error('Deepen message search failed', err)
      setMessageSearchBusy(false)
    }
  }, [
    messageVisibleCount,
    messageHits.length,
    messageSearchBusy,
    messageCanDeepen,
  ])

  const parentRef = React.useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: tab === 'chats' ? unpinnedMatched.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 12,
    useFlushSync: false,
  })

  const finishPinReorder = useCallback(() => {
    const order = pinDragOrderRef.current
    pinDragOrderRef.current = null
    setPinDragOrder(null)
    if (!order) return
    reorderPinnedIds(order)
    refreshRooms()
  }, [reorderPinnedIds, refreshRooms])

  const startDm = useCallback(
    async (userId: string) => {
      if (!client) return
      setActionBusy(userId)
      try {
        const myId = client.getUserId()
        // Self-chat: DM lookup matches ANY direct room (you are always a member).
        // Open / create a private Saved Messages room instead.
        if (myId && userId === myId) {
          const NOTES_NAME = 'Избранное'
          const LEGACY_NOTES_NAME = 'scroll-test'
          const existingNotes = client.getRooms().find((room) => {
            const name = room.name
            return name === NOTES_NAME || name === LEGACY_NOTES_NAME
          })
          if (existingNotes) {
            if (existingNotes.name === LEGACY_NOTES_NAME) {
              try {
                await client.setRoomName(existingNotes.roomId, NOTES_NAME)
              } catch {
                /* rename is best-effort */
              }
            }
            setActiveRoomId(existingNotes.roomId)
            setQuery('')
            return
          }
          const { room_id } = await client.createRoom({
            name: NOTES_NAME,
            preset: Preset.PrivateChat,
            topic: 'Личные заметки',
          })
          setActiveRoomId(room_id)
          setQuery('')
          return
        }

        const existingDm = client.getRooms().find((room) => {
          if (!isDirectRoom(room)) return false
          const others = room
            .getJoinedMembers()
            .map((m) => m.userId)
            .filter((id) => id !== myId)
          return others.length === 1 && others[0] === userId
        })
        if (existingDm) {
          setActiveRoomId(existingDm.roomId)
          setQuery('')
          return
        }
        const { room_id } = await client.createRoom({
          preset: Preset.TrustedPrivateChat,
          invite: [userId],
          is_direct: true,
        })
        setActiveRoomId(room_id)
        setQuery('')
      } catch (err) {
        console.error('Failed to start DM', err)
        alert('Не удалось начать диалог')
      } finally {
        setActionBusy(null)
      }
    },
    [client, setActiveRoomId],
  )

  const joinPublic = useCallback(
    async (roomIdOrAlias: string) => {
      if (!client) return
      setActionBusy(roomIdOrAlias)
      try {
        const room = await client.joinRoom(roomIdOrAlias)
        setActiveRoomId(room.roomId)
        setQuery('')
      } catch (err) {
        console.error('Failed to join room', err)
        alert('Не удалось вступить в комнату')
      } finally {
        setActionBusy(null)
      }
    },
    [client, setActiveRoomId],
  )

  const leaveRoom = useCallback(
    async (room: Room) => {
      if (!client) return
      const isSpace = room.isSpaceRoom()
      const name = room.name || room.roomId
      const ok = window.confirm(
        isSpace
          ? `Покинуть пространство «${name}»?`
          : `Покинуть чат «${name}»?`,
      )
      if (!ok) return
      try {
        unpinRoom(room.roomId)
        pruneMutedIds([room.roomId])
        await client.leave(room.roomId)
        if (activeRoomId === room.roomId) setActiveRoomId(null)
        setSpacePath((prev) => {
          const idx = prev.indexOf(room.roomId)
          if (idx < 0) return prev
          return prev.slice(0, idx)
        })
      } catch (err) {
        console.error('Failed to leave room', err)
        alert(
          isSpace
            ? 'Не удалось покинуть пространство'
            : 'Не удалось покинуть чат',
        )
      }
    },
    [client, activeRoomId, setActiveRoomId, unpinRoom, pruneMutedIds],
  )

  const closeSpaceDialog = useCallback(() => {
    if (spaceActionBusy) return
    setSpaceDialog(null)
    setSpaceActionError(null)
  }, [spaceActionBusy])

  const openSpaceDialog = useCallback(
    (kind: 'create-space' | 'create-room' | 'add-room') => {
      setSpaceActionError(null)
      setSpaceDialog(kind)
    },
    [],
  )

  const runCreateSpace = useCallback(
    async (data: { name: string; topic?: string }) => {
      if (!client) return
      setSpaceActionBusy(true)
      setSpaceActionError(null)
      try {
        const roomId = await createSpace(client, data)
        setSpaceDialog(null)
        refreshRooms()
        enterSpace(roomId)
      } catch (err) {
        console.error('Failed to create space', err)
        setSpaceActionError(
          err instanceof Error ? err.message : 'Не удалось создать пространство',
        )
      } finally {
        setSpaceActionBusy(false)
      }
    },
    [client, refreshRooms, enterSpace],
  )

  const runCreateRoomInSpace = useCallback(
    async (data: { name: string; topic?: string }) => {
      if (!client || !openSpace) return
      setSpaceActionBusy(true)
      setSpaceActionError(null)
      try {
        const roomId = await createRoomInSpace(client, openSpace, data)
        setSpaceDialog(null)
        setSpaceChildrenTick((n) => n + 1)
        refreshRooms()
        setActiveRoomId(roomId)
      } catch (err) {
        console.error('Failed to create room in space', err)
        setSpaceActionError(
          err instanceof Error ? err.message : 'Не удалось создать чат',
        )
      } finally {
        setSpaceActionBusy(false)
      }
    },
    [client, openSpace, refreshRooms, setActiveRoomId],
  )

  const runAddRoomToSpace = useCallback(
    async (roomId: string) => {
      if (!client || !openSpace) return
      setSpaceActionBusy(true)
      setSpaceActionError(null)
      try {
        await addRoomToSpace(client, openSpace, roomId)
        setSpaceDialog(null)
        setSpaceChildrenTick((n) => n + 1)
        refreshRooms()
      } catch (err) {
        console.error('Failed to add room to space', err)
        setSpaceActionError(
          err instanceof Error ? err.message : 'Не удалось добавить чат',
        )
      } finally {
        setSpaceActionBusy(false)
      }
    },
    [client, openSpace, refreshRooms],
  )

  const runRemoveFromSpace = useCallback(
    async (child: Room) => {
      if (!client || !openSpace) return
      const name = child.name || child.roomId
      const ok = window.confirm(
        `Убрать «${name}» из пространства «${openSpace.name || '…'}»?`,
      )
      if (!ok) return
      try {
        await removeRoomFromSpace(client, openSpace, child.roomId)
        setSpaceChildrenTick((n) => n + 1)
        refreshRooms()
      } catch (err) {
        console.error('Failed to remove room from space', err)
        alert(
          err instanceof Error
            ? err.message
            : 'Не удалось убрать чат из пространства',
        )
      }
    },
    [client, openSpace, refreshRooms],
  )

  const openMessageHit = useCallback(
    (hit: MessageHit) => {
      openRoomAtEvent(hit.roomId, hit.eventId)
    },
    [openRoomAtEvent],
  )

  const openSpaceOrRoom = useCallback(
    (room: Room) => {
      if (room.isSpaceRoom()) {
        enterSpace(room.roomId)
        return
      }
      setActiveRoomId(room.roomId)
    },
    [enterSpace, setActiveRoomId],
  )

  const activateSearchRow = useCallback(
    (row: SelectableRow) => {
      if (row.kind === 'room') {
        if (roomFilter === 'spaces') {
          openSpaceOrRoom(row.room)
          return
        }
        setActiveRoomId(row.room.roomId)
        return
      }
      if (row.kind === 'message') {
        openMessageHit(row.hit)
        return
      }
      if (row.kind === 'person') {
        void startDm(row.user.userId)
        return
      }
      void joinPublic(row.room.alias || row.room.roomId)
    },
    [
      setActiveRoomId,
      openMessageHit,
      startDm,
      joinPublic,
      roomFilter,
      openSpaceOrRoom,
    ],
  )

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!showTabs) return
        e.preventDefault()
        const idx = TABS.findIndex((t) => t.id === tab)
        const next =
          e.key === 'ArrowRight'
            ? TABS[(idx + 1) % TABS.length]
            : TABS[(idx - 1 + TABS.length) % TABS.length]
        setTab(next.id)
        setSearchCursor(-1)
        return
      }

      if (e.key === 'ArrowDown') {
        if (selectableRows.length === 0) return
        e.preventDefault()
        setSearchCursor((i) =>
          i < 0 ? 0 : Math.min(selectableRows.length - 1, i + 1),
        )
        return
      }

      if (e.key === 'ArrowUp') {
        if (selectableRows.length === 0) return
        e.preventDefault()
        setSearchCursor((i) => (i <= 0 ? 0 : i - 1))
        return
      }

      if (e.key === 'Enter') {
        const row =
          searchCursor >= 0 ? selectableRows[searchCursor] : selectableRows[0]
        if (!row) return
        e.preventDefault()
        activateSearchRow(row)
      }
    },
    [
      showTabs,
      tab,
      selectableRows,
      searchCursor,
      activateSearchRow,
    ],
  )

  useEffect(() => {
    if (searchCursor < 0) return
    const el = parentRef.current?.querySelector(
      `[data-search-idx="${searchCursor}"]`,
    )
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [searchCursor, tab, selectableRows.length])

  if (status === 'loading' || status === 'initial') {
    return <ChatListSkeleton />
  }

  const placeholder =
    roomFilter === 'spaces'
      ? openSpaceId
        ? 'Поиск чатов в пространстве…'
        : 'Поиск пространств…'
      : tab === 'messages'
        ? 'Поиск по сообщениям…'
        : tab === 'people'
          ? 'Люди или публичные комнаты…'
          : 'Поиск чатов…'

  return (
    <div
      className="tg-chatlist relative shrink-0 flex flex-col border-r overflow-hidden"
      style={{ width: chatListWidth }}
    >
      <div className="px-3 pt-3 pb-2 shrink-0 space-y-3">
        <div className="relative">
          <span className="tg-field-icon-slot" aria-hidden>
            <Search className="tg-field-icon" strokeWidth={2} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => {
              window.setTimeout(() => {
                if (!query.trim()) setSearchFocused(false)
              }, 150)
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={placeholder}
            className="tg-field w-full rounded-xl pl-9 pr-8 py-2 outline-none text-[13.5px] leading-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setSearchFocused(false)
              }}
              className="tg-icon-btn absolute right-1.5 inset-y-0 my-auto h-7 w-7 flex items-center justify-center rounded-lg"
              aria-label="Очистить"
            >
              <X className="w-3.5 h-3.5 block" strokeWidth={2} />
            </button>
          )}
        </div>

        {showTabs && (
          <div className="tg-tabs grid grid-cols-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'tg-tab min-w-0',
                  tab === t.id && 'tg-tab--active',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {tab === 'chats' && roomFilter === 'spaces' && (
          <>
            {spacePath.length > 0 && (
              <div className="px-2 pt-2 pb-1 sticky top-0 z-10 tg-chatlist">
                <button
                  type="button"
                  onClick={popSpace}
                  className="flex items-center gap-1 px-1 py-1 rounded-lg text-[13px] text-ink-muted hover:text-ink hover:bg-surface-inset transition-colors duration-ui"
                >
                  <ChevronLeft className="w-4 h-4 shrink-0" strokeWidth={2} />
                  Назад
                </button>
                <div className="mt-1 px-1 text-[12px] text-ink-faint flex items-center gap-1 min-w-0 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setSpacePath([])}
                    className="shrink-0 hover:text-ink-muted transition-colors"
                  >
                    Пространства
                  </button>
                  {spaceBreadcrumb.map((crumb, i) => (
                    <React.Fragment key={crumb.id}>
                      <span className="text-ink-faint shrink-0">/</span>
                      <button
                        type="button"
                        onClick={() => jumpSpaceTo(i)}
                        className={clsx(
                          'truncate min-w-0 transition-colors',
                          i === spaceBreadcrumb.length - 1
                            ? 'text-ink-muted cursor-default'
                            : 'hover:text-ink-muted',
                        )}
                        disabled={i === spaceBreadcrumb.length - 1}
                        title={crumb.name}
                      >
                        {crumb.name}
                      </button>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}

            {!q && (
              <div className="px-2 pt-1.5 pb-1 flex flex-wrap gap-1.5">
                {!openSpaceId ? (
                  <button
                    type="button"
                    onClick={() => openSpaceDialog('create-space')}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-surface-inset transition-colors"
                  >
                    <FolderPlus className="w-3.5 h-3.5" strokeWidth={2.1} />
                    Создать пространство
                  </button>
                ) : (
                  canEditOpenSpace && (
                    <>
                      <button
                        type="button"
                        onClick={() => openSpaceDialog('add-room')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-surface-inset transition-colors"
                      >
                        <Link2 className="w-3.5 h-3.5" strokeWidth={2.1} />
                        Добавить чат
                      </button>
                      <button
                        type="button"
                        onClick={() => openSpaceDialog('create-room')}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-surface-inset transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" strokeWidth={2.1} />
                        Новый чат
                      </button>
                    </>
                  )
                )}
              </div>
            )}

            {(openSpaceId ? matchedSpaceChildren : matchedSpaces).length > 0 ? (
              (openSpaceId ? matchedSpaceChildren : matchedSpaces).map(
                (room, idx) => (
                  <div
                    key={room.roomId}
                    data-search-idx={idx}
                    className={clsx(
                      'rounded-lg',
                      searchFocused && searchCursor === idx && 'bg-surface-inset',
                    )}
                    onClick={() => {
                      setSearchCursor(idx)
                      openSpaceOrRoom(room)
                    }}
                  >
                    <RoomItem
                      room={room}
                      isActive={
                        !room.isSpaceRoom() && room.roomId === activeRoomId
                      }
                      isMuted={mutedSet.has(room.roomId)}
                      draftPreview={
                        !room.isSpaceRoom() && room.roomId === activeRoomId
                          ? undefined
                          : draftPreviewText(draftsMap[room.roomId])
                      }
                      draftHasFiles={
                        !room.isSpaceRoom() &&
                        room.roomId !== activeRoomId &&
                        !!draftsMap[room.roomId]?.files.length
                      }
                      onAvatarLongPress={
                        room.isSpaceRoom() ? undefined : openAvatarPeek
                      }
                      onContextMenu={(e, r) => {
                        setRoomMenu({
                          x: e.clientX,
                          y: e.clientY,
                          room: r,
                        })
                      }}
                    />
                  </div>
                ),
              )
            ) : (
              <div className="text-center py-8 px-3 space-y-3">
                <p className="text-ink-faint text-[13px]">
                  {q
                    ? openSpaceId
                      ? 'Чаты не найдены'
                      : 'Пространства не найдены'
                    : openSpaceId
                      ? 'В этом пространстве нет чатов'
                      : 'Нет пространств'}
                </p>
                {!q && !openSpaceId && (
                  <button
                    type="button"
                    onClick={() => openSpaceDialog('create-space')}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] tg-btn-primary"
                  >
                    <FolderPlus className="w-4 h-4" strokeWidth={2.1} />
                    Создать пространство
                  </button>
                )}
                {!q && openSpaceId && canEditOpenSpace && (
                  <div className="flex flex-col items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openSpaceDialog('add-room')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] tg-btn-primary"
                    >
                      <Link2 className="w-4 h-4" strokeWidth={2.1} />
                      Добавить существующий чат
                    </button>
                    <button
                      type="button"
                      onClick={() => openSpaceDialog('create-room')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] text-ink-muted hover:text-ink hover:bg-surface-inset transition-colors"
                    >
                      <Plus className="w-4 h-4" strokeWidth={2.1} />
                      Создать чат здесь
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'chats' && roomFilter !== 'spaces' && (
          <>
            {matchedRooms.length > 0 ? (
              <>
                {pinnedMatched.length > 0 &&
                  (canReorderPins && pinnedMatched.length > 1 ? (
                    <Reorder.Group
                      as="div"
                      axis="y"
                      values={pinReorderValues}
                      onReorder={(next) => {
                        pinDragMovedRef.current = true
                        pinDragOrderRef.current = next
                        setPinDragOrder(next)
                      }}
                      className="relative z-10"
                    >
                      {pinReorderValues.map((roomId, pinIdx) => {
                        const room = pinnedById.get(roomId)
                        if (!room) return null
                        const searchIdx = pinIdx
                        return (
                          <Reorder.Item
                            key={roomId}
                            value={roomId}
                            as="div"
                            layout="position"
                            data-search-idx={searchIdx}
                            className={clsx(
                              'tg-pin-reorder-item w-full cursor-grab active:cursor-grabbing touch-none rounded-lg',
                              searchFocused && searchCursor === searchIdx && 'bg-surface-inset',
                            )}
                            style={{ position: 'relative' }}
                            onPointerDown={() => {
                              pinDragMovedRef.current = false
                            }}
                            onDragEnd={() => finishPinReorder()}
                            onClick={() => {
                              if (pinDragMovedRef.current) {
                                pinDragMovedRef.current = false
                                return
                              }
                              setSearchCursor(searchIdx)
                              setActiveRoomId(room.roomId)
                            }}
                          >
                            <RoomItem
                              room={room}
                              isActive={room.roomId === activeRoomId}
                              isPinned
                              isMuted={mutedSet.has(room.roomId)}
                              draftPreview={
                                room.roomId === activeRoomId
                                  ? undefined
                                  : draftPreviewText(draftsMap[room.roomId])
                              }
                              draftHasFiles={
                                room.roomId !== activeRoomId &&
                                !!draftsMap[room.roomId]?.files.length
                              }
                              onAvatarLongPress={openAvatarPeek}
                              onContextMenu={(e, r) => {
                                setRoomMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  room: r,
                                })
                              }}
                            />
                          </Reorder.Item>
                        )
                      })}
                    </Reorder.Group>
                  ) : (
                    <div>
                      {pinnedMatched.map((room, pinIdx) => (
                        <div
                          key={room.roomId}
                          data-search-idx={pinIdx}
                          className={clsx(
                            'rounded-lg',
                            searchFocused && searchCursor === pinIdx && 'bg-surface-inset',
                          )}
                          onClick={() => {
                            setSearchCursor(pinIdx)
                            setActiveRoomId(room.roomId)
                          }}
                        >
                          <RoomItem
                            room={room}
                            isActive={room.roomId === activeRoomId}
                            isPinned
                            isMuted={mutedSet.has(room.roomId)}
                            draftPreview={
                              room.roomId === activeRoomId
                                ? undefined
                                : draftPreviewText(draftsMap[room.roomId])
                            }
                            draftHasFiles={
                              room.roomId !== activeRoomId &&
                              !!draftsMap[room.roomId]?.files.length
                            }
                            onAvatarLongPress={openAvatarPeek}
                            onContextMenu={(e, r) => {
                              setRoomMenu({
                                x: e.clientX,
                                y: e.clientY,
                                room: r,
                              })
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  ))}

                {unpinnedMatched.length > 0 && (
                  <div
                    style={{
                      height: `${rowVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                      const room = unpinnedMatched[virtualItem.index]
                      const searchIdx =
                        pinnedMatched.length + virtualItem.index
                      return (
                        <div
                          key={virtualItem.key}
                          ref={rowVirtualizer.measureElement}
                          data-index={virtualItem.index}
                          data-search-idx={searchIdx}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                          className={clsx(
                            'rounded-lg',
                            searchFocused && searchCursor === searchIdx && 'bg-surface-inset',
                          )}
                          onClick={() => {
                            setSearchCursor(searchIdx)
                            setActiveRoomId(room.roomId)
                          }}
                        >
                          <RoomItem
                            room={room}
                            isActive={room.roomId === activeRoomId}
                            isMuted={mutedSet.has(room.roomId)}
                            draftPreview={
                              room.roomId === activeRoomId
                                ? undefined
                                : draftPreviewText(draftsMap[room.roomId])
                            }
                            draftHasFiles={
                              room.roomId !== activeRoomId &&
                              !!draftsMap[room.roomId]?.files.length
                            }
                            onAvatarLongPress={openAvatarPeek}
                            onContextMenu={(e, r) => {
                              setRoomMenu({
                                x: e.clientX,
                                y: e.clientY,
                                room: r,
                              })
                            }}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            ) : (
              <p className="text-center text-ink-faint text-[13px] py-8 px-3">
                {q ? 'Чаты не найдены' : 'Нет чатов'}
              </p>
            )}
          </>
        )}

        {tab === 'messages' && (
          <div className="px-2 pb-3">
            {!q && (
              <p className="text-center text-ink-faint text-[13px] py-8 px-3">
                Введите текст для поиска по всем чатам
              </p>
            )}
            {q && remoteLoading && messageHits.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-ink-faint text-[13px]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Поиск сообщений…
              </div>
            )}
            {q &&
              (messageSearchBusy || messageSearchStatus) &&
              !(remoteLoading && messageHits.length === 0) && (
                <div className="flex items-center gap-2 px-1 py-2 text-[11.5px] text-ink-faint">
                  {messageSearchBusy && (
                    <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  )}
                  <span className="truncate">
                    {messageSearchStatus ||
                      (messageSearchBusy ? 'Подгружаем…' : '')}
                    {messageHits.length > 0 &&
                      ` · ${Math.min(messageVisibleCount, messageHits.length)}/${messageHits.length}`}
                  </span>
                </div>
              )}
            {q &&
              !remoteLoading &&
              !messageSearchBusy &&
              messageHits.length === 0 &&
              !messageCanDeepen && (
                <p className="text-center text-ink-faint text-[13px] py-8 px-3">
                  Сообщения не найдены
                </p>
              )}
            {q &&
              !remoteLoading &&
              messageHits.length === 0 &&
              messageCanDeepen &&
              !messageSearchBusy && (
                <div className="flex flex-col items-center gap-3 py-8 px-3">
                  <p className="text-center text-ink-faint text-[13px]">
                    В открытой истории пока пусто
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadMoreMessages()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] tg-btn-primary"
                  >
                    Искать глубже
                  </button>
                </div>
              )}
            {visibleMessageHits.length > 0 && (
              <div className="space-y-0.5">
                {visibleMessageHits.map((hit, idx) => (
                  <button
                    key={`${hit.roomId}:${hit.eventId}`}
                    type="button"
                    data-search-idx={idx}
                    onClick={() => {
                      setSearchCursor(idx)
                      openMessageHit(hit)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setSearchCursor(idx)
                      setSearchMenu({
                        kind: 'message',
                        x: e.clientX,
                        y: e.clientY,
                        hit,
                      })
                    }}
                    className={clsx(
                      'w-full text-left px-2.5 py-2 rounded-xl hover:bg-surface-inset transition-colors duration-ui',
                      searchFocused && searchCursor === idx && 'bg-surface-inset',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-0.5">
                      <span className="text-[13px] font-semibold tg-title truncate">
                        {hit.roomName}
                      </span>
                      <span className="text-[11px] text-ink-faint shrink-0 tabular-nums">
                        {hit.ts ? format(hit.ts, 'dd.MM HH:mm') : ''}
                      </span>
                    </div>
                    <div className="text-[12px] tg-link truncate mb-0.5">
                      {hit.senderName}
                    </div>
                    <div className="text-[12.5px] text-ink-muted line-clamp-2 leading-snug">
                      <HighlightedSnippet
                        text={hit.body}
                        highlights={hit.highlights}
                      />
                    </div>
                  </button>
                ))}
                {messageHasMoreUi && (
                  <button
                    type="button"
                    disabled={messageSearchBusy}
                    onClick={() => void loadMoreMessages()}
                    className={clsx(
                      'w-full mt-1.5 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-[13px] transition-colors',
                      messageSearchBusy
                        ? 'text-ink-faint cursor-wait'
                        : 'text-ink-muted hover:text-ink hover:bg-surface-inset',
                    )}
                  >
                    {messageSearchBusy ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Подгружаем…
                      </>
                    ) : messageVisibleCount < messageHits.length ? (
                      `Ещё ${Math.min(
                        GLOBAL_SEARCH_PAGE_SIZE,
                        messageHits.length - messageVisibleCount,
                      )}`
                    ) : (
                      'Искать глубже в истории'
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'people' && (
          <div className="px-2 pb-3 space-y-3">
            {!q && (
              <p className="text-center text-ink-faint text-[13px] py-8 px-3">
                Ищите @user:server или публичные комнаты
              </p>
            )}
            {q && remoteLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-ink-faint text-[13px]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Поиск…
              </div>
            )}
            {q &&
              !remoteLoading &&
              people.length === 0 &&
              publicRooms.length === 0 && (
                <p className="text-center text-ink-faint text-[13px] py-6 px-3">
                  Ничего не найдено
                </p>
              )}

            {people.length > 0 && (
              <section>
                <h3 className="px-2 mb-1.5 text-[11px] uppercase tracking-wide text-ink-faint font-semibold">
                  Люди
                </h3>
                <div className="space-y-0.5">
                  {people.map((u, idx) => (
                    <button
                      key={u.userId}
                      type="button"
                      data-search-idx={idx}
                      disabled={actionBusy === u.userId}
                      onClick={() => {
                        setSearchCursor(idx)
                        void startDm(u.userId)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSearchCursor(idx)
                        setSearchMenu({
                          kind: 'person',
                          x: e.clientX,
                          y: e.clientY,
                          user: u,
                        })
                      }}
                      className={clsx(
                        'w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-surface-inset text-left disabled:opacity-50 transition-colors duration-ui',
                        searchFocused && searchCursor === idx && 'bg-surface-inset',
                      )}
                    >
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
                        style={{ background: getGradient(u.userId) }}
                      >
                        {(u.displayName || u.userId)[0]?.toUpperCase() || '?'}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] tg-title truncate">
                          {u.displayName || u.userId.split(':')[0].slice(1)}
                        </div>
                        <div className="text-[12px] text-ink-faint truncate">
                          {u.userId}
                        </div>
                      </div>
                      <UserPlus className="w-4 h-4 text-ink-faint shrink-0" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {publicRooms.length > 0 && (
              <section>
                <h3 className="px-2 mb-1.5 text-[11px] uppercase tracking-wide text-ink-faint font-semibold">
                  Публичные комнаты
                </h3>
                <div className="space-y-0.5">
                  {publicRooms.map((r, idx) => {
                    const searchIdx = people.length + idx
                    return (
                    <button
                      key={r.roomId}
                      type="button"
                      data-search-idx={searchIdx}
                      disabled={actionBusy === (r.alias || r.roomId)}
                      onClick={() => {
                        setSearchCursor(searchIdx)
                        void joinPublic(r.alias || r.roomId)
                      }}
                      className={clsx(
                        'w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-surface-inset text-left disabled:opacity-50 transition-colors duration-ui',
                        searchFocused && searchCursor === searchIdx && 'bg-surface-inset',
                      )}
                    >
                      <div className="w-10 h-10 rounded-full bg-surface-inset flex items-center justify-center shrink-0">
                        <Hash className="w-4 h-4 text-ink-muted" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] tg-title truncate">
                          {r.name}
                        </div>
                        <div className="text-[12px] text-ink-faint truncate">
                          {r.numJoinedMembers != null
                            ? `${r.numJoinedMembers} участников`
                            : r.alias || r.roomId}
                        </div>
                      </div>
                    </button>
                    )
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {roomMenu && (
        <AppContextMenu
          x={roomMenu.x}
          y={roomMenu.y}
          onClose={() => setRoomMenu(null)}
          items={[
            {
              id: 'profile',
              label: 'Открыть профиль чата',
              icon: <Info className="w-4 h-4" />,
              onSelect: () => openRoomProfile(roomMenu.room.roomId),
            },
            ...(openSpaceId &&
            canEditOpenSpace &&
            !roomMenu.room.isSpaceRoom()
              ? [
                  {
                    id: 'remove-from-space',
                    label: 'Убрать из пространства',
                    icon: <FolderMinus className="w-4 h-4" />,
                    onSelect: () => void runRemoveFromSpace(roomMenu.room),
                  },
                ]
              : []),
            pinnedSet.has(roomMenu.room.roomId)
              ? {
                  id: 'unpin',
                  label: 'Открепить',
                  icon: <PinOff className="w-4 h-4" />,
                  onSelect: () => {
                    unpinRoom(roomMenu.room.roomId)
                    refreshRooms()
                  },
                }
              : {
                  id: 'pin',
                  label: 'Закрепить',
                  icon: <Pin className="w-4 h-4" />,
                  onSelect: () => {
                    pinRoom(roomMenu.room.roomId)
                    refreshRooms()
                  },
                },
            mutedSet.has(roomMenu.room.roomId)
              ? {
                  id: 'unmute',
                  label: 'Включить уведомления',
                  icon: <Bell className="w-4 h-4" />,
                  onSelect: () => void unmuteRoom(roomMenu.room.roomId, client),
                }
              : {
                  id: 'mute',
                  label: 'Без звука',
                  icon: <BellOff className="w-4 h-4" />,
                  onSelect: () => void muteRoom(roomMenu.room.roomId, client),
                },
            {
              id: 'read',
              label: 'Отметить как прочитанное',
              icon: <CheckCheck className="w-4 h-4" />,
              onSelect: () => void markRoomAsRead(roomMenu.room.roomId),
            },
            {
              id: 'leave',
              label: roomMenu.room.isSpaceRoom()
                ? 'Покинуть пространство'
                : 'Покинуть чат',
              icon: <LogOut className="w-4 h-4" />,
              danger: true,
              onSelect: () => void leaveRoom(roomMenu.room),
            },
          ]}
        />
      )}

      {searchMenu?.kind === 'message' && (
        <AppContextMenu
          x={searchMenu.x}
          y={searchMenu.y}
          onClose={() => setSearchMenu(null)}
          items={[
            {
              id: 'open',
              label: 'Перейти к сообщению',
              icon: <Search className="w-4 h-4" />,
              onSelect: () => openMessageHit(searchMenu.hit),
            },
            {
              id: 'copy-text',
              label: 'Копировать текст',
              icon: <Copy className="w-4 h-4" />,
              disabled: !searchMenu.hit.body.trim(),
              onSelect: () => void copyToClipboard(searchMenu.hit.body),
            },
            {
              id: 'copy-event',
              label: 'Копировать ID события',
              icon: <Copy className="w-4 h-4" />,
              onSelect: () => void copyToClipboard(searchMenu.hit.eventId),
            },
          ]}
        />
      )}

      {searchMenu?.kind === 'person' && (
        <AppContextMenu
          x={searchMenu.x}
          y={searchMenu.y}
          onClose={() => setSearchMenu(null)}
          items={[
            {
              id: 'dm',
              label: 'Написать',
              icon: <UserPlus className="w-4 h-4" />,
              onSelect: () => void startDm(searchMenu.user.userId),
            },
            {
              id: 'copy-mxid',
              label: 'Копировать MXID',
              icon: <Copy className="w-4 h-4" />,
              onSelect: () => void copyToClipboard(searchMenu.user.userId),
            },
          ]}
        />
      )}

      {peek && (
        <ChatPeekPopover
          room={peek.room}
          anchor={peek.anchor}
          onClose={() => setPeek(null)}
        />
      )}

      <SpaceNameDialog
        open={spaceDialog === 'create-space'}
        mode="space"
        busy={spaceActionBusy}
        error={spaceActionError}
        onClose={closeSpaceDialog}
        onSubmit={(data) => void runCreateSpace(data)}
      />
      <SpaceNameDialog
        open={spaceDialog === 'create-room'}
        mode="room"
        busy={spaceActionBusy}
        error={spaceActionError}
        onClose={closeSpaceDialog}
        onSubmit={(data) => void runCreateRoomInSpace(data)}
      />
      <AddRoomToSpaceDialog
        open={spaceDialog === 'add-room'}
        space={openSpace}
        client={client}
        busy={spaceActionBusy}
        error={spaceActionError}
        onClose={closeSpaceDialog}
        onSelect={(roomId) => void runAddRoomToSpace(roomId)}
      />
      <ChatListResizeHandle />
    </div>
  )
}
