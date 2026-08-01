import { useEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'

type SpoilerTextProps = {
  children: ReactNode
  /**
   * `interactive` — chat bubbles (click to reveal).
   * `preview` — room list / snippets (same look, not clickable).
   */
  mode?: 'interactive' | 'preview'
}

/**
 * Telegram-style spoiler: shimmering particle noise until clicked.
 */
export function SpoilerText({
  children,
  mode = 'interactive',
}: SpoilerTextProps) {
  const isPreview = mode === 'preview'
  const [revealed, setRevealed] = useState(false)
  const hidden = isPreview || !revealed
  const rootRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!hidden) return
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    let raf = 0
    let timer = 0
    let alive = true
    let visible = true
    let cssW = 0
    let cssH = 0
    let particles: Array<{ x: number; y: number; a: number; s: number }> = []

    const seedParticles = (w: number, h: number) => {
      const area = w * h
      // Match chat density; slightly denser for tiny preview chips
      const density = isPreview ? 0.5 : 0.42
      const count = Math.min(9000, Math.max(40, Math.floor(area * density)))
      particles = new Array(count)
      for (let i = 0; i < count; i++) {
        particles[i] = {
          x: Math.random() * w,
          y: Math.random() * h,
          a: 0.45 + Math.random() * 0.55,
          s: Math.random() > 0.82 ? 1.5 : 1,
        }
      }
    }

    const resize = () => {
      const rect = root.getBoundingClientRect()
      const nextW = Math.max(1, Math.ceil(rect.width))
      const nextH = Math.max(1, Math.ceil(rect.height))
      if (nextW === cssW && nextH === cssH) return
      cssW = nextW
      cssH = nextH
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(nextW * dpr))
      canvas.height = Math.max(1, Math.floor(nextH * dpr))
      canvas.style.width = `${nextW}px`
      canvas.style.height = `${nextH}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      seedParticles(cssW, cssH)
    }

    const paint = (reshuffleRatio = 0) => {
      if (!alive || !visible) return
      resize()
      const w = cssW
      const h = cssH
      if (reshuffleRatio > 0 && particles.length) {
        const n = Math.max(1, Math.floor(particles.length * reshuffleRatio))
        for (let i = 0; i < n; i++) {
          const p = particles[(Math.random() * particles.length) | 0]
          p.x = Math.random() * w
          p.y = Math.random() * h
          p.a = 0.45 + Math.random() * 0.55
        }
      }
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        ctx.fillStyle = `rgba(255,255,255,${p.a})`
        ctx.fillRect(p.x, p.y, p.s, p.s)
      }
    }

    const tick = () => {
      if (!alive) return
      paint(0.055)
      if (reduceMotion) return
      timer = window.setTimeout(() => {
        raf = requestAnimationFrame(tick)
      }, 110)
    }

    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              visible = entries.some((e) => e.isIntersecting)
              if (visible && alive && !reduceMotion) {
                cancelAnimationFrame(raf)
                window.clearTimeout(timer)
                tick()
              }
            },
            { root: null, threshold: 0 },
          )
        : null
    io?.observe(root)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            cssW = 0
            cssH = 0
            if (visible) paint()
          })
        : null
    ro?.observe(root)

    paint()
    if (!reduceMotion) tick()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      io?.disconnect()
      ro?.disconnect()
    }
  }, [hidden, isPreview])

  const toggle = () => {
    if (isPreview) return
    setRevealed((v) => !v)
  }

  return (
    <span
      ref={rootRef}
      className={clsx(
        'tg-mx-spoiler',
        isPreview && 'tg-mx-spoiler--preview',
        !hidden && 'tg-mx-spoiler--revealed',
      )}
      role={isPreview ? undefined : 'button'}
      tabIndex={isPreview ? undefined : 0}
      title={
        isPreview
          ? 'Скрытый текст'
          : revealed
            ? 'Скрыть'
            : 'Показать скрытый текст'
      }
      aria-label={
        isPreview
          ? 'Скрытый текст'
          : revealed
            ? 'Спойлер'
            : 'Скрытый текст — нажмите, чтобы показать'
      }
      aria-expanded={isPreview ? undefined : revealed}
      onClick={
        isPreview
          ? undefined
          : (e) => {
              e.stopPropagation()
              toggle()
            }
      }
      onKeyDown={
        isPreview
          ? undefined
          : (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                toggle()
              }
            }
      }
    >
      <span className="tg-mx-spoiler-content" aria-hidden={hidden}>
        {children}
      </span>
      {hidden && (
        <canvas ref={canvasRef} className="tg-mx-spoiler-noise" aria-hidden />
      )}
    </span>
  )
}
