export type AppTheme =
  | 'dark'
  | 'light'
  | 'telegram'
  | 'matrix'
  | 'cyberpunk'

export const THEME_STORAGE_KEY = 'app-theme'
const LEGACY_THEME_KEY = 'matrix-macos-theme'

export const THEME_CLASS_LIST = [
  'dark',
  'theme-dark',
  'theme-light',
  'theme-telegram',
  'theme-matrix',
  'theme-cyberpunk',
  'theme-blue',
] as const

export type ThemePreview = {
  id: AppTheme
  label: string
  hint: string
  bg: string
  sidebar: string
  surface: string
  surfaceIn: string
  text: string
  muted: string
  accent: string
}

export const THEME_OPTIONS: ThemePreview[] = [
  {
    id: 'dark',
    label: 'Тёмная',
    hint: 'Глубокий zinc — по умолчанию',
    bg: '#09090b',
    sidebar: '#121214',
    surface: '#27272a',
    surfaceIn: '#1f1f23',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    accent: '#3b82f6',
  },
  {
    id: 'light',
    label: 'Светлая',
    hint: 'Чистый светлый интерфейс',
    bg: '#ffffff',
    sidebar: '#f8f8fa',
    surface: '#e6f0ff',
    surfaceIn: '#f1f1f4',
    text: '#111111',
    muted: '#6b7280',
    accent: '#2563eb',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    hint: 'Классический тёмно-синий чат',
    bg: '#101921',
    sidebar: '#0e161f',
    surface: '#264a6e',
    surfaceIn: '#17212b',
    text: '#f1f5f9',
    muted: '#748da3',
    accent: '#4f8abf',
  },
  {
    id: 'matrix',
    label: 'Matrix',
    hint: 'Неоновый зелёный терминал',
    bg: '#030a05',
    sidebar: '#051007',
    surface: '#0e331c',
    surfaceIn: '#111a14',
    text: '#b8ffd0',
    muted: '#5dff9a',
    accent: '#0aff73',
  },
  {
    id: 'cyberpunk',
    label: 'Cyberpunk',
    hint: 'Фиолет и циан',
    bg: '#150621',
    sidebar: '#10041a',
    surface: '#3b0042',
    surfaceIn: '#221a36',
    text: '#00ffff',
    muted: '#9f60d3',
    accent: '#00ffff',
  },
]

const VALID = new Set<AppTheme>(THEME_OPTIONS.map((t) => t.id))

function normalizeTheme(raw: string | null): AppTheme | null {
  if (!raw) return null
  if (raw === 'blue') return 'telegram'
  if (VALID.has(raw as AppTheme)) return raw as AppTheme
  return null
}

export function readStoredTheme(): AppTheme {
  try {
    const primary = normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY))
    if (primary) return primary
    const legacy = normalizeTheme(localStorage.getItem(LEGACY_THEME_KEY))
    if (legacy) return legacy
  } catch {
    /* ignore */
  }
  return 'dark'
}

/** Apply theme class on <html>. Dark = default (:root + .theme-dark). */
export function applyTheme(theme: AppTheme) {
  const root = document.documentElement
  root.classList.remove(...THEME_CLASS_LIST)
  root.classList.add(`theme-${theme}`)
  if (theme === 'dark') root.classList.add('dark')
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    localStorage.setItem(LEGACY_THEME_KEY, theme === 'telegram' ? 'blue' : theme)
  } catch {
    /* ignore */
  }
}

export function initTheme() {
  applyTheme(readStoredTheme())
}
