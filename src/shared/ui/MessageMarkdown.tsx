import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { clsx } from 'clsx'
import { userIdFromMatrixTo } from '@/shared/lib/openDm'
import { getUserColor, getUserColorAlpha } from '@/shared/lib/color'
import { withTwemoji } from '@/shared/ui/twemoji'

export type MentionMember = {
  userId: string
  displayName: string
}

type MessageMarkdownProps = {
  text: string
  className?: string
  /** Room members — used to resolve @DisplayName → userId */
  members?: MentionMember[]
  onUserClick?: (userId: string) => void
}

const MENTION_PILL_BASE =
  'tg-mention inline align-baseline font-medium hover:underline cursor-pointer px-1 py-0.5 rounded transition-colors'

/**
 * GFM treats a lone "+", "-" or "*" as an empty list item (renders as a bullet).
 */
function prepareChatMarkdown(text: string): string {
  const trimmed = text.trim()
  if (/^[+\-*]$/.test(trimmed)) {
    return `\\${trimmed}`
  }
  return text
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Turn @mxid / @DisplayName into markdown links so we can style them as pills.
 * Skips regions that are already markdown links or code.
 */
function linkifyMentions(text: string, members: MentionMember[]): string {
  // Protect existing markdown links and inline/code blocks with placeholders
  const slots: string[] = []
  const park = (chunk: string) => {
    slots.push(chunk)
    return `\u0000${slots.length - 1}\u0000`
  }

  let out = text
    .replace(/\[[^\]]*]\([^)]+\)/g, park)
    .replace(/`[^`]+`/g, park)
    .replace(/```[\s\S]*?```/g, park)

  // Full Matrix IDs: @localpart:server
  out = out.replace(
    /(^|[\s([{])(@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.:\-]+)/g,
    (_m, pre: string, mxid: string) =>
      `${pre}[${mxid}](https://matrix.to/#/${mxid})`,
  )

  // Display names (longest first to avoid partial overlaps)
  const sorted = [...members].sort(
    (a, b) => b.displayName.length - a.displayName.length,
  )
  for (const m of sorted) {
    if (!m.displayName.trim()) continue
    let re: RegExp
    try {
      re = new RegExp(
        `(^|[\\s([{])(@${escapeRegExp(m.displayName)})(?=$|[\\s.,!?;:)\\]}])`,
        'g',
      )
    } catch {
      continue
    }
    out = out.replace(
      re,
      (_m, pre: string, label: string) =>
        `${pre}[${label}](https://matrix.to/#/${m.userId})`,
    )
  }

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)] ?? '')
}

/**
 * Renders Matrix message body with Markdown + per-user colored mention pills.
 * Unicode emoji are drawn via Twemoji images (reliable in Electron).
 */
export function MessageMarkdown({
  text,
  className,
  members = [],
  onUserClick,
}: MessageMarkdownProps) {
  const source = linkifyMentions(prepareChatMarkdown(text), members)

  return (
    <div className={className ? `tg-md ${className}` : 'tg-md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p className="tg-md-p whitespace-pre-wrap">
              {withTwemoji(children)}
            </p>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold">{withTwemoji(children)}</strong>
          ),
          em: ({ children }) => (
            <em className="italic">{withTwemoji(children)}</em>
          ),
          li: ({ children }) => <li>{withTwemoji(children)}</li>,
          a: ({ href, children }) => {
            const userId = userIdFromMatrixTo(href)
            if (userId) {
              return (
                <button
                  type="button"
                  className={MENTION_PILL_BASE}
                  style={{
                    color: getUserColor(userId),
                    backgroundColor: getUserColorAlpha(userId, 0.2),
                  }}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onUserClick?.(userId)
                  }}
                >
                  {withTwemoji(children)}
                </button>
              )
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-hover underline underline-offset-2 hover:text-accent-fg"
              >
                {withTwemoji(children)}
              </a>
            )
          },
          ul: ({ children }) => (
            <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>
          ),
          del: ({ children }) => (
            <del className="line-through opacity-70">{withTwemoji(children)}</del>
          ),
          pre: ({ children }) => <pre className="tg-md-pre">{children}</pre>,
          code: ({ className: codeClass, children }) => {
            const isBlock =
              Boolean(codeClass) || String(children).includes('\n')
            if (isBlock) {
              return <code className={codeClass}>{children}</code>
            }
            return <code className="tg-md-code-inline">{children}</code>
          },
          blockquote: ({ children }) => (
            <blockquote className="tg-md-quote">
              <span className="tg-md-quote-bar" aria-hidden />
              <span className="tg-md-quote-text">{withTwemoji(children)}</span>
            </blockquote>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
}

export function mentionPillClassName(extra?: string) {
  return clsx(MENTION_PILL_BASE, extra)
}
