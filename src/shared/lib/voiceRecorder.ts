/** Pick best MediaRecorder mime for voice notes. */
export function pickVoiceMimeType(): string {
  const candidates = [
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t
  }
  return ''
}

export function voiceExtensionForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  return 'webm'
}

export type VoiceRecordingResult = {
  blob: Blob
  mimeType: string
  durationMs: number
  fileName: string
}

export const MIN_VOICE_MS = 450

async function measureBlobDurationMs(blob: Blob): Promise<number | null> {
  const url = URL.createObjectURL(blob)
  try {
    return await new Promise<number | null>((resolve) => {
      const audio = new Audio()
      audio.preload = 'metadata'
      const done = (value: number | null) => {
        audio.onloadedmetadata = null
        audio.onerror = null
        resolve(value)
      }
      audio.onloadedmetadata = () => {
        const d = audio.duration
        done(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null)
      }
      audio.onerror = () => done(null)
      audio.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Hold-to-record voice note via MediaRecorder.
 * Call start(); later call stop() to finalize, or cancel() to discard.
 */
export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private startedAt = 0
  private mimeType = ''
  private ready = false
  private stopPromise: Promise<VoiceRecordingResult> | null = null
  private stopResolve: ((r: VoiceRecordingResult) => void) | null = null
  private stopReject: ((e: Error) => void) | null = null

  get recording(): boolean {
    return this.ready && this.recorder?.state === 'recording'
  }

  get elapsedMs(): number {
    if (!this.startedAt) return 0
    return Date.now() - this.startedAt
  }

  async start(): Promise<void> {
    if (this.recorder) {
      throw new Error('Recording already in progress')
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Запись голоса не поддерживается в этой среде')
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      throw new Error(
        'Нет доступа к микрофону. Разрешите запись в настройках системы.',
      )
    }

    const mimeType = pickVoiceMimeType()
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)

    this.stream = stream
    this.recorder = recorder
    this.chunks = []
    this.mimeType = recorder.mimeType || mimeType || 'audio/webm'
    this.ready = false

    this.stopPromise = new Promise<VoiceRecordingResult>((resolve, reject) => {
      this.stopResolve = resolve
      this.stopReject = reject
    })

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    recorder.onerror = () => {
      this.cleanupTracks()
      this.stopReject?.(new Error('Ошибка записи голоса'))
      this.resetHandles()
    }
    recorder.onstop = () => {
      void this.finalizeStop()
    }

    this.startedAt = Date.now()
    recorder.start(100)
    this.ready = true
  }

  private async finalizeStop() {
    const wallMs = Math.max(0, Date.now() - this.startedAt)
    const blob = new Blob(this.chunks, { type: this.mimeType })
    this.cleanupTracks()
    if (blob.size < 64) {
      this.stopReject?.(new Error('Слишком короткое голосовое'))
      this.resetHandles()
      return
    }

    const measured = await measureBlobDurationMs(blob)
    const durationMs = Math.max(measured ?? 0, wallMs, MIN_VOICE_MS)
    const ext = voiceExtensionForMime(this.mimeType)
    this.stopResolve?.({
      blob,
      mimeType: this.mimeType,
      durationMs,
      fileName: `voice-${Date.now()}.${ext}`,
    })
    this.resetHandles()
  }

  stop(): Promise<VoiceRecordingResult> {
    if (!this.recorder || !this.stopPromise) {
      return Promise.reject(new Error('Запись не начата'))
    }
    if (this.recorder.state === 'recording') {
      try {
        this.recorder.requestData?.()
      } catch {
        /* ignore */
      }
      this.recorder.stop()
    }
    return this.stopPromise
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.onstop = null
        this.recorder.stop()
      } catch {
        /* ignore */
      }
    }
    this.cleanupTracks()
    this.stopReject?.(new Error('cancelled'))
    this.resetHandles()
  }

  private cleanupTracks() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
    this.chunks = []
    this.ready = false
  }

  private resetHandles() {
    this.stopPromise = null
    this.stopResolve = null
    this.stopReject = null
  }
}
