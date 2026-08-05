import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { ChevronRight } from 'lucide-react'
import {
  clampMenuPosition,
  viewportBounds,
  type MenuPos,
} from '@/shared/lib/clampMenuPosition'

export type AppContextMenuItem = {
  id: string
  label?: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** Visual separator — ignores label/onSelect */
  separator?: boolean
  shortcut?: string
  submenu?: AppContextMenuItem[]
  onSelect?: () => void
}

export type AppContextMenuProps = {
  x: number
  y: number
  items: AppContextMenuItem[]
  onClose: () => void
}

type Pos = MenuPos

function menuMaxHeight(pad = 10): number {
  const { oy, vh } = viewportBounds()
  return Math.max(120, vh - pad * 2)
}

/** Lightweight macOS-style context menu (portal), with optional submenus. */
export function AppContextMenu({ x, y, items, onClose }: AppContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const subRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Pos>({ left: x, top: y })
  const [ready, setReady] = useState(false)
  const [maxH, setMaxH] = useState(menuMaxHeight)
  const [openSubId, setOpenSubId] = useState<string | null>(null)
  const [subPos, setSubPos] = useState<Pos>({ left: 0, top: 0 })
  const [subMaxH, setSubMaxH] = useState(menuMaxHeight)
  const [subReady, setSubReady] = useState(false)
  const subCloseTimer = useRef<number | null>(null)
  const subAnchorRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setReady(false)
    setOpenSubId(null)
    setSubReady(false)
    const el = panelRef.current
    if (!el) return
    const place = () => {
      const nextMax = menuMaxHeight()
      setMaxH(nextMax)
      // Force layout with cap before measuring
      el.style.maxHeight = `${nextMax}px`
      const rect = el.getBoundingClientRect()
      setPos(clampMenuPosition(x, y, rect.width, rect.height))
      setReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [x, y, items.length])

  useLayoutEffect(() => {
    if (!openSubId) {
      setSubReady(false)
      return
    }
    const el = subRef.current
    const anchor = subAnchorRef.current
    if (!el || !anchor) return

    setSubReady(false)
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const nextMax = menuMaxHeight()
      setSubMaxH(nextMax)
      el.style.maxHeight = `${nextMax}px`

      const rect = el.getBoundingClientRect()
      const { ox, oy, vw, vh } = viewportBounds()
      const pad = 10

      let left = r.right + 6
      if (left + rect.width > ox + vw - pad) {
        left = r.left - rect.width - 6
      }
      if (left < ox + pad) left = ox + pad

      // Prefer aligning to the trigger row; then clamp into the window.
      let top = r.top - 6
      if (top + rect.height > oy + vh - pad) {
        top = oy + vh - pad - rect.height
      }
      if (top < oy + pad) top = oy + pad

      setSubPos({ left, top })
      setSubReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [openSubId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    const onResize = () => onClose()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      if (subCloseTimer.current) window.clearTimeout(subCloseTimer.current)
    }
  }, [onClose])

  const cancelSubClose = () => {
    if (subCloseTimer.current) {
      window.clearTimeout(subCloseTimer.current)
      subCloseTimer.current = null
    }
  }

  const scheduleSubClose = () => {
    cancelSubClose()
    subCloseTimer.current = window.setTimeout(() => setOpenSubId(null), 180)
  }

  const openSubmenu = (id: string, anchor: HTMLElement) => {
    cancelSubClose()
    subAnchorRef.current = anchor
    setOpenSubId(id)
  }

  const openItem = items.find((it) => it.id === openSubId)

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[1100]"
      style={{
        left: pos.left,
        top: pos.top,
        visibility: ready ? 'visible' : 'hidden',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        ref={panelRef}
        className="tg-ctx-menu min-w-[200px] max-w-[280px] rounded-xl border border-hairline bg-[var(--menu-surface-solid)] overflow-y-auto overscroll-contain py-1.5 px-1.5"
        style={{ maxHeight: maxH }}
      >
        {items.map((item) => {
          if (item.separator) {
            return (
              <div
                key={item.id}
                className="my-1.5 mx-1 h-px tg-ctx-sep"
                role="separator"
              />
            )
          }

          const hasSub = !!(item.submenu && item.submenu.length)

          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-haspopup={hasSub || undefined}
              aria-expanded={hasSub ? openSubId === item.id : undefined}
              onMouseEnter={(e) => {
                if (item.disabled) return
                if (hasSub) openSubmenu(item.id, e.currentTarget)
                else {
                  cancelSubClose()
                  setOpenSubId(null)
                }
              }}
              onMouseLeave={() => {
                if (hasSub) scheduleSubClose()
              }}
              onClick={(e) => {
                if (item.disabled) return
                if (hasSub) {
                  openSubmenu(item.id, e.currentTarget)
                  return
                }
                item.onSelect?.()
                onClose()
              }}
              data-menu-id={item.id}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] text-left transition-colors disabled:opacity-40',
                item.danger
                  ? 'text-red-400 hover:bg-red-500/15'
                  : 'text-ink hover:bg-surface-inset',
                openSubId === item.id && 'bg-surface-inset',
              )}
            >
              {item.icon && (
                <span
                  className={clsx(
                    'shrink-0',
                    item.danger ? 'text-red-400' : 'text-ink-muted',
                  )}
                >
                  {item.icon}
                </span>
              )}
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && !hasSub && (
                <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums tracking-wide pl-3">
                  {item.shortcut}
                </span>
              )}
              {hasSub && (
                <ChevronRight className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
              )}
            </button>
          )
        })}
      </div>

      {openItem?.submenu && (
        <div
          ref={subRef}
          role="menu"
          className="tg-ctx-menu fixed z-[1101] min-w-[220px] max-w-[300px] rounded-xl border border-hairline bg-[var(--menu-surface-solid)] overflow-y-auto overscroll-contain py-1.5 px-1.5"
          style={{
            left: subPos.left,
            top: subPos.top,
            maxHeight: subMaxH,
            visibility: subReady ? 'visible' : 'hidden',
          }}
          onMouseEnter={cancelSubClose}
          onMouseLeave={scheduleSubClose}
          onContextMenu={(e) => e.preventDefault()}
        >
          {openItem.submenu.map((item) => {
            if (item.separator) {
              return (
                <div
                  key={item.id}
                  className="my-1.5 mx-1 h-px tg-ctx-sep"
                  role="separator"
                />
              )
            }
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return
                  item.onSelect?.()
                  onClose()
                }}
                className={clsx(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] text-left transition-colors disabled:opacity-40',
                  item.danger
                    ? 'text-red-400 hover:bg-red-500/15'
                    : 'text-ink hover:bg-surface-inset',
                )}
              >
                {item.icon && (
                  <span
                    className={clsx(
                      'shrink-0 w-5 text-center text-[12px] font-semibold',
                      item.danger ? 'text-red-400' : 'text-ink-faint',
                    )}
                  >
                    {item.icon}
                  </span>
                )}
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && (
                  <span className="shrink-0 text-[11.5px] text-ink-faint tabular-nums tracking-wide pl-3">
                    {item.shortcut}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>,
    document.body,
  )
}
