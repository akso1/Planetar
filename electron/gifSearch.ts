export type GifSearchHit = {
  id: string
  title: string
  previewUrl: string
  url: string
  w?: number
  h?: number
  source: 'tenor' | 'giphy' | 'ddg'
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

function envKey(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

async function searchTenor(query: string): Promise<GifSearchHit[]> {
  const key = envKey('VITE_TENOR_API_KEY') || envKey('TENOR_API_KEY')
  if (!key) return []
  const q = query.trim() || 'funny'
  const url =
    `https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}` +
    `&key=${encodeURIComponent(key)}&client_key=matrix_macos&limit=24&media_filter=minimal`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Tenor HTTP ${res.status}`)
  const data = (await res.json()) as {
    results?: Array<{
      id: string
      title?: string
      media?: Array<{
        tinygif?: { url: string; dims?: number[] }
        gif?: { url: string; dims?: number[] }
        nanogif?: { url: string; dims?: number[] }
      }>
    }>
  }
  return (data.results || [])
    .map((r) => {
      const m = r.media?.[0]
      const preview = m?.nanogif || m?.tinygif || m?.gif
      const full = m?.gif || m?.tinygif || m?.nanogif
      return {
        id: `tenor_${r.id}`,
        title: r.title || 'GIF',
        previewUrl: preview?.url || '',
        url: full?.url || preview?.url || '',
        w: full?.dims?.[0],
        h: full?.dims?.[1],
        source: 'tenor' as const,
      }
    })
    .filter((g) => g.previewUrl && g.url)
}

async function searchGiphy(query: string): Promise<GifSearchHit[]> {
  const key = envKey('VITE_GIPHY_API_KEY') || envKey('GIPHY_API_KEY')
  if (!key) return []
  const q = query.trim() || 'funny'
  const url =
    `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(key)}` +
    `&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`Giphy HTTP ${res.status}`)
  const data = (await res.json()) as {
    data?: Array<{
      id: string
      title?: string
      images?: {
        fixed_width_small?: { url?: string; width?: string; height?: string }
        downsized?: { url?: string; width?: string; height?: string }
        original?: { url?: string; width?: string; height?: string }
        preview_gif?: { url?: string }
      }
    }>
  }
  return (data.data || [])
    .map((r) => {
      const preview =
        r.images?.fixed_width_small?.url ||
        r.images?.preview_gif?.url ||
        r.images?.downsized?.url ||
        ''
      const full = r.images?.downsized?.url || r.images?.original?.url || preview
      const w = Number(r.images?.downsized?.width || r.images?.original?.width)
      const h = Number(r.images?.downsized?.height || r.images?.original?.height)
      return {
        id: `giphy_${r.id}`,
        title: r.title || 'GIF',
        previewUrl: preview,
        url: full,
        w: Number.isFinite(w) ? w : undefined,
        h: Number.isFinite(h) ? h : undefined,
        source: 'giphy' as const,
      }
    })
    .filter((g) => g.previewUrl && g.url)
}

function looksLikeGif(url: string): boolean {
  const u = url.toLowerCase()
  return (
    u.includes('.gif') ||
    u.includes('media.tenor.com') ||
    u.includes('giphy.com') ||
    u.includes('media.giphy.com') ||
    u.includes('/gif')
  )
}

async function getDdgVqd(query: string): Promise<string> {
  const res = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
      },
    },
  )
  if (!res.ok) throw new Error(`DDG HTML HTTP ${res.status}`)
  const html = await res.text()
  const m =
    html.match(/vqd=["']([\d-]+)["']/) ||
    html.match(/vqd=([\d-]+)/)
  if (!m?.[1]) throw new Error('DDG vqd not found')
  return m[1]
}

/** Keyless GIF search via DuckDuckGo image search (type:gif). */
async function searchDuckDuckGo(query: string): Promise<GifSearchHit[]> {
  const base = query.trim() || 'funny'
  const q = /\bgif\b/i.test(base) ? base : `${base} gif`
  const vqd = await getDdgVqd(q)
  const url = new URL('https://duckduckgo.com/i.js')
  url.searchParams.set('l', 'us-en')
  url.searchParams.set('o', 'json')
  url.searchParams.set('q', q)
  url.searchParams.set('vqd', vqd)
  url.searchParams.set('f', ',,,,type:gif,,')
  url.searchParams.set('p', '1')

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': UA,
      Referer: 'https://duckduckgo.com/',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`DDG i.js HTTP ${res.status}`)
  const data = (await res.json()) as {
    results?: Array<{
      title?: string
      image?: string
      thumbnail?: string
      width?: number
      height?: number
      url?: string
    }>
  }

  const hits: GifSearchHit[] = []
  for (const r of data.results || []) {
    const image = r.image || ''
    const thumb = r.thumbnail || image
    if (!image) continue
    // Prefer animated GIFs; still allow CDN URLs that look like gifs
    if (!looksLikeGif(image) && !looksLikeGif(thumb)) continue
    hits.push({
      id: `ddg_${hits.length}_${Buffer.from(image).toString('base64url').slice(0, 16)}`,
      title: r.title || 'GIF',
      previewUrl: thumb || image,
      url: image,
      w: typeof r.width === 'number' ? r.width : undefined,
      h: typeof r.height === 'number' ? r.height : undefined,
      source: 'ddg',
    })
    if (hits.length >= 24) break
  }

  // If filter was too strict, take first image results that end with gif-ish paths
  if (!hits.length) {
    for (const r of (data.results || []).slice(0, 24)) {
      const image = r.image || ''
      if (!image) continue
      hits.push({
        id: `ddg_${hits.length}_${Buffer.from(image).toString('base64url').slice(0, 16)}`,
        title: r.title || 'GIF',
        previewUrl: r.thumbnail || image,
        url: image,
        w: typeof r.width === 'number' ? r.width : undefined,
        h: typeof r.height === 'number' ? r.height : undefined,
        source: 'ddg',
      })
    }
  }

  return hits
}

export async function searchGifsMain(query: string): Promise<{
  results: GifSearchHit[]
  error: string | null
}> {
  const errors: string[] = []

  for (const [name, fn] of [
    ['tenor', searchTenor],
    ['giphy', searchGiphy],
  ] as const) {
    try {
      const results = await fn(query)
      if (results.length) return { results, error: null }
    } catch (err) {
      console.warn(`[gif] ${name} failed`, err)
      errors.push(name)
    }
  }

  try {
    const results = await searchDuckDuckGo(query)
    if (results.length) return { results, error: null }
    return {
      results: [],
      error: 'По запросу ничего не найдено',
    }
  } catch (err) {
    console.warn('[gif] ddg failed', err)
    return {
      results: [],
      error:
        'Не удалось загрузить GIF. Проверьте сеть.' +
        (errors.length ? ` (также: ${errors.join(', ')})` : ''),
    }
  }
}
