export type MenuPos = { left: number; top: number }

export function viewportBounds() {
  const vv = window.visualViewport
  return {
    vw: vv?.width ?? window.innerWidth,
    vh: vv?.height ?? window.innerHeight,
    ox: vv?.offsetLeft ?? 0,
    oy: vv?.offsetTop ?? 0,
  }
}

/**
 * Keep a fixed menu inside the visible viewport.
 * Prefers flipping above the cursor when it would overflow the bottom.
 * If the menu is taller than the viewport, pins to the top (caller should set maxHeight).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  pad = 10,
): MenuPos {
  const { vw, vh, ox, oy } = viewportBounds()

  const maxLeft = ox + vw - width - pad
  const maxTop = oy + vh - height - pad
  const minLeft = ox + pad
  const minTop = oy + pad

  let left = x
  let top = y

  // Horizontal: shift left if overflowing right
  if (left > maxLeft) left = Math.max(minLeft, maxLeft)
  if (left < minLeft) left = minLeft

  // Vertical: prefer open upward when near bottom
  if (top + height > oy + vh - pad) {
    const above = y - height
    if (above >= minTop) {
      top = above
    } else {
      // Taller than viewport (or no room): pin to top edge
      top = minTop
    }
  }
  if (top < minTop) top = minTop
  if (maxTop >= minTop && top > maxTop) top = maxTop

  return { left, top }
}
