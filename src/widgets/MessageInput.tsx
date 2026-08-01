import React, { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Bold,
  CaseSensitive,
  Code2,
  Copy,
  ClipboardPaste,
  Italic,
  Link2,
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
} from '@/shared/lib/sendMedia'
import { dataUrlToBlob, type StoredSticker } from '@/shared/lib/stickersStore'
import { buildTextWithOptionalQuote, quoteSnippet } from '@/shared/lib/messageQuote'
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from '@/shared/lib/composerDrafts'
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
import { AppContextMenu, type AppContextMenuItem } from '@/shared/ui/AppContextMenu'
import { StickerPicker } from './StickerPicker'

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
) {
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
}: MessageInputProps) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingItem[]>([])
  const [mentionUserIds, setMentionUserIds] = useState<string[]>([])
  const [isSending, setIsSending] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [composerMenu, setComposerMenu] = useState<{
    x: number
    y: number
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickerBtnRef = useRef<HTMLButtonElement>(null)
  /** Keep selection across context-menu focus loss */
  const menuSelRef = useRef<ComposerSelection | null>(null)
  const selRef = useRef({ start: 0, end: 0 })
  const historyRef = useRef(createComposerHistory())
  const editTargetRef = useRef(editTarget)
  editTargetRef.current = editTarget
  const roomIdRef = useRef<string | null>(null)
  const textRef = useRef(text)
  const pendingRef = useRef(pending)
  const mentionsRef = useRef(mentionUserIds)
  textRef.current = text
  pendingRef.current = pending
  mentionsRef.current = mentionUserIds
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
    }
  }, [stopTyping])

  useEffect(() => {
    if (!externalFiles?.length) return
    setPending((prev) => [...prev, ...toPending(externalFiles)])
    onExternalFilesConsumed?.()
  }, [externalFiles, onExternalFilesConsumed])

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
      inputRef.current?.focus()
      return
    }
  }, [editTarget?.eventId])

  useEffect(() => {
    if (replyTo && !editTarget) inputRef.current?.focus()
  }, [
    replyTo?.eventId,
    replyTo?.mediaIds?.join(','),
    replyTo?.quoteText,
    editTarget,
  ])

  useEffect(() => {
    if (!pendingMention) return
    const token = `@${pendingMention.displayName} `
    setText((prev) => {
      const needsSpace = prev.length > 0 && !/\s$/.test(prev)
      return `${prev}${needsSpace ? ' ' : ''}${token}`
    })
    setMentionUserIds((prev) =>
      prev.includes(pendingMention.userId)
        ? prev
        : [...prev, pendingMention.userId],
    )
    onMentionConsumed?.()
    // After profile modal closes / unmounts, focus composer at end
    const focusEnd = () => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      try {
        el.setSelectionRange(end, end)
      } catch {
        /* ignore */
      }
    }
    requestAnimationFrame(() => {
      focusEnd()
      window.setTimeout(focusEnd, 80)
    })
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
    setPending((prev) => {
      const item = prev.find((p) => p.id === id)
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
      return prev.filter((p) => p.id !== id)
    })
  }

  const clearPending = () => {
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
      })
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
      })
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
    const nextId = activeRoom.roomId
    const prevId = roomIdRef.current

    stopTyping()

    if (prevId && prevId !== nextId && !editTargetRef.current) {
      saveComposerDraft(prevId, {
        text: textRef.current,
        mentionUserIds: mentionsRef.current,
        files: pendingRef.current.map((p) => p.file),
      })
    }

    if (prevId !== nextId) {
      // Revoke object URLs from the room we're leaving
      setPending((prev) => {
        prev.forEach((p) => {
          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
        })
        return []
      })

      const draft = loadComposerDraft(nextId)
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
  }, [activeRoom.roomId, stopTyping])

  // Persist draft while typing (text survives refresh; files are session-only)
  useEffect(() => {
    if (editTarget) return
    const roomId = activeRoom.roomId
    const t = window.setTimeout(() => {
      saveComposerDraft(roomId, {
        text: textRef.current,
        mentionUserIds: mentionsRef.current,
        files: pendingRef.current.map((p) => p.file),
      })
    }, 280)
    return () => window.clearTimeout(t)
  }, [text, mentionUserIds, pending, activeRoom.roomId, editTarget])

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
    clearComposerDraft(activeRoom.roomId)

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
        attachReplyFields(content, replySnapshot)
        attachMentions(content, mentionsSnapshot)
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

  return (
    <form onSubmit={handleSend} className="tg-composer px-4 py-3">
      {editTarget && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-black/25 border border-white/8 overflow-hidden">
          <div className="w-1 self-stretch shrink-0 bg-amber-400/80" />
          <div className="flex-1 min-w-0 py-2 pr-1">
            <div className="text-[12px] font-semibold text-amber-300/90 truncate">
              Редактирование
            </div>
            <div className="text-[12.5px] text-white/55 truncate">
              {editTarget.body.replace(/\s+/g, ' ').trim() || 'Сообщение'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setText('')
              onClearEdit?.()
            }}
            className="shrink-0 w-8 h-8 mr-2 flex items-center justify-center rounded-full text-white/45 hover:text-white hover:bg-white/10"
            aria-label="Отменить редактирование"
            title="Отменить"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!editTarget && replyTo && (
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-black/25 border border-white/8 overflow-hidden">
          <div
            className="w-1 self-stretch shrink-0"
            style={{
              background: replyTo.senderId
                ? getUserColor(replyTo.senderId)
                : 'var(--accent-hover)',
            }}
          />
          <div className="flex-1 min-w-0 py-2 pr-1">
            <div
              className="text-[12px] font-semibold truncate"
              style={{
                color: replyTo.senderId
                  ? getUserColor(replyTo.senderId)
                  : 'var(--accent-hover)',
              }}
            >
              {replyBarTitle}
            </div>
            <div
              className={clsx(
                'text-[12.5px] text-white/55 truncate',
                replyTo.quoteText && 'italic',
              )}
            >
              {replyTo.quoteText ? `«${replyLabel}»` : replyLabel}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onClearReply?.()}
            className="shrink-0 w-8 h-8 mr-2 flex items-center justify-center rounded-full text-white/45 hover:text-white hover:bg-white/10"
            aria-label="Отменить ответ"
            title="Отменить"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {pending.map((item) => (
            <div
              key={item.id}
              className="relative shrink-0 w-16 h-16 rounded-xl overflow-hidden bg-black/30 border border-white/10"
            >
              {item.previewUrl ? (
                <img
                  src={item.previewUrl}
                  alt={item.file.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] text-white/50 px-1 text-center leading-tight">
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
            historyRef.current.noteTyping({
              value: text,
              start: selRef.current.start,
              end: selRef.current.end,
            })
            const next = e.target.value
            setText(next)
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
    </form>
  )
}

/** Build a short preview for the reply composer / chip */
export function messageSnippet(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) return 'Зашифрованное сообщение'
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
