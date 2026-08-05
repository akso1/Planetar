/** Custom theme palette + apply helpers (CSS variables on <html>). */

export const CUSTOM_THEME_STORAGE_KEY = 'planetar-theme-custom-palette'

/** Shared threshold for ink auto-pick, color-scheme, and window chrome. */
export const LIGHT_LUMINANCE_THRESHOLD = 0.55

export type CustomThemePalette = {
  bg: string
  sidebar: string
  /** Outgoing bubble / accent surface */
  surface: string
  /** Incoming bubble */
  surfaceIn: string
  text: string
  muted: string
  accent: string
}

export const DEFAULT_CUSTOM_PALETTE: CustomThemePalette = {
  bg: '#0b1220',
  sidebar: '#121a2c',
  surface: '#1a3a48',
  surfaceIn: '#182233',
  text: '#e8eef8',
  muted: '#8b9bb4',
  accent: '#5eead4',
}

const HEX6_RE = /^#([0-9a-fA-F]{6})$/
const HEX3_RE = /^#([0-9a-fA-F]{3})$/

export function isValidHex(value: string): boolean {
  const v = value.trim()
  return HEX6_RE.test(v) || HEX3_RE.test(v)
}

export function normalizeHex(value: string): string | null {
  const v = value.trim()
  if (HEX6_RE.test(v)) return v.toLowerCase()
  if (HEX3_RE.test(v)) {
    const h = v.slice(1).toLowerCase()
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
  }
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v.toLowerCase()}`
  if (/^[0-9a-fA-F]{3}$/.test(v)) {
    const h = v.toLowerCase()
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
  }
  return null
}

function parseRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHex(hex)
  if (!n) return null
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  }
}

/** Relative luminance 0..1 (sRGB). */
export function relativeLuminance(hex: string): number {
  const rgb = parseRgb(hex)
  if (!rgb) return 0
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = lin(rgb.r)
  const g = lin(rgb.g)
  const b = lin(rgb.b)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

export function resolveOnAccent(accent: string): string {
  return relativeLuminance(accent) > LIGHT_LUMINANCE_THRESHOLD
    ? '#0a0a0b'
    : '#ffffff'
}

export type Hsv = { h: number; s: number; v: number }

export function hexToRgb(
  hex: string,
): { r: number; g: number; b: number } | null {
  return parseRgb(hex)
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6
    else if (max === gg) h = (bb - rr) / d + 2
    else h = (rr - gg) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  return { h, s, v: max }
}

export function hsvToRgb(h: number, s: number, v: number): {
  r: number
  g: number
  b: number
} {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let rp = 0
  let gp = 0
  let bp = 0
  if (h < 60) [rp, gp, bp] = [c, x, 0]
  else if (h < 120) [rp, gp, bp] = [x, c, 0]
  else if (h < 180) [rp, gp, bp] = [0, c, x]
  else if (h < 240) [rp, gp, bp] = [0, x, c]
  else if (h < 300) [rp, gp, bp] = [x, 0, c]
  else [rp, gp, bp] = [c, 0, x]
  return {
    r: (rp + m) * 255,
    g: (gp + m) * 255,
    b: (bp + m) * 255,
  }
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = parseRgb(hex)
  if (!rgb) return null
  return rgbToHsv(rgb.r, rgb.g, rgb.b)
}

export function hsvToHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v)
  return rgbToHex(r, g, b)
}

export function isLightSurface(hex: string): boolean {
  return relativeLuminance(hex) > LIGHT_LUMINANCE_THRESHOLD
}

export function isLightPalette(palette: CustomThemePalette): boolean {
  return isLightSurface(palette.bg)
}

/** How text/muted are chosen relative to the chat background. */
export type TextContrastMode = 'auto' | 'light' | 'dark' | 'manual'

/** Light ink — for dark backgrounds. */
export const LIGHT_INK = {
  text: '#eef2f8',
  muted: '#8b97ab',
} as const satisfies Pick<CustomThemePalette, 'text' | 'muted'>

/** Dark ink — for light backgrounds. */
export const DARK_INK = {
  text: '#12151c',
  muted: '#5c6678',
} as const satisfies Pick<CustomThemePalette, 'text' | 'muted'>

export function normalizeTextContrastMode(
  raw: unknown,
): TextContrastMode | null {
  if (raw === 'auto' || raw === 'light' || raw === 'dark' || raw === 'manual') {
    return raw
  }
  return null
}

/** Pick readable text + muted for a background hex. */
export function inkPairForBackground(
  bg: string,
): Pick<CustomThemePalette, 'text' | 'muted'> {
  return isLightSurface(bg) ? { ...DARK_INK } : { ...LIGHT_INK }
}

export function applyTextContrastMode(
  palette: CustomThemePalette,
  mode: TextContrastMode,
): CustomThemePalette {
  if (mode === 'manual') return palette
  if (mode === 'light') return { ...palette, ...LIGHT_INK }
  if (mode === 'dark') return { ...palette, ...DARK_INK }
  return { ...palette, ...inkPairForBackground(palette.bg) }
}

export type PaletteIssue = {
  key:
    | keyof CustomThemePalette
    | 'textOnBg'
    | 'mutedOnBg'
    | 'textOnBubbles'
    | 'onAccent'
  message: string
}

export function validatePalette(palette: CustomThemePalette): PaletteIssue[] {
  const issues: PaletteIssue[] = []
  const keys: (keyof CustomThemePalette)[] = [
    'bg',
    'sidebar',
    'surface',
    'surfaceIn',
    'text',
    'muted',
    'accent',
  ]
  for (const key of keys) {
    if (!normalizeHex(palette[key])) {
      issues.push({ key, message: 'Нужен цвет в формате #RGB или #RRGGBB' })
    }
  }
  if (issues.length) return issues

  if (contrastRatio(palette.text, palette.bg) < 3.5) {
    issues.push({
      key: 'textOnBg',
      message: 'Текст слабо читается на фоне — увеличьте контраст',
    })
  }
  if (contrastRatio(palette.muted, palette.bg) < 2.5) {
    issues.push({
      key: 'mutedOnBg',
      message: 'Приглушённый текст слишком бледный',
    })
  }
  const bubbleMin = Math.min(
    contrastRatio(palette.text, palette.surface),
    contrastRatio(palette.text, palette.surfaceIn),
  )
  if (bubbleMin < 3) {
    issues.push({
      key: 'textOnBubbles',
      message: 'Текст плохо читается на пузырях — проверьте исходящие/входящие',
    })
  }
  const onAccent = resolveOnAccent(palette.accent)
  if (contrastRatio(onAccent, palette.accent) < 3) {
    issues.push({
      key: 'onAccent',
      message: 'Акцент слишком серый — бейджи могут плохо читаться',
    })
  }
  return issues
}

export function sanitizePalette(
  raw: Partial<CustomThemePalette> | null | undefined,
): CustomThemePalette {
  const base = { ...DEFAULT_CUSTOM_PALETTE }
  if (!raw || typeof raw !== 'object') return base
  for (const key of Object.keys(base) as (keyof CustomThemePalette)[]) {
    const n = normalizeHex(String(raw[key] ?? ''))
    if (n) base[key] = n
  }
  return base
}

export function readCustomPalette(): CustomThemePalette {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CUSTOM_PALETTE }
    return sanitizePalette(JSON.parse(raw) as Partial<CustomThemePalette>)
  } catch {
    return { ...DEFAULT_CUSTOM_PALETTE }
  }
}

export function readCustomTextMode(): TextContrastMode {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_STORAGE_KEY)
    if (!raw) return 'auto'
    const parsed = JSON.parse(raw) as { textMode?: unknown }
    const mode = normalizeTextContrastMode(parsed.textMode)
    // Legacy saves had no textMode — keep their colors as manual
    if (!mode) return 'manual'
    return mode
  } catch {
    return 'auto'
  }
}

/** Palette with textMode applied (for cold start / applyTheme). */
export function readResolvedCustomPalette(): CustomThemePalette {
  return applyTextContrastMode(readCustomPalette(), readCustomTextMode())
}

export function writeCustomPalette(
  palette: CustomThemePalette,
  textMode: TextContrastMode = readCustomTextMode(),
): void {
  const clean = sanitizePalette(palette)
  try {
    localStorage.setItem(
      CUSTOM_THEME_STORAGE_KEY,
      JSON.stringify({ ...clean, textMode }),
    )
  } catch {
    /* ignore */
  }
}

/** CSS custom properties we set when applying a custom palette. */
export const CUSTOM_CSS_VARS = [
  '--color-bg',
  '--color-sidebar',
  '--color-surface',
  '--color-surface-in',
  '--color-text',
  '--color-text-muted',
  '--color-accent',
  '--color-on-accent',
  '--accent-fg',
  '--accent-hover',
  '--accent-pressed',
  '--bubble-out-start',
  '--bubble-out-end',
  '--bubble-in',
  '--bubble-tick-hover',
  '--on-bubble-fill',
  '--on-bubble-fill-strong',
  '--on-bubble-track',
  '--on-bubble-progress',
  '--date-chip-bg',
  '--menu-divider',
  '--segment-track',
  '--control-fill',
  '--control-fill-hover',
  '--menu-surface-solid',
  '--menu-surface',
  '--sticky-date-bg',
  '--sticky-date-bg-hover',
  '--bubble-tick-read',
  '--surface-elevated',
  '--surface-glass',
  '--surface-glass-strong',
  '--panel-shadow',
  '--bubble-shadow',
  '--float-shadow',
] as const

export function clearCustomCssVars(root: HTMLElement = document.documentElement) {
  for (const v of CUSTOM_CSS_VARS) {
    root.style.removeProperty(v)
  }
  root.classList.remove('theme-custom-light')
}

/** Paint palette onto an element (html or preview root). */
export function paintCustomPalette(
  el: HTMLElement,
  palette: CustomThemePalette,
) {
  const p = sanitizePalette(palette)
  const light = isLightPalette(p)
  const onAccent = resolveOnAccent(p.accent)

  el.style.setProperty('--color-bg', p.bg)
  el.style.setProperty('--color-sidebar', p.sidebar)
  el.style.setProperty('--color-surface', p.surface)
  el.style.setProperty('--color-surface-in', p.surfaceIn)
  el.style.setProperty('--color-text', p.text)
  el.style.setProperty('--color-text-muted', p.muted)
  el.style.setProperty('--color-accent', p.accent)
  el.style.setProperty('--color-on-accent', onAccent)

  el.style.setProperty('--bubble-in', p.surfaceIn)
  el.style.setProperty('--bubble-out-start', p.surface)
  // Light: keep outgoing flat (stock light theme). Dark: subtle depth.
  el.style.setProperty(
    '--bubble-out-end',
    light
      ? p.surface
      : `color-mix(in srgb, ${p.surface} 78%, black)`,
  )
  el.style.setProperty('--bubble-tick-read', p.accent)

  if (light) {
    el.style.setProperty(
      '--accent-fg',
      `color-mix(in srgb, ${p.accent} 55%, black)`,
    )
    el.style.setProperty(
      '--accent-hover',
      `color-mix(in srgb, ${p.accent} 82%, white)`,
    )
    el.style.setProperty(
      '--accent-pressed',
      `color-mix(in srgb, ${p.accent} 78%, black)`,
    )
    el.style.setProperty(
      '--bubble-tick-hover',
      `color-mix(in srgb, ${p.text} 6%, transparent)`,
    )
    el.style.setProperty(
      '--on-bubble-fill',
      `color-mix(in srgb, ${p.text} 6%, transparent)`,
    )
    el.style.setProperty(
      '--on-bubble-fill-strong',
      `color-mix(in srgb, ${p.text} 10%, transparent)`,
    )
    el.style.setProperty(
      '--on-bubble-track',
      `color-mix(in srgb, ${p.text} 10%, transparent)`,
    )
    el.style.setProperty('--on-bubble-progress', p.accent)
    el.style.setProperty(
      '--date-chip-bg',
      `color-mix(in srgb, ${p.text} 6%, transparent)`,
    )
    el.style.setProperty(
      '--menu-divider',
      `color-mix(in srgb, ${p.text} 8%, transparent)`,
    )
    el.style.setProperty(
      '--segment-track',
      `color-mix(in srgb, ${p.text} 8%, ${p.sidebar})`,
    )
    el.style.setProperty('--control-fill', p.bg)
    el.style.setProperty(
      '--control-fill-hover',
      `color-mix(in srgb, ${p.text} 6%, ${p.bg})`,
    )
    el.style.setProperty('--menu-surface-solid', p.sidebar)
    el.style.setProperty('--menu-surface', p.sidebar)
    el.style.setProperty('--sticky-date-bg', p.sidebar)
    el.style.setProperty('--sticky-date-bg-hover', p.sidebar)
    el.style.setProperty('--surface-elevated', p.surfaceIn)
    el.style.setProperty('--surface-glass', p.sidebar)
    el.style.setProperty('--surface-glass-strong', p.surfaceIn)
    el.style.setProperty(
      '--panel-shadow',
      '0 12px 32px color-mix(in srgb, #0f172a 10%, transparent)',
    )
    el.style.setProperty(
      '--bubble-shadow',
      '0 1px 1px color-mix(in srgb, #0f172a 4%, transparent)',
    )
    el.style.setProperty(
      '--float-shadow',
      '0 2px 8px color-mix(in srgb, #0f172a 10%, transparent)',
    )
  } else {
    el.style.setProperty(
      '--accent-fg',
      `color-mix(in srgb, ${p.accent} 45%, white)`,
    )
    el.style.setProperty(
      '--accent-hover',
      `color-mix(in srgb, ${p.accent} 82%, white)`,
    )
    el.style.setProperty(
      '--accent-pressed',
      `color-mix(in srgb, ${p.accent} 82%, black)`,
    )
    el.style.setProperty(
      '--bubble-tick-hover',
      'color-mix(in srgb, #ffffff 10%, transparent)',
    )
    el.style.setProperty(
      '--on-bubble-fill',
      'color-mix(in srgb, #ffffff 14%, transparent)',
    )
    el.style.setProperty(
      '--on-bubble-fill-strong',
      'color-mix(in srgb, #ffffff 24%, transparent)',
    )
    el.style.setProperty(
      '--on-bubble-track',
      'color-mix(in srgb, #ffffff 14%, transparent)',
    )
    el.style.setProperty(
      '--on-bubble-progress',
      `color-mix(in srgb, ${p.accent} 70%, white)`,
    )
    el.style.setProperty(
      '--date-chip-bg',
      'color-mix(in srgb, #000000 30%, transparent)',
    )
    el.style.setProperty(
      '--menu-divider',
      'color-mix(in srgb, #ffffff 10%, transparent)',
    )
    el.style.setProperty(
      '--segment-track',
      'color-mix(in srgb, #000000 35%, transparent)',
    )
    el.style.setProperty(
      '--control-fill',
      'color-mix(in srgb, #ffffff 5%, transparent)',
    )
    el.style.setProperty(
      '--control-fill-hover',
      `color-mix(in srgb, ${p.accent} 12%, transparent)`,
    )
    el.style.setProperty('--menu-surface-solid', p.sidebar)
    el.style.setProperty(
      '--menu-surface',
      `color-mix(in srgb, ${p.sidebar} 94%, transparent)`,
    )
    el.style.setProperty(
      '--sticky-date-bg',
      `color-mix(in srgb, ${p.sidebar} 92%, transparent)`,
    )
    el.style.setProperty(
      '--sticky-date-bg-hover',
      `color-mix(in srgb, ${p.surfaceIn} 94%, transparent)`,
    )
    el.style.setProperty('--surface-elevated', p.surfaceIn)
    el.style.setProperty(
      '--surface-glass',
      `color-mix(in srgb, ${p.sidebar} 88%, transparent)`,
    )
    el.style.setProperty(
      '--surface-glass-strong',
      `color-mix(in srgb, ${p.sidebar} 94%, transparent)`,
    )
    el.style.setProperty('--panel-shadow', '0 24px 48px rgba(0, 0, 0, 0.55)')
    el.style.setProperty('--bubble-shadow', '0 1px 2px rgba(0, 0, 0, 0.28)')
    el.style.setProperty('--float-shadow', '0 4px 14px rgba(0, 0, 0, 0.35)')
  }
}

export function applyCustomPaletteToDocument(palette: CustomThemePalette) {
  const root = document.documentElement
  const p = sanitizePalette(palette)
  const light = isLightPalette(p)
  paintCustomPalette(root, p)
  root.classList.toggle('theme-custom-light', light)
  root.style.colorScheme = light ? 'light' : 'dark'
  void window.electronAPI?.setWindowAppearance?.(
    light ? 'light' : 'dark',
    light ? p.bg : undefined,
  )
}
