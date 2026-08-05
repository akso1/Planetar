import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  CryptoEvent,
  canAcceptVerificationRequest,
  type VerificationRequest,
} from 'matrix-js-sdk/lib/crypto-api'
import { useSessionStore } from '@/entities/session/model/session'
import { useRoomStore } from '@/entities/session/model/room.store'
import { matrixService } from '@/shared/api/MatrixService'
import { startDesktopNotifications } from '@/shared/lib/desktopNotifications'
import { useVerificationUiStore } from '@/shared/lib/verificationUi'
import { ErrorBoundary } from '@/shared/ui/ErrorBoundary'
import { ChatList } from '../widgets/ChatList'
import { ChatProtectionWizard } from '../widgets/ChatProtectionWizard'
import { checkChatProtectionNeeded } from '@/shared/lib/chatProtection'
import { DeviceVerificationModal } from '../widgets/DeviceVerificationModal'
import { LeftSidebar } from '../widgets/LeftSidebar'
import { CallOverlay } from '../widgets/CallOverlay'
import { MessageTimeline } from '../widgets/MessageTimeline'
import { clsx } from 'clsx'

const PROTECTION_PROMPT_KEY = 'matrix-chat-protection-prompted'
/** Must match `.tg-chat-layer--closing` transition duration in CSS. */
const CHAT_CLOSE_MS = 480

export function MainLayout() {
  const client = useSessionStore((s) => s.client)
  const activeRoomId = useRoomStore((s) => s.activeRoomId)
  const setActiveRoomId = useRoomStore((s) => s.actions.setActiveRoomId)
  const openIncoming = useVerificationUiStore((s) => s.openIncoming)
  const [protectionOpen, setProtectionOpen] = useState(false)

  /** Keep chat mounted while the exit spring plays. */
  const [isClosingChat, setIsClosingChat] = useState(false)
  const [closeFromPx, setCloseFromPx] = useState(0)
  const closingRoomIdRef = useRef<string | null>(null)
  const chatLayerRef = useRef<HTMLDivElement>(null)
  const closeFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const visibleRoomId =
    activeRoomId ?? (isClosingChat ? closingRoomIdRef.current : null)

  const finishCloseChat = useCallback(() => {
    if (closeFallbackTimer.current) {
      clearTimeout(closeFallbackTimer.current)
      closeFallbackTimer.current = null
    }
    setActiveRoomId(null)
    closingRoomIdRef.current = null
    setIsClosingChat(false)
    setCloseFromPx(0)
    const el = chatLayerRef.current
    if (el) {
      el.style.transition = ''
      el.style.transform = ''
    }
  }, [setActiveRoomId])

  const beginCloseChat = useCallback(
    (fromPx = 0) => {
      if (isClosingChat) return
      const roomId = activeRoomId
      if (!roomId) return
      closingRoomIdRef.current = roomId
      setCloseFromPx(Math.max(0, fromPx))
      setIsClosingChat(true)
    },
    [activeRoomId, isClosingChat],
  )

  // When opening another room (or same), cancel any in-flight close.
  useEffect(() => {
    if (!activeRoomId) return
    if (isClosingChat && activeRoomId !== closingRoomIdRef.current) {
      if (closeFallbackTimer.current) {
        clearTimeout(closeFallbackTimer.current)
        closeFallbackTimer.current = null
      }
      setIsClosingChat(false)
      closingRoomIdRef.current = null
      setCloseFromPx(0)
    }
  }, [activeRoomId, isClosingChat])

  // Continuous WAAPI slide from gesture preview → off-screen (no CSS jank).
  useLayoutEffect(() => {
    if (!isClosingChat) return
    const el = chatLayerRef.current
    if (!el) {
      finishCloseChat()
      return
    }

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduced || typeof el.animate !== 'function') {
      finishCloseChat()
      return
    }

    el.classList.add('tg-chat-layer--closing')
    el.style.transition = 'none'
    el.style.transform = `translate3d(${closeFromPx}px,0,0)`
    el.style.setProperty('--swipe-start-offset', `${closeFromPx}px`)

    const anim = el.animate(
      [
        { transform: `translate3d(${closeFromPx}px, 0, 0)` },
        { transform: 'translate3d(100%, 0, 0)' },
      ],
      {
        duration: CHAT_CLOSE_MS,
        easing: 'cubic-bezier(0.22, 1.05, 0.25, 1)',
        fill: 'forwards',
      },
    )

    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      finishCloseChat()
    }

    anim.addEventListener('finish', done)
    anim.addEventListener('cancel', done)

    closeFallbackTimer.current = setTimeout(done, CHAT_CLOSE_MS + 100)

    return () => {
      anim.cancel()
      if (closeFallbackTimer.current) {
        clearTimeout(closeFallbackTimer.current)
        closeFallbackTimer.current = null
      }
    }
  }, [isClosingChat, closeFromPx, finishCloseChat])

  useEffect(() => {
    if (!client) return
    let cancelled = false
    let crypto: ReturnType<typeof client.getCrypto> | null = null

    const onRequest = (request: VerificationRequest) => {
      if (!canAcceptVerificationRequest(request)) return
      if (!request.isSelfVerification) return
      if (useVerificationUiStore.getState().request) return
      if (useVerificationUiStore.getState().pendingOutgoing) return
      openIncoming(request)
    }

    const attach = async () => {
      try {
        await matrixService.ensureCryptoReady()
      } catch {
        return
      }
      if (cancelled) return
      crypto = client.getCrypto()
      if (!crypto) return
      crypto.on(CryptoEvent.VerificationRequestReceived, onRequest)
    }

    void attach()

    return () => {
      cancelled = true
      crypto?.off(CryptoEvent.VerificationRequestReceived, onRequest)
    }
  }, [client, openIncoming])

  useEffect(() => {
    if (!client) return
    return startDesktopNotifications(client)
  }, [client])

  useEffect(() => {
    if (!client) return
    const userId = client.getUserId()
    if (!userId) return
    const key = `${PROTECTION_PROMPT_KEY}:${userId}`
    if (localStorage.getItem(key) === '1') return

    let cancelled = false
    const t = window.setTimeout(() => {
      void checkChatProtectionNeeded(client).then((needed) => {
        if (cancelled || !needed) return
        localStorage.setItem(key, '1')
        setProtectionOpen(true)
      })
    }, 1800)

    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [client])

  return (
    <div className="tg-app h-full w-full flex flex-col bg-chatBg text-chatText min-h-0">
      <div className="grow flex min-h-0 overflow-hidden">
        <ErrorBoundary soft name="left_sidebar">
          <LeftSidebar />
        </ErrorBoundary>
        <ErrorBoundary soft name="chat_list">
          <ChatList />
        </ErrorBoundary>
        <ErrorBoundary soft name="chat_area">
          <main className="tg-main relative flex-1 min-w-0 flex flex-col overflow-hidden">
            <div
              className="absolute inset-0 z-0 flex items-center justify-center tg-chat-bg pointer-events-none"
              aria-hidden={!!visibleRoomId}
            >
              <p className="text-ink-faint text-[15px]">
                Выберите чат, чтобы начать переписку
              </p>
            </div>
            {visibleRoomId ? (
              <div
                ref={chatLayerRef}
                className={clsx(
                  'tg-chat-layer absolute inset-0 z-10 flex flex-col min-h-0 min-w-0',
                  isClosingChat && 'tg-chat-layer--closing',
                )}
              >
                <MessageTimeline
                  key={visibleRoomId}
                  onRequestCloseChat={beginCloseChat}
                />
              </div>
            ) : null}
          </main>
        </ErrorBoundary>
      </div>
      <ErrorBoundary soft name="device_verification">
        {client && <DeviceVerificationModal client={client} />}
      </ErrorBoundary>
      <ErrorBoundary soft name="call_overlay">
        {client && <CallOverlay />}
      </ErrorBoundary>
      <ErrorBoundary soft name="chat_protection">
        {client && (
          <ChatProtectionWizard
            client={client}
            open={protectionOpen}
            onClose={() => setProtectionOpen(false)}
          />
        )}
      </ErrorBoundary>
    </div>
  )
}
