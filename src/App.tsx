import { useEffect, type ReactNode } from 'react'
import { useSessionStore } from '@/entities/session/model/session'
import { LoginModal } from '@/features/auth-by-password/ui/LoginModal'
import { MainLayout } from '@/pages/MainLayout'
import { ErrorBoundary } from './shared/ui/ErrorBoundary'
import { AppToastHost } from './shared/ui/AppToastHost'
import { installRendererErrorReporting } from '@/shared/lib/errorLog'
import { initTheme, readStoredTheme, applyTheme, applyVibrancyEnabled, readVibrancyEnabled } from '@/shared/lib/theme'
import { initBizTasks } from '@/shared/lib/bizTasks'
import { TitleBar } from '@/widgets/TitleBar'
import { ChatListSkeleton } from '@/widgets/ChatListSkeleton'

function AppContent() {
  const authStatus = useSessionStore((state) => state.authStatus)
  const startup = useSessionStore((state) => state.startup)

  useEffect(() => {
    // Idempotent — also installed from main.tsx before first paint
    installRendererErrorReporting()
  }, [])

  useEffect(() => {
    // Prefer stored theme; empty → :root / theme-dark defaults
    applyTheme(readStoredTheme())
    applyVibrancyEnabled(readVibrancyEnabled())
    initBizTasks()
  }, [])

  useEffect(() => {
    void startup()
  }, [startup])

  let body: ReactNode
  if (authStatus === 'booting') {
    body = (
      <div className="tg-app h-full w-full flex flex-col bg-chatBg text-chatText min-h-0 flex-1">
        <div className="grow flex min-h-0 overflow-hidden">
          <div
            className="tg-sidebar w-[56px] shrink-0 border-r"
            aria-hidden
          />
          <ChatListSkeleton />
          <main className="tg-main flex-1 min-w-0 bg-chatBg" aria-hidden />
        </div>
      </div>
    )
  } else if (authStatus !== 'authenticated') {
    body = (
      <ErrorBoundary soft>
        <LoginModal />
      </ErrorBoundary>
    )
  } else {
    body = (
      <ErrorBoundary soft>
        <MainLayout />
      </ErrorBoundary>
    )
  }

  return (
    <div className="tg-shell h-screen w-screen flex flex-col bg-chatBg overflow-hidden">
      <TitleBar />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{body}</div>
      <AppToastHost />
    </div>
  )
}

function App() {
  useEffect(() => {
    initTheme()
  }, [])

  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  )
}

export default App
