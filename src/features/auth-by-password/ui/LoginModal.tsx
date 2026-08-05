import { useEffect, useState } from 'react'
import { useSessionStore } from '@/entities/session/model/session'
import {
  matrixService,
  normalizeHomeserverUrl,
} from '@/shared/api/MatrixService'

export function LoginModal() {
  const [baseUrl, setBaseUrl] = useState('https://matrix.org')
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSsoLoading, setIsSsoLoading] = useState(false)
  const [ssoAvailable, setSsoAvailable] = useState(true)
  const [ssoLabel, setSsoLabel] = useState('Continue with Google / SSO')

  const login = useSessionStore((state) => state.login)
  const startSsoLogin = useSessionStore((state) => state.startSsoLogin)

  // Probe homeserver for SSO providers when baseUrl changes
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const cleanHomeserver = normalizeHomeserverUrl(baseUrl)
        if (!cleanHomeserver) return
        const flows = await matrixService.getLoginFlows(cleanHomeserver)
        if (cancelled) return
        const hasSso = matrixService.hasSsoFlow(flows)
        setSsoAvailable(hasSso)
        if (!hasSso) {
          setSsoLabel('SSO unavailable on this server')
          return
        }
        const idp = matrixService.pickPreferredIdp(flows)
        if (idp?.brand === 'google' || idp?.name.toLowerCase().includes('google')) {
          setSsoLabel('Continue with Google')
        } else if (idp?.name) {
          setSsoLabel(`Continue with ${idp.name}`)
        } else {
          setSsoLabel('Continue with SSO')
        }
      } catch {
        if (!cancelled) {
          // Keep button enabled — user may still try; error shown on click
          setSsoAvailable(true)
          setSsoLabel('Continue with Google / SSO')
        }
      }
    }
    const t = window.setTimeout(probe, 300)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [baseUrl])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)
    try {
      const cleanHomeserver = normalizeHomeserverUrl(baseUrl)
      await login(cleanHomeserver, userId, password)
    } catch (err: any) {
      if (err?.name === 'MatrixError' || err?.errcode) {
        setError(
          `Matrix Error: ${err.data?.error || err.message} (Code: ${err.httpStatus || err.errcode})`,
        )
      } else {
        setError(err?.message || 'An unknown error occurred.')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const handleSso = async () => {
    setError('')
    setIsSsoLoading(true)
    try {
      const cleanHomeserver = normalizeHomeserverUrl(baseUrl)
      await startSsoLogin(cleanHomeserver)
    } catch (err: any) {
      if (err?.message === 'SSO window closed' || err?.message === 'SSO cancelled') {
        setError('SSO sign-in was cancelled.')
      } else if (err?.name === 'MatrixError' || err?.errcode) {
        setError(`Matrix Error: ${err.data?.error || err.message}`)
      } else {
        setError(err?.message || 'SSO sign-in failed.')
      }
    } finally {
      setIsSsoLoading(false)
    }
  }

  const inputStyles =
    'bg-surface-inset border border-hairline text-ink placeholder:text-ink-faint rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-full'
  const busy = isLoading || isSsoLoading

  return (
    <div className="h-full w-full min-h-0 flex items-center justify-center bg-chatBg">
      <div className="w-full max-w-sm p-8 space-y-6 bg-chatSidebar rounded-2xl shadow-panel border border-hairline backdrop-blur-md">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-chatText">Planetar</h1>
          <p className="text-ink-faint text-sm mt-1">Sign in to your Matrix account</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="text-sm font-medium text-ink-muted block mb-1.5">
              Homeserver
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className={inputStyles}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-ink-muted block mb-1.5">
              Username
            </label>
            <input
              type="text"
              placeholder="@user:matrix.org"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className={inputStyles}
              disabled={busy}
            />
          </div>
          <div>
            <label className="text-sm font-medium text-ink-muted block mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputStyles}
              disabled={busy}
            />
          </div>

          {error && <div className="text-red-400 text-sm text-center">{error}</div>}

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-accent hover:bg-accent-hover text-[color:var(--color-on-accent)] font-semibold py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-hairline" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="px-2 bg-chatSidebar text-ink-faint uppercase tracking-wide">
              or
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSso}
          disabled={busy || !ssoAvailable}
          className="w-full flex items-center justify-center gap-2.5 bg-surface-inset hover:bg-surface-inset border border-hairline text-chatText font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <GoogleIcon />
          {isSsoLoading ? 'Waiting for browser…' : ssoLabel}
        </button>
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C39.2 36.3 44 31 44 24c0-1.3-.1-2.5-.4-3.5z"
      />
    </svg>
  )
}
