import { create } from 'zustand'
import type { GifResult } from '@/shared/lib/gifSearch'

export type SavedGif = {
  id: string
  title: string
  mime: string
  dataUrl: string
  w?: number
  h?: number
  createdAt: number
}

type SavedGifsState = {
  items: SavedGif[]
  hydrated: boolean
  hydrate: () => void
  addFromBlob: (
    blob: Blob,
    opts?: { title?: string; w?: number; h?: number },
  ) => Promise<SavedGif>
  remove: (id: string) => void
  hasSimilar: (byteLength: number, title?: string) => boolean
}

const STORAGE_KEY = 'matrix-macos-saved-gifs'
const MAX_GIF_BYTES = 10_000_000
const MAX_SAVED = 60

function persist(items: SavedGif[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }))
  } catch (err) {
    console.warn('Failed to persist saved GIFs', err)
    throw new Error(
      'Не хватило места для сохранения GIF. Удалите старые из вкладки GIF.',
    )
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

async function readDims(
  dataUrl: string,
): Promise<{ w?: number; h?: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () =>
      resolve({
        w: img.naturalWidth || undefined,
        h: img.naturalHeight || undefined,
      })
    img.onerror = () => resolve({})
    img.src = dataUrl
  })
}

export const useSavedGifsStore = create<SavedGifsState>((set, get) => ({
  items: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { items?: SavedGif[] }
        if (Array.isArray(parsed.items)) {
          set({ items: parsed.items, hydrated: true })
          return
        }
      }
    } catch (err) {
      console.warn('Failed to load saved GIFs', err)
    }
    set({ items: [], hydrated: true })
  },

  hasSimilar: (byteLength, title) => {
    const items = get().items
    const t = title?.trim().toLowerCase()
    return items.some((g) => {
      // rough dedupe: same title and similar dataUrl length
      const approx = Math.round((g.dataUrl.length * 3) / 4)
      const sizeClose = Math.abs(approx - byteLength) < 2048
      if (t && g.title.toLowerCase() === t && sizeClose) return true
      return false
    })
  },

  addFromBlob: async (blob, opts) => {
    if (blob.size > MAX_GIF_BYTES) {
      throw new Error(
        `GIF слишком большой (${(blob.size / 1_000_000).toFixed(1)} МБ, лимит 10 МБ)`,
      )
    }
    const mime = blob.type || 'image/gif'
    if (!mime.includes('gif') && !mime.includes('webp')) {
      // still allow if user explicitly saved from gif message
    }
    const dataUrl = await blobToDataUrl(blob)
    const dims = opts?.w && opts?.h ? { w: opts.w, h: opts.h } : await readDims(dataUrl)
    const item: SavedGif = {
      id: `sgif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: (opts?.title || 'gif').replace(/\.[^.]+$/, '') || 'gif',
      mime,
      dataUrl,
      ...dims,
      createdAt: Date.now(),
    }
    let items = [item, ...get().items.filter((g) => g.dataUrl !== dataUrl)]
    if (items.length > MAX_SAVED) items = items.slice(0, MAX_SAVED)
    persist(items)
    set({ items, hydrated: true })
    return item
  },

  remove: (id) => {
    const items = get().items.filter((g) => g.id !== id)
    persist(items)
    set({ items })
  },
}))

export function savedGifToResult(g: SavedGif): GifResult {
  return {
    id: `saved_${g.id}`,
    title: g.title,
    previewUrl: g.dataUrl,
    url: g.dataUrl,
    w: g.w,
    h: g.h,
    source: 'saved',
  }
}

export function listSavedGifResults(query = ''): GifResult[] {
  const q = query.trim().toLowerCase()
  const items = useSavedGifsStore.getState().items
  return items
    .filter((g) => !q || g.title.toLowerCase().includes(q))
    .map(savedGifToResult)
}

/** Detect GIF (or animated) message content */
export function isGifMessageContent(content: Record<string, unknown>): boolean {
  const info = content.info as { mimetype?: string } | undefined
  const file = content.file as { mimetype?: string } | undefined
  const mime = (
    info?.mimetype ||
    file?.mimetype ||
    ''
  ).toLowerCase()
  if (mime.includes('gif')) return true
  const body = String(content.body || '').toLowerCase()
  return body.endsWith('.gif') || body.includes('.gif')
}
