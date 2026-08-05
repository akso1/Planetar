/** Lightweight toast bus — no React in clipboard / services. */

type ToastPayload = {
  id: number
  message: string
  duration: number
}

type Listener = (toast: ToastPayload | null) => void

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
let current: ToastPayload | null = null
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l(current)
}

export function showAppToast(
  message: string,
  opts?: { duration?: number },
): void {
  const text = message.trim()
  if (!text) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  current = {
    id: ++seq,
    message: text,
    duration: opts?.duration ?? 1800,
  }
  emit()
  timer = setTimeout(() => {
    current = null
    timer = null
    emit()
  }, current.duration)
}

export function subscribeAppToast(listener: Listener): () => void {
  listeners.add(listener)
  listener(current)
  return () => {
    listeners.delete(listener)
  }
}
