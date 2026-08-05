/**
 * Trackpad chat gestures.
 * Does NOT touch MessageRow / TimelineWindow / vertical scroll React state.
 *
 * Exit (swipe right / fingers-right → deltaX < 0 on macOS natural):
 *   Directional lock + deadzone + 25% snap-back — resists diagonal scroll.
 *
 * Reply (swipe left / fingers-left → deltaX > 0 on macOS natural):
 *   Soft live drag → 120ms wheel-idle debounce = finger lift → commit or cancel.
 *
 * Coordinate note: left-negative accumulatedX. macOS natural finger-left
 * produces deltaX > 0, so we accumulate `accumulatedX += -deltaX`.
 */

/** Bump when gesture constants change so MessageTimeline re-attaches (HMR). */
export const CHAT_GESTURES_REV = 14

export type ChatGestureHandlers = {
  onReply: (eventId: string) => void
  /** Phase 2 exit: animate from this offset to 100%, then unmount. */
  onExitRequest: (exitOffsetPx: number) => void
  exitTarget?: HTMLElement | null
  isEnabled?: () => boolean
}

// ── Reply (swipe left) — DO NOT RETUNE HERE ──────────────────────────────────
/** Soft tracking: visual ≈ accumulatedX * gain (feels like early Telegram build). */
const REPLY_VISUAL_GAIN = 0.55
/** Soft visual cap while dragging. */
const REPLY_VISUAL_MAX = -120
/** Commit when |visual| reaches this on finger-lift (~60–70px). */
const REPLY_VISUAL_THRESHOLD = -65
/** Wheel quiet gap ⇒ cancel when below threshold (finger lift). */
const REPLY_GESTURE_END_MS = 120
/**
 * Once past visual threshold, commit after this short quiet gap —
 * does not wait for the full macOS inertia trail (fixes fast-swipe pause).
 */
const REPLY_COMMIT_END_MS = 32
/** Ignore residual wheel while CSS springs home. */
const REPLY_ANIM_LOCK_MS = 350
/** Soft raw cap (past visual max / gain). */
const REPLY_RAW_CAP = -280
/** Deltas below this are inertia crumbs — don't keep postponing a commit. */
const REPLY_MICRO_DX = 6

// ── Exit (swipe right) — anti-false-trigger ──────────────────────────────────
/** Decide H vs V after this much combined travel. */
const EXIT_AXIS_DECIDE_PX = 12
/** No translateX until clean right shift exceeds this. */
const EXIT_DEADZONE_PX = 20
/** Commit close only when visual shift ≥ this fraction of chat width. */
const EXIT_COMMIT_RATIO = 0.25
const EXIT_GAIN = 0.9
const EXIT_LERP = 0.4
/** Wheel quiet → settle exit / clear vertical lock. */
const EXIT_IDLE_MS = 140

const HORIZ_START_RATIO = 1.05
const HORIZ_KEEP_RATIO = 0.55

const VEL_SAMPLES = 5
const FLICK_VEL_SUM = 28
const DECEL_RATIO = 0.14
const MIN_PEAK_DX = 3
const MIN_SAMPLES = 3

type AxisLock = 'none' | 'reply' | 'exit'

type ActiveReply = {
  msgEl: HTMLElement
  target: HTMLElement
  iconEl: HTMLElement
  armed: boolean
  wasArmed: boolean
}

type ReplyHit = {
  msgEl: HTMLElement
  shell: HTMLElement
}

function fingerLeft(deltaX: number) {
  return deltaX > 0
}
function fingerRight(deltaX: number) {
  return deltaX < 0
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function performHaptic() {
  try {
    void window.electronAPI?.performHaptic?.()
  } catch {
    /* ignore */
  }
}

function isInteractiveTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false
  return !!el.closest(
    'input, textarea, [contenteditable="true"], .tg-composer, .tg-ctx-menu, .tg-mention-card, dialog, [role="dialog"]',
  )
}

function findReplyHit(
  scroller: HTMLElement,
  clientX: number,
  clientY: number,
): ReplyHit | null {
  const under = document.elementFromPoint(clientX, clientY)
  if (!(under instanceof Element) || !scroller.contains(under)) return null
  if (under.closest('.tg-reaction-bar, .tg-sender')) return null

  const bubble = under.closest(
    '.tg-bubble, .tg-sticker, .tg-bubble--media',
  ) as HTMLElement | null
  if (!bubble || !scroller.contains(bubble)) return null
  if (under.closest('button') && !bubble.contains(under)) return null

  const msgEl = bubble.closest('.tg-msg') as HTMLElement | null
  if (!msgEl || !scroller.contains(msgEl)) return null

  const shell =
    (bubble.closest('.relative') as HTMLElement | null) || bubble
  return { msgEl, shell }
}

function ensureReplyIcon(shell: HTMLElement): HTMLElement {
  let icon = shell.querySelector(
    '.tg-msg-swipe-reply-icon',
  ) as HTMLElement | null
  if (icon) return icon
  if (getComputedStyle(shell).position === 'static') {
    shell.style.position = 'relative'
  }
  icon = document.createElement('span')
  icon.className = 'tg-msg-swipe-reply-icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML =
    '<span class="tg-msg-swipe-reply-icon-glyph"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></span>'
  shell.appendChild(icon)
  return icon
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3
}

function eventIdFromMsg(msgEl: HTMLElement): string | null {
  const id = msgEl.id || ''
  if (!id.startsWith('msg-')) return null
  const eventId = id.slice(4)
  return eventId && !eventId.startsWith('~') ? eventId : null
}

/** EXIT-ONLY velocity helper — do not use for reply. */
class VelocityTracker {
  private samples: number[] = []
  peak = 0

  reset() {
    this.samples = []
    this.peak = 0
  }

  push(absDeltaX: number) {
    if (absDeltaX < 0.25) return
    this.samples.push(absDeltaX)
    if (this.samples.length > VEL_SAMPLES) this.samples.shift()
    if (absDeltaX > this.peak) this.peak = absDeltaX
  }

  get flickSum(): number {
    return this.samples.reduce((a, b) => a + b, 0)
  }

  get currentAvg(): number {
    if (!this.samples.length) return 0
    const n = Math.min(2, this.samples.length)
    let sum = 0
    for (let i = this.samples.length - n; i < this.samples.length; i++) {
      sum += this.samples[i]
    }
    return sum / n
  }

  get decelerated(): boolean {
    if (this.samples.length < MIN_SAMPLES || this.peak < MIN_PEAK_DX) return false
    return this.currentAvg <= this.peak * DECEL_RATIO
  }
}

export function attachChatGestures(
  scroller: HTMLElement,
  handlers: ChatGestureHandlers,
): () => void {
  // ── Reply state ──
  let active: ActiveReply | null = null
  let accumulatedX = 0
  /** True while CSS spring owns the bubble — ignore residual wheel. */
  let isReplyAnimating = false
  let gestureTimeout: ReturnType<typeof setTimeout> | null = null
  let replyAnimUnlockTimer: ReturnType<typeof setTimeout> | null = null
  let replyCommitOnce = false

  // ── Exit state ──
  let exitRaw = 0
  let exitVisual = 0
  let exitProbeX = 0
  let exitProbeY = 0
  let exitAxisDecided = false
  /** Once true, ignore exit until wheel gesture goes idle. */
  let isVerticalScrollLocked = false
  let lock: AxisLock = 'none'
  let isGestureLocked = false
  let safetyIdleTimer: ReturnType<typeof setTimeout> | null = null
  let rafId = 0
  let disposed = false
  let unlockTimer: ReturnType<typeof setTimeout> | null = null

  const vel = new VelocityTracker()

  const enabled = () =>
    !disposed && (handlers.isEnabled ? handlers.isEnabled() : true)

  const exitEl = () => handlers.exitTarget ?? null
  const layerWidth = () => exitEl()?.clientWidth ?? 520
  const exitPreviewMax = () => Math.max(200, layerWidth() * 0.45)
  /** Visual right shift after deadzone (px). */
  const exitVisualGoal = () =>
    Math.max(0, Math.min(exitPreviewMax(), exitRaw - EXIT_DEADZONE_PX))
  const exitCommitPx = () => layerWidth() * EXIT_COMMIT_RATIO

  const resetExitProbe = () => {
    exitRaw = 0
    exitVisual = 0
    exitProbeX = 0
    exitProbeY = 0
    exitAxisDecided = false
  }

  const setGesturingAttr = (on: boolean) => {
    if (on) scroller.setAttribute('data-tg-gesturing', '1')
    else scroller.removeAttribute('data-tg-gesturing')
  }

  const stopRaf = () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }

  const clearSafetyIdle = () => {
    if (safetyIdleTimer) {
      clearTimeout(safetyIdleTimer)
      safetyIdleTimer = null
    }
  }

  const clearUnlockTimer = () => {
    if (unlockTimer) {
      clearTimeout(unlockTimer)
      unlockTimer = null
    }
  }

  const clearGestureTimeout = () => {
    if (gestureTimeout) {
      clearTimeout(gestureTimeout)
      gestureTimeout = null
    }
  }

  const clearReplyAnimUnlock = () => {
    if (replyAnimUnlockTimer) {
      clearTimeout(replyAnimUnlockTimer)
      replyAnimUnlockTimer = null
    }
  }

  // ── EXIT lock (unchanged) ──
  const engageLock = (holdMs: number | 'forever' = 400) => {
    isGestureLocked = true
    clearSafetyIdle()
    stopRaf()
    setGesturingAttr(false)
    vel.reset()
    clearUnlockTimer()
    if (holdMs === 'forever') return
    unlockTimer = setTimeout(() => {
      unlockTimer = null
      isGestureLocked = false
      lock = 'none'
    }, holdMs)
  }

  const paintExit = (x: number) => {
    if (isGestureLocked) return
    const el = exitEl()
    if (!el) return
    el.classList.add('tg-chat-exit-target', 'tg-chat-exit-dragging')
    el.style.transition = 'none'
    if (x <= 0.5) {
      el.style.transform = ''
      return
    }
    el.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`
  }

  const clearExitInline = () => {
    const el = exitEl()
    if (!el) return
    el.classList.remove('tg-chat-exit-dragging', 'tg-chat-exit-target')
    el.style.transform = ''
    el.style.transition = ''
    el.style.opacity = ''
    el.style.removeProperty('--swipe-start-offset')
  }

  const tick = () => {
    rafId = 0
    if (disposed || isGestureLocked) return
    if (lock === 'exit' && exitAxisDecided) {
      const reduced = prefersReducedMotion()
      const goal = exitVisualGoal()
      const prev = exitVisual
      const next = reduced ? goal : prev + (goal - prev) * EXIT_LERP
      exitVisual = Math.abs(goal - next) < 0.4 ? goal : next
      paintExit(exitVisual)
      if (exitVisual !== goal) rafId = requestAnimationFrame(tick)
    }
  }

  const kick = () => {
    if (!rafId && !isGestureLocked) rafId = requestAnimationFrame(tick)
  }

  // ── Reply helpers ──
  const replyVisualX = (raw: number) => {
    if (raw >= 0) return 0
    return Math.max(REPLY_VISUAL_MAX, raw * REPLY_VISUAL_GAIN)
  }

  const clearReplyDom = (target: HTMLElement, iconEl: HTMLElement | null) => {
    target.classList.remove(
      'tg-msg-swipe-target',
      'tg-msg-swipe-dragging',
      'tg-msg-swipe-commit',
      'tg-msg-swipe-spring',
    )
    target.style.transform = ''
    target.style.transition = ''
    iconEl?.remove()
  }

  const paintReplyLive = (visualX: number) => {
    if (!active || isReplyAnimating) return
    const { target, iconEl, msgEl } = active
    const reduced = prefersReducedMotion()
    const armed = visualX <= REPLY_VISUAL_THRESHOLD

    target.classList.add('tg-msg-swipe-target')
    target.classList.remove('tg-msg-swipe-spring', 'tg-msg-swipe-commit')
    target.classList.toggle('tg-msg-swipe-dragging', !reduced)
    target.style.transition = 'none'
    target.style.transform =
      visualX === 0 ? '' : `translate3d(${visualX.toFixed(2)}px,0,0)`

    const progress = easeOutCubic(
      Math.min(1, Math.abs(visualX) / Math.abs(REPLY_VISUAL_THRESHOLD)),
    )
    iconEl.style.opacity = String(Math.min(1, progress * 1.15))
    iconEl.style.transform = `translateY(-50%) translateX(${(progress * 8).toFixed(1)}px) scale(${(0.55 + 0.5 * progress).toFixed(3)})`

    const glyph = iconEl.querySelector(
      '.tg-msg-swipe-reply-icon-glyph',
    ) as HTMLElement | null
    if (armed && !active.wasArmed && glyph) {
      glyph.classList.remove('tg-msg-swipe-reply-icon--pop')
      void glyph.offsetWidth
      glyph.classList.add('tg-msg-swipe-reply-icon--pop')
    }
    if (!armed && glyph) glyph.classList.remove('tg-msg-swipe-reply-icon--pop')
    active.armed = armed
    active.wasArmed = armed
    iconEl.classList.toggle('tg-msg-swipe-reply-icon--armed', armed)
    msgEl.classList.toggle('tg-msg-swipe-armed', armed)
  }

  const engageReplyAnimLock = () => {
    isReplyAnimating = true
    clearReplyAnimUnlock()
    replyAnimUnlockTimer = setTimeout(() => {
      replyAnimUnlockTimer = null
      isReplyAnimating = false
      replyCommitOnce = false
      if (lock === 'reply') lock = 'none'
      setGesturingAttr(false)
    }, REPLY_ANIM_LOCK_MS)
  }

  /** CSS spring → 0; optional one-shot Reply + haptic. */
  const springReplyHome = (commit: boolean) => {
    if (!active) {
      accumulatedX = 0
      return
    }
    const { target, iconEl, msgEl } = active
    const eventId = eventIdFromMsg(msgEl)
    const reduced = prefersReducedMotion()
    const doCommit = commit && !!eventId && !replyCommitOnce

    target.classList.remove('tg-msg-swipe-dragging')
    msgEl.classList.remove('tg-msg-swipe-armed')
    iconEl.classList.remove('tg-msg-swipe-reply-icon--armed')

    if (doCommit) {
      replyCommitOnce = true
      target.classList.add('tg-msg-swipe-commit')
      iconEl
        .querySelector('.tg-msg-swipe-reply-icon-glyph')
        ?.classList.add('tg-msg-swipe-reply-icon--fire')
      performHaptic()
      handlers.onReply(eventId!)
    }

    engageReplyAnimLock()

    if (reduced) {
      clearReplyDom(target, iconEl)
      active = null
      accumulatedX = 0
      return
    }

    void target.offsetWidth
    target.classList.add('tg-msg-swipe-spring')
    target.style.transition =
      'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
    target.style.transform = ''
    iconEl.style.opacity = doCommit ? '1' : '0'
    if (!doCommit) iconEl.style.transform = 'translateY(-50%) scale(0.55)'

    const doneTarget = target
    const doneIcon = iconEl
    window.setTimeout(() => {
      clearReplyDom(doneTarget, doneIcon)
    }, 320)

    active = null
    accumulatedX = 0
  }

  /**
   * Finger lift = wheel idle.
   * Past threshold → short commit debounce (or immediate if already quiet).
   * Below threshold → longer debounce, then cancel spring.
   */
  const onGestureEnd = () => {
    gestureTimeout = null
    if (disposed || isReplyAnimating) return
    if (lock !== 'reply' && !active) return

    const visual = replyVisualX(accumulatedX)
    const commit = visual <= REPLY_VISUAL_THRESHOLD
    springReplyHome(commit)
    if (lock === 'reply') lock = 'none'
  }

  const scheduleGestureEnd = (pastThreshold: boolean) => {
    clearGestureTimeout()
    gestureTimeout = setTimeout(
      onGestureEnd,
      pastThreshold ? REPLY_COMMIT_END_MS : REPLY_GESTURE_END_MS,
    )
  }

  const beginReply = (hit: ReplyHit) => {
    if (isReplyAnimating) return
    if (active?.msgEl === hit.msgEl) return
    if (active) {
      clearReplyDom(active.target, active.iconEl)
      active.msgEl.classList.remove('tg-msg-swipe-armed')
    }
    accumulatedX = 0
    replyCommitOnce = false
    active = {
      msgEl: hit.msgEl,
      target: hit.shell,
      iconEl: ensureReplyIcon(hit.shell),
      armed: false,
      wasArmed: false,
    }
  }

  const abortReplyToVertical = () => {
    clearGestureTimeout()
    if (active && !isReplyAnimating) springReplyHome(false)
    else {
      accumulatedX = 0
      if (active) {
        clearReplyDom(active.target, active.iconEl)
        active.msgEl.classList.remove('tg-msg-swipe-armed')
        active = null
      }
    }
    if (lock === 'reply') lock = 'none'
  }

  // ── EXIT commit / cancel ──
  const commitExit = () => {
    if (isGestureLocked) return
    stopRaf()

    const offset = Math.max(exitVisual, exitVisualGoal())
    const el = exitEl()
    if (el) {
      el.classList.remove('tg-chat-exit-dragging')
      el.classList.add('tg-chat-exit-target')
      el.style.transition = 'none'
      el.style.transform = `translate3d(${offset.toFixed(2)}px,0,0)`
      el.style.setProperty('--swipe-start-offset', `${offset.toFixed(2)}px`)
    }

    engageLock('forever')
    resetExitProbe()
    lock = 'none'
    isVerticalScrollLocked = false
    if (active) {
      clearReplyDom(active.target, active.iconEl)
      active.msgEl.classList.remove('tg-msg-swipe-armed')
      active = null
    }
    accumulatedX = 0
    clearGestureTimeout()
    handlers.onExitRequest(offset)
  }

  const cancelExit = () => {
    if (isGestureLocked) return
    stopRaf()
    const el = exitEl()
    const from = exitVisual
    engageLock(400)
    resetExitProbe()
    lock = 'none'
    if (active) {
      clearReplyDom(active.target, active.iconEl)
      active.msgEl.classList.remove('tg-msg-swipe-armed')
      active = null
    }
    accumulatedX = 0
    clearGestureTimeout()

    if (el && !prefersReducedMotion() && from > 1) {
      el.classList.remove('tg-chat-exit-dragging')
      el.style.transition = 'none'
      el.style.transform = `translate3d(${from.toFixed(2)}px,0,0)`
      void el.offsetWidth
      el.style.transition =
        'transform 340ms cubic-bezier(0.22, 1.2, 0.36, 1)'
      el.style.transform = ''
      window.setTimeout(() => {
        if (!disposed) clearExitInline()
      }, 360)
    } else {
      clearExitInline()
    }
  }

  const settleExitAxis = () => {
    if (isGestureLocked || lock !== 'exit') return
    // Still probing axis — abandon without animating the layer.
    if (!exitAxisDecided) {
      resetExitProbe()
      lock = 'none'
      setGesturingAttr(false)
      return
    }
    const dist = Math.max(exitVisual, exitVisualGoal())
    if (dist >= exitCommitPx()) commitExit()
    else cancelExit()
  }

  const scheduleExitIdle = () => {
    clearSafetyIdle()
    safetyIdleTimer = setTimeout(() => {
      safetyIdleTimer = null
      if (disposed) return
      if (lock === 'exit' && !isGestureLocked) settleExitAxis()
      // End of physical gesture — allow exit again after a vertical scroll.
      isVerticalScrollLocked = false
    }, EXIT_IDLE_MS)
  }

  const tryFlickExit = (): boolean => {
    if (!exitAxisDecided) return false
    const dist = Math.max(exitVisual, exitVisualGoal())
    if (vel.flickSum < FLICK_VEL_SUM) return false
    // Flick still needs the 25% commit distance — no accidental closes.
    if (dist < exitCommitPx()) return false
    commitExit()
    return true
  }

  const abortExitToVertical = () => {
    stopRaf()
    clearExitInline()
    resetExitProbe()
    lock = 'none'
    isVerticalScrollLocked = true
    setGesturingAttr(false)
    vel.reset()
    scheduleExitIdle()
  }

  const onWheel = (e: WheelEvent) => {
    // ── EXIT hard lock ──
    if (isGestureLocked) {
      e.preventDefault()
      e.stopPropagation()
      return
    }

    if (!enabled()) return
    if (isInteractiveTarget(e.target)) return

    const over =
      e.target instanceof Node && scroller.contains(e.target)
        ? true
        : (() => {
            const hit = document.elementFromPoint(e.clientX, e.clientY)
            return !!(hit && scroller.contains(hit))
          })()
    if (!over) return

    const absX = Math.abs(e.deltaX)
    const absY = Math.abs(e.deltaY)

    // Reply spring lock — swallow residual horizontal trail, no more translateX.
    if (isReplyAnimating) {
      if (absX >= absY || fingerLeft(e.deltaX)) {
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }

    // ── Axis arming ──
    if (lock === 'none') {
      if (accumulatedX < 0 && absX >= 1.2 && fingerLeft(e.deltaX)) {
        lock = 'reply'
        setGesturingAttr(true)
      } else {
        if (fingerLeft(e.deltaX)) {
          if (absX < 1.2) return
          const ratio = absY < 0.01 ? Infinity : absX / absY
          if (ratio < HORIZ_START_RATIO) return
          const hit = findReplyHit(scroller, e.clientX, e.clientY)
          if (!hit) return
          lock = 'reply'
          setGesturingAttr(true)
          beginReply(hit)
        } else if (fingerRight(e.deltaX)) {
          // Vertical scroll lock: ignore exit until this physical gesture ends.
          if (isVerticalScrollLocked) {
            scheduleExitIdle()
            return
          }
          if (absX < 1.2) return
          // Start exit probe — directional lock decides within ~12px.
          lock = 'exit'
          resetExitProbe()
          vel.reset()
        } else {
          return
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // EXIT PATH — directional lock + deadzone + 25% snap-back
    // ════════════════════════════════════════════════════════════════════════
    if (lock === 'exit') {
      if (active) {
        clearReplyDom(active.target, active.iconEl)
        active.msgEl.classList.remove('tg-msg-swipe-armed')
        active = null
        accumulatedX = 0
        clearGestureTimeout()
      }

      // 1) Directional lock — decide before stealing scroll / painting.
      if (!exitAxisDecided) {
        exitProbeX += absX
        exitProbeY += absY
        scheduleExitIdle()
        if (exitProbeX + exitProbeY < EXIT_AXIS_DECIDE_PX) {
          // Still probing — do NOT preventDefault (vertical scroll must work).
          return
        }
        exitAxisDecided = true
        if (exitProbeY > exitProbeX) {
          abortExitToVertical()
          return
        }
        setGesturingAttr(true)
      }

      e.preventDefault()
      e.stopPropagation()
      vel.push(absX)

      if (tryFlickExit()) return

      if (vel.decelerated) {
        settleExitAxis()
        return
      }

      scheduleExitIdle()

      if (fingerRight(e.deltaX)) exitRaw += -e.deltaX * EXIT_GAIN
      else if (fingerLeft(e.deltaX))
        exitRaw = Math.max(0, exitRaw - e.deltaX * EXIT_GAIN)
      // Soft preview cap; deadzone applied in exitVisualGoal().
      exitRaw = Math.min(exitPreviewMax() + EXIT_DEADZONE_PX, exitRaw)
      kick()
      return
    }

    // ════════════════════════════════════════════════════════════════════════
    // REPLY PATH — soft live drag; finger-lift = 120ms wheel debounce
    // ════════════════════════════════════════════════════════════════════════
    if (lock !== 'reply') return

    // Vertical takes over → cancel (spring home, no reply)
    if (absY > 2 && absX < absY * HORIZ_KEEP_RATIO && absX < 2.5) {
      e.preventDefault()
      e.stopPropagation()
      abortReplyToVertical()
      setGesturingAttr(false)
      return
    }

    e.preventDefault()
    e.stopPropagation()

    if (!active) {
      const hit = findReplyHit(scroller, e.clientX, e.clientY)
      if (!hit) {
        accumulatedX = 0
        lock = 'none'
        setGesturingAttr(false)
        clearGestureTimeout()
        return
      }
      beginReply(hit)
    }

    // Clean accumulate.
    accumulatedX += -e.deltaX
    if (accumulatedX < REPLY_RAW_CAP) accumulatedX = REPLY_RAW_CAP
    if (accumulatedX > 40) accumulatedX = 40

    const visual = replyVisualX(accumulatedX)
    paintReplyLive(visual)

    const pastThreshold = visual <= REPLY_VISUAL_THRESHOLD

    // Fast swipe fix: once threshold is crossed, don't wait for the full
    // macOS inertia trail (that felt like a long freeze before Reply).
    // Micro crumbs after a deep pull must not keep resetting the timer.
    if (pastThreshold && absX < REPLY_MICRO_DX) {
      if (!gestureTimeout) scheduleGestureEnd(true)
      return
    }

    scheduleGestureEnd(pastThreshold)
  }

  scroller.addEventListener('wheel', onWheel, { passive: false, capture: true })

  return () => {
    disposed = true
    clearSafetyIdle()
    clearUnlockTimer()
    clearGestureTimeout()
    clearReplyAnimUnlock()
    stopRaf()
    setGesturingAttr(false)
    scroller.removeEventListener('wheel', onWheel, true)
    if (active) {
      clearReplyDom(active.target, active.iconEl)
      active.msgEl.classList.remove('tg-msg-swipe-armed')
      active = null
    }
    if (!isGestureLocked) clearExitInline()
    isGestureLocked = true
  }
}
