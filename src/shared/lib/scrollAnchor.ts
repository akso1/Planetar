/**
 * DOM-based scroll anchoring for virtualized chat timelines.
 *
 * Estimate-based restore (scrollHeight delta / getOffsetForIndex) teleports
 * when row heights differ from estimates. Anchoring to a rendered row's
 * viewport offset is stable across prepend/append and measure passes.
 */

export type ScrollAnchor = {
  key: string
  /** Distance from scroller top edge to the anchored row's top edge (px). */
  viewportOffset: number
  /** Virtualizer scroll offset at capture time (fallback). */
  scrollOffset: number
}

export function pickAnchorItem<T extends { start: number; end: number }>(
  items: T[],
  scrollOffset: number,
): T | null {
  if (items.length === 0) return null
  for (const item of items) {
    if (item.start <= scrollOffset + 1 && item.end > scrollOffset + 1) {
      return item
    }
    if (item.start >= scrollOffset) return item
  }
  return items[0] ?? null
}

/** How far to nudge scroll so the row returns to viewportOffset. */
export function viewportAnchorDelta(
  rowTop: number,
  scrollerTop: number,
  viewportOffset: number,
): number {
  const current = rowTop - scrollerTop
  return current - viewportOffset
}

export function shouldApplyAnchorDelta(delta: number, threshold = 0.75): boolean {
  return Number.isFinite(delta) && Math.abs(delta) >= threshold
}

/**
 * Whether a size-change for a virtual row should shift scrollTop.
 * Compensate only rows fully above the fold — never the focused/spanning row.
 * Also skip while the user is scrolling (esp. upward): measure→adjust fights
 * the gesture and feels like micro-teleports / jitter.
 */
export function shouldAdjustSizeAboveFold(
  itemEnd: number,
  scrollOffset: number,
  locked: boolean,
  opts?: { isScrolling?: boolean; scrollDirection?: string | null },
): boolean {
  if (locked) return false
  if (opts?.isScrolling) return false
  if (opts?.scrollDirection === 'backward') return false
  return itemEnd <= scrollOffset + 1
}

export function rowKeySelector(key: string): string {
  // CSS.escape is available in Chromium / modern browsers; tests polyfill.
  const esc =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(key)
      : key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[data-tg-row-key="${esc}"]`
}
