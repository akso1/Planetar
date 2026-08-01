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
} from 'lucide-react'
import type { MatrixClient, Room } from 'matrix-js-sdk'
import { Preset } from 'matrix-js-sdk'
import { format } from 'date-fns'
import { clsx } from 'clsx'
import {
  useRoomStore,
  isDirectRoom,
  isGroupRoom,
} from '@/entities/session/model/room.store'
import { useSessionStore } from '@/entities/session/model/session'
import { getGradient } from '@/shared/lib/color'
import { ALBUM_CAPTION_KEY } from '@/shared/lib/sendMedia'
import { AppContextMenu } from '@/shared/ui/AppContextMenu'
import { useChatListPrefsStore } from '@/shared/lib/chatListPrefs'
import { useNotificationPrefsStore } from '@/shared/lib/notificationPrefs'
import {
  useComposerDraftsStore,
  type ComposerDraft,
} from '@/shared/lib/composerDrafts'
import { RoomItem } from './RoomItem'
import {
  ChatPeekPopover,
  type ChatPeekAnchor,
} from './ChatPeekPopover'

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

type MessageHit = {
  eventId: string
  roomId: string
  roomName: string
  senderId: string
  senderName: string
  body: string
  ts: number
  highlights: string[]
}

/** Prefer jumping to the original message when the hit is an edit event. */
function canonicalSearchEventId(
  eventId: string,
  content: Record<string, unknown> | undefined | null,
): string | null {
  const rel = content?.['m.relates_to'] as
    | { rel_type?: string; event_id?: string }
    | undefined
  if (rel?.rel_type === 'm.annotation') return null
  if (rel?.rel_type === 'm.replace') {
    return typeof rel.event_id === 'string' && rel.event_id
      ? rel.event_id
      : null
  }
  return eventId
}

function messageBodyFromContent(
  content: Record<string, unknown> | undefined | null,
): string {
  if (!content) return ''
  if (typeof content.body === 'string' && content.body) return content.body
  const newContent = content['m.new_content'] as
    | Record<string, unknown>
    | undefined
  if (typeof newContent?.body === 'string' && newContent.body) {
    return newContent.body
  }
  if (typeof content[ALBUM_CAPTION_KEY] === 'string') {
    return content[ALBUM_CAPTION_KEY] as string
  }
  return ''
}

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
  if (!raw && d.mentionUserIds.length === 0 && d.files.length === 0) {
    return undefined
  }
  const text = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw
  return text || 'Вложение'
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

async function searchMessagesLocal(
  client: MatrixClient,
  query: string,
): Promise<MessageHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const q = trimmed.toLowerCase()
  const highlights = [trimmed]
  const hits: MessageHit[] = []

  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join') continue
    if (room.isSpaceRoom()) continue

    for (const ev of room.getLiveTimeline().getEvents()) {
      if (ev.isRedacted()) continue
      const type = ev.getType()
      if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue
      if (ev.isDecryptionFailure()) continue

      // Edit / reaction events are not rendered in the timeline — skip or
      // remap so we don't show a duplicate that can't scroll.
      if (ev.isRelation?.('m.annotation')) continue
      if (ev.isRelation?.('m.replace')) continue

      const content = ev.getContent() as Record<string, unknown>
      const body = messageBodyFromContent(content)
      if (!body || !body.toLowerCase().includes(q)) continue

      const eventId = ev.getId()
      if (!eventId) continue
      const jumpId = canonicalSearchEventId(eventId, content)
      if (!jumpId) continue

      const senderId = ev.getSender() || ''
      const member = senderId ? room.getMember(senderId) : null
      hits.push({
        eventId: jumpId,
        roomId: room.roomId,
        roomName: room.name || room.roomId,
        senderId,
        senderName:
          member?.name ||
          senderId.split(':')[0]?.substring(1) ||
          senderId ||
          'Unknown',
        body,
        ts: ev.getTs(),
        highlights,
      })
    }
  }

  return hits.sort((a, b) => b.ts - a.ts)
}

async function searchMessagesServer(
  client: MatrixClient,
  query: string,
): Promise<MessageHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const results = await client.search({
    body: {
      search_categories: {
        room_events: {
          search_term: trimmed,
          order_by: 'recent' as any,
          event_context: {
            before_limit: 0,
            after_limit: 0,
            include_profile: true,
          },
        },
      },
    },
  })

  const roomEvents = results.search_categories.room_events
  const highlights = roomEvents.highlights?.length
    ? roomEvents.highlights
    : [trimmed]
  const hits: MessageHit[] = []

  for (const item of roomEvents.results || []) {
    const ev = item.result
    if (!ev?.event_id || !ev.room_id) continue
    const content = (ev.content || {}) as Record<string, unknown>
    const jumpId = canonicalSearchEventId(ev.event_id, content)
    if (!jumpId) continue

    const body = messageBodyFromContent(content)
    if (!body) continue

    const room = client.getRoom(ev.room_id)
    const profile = item.context?.profile_info?.[ev.sender]
    const member = room?.getMember(ev.sender)
    const senderName =
      profile?.displayname ||
      member?.name ||
      ev.sender?.split(':')[0]?.substring(1) ||
      ev.sender ||
      'Unknown'

    hits.push({
      eventId: jumpId,
      roomId: ev.room_id,
      roomName: room?.name || ev.room_id,
      senderId: ev.sender,
      senderName,
      body,
      ts: ev.origin_server_ts || 0,
      highlights,
    })
  }

  return hits
}

/**
 * Server search cannot see E2EE plaintext — merge with local timeline scan.
 */
async function searchMessages(
  client: MatrixClient,
  query: string,
): Promise<MessageHit[]> {
  const local = await searchMessagesLocal(client, query)
  let server: MessageHit[] = []
  try {
    server = await searchMessagesServer(client, query)
  } catch (err) {
    console.warn('Server message search failed (common for E2EE)', err)
  }

  // room+event — event ids alone are not guaranteed unique across rooms
  const byKey = new Map<string, MessageHit>()
  for (const h of server) byKey.set(`${h.roomId}:${h.eventId}`, h)
  // Local wins for body/snippet accuracy in encrypted rooms
  for (const h of local) byKey.set(`${h.roomId}:${h.eventId}`, h)

  return [...byKey.values()].sort((a, b) => b.ts - a.ts)
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

  useEffect(() => {
    useNotificationPrefsStore.getState().hydrate()
  }, [])

  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<SearchTab>('chats')
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchCursor, setSearchCursor] = useState(-1)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [people, setPeople] = useState<UserHit[]>([])
  const [publicRooms, setPublicRooms] = useState<PublicRoomHit[]>([])
  const [messageHits, setMessageHits] = useState<MessageHit[]>([])
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [roomMenu, setRoomMenu] = useState<{
    x: number
    y: number
    room: Room
  } | null>(null)
  const [peek, setPeek] = useState<{
    room: Room
    anchor: ChatPeekAnchor
  } | null>(null)
  const [pinDragOrder, setPinDragOrder] = useState<string[] | null>(null)
  const pinDragOrderRef = useRef<string[] | null>(null)
  const pinDragMovedRef = useRef(false)

  const openAvatarPeek = useCallback((room: Room, anchor: ChatPeekAnchor) => {
    setRoomMenu(null)
    setPeek({ room, anchor })
  }, [])

  const filteredByFolder = useMemo(() => {
    switch (roomFilter) {
      case 'direct':
        return rooms.filter(isDirectRoom)
      case 'groups':
        return rooms.filter(isGroupRoom)
      default:
        return rooms
    }
  }, [rooms, roomFilter])

  const q = query.trim().toLowerCase()
  const showTabs = searchFocused || query.length > 0
  const canReorderPins = tab === 'chats' && !q

  const matchedRooms = useMemo(() => {
    if (tab !== 'chats') return filteredByFolder
    return filteredByFolder.filter((r) => roomMatchesQuery(r, q))
  }, [filteredByFolder, q, tab])

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
    if (tab === 'chats') {
      return [...pinnedMatched, ...unpinnedMatched].map((room) => ({
        kind: 'room' as const,
        key: room.roomId,
        room,
      }))
    }
    if (tab === 'messages') {
      return messageHits.map((hit) => ({
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
    pinnedMatched,
    unpinnedMatched,
    messageHits,
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

  // Global message search
  useEffect(() => {
    if (!client || tab !== 'messages' || !q) {
      if (tab !== 'messages') setMessageHits([])
      if (tab === 'messages' && !q) setMessageHits([])
      return
    }

    let cancelled = false
    setRemoteLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const hits = await searchMessages(client, query.trim())
        if (!cancelled) setMessageHits(hits)
      } catch (err) {
        console.error('Global message search failed', err)
        if (!cancelled) setMessageHits([])
      } finally {
        if (!cancelled) setRemoteLoading(false)
      }
    }, 400)

    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [client, q, query, tab])

  const parentRef = React.useRef<HTMLDivElement>(null)

  const rowVirtualizer = useVirtualizer({
    count: tab === 'chats' ? unpinnedMatched.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 5,
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
        const existing = client.getRooms().find((room) => {
          if (!isDirectRoom(room)) return false
          return room.getJoinedMembers().some((m) => m.userId === userId)
        })
        if (existing) {
          setActiveRoomId(existing.roomId)
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
      const name = room.name || room.roomId
      const ok = window.confirm(`Покинуть чат «${name}»?`)
      if (!ok) return
      try {
        unpinRoom(room.roomId)
        pruneMutedIds([room.roomId])
        await client.leave(room.roomId)
        if (activeRoomId === room.roomId) setActiveRoomId(null)
      } catch (err) {
        console.error('Failed to leave room', err)
        alert('Не удалось покинуть чат')
      }
    },
    [client, activeRoomId, setActiveRoomId, unpinRoom, pruneMutedIds],
  )

  const openMessageHit = useCallback(
    (hit: MessageHit) => {
      openRoomAtEvent(hit.roomId, hit.eventId)
    },
    [openRoomAtEvent],
  )

  const activateSearchRow = useCallback(
    (row: SelectableRow) => {
      if (row.kind === 'room') {
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
    [setActiveRoomId, openMessageHit, startDm, joinPublic],
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
    return (
      <div className="w-[300px] shrink-0 flex flex-col items-center justify-center tg-chatlist border-r">
        <p className="tg-muted">Loading chats...</p>
      </div>
    )
  }

  const placeholder =
    tab === 'messages'
      ? 'Поиск по сообщениям…'
      : tab === 'people'
        ? 'Люди или публичные комнаты…'
        : 'Поиск чатов…'

  return (
    <div className="tg-chatlist w-[300px] shrink-0 flex flex-col border-r overflow-hidden">
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
        {tab === 'chats' && (
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
                            data-search-idx={searchIdx}
                            className={clsx(
                              'cursor-grab active:cursor-grabbing touch-none rounded-lg',
                              searchCursor === searchIdx && 'bg-white/10',
                            )}
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
                            searchCursor === pinIdx && 'bg-white/10',
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
                            searchCursor === searchIdx && 'bg-white/10',
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
              <p className="text-center text-white/35 text-[13px] py-8 px-3">
                {q ? 'Чаты не найдены' : 'Нет чатов'}
              </p>
            )}
          </>
        )}

        {tab === 'messages' && (
          <div className="px-2 pb-3">
            {!q && (
              <p className="text-center text-white/35 text-[13px] py-8 px-3">
                Введите текст для поиска по всем чатам
              </p>
            )}
            {q && remoteLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-white/40 text-[13px]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Поиск сообщений…
              </div>
            )}
            {q && !remoteLoading && messageHits.length === 0 && (
              <p className="text-center text-white/35 text-[13px] py-8 px-3">
                Сообщения не найдены
              </p>
            )}
            {messageHits.length > 0 && (
              <div className="space-y-0.5">
                {messageHits.map((hit, idx) => (
                  <button
                    key={`${hit.roomId}:${hit.eventId}`}
                    type="button"
                    data-search-idx={idx}
                    onClick={() => {
                      setSearchCursor(idx)
                      openMessageHit(hit)
                    }}
                    className={clsx(
                      'w-full text-left px-2.5 py-2 rounded-xl hover:bg-white/5 transition-colors duration-ui',
                      searchCursor === idx && 'bg-white/10',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-0.5">
                      <span className="text-[13px] font-semibold tg-title truncate">
                        {hit.roomName}
                      </span>
                      <span className="text-[11px] text-white/35 shrink-0 tabular-nums">
                        {hit.ts ? format(hit.ts, 'dd.MM HH:mm') : ''}
                      </span>
                    </div>
                    <div className="text-[12px] tg-link truncate mb-0.5">
                      {hit.senderName}
                    </div>
                    <div className="text-[12.5px] text-white/55 line-clamp-2 leading-snug">
                      <HighlightedSnippet
                        text={hit.body}
                        highlights={hit.highlights}
                      />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'people' && (
          <div className="px-2 pb-3 space-y-3">
            {!q && (
              <p className="text-center text-white/35 text-[13px] py-8 px-3">
                Ищите @user:server или публичные комнаты
              </p>
            )}
            {q && remoteLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-white/40 text-[13px]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Поиск…
              </div>
            )}
            {q &&
              !remoteLoading &&
              people.length === 0 &&
              publicRooms.length === 0 && (
                <p className="text-center text-white/35 text-[13px] py-6 px-3">
                  Ничего не найдено
                </p>
              )}

            {people.length > 0 && (
              <section>
                <h3 className="px-2 mb-1.5 text-[11px] uppercase tracking-wide text-white/35 font-semibold">
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
                      className={clsx(
                        'w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-white/5 text-left disabled:opacity-50 transition-colors duration-ui',
                        searchCursor === idx && 'bg-white/10',
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
                        <div className="text-[12px] text-white/40 truncate">
                          {u.userId}
                        </div>
                      </div>
                      <UserPlus className="w-4 h-4 text-white/40 shrink-0" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {publicRooms.length > 0 && (
              <section>
                <h3 className="px-2 mb-1.5 text-[11px] uppercase tracking-wide text-white/35 font-semibold">
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
                        'w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-white/5 text-left disabled:opacity-50 transition-colors duration-ui',
                        searchCursor === searchIdx && 'bg-white/10',
                      )}
                    >
                      <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center shrink-0">
                        <Hash className="w-4 h-4 text-white/50" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] tg-title truncate">
                          {r.name}
                        </div>
                        <div className="text-[12px] text-white/40 truncate">
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
                  onSelect: () => unmuteRoom(roomMenu.room.roomId),
                }
              : {
                  id: 'mute',
                  label: 'Без звука',
                  icon: <BellOff className="w-4 h-4" />,
                  onSelect: () => muteRoom(roomMenu.room.roomId),
                },
            {
              id: 'read',
              label: 'Отметить как прочитанное',
              icon: <CheckCheck className="w-4 h-4" />,
              onSelect: () => void markRoomAsRead(roomMenu.room.roomId),
            },
            {
              id: 'leave',
              label: 'Покинуть чат',
              icon: <LogOut className="w-4 h-4" />,
              danger: true,
              onSelect: () => void leaveRoom(roomMenu.room),
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
    </div>
  )
}
