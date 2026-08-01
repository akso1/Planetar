import { composerMarkupToMatrix } from '@/shared/lib/composerFormat'
import { escapeHtml } from '@/shared/lib/escapeHtml'

export { escapeHtml }

/** Max characters of selected text to quote (keeps events reasonable). */
export const MAX_QUOTE_CHARS = 2000

/** Normalize selection text for quoting. */
export function normalizeQuoteText(raw: string): string {
  let text = raw.replace(/\u00a0/g, ' ')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > MAX_QUOTE_CHARS) {
    text = `${text.slice(0, MAX_QUOTE_CHARS).trimEnd()}…`
  }
  return text
}

/**
 * Selected text inside a single message bubble (for quote-reply).
 * Returns '' if selection is empty, collapsed, or spans outside one message.
 */
export function getQuoteSelectionWithin(
  messageRoot: Element | null | undefined,
): string {
  if (typeof window === 'undefined') return ''
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ''

  const range = sel.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  const el =
    ancestor.nodeType === Node.TEXT_NODE
      ? ancestor.parentElement
      : (ancestor as Element | null)
  if (!el) return ''

  const body = el.closest('.tg-msg-body, .tg-bubble-text, .tg-md')
  if (!body) return ''

  const msg = body.closest('.tg-msg')
  if (!msg) return ''

  if (messageRoot) {
    const root = messageRoot.closest('.tg-msg') || messageRoot
    if (!root.contains(body)) return ''
  }

  return normalizeQuoteText(sel.toString())
}

/** Plain-body markdown-style quote lines (`> …`). */
export function quoteAsPlainBody(quote: string): string {
  return quote
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
}

/** HTML fragment for Matrix `formatted_body`. */
export function quoteAsHtml(quote: string): string {
  const inner = escapeHtml(quote).replace(/\r?\n/g, '<br/>')
  return `<blockquote>${inner}</blockquote>`
}

/**
 * Build Matrix text content fields with an optional selection quote.
 * Caption may include composer markup (**bold**, etc.) → HTML formatted_body.
 * Reply quote is always HTML blockquote + plain `>` fallback for other clients.
 */
export function buildTextWithOptionalQuote(
  caption: string,
  quote?: string | null,
): {
  body: string
  format?: string
  formatted_body?: string
} {
  const q = quote?.trim() ? normalizeQuoteText(quote) : ''
  const rawCap = caption.trim()
  const parsed = composerMarkupToMatrix(rawCap)
  const capPlain = parsed.body
  const capHtml = parsed.html

  if (!q) {
    if (!rawCap) return { body: '' }
    if (parsed.hasRich) {
      return {
        body: capPlain,
        format: 'org.matrix.custom.html',
        formatted_body: capHtml,
      }
    }
    return { body: capPlain }
  }

  const plainQuote = quoteAsPlainBody(q)
  const body = capPlain ? `${plainQuote}\n\n${capPlain}` : plainQuote
  const formatted_body = capHtml
    ? `${quoteAsHtml(q)}<div>${capHtml}</div>`
    : quoteAsHtml(q)

  return {
    body,
    format: 'org.matrix.custom.html',
    formatted_body,
  }
}

/** Short preview for the composer reply bar. */
export function quoteSnippet(quote: string, max = 120): string {
  const one = normalizeQuoteText(quote).replace(/\s+/g, ' ')
  if (one.length <= max) return one
  return `${one.slice(0, max - 1)}…`
}

function stripMxReply(html: string): string {
  return html.replace(/<mx-reply[\s\S]*?<\/mx-reply>/gi, '')
}

function htmlFragmentToPlain(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n')
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(
        `<div id="q">${withBreaks}</div>`,
        'text/html',
      )
      const text = doc.getElementById('q')?.textContent ?? ''
      return normalizeQuoteText(text)
    } catch {
      /* fall through */
    }
  }
  return normalizeQuoteText(
    withBreaks
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"'),
  )
}

/** Remove leading `> …` markdown quote lines from plain body. */
export function stripPlainQuotePrefix(body: string): string {
  const lines = body.split(/\r?\n/)
  let i = 0
  while (i < lines.length && /^> ?/.test(lines[i])) i++
  while (i < lines.length && lines[i].trim() === '') i++
  return lines.slice(i).join('\n').trim()
}

export type ExtractedQuote = {
  quoteText: string
  /** Content with leading quote removed (for bubble body). */
  contentWithoutQuote: Record<string, unknown>
}

/**
 * Pull a leading selection-quote out of a Matrix text event so the UI can
 * show one reply chip instead of chip + in-body blockquote.
 */
export function extractEmbeddedQuote(
  content: Record<string, unknown>,
): ExtractedQuote | null {
  const body = typeof content.body === 'string' ? content.body : ''
  const formatted =
    typeof content.formatted_body === 'string' ? content.formatted_body : null

  if (formatted) {
    const cleaned = stripMxReply(formatted).trim()
    const m = cleaned.match(
      /^<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>([\s\S]*)$/i,
    )
    if (m) {
      const quoteText = htmlFragmentToPlain(m[1])
      if (!quoteText) return null
      let restHtml = m[2].replace(/^(?:\s|<br\s*\/?>)*/i, '').trim()
      // unwrap a single outer <div>…</div> we wrap captions in
      const wrap = restHtml.match(/^<div\b[^>]*>([\s\S]*)<\/div>\s*$/i)
      if (wrap) restHtml = wrap[1].trim()

      const restBody = stripPlainQuotePrefix(body)
      const next: Record<string, unknown> = { ...content, body: restBody }

      if (restHtml) {
        next.formatted_body = restHtml
        next.format = content.format || 'org.matrix.custom.html'
      } else {
        delete next.formatted_body
        delete next.format
        if (!restBody) next.body = ''
      }
      return { quoteText, contentWithoutQuote: next }
    }
  }

  if (!body || !/^>/m.test(body)) return null

  const lines = body.split(/\r?\n/)
  const quoteLines: string[] = []
  let i = 0
  while (i < lines.length && /^> ?/.test(lines[i])) {
    quoteLines.push(lines[i].replace(/^> ?/, ''))
    i++
  }
  while (i < lines.length && lines[i].trim() === '') i++
  const quoteText = normalizeQuoteText(quoteLines.join('\n'))
  if (!quoteText) return null

  const restBody = lines.slice(i).join('\n').trim()
  const next: Record<string, unknown> = { ...content, body: restBody }
  // formatted_body may still contain the quote — drop it if we parsed from plain
  if (typeof next.formatted_body === 'string') {
    const cleaned = stripMxReply(String(next.formatted_body)).trim()
    if (/^<blockquote\b/i.test(cleaned)) {
      delete next.formatted_body
      delete next.format
    }
  }
  return { quoteText, contentWithoutQuote: next }
}
