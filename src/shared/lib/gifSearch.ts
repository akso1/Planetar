import { listSavedGifResults } from '@/shared/lib/savedGifsStore'

export type GifResult = {
  id: string
  title: string
  previewUrl: string
  url: string
  w?: number
  h?: number
  source: 'local' | 'saved' | 'tenor' | 'giphy' | 'ddg'
}

type ElectronGifApi = {
  searchGifs?: (
    query: string,
  ) => Promise<{ results: GifResult[]; error: string | null }>
}

function getElectronGifApi(): ElectronGifApi | null {
  try {
    const api = (window as unknown as { electronAPI?: ElectronGifApi })
      .electronAPI
    if (api?.searchGifs) return api
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Empty query → only GIFs saved from chat (not sticker packs).
 * Non-empty query → online search (+ filter saved by name).
 */
export async function searchGifs(query: string): Promise<{
  results: GifResult[]
  error: string | null
}> {
  const q = query.trim()
  const saved = listSavedGifResults(q)

  // No search text: show saved library only, do not hit the network
  if (!q) {
    return { results: saved, error: null }
  }

  let online: GifResult[] = []
  let error: string | null = null

  const electron = getElectronGifApi()
  if (electron?.searchGifs) {
    try {
      const remote = await electron.searchGifs(q)
      online = (remote.results || []).map((g) => ({
        ...g,
        source: g.source || 'ddg',
      }))
      if (!online.length) error = remote.error
    } catch (err) {
      console.warn('Electron GIF search failed', err)
      error = 'Не удалось загрузить GIF. Проверьте сеть.'
    }
  } else {
    error =
      'Онлайн-поиск GIF доступен в приложении Electron. Перезапустите через npm run dev.'
  }

  const seen = new Set<string>()
  const results: GifResult[] = []
  for (const g of [...saved, ...online]) {
    if (seen.has(g.url)) continue
    seen.add(g.url)
    results.push(g)
  }

  if (results.length) error = null
  return { results, error }
}
