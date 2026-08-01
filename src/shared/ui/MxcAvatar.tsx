import { useEffect, useState } from 'react'
import type { MatrixClient } from 'matrix-js-sdk'
import { clsx } from 'clsx'
import { getGradient } from '@/shared/lib/color'
import {
  loadAuthenticatedMxcObjectUrl,
  releaseAuthenticatedMxcObjectUrl,
} from '@/shared/lib/matrixMedia'

type MxcAvatarProps = {
  client: MatrixClient | null | undefined
  mxcUrl?: string | null
  label: string
  size?: number
  className?: string
  textClassName?: string
}

/** Defer setState so we never update during a parent render flush. */
function scheduleState(fn: () => void) {
  queueMicrotask(fn)
}

/**
 * Circular avatar loaded via authenticated MSC3916 media.
 * Falls back to a gradient + initial when MXC is missing or load fails.
 */
export function MxcAvatar({
  client,
  mxcUrl,
  label,
  size = 44,
  className,
  textClassName,
}: MxcAvatarProps) {
  const mediaSize = Math.max(size * 2, size)
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    let acquired = false
    let released = false
    const releaseOnce = () => {
      if (!acquired || released || !mxcUrl) return
      released = true
      releaseAuthenticatedMxcObjectUrl(mxcUrl, mediaSize)
    }

    if (!client || !mxcUrl) {
      scheduleState(() => {
        if (cancelled) return
        setObjectUrl(null)
        setFailed(false)
      })
      return () => {
        cancelled = true
      }
    }

    scheduleState(() => {
      if (cancelled) return
      setFailed(false)
    })

    void (async () => {
      try {
        const url = await loadAuthenticatedMxcObjectUrl(
          client,
          mxcUrl,
          mediaSize,
        )
        acquired = true
        scheduleState(() => {
          if (cancelled) {
            releaseOnce()
            return
          }
          setObjectUrl(url)
        })
      } catch {
        scheduleState(() => {
          if (cancelled) return
          setObjectUrl(null)
          setFailed(true)
        })
      }
    })()

    return () => {
      cancelled = true
      releaseOnce()
    }
  }, [client, mxcUrl, mediaSize])

  const showImage = Boolean(objectUrl) && !failed
  const initial = (label || '?').charAt(0).toUpperCase()

  return (
    <div
      className={clsx(
        'rounded-full flex items-center justify-center text-white font-semibold shrink-0 overflow-hidden',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: showImage ? 'transparent' : getGradient(label || '?'),
      }}
    >
      {showImage ? (
        <img
          src={objectUrl!}
          alt=""
          className="w-full h-full object-cover"
          onError={() => {
            scheduleState(() => setFailed(true))
          }}
        />
      ) : (
        <span className={textClassName}>{initial}</span>
      )}
    </div>
  )
}
