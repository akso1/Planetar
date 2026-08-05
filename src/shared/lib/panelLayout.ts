import { create } from 'zustand'

export const CHAT_LIST_WIDTH_KEY = 'planetar-chatlist-width'
export const CHAT_LIST_WIDTH_DEFAULT = 300
export const CHAT_LIST_WIDTH_MIN = 220
export const CHAT_LIST_WIDTH_MAX = 560

export function clampChatListWidth(px: number): number {
  if (!Number.isFinite(px)) return CHAT_LIST_WIDTH_DEFAULT
  return Math.round(
    Math.min(CHAT_LIST_WIDTH_MAX, Math.max(CHAT_LIST_WIDTH_MIN, px)),
  )
}

export function readStoredChatListWidth(): number {
  try {
    const raw = localStorage.getItem(CHAT_LIST_WIDTH_KEY)
    if (!raw) return CHAT_LIST_WIDTH_DEFAULT
    return clampChatListWidth(Number(raw))
  } catch {
    return CHAT_LIST_WIDTH_DEFAULT
  }
}

function persistChatListWidth(px: number) {
  try {
    localStorage.setItem(CHAT_LIST_WIDTH_KEY, String(px))
  } catch {
    /* ignore */
  }
}

type PanelLayoutState = {
  chatListWidth: number
  setChatListWidth: (px: number, opts?: { persist?: boolean }) => void
  resetChatListWidth: () => void
}

export const usePanelLayoutStore = create<PanelLayoutState>((set) => ({
  chatListWidth: readStoredChatListWidth(),

  setChatListWidth: (px, opts) => {
    const next = clampChatListWidth(px)
    set({ chatListWidth: next })
    if (opts?.persist !== false) persistChatListWidth(next)
  },

  resetChatListWidth: () => {
    set({ chatListWidth: CHAT_LIST_WIDTH_DEFAULT })
    persistChatListWidth(CHAT_LIST_WIDTH_DEFAULT)
  },
}))
