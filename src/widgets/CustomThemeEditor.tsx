import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, ChevronDown, RotateCcw, Sparkles } from 'lucide-react'
import { clsx } from 'clsx'
import {
  DEFAULT_CUSTOM_PALETTE,
  applyCustomPaletteToDocument,
  applyTextContrastMode,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  paintCustomPalette,
  readCustomPalette,
  readCustomTextMode,
  resolveOnAccent,
  sanitizePalette,
  validatePalette,
  writeCustomPalette,
  type CustomThemePalette,
  type Hsv,
  type TextContrastMode,
} from '@/shared/lib/customTheme'
import { applyTheme } from '@/shared/lib/theme'

const TEXT_MODE_OPTIONS: {
  id: TextContrastMode
  label: string
  title: string
}[] = [
  { id: 'auto', label: 'Авто', title: 'Текст подбирается по яркости фона' },
  { id: 'light', label: 'Светлый', title: 'Светлый текст — для тёмного фона' },
  { id: 'dark', label: 'Тёмный', title: 'Тёмный текст — для светлого фона' },
  { id: 'manual', label: 'Свой', title: 'Задать текст вручную' },
]

const PICKER_W = 260
const PICKER_H_FALLBACK = 320
const PICKER_PAD = 8

/** Place popover in viewport while preferring not to cover `avoid`. */
function placeColorPicker(
  anchor: DOMRect,
  width: number,
  height: number,
  avoid: DOMRect | null,
): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const clamp = (left: number, top: number) => ({
    left: Math.max(PICKER_PAD, Math.min(left, vw - width - PICKER_PAD)),
    top: Math.max(PICKER_PAD, Math.min(top, vh - height - PICKER_PAD)),
  })

  const overlaps = (left: number, top: number, r: DOMRect) => {
    const right = left + width
    const bottom = top + height
    return !(
      right <= r.left ||
      left >= r.right ||
      bottom <= r.top ||
      top >= r.bottom
    )
  }

  const fitsUnclamped = (left: number, top: number) =>
    left >= PICKER_PAD &&
    top >= PICKER_PAD &&
    left + width <= vw - PICKER_PAD &&
    top + height <= vh - PICKER_PAD

  const candidates: { left: number; top: number }[] = [
    // Prefer side placements so the live preview above stays visible
    { left: anchor.right + PICKER_PAD, top: anchor.top },
    { left: anchor.right + PICKER_PAD, top: anchor.bottom - height },
    { left: anchor.left - width - PICKER_PAD, top: anchor.top },
    { left: anchor.left, top: anchor.bottom + PICKER_PAD },
    { left: anchor.right - width, top: anchor.bottom + PICKER_PAD },
    { left: anchor.left, top: anchor.top - height - PICKER_PAD },
    { left: anchor.right - width, top: anchor.top - height - PICKER_PAD },
  ]

  let best = clamp(anchor.left, anchor.bottom + PICKER_PAD)
  let bestScore = -Infinity
  for (const c of candidates) {
    const p = clamp(c.left, c.top)
    let score = 0
    if (fitsUnclamped(c.left, c.top)) score += 40
    if (avoid && overlaps(p.left, p.top, avoid)) score -= 100
    // Prefer staying near the swatch vertically when placed to the side
    score -= Math.abs(p.top - anchor.top) * 0.02
    score -= Math.abs(p.left - (anchor.right + PICKER_PAD)) * 0.01
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  return best
}

const FIELDS: {
  key: keyof CustomThemePalette
  label: string
  hint: string
}[] = [
  { key: 'bg', label: 'Фон чата', hint: 'Основной холст' },
  { key: 'sidebar', label: 'Сайдбар', hint: 'Список чатов' },
  { key: 'surfaceIn', label: 'Входящие', hint: 'Чужие пузыри' },
  { key: 'surface', label: 'Исходящие', hint: 'Ваши пузыри' },
  { key: 'text', label: 'Текст', hint: 'Основной' },
  { key: 'muted', label: 'Приглушённый', hint: 'Время, подписи' },
  { key: 'accent', label: 'Акцент', hint: 'Кнопки и бейджи' },
]

const PRESET_SWATCHES = [
  '#5eead4',
  '#34d3a0',
  '#c6a75e',
  '#3b82f6',
  '#a78bfa',
  '#f472b6',
  '#f97316',
  '#ef4444',
  '#e8eef8',
  '#8b9bb4',
  '#0b1220',
  '#121a2c',
]

type Props = {
  active: boolean
  onActivate: () => void
  onApplied: () => void
}

function MiniPreview({ palette }: { palette: CustomThemePalette }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const onAccent = resolveOnAccent(palette.accent)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    paintCustomPalette(el, palette)
  }, [palette])

  return (
    <div
      ref={rootRef}
      className="theme-custom rounded-2xl overflow-hidden border border-hairline shadow-panel"
      style={{ background: palette.bg }}
    >
      <div className="flex h-[132px]">
        <div
          className="w-[34%] shrink-0 flex flex-col border-r p-2 gap-1.5"
          style={{
            background: palette.sidebar,
            borderColor:
              'color-mix(in srgb, ' + palette.text + ' 10%, transparent)',
          }}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <div
              className="w-5 h-5 rounded-full"
              style={{
                background: `linear-gradient(135deg, ${palette.accent}, ${palette.surface})`,
              }}
            />
            <div
              className="h-1.5 flex-1 rounded-full opacity-80"
              style={{ background: palette.muted }}
            />
          </div>
          <div
            className="rounded-lg px-1.5 py-1.5"
            style={{
              background: `color-mix(in srgb, ${palette.accent} 22%, transparent)`,
            }}
          >
            <div
              className="h-1.5 w-[78%] rounded-full mb-1"
              style={{ background: palette.text }}
            />
            <div
              className="h-1 w-[52%] rounded-full"
              style={{ background: palette.muted }}
            />
          </div>
          <div className="rounded-lg px-1.5 py-1.5 opacity-70">
            <div
              className="h-1.5 w-[70%] rounded-full mb-1"
              style={{ background: palette.text }}
            />
            <div
              className="h-1 w-[40%] rounded-full"
              style={{ background: palette.muted }}
            />
          </div>
        </div>
        <div className="flex-1 flex flex-col p-2.5 gap-2 min-w-0">
          <div className="flex justify-start">
            <div
              className="max-w-[78%] rounded-2xl rounded-bl-md px-2.5 py-1.5"
              style={{ background: palette.surfaceIn }}
            >
              <div
                className="text-[10px] leading-snug"
                style={{ color: palette.text }}
              >
                Привет — так выглядит чат
              </div>
              <div
                className="text-[8px] text-right mt-0.5"
                style={{ color: palette.muted }}
              >
                12:40
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <div
              className="max-w-[78%] rounded-2xl rounded-br-md px-2.5 py-1.5"
              style={{ background: palette.surface }}
            >
              <div
                className="text-[10px] leading-snug"
                style={{ color: palette.text }}
              >
                Своя тема готова
              </div>
              <div className="flex items-center justify-end gap-1 mt-0.5">
                <span className="text-[8px]" style={{ color: palette.muted }}>
                  12:41
                </span>
                <span
                  className="inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full text-[8px] font-bold px-0.5"
                  style={{ background: palette.accent, color: onAccent }}
                >
                  1
                </span>
              </div>
            </div>
          </div>
          <div className="mt-auto flex items-center gap-1.5">
            <div
              className="flex-1 h-6 rounded-full border px-2 flex items-center"
              style={{
                background: palette.sidebar,
                borderColor:
                  'color-mix(in srgb, ' + palette.text + ' 12%, transparent)',
              }}
            >
              <span className="text-[9px]" style={{ color: palette.muted }}>
                Сообщение…
              </span>
            </div>
            <div
              className="w-6 h-6 rounded-full shrink-0"
              style={{ background: palette.accent }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorPickerPopover({
  value,
  anchor,
  avoid,
  onChange,
  onClose,
}: {
  value: string
  anchor: DOMRect
  avoid: DOMRect | null
  onChange: (hex: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const initial = hexToHsv(value) ?? { h: 180, s: 0.4, v: 0.5 }
  const [hsv, setHsv] = useState<Hsv>(initial)
  const [hexText, setHexText] = useState(
    (normalizeHex(value) ?? '#000000').toUpperCase(),
  )
  const [pos, setPos] = useState(() =>
    placeColorPicker(anchor, PICKER_W, PICKER_H_FALLBACK, avoid),
  )

  const hex = useMemo(
    () => hsvToHex(hsv.h, hsv.s, hsv.v),
    [hsv.h, hsv.s, hsv.v],
  )
  const hueColor = hsvToHex(hsv.h, 1, 1)
  const emitRef = useRef(false)

  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const next = placeColorPicker(
        anchor,
        r.width || PICKER_W,
        r.height || PICKER_H_FALLBACK,
        avoid,
      )
      setPos((prev) =>
        prev.left === next.left && prev.top === next.top ? prev : next,
      )
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [anchor, avoid])

  useEffect(() => {
    setHexText(hex.toUpperCase())
    // Skip the initial mount sync so opening the picker doesn't force textMode → manual
    if (!emitRef.current) {
      emitRef.current = true
      return
    }
    onChange(hex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hex])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const { left, top } = pos

  const pickSv = (clientX: number, clientY: number) => {
    const el = svRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const s = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const v = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height))
    setHsv((prev) => ({ ...prev, s, v }))
  }

  const pickHue = (clientX: number) => {
    const el = hueRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const h = Math.max(0, Math.min(359, ((clientX - r.left) / r.width) * 360))
    setHsv((prev) => ({ ...prev, h }))
  }

  const bindDrag = (
    move: (e: PointerEvent) => void,
    el: HTMLElement | null,
  ) => {
    if (!el) return
    const onMove = (e: PointerEvent) => move(e)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[1200] w-[260px] rounded-2xl border border-hairline bg-[var(--menu-surface-solid)] shadow-panel p-3"
      style={{ left, top }}
      role="dialog"
      aria-label="Выбор цвета"
    >
      <div
        ref={svRef}
        className="relative w-full h-[160px] rounded-xl overflow-hidden cursor-crosshair touch-none isolate"
        style={{
          // Single composited stack avoids hue “fringe” at rounded edges
          backgroundImage: `
            linear-gradient(to top, #000000, transparent),
            linear-gradient(to right, #ffffff, transparent),
            linear-gradient(${hueColor}, ${hueColor})
          `,
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 12%, transparent)',
        }}
        onPointerDown={(e) => {
          e.preventDefault()
          pickSv(e.clientX, e.clientY)
          bindDrag((ev) => pickSv(ev.clientX, ev.clientY), svRef.current)
        }}
      >
        <div
          className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] pointer-events-none"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hex,
          }}
        />
      </div>

      <div
        ref={hueRef}
        className="relative mt-3 h-3 rounded-full cursor-pointer border border-hairline touch-none"
        style={{
          background:
            'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
        }}
        onPointerDown={(e) => {
          e.preventDefault()
          pickHue(e.clientX)
          bindDrag((ev) => pickHue(ev.clientX), hueRef.current)
        }}
      >
        <div
          className="absolute top-1/2 -mt-2 w-4 h-4 -ml-2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] pointer-events-none"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            background: hueColor,
          }}
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <div
          className="w-9 h-9 rounded-xl border border-hairline shrink-0"
          style={{ background: hex }}
        />
        <input
          type="text"
          value={hexText}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const raw = e.target.value
            setHexText(raw)
            const n = normalizeHex(raw)
            if (!n) return
            const next = hexToHsv(n)
            if (next) setHsv(next)
          }}
          onBlur={() => setHexText(hex.toUpperCase())}
          className="flex-1 min-w-0 rounded-xl border border-hairline bg-surface-inset px-2.5 py-2 text-[12.5px] font-mono uppercase text-ink focus:outline-none focus:border-accent/50"
        />
      </div>

      <div className="mt-3 grid grid-cols-6 gap-1.5">
        {PRESET_SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            className={clsx(
              'h-7 rounded-lg border transition-transform hover:scale-105',
              normalizeHex(hex) === c
                ? 'border-accent ring-2 ring-accent/35'
                : 'border-hairline',
            )}
            style={{ background: c }}
            onClick={() => {
              const next = hexToHsv(c)
              if (next) setHsv(next)
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  )
}

function ColorField({
  label,
  hint,
  value,
  onChange,
  invalid,
  locked,
  getAvoidRect,
}: {
  label: string
  hint: string
  value: string
  onChange: (hex: string) => void
  invalid?: boolean
  locked?: boolean
  getAvoidRect?: () => DOMRect | null
}) {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [avoid, setAvoid] = useState<DOMRect | null>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)
  useEffect(() => setText(value), [value])

  const hex = normalizeHex(value) ?? '#000000'

  return (
    <div
      className={clsx(
        'flex items-center gap-2.5 rounded-xl border px-2.5 py-2 min-w-0 transition-colors',
        invalid
          ? 'border-red-400/50 bg-red-500/10'
          : locked
            ? 'border-hairline bg-surface-inset/35 opacity-80'
            : 'border-hairline bg-surface-inset/60 hover:border-hairline-strong',
      )}
    >
      <button
        ref={swatchRef}
        type="button"
        aria-label={`${label}: выбрать цвет`}
        aria-expanded={open}
        disabled={locked}
        onClick={() => {
          if (locked) return
          const r = swatchRef.current?.getBoundingClientRect()
          if (r) setAnchor(r)
          setAvoid(getAvoidRect?.() ?? null)
          setOpen((v) => !v)
        }}
        className={clsx(
          'w-9 h-9 shrink-0 rounded-lg border border-hairline shadow-inner',
          locked ? 'cursor-default' : 'cursor-pointer',
        )}
        style={{ background: hex }}
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="text-[12.5px] font-medium text-ink leading-tight truncate">
          {label}
        </div>
        <div className="text-[11px] text-ink-muted leading-tight mt-0.5 truncate">
          {hint}
        </div>
      </div>
      <input
        type="text"
        value={text}
        spellCheck={false}
        maxLength={7}
        disabled={locked}
        onChange={(e) => {
          const raw = e.target.value
          setText(raw)
          const n = normalizeHex(raw)
          if (n) onChange(n)
        }}
        onBlur={() => {
          const n = normalizeHex(text)
          if (n) {
            setText(n.toUpperCase())
            onChange(n)
          } else setText(value.toUpperCase())
        }}
        className={clsx(
          'w-[5.25rem] shrink-0 rounded-lg border px-2 py-1.5 text-[11px] font-mono uppercase tracking-wide',
          'bg-black/20 text-ink border-hairline focus:outline-none focus:border-accent/50',
          invalid && 'border-red-400/60',
          locked && 'opacity-70 cursor-default',
        )}
      />
      {open && anchor && !locked && (
        <ColorPickerPopover
          value={hex}
          anchor={anchor}
          avoid={avoid}
          onChange={(next) => {
            setText(next.toUpperCase())
            onChange(next)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}

export function CustomThemeEditor({
  active,
  onActivate: _onActivate,
  onApplied,
}: Props) {
  const loadSaved = () => {
    const mode = readCustomTextMode()
    return {
      mode,
      palette: applyTextContrastMode(readCustomPalette(), mode),
    }
  }
  const [textMode, setTextMode] = useState<TextContrastMode>(
    () => loadSaved().mode,
  )
  const [draft, setDraft] = useState<CustomThemePalette>(
    () => loadSaved().palette,
  )
  const [expanded, setExpanded] = useState(false)
  const previewRef = useRef<HTMLDivElement>(null)
  const issues = useMemo(() => validatePalette(draft), [draft])
  const blocking = issues.some(
    (i) =>
      i.key === 'bg' ||
      i.key === 'sidebar' ||
      i.key === 'surface' ||
      i.key === 'surfaceIn' ||
      i.key === 'text' ||
      i.key === 'muted' ||
      i.key === 'accent',
  )
  const softWarnings = issues.filter(
    (i) =>
      i.key === 'textOnBg' ||
      i.key === 'mutedOnBg' ||
      i.key === 'textOnBubbles' ||
      i.key === 'onAccent',
  )
  const inkManaged = textMode !== 'manual'

  const discardAndCollapse = () => {
    const saved = loadSaved()
    setTextMode(saved.mode)
    setDraft(saved.palette)
    setExpanded(false)
    if (active) applyTheme('custom')
  }

  const setField = (key: keyof CustomThemePalette, hex: string) => {
    if ((key === 'text' || key === 'muted') && textMode !== 'manual') {
      setTextMode('manual')
    }
    setDraft((prev) => {
      const next: CustomThemePalette = { ...prev, [key]: hex }
      if (key === 'bg' && textMode === 'auto') {
        return applyTextContrastMode(next, 'auto')
      }
      return next
    })
  }

  const setTextModeAndApply = (mode: TextContrastMode) => {
    setTextMode(mode)
    setDraft((prev) => applyTextContrastMode(prev, mode))
  }

  const applyNow = () => {
    if (blocking) return
    const clean = sanitizePalette(draft)
    writeCustomPalette(clean, textMode)
    setDraft(clean)
    applyTheme('custom')
    onApplied()
    setExpanded(false)
  }

  const resetDefaults = () => {
    setTextMode('auto')
    setDraft(applyTextContrastMode({ ...DEFAULT_CUSTOM_PALETTE }, 'auto'))
  }

  // Live preview on the app while editing — does NOT write storage
  useEffect(() => {
    if (!active || !expanded || blocking) return
    const t = window.setTimeout(() => {
      applyCustomPaletteToDocument(sanitizePalette(draft))
    }, 120)
    return () => window.clearTimeout(t)
  }, [draft, active, blocking, expanded])

  const swatchKeys: (keyof CustomThemePalette)[] = [
    'bg',
    'sidebar',
    'surfaceIn',
    'surface',
    'accent',
    'text',
  ]

  const inkHint =
    textMode === 'auto'
      ? 'Авто по фону'
      : textMode === 'light'
        ? 'Светлый пресет'
        : textMode === 'dark'
          ? 'Тёмный пресет'
          : undefined

  return (
    <div
      className={clsx(
        'rounded-2xl border transition-all',
        active
          ? 'border-chatAccent ring-2 ring-chatAccent/30 shadow-lg shadow-black/20'
          : 'border-hairline',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) {
            discardAndCollapse()
            return
          }
          if (!active) {
            // Select saved custom like other theme cards — stay collapsed
            applyTheme('custom')
            onApplied()
            return
          }
          // Active + collapsed → open editor
          const saved = loadSaved()
          setTextMode(saved.mode)
          setDraft(saved.palette)
          setExpanded(true)
        }}
        className={clsx(
          'w-full flex items-center gap-3 px-3.5 py-3 text-left bg-surface-inset/40 hover:bg-surface-inset/70 transition-colors',
          expanded ? 'rounded-t-2xl' : 'rounded-2xl',
        )}
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-accent/20 border border-accent/30">
          <Sparkles className="w-5 h-5 text-accent-fg" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-ink flex items-center gap-2">
            Своя тема
            {active && (
              <span className="text-[10px] font-bold uppercase tracking-wide text-accent-fg">
                активна
              </span>
            )}
          </div>
          <div className="text-[12px] text-ink-muted mt-0.5">
            {expanded
              ? 'Правки в чате — черновик; сохранение кнопкой ниже'
              : active
                ? 'Нажмите ещё раз, чтобы править цвета'
                : 'Нажмите, чтобы включить сохранённую тему'}
          </div>
          {!expanded && (
            <div className="flex items-center gap-1 mt-2">
              {swatchKeys.map((k) => (
                <span
                  key={k}
                  className="w-4 h-4 rounded-md border border-black/20 shadow-inner"
                  style={{ background: draft[k] }}
                />
              ))}
            </div>
          )}
        </div>
        <ChevronDown
          className={clsx(
            'w-4 h-4 shrink-0 text-ink-muted transition-transform duration-200',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <div className="px-3.5 pb-3.5 pt-1 space-y-3 border-t border-hairline bg-black/10 rounded-b-2xl">
          <div
            ref={previewRef}
            className="sticky top-0 z-10 -mx-3.5 px-3.5 pt-2 pb-2 bg-[color-mix(in_srgb,var(--color-sidebar)_92%,transparent)] backdrop-blur-md"
          >
            <MiniPreview palette={draft} />
          </div>

          <div className="rounded-xl border border-hairline bg-surface-inset/50 p-2">
            <div className="flex items-center justify-between gap-2 px-1 mb-1.5">
              <div className="text-[12px] font-medium text-ink">Текст</div>
              <div className="text-[11px] text-ink-muted truncate">
                {textMode === 'auto'
                  ? 'Под фон чата'
                  : textMode === 'light'
                    ? 'Светлые буквы'
                    : textMode === 'dark'
                      ? 'Тёмные буквы'
                      : 'Вручную'}
              </div>
            </div>
            <div
              className="grid grid-cols-4 gap-1 p-0.5 rounded-lg bg-black/20"
              role="radiogroup"
              aria-label="Контраст текста"
            >
              {TEXT_MODE_OPTIONS.map((opt) => {
                const on = textMode === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    title={opt.title}
                    onClick={() => setTextModeAndApply(opt.id)}
                    className={clsx(
                      'rounded-md py-1.5 text-[11.5px] font-semibold transition-colors',
                      on
                        ? 'bg-accent text-[color:var(--color-on-accent)] shadow-sm'
                        : 'text-ink-muted hover:text-ink hover:bg-white/5',
                    )}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {FIELDS.map((f) => {
              const inkField = f.key === 'text' || f.key === 'muted'
              return (
                <ColorField
                  key={f.key}
                  label={f.label}
                  hint={inkField && inkHint ? inkHint : f.hint}
                  value={draft[f.key]}
                  invalid={issues.some((i) => i.key === f.key)}
                  locked={inkField && inkManaged}
                  getAvoidRect={() =>
                    previewRef.current?.getBoundingClientRect() ?? null
                  }
                  onChange={(hex) => setField(f.key, hex)}
                />
              )
            })}
          </div>

          {softWarnings.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex gap-2 text-[12px] text-amber-200/95">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <ul className="space-y-0.5">
                {softWarnings.map((w) => (
                  <li key={w.key}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={blocking}
              onClick={applyNow}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-semibold transition-colors',
                blocking
                  ? 'opacity-50 cursor-not-allowed bg-surface-inset text-ink-muted'
                  : 'bg-accent text-[color:var(--color-on-accent)] hover:opacity-90',
              )}
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
              {active ? 'Сохранить' : 'Применить свою тему'}
            </button>
            <button
              type="button"
              onClick={resetDefaults}
              className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12.5px] font-medium border border-hairline bg-surface-inset text-ink-muted hover:text-ink hover:border-hairline-strong transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Сбросить
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
