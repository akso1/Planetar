import { EventType, type MatrixEvent } from 'matrix-js-sdk'
import { CallErrorCode } from 'matrix-js-sdk/lib/webrtc/call'

export type CallHistoryStatus =
  | 'ringing'
  | 'missed'
  | 'no_answer'
  | 'rejected'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'answered_elsewhere'

export type CallHistorySummary = {
  callId: string
  invite: MatrixEvent | null
  answer: MatrixEvent | null
  hangup: MatrixEvent | null
  reject: MatrixEvent | null
  /** Chronologically first lifecycle event — placement anchor in the timeline */
  firstEvent: MatrixEvent
  /** Event used for timestamp / scroll id (prefer terminal) */
  anchorEvent: MatrixEvent
  isVideo: boolean
  /** Relative to local user */
  outbound: boolean
  status: CallHistoryStatus
  durationMs?: number
  /** Who sent the reject, if any */
  rejectedByMe?: boolean
}

const CALL_TYPES = new Set<string>([
  EventType.CallInvite,
  EventType.CallAnswer,
  EventType.CallHangup,
  EventType.CallReject,
])

export function isCallLifecycleEvent(event: MatrixEvent): boolean {
  return CALL_TYPES.has(event.getType())
}

export function getCallId(event: MatrixEvent): string | null {
  const id = (event.getContent() as { call_id?: unknown })?.call_id
  return typeof id === 'string' && id ? id : null
}

function isVideoInvite(invite: MatrixEvent | null): boolean {
  if (!invite) return false
  const content = invite.getContent() as {
    offer?: { sdp?: string }
    sdp_stream_metadata?: Record<
      string,
      { purpose?: string; video_muted?: boolean }
    >
    'org.matrix.msc3077.sdp_stream_metadata'?: Record<
      string,
      { purpose?: string; video_muted?: boolean }
    >
  }

  const meta =
    content.sdp_stream_metadata ||
    content['org.matrix.msc3077.sdp_stream_metadata']

  // Prefer explicit stream metadata: audio invites also use purpose m.usermedia
  if (meta && typeof meta === 'object') {
    const tracks = Object.values(meta).filter(
      (s) => s?.purpose === 'm.usermedia',
    )
    if (tracks.length > 0) {
      // Video call only if at least one usermedia track is not video-muted
      return tracks.some((s) => s?.video_muted === false)
    }
  }

  const sdp = content.offer?.sdp
  if (typeof sdp === 'string') {
    // m=video with inactive/recvonly-only often means voice-first offer — still
    // treat presence of an active send video section as video when no metadata.
    if (!/(^|\n)m=video\s/.test(sdp)) return false
    // If every video m-line is inactive, treat as audio
    const videoSections = sdp.split(/(?=^m=)/m).filter((b) => /^m=video\s/m.test(b))
    if (
      videoSections.length > 0 &&
      videoSections.every((b) => /a=inactive/i.test(b))
    ) {
      return false
    }
    return true
  }

  return false
}

function hangupReason(hangup: MatrixEvent | null): string | undefined {
  if (!hangup) return undefined
  const reason = (hangup.getContent() as { reason?: unknown })?.reason
  return typeof reason === 'string' ? reason : undefined
}

function resolveStatus(
  outbound: boolean,
  answer: MatrixEvent | null,
  hangup: MatrixEvent | null,
  reject: MatrixEvent | null,
  myUserId: string,
): {
  status: CallHistoryStatus
  rejectedByMe?: boolean
} {
  if (reject) {
    return {
      status: 'rejected',
      rejectedByMe: reject.getSender() === myUserId,
    }
  }

  const reason = hangupReason(hangup)

  if (answer && hangup) {
    if (
      reason === CallErrorCode.IceFailed ||
      reason === CallErrorCode.SignallingFailed ||
      reason === CallErrorCode.SetRemoteDescription ||
      reason === CallErrorCode.SetLocalDescription
    ) {
      return { status: 'failed' }
    }
    return { status: 'completed' }
  }

  if (answer && !hangup) {
    return { status: 'ringing' } // still connected — overlay owns UI
  }

  if (!hangup && !reject) {
    return { status: 'ringing' }
  }

  // Terminal without answer
  if (reason === CallErrorCode.UserBusy) {
    return {
      status: 'rejected',
      rejectedByMe: !outbound,
    }
  }

  if (
    reason === CallErrorCode.IceFailed ||
    reason === CallErrorCode.SignallingFailed ||
    reason === CallErrorCode.LocalOfferFailed ||
    reason === CallErrorCode.NoUserMedia ||
    reason === CallErrorCode.CreateOffer ||
    reason === CallErrorCode.CreateAnswer ||
    reason === CallErrorCode.SendInvite ||
    reason === CallErrorCode.SendAnswer
  ) {
    return { status: 'failed' }
  }

  if (reason === CallErrorCode.InviteTimeout) {
    return { status: outbound ? 'no_answer' : 'missed' }
  }

  if (reason === CallErrorCode.AnsweredElsewhere) {
    return { status: 'answered_elsewhere' }
  }

  if (reason === CallErrorCode.UserHangup || !reason) {
    if (!answer && hangup) {
      const iHungUp = hangup.getSender() === myUserId
      if (outbound) {
        return { status: iHungUp ? 'cancelled' : 'no_answer' }
      }
      return {
        status: iHungUp ? 'rejected' : 'missed',
        rejectedByMe: iHungUp,
      }
    }
    return { status: outbound ? 'cancelled' : 'missed' }
  }

  return { status: outbound ? 'no_answer' : 'missed' }
}

function pickAnchor(
  invite: MatrixEvent | null,
  answer: MatrixEvent | null,
  hangup: MatrixEvent | null,
  reject: MatrixEvent | null,
): MatrixEvent {
  const terminal = hangup || reject || answer || invite
  if (!terminal) {
    throw new Error('pickAnchor: empty call')
  }
  return terminal
}

function pickFirst(
  events: Array<MatrixEvent | null>,
): MatrixEvent {
  const present = events.filter(Boolean) as MatrixEvent[]
  present.sort((a, b) => a.getTs() - b.getTs())
  return present[0]
}

/**
 * Aggregate m.call.invite / answer / hangup / reject by call_id.
 */
export function buildCallHistoryMap(
  events: MatrixEvent[],
  myUserId: string,
): Map<string, CallHistorySummary> {
  type Acc = {
    invite: MatrixEvent | null
    answer: MatrixEvent | null
    hangup: MatrixEvent | null
    reject: MatrixEvent | null
  }
  const raw = new Map<string, Acc>()

  for (const event of events) {
    if (!isCallLifecycleEvent(event)) continue
    const callId = getCallId(event)
    if (!callId) continue
    let acc = raw.get(callId)
    if (!acc) {
      acc = { invite: null, answer: null, hangup: null, reject: null }
      raw.set(callId, acc)
    }
    const t = event.getType()
    if (t === EventType.CallInvite && !acc.invite) acc.invite = event
    else if (t === EventType.CallAnswer && !acc.answer) acc.answer = event
    else if (t === EventType.CallHangup && !acc.hangup) acc.hangup = event
    else if (t === EventType.CallReject && !acc.reject) acc.reject = event
  }

  const out = new Map<string, CallHistorySummary>()
  for (const [callId, acc] of raw) {
    const firstEvent = pickFirst([
      acc.invite,
      acc.answer,
      acc.hangup,
      acc.reject,
    ])
    if (!firstEvent) continue

    const outbound = acc.invite
      ? acc.invite.getSender() === myUserId
      : acc.answer
        ? acc.answer.getSender() !== myUserId
        : acc.reject
          ? acc.reject.getSender() !== myUserId
          : firstEvent.getSender() === myUserId

    const { status, rejectedByMe } = resolveStatus(
      outbound,
      acc.answer,
      acc.hangup,
      acc.reject,
      myUserId,
    )

    let durationMs: number | undefined
    if (acc.answer && acc.hangup) {
      durationMs = Math.max(0, acc.hangup.getTs() - acc.answer.getTs())
    }

    out.set(callId, {
      callId,
      invite: acc.invite,
      answer: acc.answer,
      hangup: acc.hangup,
      reject: acc.reject,
      firstEvent,
      anchorEvent: pickAnchor(acc.invite, acc.answer, acc.hangup, acc.reject),
      isVideo: isVideoInvite(acc.invite),
      outbound,
      status,
      durationMs,
      rejectedByMe,
    })
  }

  return out
}

export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Short label for timeline tile / room list preview */
export function callHistoryLabel(summary: CallHistorySummary): string {
  const video = summary.isVideo
  switch (summary.status) {
    case 'ringing':
      if (summary.answer) {
        return video ? 'Идёт видеозвонок' : 'Идёт звонок'
      }
      return video ? 'Видеозвонок…' : 'Звонок…'
    case 'missed':
      return video ? 'Пропущенный видеозвонок' : 'Пропущенный звонок'
    case 'no_answer':
      return video ? 'Нет ответа (видео)' : 'Нет ответа'
    case 'rejected':
      if (summary.rejectedByMe) {
        return video ? 'Отклонённый видеозвонок' : 'Отклонённый звонок'
      }
      return video ? 'Видеозвонок отклонён' : 'Звонок отклонён'
    case 'cancelled':
      return video ? 'Отменённый видеозвонок' : 'Отменённый звонок'
    case 'failed':
      return video
        ? 'Не удалось установить видеозвонок'
        : 'Не удалось дозвониться'
    case 'answered_elsewhere':
      return video
        ? 'Видеозвонок принят на другом устройстве'
        : 'Звонок принят на другом устройстве'
    case 'completed': {
      return summary.outbound
        ? video
          ? 'Исходящий видеозвонок'
          : 'Исходящий звонок'
        : video
          ? 'Входящий видеозвонок'
          : 'Входящий звонок'
    }
    default:
      return video ? 'Видеозвонок' : 'Звонок'
  }
}

/** Room-list / peek one-liner including duration when available */
export function callHistoryPreviewText(summary: CallHistorySummary): string {
  const label = callHistoryLabel(summary)
  if (
    summary.status === 'completed' &&
    summary.durationMs != null &&
    summary.durationMs > 0
  ) {
    return `${label} · ${formatCallDuration(summary.durationMs)}`
  }
  return label
}

/** True when the tile should appear in history (not an in-progress call) */
export function isTerminalCall(summary: CallHistorySummary): boolean {
  return summary.status !== 'ringing'
}

/** Event ids that belong to this call tile (for jump / scroll). */
export function callHistoryEventIds(summary: CallHistorySummary): string[] {
  const ids: string[] = []
  for (const ev of [
    summary.invite,
    summary.answer,
    summary.hangup,
    summary.reject,
    summary.firstEvent,
    summary.anchorEvent,
  ]) {
    const id = ev?.getId()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
