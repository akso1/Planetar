import { create } from 'zustand'
import {
  CallEvent,
  ClientEvent,
  type MatrixCall,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk'
import {
  CallDirection,
  CallErrorCode,
  CallState,
  CallType,
} from 'matrix-js-sdk/lib/webrtc/call'
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler'
import { notifyIncomingCall } from '@/shared/lib/desktopNotifications'

export type CallUiPhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'ended'

type CallStoreState = {
  client: MatrixClient | null
  call: MatrixCall | null
  phase: CallUiPhase
  roomId: string | null
  isVideo: boolean
  micMuted: boolean
  camMuted: boolean
  error: string | null
  startedAt: number | null
  /** Element Call BrowserWindow is open */
  elementCallOpen: boolean
  actions: {
    init: (client: MatrixClient) => void
    cleanup: () => void
    placeCall: (roomId: string, video: boolean) => Promise<void>
    answer: () => Promise<void>
    reject: () => void
    hangup: () => void
    toggleMic: () => Promise<void>
    toggleCam: () => Promise<void>
    clearError: () => void
    setElementCallOpen: (open: boolean) => void
  }
}

function phaseFromCall(call: MatrixCall | null): CallUiPhase {
  if (!call) return 'idle'
  const inbound = call.direction === CallDirection.Inbound
  switch (call.state) {
    case CallState.Ringing:
      return inbound ? 'incoming' : 'outgoing'
    case CallState.InviteSent:
    case CallState.WaitLocalMedia:
    case CallState.CreateOffer:
      return 'outgoing'
    case CallState.CreateAnswer:
    case CallState.Connecting:
      return 'connecting'
    case CallState.Connected:
      return 'connected'
    case CallState.Ended:
      return 'ended'
    default:
      return inbound ? 'incoming' : 'connecting'
  }
}

function muteFlags(call: MatrixCall): { micMuted: boolean; camMuted: boolean } {
  return {
    micMuted: !!call.isMicrophoneMuted?.(),
    camMuted: !!call.isLocalVideoMuted?.(),
  }
}

/** Rooms where Planetar uses native matrix-js-sdk 1:1 VoIP (not Element Call). */
export function isNativeCallRoom(room: Room): boolean {
  if (room.isSpaceRoom()) return false
  const n = room.getJoinedMemberCount()
  if (n > 2) return false
  if (room.getDMInviter?.()) return true
  const direct = room.client
    ?.getAccountData?.('m.direct')
    ?.getContent() as Record<string, string[]> | undefined
  if (direct) {
    for (const ids of Object.values(direct)) {
      if (Array.isArray(ids) && ids.includes(room.roomId)) return true
    }
  }
  // Classic 1:1 without m.direct still uses native VoIP
  return n >= 1 && n <= 2
}

export const useCallStore = create<CallStoreState>((set, get) => {
  let incomingHandler: ((call: MatrixCall) => void) | null = null
  let turnErrorHandler: ((error: Error, fatal: boolean) => void) | null = null
  let boundCall: MatrixCall | null = null
  let endedTimer: ReturnType<typeof setTimeout> | null = null

  const clearEndedTimer = () => {
    if (endedTimer != null) {
      window.clearTimeout(endedTimer)
      endedTimer = null
    }
  }

  const resetIdle = () => {
    clearEndedTimer()
    detachCallListeners()
    set({
      call: null,
      phase: 'idle',
      roomId: null,
      startedAt: null,
      micMuted: false,
      camMuted: false,
    })
  }

  const scheduleEndedCleanup = (call: MatrixCall) => {
    clearEndedTimer()
    set({ phase: 'ended', startedAt: null })
    endedTimer = window.setTimeout(() => {
      endedTimer = null
      if (get().call === call || get().phase === 'ended') {
        resetIdle()
      }
    }, 1200)
  }

  const detachCallListeners = () => {
    if (!boundCall) return
    boundCall.removeAllListeners(CallEvent.State)
    boundCall.removeAllListeners(CallEvent.Hangup)
    boundCall.removeAllListeners(CallEvent.Error)
    boundCall.removeAllListeners(CallEvent.FeedsChanged)
    boundCall = null
  }

  const bindCall = (call: MatrixCall) => {
    detachCallListeners()
    clearEndedTimer()
    boundCall = call

    const sync = () => {
      const next = phaseFromCall(call)
      const mutes = muteFlags(call)
      set({
        call,
        phase: next === 'ended' ? 'ended' : next,
        roomId: call.roomId,
        isVideo:
          call.type === CallType.Video ||
          (next === 'connected' && !mutes.camMuted),
        ...mutes,
        startedAt:
          next === 'connected'
            ? get().startedAt ?? Date.now()
            : next === 'idle' || next === 'ended'
              ? null
              : get().startedAt,
      })
      if (next === 'ended') {
        scheduleEndedCleanup(call)
      }
    }

    call.on(CallEvent.State, sync)
    call.on(CallEvent.Hangup, sync)
    call.on(CallEvent.FeedsChanged, sync)
    call.on(CallEvent.Error, (err) => {
      console.error('[call] error', err)
      set({
        error:
          err?.message ||
          'Ошибка звонка. Проверьте микрофон / камеру и сеть.',
      })
      sync()
    })
    sync()
  }

  return {
    client: null,
    call: null,
    phase: 'idle',
    roomId: null,
    isVideo: false,
    micMuted: false,
    camMuted: false,
    error: null,
    startedAt: null,
    elementCallOpen: false,
    actions: {
      init: (client) => {
        const prev = get().client
        if (prev && incomingHandler) {
          prev.off(CallEventHandlerEvent.Incoming, incomingHandler)
        }
        if (prev && turnErrorHandler) {
          prev.off(ClientEvent.TurnServersError, turnErrorHandler)
        }

        incomingHandler = (call: MatrixCall) => {
          const { call: current, elementCallOpen } = get()
          if (
            elementCallOpen ||
            (current && current.state !== CallState.Ended)
          ) {
            try {
              call.reject()
            } catch {
              /* busy */
            }
            return
          }
          bindCall(call)

          const room = client.getRoom(call.roomId)
          const myId = client.getUserId()
          const peer = room
            ?.getJoinedMembers()
            .find((m) => m.userId !== myId)
          const name =
            peer?.name ||
            peer?.rawDisplayName ||
            room?.name ||
            'Входящий звонок'
          void notifyIncomingCall({
            roomId: call.roomId,
            title: name,
            body:
              call.type === CallType.Video
                ? 'Входящий видеозвонок'
                : 'Входящий звонок',
          })
        }

        turnErrorHandler = (error, fatal) => {
          console.warn('[call] TURN error', error, fatal)
          if (fatal) {
            set({
              error:
                'Homeserver не отдаёт TURN-сервер. Звонки за NAT могут не работать.',
            })
          }
        }

        client.on(CallEventHandlerEvent.Incoming, incomingHandler)
        client.on(ClientEvent.TurnServersError, turnErrorHandler)
        set({ client })
      },
      cleanup: () => {
        const { client, call } = get()
        if (client && incomingHandler) {
          client.off(CallEventHandlerEvent.Incoming, incomingHandler)
        }
        if (client && turnErrorHandler) {
          client.off(ClientEvent.TurnServersError, turnErrorHandler)
        }
        incomingHandler = null
        turnErrorHandler = null
        if (call && call.state !== CallState.Ended) {
          try {
            call.hangup(CallErrorCode.UserHangup, false)
          } catch {
            /* ignore */
          }
        }
        clearEndedTimer()
        detachCallListeners()
        set({
          client: null,
          call: null,
          phase: 'idle',
          roomId: null,
          micMuted: false,
          camMuted: false,
          error: null,
          startedAt: null,
          elementCallOpen: false,
        })
      },
      placeCall: async (roomId, video) => {
        const { client, call, elementCallOpen } = get()
        if (!client) throw new Error('Нет Matrix-клиента')
        if (elementCallOpen) {
          throw new Error('Сначала закройте групповой звонок (Element Call)')
        }
        if (call && call.state !== CallState.Ended) {
          throw new Error('Уже есть активный звонок')
        }
        set({ error: null })

        const turns = client.getTurnServers?.() ?? []
        if (!turns.length) {
          // Soft warning — still attempt; many LANs work with host candidates
          console.warn('[call] no TURN servers yet')
        }

        const next = client.createCall(roomId)
        if (!next) {
          throw new Error('Не удалось создать звонок (VoIP недоступен)')
        }
        bindCall(next)
        set({
          isVideo: video,
          phase: 'outgoing',
          roomId,
          micMuted: false,
          camMuted: !video,
        })
        try {
          await next.placeCall(true, video)
          if (!video) {
            try {
              await next.setLocalVideoMuted(true)
            } catch {
              /* voice-only */
            }
          }
          set({ ...muteFlags(next) })
        } catch (err) {
          console.error('[call] placeCall failed', err)
          set({
            error:
              err instanceof Error
                ? err.message
                : 'Не удалось начать звонок',
          })
          try {
            next.hangup(CallErrorCode.UserHangup, false)
          } catch {
            /* ignore */
          }
          scheduleEndedCleanup(next)
        }
      },
      answer: async () => {
        const { call } = get()
        if (!call) return
        set({ error: null, phase: 'connecting' })
        try {
          await call.answer(true, call.type === CallType.Video)
          set({ ...muteFlags(call) })
        } catch (err) {
          console.error('[call] answer failed', err)
          set({
            error:
              err instanceof Error
                ? err.message
                : 'Не удалось принять звонок',
          })
          try {
            call.hangup(CallErrorCode.NoUserMedia, false)
          } catch {
            try {
              call.reject()
            } catch {
              /* ignore */
            }
          }
          scheduleEndedCleanup(call)
        }
      },
      reject: () => {
        const { call } = get()
        if (!call) return
        try {
          call.reject()
        } catch {
          try {
            call.hangup(CallErrorCode.UserHangup, false)
          } catch {
            /* ignore */
          }
        }
        resetIdle()
      },
      hangup: () => {
        const { call } = get()
        if (!call) return
        try {
          call.hangup(CallErrorCode.UserHangup, false)
        } catch {
          /* ignore */
        }
        scheduleEndedCleanup(call)
      },
      toggleMic: async () => {
        const { call, micMuted } = get()
        if (!call) return
        try {
          await call.setMicrophoneMuted(!micMuted)
          set({ micMuted: !!call.isMicrophoneMuted?.() })
        } catch (err) {
          console.error('[call] toggleMic failed', err)
        }
      },
      toggleCam: async () => {
        const { call, camMuted } = get()
        if (!call) return
        try {
          await call.setLocalVideoMuted(!camMuted)
          const muted = !!call.isLocalVideoMuted?.()
          set({
            camMuted: muted,
            isVideo: call.type === CallType.Video || !muted,
          })
        } catch (err) {
          console.error('[call] toggleCam failed', err)
          set({
            error:
              err instanceof Error
                ? err.message
                : 'Не удалось переключить камеру',
          })
        }
      },
      clearError: () => set({ error: null }),
      setElementCallOpen: (open) => set({ elementCallOpen: open }),
    },
  }
})

export function buildElementCallUrl(
  roomId: string,
  homeserverUrl?: string | null,
): string {
  const url = new URL('https://call.element.io/')
  if (homeserverUrl) {
    try {
      const hs = new URL(homeserverUrl).origin
      url.searchParams.set('homeserver', hs)
    } catch {
      /* ignore bad HS */
    }
  }
  url.hash = `/room/${encodeURIComponent(roomId)}`
  return url.toString()
}

export function roomHasActiveMatrixRtc(
  client: MatrixClient,
  roomId: string,
): boolean {
  try {
    const room = client.getRoom(roomId)
    if (!room) return false
    const session = client.matrixRTC?.getActiveRoomSession?.(room)
    if (!session) return false
    return (session.memberships?.length ?? 0) > 0
  } catch {
    return false
  }
}

/** True while native VoIP or Element Call occupies the line */
export function isCallLineBusy(state: {
  phase: CallUiPhase
  elementCallOpen: boolean
}): boolean {
  if (state.elementCallOpen) return true
  return (
    state.phase === 'outgoing' ||
    state.phase === 'incoming' ||
    state.phase === 'connecting' ||
    state.phase === 'connected'
  )
}
