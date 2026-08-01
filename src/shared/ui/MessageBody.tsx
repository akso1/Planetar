import { useEffect, useMemo, useState, isValidElement, type ReactNode } from 'react'
import { clsx } from 'clsx'
import {
  acquireCachedObjectUrl,
  downloadAuthenticatedMxc,
  releaseCachedObjectUrl,
} from '@/shared/lib/matrixMedia'
import { MessageMarkdown, type MentionMember } from '@/shared/ui/MessageMarkdown'
import { userIdFromMatrixTo } from '@/shared/lib/openDm'
import { getUserColor, getUserColorAlpha } from '@/shared/lib/color'
import { useSessionStore } from '@/entities/session/model/session'
import { renderTwemojiString } from '@/shared/ui/twemoji'
import { SpoilerText } from '@/shared/ui/SpoilerText'
import type { MatrixClient } from 'matrix-js-sdk'

const ALLOWED_TAGS = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'DEL',
  'EM',
  'FONT',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'I',
  'IMG',
  'LI',
  'OL',
  'P',
  'PRE',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TABLE',
  'TBODY',
  'TD',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL',
])

function stripMxReply(html: string): string {
  return html.replace(/<mx-reply[\s\S]*?<\/mx-reply>/gi, '')
}

function isMxcUrl(url: string | null | undefined): url is string {
  return !!url && url.startsWith('mxc://')
}

/** Body is empty / only object-replacement / ZWSP placeholders (image lived in HTML). */
function isPlaceholderBody(body: string): boolean {
  return body.replace(/[\s\uFFFC\uFFFD\uFEFF\u200B-\u200D\u2060\u00A0]/g, '')
    .length === 0
}

/**
 * Bridges (esp. Telegram) sometimes put a geometric "tofu" box in `body`
 * while the real custom emoji lives in formatted_body as mxc <img>.
 */
function isBridgeEmojiPlaceholder(body: string): boolean {
  if (isPlaceholderBody(body)) return true
  const stripped = body.replace(
    /[\s\uFEFF\u200B-\u200D\u2060\u00A0]/g,
    '',
  )
  const chars = [...stripped]
  if (chars.length === 0 || chars.length > 2) return false
  return chars.every((ch) => {
    const cp = ch.codePointAt(0)
    if (cp == null) return false
    if (cp === 0xfffc || cp === 0xfffd) return true
    // Geometric Shapes block — common missing-glyph stand-ins (incl. ▯)
    if (cp >= 0x25a0 && cp <= 0x25ff) return true
    return false
  })
}

function emoticonCacheKey(mxcUrl: string, size: number) {
  return `mx-emoticon:${mxcUrl}|${size}`
}

async function downloadEmoticonBlob(
  client: MatrixClient,
  mxcUrl: string,
  size: number,
): Promise<Blob> {
  try {
    return await downloadAuthenticatedMxc(client, mxcUrl, size)
  } catch {
    const token = client.getAccessToken()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined
    const httpUrl = client.mxcUrlToHttp(
      mxcUrl,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    )
    if (!httpUrl) throw new Error('Invalid emoticon MXC')
    const res = await fetch(httpUrl, { headers })
    if (!res.ok) throw new Error(`Emoticon HTTP ${res.status}`)
    return res.blob()
  }
}

function MxEmoticonImg({
  mxcUrl,
  alt,
  title,
  height,
}: {
  mxcUrl: string
  alt: string
  title?: string
  height: number
}) {
  const client = useSessionStore((s) => s.client)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const mediaSize = Math.max(64, height * 3)

  useEffect(() => {
    if (!client || !mxcUrl) return
    let cancelled = false
    let acquired = false
    const key = emoticonCacheKey(mxcUrl, mediaSize)
    const releaseOnce = () => {
      if (!acquired) return
      acquired = false
      releaseCachedObjectUrl(key)
    }

    setFailed(false)
    setSrc(null)

    void (async () => {
      try {
        const url = await acquireCachedObjectUrl(key, () =>
          downloadEmoticonBlob(client, mxcUrl, mediaSize),
        )
        acquired = true
        if (cancelled) {
          releaseOnce()
          return
        }
        setSrc(url)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
      releaseOnce()
    }
  }, [client, mxcUrl, mediaSize])

  if (failed) {
    const fallback = (alt || title || '').trim()
    if (fallback && /\p{Extended_Pictographic}/u.test(fallback)) {
      return <>{renderTwemojiString(fallback)}</>
    }
    return (
      <span
        className="tg-emoticon tg-emoticon--missing"
        title={title || alt || 'Смайл'}
      >
        ▢
      </span>
    )
  }

  if (!src) {
    return <span className="tg-emoticon tg-emoticon--pending" aria-hidden />
  }

  return (
    <img
      src={src}
      alt={alt || ''}
      title={title || alt}
      className="tg-emoticon"
      style={{ height, width: 'auto', maxWidth: 48 }}
      draggable={false}
    />
  )
}

function renderNodes(
  nodes: NodeListOf<ChildNode> | ChildNode[],
  keyPrefix: string,
  onUserClick?: (userId: string) => void,
): ReactNode[] {
  const out: ReactNode[] = []
  Array.from(nodes).forEach((node, i) => {
    const key = `${keyPrefix}.${i}`
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      // Skip object-replacement placeholders — the <img> carries the real content
      if (isPlaceholderBody(text)) return
      if (text) out.push(<span key={key}>{renderTwemojiString(text)}</span>)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toUpperCase()

    if (tag === 'MX-REPLY') return

    if (!ALLOWED_TAGS.has(tag)) {
      out.push(...renderNodes(el.childNodes, key, onUserClick))
      return
    }

    if (tag === 'BR') {
      out.push(<br key={key} />)
      return
    }

    if (tag === 'IMG') {
      const src = el.getAttribute('src')
      // Element / Nheko / others: custom emoji = mxc img (with or without data-mx-emoticon)
      if (isMxcUrl(src)) {
        const rawH = Number(
          el.getAttribute('height') || el.getAttribute('data-mx-height'),
        )
        const height =
          Number.isFinite(rawH) && rawH > 0 ? Math.min(48, rawH) : 32
        out.push(
          <MxEmoticonImg
            key={key}
            mxcUrl={src}
            alt={el.getAttribute('alt') || ''}
            title={el.getAttribute('title') || undefined}
            height={height}
          />,
        )
      }
      return
    }

    const children = renderNodes(el.childNodes, key, onUserClick)

    if (tag === 'A') {
      const href = el.getAttribute('href') || ''
      const userId = userIdFromMatrixTo(href)
      if (userId) {
        out.push(
          <button
            key={key}
            type="button"
            className="tg-mention inline align-baseline font-medium hover:underline cursor-pointer px-1 py-0.5 rounded transition-colors"
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
            {children}
          </button>,
        )
        return
      }
      out.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-hover underline underline-offset-2 hover:text-accent-fg"
        >
          {children}
        </a>,
      )
      return
    }

    if (tag === 'CODE') {
      out.push(
        <code key={key} className="tg-md-code-inline">
          {children}
        </code>,
      )
      return
    }

    if (tag === 'PRE') {
      out.push(
        <pre key={key} className="tg-md-pre">
          {children}
        </pre>,
      )
      return
    }

    if (tag === 'BLOCKQUOTE') {
      const isForward =
        el.getAttribute('data-mx-forward') === '1' ||
        !!el.querySelector('a[href*="matrix.to/#/"]')
      out.push(
        <blockquote
          key={key}
          className={isForward ? 'tg-forward-header' : 'tg-md-quote'}
        >
          {isForward ? (
            <>
              <span className="tg-forward-label" aria-hidden>
                Переслано
              </span>
              <span className="tg-forward-meta">{children}</span>
            </>
          ) : (
            <>
              <span className="tg-md-quote-bar" aria-hidden />
              <span className="tg-md-quote-text">{children}</span>
            </>
          )}
        </blockquote>,
      )
      return
    }

    if (tag === 'FONT') {
      const color = el.getAttribute('color') || undefined
      out.push(
        <span key={key} style={color ? { color } : undefined}>
          {children}
        </span>,
      )
      return
    }

    if (tag === 'U') {
      out.push(
        <u key={key} className="underline underline-offset-2">
          {children}
        </u>,
      )
      return
    }

    if (tag === 'SPAN' && el.hasAttribute('data-mx-spoiler')) {
      out.push(
        <SpoilerText key={key}>{children}</SpoilerText>,
      )
      return
    }

    const Wrapper =
      tag === 'STRONG' || tag === 'B'
        ? 'strong'
        : tag === 'EM' || tag === 'I'
          ? 'em'
          : tag === 'DEL'
            ? 'del'
            : tag === 'P'
              ? 'p'
              : tag === 'UL'
                ? 'ul'
                : tag === 'OL'
                  ? 'ol'
                  : tag === 'LI'
                    ? 'li'
                    : 'span'

    out.push(
      <Wrapper
        key={key}
        className={clsx(
          tag === 'P' && 'whitespace-pre-wrap',
          tag === 'UL' && 'list-disc pl-4 my-1 space-y-0.5',
          tag === 'OL' && 'list-decimal pl-4 my-1 space-y-0.5',
          (tag === 'STRONG' || tag === 'B') && 'font-semibold',
          (tag === 'EM' || tag === 'I') && 'italic',
          tag === 'DEL' && 'line-through opacity-70',
        )}
      >
        {children}
      </Wrapper>,
    )
  })
  return out
}

type MessageBodyProps = {
  content: Record<string, unknown>
  className?: string
  members?: MentionMember[]
  onUserClick?: (userId: string) => void
  plainText?: string
}

/**
 * Renders Matrix text: formatted_body (custom HTML + mxc emoticons) when useful,
 * otherwise markdown plain body + Twemoji.
 */
export function MessageBody({
  content,
  className,
  members = [],
  onUserClick,
  plainText,
}: MessageBodyProps) {
  const body =
    plainText ?? (typeof content.body === 'string' ? content.body : '')
  const format = content.format
  const formatted =
    typeof content.formatted_body === 'string' ? content.formatted_body : null

  const htmlNodes = useMemo(() => {
    if (!formatted) return null
    if (typeof DOMParser === 'undefined') return null
    const cleaned = stripMxReply(formatted).trim()
    if (!cleaned) return null
    const hasMedia =
      /mxc:\/\//i.test(cleaned) ||
      /data-mx-emoticon/i.test(cleaned) ||
      /<\/?img\b/i.test(cleaned)
    // Always honor Matrix HTML when declared — Telegram bridge custom emoji
    // lives here even when `body` looks like a normal character.
    const looksUseful =
      format === 'org.matrix.custom.html' ||
      hasMedia ||
      /<\/?(?:a|code|pre|blockquote|ol|ul|li|table|strong|em|u|del|span)\b/i.test(
        cleaned,
      )
    if (!looksUseful) return null
    // Skip HTML only for plain styled text without media (prefer markdown).
    if (
      format !== 'org.matrix.custom.html' &&
      !hasMedia &&
      !isBridgeEmojiPlaceholder(body) &&
      !/<\/?(?:a|code|pre|blockquote|strong|em|u|del|span)\b/i.test(cleaned)
    ) {
      return null
    }
    try {
      const doc = new DOMParser().parseFromString(
        `<div id="mx-root">${cleaned}</div>`,
        'text/html',
      )
      const root = doc.getElementById('mx-root')
      if (!root) return null
      return renderNodes(root.childNodes, 'r', onUserClick)
    } catch {
      return null
    }
  }, [format, formatted, body, onUserClick])

  const bodyHex = useMemo(() => {
    if (!body || body.length > 16) return undefined
    return [...body]
      .map((c) => (c.codePointAt(0) ?? 0).toString(16))
      .join(' ')
  }, [body])

  if (htmlNodes && htmlNodes.length > 0) {
    const first = htmlNodes[0]
    const leadingQuote =
      isValidElement(first) &&
      typeof first.props === 'object' &&
      first.props &&
      'className' in first.props &&
      first.props.className === 'tg-md-quote'
        ? first
        : null
    const restRaw = leadingQuote ? htmlNodes.slice(1) : htmlNodes
    const rest = leadingQuote
      ? restRaw.filter((node, i) => {
          if (i > 0) return true
          return !(isValidElement(node) && node.type === 'br')
        })
      : restRaw

    return (
      <div
        className={clsx(
          'tg-md tg-msg-body',
          leadingQuote && 'tg-msg-body--quoted',
          className,
        )}
        data-mx-body-hex={bodyHex}
        data-mx-has-html="1"
      >
        {leadingQuote}
        {rest.length > 0 ? (
          leadingQuote ? (
            <div className="tg-msg-body-main">{rest}</div>
          ) : (
            rest
          )
        ) : null}
      </div>
    )
  }

  // Avoid showing lone object-replacement / empty glyph when HTML failed
  if (isBridgeEmojiPlaceholder(body)) {
    return (
      <div
        className={clsx('tg-md tg-msg-body text-white/35 italic', className)}
        data-mx-body-hex={bodyHex}
        title={bodyHex ? `placeholder ${bodyHex}` : undefined}
      >
        Смайл
      </div>
    )
  }

  return (
    <MessageMarkdown
      text={body}
      className={clsx('tg-msg-body', className)}
      members={members}
      onUserClick={onUserClick}
    />
  )
}
