import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import {
  Image as ImageIcon,
  Loader2,
  Search,
  Smile,
  Sticker,
  Trash2,
} from 'lucide-react'
import { useStickersStore, type StoredSticker } from '@/shared/lib/stickersStore'
import { useSavedGifsStore } from '@/shared/lib/savedGifsStore'
import { searchGifs, type GifResult } from '@/shared/lib/gifSearch'
import { AppContextMenu } from '@/shared/ui/AppContextMenu'
import { ALL_CONTEXT_EMOJIS } from '@/shared/lib/contextEmojis'
import { TwemojiImg } from '@/shared/ui/twemoji'
import { useSessionStore } from '@/entities/session/model/session'

export type StickerPickerTab = 'emoji' | 'stickers' | 'gif'

type StickerPickerProps = {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onPickSticker: (sticker: StoredSticker) => void
  onPickGif: (gif: GifResult) => void
  onPickEmoji: (emoji: string) => void
  /** When true, only the emoji tab is available (e.g. while editing) */
  emojiOnly?: boolean
}

const EMOJI_LIST = (() => {
  const map = new Map<string, string>()
  for (const e of ALL_CONTEXT_EMOJIS) {
    map.set(e.emoji, `${map.get(e.emoji) ?? ''} ${e.keywords}`.trim())
  }
  return [...map.entries()].map(([emoji, keywords]) => ({ emoji, keywords }))
})()

export function StickerPicker({
  open,
  anchorRef,
  onClose,
  onPickSticker,
  onPickGif,
  onPickEmoji,
  emojiOnly = false,
}: StickerPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const emojiSearchRef = useRef<HTMLInputElement>(null)
  const [tab, setTab] = useState<StickerPickerTab>('emoji')
  const [pos, setPos] = useState({ left: 0, bottom: 72 })
  /** Hide until laid out — avoids a one-frame jump to left:0 / wrong side. */
  const [ready, setReady] = useState(false)
  const packs = useStickersStore((s) => s.packs)
  const hydrateStickers = useStickersStore((s) => s.hydrate)
  const client = useSessionStore((s) => s.client)
  const savedItems = useSavedGifsStore((s) => s.items)
  const hydrateSaved = useSavedGifsStore((s) => s.hydrate)
  const removeSaved = useSavedGifsStore((s) => s.remove)
  const [activePackId, setActivePackId] = useState<string | null>(null)

  const [emojiQuery, setEmojiQuery] = useState('')
  const [gifQuery, setGifQuery] = useState('')
  const [gifs, setGifs] = useState<GifResult[]>([])
  const [gifLoading, setGifLoading] = useState(false)
  const [gifError, setGifError] = useState<string | null>(null)
  const [gifCtx, setGifCtx] = useState<{
    x: number
    y: number
    savedId: string
  } | null>(null)
  const [gifPreview, setGifPreview] = useState<{
    gif: GifResult
    top: number
    /** Distance from viewport left (when placed to the right / above) */
    left?: number
    /** Distance from viewport right (when placed to the left of picker) */
    right?: number
    maxW: number
    maxH: number
  } | null>(null)
  const gifPreviewRef = useRef(gifPreview)
  gifPreviewRef.current = gifPreview
  const gifPreviewElRef = useRef<HTMLDivElement>(null)
  const gifPreviewTimer = useRef<number | null>(null)
  const gifPreviewHideTimer = useRef<number | null>(null)

  const clearGifPreviewTimers = () => {
    if (gifPreviewTimer.current != null) {
      window.clearTimeout(gifPreviewTimer.current)
      gifPreviewTimer.current = null
    }
    if (gifPreviewHideTimer.current != null) {
      window.clearTimeout(gifPreviewHideTimer.current)
      gifPreviewHideTimer.current = null
    }
  }

  const hideGifPreview = (immediate = false) => {
    clearGifPreviewTimers()
    if (immediate) {
      setGifPreview(null)
      return
    }
    gifPreviewHideTimer.current = window.setTimeout(() => {
      setGifPreview(null)
      gifPreviewHideTimer.current = null
    }, 120)
  }

  const showGifPreview = (gif: GifResult, el: HTMLElement) => {
    clearGifPreviewTimers()
    gifPreviewTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect()
      const panel = panelRef.current?.getBoundingClientRect()
      const gap = 10
      const edge = 8
      const panelLeft = panel?.left ?? rect.left
      const panelRight = panel?.right ?? rect.right
      const spaceRight = window.innerWidth - panelRight - gap - edge
      const spaceLeft = panelLeft - gap - edge
      const viewportMaxH = Math.max(120, window.innerHeight - edge * 2)
      // Leave room for frame padding + optional caption
      const hardMaxW = Math.min(320, window.innerWidth - edge * 2)
      const hardMaxH = Math.min(260, viewportMaxH - 40)

      let top = Math.min(rect.top, window.innerHeight - Math.min(hardMaxH, 180) - edge)
      if (top < edge) top = edge

      if (spaceRight >= 140) {
        const maxW = Math.min(hardMaxW, spaceRight)
        const maxH = Math.min(hardMaxH, Math.max(100, window.innerHeight - top - edge - 40))
        setGifPreview({ gif, top, left: panelRight + gap, maxW, maxH })
      } else if (spaceLeft >= 140) {
        const maxW = Math.min(hardMaxW, spaceLeft)
        const maxH = Math.min(hardMaxH, Math.max(100, window.innerHeight - top - edge - 40))
        setGifPreview({
          gif,
          top,
          right: window.innerWidth - panelLeft + gap,
          maxW,
          maxH,
        })
      } else {
        const maxW = Math.min(hardMaxW, window.innerWidth - edge * 2)
        const above = Math.max(0, rect.top - gap - edge)
        const maxH = Math.min(hardMaxH, above > 120 ? Math.max(100, above - 40) : Math.max(100, viewportMaxH - 40))
        let left = rect.left + rect.width / 2 - maxW / 2
        left = Math.max(edge, Math.min(left, window.innerWidth - maxW - edge))
        top =
          above > 120
            ? Math.max(edge, rect.top - (maxH + 40) - gap)
            : edge
        setGifPreview({ gif, top, left, maxW, maxH })
      }
      gifPreviewTimer.current = null
    }, 220)
  }

  // Keep preview fully inside the viewport after real image size is known
  useLayoutEffect(() => {
    if (!gifPreview) return
    const node = gifPreviewElRef.current
    if (!node) return
    const edge = 8
    const clamp = () => {
      const box = node.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      const prev = gifPreviewRef.current
      if (!prev) return

      let top = prev.top
      let left = prev.left
      let right = prev.right
      let maxH = prev.maxH
      let changed = false

      if (box.height > window.innerHeight - edge * 2) {
        maxH = Math.max(100, window.innerHeight - edge * 2 - 36)
        changed = true
      }
      if (box.bottom > window.innerHeight - edge) {
        top = Math.max(edge, window.innerHeight - box.height - edge)
        changed = true
      }
      if (top < edge) {
        top = edge
        changed = true
      }
      if (left != null && box.right > window.innerWidth - edge) {
        left = Math.max(edge, window.innerWidth - box.width - edge)
        changed = true
      }
      if (left != null && box.left < edge) {
        left = edge
        changed = true
      }
      if (right != null && box.left < edge) {
        // Pull inward from the left overflow by increasing `right`
        right = Math.min(
          right + (edge - box.left),
          window.innerWidth - edge,
        )
        changed = true
      }

      if (
        !changed ||
        (top === prev.top &&
          left === prev.left &&
          right === prev.right &&
          maxH === prev.maxH)
      ) {
        return
      }
      setGifPreview({ ...prev, top, left, right, maxH })
    }
    clamp()
    const img = node.querySelector('img')
    if (img && !img.complete) {
      img.addEventListener('load', clamp)
      return () => img.removeEventListener('load', clamp)
    }
  }, [gifPreview?.gif.id, gifPreview?.left, gifPreview?.right, gifPreview?.maxW, gifPreview?.maxH])

  useEffect(() => {
    void hydrateStickers(client)
    hydrateSaved()
  }, [hydrateStickers, hydrateSaved, client])

  useEffect(() => {
    if (!open) return
    if (emojiOnly && tab !== 'emoji') setTab('emoji')
  }, [open, emojiOnly, tab])

  useLayoutEffect(() => {
    if (!open) {
      setReady(false)
      return
    }
    setReady(false)
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const width = Math.min(
        tab === 'gif' ? 380 : 340,
        window.innerWidth - 24,
      )
      let left = r.left
      if (left + width > window.innerWidth - 12) {
        left = window.innerWidth - width - 12
      }
      if (left < 12) left = 12
      setPos({
        left,
        bottom: Math.max(12, window.innerHeight - r.top + 8),
      })
      setReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, tab])

  useEffect(() => {
    if (!open) {
      setGifCtx(null)
      hideGifPreview(true)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (gifCtx) {
          setGifCtx(null)
          return
        }
        if (gifPreviewRef.current) {
          hideGifPreview(true)
          return
        }
        onClose()
      }
    }
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      if ((e.target as HTMLElement | null)?.closest?.('[role="menu"]')) return
      if ((e.target as HTMLElement | null)?.closest?.('.tg-gif-preview')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open, onClose, anchorRef, gifCtx])

  useEffect(() => {
    if (tab !== 'gif') hideGifPreview(true)
  }, [tab])

  useEffect(() => () => clearGifPreviewTimers(), [])

  useEffect(() => {
    if (packs.length && !activePackId) setActivePackId(packs[0].id)
  }, [packs, activePackId])

  useEffect(() => {
    if (!open || tab !== 'gif') return
    let cancelled = false
    const q = gifQuery.trim()
    const delay = q ? 280 : 0
    const t = window.setTimeout(async () => {
      setGifLoading(!!q)
      setGifError(null)
      try {
        const { results, error } = await searchGifs(gifQuery)
        if (!cancelled) {
          setGifs(results)
          setGifError(error)
        }
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          setGifs([])
          setGifError('Не удалось загрузить GIF')
        }
      } finally {
        if (!cancelled) setGifLoading(false)
      }
    }, delay)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [open, tab, gifQuery, savedItems])

  const filteredEmojis = useMemo(() => {
    const q = emojiQuery.trim().toLowerCase()
    if (!q) return EMOJI_LIST
    return EMOJI_LIST.filter(
      (e) => e.emoji.includes(q) || e.keywords.toLowerCase().includes(q),
    )
  }, [emojiQuery])

  if (!open) return null

  const activePack = packs.find((p) => p.id === activePackId) ?? packs[0]
  const libraryCount = gifs.filter((g) => g.source === 'saved').length
  const searching = !!gifQuery.trim()

  const tabs = (
    [
      { id: 'emoji' as const, label: 'Смайлы', icon: Smile },
      ...(!emojiOnly
        ? ([
            { id: 'stickers' as const, label: 'Стикеры', icon: Sticker },
            { id: 'gif' as const, label: 'GIF', icon: ImageIcon },
          ] as const)
        : []),
    ] as const
  )

  return (
    <>
      {createPortal(
        <div
          ref={panelRef}
          className={clsx(
            'tg-sticker-picker fixed z-[950] flex flex-col',
            tab === 'gif' && 'tg-sticker-picker--gif',
          )}
          style={{
            left: pos.left,
            bottom: pos.bottom,
            visibility: ready ? 'visible' : 'hidden',
            pointerEvents: ready ? 'auto' : 'none',
          }}
          role="dialog"
          aria-label="Смайлы, стикеры и GIF"
        >
          <div className="flex items-center gap-1 px-2 pt-2 shrink-0">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={clsx(
                  'tg-picker-tab flex-1 h-8 flex items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors',
                  tab === id && 'tg-picker-tab--active',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>

          {tab === 'emoji' ? (
            <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 pt-2 gap-2">
              <div className="relative shrink-0">
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center justify-center"
                  aria-hidden
                >
                  <Search className="tg-picker-search-icon" strokeWidth={2} />
                </span>
                <input
                  ref={emojiSearchRef}
                  type="text"
                  value={emojiQuery}
                  onChange={(e) => setEmojiQuery(e.target.value)}
                  placeholder="Поиск смайлов…"
                  className="tg-field w-full h-8 rounded-lg pl-8 pr-2.5 text-[12.5px] leading-none outline-none"
                />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {filteredEmojis.length === 0 ? (
                  <div className="tg-picker-empty px-3 py-8 text-center text-[12px]">
                    Ничего не найдено
                  </div>
                ) : (
                  <div className="grid grid-cols-7 gap-0.5">
                    {filteredEmojis.map(({ emoji }) => (
                      <button
                        key={emoji}
                        type="button"
                        className="tg-picker-cell aspect-square rounded-lg flex items-center justify-center text-[22px] leading-none transition-colors"
                        title={emoji}
                        onClick={() => onPickEmoji(emoji)}
                      >
                        <TwemojiImg
                          emoji={emoji}
                          className="tg-twemoji tg-twemoji--lg"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : tab === 'stickers' ? (
            <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 pt-2">
              {packs.length === 0 ? (
                <div className="tg-picker-empty flex-1 flex items-center justify-center px-4 text-center text-[12.5px] leading-relaxed">
                  Нет стикеров. Добавьте пак в Настройках → Мои стикеры.
                </div>
              ) : (
                <>
                  <div className="flex gap-1 overflow-x-auto pb-2 shrink-0">
                    {packs.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setActivePackId(p.id)}
                        className={clsx(
                          'tg-picker-chip shrink-0 px-2.5 h-7 rounded-full text-[11.5px] font-medium transition-colors',
                          activePack?.id === p.id && 'tg-picker-chip--active',
                        )}
                        title={p.name}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <div className="grid grid-cols-4 gap-2 p-1">
                      {(activePack?.stickers ?? []).map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className="tg-picker-cell aspect-square rounded-xl p-1 transition-colors"
                          onClick={() => {
                            onPickSticker(s)
                            onClose()
                          }}
                          title={s.name}
                        >
                          <img
                            src={s.dataUrl}
                            alt={s.name}
                            className="w-full h-full object-contain rounded-lg"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 pt-2 gap-2">
              <div className="relative shrink-0">
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center justify-center"
                  aria-hidden
                >
                  <Search className="tg-picker-search-icon" strokeWidth={2} />
                </span>
                <input
                  type="text"
                  value={gifQuery}
                  onChange={(e) => setGifQuery(e.target.value)}
                  placeholder="Сохранённые · введите запрос для поиска…"
                  className="tg-field w-full h-8 rounded-lg pl-8 pr-2.5 text-[12.5px] leading-none outline-none"
                />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {gifLoading && (
                  <div className="tg-picker-empty flex items-center justify-center py-10 gap-2 text-[12px]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Поиск в сети…
                  </div>
                )}
                {!gifLoading && gifError && gifs.length === 0 && (
                  <div className="tg-picker-empty px-3 py-8 text-center text-[12px] leading-relaxed">
                    {gifError}
                  </div>
                )}
                {!gifLoading && !gifError && gifs.length === 0 && !searching && (
                  <div className="tg-picker-empty px-3 py-8 text-center text-[12px] leading-relaxed">
                    Нет сохранённых GIF.
                    <br />
                    ПКМ по GIF в чате → «Сохранить GIF».
                    <br />
                    Введите запрос, чтобы искать в сети.
                  </div>
                )}
                {!gifLoading && gifs.length > 0 && (
                  <>
                    {libraryCount > 0 && (
                      <div className="tg-picker-section-label px-0.5 pb-1.5 text-[10.5px] font-medium uppercase tracking-wide">
                        Сохранённые · {libraryCount}
                      </div>
                    )}
                    <div className="tg-gif-masonry">
                      {gifs.map((g, i) => {
                        const savedId =
                          g.source === 'saved' && g.id.startsWith('saved_')
                            ? g.id.replace(/^saved_/, '')
                            : null
                        return (
                          <React.Fragment key={g.id}>
                            {libraryCount > 0 &&
                              i === libraryCount &&
                              searching && (
                                <div className="tg-picker-section-label tg-gif-masonry__label px-0.5 pt-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-wide">
                                  Из сети
                                </div>
                              )}
                            <button
                              type="button"
                              className="tg-picker-cell tg-gif-tile rounded-xl overflow-hidden transition-shadow"
                              onClick={() => {
                                hideGifPreview(true)
                                onPickGif(g)
                                onClose()
                              }}
                              onMouseEnter={(e) =>
                                showGifPreview(g, e.currentTarget)
                              }
                              onMouseLeave={() => hideGifPreview()}
                              onFocus={(e) =>
                                showGifPreview(g, e.currentTarget)
                              }
                              onBlur={() => hideGifPreview()}
                              onContextMenu={(e) => {
                                if (!savedId) return
                                e.preventDefault()
                                e.stopPropagation()
                                hideGifPreview(true)
                                setGifCtx({
                                  x: e.clientX,
                                  y: e.clientY,
                                  savedId,
                                })
                              }}
                              title={undefined}
                              aria-label={
                                g.source === 'saved'
                                  ? `${g.title} (сохранённый)`
                                  : `${g.title} (${g.source})`
                              }
                            >
                              <img
                                src={g.previewUrl}
                                alt={g.title}
                                className="tg-gif-tile__img"
                                loading="lazy"
                              />
                            </button>
                          </React.Fragment>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
      {gifPreview &&
        createPortal(
          <div
            ref={gifPreviewElRef}
            className="tg-gif-preview fixed z-[960] pointer-events-none"
            style={{
              top: gifPreview.top,
              ...(gifPreview.right != null
                ? { right: gifPreview.right, left: 'auto' }
                : { left: gifPreview.left, right: 'auto' }),
              ['--tg-gif-preview-max-w' as string]: `${gifPreview.maxW}px`,
              ['--tg-gif-preview-max-h' as string]: `${gifPreview.maxH}px`,
            }}
            role="presentation"
            aria-hidden
          >
            <div className="tg-gif-preview__frame">
              <img
                src={gifPreview.gif.url || gifPreview.gif.previewUrl}
                alt=""
                className="tg-gif-preview__img"
              />
            </div>
            {gifPreview.gif.title ? (
              <div className="tg-gif-preview__caption">
                {gifPreview.gif.title}
              </div>
            ) : null}
          </div>,
          document.body,
        )}
      {gifCtx && (
        <AppContextMenu
          x={gifCtx.x}
          y={gifCtx.y}
          onClose={() => setGifCtx(null)}
          items={[
            {
              id: 'delete',
              label: 'Удалить из сохранённых',
              danger: true,
              icon: <Trash2 className="w-4 h-4" />,
              onSelect: () => {
                removeSaved(gifCtx.savedId)
              },
            },
          ]}
        />
      )}
    </>
  )
}
