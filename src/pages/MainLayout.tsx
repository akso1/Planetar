import { useEffect, useState } from 'react'
import {
  CryptoEvent,
  canAcceptVerificationRequest,
  type VerificationRequest,
} from 'matrix-js-sdk/lib/crypto-api'
import { useSessionStore } from '@/entities/session/model/session'
import { matrixService } from '@/shared/api/MatrixService'
import { startDesktopNotifications } from '@/shared/lib/desktopNotifications'
import { useVerificationUiStore } from '@/shared/lib/verificationUi'
import { ChatList } from '../widgets/ChatList'
import { ChatProtectionWizard } from '../widgets/ChatProtectionWizard'
import { checkChatProtectionNeeded } from '@/shared/lib/chatProtection'
import { DeviceVerificationModal } from '../widgets/DeviceVerificationModal'
import { LeftSidebar } from '../widgets/LeftSidebar'
import { MessageTimeline } from '../widgets/MessageTimeline'
import { TitleBar } from '../widgets/TitleBar'

const PROTECTION_PROMPT_KEY = 'matrix-chat-protection-prompted'

export function MainLayout() {
  const client = useSessionStore((s) => s.client)
  const openIncoming = useVerificationUiStore((s) => s.openIncoming)
  const [protectionOpen, setProtectionOpen] = useState(false)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    let crypto: ReturnType<typeof client.getCrypto> | null = null

    const onRequest = (request: VerificationRequest) => {
      if (!canAcceptVerificationRequest(request)) return
      // Prefer self-verification (confirm this session via another device).
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
    <div className="tg-app h-screen w-screen flex flex-col bg-chatBg text-chatText">
      <TitleBar />
      <div className="grow flex h-[calc(100vh-38px)] overflow-hidden">
        <LeftSidebar />
        <ChatList />
        <main className="tg-main flex-1 min-w-0 flex flex-col overflow-hidden">
          <MessageTimeline />
        </main>
      </div>
      {client && <DeviceVerificationModal client={client} />}
      {client && (
        <ChatProtectionWizard
          client={client}
          open={protectionOpen}
          onClose={() => setProtectionOpen(false)}
        />
      )}
    </div>
  )
}
