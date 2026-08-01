import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { ALL_CONTEXT_EMOJIS } from '@/shared/ui/MessageContextMenu'
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

  useEffect(() => {
    void hydrateStickers(client)
    hydrateSaved()
  }, [hydrateStickers, hydrateSaved, client])

  useEffect(() => {
    if (!open) return
    if (emojiOnly && tab !== 'emoji') setTab('emoji')
  }, [open, emojiOnly, tab])

  useEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const width = Math.min(340, window.innerWidth - 24)
      let left = r.left
      if (left + width > window.innerWidth - 12) {
        left = window.innerWidth - width - 12
      }
      if (left < 12) left = 12
      setPos({
        left,
        bottom: window.innerHeight - r.top + 8,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchorRef])

  useEffect(() => {
    if (!open) {
      setGifCtx(null)
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (gifCtx) {
          setGifCtx(null)
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
          className="tg-sticker-picker fixed z-[950] flex flex-col"
          style={{ left: pos.left, bottom: pos.bottom }}
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
                    <div className="grid grid-cols-2 gap-1.5">
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
                                <div className="tg-picker-section-label col-span-2 px-0.5 pt-1 pb-1.5 text-[10.5px] font-medium uppercase tracking-wide">
                                  Из сети
                                </div>
                              )}
                            <button
                              type="button"
                              className="tg-picker-cell w-full rounded-xl overflow-hidden transition-shadow aspect-video"
                              onClick={() => {
                                onPickGif(g)
                                onClose()
                              }}
                              onContextMenu={(e) => {
                                if (!savedId) return
                                e.preventDefault()
                                e.stopPropagation()
                                setGifCtx({
                                  x: e.clientX,
                                  y: e.clientY,
                                  savedId,
                                })
                              }}
                              title={
                                g.source === 'saved'
                                  ? `${g.title} (сохранённый)`
                                  : `${g.title} (${g.source})`
                              }
                            >
                              <img
                                src={g.previewUrl}
                                alt={g.title}
                                className="w-full h-full object-cover"
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
