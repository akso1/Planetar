/**
 * Highlight quoted text in a message.
 * Uses CSS Custom Highlight API (scrolls with content, keeps glyphs visible).
 * Overlay fallback is bubble-relative and only painted after scroll settles.
 */

const OVERLAY_ATTR = 'data-tg-quote-hl-overlay'
const HIGHLIGHT_NAME = 'tg-quote-hl'

let paintGen = 0
const pendingTimers = new Set<number>()

function clearPendingTimers(): void {
  for (const id of pendingTimers) window.clearTimeout(id)
  pendingTimers.clear()
}

function later(fn: () => void, ms: number): void {
  const id = window.setTimeout(() => {
    pendingTimers.delete(id)
    fn()
  }, ms)
  pendingTimers.add(id)
}

export function clearQuoteTextHighlights(): void {
  try {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    }
  } catch {
    /* ignore */
  }
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove())
  document.querySelectorAll('mark.tg-quote-text-hl').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

type TextPiece = { node: Text; start: number; end: number }

function collectTextPieces(root: HTMLElement): {
  full: string
  pieces: TextPiece[]
} {
  const pieces: TextPiece[] = []
  let full = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    if (!text) continue
    const el = node.parentElement
    if (
      el?.closest(
        [
          '.tg-bubble-meta',
          '.tg-reply-chip',
          '.tg-msg-actions',
          '.tg-md-quote',
          '.tg-forward-header',
          '.tg-quote-hl-layer',
          `[${OVERLAY_ATTR}]`,
          'img',
          '.tg-twemoji',
        ].join(', '),
      )
    ) {
      continue
    }
    const start = full.length
    full += text
    pieces.push({ node: node as Text, start, end: full.length })
  }
  return { full, pieces }
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function mapCollapsedIndex(full: string, collapsedIndex: number): number {
  const target = Math.max(0, collapsedIndex)
  let ci = 0
  let i = 0
  while (i < full.length && /\s/.test(full[i]!)) i++
  if (target === 0) return i
  while (i < full.length && ci < target) {
    if (/\s/.test(full[i]!)) {
      while (i < full.length && /\s/.test(full[i]!)) i++
      ci++
      continue
    }
    i++
    ci++
  }
  return i
}

function findInCollapsed(
  full: string,
  needle: string,
): { start: number; end: number } | null {
  const collapsedFull = collapseWs(full)
  if (!collapsedFull || !needle) return null
  let cStart = collapsedFull.indexOf(needle)
  if (cStart < 0) {
    cStart = collapsedFull.toLowerCase().indexOf(needle.toLowerCase())
  }
  if (cStart < 0) return null
  const start = mapCollapsedIndex(full, cStart)
  const end = mapCollapsedIndex(full, cStart + needle.length)
  if (end <= start) return null
  return { start, end }
}

function rangeFromOffsets(
  pieces: TextPiece[],
  start: number,
  end: number,
): Range | null {
  if (!pieces.length || end <= start) return null
  const range = document.createRange()
  let setStart = false
  let setEnd = false
  for (const p of pieces) {
    if (!setStart && start < p.end && start >= p.start) {
      range.setStart(
        p.node,
        Math.min(Math.max(0, start - p.start), p.node.length),
      )
      setStart = true
    }
    if (!setEnd && end > p.start && end <= p.end) {
      range.setEnd(
        p.node,
        Math.min(Math.max(0, end - p.start), p.node.length),
      )
      setEnd = true
      break
    }
  }
  if (setStart && !setEnd) {
    const last = pieces[pieces.length - 1]!
    if (end >= last.end) {
      range.setEnd(last.node, last.node.length)
      setEnd = true
    }
  }
  if (!setStart || !setEnd) return null
  try {
    if (range.collapsed) return null
  } catch {
    return null
  }
  return range
}

function findQuoteRange(root: HTMLElement, quote: string): Range | null {
  const needle = collapseWs(quote)
  if (!needle) return null
  const { full, pieces } = collectTextPieces(root)
  if (!full || pieces.length === 0) return null

  const trimmed = quote.trim()
  let start = full.indexOf(trimmed)
  let end = start >= 0 ? start + trimmed.length : -1
  if (start < 0) {
    const hit = findInCollapsed(full, needle)
    if (!hit) return null
    start = hit.start
    end = hit.end
  }
  return rangeFromOffsets(pieces, start, end)
}

function resolveBody(messageRoot: HTMLElement): HTMLElement {
  const candidates = [
    messageRoot.querySelector('.tg-bubble-text > .tg-msg-body'),
    messageRoot.querySelector('.tg-bubble-text .tg-msg-body'),
    messageRoot.querySelector('.tg-msg-body-main'),
    messageRoot.querySelector('.tg-msg-body'),
    messageRoot.querySelector('.tg-bubble-text'),
    messageRoot.querySelector('.tg-md'),
  ]
  for (const el of candidates) {
    if (el instanceof HTMLElement) return el
  }
  return messageRoot
}

function supportsCssHighlight(): boolean {
  try {
    return (
      typeof CSS !== 'undefined' &&
      'highlights' in CSS &&
      typeof Highlight !== 'undefined'
    )
  } catch {
    return false
  }
}

function paintCssHighlight(range: Range, durationMs: number, gen: number): boolean {
  if (!supportsCssHighlight()) return false
  try {
    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range))
    later(() => {
      if (gen !== paintGen) return
      try {
        CSS.highlights.delete(HIGHLIGHT_NAME)
      } catch {
        /* ignore */
      }
    }, durationMs)
    return true
  } catch {
    return false
  }
}

/** Bubble-relative overlay — scrolls with the message (not viewport-fixed). */
function paintBubbleOverlay(
  messageRoot: HTMLElement,
  range: Range,
  durationMs: number,
  gen: number,
): boolean {
  let rects: DOMRect[]
  try {
    rects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 1 && r.height > 1,
    )
  } catch {
    return false
  }
  if (!rects.length) {
    try {
      const b = range.getBoundingClientRect()
      if (b.width > 1 && b.height > 1) rects = [b]
      else return false
    } catch {
      return false
    }
  }

  const host = (messageRoot.querySelector('.tg-bubble') ||
    messageRoot) as HTMLElement
  const cs = getComputedStyle(host)
  if (cs.position === 'static') host.style.position = 'relative'

  const hostRect = host.getBoundingClientRect()
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove())

  const layer = document.createElement('div')
  layer.setAttribute(OVERLAY_ATTR, '1')
  layer.className = 'tg-quote-hl-layer'
  layer.setAttribute('aria-hidden', 'true')

  for (const r of rects) {
    const box = document.createElement('div')
    box.className = 'tg-quote-hl-rect'
    box.style.left = `${Math.round(r.left - hostRect.left)}px`
    box.style.top = `${Math.round(r.top - hostRect.top)}px`
    box.style.width = `${Math.max(2, Math.round(r.width))}px`
    box.style.height = `${Math.max(2, Math.round(r.height))}px`
    layer.appendChild(box)
  }

  host.appendChild(layer)
  later(() => {
    if (gen !== paintGen) return
    if (layer.isConnected) layer.remove()
  }, durationMs)
  return true
}

function tryPaint(
  messageRoot: HTMLElement,
  quote: string,
  durationMs: number,
  gen: number,
): boolean {
  if (gen !== paintGen || !messageRoot.isConnected) return false
  const body = resolveBody(messageRoot)
  const range = findQuoteRange(body, quote)
  if (!range) return false

  // CSS Highlight stays glued to glyphs while scrolling and keeps text readable
  if (paintCssHighlight(range.cloneRange(), durationMs, gen)) {
    return true
  }
  return paintBubbleOverlay(messageRoot, range, durationMs, gen)
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el
  while (cur) {
    const { overflowY } = getComputedStyle(cur)
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      cur.scrollHeight > cur.clientHeight + 1
    ) {
      return cur
    }
    cur = cur.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) || null
}

/** Resolve after scroll activity stops (debounce). */
function waitForScrollSettle(
  scroller: HTMLElement | null,
  quietMs = 140,
  maxWaitMs = 900,
): Promise<void> {
  return new Promise((resolve) => {
    if (!scroller) {
      later(() => resolve(), quietMs)
      return
    }
    let settled: number | null = null
    const started = Date.now()

    const finish = () => {
      scroller.removeEventListener('scroll', onScroll)
      if (settled != null) window.clearTimeout(settled)
      pendingTimers.delete(settled as number)
      resolve()
    }

    const onScroll = () => {
      if (settled != null) {
        window.clearTimeout(settled)
        pendingTimers.delete(settled)
      }
      settled = window.setTimeout(() => {
        pendingTimers.delete(settled!)
        finish()
      }, quietMs)
      pendingTimers.add(settled)

      if (Date.now() - started > maxWaitMs) finish()
    }

    scroller.addEventListener('scroll', onScroll, { passive: true })
    // If no scroll events fire (already in view / auto), settle soon
    settled = window.setTimeout(() => {
      pendingTimers.delete(settled!)
      finish()
    }, quietMs)
    pendingTimers.add(settled)
  })
}

export function highlightQuoteInMessage(
  messageRoot: HTMLElement,
  quote: string,
  durationMs = 2000,
): boolean {
  const q = quote?.trim()
  if (!q) return false
  paintGen += 1
  const gen = paintGen
  clearPendingTimers()
  clearQuoteTextHighlights()
  return tryPaint(messageRoot, q, durationMs, gen)
}

/**
 * Wait for scroll to settle, then highlight (no drifting fixed overlays).
 */
export function highlightQuoteInMessageRetry(
  getRoot: () => HTMLElement | null,
  quote: string,
  durationMs = 2200,
): void {
  const q = quote?.trim()
  if (!q) return

  paintGen += 1
  const gen = paintGen
  clearPendingTimers()
  clearQuoteTextHighlights()

  const rootNow = getRoot()
  const scroller = findScrollParent(rootNow)

  void waitForScrollSettle(scroller).then(() => {
    if (gen !== paintGen) return
    const paint = () => {
      if (gen !== paintGen) return
      const root = getRoot()
      if (!root) return
      tryPaint(root, q, durationMs, gen)
    }
    paint()
    // One refresh after layout/fonts
    later(paint, 80)
    later(paint, 200)
  })
}
