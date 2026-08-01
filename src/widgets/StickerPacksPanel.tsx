import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  ChevronLeft,
  FolderOpen,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import type { MatrixClient } from 'matrix-js-sdk'
import {
  filesToStickers,
  stickersCountLabel,
  STICKER_FILE_ACCEPT,
  useStickersStore,
  type StoredSticker,
} from '@/shared/lib/stickersStore'

type StickerView = 'list' | 'create' | 'edit'

type Draft = {
  id?: string
  name: string
  stickers: StoredSticker[]
}

type StickerPacksPanelProps = {
  client: MatrixClient | null
}

export function StickerPacksPanel({ client }: StickerPacksPanelProps) {
  const packs = useStickersStore((s) => s.packs)
  const savePack = useStickersStore((s) => s.savePack)
  const removePack = useStickersStore((s) => s.removePack)

  const [view, setView] = useState<StickerView>('list')
  const [draft, setDraft] = useState<Draft>({ name: '', stickers: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void useStickersStore.getState().hydrate(client)
  }, [client])

  const openCreate = () => {
    setDraft({ name: '', stickers: [] })
    setError(null)
    setHint(null)
    setView('create')
  }

  const openEdit = (packId: string) => {
    const pack = packs.find((p) => p.id === packId)
    if (!pack) return
    setDraft({
      id: pack.id,
      name: pack.name,
      stickers: [...pack.stickers],
    })
    setError(null)
    setHint(null)
    setView('edit')
  }

  const goList = () => {
    setView('list')
    setError(null)
    setHint(null)
    setDraft({ name: '', stickers: [] })
  }

  const onFilesPicked = async (list: FileList | null) => {
    if (!list?.length) return
    setBusy(true)
    setError(null)
    setHint(null)
    try {
      const files = Array.from(list)
      const firstPath = (files[0] as File & { webkitRelativePath?: string })
        .webkitRelativePath
      const folderHint = firstPath ? firstPath.split('/')[0] : ''

      const { stickers, warning } = await filesToStickers(
        files,
        draft.stickers.length,
      )
      setDraft((prev) => ({
        ...prev,
        name:
          prev.name.trim() ||
          (view === 'create' ? folderHint : prev.name) ||
          prev.name,
        stickers: [...prev.stickers, ...stickers],
      }))
      if (warning) setHint(warning)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось загрузить стикеры',
      )
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const removeDraftSticker = (stickerId: string) => {
    setDraft((prev) => ({
      ...prev,
      stickers: prev.stickers.filter((s) => s.id !== stickerId),
    }))
  }

  const onSave = async () => {
    setBusy(true)
    setError(null)
    try {
      await savePack({
        id: draft.id,
        name: draft.name,
        stickers: draft.stickers,
      })
      goList()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось сохранить пак',
      )
    } finally {
      setBusy(false)
    }
  }

  const onDeletePack = async (packId: string, e: MouseEvent) => {
    e.stopPropagation()
    setError(null)
    try {
      await removePack(packId)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Не удалось удалить пак',
      )
    }
  }

  if (view === 'list') {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={openCreate}
          className="w-full flex items-center justify-center gap-2 rounded-xl bg-accent/45 hover:bg-accent/65 border border-accent/50 text-ink text-[13px] font-semibold py-3 transition-colors"
        >
          <Plus className="w-4 h-4" strokeWidth={2.5} />
          Создать стикерпак
        </button>

        {error && (
          <div className="text-[12px] text-red-300/90">{error}</div>
        )}

        <div className="space-y-2 max-h-[48vh] overflow-y-auto pr-0.5">
          {packs.length === 0 && (
            <div className="text-[12.5px] text-ink-faint py-2 leading-relaxed">
              Паки пока не добавлены. PNG, WEBP, JPG — до 800 КБ, GIF — до
              10 МБ. Сохраняются в Matrix Account Data.
            </div>
          )}
          {packs.map((pack) => {
            const cover = pack.stickers[0]
            return (
              <div
                key={pack.id}
                role="button"
                tabIndex={0}
                onClick={() => openEdit(pack.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openEdit(pack.id)
                  }
                }}
                className="w-full flex items-center gap-3 rounded-xl bg-surface-inset border border-hairline px-2.5 py-2.5 text-left hover:bg-black/[0.04] transition-colors group cursor-pointer"
              >
                <div className="w-12 h-12 rounded-lg bg-surface-inset ring-1 ring-black/15 overflow-hidden flex items-center justify-center shrink-0">
                  {cover ? (
                    <img
                      src={cover.dataUrl}
                      alt=""
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <span className="text-ink-faint text-[11px]">—</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] text-ink font-medium truncate">
                    {pack.name}
                  </div>
                  <div className="text-[11.5px] text-ink-muted">
                    {stickersCountLabel(pack.stickers.length)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => void onDeletePack(pack.id, e)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-muted hover:text-red-300 hover:bg-red-500/10 opacity-70 group-hover:opacity-100"
                  title="Удалить пак"
                  aria-label="Удалить пак"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 -mt-0.5">
        <button
          type="button"
          onClick={goList}
          className="flex items-center gap-0.5 text-[13px] text-ink-muted hover:text-ink transition-colors py-1 pr-2 -ml-1 rounded-md"
        >
          <ChevronLeft className="w-4 h-4" />
          Назад
        </button>
        <div className="text-[13px] font-medium text-ink">
          {view === 'create' ? 'Новый пак' : 'Редактирование'}
        </div>
      </div>

      <input
        value={draft.name}
        onChange={(e) =>
          setDraft((prev) => ({ ...prev, name: e.target.value }))
        }
        placeholder="Название пака"
        className="w-full h-9 rounded-lg bg-surface-inset border border-hairline px-3 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent/80"
      />

      <input
        ref={fileRef}
        type="file"
        multiple
        accept={STICKER_FILE_ACCEPT}
        className="hidden"
        onChange={(e) => void onFilesPicked(e.target.files)}
      />

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const el = fileRef.current
            if (!el) return
            el.removeAttribute('webkitdirectory')
            el.removeAttribute('directory')
            el.click()
          }}
          className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-surface-inset hover:bg-black/5 border border-hairline text-ink text-[12.5px] font-medium py-2.5 transition-colors disabled:opacity-50"
        >
          Выбрать файлы
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const el = fileRef.current
            if (!el) return
            el.setAttribute('webkitdirectory', '')
            el.setAttribute('directory', '')
            el.click()
          }}
          className="flex-[1.35] flex items-center justify-center gap-2 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-[12.5px] font-medium py-2.5 transition-colors disabled:opacity-50"
        >
          <FolderOpen className="w-4 h-4" />
          {busy ? 'Загрузка…' : 'Загрузить из папки'}
        </button>
      </div>

      {error && <div className="text-[12px] text-red-300/90">{error}</div>}
      {hint && !error && (
        <div className="text-[12px] text-ink-muted">{hint}</div>
      )}

      <div className="max-h-[36vh] overflow-y-auto rounded-xl border border-hairline bg-surface-inset/60 p-2">
        {draft.stickers.length === 0 ? (
          <div className="text-[12.5px] text-ink-faint text-center py-8 px-3">
            Выберите файлы или папку — здесь появится сетка предпросмотра
          </div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
            {draft.stickers.map((s) => (
              <div
                key={s.id}
                className="relative aspect-square rounded-lg bg-surface-inset ring-1 ring-black/10 overflow-hidden group"
              >
                <img
                  src={s.dataUrl}
                  alt={s.name}
                  title={s.name}
                  className="w-full h-full object-contain p-1"
                />
                <button
                  type="button"
                  onClick={() => removeDraftSticker(s.id)}
                  className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-black/65 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity hover:bg-red-600/90"
                  title="Удалить стикер"
                  aria-label="Удалить стикер"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="text-[11px] text-ink-faint">
        {stickersCountLabel(draft.stickers.length)}
        {draft.stickers.length > 0 ? ' в паке' : ''}
      </div>

      <button
        type="button"
        disabled={busy || draft.stickers.length === 0}
        onClick={() => void onSave()}
        className="w-full rounded-xl bg-accent hover:bg-accent/90 disabled:opacity-45 disabled:pointer-events-none text-ink text-[13px] font-semibold py-2.5 transition-colors"
      >
        {busy ? 'Сохранение…' : 'Сохранить пак'}
      </button>
    </div>
  )
}
