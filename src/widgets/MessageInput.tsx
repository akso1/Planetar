import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import clsx from 'clsx'
import {
  Bold,
  BarChart3,
  CaseSensitive,
  Code2,
  Copy,
  ClipboardPaste,
  Italic,
  Link2,
  Mic,
  Paperclip,
  Quote,
  Scissors,
  Smile,
  Strikethrough,
  Underline,
  EyeOff,
  RemoveFormatting,
  X,
  Loader2,
  Type,
} from 'lucide-react'
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk'
import { useSessionStore } from '@/entities/session/model/session'
import { matrixService } from '@/shared/api/MatrixService'
import { getUserColor } from '@/shared/lib/color'
import {
  REPLY_MEDIA_IDS_KEY,
  sendAlbumMessages,
  sendStickerOrGif,
  sendVoiceMessage,
} from '@/shared/lib/sendMedia'
import { VoiceRecorder } from '@/shared/lib/voiceRecorder'
import { dataUrlToBlob, type StoredSticker } from '@/shared/lib/stickersStore'
import { buildTextWithOptionalQuote, quoteSnippet } from '@/shared/lib/messageQuote'
import { applyMentionLinksToContent } from '@/shared/lib/mentions'
import {
  clearComposerDraft,
  loadComposerDraft,
  rehydrateComposerDraft,
  saveComposerDraft,
} from '@/shared/lib/composerDrafts'
import { buildThreadRelation } from '@/shared/lib/threads'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import { reportAppError } from '@/shared/lib/errorLog'
import {
  applyCaseTransform,
  applyInlineFormat,
  applyLinkFormat,
  applyQuoteFormat,
  clearComposerFormat,
  composerMarkupToMatrix,
  selectionHasFormat,
  type ComposerSelection,
  type FormatKind,
} from '@/shared/lib/composerFormat'
import { createComposerHistory } from '@/shared/lib/composerHistory'
import { composerBannerMotion, composerReplySwapMotion, prefersReducedMotion } from '@/shared/lib/motion'
import { AppContextMenu, type AppContextMenuItem } from '@/shared/ui/AppContextMenu'
import { StickerPicker } from './StickerPicker'
import { CreatePollDialog } from './CreatePollDialog'
import { buildPollStartContent, pollNotificationSnippet } from '@/shared/lib/polls'

const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

function modLabel(keys: string): string {
  if (isMac) {
    return keys
      .replace(/Mod\+/g, '⌘')
      .replace(/Shift\+/g, '⇧')
      .replace(/Alt\+/g, '⌥')
  }
  return keys
    .replace(/Mod\+/g, 'Ctrl+')
    .replace(/Shift\+/g, 'Shift+')
    .replace(/Alt\+/g, 'Alt+')
}

type PendingItem = {
  id: string
  file: File
  previewUrl: string | null
}

export type ReplyTarget = {
  /** Primary event for m.in_reply_to */
  eventId: string
  /** Selected album media event ids (Telegram-style multi-photo reply) */
  mediaIds?: string[]
  senderName: string
  senderId?: string
  snippet: string
  /** Selected text quote (shown in bar; sent as blockquote + `>` body) */
  quoteText?: string
}

export type EditTarget = {
  eventId: string
  body: string
  msgtype?: string
}

export type PendingMention = {
  userId: string
  displayName: string
  /** bump to re-apply same user */
  nonce: number
}

type MessageInputProps = {
  activeRoom: Room
  /** Extra files from parent drag-and-drop */
  externalFiles?: File[]
  onExternalFilesConsumed?: () => void
  replyTo?: ReplyTarget | null
  onClearReply?: () => void
  editTarget?: EditTarget | null
  onClearEdit?: () => void
  pendingMention?: PendingMention | null
  onMentionConsumed?: () => void
  /** Called after a successful send / edit (scroll timeline to bottom, etc.) */
  onSent?: () => void
  /** When set, sends as MSC3440 thread reply under this root event */
  threadRootId?: string | null
}

function toPending(files: File[]): PendingItem[] {
  return files.map((file) => ({
    id: `${file.name}_${file.size}_${file.lastModified}_${Math.random()}`,
    file,
    previewUrl: file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : null,
  }))
}

function seedComposerFromDraft(roomId: string): {
  text: string
  mentionUserIds: string[]
  pending: PendingItem[]
} {
  const draft = rehydrateComposerDraft(roomId) ?? loadComposerDraft(roomId)
  return {
    text: draft?.text ?? '',
    mentionUserIds: draft?.mentionUserIds ?? [],
    pending: draft?.files?.length ? toPending(draft.files) : [],
  }
}

/** Screenshots / clipboard blobs often have empty or generic names. */
function normalizeClipboardFile(file: File): File {
  const name = (file.name || '').trim()
  const looksGeneric =
    !name ||
    name === 'image.png' ||
    name === 'blob' ||
    name === 'untitled' ||
    name === 'Untitled'
  if (!looksGeneric) return file

  const mime = (file.type || '').toLowerCase()
  const ext =
    mime === 'image/jpeg'
      ? 'jpg'
      : mime === 'image/webp'
        ? 'webp'
        : mime === 'image/gif'
          ? 'gif'
          : mime === 'image/png'
            ? 'png'
            : mime.startsWith('video/')
              ? 'mp4'
              : mime.startsWith('audio/')
                ? 'mp3'
                : mime.includes('pdf')
                  ? 'pdf'
                  : 'bin'
  const base = mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file'
  return new File([file], `${base}-${Date.now()}.${ext}`, {
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified || Date.now(),
  })
}

function filesFromClipboardData(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  const seen = new Set<string>()

  const push = (file: File | null) => {
    if (!file || file.size <= 0) return
    const key = `${file.type}:${file.size}:${file.name}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(normalizeClipboardFile(file))
  }

  if (data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      push(item.getAsFile())
    }
  }
  if (!out.length && data.files?.length) {
    for (const file of Array.from(data.files)) push(file)
  }
  return out
}

async function filesFromClipboardApi(): Promise<File[]> {
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return []
  }
  try {
    const items = await navigator.clipboard.read()
    const out: File[] = []
    for (const item of items) {
      for (const type of item.types) {
        if (type === 'text/plain' || type === 'text/html') continue
        try {
          const blob = await item.getType(type)
          if (!blob || blob.size <= 0) continue
          out.push(
            normalizeClipboardFile(
              new File([blob], 'clipboard', {
                type: blob.type || type,
                lastModified: Date.now(),
              }),
            ),
          )
        } catch {
          /* type not readable */
        }
      }
    }
    return out
  } catch {
    return []
  }
}

function attachReplyFields(
  content: Record<string, unknown>,
  replyTo: ReplyTarget | null | undefined,
  threadRootId?: string | null,
) {
  if (threadRootId) {
    Object.assign(
      content,
      buildThreadRelation(threadRootId, replyTo?.eventId || threadRootId),
    )
    const mediaIds =
      replyTo?.mediaIds?.filter(Boolean) ??
      (replyTo?.eventId ? [replyTo.eventId] : [])
    if (mediaIds.length > 0) {
      content[REPLY_MEDIA_IDS_KEY] = mediaIds
    }
    return
  }
  if (!replyTo?.eventId) return
  content['m.relates_to'] = {
    'm.in_reply_to': { event_id: replyTo.eventId },
  }
  const mediaIds =
    replyTo.mediaIds?.filter(Boolean) ??
    (replyTo.eventId ? [replyTo.eventId] : [])
  if (mediaIds.length > 0) {
    content[REPLY_MEDIA_IDS_KEY] = mediaIds
  }
}

function attachMentions(
  content: Record<string, unknown>,
  userIds: string[],
) {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (!unique.length) return
  content['m.mentions'] = { user_ids: unique }
}

export function MessageInput({
  activeRoom,
  externalFiles,
  onExternalFilesConsumed,
  replyTo,
  onClearReply,
  editTarget,
  onClearEdit,
  pendingMention,
  onMentionConsumed,
  onSent,
  threadRootId = null,
}: MessageInputProps) {
  const draftRoomKey = threadRootId
    ? `${activeRoom.roomId}::thread::${threadRootId}`
    : activeRoom.roomId
  const [seed] = useState(() => seedComposerFromDraft(draftRoomKey))
  const [text, setText] = useState(seed.text)
  const [pending, setPending] = useState<PendingItem[]>(seed.pending)
  const [mentionUserIds, setMentionUserIds] = useState<string[]>(
    seed.mentionUserIds,
  )
  const [isSending, setIsSending] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [pollBusy, setPollBusy] = useState(false)
  const [pollError, setPollError] = useState<string | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [composerMenu, setComposerMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickerBtnRef = useRef<HTMLButtonElement>(null)
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null)
  const voiceTimerRef = useRef<number | null>(null)
  const voiceLockRef = useRef(false)
  /** Prevents double-send from pointerup + lostpointercapture */
  const voiceFinishLockRef = useRef(false)
  /** If user releases before getUserMedia finishes, stop right after start */
  const voiceStopAfterStartRef = useRef(false)
  const voicePointerIdRef = useRef<number | null>(null)
  /** Keep selection across context-menu focus loss */
  const menuSelRef = useRef<ComposerSelection | null>(null)
  const selRef = useRef({ start: seed.text.length, end: seed.text.length })
  const historyRef = useRef(createComposerHistory())
  const historySeededRef = useRef(false)
  if (!historySeededRef.current) {
    historySeededRef.current = true
    historyRef.current.reset({
      value: seed.text,
      start: seed.text.length,
      end: seed.text.length,
    })
  }
  const editTargetRef = useRef(editTarget)
  editTargetRef.current = editTarget
  const roomIdRef = useRef<string | null>(draftRoomKey)
  const textRef = useRef(text)
  const pendingRef = useRef(pending)
  const mentionsRef = useRef(mentionUserIds)
  textRef.current = text
  pendingRef.current = pending
  mentionsRef.current = mentionUserIds
  /** Only persist/clear drafts after the user actually edits the composer. */
  const draftDirtyRef = useRef(false)
  const markDraftDirty = useCallback(() => {
    draftDirtyRef.current = true
  }, [])
  const typingActiveRef = useRef(false)
  const typingStopTimer = useRef<number | null>(null)
  const client = useSessionStore((state) => state.client)

  const stopTyping = useCallback(() => {
    if (typingStopTimer.current != null) {
      window.clearTimeout(typingStopTimer.current)
      typingStopTimer.current = null
    }
    if (!typingActiveRef.current || !client) return
    typingActiveRef.current = false
    void client
      .sendTyping(activeRoom.roomId, false, 0)
      .catch(() => {})
  }, [client, activeRoom.roomId])

  const bumpTyping = useCallback(() => {
    if (!client || editTargetRef.current) return
    if (!typingActiveRef.current) {
      typingActiveRef.current = true
      void client
        .sendTyping(activeRoom.roomId, true, 8000)
        .catch(() => {})
    }
    if (typingStopTimer.current != null) {
      window.clearTimeout(typingStopTimer.current)
    }
    typingStopTimer.current = window.setTimeout(() => {
      typingStopTimer.current = null
      if (!typingActiveRef.current || !client) return
      typingActiveRef.current = false
      void client
        .sendTyping(activeRoom.roomId, false, 0)
        .catch(() => {})
    }, 4000)
  }, [client, activeRoom.roomId])

  useEffect(() => {
    return () => {
      stopTyping()
      if (voiceTimerRef.current != null) {
        window.clearInterval(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
      voiceRecorderRef.current?.cancel()
      voiceRecorderRef.current = null
    }
  }, [stopTyping])

  const clearVoiceTimer = useCallback(() => {
    if (voiceTimerRef.current != null) {
      window.clearInterval(voiceTimerRef.current)
      voiceTimerRef.current = null
    }
  }, [])

  const startVoiceRecording = useCallback(async () => {
    if (voiceLockRef.current || isSending || editTarget || !client) return
    voiceLockRef.current = true
    voiceFinishLockRef.current = false
    voiceStopAfterStartRef.current = false
    setVoiceError(null)
    try {
      const recorder = new VoiceRecorder()
      voiceRecorderRef.current = recorder
      await recorder.start()
      // Released during mic permission / setup — discard
      if (voiceStopAfterStartRef.current) {
        voiceRecorderRef.current = null
        recorder.cancel()
        setVoiceRecording(false)
        setVoiceElapsedMs(0)
        setVoiceError('Удерживайте кнопку, чтобы записать голосовое')
        return
      }
      setVoiceRecording(true)
      setVoiceElapsedMs(0)
      clearVoiceTimer()
      const started = Date.now()
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceElapsedMs(Date.now() - started)
      }, 200)
      stopTyping()
    } catch (err) {
      voiceRecorderRef.current = null
      setVoiceRecording(false)
      const msg =
        err instanceof Error ? err.message : 'Не удалось начать запись'
      setVoiceError(msg)
      reportAppError({
        title: 'Голосовое сообщение',
        summary: msg,
        detail: err instanceof Error ? err.stack : String(err),
      })
    } finally {
      voiceLockRef.current = false
    }
  }, [clearVoiceTimer, client, editTarget, isSending, stopTyping])

  const cancelVoiceRecording = useCallback(() => {
    clearVoiceTimer()
    voiceStopAfterStartRef.current = false
    voiceFinishLockRef.current = false
    voicePointerIdRef.current = null
    voiceRecorderRef.current?.cancel()
    voiceRecorderRef.current = null
    setVoiceRecording(false)
    setVoiceElapsedMs(0)
  }, [clearVoiceTimer])

  const finishVoiceRecording = useCallback(async () => {
    // Still waiting for getUserMedia — mark for cancel after start
    if (voiceLockRef.current && !voiceRecorderRef.current?.recording) {
      voiceStopAfterStartRef.current = true
      return
    }
    if (voiceFinishLockRef.current) return
    const recorder = voiceRecorderRef.current
    if (!client || !recorder) {
      cancelVoiceRecording()
      return
    }

    // Claim the recorder immediately so a second event cannot send again
    voiceFinishLockRef.current = true
    voiceRecorderRef.current = null
    clearVoiceTimer()
    setIsSending(true)
    setVoiceRecording(false)

    try {
      if (recorder.elapsedMs < 450) {
        recorder.cancel()
        setVoiceError('Слишком короткое голосовое — удерживайте дольше')
        return
      }
      const result = await recorder.stop()
      setVoiceElapsedMs(0)
      pushBreadcrumb('voice_send', { roomId: activeRoom.roomId })
      await sendVoiceMessage(client, activeRoom, result.blob, {
        durationMs: result.durationMs,
        mimeType: result.mimeType,
        fileName: result.fileName,
        replyToEventId: replyTo?.eventId,
        threadRootId,
      })
      onClearReply?.()
      onSent?.()
      setVoiceError(null)
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') return
      const msg =
        err instanceof Error ? err.message : 'Не удалось отправить голосовое'
      setVoiceError(msg)
      reportAppError({
        title: 'Голосовое сообщение',
        summary: msg,
        detail: err instanceof Error ? err.stack : String(err),
      })
    } finally {
      setIsSending(false)
      setVoiceElapsedMs(0)
      voicePointerIdRef.current = null
      // Keep finish lock until next successful start clears it
    }
  }, [
    activeRoom,
    cancelVoiceRecording,
    clearVoiceTimer,
    client,
    onClearReply,
    onSent,
    replyTo?.eventId,
    threadRootId,
  ])

  useEffect(() => {
    if (!externalFiles?.length) return
    markDraftDirty()
    setPending((prev) => [...prev, ...toPending(externalFiles)])
    onExternalFilesConsumed?.()
  }, [externalFiles, onExternalFilesConsumed, markDraftDirty])

  // If seed somehow missed a persisted draft, pull it in once after mount.
  useEffect(() => {
    if (draftDirtyRef.current || editTarget) return
    if (textRef.current.trim() || pendingRef.current.length) return
    const draft = rehydrateComposerDraft(draftRoomKey)
    if (!draft) return
    if (!draft.text.trim() && !draft.mentionUserIds.length && !draft.files.length) {
      return
    }
    setText(draft.text)
    setMentionUserIds(draft.mentionUserIds)
    if (draft.files.length) setPending(toPending(draft.files))
    historyRef.current.reset({
      value: draft.text,
      start: draft.text.length,
      end: draft.text.length,
    })
    selRef.current = { start: draft.text.length, end: draft.text.length }
  }, [draftRoomKey, editTarget])

  useEffect(() => {
    if (editTarget) {
      setText(editTarget.body)
      historyRef.current.reset({
        value: editTarget.body,
        start: editTarget.body.length,
        end: editTarget.body.length,
      })
      selRef.current = {
        start: editTarget.body.length,
        end: editTarget.body.length,
      }
      inputRef.current?.focus({ preventScroll: true })
      return
    }
  }, [editTarget?.eventId])

  // Focus composer when entering a room / thread so typing can start immediately.
  // preventScroll: avoid jumping the message timeline when the textarea focuses.
  useEffect(() => {
    const t = window.setTimeout(() => {
      inputRef.current?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(t)
  }, [draftRoomKey])

  useEffect(() => {
    if (replyTo && !editTarget) inputRef.current?.focus({ preventScroll: true })
  }, [
    replyTo?.eventId,
    replyTo?.mediaIds?.join(','),
    replyTo?.quoteText,
    editTarget,
  ])

  useEffect(() => {
    if (!pendingMention) return
    const raw = pendingMention.displayName.trim()
    const token = `${raw.startsWith('@') ? raw : `@${raw}`} `
    markDraftDirty()

    const el = inputRef.current
    const value = el?.value ?? text
    // Prefer live caret; fall back to last known selRef (mention click blurs textarea)
    let start =
      el && document.activeElement === el
        ? (el.selectionStart ?? selRef.current.start)
        : selRef.current.start
    let end =
      el && document.activeElement === el
        ? (el.selectionEnd ?? selRef.current.end)
        : selRef.current.end
    start = Math.max(0, Math.min(start, value.length))
    end = Math.max(start, Math.min(end, value.length))

    const before = value.slice(0, start)
    const after = value.slice(end)
    const needsSpaceBefore = before.length > 0 && !/\s$/.test(before)
    const insert = `${needsSpaceBefore ? ' ' : ''}${token}`
    const next = before + insert + after
    const caret = before.length + insert.length

    historyRef.current.checkpoint({ value, start, end })
    setText(next)
    setMentionUserIds((prev) =>
      prev.includes(pendingMention.userId)
        ? prev
        : [...prev, pendingMention.userId],
    )
    selRef.current = { start: caret, end: caret }
    onMentionConsumed?.()

    const focusAtCaret = () => {
      const node = inputRef.current
      if (!node) return
      node.focus({ preventScroll: true })
      try {
        node.setSelectionRange(caret, caret)
      } catch {
        /* ignore */
      }
    }
    requestAnimationFrame(() => {
      focusAtCaret()
      window.setTimeout(focusAtCaret, 80)
    })
    // intentionally omit `text` — use snapshot at mention click only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    pendingMention?.nonce,
    pendingMention?.userId,
    pendingMention?.displayName,
    onMentionConsumed,
  ])

  useEffect(() => {
    return () => {
      pending.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const maxH = 160
    const minH = 40
    el.style.height = '0px'
    const full = el.scrollHeight
    const next = Math.min(Math.max(full, minH), maxH)
    el.style.height = `${next}px`
    // Scroll only when content hits the max height cap
    el.style.overflowY = full > maxH ? 'auto' : 'hidden'
  }, [text])

  const focusComposer = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    try {
      const len = el.value.length
      el.setSelectionRange(len, len)
    } catch {
      /* ignore */
    }
  }, [])

  const submitForm = () => {
    const form = inputRef.current?.form
    if (!form) return
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  }

  const insertEmoji = (emoji: string) => {
    markDraftDirty()
    const el = inputRef.current
    if (!el) {
      historyRef.current.checkpoint({
        value: text,
        start: text.length,
        end: text.length,
      })
      setText((prev) => prev + emoji)
      return
    }
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    historyRef.current.checkpoint({ value: text, start, end })
    const next = text.slice(0, start) + emoji + text.slice(end)
    setText(next)
    const caret = start + emoji.length
    selRef.current = { start: caret, end: caret }
    requestAnimationFrame(() => {
      el.focus()
      try {
        el.setSelectionRange(caret, caret)
      } catch {
        /* ignore */
      }
      // Re-assert after picker click steals focus on some platforms
      window.setTimeout(() => {
        el.focus()
        try {
          el.setSelectionRange(caret, caret)
        } catch {
          /* ignore */
        }
      }, 0)
    })
  }

  const readLiveSelection = (): ComposerSelection => {
    const el = inputRef.current
    const value = el?.value ?? text
    const start = el?.selectionStart ?? selRef.current.start
    const end = el?.selectionEnd ?? selRef.current.end
    return { value, start, end }
  }

  const readMenuSelection = (): ComposerSelection =>
    menuSelRef.current ?? readLiveSelection()

  const applySelection = (next: ComposerSelection, opts?: { checkpoint?: boolean }) => {
    markDraftDirty()
    if (opts?.checkpoint !== false) {
      const before =
        menuSelRef.current && menuSelRef.current.value === text
          ? menuSelRef.current
          : {
              value: text,
              start: selRef.current.start,
              end: selRef.current.end,
            }
      historyRef.current.checkpoint(before)
    }
    menuSelRef.current = next
    selRef.current = { start: next.start, end: next.end }
    setText(next.value)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      try {
        el.setSelectionRange(next.start, next.end)
      } catch {
        /* ignore */
      }
    })
  }

  const restoreSnapshot = (snap: { value: string; start: number; end: number }) => {
    selRef.current = { start: snap.start, end: snap.end }
    setText(snap.value)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      try {
        const max = snap.value.length
        el.setSelectionRange(
          Math.min(snap.start, max),
          Math.min(snap.end, max),
        )
      } catch {
        /* ignore */
      }
    })
  }

  const runUndo = () => {
    const cur = readLiveSelection()
    const prev = historyRef.current.undo(cur)
    if (prev) restoreSnapshot(prev)
  }

  const runRedo = () => {
    const cur = readLiveSelection()
    const next = historyRef.current.redo(cur)
    if (next) restoreSnapshot(next)
  }

  const runFormat = (kind: FormatKind, fromMenu = false) => {
    const sel = fromMenu ? readMenuSelection() : readLiveSelection()
    if (kind === 'quote') applySelection(applyQuoteFormat(sel))
    else applySelection(applyInlineFormat(sel, kind))
  }

  const runClearFormat = () => {
    applySelection(clearComposerFormat(readMenuSelection()))
  }

  const runCase = (mode: 'upper' | 'lower' | 'title') => {
    applySelection(applyCaseTransform(readMenuSelection(), mode))
  }

  const runLink = (fromMenu = false) => {
    const sel = fromMenu ? readMenuSelection() : readLiveSelection()
    const url = window.prompt('Введите ссылку (https://…)', 'https://')
    if (url == null) return
    const trimmed = url.trim()
    if (!trimmed) return
    applySelection(applyLinkFormat(sel, trimmed))
  }

  const clipboardAction = async (action: 'cut' | 'copy' | 'paste') => {
    const el = inputRef.current
    const snap = menuSelRef.current
    try {
      if (action === 'paste') {
        if (!editTarget) {
          const clipFiles = await filesFromClipboardApi()
          if (clipFiles.length) addFiles(clipFiles)
        }
        let clip = ''
        try {
          clip = await navigator.clipboard.readText()
        } catch {
          clip = ''
        }
        if (!clip) {
          if (!editTarget) {
            // Files-only paste from context menu — already attached above
            return
          }
          throw new Error('no clipboard text')
        }
        const base = snap ?? readLiveSelection()
        const next =
          base.value.slice(0, base.start) + clip + base.value.slice(base.end)
        const caret = base.start + clip.length
        applySelection({ value: next, start: caret, end: caret })
        return
      }
      const base = snap ?? readLiveSelection()
      if (base.start === base.end) return
      const selected = base.value.slice(base.start, base.end)
      await navigator.clipboard.writeText(selected)
      if (action === 'cut') {
        const next =
          base.value.slice(0, base.start) + base.value.slice(base.end)
        applySelection({
          value: next,
          start: base.start,
          end: base.start,
        })
      }
    } catch (err) {
      console.warn('clipboard', err)
      try {
        el?.focus()
        document.execCommand(action)
      } catch {
        /* ignore */
      }
    }
  }

  const composerMenuItems = (): AppContextMenuItem[] => {
    const sel = readMenuSelection()
    const hasSel = sel.start !== sel.end
    const canClear = hasSel && selectionHasFormat(sel)
    return [
      {
        id: 'cut',
        label: 'Вырезать',
        icon: <Scissors className="w-4 h-4" />,
        shortcut: modLabel('Mod+X'),
        disabled: !hasSel,
        onSelect: () => void clipboardAction('cut'),
      },
      {
        id: 'copy',
        label: 'Копировать',
        icon: <Copy className="w-4 h-4" />,
        shortcut: modLabel('Mod+C'),
        disabled: !hasSel,
        onSelect: () => void clipboardAction('copy'),
      },
      {
        id: 'paste',
        label: 'Вставить',
        icon: <ClipboardPaste className="w-4 h-4" />,
        shortcut: modLabel('Mod+V'),
        onSelect: () => void clipboardAction('paste'),
      },
      { id: 'sep-main', separator: true },
      {
        id: 'transform',
        label: 'Преобразования',
        icon: <Type className="w-4 h-4" />,
        submenu: [
          {
            id: 'clear',
            label: 'Убрать форматирование',
            icon: <RemoveFormatting className="w-4 h-4" />,
            disabled: !canClear,
            onSelect: runClearFormat,
          },
          { id: 'sep-fmt', separator: true },
          {
            id: 'strike',
            label: 'Зачёркнутый',
            icon: <Strikethrough className="w-4 h-4" />,
            shortcut: modLabel('Shift+Mod+X'),
            onSelect: () => runFormat('strike', true),
          },
          {
            id: 'underline',
            label: 'Подчёркнутый',
            icon: <Underline className="w-4 h-4" />,
            shortcut: modLabel('Shift+Mod+U'),
            onSelect: () => runFormat('underline', true),
          },
          {
            id: 'spoiler',
            label: 'Скрытый',
            icon: <EyeOff className="w-4 h-4" />,
            shortcut: modLabel('Shift+Mod+P'),
            onSelect: () => runFormat('spoiler', true),
          },
          {
            id: 'mono',
            label: 'Моноширинный',
            icon: <Code2 className="w-4 h-4" />,
            shortcut: modLabel('Shift+Mod+K'),
            onSelect: () => runFormat('mono', true),
          },
          {
            id: 'italic',
            label: 'Курсив',
            icon: <Italic className="w-4 h-4" />,
            shortcut: modLabel('Mod+I'),
            onSelect: () => runFormat('italic', true),
          },
          {
            id: 'bold',
            label: 'Жирный',
            icon: <Bold className="w-4 h-4" />,
            shortcut: modLabel('Mod+B'),
            onSelect: () => runFormat('bold', true),
          },
          {
            id: 'link',
            label: 'Добавить ссылку',
            icon: <Link2 className="w-4 h-4" />,
            shortcut: modLabel('Mod+U'),
            onSelect: () => runLink(true),
          },
          {
            id: 'quote',
            label: 'Цитата',
            icon: <Quote className="w-4 h-4" />,
            shortcut: modLabel('Shift+Mod+I'),
            onSelect: () => runFormat('quote', true),
          },
          { id: 'sep-case', separator: true },
          {
            id: 'upper',
            label: 'Прописные',
            icon: <span className="text-[11px] font-bold">АБВ</span>,
            disabled: !hasSel,
            onSelect: () => runCase('upper'),
          },
          {
            id: 'lower',
            label: 'Строчные',
            icon: <span className="text-[11px] font-bold">абв</span>,
            disabled: !hasSel,
            onSelect: () => runCase('lower'),
          },
          {
            id: 'title',
            label: 'С заглавной буквы',
            icon: <CaseSensitive className="w-4 h-4" />,
            disabled: !hasSel,
            onSelect: () => runCase('title'),
          },
        ],
      },
    ]
  }

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return
      if (e.shiftKey) return
      e.preventDefault()
      if (isSending) return
      submitForm()
      return
    }

    const mod = e.metaKey || e.ctrlKey
    if (!mod) return

    const key = e.key.toLowerCase()

    // Undo / Redo — macOS: ⌘Z / ⇧⌘Z, Windows: Ctrl+Z / Ctrl+Y (и Ctrl+Shift+Z)
    if (key === 'z' && !e.altKey) {
      e.preventDefault()
      if (e.shiftKey) runRedo()
      else runUndo()
      return
    }
    if (key === 'y' && !e.shiftKey && !e.altKey && !isMac) {
      e.preventDefault()
      runRedo()
      return
    }

    if (key === 'b' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      runFormat('bold')
      return
    }
    if (key === 'i' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      runFormat('italic')
      return
    }
    if (key === 'u' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      runLink(false)
      return
    }
    if (key === 'x' && e.shiftKey) {
      e.preventDefault()
      runFormat('strike')
      return
    }
    if (key === 'u' && e.shiftKey) {
      e.preventDefault()
      runFormat('underline')
      return
    }
    if (key === 'p' && e.shiftKey) {
      e.preventDefault()
      runFormat('spoiler')
      return
    }
    if (key === 'k' && e.shiftKey) {
      e.preventDefault()
      runFormat('mono')
      return
    }
    if (key === 'i' && e.shiftKey) {
      e.preventDefault()
      runFormat('quote')
    }
  }

  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list)
    if (!files.length) return
    markDraftDirty()
    setPending((prev) => [...prev, ...toPending(files)])
  }

  const onComposerPaste = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    if (editTarget) return
    const files = filesFromClipboardData(e.clipboardData)
    if (!files.length) return

    // Attach media/files; keep any accompanying plain text in the composer
    e.preventDefault()
    addFiles(files)

    const clipText = e.clipboardData.getData('text/plain')
    if (!clipText) return

    const el = e.currentTarget
    const start = el.selectionStart
    const end = el.selectionEnd
    historyRef.current.noteTyping({
      value: text,
      start: selRef.current.start,
      end: selRef.current.end,
    })
    const next = text.slice(0, start) + clipText + text.slice(end)
    const caret = start + clipText.length
    markDraftDirty()
    setText(next)
    requestAnimationFrame(() => {
      try {
        el.setSelectionRange(caret, caret)
      } catch {
        /* ignore */
      }
      selRef.current = { start: caret, end: caret }
    })
  }

  const removePending = (id: string) => {
    markDraftDirty()
    setPending((prev) => {
      const item = prev.find((p) => p.id === id)
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  const clearPending = () => {
    markDraftDirty()
    setPending((prev) => {
      prev.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      })
      return []
    })
  }

  const sendStickerAsset = async (sticker: StoredSticker) => {
    if (!client || isSending) return
    setIsSending(true)
    setPickerOpen(false)
    try {
      const blob = dataUrlToBlob(sticker.dataUrl)
      await sendStickerOrGif(client, activeRoom, blob, {
        body: sticker.name,
        asSticker: true,
        w: sticker.w,
        h: sticker.h,
        replyToEventId: replyTo?.eventId,
        threadRootId,
      })
      onClearReply?.()
      onSent?.()
    } catch (error) {
      console.error('Failed to send sticker', error)
      pushBreadcrumb('send_fail', {
        roomId: activeRoom.roomId,
        kind: 'sticker',
      })
      reportAppError({
        error,
        source: 'manual',
        context: { roomId: activeRoom.roomId, screen: 'composer' },
      })
      alert(
        error instanceof Error
          ? error.message
          : 'Не удалось отправить стикер.',
      )
    } finally {
      setIsSending(false)
    }
  }

  const sendGifUrl = async (gif: {
    title: string
    url: string
    w?: number
    h?: number
  }) => {
    if (!client || isSending) return
    setIsSending(true)
    setPickerOpen(false)
    try {
      let blob: Blob
      if (gif.url.startsWith('data:')) {
        blob = dataUrlToBlob(gif.url)
      } else {
        const res = await fetch(gif.url)
        if (!res.ok) throw new Error(`GIF HTTP ${res.status}`)
        blob = await res.blob()
      }
      await sendStickerOrGif(client, activeRoom, blob, {
        body: gif.title || 'gif.gif',
        asSticker: false,
        w: gif.w,
        h: gif.h,
        replyToEventId: replyTo?.eventId,
        threadRootId,
      })
      onClearReply?.()
      onSent?.()
    } catch (error) {
      console.error('Failed to send gif', error)
      pushBreadcrumb('send_fail', {
        roomId: activeRoom.roomId,
        kind: 'gif',
      })
      reportAppError({
        error,
        source: 'manual',
        context: { roomId: activeRoom.roomId, screen: 'composer' },
      })
      alert(
        error instanceof Error ? error.message : 'Не удалось отправить GIF.',
      )
    } finally {
      setIsSending(false)
    }
  }

  useEffect(() => {
    const nextId = draftRoomKey
    const prevId = roomIdRef.current

    stopTyping()

    if (prevId && prevId !== nextId && !editTargetRef.current) {
      if (draftDirtyRef.current) {
        saveComposerDraft(prevId, {
          text: textRef.current,
          mentionUserIds: mentionsRef.current,
          files: pendingRef.current.map((p) => p.file),
        })
      } else {
        // Don't wipe a persisted draft just because the composer remounted empty.
        rehydrateComposerDraft(prevId)
      }
    }

    if (prevId !== nextId) {
      draftDirtyRef.current = false
      // Revoke object URLs from the room we're leaving
      setPending((prev) => {
        prev.forEach((p) => {
          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
        })
        return []
      })

      const draft = rehydrateComposerDraft(nextId) ?? loadComposerDraft(nextId)
      const nextText = draft?.text ?? ''
      setText(nextText)
      setMentionUserIds(draft?.mentionUserIds ?? [])
      setPending(draft?.files?.length ? toPending(draft.files) : [])
      setPickerOpen(false)
      historyRef.current.reset({
        value: nextText,
        start: nextText.length,
        end: nextText.length,
      })
      selRef.current = { start: nextText.length, end: nextText.length }

      const focus = () => inputRef.current?.focus()
      const raf = requestAnimationFrame(focus)
      const t = window.setTimeout(focus, 50)
      roomIdRef.current = nextId
      return () => {
        cancelAnimationFrame(raf)
        window.clearTimeout(t)
      }
    }

    roomIdRef.current = nextId
  }, [draftRoomKey, stopTyping])

  // Flush only if the user edited — otherwise restore sidebar draft from LS.
  useEffect(() => {
    return () => {
      const id = roomIdRef.current
      if (id && !editTargetRef.current) {
        if (draftDirtyRef.current) {
          saveComposerDraft(id, {
            text: textRef.current,
            mentionUserIds: mentionsRef.current,
            files: pendingRef.current.map((p) => p.file),
          })
        } else {
          rehydrateComposerDraft(id)
        }
      }
      pendingRef.current.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      })
    }
  }, [])

  // Persist draft while typing (only after a real edit)
  useEffect(() => {
    if (editTarget) return
    if (!draftDirtyRef.current) return
    const roomId = draftRoomKey
    const t = window.setTimeout(() => {
      if (!draftDirtyRef.current) return
      saveComposerDraft(roomId, {
        text: textRef.current,
        mentionUserIds: mentionsRef.current,
        files: pendingRef.current.map((p) => p.file),
      })
    }, 280)
    return () => window.clearTimeout(t)
  }, [text, mentionUserIds, pending, draftRoomKey, editTarget])

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!client || isSending) return

    const caption = text.trim()
    const files = pending.map((p) => p.file)
    const editing = editTargetRef.current
    const replySnapshot = replyTo
    const mentionsSnapshot = [...mentionUserIds]

    // Matrix edit (MSC2676): m.replace → must NOT go through the plain send path
    if (editing?.eventId) {
      if (!caption) return
      stopTyping()
      // Clear immediately — don't wait for network / E2EE
      setText('')
      historyRef.current.reset({ value: '', start: 0, end: 0 })
      selRef.current = { start: 0, end: 0 }
      onClearEdit?.()
      onClearReply?.()
      setIsSending(true)
      requestAnimationFrame(() => focusComposer())
      try {
        if (activeRoom.hasEncryptionStateEvent()) {
          await matrixService.ensureCryptoReady()
          client.getCrypto()?.prepareToEncrypt(activeRoom)
        }

        const msgtype =
          editing.msgtype === MsgType.Emote || editing.msgtype === 'm.emote'
            ? MsgType.Emote
            : MsgType.Text

        const parsed = composerMarkupToMatrix(caption)
        const newContent: Record<string, unknown> = {
          msgtype,
          body: parsed.body || caption,
        }
        if (parsed.hasRich) {
          newContent.format = 'org.matrix.custom.html'
          newContent.formatted_body = parsed.html
        }
        attachMentions(newContent, mentionsSnapshot)
        applyMentionLinksToContent(newContent, mentionsSnapshot, activeRoom)

        const content = {
          msgtype,
          // Fallback for clients that don't understand m.replace
          body: `• ${parsed.body || caption}`,
          'm.new_content': newContent,
          'm.relates_to': {
            rel_type: RelationType.Replace,
            event_id: editing.eventId,
          },
        }

        await client.sendEvent(
          activeRoom.roomId,
          EventType.RoomMessage,
          content as any,
        )
        onSent?.()
      } catch (error) {
        console.error('Failed to edit message', error)
        pushBreadcrumb('send_fail', {
          roomId: activeRoom.roomId,
          kind: 'edit',
        })
        reportAppError({
          error,
          source: 'manual',
          context: { roomId: activeRoom.roomId, screen: 'composer' },
        })
        setText(caption)
        const msg =
          error instanceof Error
            ? error.message
            : 'Не удалось отредактировать сообщение.'
        alert(msg)
      } finally {
        setIsSending(false)
        requestAnimationFrame(() => focusComposer())
      }
      return
    }

    const quoteText = replySnapshot?.quoteText?.trim() || ''
    if (!caption && files.length === 0 && !quoteText) return

    stopTyping()
    draftDirtyRef.current = false
    clearComposerDraft(draftRoomKey)

    // Optimistic clear — text + reply chip + attachments together
    setText('')
    historyRef.current.reset({ value: '', start: 0, end: 0 })
    selRef.current = { start: 0, end: 0 }
    setMentionUserIds([])
    clearPending()
    textRef.current = ''
    mentionsRef.current = []
    pendingRef.current = []
    onClearReply?.()
    setIsSending(true)
    requestAnimationFrame(() => focusComposer())

    try {
      if (activeRoom.hasEncryptionStateEvent()) {
        await matrixService.ensureCryptoReady()
        client.getCrypto()?.prepareToEncrypt(activeRoom)
      }

      if (files.length > 0) {
        const withQuote = buildTextWithOptionalQuote(caption, quoteText || null)
        await sendAlbumMessages(
          client,
          activeRoom,
          files,
          withQuote.body,
          replySnapshot?.eventId,
          withQuote.format && withQuote.formatted_body
            ? {
                format: withQuote.format,
                formatted_body: withQuote.formatted_body,
              }
            : undefined,
          threadRootId,
        )
      } else {
        const built = buildTextWithOptionalQuote(caption, quoteText || null)
        const content: Record<string, unknown> = {
          msgtype: MsgType.Text,
          body: built.body,
        }
        if (built.format && built.formatted_body) {
          content.format = built.format
          content.formatted_body = built.formatted_body
        }
        attachReplyFields(content, replySnapshot, threadRootId)
        attachMentions(content, mentionsSnapshot)
        applyMentionLinksToContent(content, mentionsSnapshot, activeRoom)
        await client.sendEvent(
          activeRoom.roomId,
          EventType.RoomMessage,
          content as any,
        )
      }
      onSent?.()
    } catch (error) {
      console.error('Failed to send message', error)
      pushBreadcrumb('send_fail', {
        roomId: activeRoom.roomId,
        kind: files.length > 0 ? 'media' : 'text',
      })
      reportAppError({
        error,
        source: 'manual',
        context: { roomId: activeRoom.roomId, screen: 'composer' },
      })
      setText(caption)
      setMentionUserIds(mentionsSnapshot)
      if (files.length > 0) {
        setPending((prev) => {
          // Avoid duplicating if something else restored
          if (prev.length) return prev
          return toPending(files)
        })
      }
      const msg =
        error instanceof Error
          ? error.message
          : 'Не удалось отправить сообщение.'
      alert(msg)
    } finally {
      setIsSending(false)
      requestAnimationFrame(() => focusComposer())
    }
  }

  const mediaCount = replyTo?.mediaIds?.length ?? 0
  const replyLabel = replyTo?.quoteText
    ? quoteSnippet(replyTo.quoteText)
    : mediaCount > 1
      ? `${mediaCount} фото`
      : replyTo?.snippet
  const replyBarTitle = replyTo?.quoteText
    ? `Цитата · ${replyTo.senderName}`
    : `В ответ ${replyTo?.senderName ?? ''}`

  const formatVoiceElapsed = (ms: number) => {
    const sec = Math.floor(ms / 1000)
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const canSendText = editTarget
    ? !!text.trim()
    : !!text.trim() ||
      pending.length > 0 ||
      !!replyTo?.quoteText?.trim()
  const showMic =
    !editTarget && !canSendText && !voiceRecording && !isSending

  return (
    <form onSubmit={handleSend} className="tg-composer px-4 py-3">
      {voiceError && (
        <div className="mb-2 text-[12px] text-red-300/90 px-1">{voiceError}</div>
      )}

      <AnimatePresence initial={false}>
        {voiceRecording && (
          <motion.div
            key="voice"
            className="mb-3 flex items-center gap-3 rounded-xl bg-surface-inset border border-hairline px-3 py-2.5"
            {...(prefersReducedMotion()
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                }
              : composerBannerMotion)}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium text-ink">Запись…</div>
              <div className="text-[12px] text-ink-muted tabular-nums">
                {formatVoiceElapsed(voiceElapsedMs)} · отпустите, чтобы отправить
              </div>
            </div>
            <button
              type="button"
              onClick={cancelVoiceRecording}
              className="shrink-0 h-8 px-3 rounded-full text-[12px] text-ink-muted hover:text-ink hover:bg-surface-inset"
            >
              Отмена
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {editTarget && (
          <motion.div
            key="edit"
            className="mb-3 flex items-center gap-2 rounded-xl bg-surface-inset border border-hairline overflow-hidden tg-composer-banner"
            {...(prefersReducedMotion()
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                }
              : composerBannerMotion)}
          >
            <div className="w-1 self-stretch shrink-0 bg-amber-400/80" />
            <div className="flex-1 min-w-0 py-2 pr-1">
              <div className="text-[12px] font-semibold text-amber-500 truncate">
                Редактирование
              </div>
              <div className="text-[12.5px] text-ink-muted truncate">
                {editTarget.body.replace(/\s+/g, ' ').trim() || 'Сообщение'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setText('')
                onClearEdit?.()
              }}
              className="shrink-0 w-8 h-8 mr-2 flex items-center justify-center rounded-full text-ink-faint hover:text-ink hover:bg-surface-inset"
              aria-label="Отменить редактирование"
              title="Отменить"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {!editTarget && replyTo && !threadRootId && (
          <motion.div
            key="reply-banner"
            className="mb-3 flex items-center gap-2 rounded-xl bg-surface-inset border border-hairline overflow-hidden tg-composer-banner"
            {...(prefersReducedMotion()
              ? {
                  initial: { opacity: 0 },
                  animate: { opacity: 1 },
                  exit: { opacity: 0 },
                }
              : composerBannerMotion)}
          >
            <div
              className="w-1 self-stretch shrink-0 rounded-full tg-composer-banner-bar"
              style={{
                background: replyTo.senderId
                  ? getUserColor(replyTo.senderId)
                  : 'var(--accent-hover)',
                transition: prefersReducedMotion()
                  ? undefined
                  : 'background-color 200ms ease',
              }}
            />
            <div className="flex-1 min-w-0 grid overflow-hidden">
              <AnimatePresence initial={false}>
                <motion.div
                  key={`${replyTo.eventId}-${replyTo.quoteText ?? ''}`}
                  className="col-start-1 row-start-1 py-2 pr-1"
                  {...(prefersReducedMotion()
                    ? {
                        initial: { opacity: 0 },
                        animate: { opacity: 1 },
                        exit: { opacity: 0 },
                      }
                    : composerReplySwapMotion)}
                >
                  <div
                    className="text-[12px] font-semibold truncate"
                    style={{
                      color: replyTo.senderId
                        ? getUserColor(replyTo.senderId)
                        : 'var(--accent-hover)',
                      transition: prefersReducedMotion()
                        ? undefined
                        : 'color 200ms ease',
                    }}
                  >
                    {replyBarTitle}
                  </div>
                  <div
                    className={clsx(
                      'text-[12.5px] text-ink-muted truncate',
                      replyTo.quoteText && 'italic',
                    )}
                  >
                    {replyTo.quoteText ? `«${replyLabel}»` : replyLabel}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
            <button
              type="button"
              onClick={() => onClearReply?.()}
              className="shrink-0 w-8 h-8 mr-2 flex items-center justify-center rounded-full text-ink-faint hover:text-ink hover:bg-surface-inset"
              aria-label="Отменить ответ"
              title="Отменить"
            >
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {pending.length > 0 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {pending.map((item) => (
            <div
              key={item.id}
              className="relative shrink-0 w-16 h-16 rounded-xl overflow-hidden bg-black/30 border border-hairline"
            >
              {item.previewUrl ? (
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-ink-muted px-1 text-center leading-tight">
                  {item.file.name}
                </div>
              )}
              <button
                type="button"
                onClick={() => removePending(item.id)}
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black/90"
                aria-label="Убрать файл"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.zip,.txt"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={isSending || !!editTarget}
          className="tg-icon-btn w-10 h-10 flex items-center justify-center rounded-full shrink-0 transition-colors disabled:opacity-40"
          aria-label="Прикрепить файлы"
          title="Прикрепить файлы"
        >
          <Paperclip className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={() => {
            setPollError(null)
            setPollOpen(true)
          }}
          disabled={isSending || !!editTarget}
          className="tg-icon-btn w-10 h-10 flex items-center justify-center rounded-full shrink-0 transition-colors disabled:opacity-40"
          aria-label="Создать опрос"
          title="Опрос"
        >
          <BarChart3 className="w-5 h-5" />
        </button>

        <button
          ref={stickerBtnRef}
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          disabled={isSending}
          className={clsx(
            'w-10 h-10 flex items-center justify-center rounded-full shrink-0 transition-colors disabled:opacity-40',
            pickerOpen ? 'tg-icon-btn--active' : 'tg-icon-btn',
          )}
          aria-label="Смайлы, стикеры и GIF"
          title="Смайлы, стикеры и GIF"
          aria-pressed={pickerOpen}
        >
          <Smile className="w-5 h-5" />
        </button>

        {pickerOpen && (
          <StickerPicker
            open
            onClose={() => setPickerOpen(false)}
            onPickSticker={sendStickerAsset}
            onPickGif={(gif) =>
              sendGifUrl({
                title: gif.title,
                url: gif.url,
                w: gif.w,
                h: gif.h,
              })
            }
            onPickEmoji={insertEmoji}
            emojiOnly={!!editTarget}
            anchorRef={stickerBtnRef}
          />
        )}

        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onSelect={(e) => {
            selRef.current = {
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            }
          }}
          onChange={(e) => {
            markDraftDirty()
            historyRef.current.noteTyping({
              value: text,
              start: selRef.current.start,
              end: selRef.current.end,
            })
            const next = e.target.value
            setText(next)
            // Drop stale mention ids when the user deletes the @token
            if (!next.trim()) {
              setMentionUserIds([])
            }
            selRef.current = {
              start: e.target.selectionStart,
              end: e.target.selectionEnd,
            }
            if (next.trim()) bumpTyping()
            else stopTyping()
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            menuSelRef.current = {
              value: e.currentTarget.value,
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            }
            selRef.current = {
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            }
            setComposerMenu({ x: e.clientX, y: e.clientY })
          }}
          onKeyDown={onComposerKeyDown}
          onPaste={onComposerPaste}
          onBlur={(e) => {
            selRef.current = {
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            }
          }}
          placeholder={
            editTarget
              ? 'Изменить сообщение…'
              : replyTo?.quoteText
                ? 'Добавить комментарий…'
                : replyTo
                  ? 'Написать ответ…'
                  : pending.length > 0
                    ? 'Подпись к альбому…'
                    : 'Написать сообщение...'
          }
          className="tg-composer-input flex-1 rounded-[22px] px-4 py-[10px] text-[14.5px] leading-snug"
        />

        {showMic || voiceRecording ? (
          <button
            type="button"
            disabled={isSending}
            onPointerDown={(e) => {
              if (voiceRecording || voiceFinishLockRef.current || isSending) {
                return
              }
              // Only primary button / touch
              if (e.button != null && e.button !== 0) return
              e.preventDefault()
              voicePointerIdRef.current = e.pointerId
              try {
                ;(e.currentTarget as HTMLButtonElement).setPointerCapture(
                  e.pointerId,
                )
              } catch {
                /* ignore */
              }
              void startVoiceRecording()
            }}
            onPointerUp={(e) => {
              if (
                voicePointerIdRef.current != null &&
                e.pointerId !== voicePointerIdRef.current
              ) {
                return
              }
              e.preventDefault()
              voicePointerIdRef.current = null
              void finishVoiceRecording()
            }}
            onPointerCancel={(e) => {
              if (
                voicePointerIdRef.current != null &&
                e.pointerId !== voicePointerIdRef.current
              ) {
                return
              }
              voicePointerIdRef.current = null
              cancelVoiceRecording()
            }}
            onContextMenu={(e) => e.preventDefault()}
            className={clsx(
              'tg-send-btn w-10 h-10 flex items-center justify-center rounded-full shrink-0 shadow-md shadow-black/30 disabled:opacity-40 select-none',
              voiceRecording && 'ring-2 ring-red-400/70',
            )}
            aria-label={
              voiceRecording
                ? 'Отпустите, чтобы отправить'
                : 'Удерживайте, чтобы записать голосовое'
            }
            title={
              voiceRecording
                ? 'Отпустите, чтобы отправить'
                : 'Удерживайте, чтобы записать голосовое'
            }
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : voiceRecording ? (
              <span className="w-3 h-3 rounded-sm bg-current" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>
        ) : (
          <button
            type="submit"
            disabled={
              isSending ||
              (editTarget
                ? !text.trim()
                : !text.trim() &&
                  pending.length === 0 &&
                  !replyTo?.quoteText?.trim())
            }
            className="tg-send-btn w-10 h-10 flex items-center justify-center rounded-full shrink-0 shadow-md shadow-black/30 disabled:opacity-40"
            aria-label={editTarget ? 'Сохранить' : 'Отправить'}
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-[18px] h-[18px] -mr-0.5"
              >
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            )}
          </button>
        )}
      </div>

      {composerMenu && (
        <AppContextMenu
          x={composerMenu.x}
          y={composerMenu.y}
          items={composerMenuItems()}
          onClose={() => {
            setComposerMenu(null)
            menuSelRef.current = null
          }}
        />
      )}

      <CreatePollDialog
        open={pollOpen}
        busy={pollBusy}
        error={pollError}
        onClose={() => {
          if (pollBusy) return
          setPollOpen(false)
          setPollError(null)
        }}
        onSubmit={(data) => {
          void (async () => {
            if (!client) return
            setPollBusy(true)
            setPollError(null)
            try {
              if (activeRoom.hasEncryptionStateEvent()) {
                await matrixService.ensureCryptoReady()
                client.getCrypto()?.prepareToEncrypt(activeRoom)
              }
              await client.sendEvent(
                activeRoom.roomId,
                'org.matrix.msc3381.poll.start' as any,
                (() => {
                  const content = buildPollStartContent(data) as Record<
                    string,
                    unknown
                  >
                  if (threadRootId) {
                    Object.assign(
                      content,
                      buildThreadRelation(
                        threadRootId,
                        replyTo?.eventId || threadRootId,
                      ),
                    )
                  }
                  return content
                })() as any,
              )
              setPollOpen(false)
              onSent?.()
            } catch (err) {
              console.error('Failed to create poll', err)
              setPollError(
                err instanceof Error ? err.message : 'Не удалось создать опрос',
              )
            } finally {
              setPollBusy(false)
            }
          })()
        }}
      />
    </form>
  )
}

/** Build a short preview for the reply composer / chip */
export function messageSnippet(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return 'Зашифрованное сообщение'
  const poll = pollNotificationSnippet(event)
  if (poll) return poll
  const content = event.getContent() as Record<string, unknown>
  const msgtype = content.msgtype as string | undefined
  switch (msgtype) {
    case 'm.image':
      return '🖼 Фото'
    case 'm.sticker':
      return '🎟 Стикер'
    case 'm.audio':
      return '🎤 Голосовое'
    case 'm.video':
      return '🎬 Видео'
    case 'm.file':
      return `📄 ${(content.body as string) || 'Файл'}`
    default:
      break
  }
  if (event.getType() === 'm.sticker') return '🎟 Стикер'
  let body = typeof content.body === 'string' ? content.body : ''
  if (body.startsWith('>')) {
    const split = body.split(/\n\n/)
    if (split.length > 1) body = split.slice(1).join('\n\n')
  }
  body = body.replace(/\s+/g, ' ').trim()
  if (!body) return 'Сообщение'
  return body.length > 140 ? `${body.slice(0, 140)}…` : body
}
