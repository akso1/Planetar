import { escapeHtml } from './escapeHtml'

export type ComposerSelection = {
  value: string
  start: number
  end: number
}

export type FormatKind =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'spoiler'
  | 'mono'
  | 'quote'

const WRAP: Record<
  Exclude<FormatKind, 'quote'>,
  { left: string; right: string }
> = {
  bold: { left: '**', right: '**' },
  italic: { left: '*', right: '*' },
  underline: { left: '++', right: '++' },
  strike: { left: '~~', right: '~~' },
  spoiler: { left: '||', right: '||' },
  mono: { left: '`', right: '`' },
}

/** Markers longest-first so `**` wins over `*`. */
const CLEAR_PAIRS: Array<{ left: string; right: string }> = [
  { left: '||', right: '||' },
  { left: '**', right: '**' },
  { left: '++', right: '++' },
  { left: '~~', right: '~~' },
  { left: '*', right: '*' },
  { left: '`', right: '`' },
]

function replaceRange(
  value: string,
  start: number,
  end: number,
  insert: string,
): ComposerSelection {
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    start,
    end: start + insert.length,
  }
}

/** Toggle wrap markers around the current selection (or insert empty pair). */
export function applyInlineFormat(
  sel: ComposerSelection,
  kind: Exclude<FormatKind, 'quote'>,
): ComposerSelection {
  const { left, right } = WRAP[kind]
  const { value, start, end } = sel
  const selected = value.slice(start, end)

  // Already wrapped by selection including markers
  if (
    selected.startsWith(left) &&
    selected.endsWith(right) &&
    selected.length >= left.length + right.length
  ) {
    const inner = selected.slice(left.length, selected.length - right.length)
    return replaceRange(value, start, end, inner)
  }

  // Markers immediately outside selection
  const before = value.slice(Math.max(0, start - left.length), start)
  const after = value.slice(end, end + right.length)
  if (before === left && after === right) {
    return {
      value: value.slice(0, start - left.length) + selected + value.slice(end + right.length),
      start: start - left.length,
      end: end - left.length,
    }
  }

  const insert = `${left}${selected}${right}`
  const next = replaceRange(value, start, end, insert)
  if (!selected) {
    const caret = start + left.length
    return { value: next.value, start: caret, end: caret }
  }
  return {
    value: next.value,
    start: start + left.length,
    end: start + left.length + selected.length,
  }
}

/**
 * Quote only the selection (not the whole line).
 * Mid-line selections are split onto their own `>` lines so Matrix HTML works.
 * Empty selection → toggle quote on the current line.
 */
export function applyQuoteFormat(sel: ComposerSelection): ComposerSelection {
  const { value, start, end } = sel

  if (start === end) {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    let lineEnd = value.indexOf('\n', end)
    if (lineEnd < 0) lineEnd = value.length
    const line = value.slice(lineStart, lineEnd)
    const quoted = line.startsWith('> ') || line === '>'
    const nextLine = quoted
      ? line.startsWith('> ')
        ? line.slice(2)
        : ''
      : line.startsWith('>')
        ? line
        : `> ${line}`
    const nextValue = value.slice(0, lineStart) + nextLine + value.slice(lineEnd)
    const caret = lineStart + nextLine.length
    return { value: nextValue, start: caret, end: caret }
  }

  const selected = value.slice(start, end)
  const lines = selected.split('\n')
  const allQuoted =
    lines.length > 0 && lines.every((l) => l.startsWith('> ') || l === '>')

  let insert: string
  if (allQuoted) {
    insert = lines
      .map((l) => (l.startsWith('> ') ? l.slice(2) : l === '>' ? '' : l))
      .join('\n')
    return replaceRange(value, start, end, insert)
  }

  insert = lines
    .map((l) => (l.startsWith('> ') || l === '>' ? l : `> ${l}`))
    .join('\n')

  const before = value.slice(0, start)
  const after = value.slice(end)
  const needLead = before.length > 0 && !before.endsWith('\n')
  const needTail = after.length > 0 && !after.startsWith('\n')
  const block = `${needLead ? '\n' : ''}${insert}${needTail ? '\n' : ''}`
  const nextValue = before + block + after
  const selStart = start + (needLead ? 1 : 0)
  return {
    value: nextValue,
    start: selStart,
    end: selStart + insert.length,
  }
}

/** Strip known markdown-like markers and quote prefixes from selection. */
export function clearComposerFormat(sel: ComposerSelection): ComposerSelection {
  const { value, start, end } = sel
  if (start === end) return sel
  let chunk = value.slice(start, end)

  // Strip quote prefixes per line
  chunk = chunk
    .split('\n')
    .map((l) => (l.startsWith('> ') ? l.slice(2) : l === '>' ? '' : l))
    .join('\n')

  // Strip [label](url) → label
  chunk = chunk.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1')

  let prev = ''
  while (prev !== chunk) {
    prev = chunk
    for (const { left, right } of CLEAR_PAIRS) {
      const re = new RegExp(
        `${escapeRegExp(left)}([\\s\\S]*?)${escapeRegExp(right)}`,
        'g',
      )
      chunk = chunk.replace(re, '$1')
    }
  }

  // Drop leftover marker runs that no longer form pairs
  chunk = chunk.replace(/\|\||\+\+|~~|\*\*/g, '').replace(/`/g, '')

  return replaceRange(value, start, end, chunk)
}

export function applyCaseTransform(
  sel: ComposerSelection,
  mode: 'upper' | 'lower' | 'title',
): ComposerSelection {
  const { value, start, end } = sel
  if (start === end) return sel
  const selected = value.slice(start, end)
  let next: string
  if (mode === 'upper') next = selected.toLocaleUpperCase('ru-RU')
  else if (mode === 'lower') next = selected.toLocaleLowerCase('ru-RU')
  else {
    next = selected.replace(/([^\s]+)/g, (word) => {
      const chars = [...word]
      if (!chars.length) return word
      return (
        chars[0].toLocaleUpperCase('ru-RU') +
        chars.slice(1).join('').toLocaleLowerCase('ru-RU')
      )
    })
  }
  return replaceRange(value, start, end, next)
}

export function applyLinkFormat(
  sel: ComposerSelection,
  url: string,
): ComposerSelection {
  const href = url.trim()
  if (!href) return sel
  const { value, start, end } = sel
  const selected = value.slice(start, end) || 'ссылка'
  // Replace existing markdown link selection
  const insert = `[${selected}](${href})`
  const next = replaceRange(value, start, end, insert)
  return {
    value: next.value,
    start: start,
    end: start + insert.length,
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Convert composer markup → plain body + Matrix HTML.
 * Markers: **bold** *italic* ++underline++ ~~strike~~ ||spoiler|| `code` [t](url) > quote
 */
export function composerMarkupToMatrix(raw: string): {
  body: string
  html: string
  hasRich: boolean
} {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text) return { body: '', html: '', hasRich: false }

  const lines = text.split('\n')
  const htmlParts: string[] = []
  const plainParts: string[] = []
  let hasRich = false
  let i = 0

  while (i < lines.length) {
    if (isQuoteLine(lines[i])) {
      const qLines: string[] = []
      while (i < lines.length && isQuoteLine(lines[i])) {
        qLines.push(stripQuotePrefix(lines[i]))
        i++
      }
      hasRich = true
      const innerHtml = qLines
        .map((l) => inlineToHtml(l).html)
        .join('<br/>')
      const innerPlain = qLines.map((l) => inlineToHtml(l).plain).join('\n')
      htmlParts.push(`<blockquote>${innerHtml}</blockquote>`)
      plainParts.push(innerPlain.split('\n').map((l) => `> ${l}`).join('\n'))
      continue
    }

    const line = lines[i]
    i++
    const { html, plain, rich } = inlineToHtml(line)
    if (rich) hasRich = true
    htmlParts.push(html)
    plainParts.push(plain)
  }

  const html = htmlParts.join('<br/>')
  const body = plainParts.join('\n')
  if (lines.length > 1) hasRich = true

  return { body, html, hasRich }
}

function isQuoteLine(line: string): boolean {
  return /^> ?/.test(line)
}

function stripQuotePrefix(line: string): string {
  return line.replace(/^> ?/, '')
}

type AstNode =
  | { type: 'text'; text: string }
  | { type: 'tag'; tag: string; attrs?: string; children: AstNode[] }

function inlineToHtml(line: string): {
  html: string
  plain: string
  rich: boolean
} {
  const nodes = parseInline(line)
  return {
    html: nodesToHtml(nodes),
    plain: nodesToPlain(nodes),
    rich: nodes.some((n) => n.type === 'tag'),
  }
}

function nodesToPlain(nodes: AstNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += n.text
    else out += nodesToPlain(n.children)
  }
  return out
}

function nodesToHtml(nodes: AstNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') {
      out += escapeHtml(n.text)
      continue
    }
    const open = n.attrs ? `<${n.tag} ${n.attrs}>` : `<${n.tag}>`
    out += `${open}${nodesToHtml(n.children)}</${n.tag}>`
  }
  return out
}

function parseInline(input: string): AstNode[] {
  const nodes: AstNode[] = []
  let i = 0

  const pushText = (t: string) => {
    if (!t) return
    const last = nodes[nodes.length - 1]
    if (last?.type === 'text') last.text += t
    else nodes.push({ type: 'text', text: t })
  }

  while (i < input.length) {
    // code `...`
    if (input[i] === '`') {
      const close = input.indexOf('`', i + 1)
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'code',
          children: [{ type: 'text', text: input.slice(i + 1, close) }],
        })
        i = close + 1
        continue
      }
    }

    // spoiler ||...||
    if (input.startsWith('||', i)) {
      const close = input.indexOf('||', i + 2)
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'span',
          attrs: 'data-mx-spoiler=""',
          children: parseInline(input.slice(i + 2, close)),
        })
        i = close + 2
        continue
      }
    }

    // link [text](url)
    if (input[i] === '[') {
      const m = input.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/)
      if (m) {
        const href = escapeHtml(m[2])
        nodes.push({
          type: 'tag',
          tag: 'a',
          attrs: `href="${href}"`,
          children: parseInline(m[1]),
        })
        i += m[0].length
        continue
      }
    }

    // bold **...**
    if (input.startsWith('**', i)) {
      const close = input.indexOf('**', i + 2)
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'strong',
          children: parseInline(input.slice(i + 2, close)),
        })
        i = close + 2
        continue
      }
    }

    // underline ++...++
    if (input.startsWith('++', i)) {
      const close = input.indexOf('++', i + 2)
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'u',
          children: parseInline(input.slice(i + 2, close)),
        })
        i = close + 2
        continue
      }
    }

    // strike ~~...~~
    if (input.startsWith('~~', i)) {
      const close = input.indexOf('~~', i + 2)
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'del',
          children: parseInline(input.slice(i + 2, close)),
        })
        i = close + 2
        continue
      }
    }

    // italic *...* (single asterisk, not **)
    if (input[i] === '*' && input[i + 1] !== '*') {
      const close = findSingleClose(input, i + 1, '*')
      if (close > i) {
        nodes.push({
          type: 'tag',
          tag: 'em',
          children: parseInline(input.slice(i + 1, close)),
        })
        i = close + 1
        continue
      }
    }

    pushText(input[i])
    i++
  }

  return nodes
}

function findSingleClose(input: string, from: number, ch: string): number {
  for (let j = from; j < input.length; j++) {
    if (input[j] !== ch) continue
    // skip ** 
    if (ch === '*' && input[j + 1] === '*') {
      j++
      continue
    }
    return j
  }
  return -1
}

/** Whether selection looks like it has composer markers (for enabling clear). */
export function selectionHasFormat(sel: ComposerSelection): boolean {
  const chunk = sel.value.slice(sel.start, sel.end)
  if (!chunk) return false
  if (/^> |^>/m.test(chunk)) return true
  if (/\[[^\]]+\]\([^)\s]+\)/.test(chunk)) return true
  return CLEAR_PAIRS.some(
    ({ left, right }) => chunk.includes(left) && chunk.includes(right),
  )
}

function stripMxReplyHtml(html: string): string {
  return html.replace(/<mx-reply[\s\S]*?<\/mx-reply>/gi, '')
}

/**
 * Convert Matrix `formatted_body` HTML back into composer markup
 * so editing preserves bold / spoilers / quotes / etc.
 */
export function matrixHtmlToComposerMarkup(rawHtml: string): string {
  const cleaned = stripMxReplyHtml(rawHtml).trim()
  if (!cleaned) return ''

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(cleaned, 'text/html')
      const root = doc.body
      if (root) {
        const fromDom = normalizeComposerText(serializeHtmlNode(root))
        if (fromDom.trim()) return fromDom
      }
    } catch {
      /* fall through */
    }
  }

  return normalizeComposerText(htmlToMarkupFallback(cleaned))
}

/** Prefer HTML→markup; fall back to plain body. */
export function matrixContentToComposerText(content: {
  body?: unknown
  format?: unknown
  formatted_body?: unknown
}): string {
  const body = typeof content.body === 'string' ? content.body : ''
  const formatted =
    typeof content.formatted_body === 'string' ? content.formatted_body : ''
  if (
    (content.format === 'org.matrix.custom.html' || formatted.trim()) &&
    formatted.trim()
  ) {
    const markup = matrixHtmlToComposerMarkup(formatted)
    if (markup.trim()) return markup
  }
  return body
}

function normalizeComposerText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function stripTags(s: string): string {
  return decodeBasicEntities(s.replace(/<[^>]+>/g, ''))
}

/** Regex fallback when DOMParser is unavailable or yields nothing. */
function htmlToMarkupFallback(html: string): string {
  let s = html
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(?:p|div|h[1-6])>/gi, '\n')
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const text = htmlToMarkupFallback(String(inner)).replace(/\n+$/g, '')
    if (!text.trim()) return ''
    return `${text
      .split('\n')
      .map((l) => (l.startsWith('> ') || l === '>' ? l : `> ${l}`))
      .join('\n')}\n`
  })
  s = s.replace(
    /<span[^>]*data-mx-spoiler[^>]*>([\s\S]*?)<\/span>/gi,
    (_m, inner) => {
      const t = htmlToMarkupFallback(String(inner))
      return t ? `||${t}||` : ''
    },
  )
  s = s.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, inner) => {
    const t = htmlToMarkupFallback(String(inner))
    return t ? `**${t}**` : ''
  })
  s = s.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, inner) => {
    const t = htmlToMarkupFallback(String(inner))
    return t ? `*${t}*` : ''
  })
  s = s.replace(/<u[^>]*>([\s\S]*?)<\/u>/gi, (_m, inner) => {
    const t = htmlToMarkupFallback(String(inner))
    return t ? `++${t}++` : ''
  })
  s = s.replace(/<(?:del|s|strike)[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi, (_m, inner) => {
    const t = htmlToMarkupFallback(String(inner))
    return t ? `~~${t}~~` : ''
  })
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const t = stripTags(String(inner))
    return t ? `\`${t.replace(/`/g, '')}\`` : ''
  })
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const t = stripTags(String(inner)).trim() || String(href)
    return `[${t}](${href})`
  })
  return stripTags(s)
}

const NODE_TEXT = 3
const NODE_ELEMENT = 1

function serializeHtmlNode(node: Node): string {
  if (node.nodeType === NODE_TEXT) {
    return node.textContent ?? ''
  }
  if (node.nodeType !== NODE_ELEMENT) return ''

  const el = node as HTMLElement
  const tag = el.tagName.toUpperCase()
  const inner = () =>
    Array.from(el.childNodes)
      .map(serializeHtmlNode)
      .join('')

  if (tag === 'MX-REPLY') return ''
  if (tag === 'BR') return '\n'

  if (tag === 'STRONG' || tag === 'B') {
    const t = inner()
    return t ? `**${t}**` : ''
  }
  if (tag === 'EM' || tag === 'I') {
    const t = inner()
    return t ? `*${t}*` : ''
  }
  if (tag === 'U') {
    const t = inner()
    return t ? `++${t}++` : ''
  }
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') {
    const t = inner()
    return t ? `~~${t}~~` : ''
  }
  if (tag === 'CODE') {
    const t = el.textContent ?? ''
    return t ? `\`${t.replace(/`/g, '')}\`` : ''
  }
  if (tag === 'PRE') {
    const t = (el.textContent ?? '').replace(/\n$/, '')
    return t ? `\`${t.replace(/`/g, '')}\`` : ''
  }
  if (tag === 'SPAN' && el.hasAttribute('data-mx-spoiler')) {
    const t = inner()
    return t ? `||${t}||` : ''
  }
  if (tag === 'A') {
    const href = el.getAttribute('href') || ''
    const t = inner().trim() || href
    if (!href) return t
    return `[${t}](${href})`
  }
  if (tag === 'BLOCKQUOTE') {
    const raw = inner().replace(/\n+$/g, '')
    if (!raw.trim()) return ''
    return `${raw
      .split('\n')
      .map((l) => (l.startsWith('> ') || l === '>' ? l : `> ${l}`))
      .join('\n')}\n`
  }
  if (tag === 'P' || tag === 'DIV') {
    const t = inner()
    if (!t) return ''
    return t.endsWith('\n') ? t : `${t}\n`
  }
  if (tag === 'LI') {
    return `• ${inner().trim()}\n`
  }

  return inner()
}

