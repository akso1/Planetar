import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import { CheckCheck, X } from 'lucide-react'
import type { MatrixClient } from 'matrix-js-sdk'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import type { MessageReader } from '@/shared/lib/readReceipts'
import {
  clampMenuPosition,
  type MenuPos,
} from '@/shared/lib/clampMenuPosition'

const MAX_VISIBLE = 3

type ReadByAvatarsProps = {
  client: MatrixClient | null | undefined
  readers: MessageReader[]
  align?: 'start' | 'end'
  className?: string
  /** When set, strip is always clickable even if empty (shows empty state). */
  allowEmptyOpen?: boolean
}

/**
 * Stacked read avatars. Click opens a popover with name + Matrix tag.
 */
export function ReadByAvatars({
  client,
  readers,
  align = 'end',
  className,
  allowEmptyOpen = false,
}: ReadByAvatarsProps) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  if (!readers.length && !allowEmptyOpen) return null

  const visible = readers.slice(0, MAX_VISIBLE)
  const extra = Math.max(0, readers.length - visible.length)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={clsx(
          'tg-read-by',
          align === 'end' ? 'tg-read-by--end' : 'tg-read-by--start',
          className,
        )}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        aria-expanded={open}
        aria-label={
          readers.length
            ? `Просмотрели ${readers.length}: открыть список`
            : 'Кто просмотрел'
        }
        title="Кто просмотрел"
      >
        <div className="tg-read-by-stack">
          {visible.map((r, i) => (
            <div
              key={r.userId}
              className="tg-read-by-avatar"
              style={{ zIndex: visible.length - i }}
            >
              <MxcAvatar
                client={client}
                mxcUrl={r.avatarMxc}
                label={r.displayName}
                size={18}
              />
            </div>
          ))}
          {extra > 0 && (
            <div className="tg-read-by-more">+{extra}</div>
          )}
          {readers.length === 0 && (
            <span className="tg-read-by-empty-label">Просмотры</span>
          )}
        </div>
      </button>
      {open && (
        <ReadersPopover
          client={client}
          readers={readers}
          anchorRef={btnRef}
          align={align}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

type DeliveryTicksButtonProps = {
  client: MatrixClient | null | undefined
  delivery: 'sent' | 'read'
  readers: MessageReader[]
  className?: string
}

/** Clickable ✓✓ that opens the same readers popover. */
export function DeliveryTicksButton({
  client,
  delivery,
  readers,
  className,
}: DeliveryTicksButtonProps) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={clsx(
          'tg-bubble-ticks',
          'tg-bubble-ticks--btn',
          delivery === 'read'
            ? 'tg-bubble-ticks--read'
            : 'tg-bubble-ticks--sent',
          className,
        )}
        title={
          delivery === 'read'
            ? 'Прочитано — нажмите, чтобы увидеть кто'
            : 'Доставлено — нажмите, чтобы увидеть кто'
        }
        aria-label={
          delivery === 'read' ? 'Прочитано, список просмотров' : 'Доставлено'
        }
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <CheckCheck className="w-[14px] h-[14px]" strokeWidth={2.4} />
      </button>
      {open && (
        <ReadersPopover
          client={client}
          readers={readers}
          anchorRef={btnRef}
          align="end"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ReadersPopover({
  client,
  readers,
  anchorRef,
  align,
  onClose,
}: {
  client: MatrixClient | null | undefined
  readers: MessageReader[]
  anchorRef: React.RefObject<HTMLElement | null>
  align: 'start' | 'end'
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuPos>({ left: 0, top: 0 })
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const el = panelRef.current
    const anchor = anchorRef.current
    if (!el || !anchor) return
    const rect = anchor.getBoundingClientRect()
    const size = el.getBoundingClientRect()
    const x =
      align === 'end' ? rect.right - size.width : rect.left
    const y = rect.bottom + 6
    setPos(clampMenuPosition(x, y, size.width, size.height, 8))
    setReady(true)
  }, [anchorRef, align, readers.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Кто просмотрел"
      className="tg-readers-pop"
      style={{
        left: pos.left,
        top: pos.top,
        visibility: ready ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tg-readers-pop-head">
        <div className="tg-readers-pop-title">
          {readers.length > 0
            ? `Просмотрели · ${readers.length}`
            : 'Просмотры'}
        </div>
        <button
          type="button"
          className="tg-readers-pop-close"
          aria-label="Закрыть"
          onClick={onClose}
        >
          <X className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
      </div>
      {readers.length === 0 ? (
        <div className="tg-readers-pop-empty">
          Пока никто не просмотрел
          <span>Или у собеседника приватные read receipts</span>
        </div>
      ) : (
        <ul className="tg-readers-pop-list">
          {readers.map((r) => (
            <li key={r.userId} className="tg-readers-pop-row">
              <MxcAvatar
                client={client}
                mxcUrl={r.avatarMxc}
                label={r.displayName}
                size={32}
              />
              <div className="tg-readers-pop-meta">
                <div className="tg-readers-pop-name">{r.displayName}</div>
                <div className="tg-readers-pop-tag">{r.mxid}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  )
}
