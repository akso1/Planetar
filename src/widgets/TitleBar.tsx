import { useEffect, useState, type ReactNode } from 'react'

function WinCaptionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={[
        'h-[38px] w-[46px] flex items-center justify-center transition-colors',
        'text-chatMuted hover:text-chatText',
        danger
          ? 'hover:bg-[#e81123] hover:text-white'
          : 'hover:bg-surface-inset',
      ].join(' ')}
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {children}
    </button>
  )
}

/**
 * Frameless drag strip.
 * - macOS: empty region; OS traffic lights stay native.
 * - Windows/Linux: custom min / max / close matching chat chrome.
 */
export function TitleBar() {
  const isWinChrome =
    typeof window !== 'undefined' &&
    (window.electronAPI?.platform === 'win32' ||
      window.electronAPI?.platform === 'linux')

  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!isWinChrome) return
    let cancelled = false
    void window.electronAPI?.windowIsMaximized?.().then((v) => {
      if (!cancelled) setMaximized(!!v)
    })
    const unsub = window.electronAPI?.onWindowMaximized?.((v) => {
      setMaximized(!!v)
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [isWinChrome])

  const onDragDoubleClick = () => {
    if (!isWinChrome) return
    void window.electronAPI?.windowMaximizeToggle?.()
  }

  return (
    <div
      data-tauri-drag-region
      className={[
        'h-[38px] shrink-0 select-none flex items-stretch',
        isWinChrome ? 'border-b border-hairline bg-chatSidebar/80' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ WebkitAppRegion: 'drag' }}
      onDoubleClick={onDragDoubleClick}
    >
      <div className="flex-1 min-w-0" aria-hidden />
      {isWinChrome && (
        <div className="flex items-stretch shrink-0">
          <WinCaptionButton
            label="Свернуть"
            onClick={() => void window.electronAPI?.windowMinimize?.()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </WinCaptionButton>
          <WinCaptionButton
            label={maximized ? 'Восстановить' : 'Развернуть'}
            onClick={() => void window.electronAPI?.windowMaximizeToggle?.()}
          >
            {maximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path
                  d="M2.5 3.5h5v5h-5zM3.5 2.5h5v5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect
                  x="1.5"
                  y="1.5"
                  width="7"
                  height="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
            )}
          </WinCaptionButton>
          <WinCaptionButton
            label="Закрыть"
            danger
            onClick={() => void window.electronAPI?.windowClose?.()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path
                d="M2 2l6 6M8 2L2 8"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </WinCaptionButton>
        </div>
      )}
    </div>
  )
}
