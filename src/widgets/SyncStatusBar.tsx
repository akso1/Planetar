import { useEffect, useState } from 'react'
import { SyncState } from 'matrix-js-sdk'
import { CloudOff, Loader2, Wifi, WifiOff } from 'lucide-react'
import { useSessionStore } from '@/entities/session/model/session'
import { clsx } from 'clsx'

type ConnTone = 'ok' | 'warn' | 'bad' | 'busy'

function statusForSync(
  online: boolean,
  syncState: SyncState | null,
): { label: string; tone: ConnTone } {
  if (!online) {
    return { label: 'Нет сети', tone: 'bad' }
  }
  switch (syncState) {
    case SyncState.Error:
      return { label: 'Ошибка соединения', tone: 'bad' }
    case SyncState.Stopped:
      return { label: 'Синхронизация остановлена', tone: 'bad' }
    case SyncState.Reconnecting:
      return { label: 'Переподключение…', tone: 'warn' }
    case SyncState.Catchup:
      return { label: 'Обновление…', tone: 'busy' }
    case SyncState.Prepared:
      return { label: 'Подключение…', tone: 'busy' }
    case SyncState.Syncing:
      return { label: 'В сети', tone: 'ok' }
    case null:
      return { label: 'Подключение…', tone: 'busy' }
    default:
      return { label: 'В сети', tone: 'ok' }
  }
}

const iconStyle = 'w-[18px] h-[18px] tg-nav-icon transition-colors'

/** Connection pill for the left rail — matches tg-nav-btn chrome. */
export function SyncStatusNav() {
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated)
  const syncState = useSessionStore((s) => s.syncState)
  const [online, setOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )

  useEffect(() => {
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  if (!isAuthenticated) return null

  const { label, tone } = statusForSync(online, syncState)

  const Icon =
    tone === 'ok'
      ? Wifi
      : tone === 'busy'
        ? Loader2
        : tone === 'warn'
          ? WifiOff
          : CloudOff

  return (
    <button
      type="button"
      className={clsx(
        'tg-nav-btn tg-nav-btn--sync group relative',
        tone === 'ok' && 'tg-nav-btn--sync-ok',
        tone === 'busy' && 'tg-nav-btn--sync-busy',
        tone === 'warn' && 'tg-nav-btn--sync-warn',
        tone === 'bad' && 'tg-nav-btn--sync-bad',
      )}
      title={label}
      aria-label={label}
      aria-live="polite"
    >
      <Icon
        className={clsx(iconStyle, tone === 'busy' && 'animate-spin')}
        strokeWidth={1.75}
      />
      <span
        className={clsx(
          'tg-sync-dot',
          tone === 'ok' && 'tg-sync-dot--ok',
          tone === 'busy' && 'tg-sync-dot--busy',
          tone === 'warn' && 'tg-sync-dot--warn',
          tone === 'bad' && 'tg-sync-dot--bad',
        )}
        aria-hidden
      />
    </button>
  )
}
