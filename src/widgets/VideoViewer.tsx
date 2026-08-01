import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pause,
  Play,
  X,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useSessionStore } from '@/entities/session/model/session'
import {
  acquireCachedObjectUrl,
  downloadMessageAttachment,
  releaseCachedObjectUrl,
} from '@/shared/lib/matrixMedia'
import { formatBytes } from '@/shared/lib/stickersStore'

export type ViewerVideo = {
  id: string
  content: {
    url?: string
    file?: any
    info?: {
      mimetype?: string
      size?: number
      w?: number
      h?: number
      duration?: number
    }
    body?: string
  }
  name?: string
}

type VideoViewerProps = {
  videos: ViewerVideo[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Matrix `info.duration` is milliseconds. */
function infoDurationSeconds(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return raw / 1000
}

function useViewerObjectUrl(content: ViewerVideo['content'] | null) {
  const client = useSessionStore((s) => s.client)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const mxcUrl = content?.file?.url || content?.url || null
  const mime =
    content?.info?.mimetype || content?.file?.mimetype || 'video/mp4'
  const cacheKey = mxcUrl ? `viewer-video:${mxcUrl}|${mime}` : null

  useEffect(() => {
    if (!client || !content || !cacheKey) {
      setObjectUrl(null)
      setError(false)
      setLoading(false)
      return
    }

    let cancelled = false
    let acquired = false
    let released = false
    const releaseOnce = () => {
      if (!acquired || released) return
      released = true
      releaseCachedObjectUrl(cacheKey)
    }

    setObjectUrl(null)
    setLoading(true)
    setError(false)

    void (async () => {
      try {
        const url = await acquireCachedObjectUrl(cacheKey, () =>
          downloadMessageAttachment(client, content, mime),
        )
        acquired = true
        if (cancelled) {
          releaseOnce()
          return
        }
        setObjectUrl(url)
        setLoading(false)
      } catch (err) {
        console.error('VideoViewer load failed:', err)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      releaseOnce()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cacheKey, mime])

  return { objectUrl, error, loading }
}

export function VideoViewer({
  videos,
  index,
  onClose,
  onIndexChange,
}: VideoViewerProps) {
  const safeIndex = Math.min(Math.max(index, 0), Math.max(videos.length - 1, 0))
  const current = videos[safeIndex] ?? null
  const { objectUrl, error, loading } = useViewerObjectUrl(
    current?.content ?? null,
  )
  const hasNav = videos.length > 1
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const rafRef = useRef<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  const infoDurationSec = infoDurationSeconds(current?.content.info?.duration)
  const displayDuration =
    Number.isFinite(duration) && duration > 0 ? duration : infoDurationSec
  const fileSize =
    typeof current?.content.info?.size === 'number'
      ? current.content.info.size
      : undefined

  const syncTimeFromVideo = useCallback(() => {
    const v = videoRef.current
    if (!v || draggingRef.current) return
    setCurrentTime(v.currentTime)
    const d = v.duration
    if (Number.isFinite(d) && d > 0) setDuration(d)
  }, [])

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const startRaf = useCallback(() => {
    stopRaf()
    const tick = () => {
      syncTimeFromVideo()
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [stopRaf, syncTimeFromVideo])

  const goPrev = useCallback(() => {
    if (!hasNav) return
    onIndexChange((safeIndex - 1 + videos.length) % videos.length)
  }, [hasNav, safeIndex, videos.length, onIndexChange])

  const goNext = useCallback(() => {
    if (!hasNav) return
    onIndexChange((safeIndex + 1) % videos.length)
  }, [hasNav, safeIndex, videos.length, onIndexChange])

  useEffect(() => {
    draggingRef.current = false
    stopRaf()
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
  }, [current?.id, stopRaf])

  useEffect(() => {
    return () => stopRaf()
  }, [stopRaf])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goPrev()
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        goNext()
        return
      }
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault()
        const v = videoRef.current
        if (!v || !objectUrl) return
        if (v.paused) void v.play().catch(() => {})
        else v.pause()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext, objectUrl])

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }

  const seekToClientX = (clientX: number) => {
    const el = seekRef.current
    const v = videoRef.current
    const total = displayDuration
    if (!el || !v || !(total > 0)) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const t = ratio * total
    try {
      v.currentTime = t
    } catch {
      /* ignore seek before ready */
    }
    setCurrentTime(t)
  }

  const endSeekDrag = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    syncTimeFromVideo()
  }, [syncTimeFromVideo])

  useEffect(() => {
    const onUp = () => endSeekDrag()
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [endSeekDrag])

  const onSeekPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    seekToClientX(e.clientX)
  }

  const onSeekPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    seekToClientX(e.clientX)
  }

  const onSeekPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* ignore */
    }
    endSeekDrag()
  }

  const handleDownload = () => {
    if (!objectUrl || !current) return
    const a = document.createElement('a')
    a.href = objectUrl
    a.download =
      current.name || current.content.body || `video-${safeIndex + 1}.mp4`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const progress =
    displayDuration > 0 ? Math.min(1, Math.max(0, currentTime / displayDuration)) : 0

  if (!current) return null

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="tg-video-viewer fixed inset-0 z-[1200] flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="dialog"
        aria-modal="true"
        aria-label="Просмотр видео"
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/85 backdrop-blur-[2px]"
          aria-label="Закрыть"
          onClick={onClose}
        />

        <div className="absolute top-[42px] inset-x-0 z-10 flex items-center justify-between px-4 py-2 pointer-events-none">
          <div className="text-white/70 text-sm pointer-events-auto pl-16 sm:pl-2">
            {hasNav ? `${safeIndex + 1} / ${videos.length}` : 'Видео'}
          </div>
          <div className="flex items-center gap-2 pointer-events-auto">
            <button
              type="button"
              onClick={handleDownload}
              disabled={!objectUrl}
              className={clsx(
                'flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors',
                'bg-white/10 hover:bg-white/20 text-white disabled:opacity-40',
              )}
              title="Скачать"
            >
              <Download className="w-4 h-4" />
              Скачать
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 bg-white/10 hover:bg-white/20 text-white transition-colors"
              aria-label="Закрыть"
              title="Esc"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {hasNav && (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                goPrev()
              }}
              className="absolute left-3 z-10 rounded-full p-2.5 bg-black/40 hover:bg-black/60 text-white transition-colors"
              aria-label="Предыдущее видео"
            >
              <ChevronLeft className="w-7 h-7" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                goNext()
              }}
              className="absolute right-3 z-10 rounded-full p-2.5 bg-black/40 hover:bg-black/60 text-white transition-colors"
              aria-label="Следующее видео"
            >
              <ChevronRight className="w-7 h-7" />
            </button>
          </>
        )}

        <motion.div
          key={current?.id ?? safeIndex}
          className="relative z-[1] w-[min(96vw,1100px)] max-h-[88vh] flex flex-col items-center px-12"
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tg-video-viewer-stage relative w-full flex items-center justify-center rounded-2xl overflow-hidden bg-black/50 shadow-2xl min-h-[200px]">
            {error && (
              <div className="text-white/60 text-sm py-16">
                Не удалось загрузить видео
              </div>
            )}
            {!error && (loading || !objectUrl) && (
              <div className="flex items-center gap-2 text-white/45 text-sm py-16">
                <Loader2 className="w-4 h-4 animate-spin" />
                Загрузка…
              </div>
            )}
            {objectUrl && !error && (
              <video
                ref={videoRef}
                key={objectUrl}
                src={objectUrl}
                className="max-w-full max-h-[min(72vh,820px)] w-auto h-auto object-contain bg-black"
                playsInline
                preload="auto"
                onClick={togglePlay}
                onPlay={() => {
                  setPlaying(true)
                  startRaf()
                }}
                onPause={() => {
                  setPlaying(false)
                  stopRaf()
                  syncTimeFromVideo()
                }}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration
                  if (Number.isFinite(d) && d > 0) setDuration(d)
                }}
                onDurationChange={(e) => {
                  const d = e.currentTarget.duration
                  if (Number.isFinite(d) && d > 0) setDuration(d)
                }}
                onTimeUpdate={syncTimeFromVideo}
                onSeeked={syncTimeFromVideo}
                onEnded={() => {
                  setPlaying(false)
                  stopRaf()
                  syncTimeFromVideo()
                }}
              />
            )}

            {objectUrl && !error && !playing && (
              <button
                type="button"
                className="tg-video-viewer-play absolute w-16 h-16 rounded-full bg-black/45 text-white flex items-center justify-center shadow-lg"
                aria-hidden
                tabIndex={-1}
              >
                <Play className="w-8 h-8 ml-0.5" fill="currentColor" />
              </button>
            )}
          </div>

          <div className="tg-video-viewer-controls mt-3 w-full rounded-2xl bg-white/[0.08] border border-white/10 backdrop-blur-xl px-3.5 py-3 shadow-lg">
            <div
              ref={seekRef}
              className="tg-video-seek group relative h-5 flex items-center cursor-pointer touch-none select-none"
              onPointerDown={onSeekPointerDown}
              onPointerMove={onSeekPointerMove}
              onPointerUp={onSeekPointerUp}
              onPointerCancel={onSeekPointerUp}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.round(displayDuration))}
              aria-valuenow={Math.round(currentTime)}
              aria-label="Перемотка"
            >
              <div className="relative w-full h-1 rounded-full bg-white/15 overflow-visible">
                <div
                  className="h-full rounded-full bg-accent-hover"
                  style={{ width: `${progress * 100}%` }}
                />
                <div
                  className="tg-video-seek-thumb absolute top-1/2 w-3.5 h-3.5 -mt-[7px] -ml-[7px] rounded-full bg-white shadow-md opacity-90 group-hover:opacity-100 pointer-events-none"
                  style={{ left: `${progress * 100}%` }}
                />
              </div>
            </div>

            <div className="mt-2.5 flex items-center gap-3">
              <button
                type="button"
                onClick={togglePlay}
                disabled={!objectUrl}
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors disabled:opacity-40"
                aria-label={playing ? 'Пауза' : 'Воспроизвести'}
              >
                {playing ? (
                  <Pause className="w-4 h-4" fill="currentColor" />
                ) : (
                  <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
                )}
              </button>

              <div className="text-[12.5px] text-white/75 tabular-nums min-w-[88px]">
                {formatClock(currentTime)}
                <span className="text-white/35"> / </span>
                {formatClock(displayDuration)}
              </div>

              <div className="flex-1 min-w-0 text-[12.5px] text-white/45 truncate">
                {current?.name || current?.content.body || 'Видео'}
              </div>

              {fileSize != null && fileSize > 0 && (
                <div className="text-[12px] text-white/50 tabular-nums shrink-0">
                  {formatBytes(fileSize)}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
