import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, Check, Loader2, UserPlus, Users, X } from 'lucide-react'
import { clsx } from 'clsx'
import { format } from 'date-fns'
import { ru } from 'date-fns/locale'
import {
  useInvitesStore,
  type RoomInviteInfo,
} from '@/entities/session/model/invites.store'
import { useSessionStore } from '@/entities/session/model/session'
import { MxcAvatar } from '@/shared/ui/MxcAvatar'
import { clampMenuPosition } from '@/shared/lib/clampMenuPosition'

function inviteSubtitle(invite: RoomInviteInfo): string {
  if (invite.isDirect) {
    return invite.inviterName
      ? `Личное сообщение от ${invite.inviterName}`
      : 'Личное сообщение'
  }
  if (invite.inviterName) {
    return `${invite.inviterName} приглашает в группу`
  }
  return 'Приглашение в группу'
}

function InviteRow({
  invite,
  busy,
  onAccept,
  onDecline,
}: {
  invite: RoomInviteInfo
  busy: boolean
  onAccept: () => void
  onDecline: () => void
}) {
  const client = useSessionStore((s) => s.client)
  const time = invite.ts
    ? format(invite.ts, 'd MMM, HH:mm', { locale: ru })
    : ''

  return (
    <div className="tg-invite-row">
      <MxcAvatar
        client={client}
        mxcUrl={invite.avatarMxc}
        label={invite.inviterName || invite.name}
        size={40}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="tg-invite-title truncate">{invite.name}</div>
            <div className="tg-invite-sub mt-0.5 truncate">
              {inviteSubtitle(invite)}
            </div>
          </div>
          {time && (
            <span className="tg-invite-time shrink-0 pt-0.5">{time}</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            className="tg-invite-btn tg-invite-btn--accept"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            )}
            Принять
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDecline}
            className="tg-invite-btn tg-invite-btn--decline"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.5} />
            Отклонить
          </button>
        </div>
      </div>
    </div>
  )
}

export function InvitesBell() {
  const invites = useInvitesStore((s) => s.invites)
  const busyRoomIds = useInvitesStore((s) => s.busyRoomIds)
  const error = useInvitesStore((s) => s.error)
  const accept = useInvitesStore((s) => s.actions.accept)
  const decline = useInvitesStore((s) => s.actions.decline)
  const refresh = useInvitesStore((s) => s.actions.refresh)

  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const [ready, setReady] = useState(false)

  const count = invites.length

  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  useLayoutEffect(() => {
    if (!open) return
    setReady(false)
    const btn = btnRef.current
    const panel = panelRef.current
    if (!btn || !panel) return
    const place = () => {
      const br = btn.getBoundingClientRect()
      const size = panel.getBoundingClientRect()
      const preferredX = br.right + 10
      const preferredY = Math.max(8, br.top - 8)
      setPos(clampMenuPosition(preferredX, preferredY, size.width, size.height))
      setReady(true)
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [open, invites.length, error])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onPointer = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={clsx(
          'tg-nav-btn relative group',
          open && 'tg-nav-btn--active',
          count > 0 && 'tg-nav-btn--notify',
        )}
        title={count > 0 ? `Приглашения (${count})` : 'Приглашения'}
        aria-label="Приглашения"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell
          className="w-[18px] h-[18px] tg-nav-icon transition-colors"
          strokeWidth={1.75}
        />
        {count > 0 && (
          <span className="tg-nav-badge">{count > 99 ? '99+' : count}</span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Приглашения в чаты"
            className="tg-invites-panel fixed z-[1000]"
            style={{
              left: pos.left,
              top: pos.top,
              visibility: ready ? 'visible' : 'hidden',
            }}
          >
            <div className="tg-invites-head">
              <div className="flex items-center gap-2 min-w-0">
                <UserPlus className="w-4 h-4 text-accent-hover shrink-0" />
                <span className="tg-invites-head-title truncate">
                  Приглашения
                </span>
              </div>
              {count > 0 && <span className="tg-invites-count">{count}</span>}
            </div>

            {error && <div className="tg-invites-error">{error}</div>}

            <div className="tg-invites-body">
              {invites.length === 0 ? (
                <div className="tg-invites-empty">
                  <Users
                    className="tg-invites-empty-icon w-8 h-8 mb-2"
                    strokeWidth={1.5}
                  />
                  <div className="tg-invites-empty-title">
                    Нет новых приглашений
                  </div>
                  <div className="tg-invites-empty-hint mt-1 max-w-[220px] text-center">
                    Когда вас пригласят в чат, это появится здесь
                  </div>
                </div>
              ) : (
                invites.map((invite) => (
                  <InviteRow
                    key={invite.roomId}
                    invite={invite}
                    busy={!!busyRoomIds[invite.roomId]}
                    onAccept={() => {
                      void accept(invite.roomId).then(() => {
                        const st = useInvitesStore.getState()
                        if (st.error) return
                        // Keep panel open if more invites remain
                        if (st.invites.length === 0) setOpen(false)
                      })
                    }}
                    onDecline={() => {
                      void decline(invite.roomId)
                    }}
                  />
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
