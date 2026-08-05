/** Helpers for in-app file preview (modal) — not timeline layout. */

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'yml',
  'yaml',
  'toml',
  'ini',
  'env',
  'svg',
  'sh',
  'bash',
  'zsh',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'sql',
  'conf',
  'cfg',
])

const TEXT_MIME_PREFIXES = ['text/']
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'image/svg+xml',
])

export type FilePreviewKind = 'text' | 'pdf' | 'image' | 'unsupported'

export function fileExt(name: string): string {
  const base = name.split(/[/\\]/).pop() || name
  const i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i + 1).toLowerCase()
}

export function detectFilePreviewKind(
  mime: string | undefined,
  fileName: string,
): FilePreviewKind {
  const m = (mime || '').toLowerCase().split(';')[0].trim()
  const ext = fileExt(fileName)

  if (m === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (m.startsWith('image/') && m !== 'image/svg+xml') return 'image'
  if (
    TEXT_MIME_PREFIXES.some((p) => m.startsWith(p)) ||
    TEXT_MIME_EXACT.has(m) ||
    TEXT_EXTS.has(ext)
  ) {
    return 'text'
  }
  return 'unsupported'
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Soft cap for in-modal text decode (avoid freezing on huge dumps). */
export const FILE_PREVIEW_TEXT_MAX_BYTES = 1_500_000
