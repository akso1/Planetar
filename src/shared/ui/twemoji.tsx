import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  twemojiCodeExists,
  twemojiKnownCodeCount,
} from '@/shared/ui/twemojiCodes.generated'

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
 * Build candidate Twemoji basenames for a grapheme.
 * Pack naming is inconsistent for ZWJ (👁‍🗨 → `1f441-200d-1f5e8`,
 * ❤🔥 → `2764-fe0f-200d-1f525`), so we try several FE0F variants and
 * only request codes that exist in the generated index — no console 404s.
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
    // Prefer stripped first — matches eye-in-speech-bubble and many ZWJ packs
    add(stripped)
    add(noTextVs)
    // Drop trailing FE0F only (…-1f5e8-fe0f → …-1f5e8)
    if (noTextVs.length > 1 && noTextVs[noTextVs.length - 1] === 0xfe0f) {
      add(noTextVs.slice(0, -1))
    }
    // Insert FE0F after every non-ZWJ codepoint (heart-on-fire / jdecked style)
    const fe0fEverywhere: number[] = []
    for (const cp of stripped) {
      fe0fEverywhere.push(cp)
      if (cp !== 0x200d) fe0fEverywhere.push(0xfe0f)
    }
    if (fe0fEverywhere[fe0fEverywhere.length - 1] === 0xfe0f) {
      add(fe0fEverywhere.slice(0, -1))
    }
    add(fe0fEverywhere)
  } else {
    add(stripped)
    if (stripped.length === 1) add([stripped[0]!, 0xfe0f])
  }

  if (stripped.length > 1) {
    add([stripped[0]!])
    const noZwj = stripped.filter((cp) => cp !== 0x200d)
    if (noZwj.length && noZwj.length !== stripped.length) add(noZwj)
  }

  // Only codes that exist on disk — never hit ERR_FILE_NOT_FOUND
  const existing = codes.filter((c) => twemojiCodeExists(c))
  return existing.length ? existing : codes.slice(0, 1)
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

/** Local Twemoji <img> from public/. Only loads filenames known to exist. */
export function TwemojiImg({
  emoji,
  className = 'tg-twemoji',
}: {
  emoji: string
  className?: string
}) {
  const codes = useMemo(() => toTwemojiCodes(emoji), [emoji])
  const known = useMemo(
    () => codes.filter((c) => twemojiCodeExists(c)),
    [codes],
  )
  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(known.length === 0)

  useEffect(() => {
    setIdx(0)
    setFailed(known.length === 0)
  }, [emoji, known])

  const code = !failed && known[idx] ? known[idx] : null
  const src = code ? twemojiPublicUrl(code) : null

  if (!src) {
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
        // Should be rare (index out of date). Fall through candidates then native.
        if (idx + 1 < known.length) setIdx(idx + 1)
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
  return twemojiKnownCodeCount()
}

export function twemojiHasCode(code: string): boolean {
  return twemojiCodeExists(code)
}
