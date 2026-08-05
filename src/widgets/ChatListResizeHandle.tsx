import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  CHAT_LIST_WIDTH_DEFAULT,
  CHAT_LIST_WIDTH_MAX,
  CHAT_LIST_WIDTH_MIN,
  usePanelLayoutStore,
} from '@/shared/lib/panelLayout'

/**
 * Absolute drag strip on the chat-list right edge (where the visible border is).
 * Layout-only — does not touch timeline scroll / virtualization.
 */
export function ChatListResizeHandle() {
  const setWidth = usePanelLayoutStore((s) => s.setChatListWidth)
  const resetWidth = usePanelLayoutStore((s) => s.resetChatListWidth)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(CHAT_LIST_WIDTH_DEFAULT)
  const handleRef = useRef<HTMLDivElement>(null)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      setWidth(startW.current + (e.clientX - startX.current), { persist: false })
    },
    [setWidth],
  )

  const endDrag = useCallback(
    (e?: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('tg-col-resizing')
      const el = handleRef.current
      if (el && e && el.hasPointerCapture?.(e.pointerId)) {
        try {
          el.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }
      setWidth(usePanelLayoutStore.getState().chatListWidth, { persist: true })
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    },
    [onPointerMove, setWidth],
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    startX.current = e.clientX
    startW.current = usePanelLayoutStore.getState().chatListWidth
    document.body.classList.add('tg-col-resizing')
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  useEffect(() => {
    return () => {
      document.body.classList.remove('tg-col-resizing')
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [endDrag, onPointerMove])

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="Изменить ширину списка чатов"
      aria-valuemin={CHAT_LIST_WIDTH_MIN}
      aria-valuemax={CHAT_LIST_WIDTH_MAX}
      title="Потяните, чтобы изменить ширину списка. Двойной клик — сброс."
      className="tg-col-resize"
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        resetWidth()
      }}
    />
  )
}
