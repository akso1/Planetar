/** Shared UI motion tokens — keep timelines/scroll out of this. */

export const MOTION_EASE_OUT = [0.22, 1, 0.36, 1] as const
export const MOTION_EASE_IN = [0.4, 0, 1, 1] as const

/** Composer reply / edit banner */
export const composerBannerMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  transition: { duration: 0.18, ease: MOTION_EASE_OUT },
} as const

/** Inner reply-target swap (same banner shell — avoids stacked banners). */
export const composerReplySwapMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.16, ease: MOTION_EASE_OUT },
} as const

/** Floating menus / toasts */
export const popMotion = {
  initial: { opacity: 0, y: 6, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 4, scale: 0.98 },
  transition: { duration: 0.16, ease: MOTION_EASE_OUT },
} as const

export const toastMotion = {
  initial: { opacity: 0, y: 14, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.98 },
  transition: { duration: 0.2, ease: MOTION_EASE_OUT },
} as const

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
