import { create } from 'zustand'
import { getBreadcrumbs, pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import { THEME_STORAGE_KEY } from '@/shared/lib/theme'

const STORAGE_KEY = 'matrix-app-error-log'
const EMAIL_KEY = 'matrix-app-error-report-email'
const MAX_ENTRIES = 80

export type AppErrorSource =
  | 'react'
  | 'window'
  | 'promise'
  | 'main'
  | 'manual'
  | 'unknown'

export type AppErrorContext = {
  roomId?: string | null
  screen?: string | null
  extra?: Record<string, string | number | boolean | null | undefined>
}

export type AppErrorEntry = {
  id: string
  ts: number
  lastSeen: number
  count: number
  fingerprint: string
  /** Short human-readable title */
  title: string
  /** What the user should understand */
  summary: string
  /** Technical detail for developers */
  detail: string
  source: AppErrorSource
  stack?: string
  context?: AppErrorContext
}

export type ReportInput = {
  error?: unknown
  title?: string
  summary?: string
  detail?: string
  source?: AppErrorSource
  stack?: string
  context?: AppErrorContext
}

type ErrorLogState = {
  entries: AppErrorEntry[]
  hydrated: boolean
  hydrate: () => void
  report: (input: ReportInput) => void
  clear: () => void
  remove: (id: string) => void
}

function loadEntries(): AppErrorEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as AppErrorEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, MAX_ENTRIES).map(normalizeEntry)
  } catch {
    return []
  }
}

function normalizeEntry(raw: Partial<AppErrorEntry> & { ts?: number }): AppErrorEntry {
  const ts = typeof raw.ts === 'number' ? raw.ts : Date.now()
  const title = raw.title || 'Ошибка'
  const detail = raw.detail || ''
  const source = (raw.source || 'unknown') as AppErrorSource
  const fingerprint =
    raw.fingerprint || makeFingerprint(title, detail, source)
  return {
    id: raw.id || `${ts}_${Math.random().toString(36).slice(2, 8)}`,
    ts,
    lastSeen: typeof raw.lastSeen === 'number' ? raw.lastSeen : ts,
    count: typeof raw.count === 'number' && raw.count > 0 ? raw.count : 1,
    fingerprint,
    title,
    summary: raw.summary || '',
    detail,
    source,
    stack: raw.stack,
    context: raw.context,
  }
}

function saveEntries(entries: AppErrorEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    /* quota / private mode */
  }
}

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function errStack(error: unknown): string | undefined {
  if (error instanceof Error && error.stack) return error.stack
  return undefined
}

/** Simple non-crypto fingerprint for dedupe. */
export function makeFingerprint(
  title: string,
  detail: string,
  source: AppErrorSource,
): string {
  const raw = `${source}|${title}|${detail}`.slice(0, 400)
  let h = 2166136261
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function newReportId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Map technical failures to plain Russian titles/summaries. */
export function humanizeError(
  error: unknown,
  source: AppErrorSource = 'unknown',
): { title: string; summary: string; detail: string } {
  const detail = errMessage(error)
  const lower = detail.toLowerCase()

  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('net::') ||
    lower.includes('network request failed') ||
    lower.includes('err_connection') ||
    lower.includes('err_timed_out')
  ) {
    return {
      title: 'Проблема с сетью',
      summary:
        'Не удалось связаться с сервером. Проверьте интернет и адрес homeserver.',
      detail,
    }
  }
  if (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('m.limit') ||
    lower.includes('too many requests')
  ) {
    return {
      title: 'Слишком много запросов',
      summary: 'Сервер ограничил частоту запросов. Подождите немного и повторите.',
      detail,
    }
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return {
      title: 'Сессия устарела',
      summary: 'Сервер не принял вход. Попробуйте выйти и войти снова.',
      detail,
    }
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return {
      title: 'Недостаточно прав',
      summary: 'Действие запрещено сервером или настройками комнаты.',
      detail,
    }
  }
  if (lower.includes('404') || lower.includes('not found')) {
    return {
      title: 'Не найдено',
      summary: 'Запрошенный ресурс или ключ на сервере отсутствует.',
      detail,
    }
  }
  if (
    lower.includes('m.missing_token') ||
    lower.includes('unknown token') ||
    lower.includes('invalid token')
  ) {
    return {
      title: 'Токен доступа недействителен',
      summary: 'Сессия на сервере сброшена. Нужно войти заново.',
      detail,
    }
  }
  if (
    lower.includes('decrypt') ||
    lower.includes('megolm') ||
    lower.includes('olm') ||
    lower.includes('room_keys') ||
    lower.includes('unable to decrypt')
  ) {
    return {
      title: 'Не удалось расшифровать',
      summary:
        'Не хватает ключей шифрования. Попробуйте «Import history keys» в настройках.',
      detail,
    }
  }
  if (
    lower.includes('crypto not') ||
    lower.includes('crypto is not') ||
    lower.includes('ensurecryptoready') ||
    lower.includes('no crypto')
  ) {
    return {
      title: 'Шифрование ещё не готово',
      summary:
        'Криптомодуль не успел инициализироваться. Подождите или перезапустите приложение.',
      detail,
    }
  }
  if (
    lower.includes('sync') &&
    (lower.includes('fail') ||
      lower.includes('error') ||
      lower.includes('abort') ||
      lower.includes('timeout'))
  ) {
    return {
      title: 'Сбой синхронизации',
      summary:
        'Клиент не смог синхронизировать события с homeserver. Проверьте сеть.',
      detail,
    }
  }
  if (lower.includes('quota') || lower.includes('storage') || lower.includes('idb')) {
    return {
      title: 'Мало места в хранилище',
      summary: 'Браузер/приложение не смогло сохранить данные локально.',
      detail,
    }
  }
  if (source === 'react') {
    return {
      title: 'Сбой интерфейса',
      summary:
        'Часть экрана упала из‑за ошибки в интерфейсе. Приложение продолжит работу после восстановления.',
      detail,
    }
  }
  if (source === 'main') {
    return {
      title: 'Сбой фонового процесса',
      summary:
        'Ошибка в системной части Electron. Обычно окно можно просто перезапустить.',
      detail,
    }
  }
  if (source === 'promise') {
    return {
      title: 'Фоновая операция не выполнилась',
      summary:
        'Асинхронная задача завершилась с ошибкой. Чаты при этом могут работать.',
      detail,
    }
  }

  return {
    title: 'Непредвиденная ошибка',
    summary:
      'Произошёл сбой. Подробности ниже — их можно отправить разработчику.',
    detail,
  }
}

export const useErrorLogStore = create<ErrorLogState>((set, get) => ({
  entries: [],
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return
    set({ entries: loadEntries(), hydrated: true })
  },

  report: (input) => {
    const source = input.source ?? 'unknown'
    const human =
      input.title && input.summary
        ? {
            title: input.title,
            summary: input.summary,
            detail: input.detail || errMessage(input.error),
          }
        : humanizeError(input.error ?? input.detail ?? 'Unknown error', source)

    const title = input.title || human.title
    const summary = input.summary || human.summary
    const detail = input.detail || human.detail
    const stack = input.stack || errStack(input.error)
    const fingerprint = makeFingerprint(title, detail, source)
    const now = Date.now()

    const existing = get().entries
    const idx = existing.findIndex((e) => e.fingerprint === fingerprint)
    let next: AppErrorEntry[]

    if (idx >= 0) {
      const prev = existing[idx]
      const updated: AppErrorEntry = {
        ...prev,
        lastSeen: now,
        count: (prev.count || 1) + 1,
        stack: stack || prev.stack,
        context: input.context || prev.context,
        summary,
      }
      next = [updated, ...existing.filter((_, i) => i !== idx)].slice(
        0,
        MAX_ENTRIES,
      )
    } else {
      const entry: AppErrorEntry = {
        id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
        ts: now,
        lastSeen: now,
        count: 1,
        fingerprint,
        title,
        summary,
        detail,
        source,
        stack,
        context: input.context,
      }
      next = [entry, ...existing].slice(0, MAX_ENTRIES)
    }

    saveEntries(next)
    set({ entries: next, hydrated: true })
  },

  clear: () => {
    saveEntries([])
    set({ entries: [] })
  },

  remove: (id) => {
    const next = get().entries.filter((e) => e.id !== id)
    saveEntries(next)
    set({ entries: next })
  },
}))

/** Imperative helper for non-React code. */
export function reportAppError(input: ReportInput): void {
  useErrorLogStore.getState().hydrate()
  useErrorLogStore.getState().report(input)
}

export function readSavedReportEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) || ''
  } catch {
    return ''
  }
}

export function saveReportEmail(email: string): void {
  try {
    localStorage.setItem(EMAIL_KEY, email.trim())
  } catch {
    /* ignore */
  }
}

function sourceLabel(source: AppErrorSource): string {
  switch (source) {
    case 'react':
      return 'Интерфейс (React)'
    case 'window':
      return 'Окно приложения'
    case 'promise':
      return 'Фоновая задача'
    case 'main':
      return 'Системный процесс'
    case 'manual':
      return 'Вручную'
    default:
      return 'Неизвестно'
  }
}

function formatWhen(ts: number): string {
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    })
  } catch {
    return String(ts)
  }
}

function readTheme(): string {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || 'dark'
  } catch {
    return 'dark'
  }
}

function appVersion(): string {
  return (
    (typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { VITE_APP_VERSION?: string } }).env
        ?.VITE_APP_VERSION) ||
    'dev'
  )
}

export type DiagnosticReport = {
  reportId: string
  createdAt: number
  app: {
    version: string
    userAgent: string
    theme: string
    locale: string
    platform: string
  }
  session: {
    userId?: string | null
    deviceId?: string | null
    homeserver?: string | null
    activeRoomId?: string | null
  }
  comment: string
  errors: AppErrorEntry[]
  breadcrumbs: ReturnType<typeof getBreadcrumbs>
}

export function buildDiagnosticReport(opts: {
  entries: AppErrorEntry[]
  comment: string
  userId?: string | null
  deviceId?: string | null
  homeserver?: string | null
  activeRoomId?: string | null
}): DiagnosticReport {
  return {
    reportId: newReportId(),
    createdAt: Date.now(),
    app: {
      version: appVersion(),
      userAgent:
        typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      theme: readTheme(),
      locale: typeof navigator !== 'undefined' ? navigator.language : 'unknown',
      platform:
        typeof navigator !== 'undefined' ? navigator.platform || 'unknown' : 'unknown',
    },
    session: {
      userId: opts.userId ?? null,
      deviceId: opts.deviceId ?? null,
      homeserver: opts.homeserver ?? null,
      activeRoomId: opts.activeRoomId ?? null,
    },
    comment: opts.comment.trim(),
    errors: opts.entries,
    breadcrumbs: getBreadcrumbs(),
  }
}

/** Full human-readable report (for clipboard / .txt file). */
export function formatDiagnosticReportText(report: DiagnosticReport): string {
  const lines: string[] = []
  lines.push('══════════════════════════════════════')
  lines.push('  ОТЧЁТ ОБ ОШИБКАХ — Matrix macOS Client')
  lines.push('══════════════════════════════════════')
  lines.push('')
  lines.push(`Report ID: ${report.reportId}`)
  lines.push(`Дата: ${formatWhen(report.createdAt)}`)
  lines.push('')
  lines.push('— Приложение —')
  lines.push(`Версия: ${report.app.version}`)
  lines.push(`Тема: ${report.app.theme}`)
  lines.push(`Locale: ${report.app.locale}`)
  lines.push(`Platform: ${report.app.platform}`)
  lines.push(`User-Agent: ${report.app.userAgent}`)
  lines.push('')
  lines.push('— Сессия —')
  lines.push(`Пользователь: ${report.session.userId || '(нет)'}`)
  lines.push(`Устройство: ${report.session.deviceId || '(нет)'}`)
  lines.push(`Homeserver: ${report.session.homeserver || '(нет)'}`)
  lines.push(`Активная комната: ${report.session.activeRoomId || '(нет)'}`)
  lines.push('')
  lines.push('— Комментарий пользователя —')
  lines.push(report.comment || '(не указан)')
  lines.push('')

  if (report.breadcrumbs.length) {
    lines.push('— Последние действия (без текста сообщений) —')
    for (const b of report.breadcrumbs) {
      const data =
        b.data && Object.keys(b.data).length
          ? ` ${JSON.stringify(b.data)}`
          : ''
      lines.push(`  ${formatWhen(b.ts)}  ${b.type}${data}`)
    }
    lines.push('')
  }

  if (report.errors.length === 0) {
    lines.push('— Ошибки —')
    lines.push('(журнал пуст)')
  } else {
    lines.push(`— Ошибки (${report.errors.length}) —`)
    lines.push('')
    report.errors.forEach((e, i) => {
      lines.push(`──────── ${i + 1}. ${e.title} ────────`)
      lines.push(`Fingerprint: ${e.fingerprint}`)
      lines.push(`Count: ${e.count}`)
      lines.push(`Впервые: ${formatWhen(e.ts)}`)
      lines.push(`Последний раз: ${formatWhen(e.lastSeen)}`)
      lines.push(`Источник: ${sourceLabel(e.source)}`)
      lines.push(`Суть: ${e.summary}`)
      lines.push(`Детали: ${e.detail}`)
      if (e.context?.roomId) lines.push(`roomId: ${e.context.roomId}`)
      if (e.context?.screen) lines.push(`screen: ${e.context.screen}`)
      if (e.context?.extra) {
        lines.push(`extra: ${JSON.stringify(e.context.extra)}`)
      }
      if (e.stack) {
        lines.push('Стек:')
        lines.push(e.stack)
      }
      lines.push('')
    })
  }

  lines.push('══════════════════════════════════════')
  lines.push('— JSON (для машинного разбора) —')
  lines.push(JSON.stringify(report, null, 2))
  lines.push('')
  lines.push('Конец отчёта')

  return lines.join('\n')
}

/** @deprecated Use buildDiagnosticReport + formatDiagnosticReportText */
export function buildErrorEmailReport(opts: {
  entries: AppErrorEntry[]
  comment: string
  userId?: string | null
  deviceId?: string | null
  homeserver?: string | null
  activeRoomId?: string | null
}): { subject: string; body: string; report: DiagnosticReport } {
  const report = buildDiagnosticReport(opts)
  return {
    subject: `[Planetar] report ${report.reportId}`,
    body: formatDiagnosticReportText(report),
    report,
  }
}

/** Short mailto body — full report should be attached / pasted from clipboard. */
export function buildShortMailtoReport(opts: {
  report: DiagnosticReport
  fileHint?: string
}): { subject: string; body: string } {
  const { report, fileHint } = opts
  const top = report.errors.slice(0, 3)
  const lines: string[] = []
  lines.push(`Report ID: ${report.reportId}`)
  lines.push(`Ошибок в журнале: ${report.errors.length}`)
  lines.push(`Версия: ${report.app.version}`)
  lines.push(`Тема UI: ${report.app.theme}`)
  if (report.session.userId) lines.push(`User: ${report.session.userId}`)
  if (report.session.homeserver)
    lines.push(`HS: ${report.session.homeserver}`)
  lines.push('')
  lines.push('Комментарий:')
  lines.push(report.comment || '(не указан)')
  lines.push('')
  if (top.length) {
    lines.push('Последние ошибки:')
    top.forEach((e, i) => {
      lines.push(
        `${i + 1}. [${e.count}×] ${e.title} — ${e.detail.slice(0, 120)}`,
      )
    })
    lines.push('')
  }
  lines.push(
    'Полный отчёт слишком большой для mailto. Он скопирован в буфер обмена.',
  )
  lines.push(
    fileHint ||
      'Пожалуйста, приложите скачанный файл отчёта (.txt) к этому письму.',
  )
  return {
    subject: `[Planetar] report ${report.reportId}`,
    body: lines.join('\n'),
  }
}

const MAILTO_BODY_LIMIT = 1600

export function buildMailtoUrl(
  to: string,
  subject: string,
  body: string,
): string {
  let mailBody = body
  if (mailBody.length > MAILTO_BODY_LIMIT) {
    mailBody =
      mailBody.slice(0, MAILTO_BODY_LIMIT) +
      '\n\n…\n[Текст обрезан. Вставьте полный отчёт из буфера (Cmd+V) или приложите файл.]'
  }
  return `mailto:${to.trim()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}`
}

export async function downloadTextFile(
  filename: string,
  content: string,
): Promise<{ ok: boolean; path?: string; method: 'electron' | 'browser' }> {
  const api = window.electronAPI
  if (api?.saveTextFile) {
    const result = await api.saveTextFile({
      defaultPath: filename,
      content,
    })
    return {
      ok: !!result?.ok,
      path: result?.path,
      method: 'electron',
    }
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return { ok: true, method: 'browser' }
}

let installed = false

/** Install global window / promise / main-IPC handlers once (call as early as possible). */
export function installRendererErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  try {
    useErrorLogStore.getState().hydrate()
  } catch {
    /* localStorage may be unavailable in exotic contexts */
  }
  pushBreadcrumb('error_reporting_ready')

  const safeReport = (input: ReportInput) => {
    try {
      reportAppError(input)
    } catch (err) {
      console.error('[errorLog] reportAppError failed', err)
    }
  }

  window.addEventListener('error', (event) => {
    safeReport({
      error: event.error ?? event.message,
      source: 'window',
      stack:
        event.error instanceof Error
          ? event.error.stack
          : [event.filename, event.lineno, event.colno].filter(Boolean).join(':'),
      context: {
        screen: 'window_error',
        extra: {
          filename: event.filename || undefined,
          lineno: event.lineno,
          colno: event.colno,
        },
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    safeReport({
      error: event.reason,
      source: 'promise',
      context: { screen: 'unhandled_rejection' },
    })
  })

  // Main-process crashes forwarded over preload IPC → same Settings → Errors store
  try {
    window.electronAPI?.onMainError?.((payload) => {
      safeReport({
        title: payload.title,
        summary: payload.summary,
        detail: payload.detail,
        stack: payload.stack,
        source: 'main',
        context: { screen: 'electron_main' },
      })
    })
  } catch (err) {
    console.error('[errorLog] onMainError subscribe failed', err)
  }
}
