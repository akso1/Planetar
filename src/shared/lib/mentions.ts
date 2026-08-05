import type { Room } from 'matrix-js-sdk'
import { escapeHtml } from '@/shared/lib/escapeHtml'

/** Localpart without leading @ — preferred composer / pill token. */
export function mxidLocalpart(userId: string): string {
  return userId.split(':')[0]?.replace(/^@/, '') || ''
}

export type MentionClickAnchor = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type MentionUserClickHandler = (
  userId: string,
  visibleLabel?: string,
  anchor?: MentionClickAnchor,
) => void

export function mentionClickAnchorFromEl(
  el: Element,
): MentionClickAnchor {
  const r = el.getBoundingClientRect()
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  }
}

export type MentionLabelMember = {
  userId: string
  displayName: string
}

/** How specific a `@label` is for a given user — higher wins on collisions. */
function mentionLabelPriority(label: string, userId: string): number {
  const key = label.toLowerCase()
  const full = (
    userId.startsWith('@') ? userId : `@${userId}`
  ).toLowerCase()
  const local = `@${mxidLocalpart(userId)}`.toLowerCase()
  if (key === full) return 3
  if (key === local) return 2
  return 1 // display-name form
}

/**
 * Display-name tokens used for plain-text / markdown @pills.
 * Skip names with spaces (can't be one @token) and very short common words.
 */
function mentionableDisplayToken(displayName: string | undefined): string {
  const raw = (displayName || '').trim().replace(/^@+/, '')
  if (!raw || /\s/.test(raw)) return ''
  // Avoid turning `@ok` / `@я` style noise into pills unless it's a real handle
  if (raw.length < 2) return ''
  return raw
}

/**
 * Map of `@token` (lowercase) → userId for pill / click resolution.
 * Includes full mxid, localpart, and single-token display names.
 * On collisions prefer full MXID > localpart > display name; equal rank keeps first.
 */
export function buildMentionLabelMap(
  members: MentionLabelMember[],
): Map<string, string> {
  const map = new Map<string, string>()
  const rank = new Map<string, number>()
  for (const m of members) {
    if (!m.userId) continue
    const local = mxidLocalpart(m.userId)
    const displayTok = mentionableDisplayToken(m.displayName)
    const labels = [
      m.userId.startsWith('@') ? m.userId : `@${m.userId}`,
      local ? `@${local}` : '',
      displayTok ? `@${displayTok}` : '',
    ]
    for (const label of labels) {
      if (!label || label === '@') continue
      const key = label.toLowerCase()
      const p = mentionLabelPriority(label, m.userId)
      const prev = rank.get(key) ?? -1
      if (p > prev) {
        map.set(key, m.userId)
        rank.set(key, p)
      }
    }
  }
  return map
}

export type MentionTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; label: string; userId: string }

/**
 * Split plain text into text + @mention parts (full mxid or known member labels).
 */
export function splitTextMentions(
  text: string,
  labelMap: Map<string, string>,
): MentionTextPart[] {
  if (!text) return []
  const parts: MentionTextPart[] = []
  // Full mxid OR @token with typical Matrix localpart / display chars
  const re =
    /@[A-Za-z0-9._=\-/]+(?::[A-Za-z0-9.:\-]+)?/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) != null) {
    const label = m[0]
    const userId =
      labelMap.get(label.toLowerCase()) ||
      (/^@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.:\-]+$/.test(label) ? label : null)
    if (m.index > last) {
      parts.push({ kind: 'text', text: text.slice(last, m.index) })
    }
    if (userId) {
      parts.push({ kind: 'mention', label, userId })
    } else {
      parts.push({ kind: 'text', text: label })
    }
    last = m.index + label.length
  }
  if (last < text.length) {
    parts.push({ kind: 'text', text: text.slice(last) })
  }
  return parts.length ? parts : [{ kind: 'text', text }]
}

/**
 * Label inserted into the composer for @mentions.
 * Prefer MXID localpart so tokens stay one word and match pill re-clicks
 * (display names with spaces like "Telegram bridge bot" break the tag).
 */
export function mentionComposerLabel(
  userId: string,
  fallbackDisplayName?: string | null,
): string {
  const local = mxidLocalpart(userId)
  if (local) return local
  const raw = (fallbackDisplayName || '').trim().replace(/^@+/, '')
  return raw || userId
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Ensure `formatted_body` contains matrix.to mention links for known user ids
 * so messages render as colored pills (not plain `@Display Name` text).
 */
export function applyMentionLinksToContent(
  content: Record<string, unknown>,
  userIds: string[],
  room?: Room | null,
): void {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (!unique.length) return

  const body = typeof content.body === 'string' ? content.body : ''
  if (!body) return

  let html =
    typeof content.formatted_body === 'string' && content.formatted_body.trim()
      ? content.formatted_body
      : escapeHtml(body).replace(/\n/g, '<br/>')

  for (const userId of unique) {
    const local = mxidLocalpart(userId)
    const member = room?.getMember(userId)
    const display =
      member?.name ||
      member?.rawDisplayName ||
      local ||
      userId
    const href = `https://matrix.to/#/${userId}`
    const linkFor = (label: string) =>
      `<a href="${href}">${escapeHtml(label)}</a>`

    const candidates = [`@${userId}`, userId.startsWith('@') ? userId : `@${userId}`]
    if (local) candidates.push(`@${local}`)
    if (display && display !== local) candidates.push(`@${display}`)

    // Longest first so @user:server wins over @user
    const sorted = [...new Set(candidates)].sort((a, b) => b.length - a.length)
    for (const token of sorted) {
      if (!token || token === '@') continue
      let re: RegExp
      try {
        re = new RegExp(
          `(^|[\\s([{>])(${escapeRegExp(token)})(?=$|[\\s.,!?;:)\\]}<])`,
          'g',
        )
      } catch {
        continue
      }
      html = html.replace(re, (_m, pre: string, label: string) => {
        // Skip if already inside an href for this user
        return `${pre}${linkFor(label)}`
      })
    }
  }

  // Avoid double-wrapping already-linked mentions
  html = html.replace(
    /<a href="(https:\/\/matrix\.to\/#\/[^"]+)">\s*<a href="\1">([\s\S]*?)<\/a>\s*<\/a>/gi,
    '<a href="$1">$2</a>',
  )

  content.format = 'org.matrix.custom.html'
  content.formatted_body = html
}
