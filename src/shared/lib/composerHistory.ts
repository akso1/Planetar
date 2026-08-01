export type ComposerSnapshot = {
  value: string
  start: number
  end: number
}

const COALESCE_MS = 450
const DEFAULT_LIMIT = 100

/**
 * Undo/redo for a controlled composer.
 * Discrete edits (format, paste, emoji) call `checkpoint` before changing.
 * Typing goes through `noteTyping` and is coalesced into one undo step.
 */
export function createComposerHistory(limit = DEFAULT_LIMIT) {
  let undo: ComposerSnapshot[] = []
  let redo: ComposerSnapshot[] = []
  let lastTypedAt = 0

  const pushUndo = (snap: ComposerSnapshot) => {
    const top = undo[undo.length - 1]
    if (top && top.value === snap.value) return
    undo.push({
      value: snap.value,
      start: snap.start,
      end: snap.end,
    })
    if (undo.length > limit) undo.shift()
  }

  return {
    checkpoint(snap: ComposerSnapshot) {
      pushUndo(snap)
      redo = []
      lastTypedAt = 0
    },

    noteTyping(before: ComposerSnapshot) {
      const now = Date.now()
      if (lastTypedAt === 0 || now - lastTypedAt > COALESCE_MS) {
        pushUndo(before)
        redo = []
      }
      lastTypedAt = now
    },

    undo(current: ComposerSnapshot): ComposerSnapshot | null {
      if (!undo.length) return null
      const prev = undo.pop()!
      redo.push({
        value: current.value,
        start: current.start,
        end: current.end,
      })
      lastTypedAt = 0
      return prev
    },

    redo(current: ComposerSnapshot): ComposerSnapshot | null {
      if (!redo.length) return null
      const next = redo.pop()!
      pushUndo(current)
      lastTypedAt = 0
      return next
    },

    reset(snap?: ComposerSnapshot) {
      undo = snap ? [{ ...snap }] : []
      redo = []
      lastTypedAt = 0
    },
  }
}

export type ComposerHistory = ReturnType<typeof createComposerHistory>
