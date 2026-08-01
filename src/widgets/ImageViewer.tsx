import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react'
import { clsx } from 'clsx'
import { useSessionStore } from '@/entities/session/model/session'
import {
  acquireCachedObjectUrl,
  downloadMessageAttachment,
  releaseCachedObjectUrl,
} from '@/shared/lib/matrixMedia'

export type ViewerImage = {
  id: string
  content: {
    url?: string
    file?: any
    info?: { mimetype?: string }
    body?: string
  }
  name?: string
}

type ImageViewerProps = {
  images: ViewerImage[]
  index: number
  onClose: () => void
  onIndexChange: (index: number) => void
}

function useViewerObjectUrl(content: ViewerImage['content'] | null) {
  const client = useSessionStore((s) => s.client)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const mxcUrl = content?.file?.url || content?.url || null
  const mime =
    content?.info?.mimetype || content?.file?.mimetype || 'image/jpeg'
  const cacheKey = mxcUrl ? `viewer:${mxcUrl}|${mime}` : null

  useEffect(() => {
    if (!client || !content || !cacheKey) {
      setObjectUrl(null)
      setError(false)
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

    const load = async () => {
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
        setError(false)
      } catch (err) {
        console.error('ImageViewer load failed:', err)
        if (!cancelled) setError(true)
      }
    }

    void load()

    return () => {
      cancelled = true
      releaseOnce()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cacheKey, mime])

  return { objectUrl, error }
}

export function ImageViewer({
  images,
  index,
  onClose,
  onIndexChange,
}: ImageViewerProps) {
  const safeIndex = Math.min(Math.max(index, 0), Math.max(images.length - 1, 0))
  const current = images[safeIndex] ?? null
  const { objectUrl, error } = useViewerObjectUrl(current?.content ?? null)
  const hasNav = images.length > 1

  const goPrev = useCallback(() => {
    if (!hasNav) return
    onIndexChange((safeIndex - 1 + images.length) % images.length)
  }, [hasNav, safeIndex, images.length, onIndexChange])

  const goNext = useCallback(() => {
    if (!hasNav) return
    onIndexChange((safeIndex + 1) % images.length)
  }, [hasNav, safeIndex, images.length, onIndexChange])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext])

  // Prevent background scroll
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const handleDownload = () => {
    if (!objectUrl || !current) return
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = current.name || current.content.body || `image-${safeIndex + 1}.jpg`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return createPortal(
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[1200] flex items-center justify-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
      >
        <button
          type="button"
          className="absolute inset-0 bg-black/85 backdrop-blur-[2px]"
          aria-label="Close"
          onClick={onClose}
        />

        {/* Top bar — below macOS traffic lights / frameless titlebar (~38px) */}
        <div className="absolute top-[42px] inset-x-0 z-10 flex items-center justify-between px-4 py-2 pointer-events-none">
          <div className="text-white/70 text-sm pointer-events-auto pl-16 sm:pl-2">
            {hasNav ? `${safeIndex + 1} / ${images.length}` : ''}
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
              title="Download"
            >
              <Download className="w-4 h-4" />
              Скачать
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 bg-white/10 hover:bg-white/20 text-white transition-colors"
              aria-label="Close"
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
              aria-label="Previous"
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
              aria-label="Next"
            >
              <ChevronRight className="w-7 h-7" />
            </button>
          </>
        )}

        <motion.div
          key={current?.id ?? safeIndex}
          className="relative z-[1] max-w-[min(96vw,1200px)] max-h-[88vh] flex items-center justify-center px-12"
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          onClick={(e) => e.stopPropagation()}
        >
          {error && (
            <div className="text-white/60 text-sm">Не удалось загрузить изображение</div>
          )}
          {!error && !objectUrl && (
            <div className="text-white/40 text-sm italic">Загрузка…</div>
          )}
          {objectUrl && (
            <img
              src={objectUrl}
              alt={current?.name || 'Image'}
              className="max-w-full max-h-[88vh] object-contain rounded-lg shadow-2xl select-none"
              draggable={false}
            />
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  )
}
