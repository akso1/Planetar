import {
  ClientEvent,
  MatrixEvent,
  MatrixEventEvent,
  RelationType,
  Room,
  RoomEvent,
  type MatrixClient,
  type RoomEventHandlerMap,
} from 'matrix-js-sdk'
import { useRoomStore, getRoomUnread } from '@/entities/session/model/room.store'
import {
  areNotificationsEnabled,
  isRoomMuted,
  useNotificationPrefsStore,
} from '@/shared/lib/notificationPrefs'
import { pollNotificationSnippet } from '@/shared/lib/polls'

export type DesktopNotificationPayload = {
  title: string
  body: string
  roomId: string
  eventId?: string
}

function isReplaceOrReaction(ev: MatrixEvent): boolean {
  if (ev.getType() === 'm.reaction') return true
  if (ev.isRelation?.(RelationType.Annotation)) return true
  if (ev.isRelation?.(RelationType.Replace)) return true
  const rel = ev.getRelation?.()
  return (
    rel?.rel_type === RelationType.Replace ||
    rel?.rel_type === 'm.replace' ||
    rel?.rel_type === RelationType.Annotation
  )
}

function notificationBody(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return '🔒 Зашифрованное сообщение'
  const poll = pollNotificationSnippet(event)
  if (poll) return poll
  if (event.getType() === 'm.sticker') return '🎟 Стикер'

  const content = event.getContent() as Record<string, unknown>
  const msgtype = content.msgtype as string | undefined
  switch (msgtype) {
    case 'm.image':
      return '📷 Фото'
    case 'm.audio':
      return '🎤 Голосовое'
    case 'm.video':
      return '🎬 Видео'
    case 'm.file':
      return `📄 ${(content.body as string) || 'Файл'}`
    case 'm.emote': {
      const body = typeof content.body === 'string' ? content.body : ''
      return body ? `* ${body}` : '* действие'
    }
    default:
      break
  }

  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  body = body.replace(/^([•*]\s+)/, '').replace(/\s+/g, ' ').trim()
  if (!body) {
    return event.isEncrypted() ? '🔒 Зашифрованное сообщение' : 'Сообщение'
  }
  return body.length > 160 ? `${body.slice(0, 160)}…` : body
}

function senderLabel(room: Room, event: MatrixEvent): string {
  const senderId = event.getSender() || ''
  const member = senderId ? room.getMember(senderId) : null
  return (
    member?.name ||
    event.sender?.name ||
    senderId.split(':')[0]?.substring(1) ||
    senderId ||
    'Кто-то'
  )
}

function totalUnread(client: MatrixClient): number {
  let total = 0
  const myId = client.getUserId()
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join') continue
    if (room.isSpaceRoom()) continue
    total += getRoomUnread(room, myId)
  }
  return total
}

async function syncDockBadge(client: MatrixClient) {
  const api = window.electronAPI
  if (!api?.setDockBadge) return
  try {
    await api.setDockBadge(totalUnread(client))
  } catch (err) {
    console.warn('Failed to update dock badge', err)
  }
}

/** Coalesce badge updates — timeline storms used to scan every room per event. */
let dockBadgeTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDockBadge(client: MatrixClient) {
  if (dockBadgeTimer) return
  dockBadgeTimer = setTimeout(() => {
    dockBadgeTimer = null
    void syncDockBadge(client)
  }, 800)
}

async function shouldSuppressForRoom(roomId: string): Promise<boolean> {
  if (!areNotificationsEnabled()) return true
  if (isRoomMuted(roomId)) return true

  const activeId = useRoomStore.getState().activeRoomId
  if (activeId !== roomId) return false

  try {
    if (window.electronAPI?.isWindowFocused) {
      const focused = await window.electronAPI.isWindowFocused()
      if (focused) return true
      return false
    }
  } catch {
    /* fall through */
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** Push a native OS banner via Electron main (never HTML5 Notification). */
function showDesktopNotification(payload: DesktopNotificationPayload) {
  const title = payload.title.slice(0, 120)
  const body = payload.body.slice(0, 240)
  const data = {
    title,
    body,
    roomId: payload.roomId,
    eventId: payload.eventId,
  }

  console.info('[notifications] show:', title, '—', body)

  const api = window.electronAPI
  if (api?.showNativeNotification) {
    api.showNativeNotification(data)
    return
  }

  // Legacy invoke path (older preload)
  if (api?.showNotification) {
    void api.showNotification(data).then((result) => {
      if (result && 'ok' in result && result.ok === false) {
        console.warn(
          '[notifications] Electron Notification отклонён:',
          result.reason ||
            'проверьте Системные настройки → Уведомления → Electron / Planetar',
        )
      }
    }).catch((err) => {
      console.warn('[notifications] Electron IPC error', err)
    })
    return
  }

  console.warn(
    '[notifications] нет native IPC — нужен полный перезапуск приложения',
  )
}

/** Incoming 1:1 call — notify when window is not focused (ringtone is separate). */
export async function notifyIncomingCall(payload: {
  roomId: string
  title: string
  body: string
}): Promise<void> {
  if (!areNotificationsEnabled()) return
  if (isRoomMuted(payload.roomId)) return

  let focused = false
  try {
    if (window.electronAPI?.isWindowFocused) {
      focused = !!(await window.electronAPI.isWindowFocused())
    } else {
      focused =
        document.visibilityState === 'visible' && document.hasFocus()
    }
  } catch {
    focused = false
  }

  // In-focus: CallOverlay ringtone is enough. Background: system notification.
  if (focused) return

  showDesktopNotification({
    title: payload.title,
    body: payload.body,
    roomId: payload.roomId,
  })
}

/**
 * Wire desktop notifications + Dock badge while the Matrix client is running.
 * Returns a cleanup function.
 */
export function startDesktopNotifications(client: MatrixClient): () => void {
  const myUserId = client.getUserId()
  let armed = false

  useNotificationPrefsStore.getState().hydrate()
  void useNotificationPrefsStore.getState().syncFromClient(client)
  const unbindPushRules =
    useNotificationPrefsStore.getState().bindPushRulesListener(client)

  if (!window.electronAPI?.showNativeNotification && !window.electronAPI?.showNotification) {
    console.warn(
      '[notifications] Electron API нет — нужен полный перезапуск (Cmd+Q)',
    )
  } else {
    console.info('[notifications] native main-process banners ready')
  }

  const armTimer = window.setTimeout(() => {
    armed = true
    console.info('[notifications] готовы')
    if (!areNotificationsEnabled()) {
      console.info('[notifications] глобально выключены — самотест пропущен')
      return
    }
    // Self-test so permissions / UI path are visible immediately
    showDesktopNotification({
      title: 'Уведомления включены',
      body: 'Если видишь это — пуши работают. Дальше только когда чат не в фокусе.',
      roomId: useRoomStore.getState().activeRoomId || 'test',
    })
  }, 1500)

  const maybeNotify = async (event: MatrixEvent, room: Room | undefined) => {
    if (!armed || !room) return
    if (!areNotificationsEnabled()) return
    if (isRoomMuted(room.roomId)) {
      return
    }
    if (!myUserId) return
    if (event.getSender() === myUserId) return
    if (event.isRedacted()) return
    if (isReplaceOrReaction(event)) return

    const type = event.getType()
    const isMsg =
      type === 'm.room.message' ||
      type === 'm.sticker' ||
      type === 'm.room.encrypted' ||
      type === 'org.matrix.msc3381.poll.start' ||
      type === 'm.poll.start' ||
      event.isDecryptionFailure()
    if (!isMsg) return

    const age = Date.now() - (event.getTs() || 0)
    if (age > 90_000) return

    if (await shouldSuppressForRoom(room.roomId)) {
      return
    }

    if (type === 'm.room.encrypted' && !event.isDecryptionFailure()) {
      const alreadyClear =
        typeof event.getContent()?.msgtype === 'string' ||
        typeof event.getContent()?.body === 'string'
      if (!alreadyClear) {
        await new Promise<void>((resolve) => {
          const done = () => {
            event.off(MatrixEventEvent.Decrypted, done)
            window.clearTimeout(t)
            resolve()
          }
          const t = window.setTimeout(done, 1200)
          event.once(MatrixEventEvent.Decrypted, done)
        })
        if (event.getSender() === myUserId) return
        if (isReplaceOrReaction(event)) return
        if (await shouldSuppressForRoom(room.roomId)) {
          return
        }
      }
    }

    const eventId = event.getId() || undefined
    const roomName = room.name || room.roomId
    const sender = senderLabel(room, event)
    const isDm = room.getJoinedMemberCount() <= 2
    const title = isDm ? sender : roomName
    const body = isDm
      ? notificationBody(event)
      : `${sender}: ${notificationBody(event)}`

    showDesktopNotification({
      title,
      body,
      roomId: room.roomId,
      eventId,
    })
  }

  const onTimeline: RoomEventHandlerMap[RoomEvent.Timeline] = (
    event,
    room,
    toStartOfTimeline,
    _removed,
    data,
  ) => {
    if (toStartOfTimeline) return
    // Only skip when SDK explicitly marks as non-live
    if (data?.liveEvent === false) return
    void maybeNotify(event, room ?? undefined)
    scheduleDockBadge(client)
  }

  const onUnread = () => {
    scheduleDockBadge(client)
  }

  const onSync = () => {
    scheduleDockBadge(client)
  }

  client.on(RoomEvent.Timeline, onTimeline)
  client.on(RoomEvent.UnreadNotifications, onUnread)
  client.on(ClientEvent.Sync, onSync)
  void syncDockBadge(client)

  const unsubClick = window.electronAPI?.onNotificationClicked?.((payload) => {
    if (!payload?.roomId) return
    if (payload.eventId) {
      useRoomStore
        .getState()
        .actions.openRoomAtEvent(payload.roomId, payload.eventId)
    } else {
      useRoomStore.getState().actions.setActiveRoomId(payload.roomId)
    }
  })

  return () => {
    window.clearTimeout(armTimer)
    if (dockBadgeTimer) {
      clearTimeout(dockBadgeTimer)
      dockBadgeTimer = null
    }
    unbindPushRules()
    client.removeListener(RoomEvent.Timeline, onTimeline)
    client.removeListener(RoomEvent.UnreadNotifications, onUnread)
    client.removeListener(ClientEvent.Sync, onSync)
    unsubClick?.()
    void window.electronAPI?.setDockBadge?.(0)
  }
}

/** Manual smoke-test from Settings after enabling notifications. */
export function showNotificationsSelfTest(): void {
  if (!areNotificationsEnabled()) return
  void showDesktopNotification({
    title: 'Уведомления включены',
    body: 'Тестовое уведомление. Входящие будут приходить, когда чат не в фокусе.',
    roomId: useRoomStore.getState().activeRoomId || 'test',
  })
}
