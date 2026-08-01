import { create } from 'zustand'
import type { MatrixClient } from 'matrix-js-sdk'

export type StoredSticker = {
  id: string
  name: string
  mime: string
  /** data:image/...;base64,... */
  dataUrl: string
  w?: number
  h?: number
}

export type StickerPack = {
  id: string
  name: string
  stickers: StoredSticker[]
  createdAt: number
}

export const STICKER_ACCOUNT_DATA_TYPE = 'user.custom.stickerpacks'
export const STICKER_FILE_ACCEPT =
  'image/png, image/webp, image/gif, image/jpeg'

const STORAGE_KEY = 'matrix-macos-stickers'
/** Static stickers (PNG / WEBP / JPEG) */
const MAX_STATIC_BYTES = 800_000 // ~800 KB
/** Animated GIF — larger, but still storage-friendly */
const MAX_GIF_BYTES = 10_000_000 // ~10 MB
export const MAX_PACK_STICKERS = 40

type StickersState = {
  packs: StickerPack[]
  hydrated: boolean
  /** Load from Account Data (preferred) or localStorage. */
  hydrate: (client?: MatrixClient | null) => Promise<void>
  /** Create or replace a pack; persists to Account Data + local cache. */
  savePack: (pack: {
    id?: string
    name: string
    stickers: StoredSticker[]
  }) => Promise<StickerPack>
  removePack: (packId: string) => Promise<void>
  removeSticker: (packId: string, stickerId: string) => Promise<void>
}

export function maxBytesForFile(file: File): number {
  const t = file.type.toLowerCase()
  const n = file.name.toLowerCase()
  if (t === 'image/gif' || n.endsWith('.gif')) return MAX_GIF_BYTES
  return MAX_STATIC_BYTES
}

export function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} МБ`
  return `${Math.round(n / 1000)} КБ`
}

export function isStickerFile(file: File): boolean {
  const t = file.type.toLowerCase()
  if (
    t === 'image/png' ||
    t === 'image/webp' ||
    t === 'image/gif' ||
    t === 'image/jpeg' ||
    t === 'image/jpg'
  ) {
    return true
  }
  const n = file.name.toLowerCase()
  return (
    n.endsWith('.png') ||
    n.endsWith('.webp') ||
    n.endsWith('.gif') ||
    n.endsWith('.jpg') ||
    n.endsWith('.jpeg')
  )
}

export function stickersCountLabel(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return `${n} стикер`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return `${n} стикера`
  }
  return `${n} стикеров`
}

function persistLocal(packs: StickerPack[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ packs }))
  } catch (err) {
    console.warn('Failed to persist stickers locally', err)
    throw new Error(
      'Не хватило места в хранилище браузера. Удалите старые паки или загрузите меньше / легче файлов.',
    )
  }
}

function readLocalPacks(): StickerPack[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { packs?: StickerPack[] }
    if (Array.isArray(parsed.packs)) return parsed.packs
  } catch (err) {
    console.warn('Failed to load stickers from localStorage', err)
  }
  return null
}

function readAccountPacks(client: MatrixClient): StickerPack[] | null {
  try {
    const ev = client.getAccountData(STICKER_ACCOUNT_DATA_TYPE as never)
    const content = ev?.getContent?.() as { packs?: StickerPack[] } | undefined
    if (content && Array.isArray(content.packs)) return content.packs
  } catch (err) {
    console.warn('Failed to read sticker account data', err)
  }
  return null
}

async function persistAccountData(
  client: MatrixClient | null | undefined,
  packs: StickerPack[],
) {
  if (!client) return
  try {
    await client.setAccountData(STICKER_ACCOUNT_DATA_TYPE as never, {
      packs,
    })
  } catch (err) {
    console.warn('Failed to persist stickers to account data', err)
    throw new Error(
      'Не удалось сохранить стикеры в Matrix Account Data. Проверьте размер паков (слишком большие файлы) и сеть.',
    )
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
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

function newStickerId() {
  return `stk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function newPackId() {
  return `pack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Convert picked files into sticker records (does not persist).
 * Respects pack size limit relative to `already`.
 */
export async function filesToStickers(
  files: File[],
  already = 0,
): Promise<{ stickers: StoredSticker[]; warning?: string }> {
  const room = Math.max(0, MAX_PACK_STICKERS - already)
  const usable = files.filter(isStickerFile).slice(0, room)
  if (!usable.length) {
    throw new Error('Нет подходящих файлов (PNG / WEBP / GIF / JPG)')
  }

  const stickers: StoredSticker[] = []
  let skippedLarge = 0
  let skippedRead = 0
  let largestSkipped = 0

  for (const file of usable) {
    const limit = maxBytesForFile(file)
    if (file.size > limit) {
      skippedLarge++
      largestSkipped = Math.max(largestSkipped, file.size)
      console.warn(
        'Skip oversized sticker',
        file.name,
        file.size,
        'limit',
        limit,
      )
      continue
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      const dims = await readDims(dataUrl)
      const mime =
        file.type ||
        (file.name.toLowerCase().endsWith('.gif')
          ? 'image/gif'
          : file.name.toLowerCase().match(/\.jpe?g$/)
            ? 'image/jpeg'
            : 'image/png')
      stickers.push({
        id: newStickerId(),
        name: file.name.replace(/\.[^.]+$/, '') || file.name,
        mime,
        dataUrl,
        ...dims,
      })
    } catch (err) {
      skippedRead++
      console.warn('Failed to read sticker', file.name, err)
    }
  }

  if (!stickers.length) {
    const parts: string[] = []
    if (skippedLarge) {
      parts.push(
        `${skippedLarge} файл(ов) больше лимита (GIF до ${formatBytes(MAX_GIF_BYTES)}, PNG/WEBP/JPG до ${formatBytes(MAX_STATIC_BYTES)})`,
      )
      if (largestSkipped) {
        parts.push(`самый большой был ${formatBytes(largestSkipped)}`)
      }
    }
    if (skippedRead) {
      parts.push(`${skippedRead} не удалось прочитать`)
    }
    throw new Error(
      parts.length ? parts.join('. ') : 'Не удалось загрузить стикеры',
    )
  }

  const warningParts: string[] = []
  if (files.filter(isStickerFile).length > room && room >= 0) {
    warningParts.push(`добавлено не больше ${MAX_PACK_STICKERS} на пак`)
  }
  if (skippedLarge) {
    warningParts.push(`пропущено слишком больших: ${skippedLarge}`)
  }
  if (skippedRead) {
    warningParts.push(`не прочитано: ${skippedRead}`)
  }

  return {
    stickers,
    warning: warningParts.length ? warningParts.join('. ') : undefined,
  }
}

let hydrateClient: MatrixClient | null = null

export const useStickersStore = create<StickersState>((set, get) => ({
  packs: [],
  hydrated: false,

  hydrate: async (client) => {
    if (client) hydrateClient = client
    const active = client ?? hydrateClient

    let packs: StickerPack[] | null = null
    if (active) {
      packs = readAccountPacks(active)
    }
    const local = readLocalPacks()

    if (packs && packs.length > 0) {
      persistLocal(packs)
      set({ packs, hydrated: true })
      return
    }

    if (local && local.length > 0) {
      set({ packs: local, hydrated: true })
      // Migrate local → Account Data when online
      if (active) {
        try {
          await persistAccountData(active, local)
        } catch (err) {
          console.warn('Sticker migrate to account data failed', err)
        }
      }
      return
    }

    // Empty account data still wins over nothing
    if (packs) {
      set({ packs, hydrated: true })
      return
    }

    set({ packs: [], hydrated: true })
  },

  savePack: async ({ id, name, stickers }) => {
    if (!stickers.length) {
      throw new Error('Добавьте хотя бы один стикер')
    }
    const trimmed = name.trim() || 'Стикеры'
    const existing = id ? get().packs.find((p) => p.id === id) : undefined
    const pack: StickerPack = {
      id: existing?.id ?? id ?? newPackId(),
      name: trimmed,
      stickers: stickers.slice(0, MAX_PACK_STICKERS),
      createdAt: existing?.createdAt ?? Date.now(),
    }
    const packs = existing
      ? get().packs.map((p) => (p.id === pack.id ? pack : p))
      : [...get().packs, pack]
    persistLocal(packs)
    set({ packs, hydrated: true })
    await persistAccountData(hydrateClient, packs)
    return pack
  },

  removePack: async (packId) => {
    const packs = get().packs.filter((p) => p.id !== packId)
    persistLocal(packs)
    set({ packs })
    await persistAccountData(hydrateClient, packs)
  },

  removeSticker: async (packId, stickerId) => {
    const packs = get().packs.map((p) =>
      p.id !== packId
        ? p
        : { ...p, stickers: p.stickers.filter((s) => s.id !== stickerId) },
    )
    persistLocal(packs)
    set({ packs })
    await persistAccountData(hydrateClient, packs)
  },
}))

export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(meta)?.[1] || 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
