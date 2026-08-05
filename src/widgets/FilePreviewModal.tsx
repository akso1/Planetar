import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Download, Eye, FileText, X } from 'lucide-react'
import { useSessionStore } from '@/entities/session/model/session'
import { downloadMessageAttachment } from '@/shared/lib/matrixMedia'
import {
  FILE_PREVIEW_TEXT_MAX_BYTES,
  detectFilePreviewKind,
  formatFileSize,
  type FilePreviewKind,
} from '@/shared/lib/filePreview'
import { prefersReducedMotion, popMotion } from '@/shared/lib/motion'
import { reportAppError } from '@/shared/lib/errorLog'

export type FilePreviewContent = {
  url?: string
  file?: any
  info?: { mimetype?: string; size?: number }
  body?: string
}

type Props = {
  open: boolean
  content: FilePreviewContent | null
  onClose: () => void
}

export function FilePreviewModal({ open, content, onClose }: Props) {
  const client = useSessionStore((s) => s.client)
  const reduce = prefersReducedMotion()
  const fileName = content?.body || 'file'
  const mime =
    content?.info?.mimetype ||
    content?.file?.mimetype ||
    'application/octet-stream'
  const kind: FilePreviewKind = useMemo(
    () => detectFilePreviewKind(mime, fileName),
    [mime, fileName],
  )

  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open || !content || !client) return
    let cancelled = false
    let url: string | null = null

    setLoading(true)
    setError(null)
    setText(null)
    setTruncated(false)
    setObjectUrl(null)

    void (async () => {
      try {
        const blob = await downloadMessageAttachment(client, content, mime)
        if (cancelled) return

        if (kind === 'text') {
          const slice = blob.slice(0, FILE_PREVIEW_TEXT_MAX_BYTES)
          const raw = await slice.text()
          if (cancelled) return
          setText(raw)
          setTruncated(blob.size > FILE_PREVIEW_TEXT_MAX_BYTES)
        }

        url = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        setObjectUrl(url)
      } catch (err) {
        if (cancelled) return
        console.error('[FilePreviewModal]', err)
        reportAppError({
          error: err,
          source: 'manual',
          context: { screen: 'file_preview' },
        })
        setError(
          err instanceof Error ? err.message : 'Не удалось открыть файл',
        )
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, content, client, mime, kind])

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open && content && (
        <motion.div
          className="fixed inset-0 z-[1300] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
            aria-label="Закрыть"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Просмотр: ${fileName}`}
            className="relative z-10 flex max-h-[min(88vh,820px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-hairline bg-[var(--menu-surface-solid)] shadow-panel"
            {...(reduce
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                }
              : popMotion)}
          >
            <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent-fg">
                {kind === 'pdf' ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-ink">
                  {fileName}
                </div>
                <div className="text-[11.5px] text-ink-muted truncate">
                  {[mime, formatFileSize(content.info?.size)]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {objectUrl && (
                <a
                  href={objectUrl}
                  download={fileName}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-surface-inset px-2.5 text-[12px] font-medium text-ink-muted hover:text-ink hover:border-hairline-strong transition-colors"
                >
                  <Download className="h-3.5 w-3.5" />
                  Скачать
                </a>
              )}
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-inset hover:text-ink transition-colors"
                aria-label="Закрыть"
              >
                <X className="h-4 h-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-black/10">
              {loading && (
                <div className="flex h-[min(60vh,520px)] items-center justify-center text-[13px] text-ink-muted">
                  Загрузка…
                </div>
              )}
              {!loading && error && (
                <div className="flex h-[min(40vh,280px)] flex-col items-center justify-center gap-2 px-6 text-center">
                  <div className="text-[13.5px] text-red-300">{error}</div>
                  <div className="text-[12px] text-ink-muted">
                    Можно скачать файл и открыть в другой программе
                  </div>
                </div>
              )}
              {!loading && !error && kind === 'text' && text != null && (
                <div className="flex h-[min(60vh,520px)] flex-col">
                  <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-ink">
                    {text}
                  </pre>
                  {truncated && (
                    <div className="border-t border-hairline px-4 py-2 text-[11.5px] text-ink-muted">
                      Показаны первые ~
                      {Math.round(FILE_PREVIEW_TEXT_MAX_BYTES / 1024)} КБ —
                      скачайте файл целиком
                    </div>
                  )}
                </div>
              )}
              {!loading && !error && kind === 'pdf' && objectUrl && (
                <iframe
                  title={fileName}
                  src={objectUrl}
                  className="h-[min(70vh,640px)] w-full border-0 bg-white"
                />
              )}
              {!loading && !error && kind === 'image' && objectUrl && (
                <div className="flex h-[min(70vh,640px)] items-center justify-center p-3">
                  <img
                    src={objectUrl}
                    alt={fileName}
                    className="max-h-full max-w-full object-contain rounded-lg"
                  />
                </div>
              )}
              {!loading && !error && kind === 'unsupported' && (
                <div className="flex h-[min(40vh,280px)] flex-col items-center justify-center gap-3 px-6 text-center">
                  <div className="text-[13.5px] text-ink">
                    Предпросмотр для этого типа недоступен
                  </div>
                  <div className="text-[12px] text-ink-muted max-w-sm">
                    Поддерживаются текст (txt, md, json, csv, код…), PDF и
                    изображения. Остальное — скачивание.
                  </div>
                  {objectUrl && (
                    <a
                      href={objectUrl}
                      download={fileName}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[12.5px] font-semibold text-[color:var(--color-on-accent)] hover:opacity-90"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Скачать файл
                    </a>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
