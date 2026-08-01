import { create } from 'zustand'
import type { VerificationRequest } from 'matrix-js-sdk/lib/crypto-api'

type VerificationUiState = {
  /** Active request shown in the modal (incoming or after outgoing started) */
  request: VerificationRequest | null
  /** Kick off requestOwnUserVerification when modal opens */
  pendingOutgoing: boolean
  /** Bumped when SAS verification completes successfully */
  verifiedTick: number
  openOutgoing: () => void
  openIncoming: (request: VerificationRequest) => void
  setRequest: (request: VerificationRequest | null) => void
  markVerified: () => void
  close: () => void
}

export const useVerificationUiStore = create<VerificationUiState>((set) => ({
  request: null,
  pendingOutgoing: false,
  verifiedTick: 0,
  openOutgoing: () => set({ pendingOutgoing: true, request: null }),
  openIncoming: (request) => set({ request, pendingOutgoing: false }),
  setRequest: (request) => set({ request, pendingOutgoing: false }),
  markVerified: () => set((s) => ({ verifiedTick: s.verifiedTick + 1 })),
  close: () => set({ request: null, pendingOutgoing: false }),
}))
