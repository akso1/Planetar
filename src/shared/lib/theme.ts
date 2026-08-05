import {
  applyCustomPaletteToDocument,
  clearCustomCssVars,
  readResolvedCustomPalette,
} from '@/shared/lib/customTheme'

export type AppTheme =
  | 'dark'
  | 'light'
  | 'telegram'
  | 'matrix'
  | 'cyberpunk'
  | 'orbit'
  | 'obsidian'
  | 'ember'
  | 'custom'

export const THEME_STORAGE_KEY = 'app-theme'
const LEGACY_THEME_KEY = 'matrix-macos-theme'
/** macOS Vibrancy / acrylic glass — default off on clean install */
export const VIBRANCY_STORAGE_KEY = 'planetar-vibrancy-enabled'

export const THEME_CLASS_LIST = [
  'dark',
  'theme-dark',
  'theme-light',
  'theme-telegram',
  'theme-matrix',
  'theme-cyberpunk',
  'theme-orbit',
  'theme-obsidian',
  'theme-ember',
  'theme-custom',
  'theme-custom-light',
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
    hint: 'Плотный светлый мессенджер',
    bg: '#eef1f5',
    sidebar: '#f7f8fa',
    surface: '#dcebff',
    surfaceIn: '#ffffff',
    text: '#111827',
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
  {
    id: 'orbit',
    label: 'Planetar Orbit',
    hint: 'Космос и бирюза бренда',
    bg: '#070B14',
    sidebar: '#0C1220',
    surface: '#1A3A3A',
    surfaceIn: '#141C2E',
    text: '#E8EEF8',
    muted: '#8B9BB4',
    accent: '#5EEAD4',
  },
  {
    id: 'obsidian',
    label: 'Obsidian Gold',
    hint: 'Чёрный обсидиан и шампань',
    bg: '#0A0A0B',
    sidebar: '#141416',
    surface: '#2A2418',
    surfaceIn: '#1A1A1C',
    text: '#F3F0E8',
    muted: '#A39E90',
    accent: '#C6A75E',
  },
  {
    id: 'ember',
    label: 'Northern Ember',
    hint: 'Полночь и северное сияние',
    bg: '#0A1018',
    sidebar: '#111827',
    surface: '#134E4A',
    surfaceIn: '#152033',
    text: '#E8EEF5',
    muted: '#8B9CB3',
    accent: '#34D3A0',
  },
]

const VALID = new Set<AppTheme>([
  ...THEME_OPTIONS.map((t) => t.id),
  'custom',
])

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

export function readVibrancyEnabled(): boolean {
  try {
    const v = localStorage.getItem(VIBRANCY_STORAGE_KEY)
    if (v === '1' || v === 'true') return true
    if (v === '0' || v === 'false') return false
  } catch {
    /* ignore */
  }
  return false
}

/** Toggle CSS class + native vibrancy IPC. Persists to localStorage. */
export function applyVibrancyEnabled(enabled: boolean) {
  const isDarwin = window.electronAPI?.platform === 'darwin'
  // Persist preference always; only activate native/CSS glass on macOS
  const active = !!enabled && isDarwin
  document.documentElement.classList.toggle('vibrancy-enabled', active)
  try {
    localStorage.setItem(VIBRANCY_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
  // Force a paint so translucent shells update immediately behind modals
  void document.body?.offsetHeight
  void window.electronAPI?.setVibrancy?.(active)
}

/** Apply theme class on <html>. */
export function applyTheme(theme: AppTheme) {
  const root = document.documentElement
  clearCustomCssVars(root)
  root.classList.remove(...THEME_CLASS_LIST)
  root.classList.add(`theme-${theme}`)
  if (theme === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
  root.style.removeProperty('color-scheme')

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    localStorage.setItem(
      LEGACY_THEME_KEY,
      theme === 'telegram' ? 'blue' : theme,
    )
  } catch {
    /* ignore */
  }

  if (theme === 'custom') {
    applyCustomPaletteToDocument(readResolvedCustomPalette())
    // Keep vibrancy class + native effect in sync after custom paint
    applyVibrancyEnabled(readVibrancyEnabled())
    return
  }

  void window.electronAPI?.setWindowAppearance?.(
    theme === 'light' ? 'light' : 'dark',
    theme === 'light' ? '#eef1f5' : undefined,
  )
}

export function initTheme() {
  applyTheme(readStoredTheme())
  applyVibrancyEnabled(readVibrancyEnabled())
}
