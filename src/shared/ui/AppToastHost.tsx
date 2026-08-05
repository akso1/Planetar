import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { subscribeAppToast } from '@/shared/lib/appToast'
import { prefersReducedMotion, toastMotion } from '@/shared/lib/motion'

type ToastView = { id: number; message: string } | null

/** Global toast host — mount once under App (outside chat virtualization). */
export function AppToastHost() {
  const [toast, setToast] = useState<ToastView>(null)
  const reduce = prefersReducedMotion()

  useEffect(() => subscribeAppToast((t) => setToast(t)), [])

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[1400] flex justify-center px-4"
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout">
        {toast && (
          <motion.div
            key={toast.id}
            role="status"
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-hairline bg-[var(--menu-surface-solid)] px-3.5 py-2 text-[13px] font-medium text-ink shadow-float"
            {...(reduce
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                  transition: { duration: 0.12 },
                }
              : toastMotion)}
          >
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-accent-fg">
              <Check className="h-3 w-3" strokeWidth={2.75} />
            </span>
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
