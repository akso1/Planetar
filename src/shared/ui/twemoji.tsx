import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * Local Twemoji PNGs from `public/twemoji/72x72` (copied into dist / asar).
 * Not a font and not a CDN — offline assets. Run `bash scripts/fetch-twemoji.sh` if missing.
 */
function twemojiPublicUrl(code: string): string {
  const base = import.meta.env.BASE_URL || './'
  const prefix = base.endsWith('/') ? base : `${base}/`
  return `${prefix}twemoji/72x72/${code.toLowerCase()}.png`
}

const EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*)|(?:\d\uFE0F\u20E3)|(?:[#*]\uFE0F\u20E3)/gu

/**
 * Twemoji filename rule (same as jdecked/twemoji):
 * - no ZWJ → strip U+FE0F / U+FE0E (❤ → `2764.png`, not `2764-fe0f.png`)
 * - with ZWJ → keep FE0F in the sequence (`2764-fe0f-200d-1f525.png`)
 */
function toTwemojiCodes(emoji: string): string[] {
  const raw: number[] = []
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)
    if (cp == null) continue
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    raw.push(cp)
  }
  if (!raw.length) return []

  const hasZwj = raw.includes(0x200d)
  const noTextVs = raw.filter((cp) => cp !== 0xfe0e)
  const stripped = raw.filter((cp) => cp !== 0xfe0f && cp !== 0xfe0e)

  const codes: string[] = []
  const add = (parts: number[]) => {
    if (!parts.length) return
    const key = parts.map((c) => c.toString(16)).join('-')
    if (!codes.includes(key)) codes.push(key)
  }

  if (hasZwj) {
    // Prefer official ZWJ name with FE0F kept
    add(noTextVs)
    add(stripped)
  } else {
    // Simple emoji: FE0F is never in the asset filename
    add(stripped)
    // Some packs / lookups still use the FE0F form — try as fallback
    if (stripped.length === 1) add([stripped[0], 0xfe0f])
  }

  // Last-resort fallbacks (rare / incomplete packs)
  if (stripped.length > 1) {
    add([stripped[0]])
    const noZwj = stripped.filter((cp) => cp !== 0x200d)
    if (noZwj.length && noZwj.length !== stripped.length) add(noZwj)
  }
  return codes
}

function isEmojiGrapheme(segment: string): boolean {
  if (!segment) return false
  EMOJI_RE.lastIndex = 0
  const m = segment.match(EMOJI_RE)
  return !!(m && m[0] === segment)
}

function forEachEmoji(
  text: string,
  onEmoji: (emoji: string, index: number, length: number) => void,
): void {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let index = 0
    for (const { segment } of seg.segment(text)) {
      if (isEmojiGrapheme(segment)) onEmoji(segment, index, segment.length)
      index += segment.length
    }
    return
  }
  EMOJI_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EMOJI_RE.exec(text)) != null) {
    onEmoji(match[0], match.index, match[0].length)
  }
}

/** Local Twemoji <img> from public/. Tries candidate filenames until one loads. */
export function TwemojiImg({
  emoji,
  className = 'tg-twemoji',
}: {
  emoji: string
  className?: string
}) {
  const codes = useMemo(() => toTwemojiCodes(emoji), [emoji])
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(codes.length === 0)

  useEffect(() => {
    setIdx(0)
    setFailed(codes.length === 0)
  }, [emoji, codes])

  const src = !failed && codes[idx] ? twemojiPublicUrl(codes[idx]) : null

  if (!src) {
    // Keep native glyph as last resort (no debug hex in UI)
    return (
      <span className="tg-twemoji tg-twemoji--native" title={emoji}>
        {emoji}
      </span>
    )
  }

  return (
    <img
      className={className}
      src={src}
      alt={emoji}
      title={emoji}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => {
        if (idx + 1 < codes.length) setIdx(idx + 1)
        else setFailed(true)
      }}
    />
  )
}

export function renderTwemojiString(text: string): ReactNode {
  if (!text) return null
  const hits: Array<{ index: number; length: number; emoji: string }> = []
  forEachEmoji(text, (emoji, index, length) => {
    hits.push({ index, length, emoji })
  })
  if (!hits.length) return text

  const nodes: ReactNode[] = []
  let cursor = 0
  hits.forEach((hit, i) => {
    if (hit.index > cursor) {
      nodes.push(text.slice(cursor, hit.index))
    }
    nodes.push(
      <TwemojiImg key={`e-${hit.index}-${i}`} emoji={hit.emoji} />,
    )
    cursor = hit.index + hit.length
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

export function withTwemoji(children: ReactNode): ReactNode {
  if (children == null || typeof children === 'boolean') return children
  if (typeof children === 'string' || typeof children === 'number') {
    return renderTwemojiString(String(children))
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => (
      <Fragment key={i}>{withTwemoji(child)}</Fragment>
    ))
  }
  return children
}

export function twemojiAssetCount(): number {
  return -1
}

export function twemojiHasCode(_code: string): boolean {
  return true
}
