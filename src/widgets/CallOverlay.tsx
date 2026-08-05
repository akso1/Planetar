import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react'
import { clsx } from 'clsx'
import { CallFeedEvent, CallEvent, type CallFeed } from 'matrix-js-sdk'
import { useSessionStore } from '@/entities/session/model/session'
import { useCallStore } from '@/shared/lib/calls'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Always attach remote usermedia so audio plays even without a visible video tile. */
function RemoteMedia({ feed }: { feed: CallFeed | null }) {
  const audioRef = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (!feed) {
      el.srcObject = null
      return
    }
    const apply = () => {
      el.srcObject = feed.stream
      // Browsers may require an explicit play() after srcObject assign
      void el.play().catch(() => {
        /* autoplay policy — user gesture from Answer usually unlocks */
      })
    }
    apply()
    feed.on(CallFeedEvent.NewStream, apply)
    return () => {
      feed.off(CallFeedEvent.NewStream, apply)
      el.srcObject = null
    }
  }, [feed])

  // Keep <audio> mounted for the call phase even before remote feed arrives
  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      style={{
        position: 'fixed',
        width: 1,
        height: 1,
        left: -9999,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
      }}
      aria-hidden
    />
  )
}

function VideoTile({
  feed,
  mirrored,
  className,
}: {
  feed: CallFeed | null
  mirrored?: boolean
  className?: string
}) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !feed) return
    const apply = () => {
      el.srcObject = feed.stream
    }
    apply()
    feed.on(CallFeedEvent.NewStream, apply)
    return () => {
      feed.off(CallFeedEvent.NewStream, apply)
      el.srcObject = null
    }
  }, [feed])

  if (!feed) return null
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      // Audio always via RemoteMedia — avoid double playback on video tiles
      muted
      className={clsx(
        'object-cover bg-black/40',
        mirrored && 'scale-x-[-1]',
        className,
      )}
    />
  )
}

function useIncomingRingtone(active: boolean) {
  useEffect(() => {
    if (!active) return
    let ctx: AudioContext | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let stopped = false

    const beep = () => {
      if (stopped) return
      try {
        if (!ctx) ctx = new AudioContext()
        const now = ctx.currentTime
        for (const [i, freq] of [880, 660].entries()) {
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = 'sine'
          osc.frequency.value = freq
          gain.gain.setValueAtTime(0.0001, now)
          gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35)
          osc.connect(gain)
          gain.connect(ctx.destination)
          const t0 = now + i * 0.4
          osc.start(t0)
          osc.stop(t0 + 0.36)
        }
      } catch {
        /* autoplay / AudioContext blocked */
      }
    }

    beep()
    timer = window.setInterval(beep, 2200)
    return () => {
      stopped = true
      if (timer != null) window.clearInterval(timer)
      void ctx?.close()
    }
  }, [active])
}

export function CallOverlay() {
  const client = useSessionStore((s) => s.client)
  const phase = useCallStore((s) => s.phase)
  const call = useCallStore((s) => s.call)
  const roomId = useCallStore((s) => s.roomId)
  const isVideo = useCallStore((s) => s.isVideo)
  const micMuted = useCallStore((s) => s.micMuted)
  const camMuted = useCallStore((s) => s.camMuted)
  const error = useCallStore((s) => s.error)
  const startedAt = useCallStore((s) => s.startedAt)
  const answer = useCallStore((s) => s.actions.answer)
  const reject = useCallStore((s) => s.actions.reject)
  const hangup = useCallStore((s) => s.actions.hangup)
  const toggleMic = useCallStore((s) => s.actions.toggleMic)
  const toggleCam = useCallStore((s) => s.actions.toggleCam)
  const clearError = useCallStore((s) => s.actions.clearError)
  const [now, setNow] = useState(Date.now())
  const [, setFeedTick] = useState(0)

  useIncomingRingtone(phase === 'incoming')

  useEffect(() => {
    if (phase !== 'connected' || !startedAt) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [phase, startedAt])

  useEffect(() => {
    if (!call) return
    const bump = () => setFeedTick((n) => n + 1)
    call.on(CallEvent.FeedsChanged, bump)
    return () => {
      call.off(CallEvent.FeedsChanged, bump)
    }
  }, [call])

  const room = roomId && client ? client.getRoom(roomId) : null
  const peer = useMemo(() => {
    if (!room || !client) return null
    const myId = client.getUserId()
    const members = room.getJoinedMembers().filter((m) => m.userId !== myId)
    return members[0] ?? null
  }, [room, client])

  const remoteFeed =
    call
      ?.getRemoteFeeds?.()
      ?.find((f) => String(f.purpose) === 'm.usermedia') ??
    call?.getRemoteFeeds?.()?.[0] ??
    null
  const localFeed =
    call
      ?.getLocalFeeds?.()
      ?.find((f) => String(f.purpose) === 'm.usermedia') ??
    call?.getLocalFeeds?.()?.[0] ??
    null

  if (phase === 'idle' || !roomId) return null

  const title =
    peer?.name ||
    peer?.rawDisplayName ||
    room?.name ||
    'Звонок'

  const statusLabel =
    phase === 'incoming'
      ? isVideo
        ? 'Входящий видеозвонок'
        : 'Входящий звонок'
      : phase === 'outgoing'
        ? 'Вызов…'
        : phase === 'connecting'
          ? 'Соединение…'
          : phase === 'connected'
            ? startedAt
              ? formatElapsed(now - startedAt)
              : 'Разговор'
            : phase === 'ended'
              ? 'Звонок завершён'
              : ''

  const showFull =
    phase === 'outgoing' ||
    phase === 'connecting' ||
    phase === 'connected' ||
    phase === 'ended'

  const showRemoteVideo =
    isVideo && remoteFeed && !remoteFeed.isVideoMuted?.()

  return createPortal(
    <>
      {/* Remote audio must exist for voice-only and muted-video peers */}
      {(phase === 'connecting' || phase === 'connected') && (
        <RemoteMedia feed={remoteFeed} />
      )}

      {phase === 'incoming' && (
        <div
          className="fixed left-1/2 top-[52px] z-[1100] -translate-x-1/2 w-[min(420px,calc(100%-24px))]"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <div className="tg-profile-panel border border-hairline shadow-panel rounded-2xl px-4 py-3 flex items-center gap-3">
            {client && (
              <MxcAvatar
                client={client}
                mxcUrl={peer?.getMxcAvatarUrl?.() || room?.getMxcAvatarUrl?.()}
                label={title}
                size={44}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="tg-title text-[14px] font-semibold truncate">
                {title}
              </div>
              <div className="tg-muted text-[12px]">{statusLabel}</div>
            </div>
            <button
              type="button"
              onClick={() => void answer()}
              className="w-10 h-10 rounded-full flex items-center justify-center bg-emerald-500 text-white"
              title="Принять"
              aria-label="Принять"
            >
              <Phone className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => reject()}
              className="w-10 h-10 rounded-full flex items-center justify-center text-white bg-[var(--call-hangup)]"
              title="Отклонить"
              aria-label="Отклонить"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {showFull && (
        <div
          className="fixed inset-0 z-[1100] flex flex-col items-center justify-center"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div className="relative z-10 w-full max-w-lg mx-4 flex flex-col items-center">
            <div className="relative w-full aspect-video rounded-2xl overflow-hidden border border-hairline bg-[color-mix(in_srgb,var(--menu-surface)_92%,black)] shadow-panel">
              {showRemoteVideo ? (
                <VideoTile
                  feed={remoteFeed}
                  className="absolute inset-0 w-full h-full"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
                  {client && (
                    <MxcAvatar
                      client={client}
                      mxcUrl={
                        peer?.getMxcAvatarUrl?.() || room?.getMxcAvatarUrl?.()
                      }
                      label={title}
                      size={96}
                    />
                  )}
                  <div className="tg-title text-[18px] font-semibold text-center">
                    {title}
                  </div>
                  <div className="tg-muted text-[13px]">{statusLabel}</div>
                </div>
              )}
              {isVideo && localFeed && !camMuted && (
                <VideoTile
                  feed={localFeed}
                  mirrored
                  className="absolute right-3 bottom-3 w-28 h-40 rounded-xl border border-hairline shadow-float overflow-hidden"
                />
              )}
            </div>

            {showRemoteVideo && (
              <div className="mt-3 text-center">
                <div className="tg-title text-[15px] font-semibold">{title}</div>
                <div className="tg-muted text-[12px] mt-0.5">{statusLabel}</div>
              </div>
            )}

            {error && (
              <div className="mt-3 text-[12.5px] text-red-400 text-center px-2">
                {error}{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => clearError()}
                >
                  скрыть
                </button>
              </div>
            )}

            <div className="mt-5 flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => void toggleMic()}
                className={clsx(
                  'w-12 h-12 shrink-0 rounded-full flex items-center justify-center transition-colors',
                  'border border-hairline shadow-float',
                  micMuted
                    ? 'bg-[var(--call-hangup)] text-white border-transparent'
                    : 'bg-[color-mix(in_srgb,var(--menu-surface)_92%,transparent)] text-[color:var(--text)] hover:bg-[color-mix(in_srgb,var(--hover-surface)_80%,transparent)]',
                )}
                title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                aria-label={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
                aria-pressed={micMuted}
              >
                {micMuted ? (
                  <MicOff className="w-5 h-5" />
                ) : (
                  <Mic className="w-5 h-5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void toggleCam()}
                className={clsx(
                  'w-12 h-12 shrink-0 rounded-full flex items-center justify-center transition-colors',
                  'border border-hairline shadow-float',
                  camMuted
                    ? 'bg-[var(--call-hangup)] text-white border-transparent'
                    : 'bg-[color-mix(in_srgb,var(--menu-surface)_92%,transparent)] text-[color:var(--text)] hover:bg-[color-mix(in_srgb,var(--hover-surface)_80%,transparent)]',
                )}
                title={camMuted ? 'Включить камеру' : 'Выключить камеру'}
                aria-label={camMuted ? 'Включить камеру' : 'Выключить камеру'}
                aria-pressed={camMuted}
              >
                {camMuted ? (
                  <VideoOff className="w-5 h-5" />
                ) : (
                  <Video className="w-5 h-5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => hangup()}
                className="w-12 h-12 shrink-0 rounded-full flex items-center justify-center text-white shadow-float transition-colors bg-[var(--call-hangup)] hover:bg-[var(--call-hangup-hover)]"
                title="Завершить"
                aria-label="Завершить"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
