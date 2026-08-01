import { useEffect } from 'react';
import { useSessionStore } from '@/entities/session/model/session';
import { LoginModal } from '@/features/auth-by-password/ui/LoginModal';
import { MainLayout } from '@/pages/MainLayout';
import { ErrorBoundary } from './shared/ui/ErrorBoundary';
import { installRendererErrorReporting } from '@/shared/lib/errorLog';
import { initTheme, readStoredTheme, applyTheme } from '@/shared/lib/theme';

function AppContent() {
  const authStatus = useSessionStore(state => state.authStatus);
  const startup = useSessionStore(state => state.startup);

  useEffect(() => {
    installRendererErrorReporting();
  }, []);

  useEffect(() => {
    // Prefer stored theme; empty → :root / theme-dark defaults
    const stored = readStoredTheme();
    applyTheme(stored);
  }, []);

  useEffect(() => {
    void startup();
  }, [startup]);

  if (authStatus === 'booting') {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-chatBg">
        <p className="text-chatMuted text-sm">Восстановление сессии…</p>
      </div>
    );
  }

  if (authStatus !== 'authenticated') {
    return (
      <ErrorBoundary soft>
        <LoginModal />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary soft>
      <MainLayout />
    </ErrorBoundary>
  );
}

function App() {
  useEffect(() => {
    initTheme();
  }, []);

  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

export default App;
