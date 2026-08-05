import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Check, Loader2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import {
  buildPollEndContent,
  buildPollResponseContent,
  fetchPollRelatedEvents,
  parsePollStart,
  tallyPollVotes,
  type PollTally,
} from '@/shared/lib/polls'

type PollCardProps = {
  event: MatrixEvent
  room: Room
  client: MatrixClient
  myUserId: string | null
  isOwn: boolean
  pollTick?: number
  onChanged?: () => void
}

export function PollCard({
  event,
  room,
  client,
  myUserId,
  isOwn,
  pollTick = 0,
  onChanged,
}: PollCardProps) {
  const pollId = event.getId() || ''
  const parsed = useMemo(() => parsePollStart(event), [event, pollTick])
  const [tally, setTally] = useState<PollTally>({
    counts: {},
    totalVoters: 0,
    myAnswers: [],
    ended: false,
  })
  const [pending, setPending] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!pollId) return
    const { responses, endEvent } = await fetchPollRelatedEvents(
      client,
      room,
      pollId,
    )
    setTally(
      tallyPollVotes(responses, myUserId, endEvent?.getTs() ?? null),
    )
  }, [client, room, pollId, myUserId])

  useEffect(() => {
    void refresh()
  }, [refresh, pollTick])

  if (!parsed) {
    return (
      <div className="tg-muted text-[13px] px-1 py-1">Некорректный опрос</div>
    )
  }

  const multi = parsed.maxSelections > 1
  const selection = pending ?? tally.myAnswers
  const ended = tally.ended
  const total = Math.max(tally.totalVoters, 1)

  const toggle = (answerId: string) => {
    if (ended || busy) return
    setError(null)
    setPending((prev) => {
      const cur = prev ?? tally.myAnswers
      if (multi) {
        if (cur.includes(answerId)) return cur.filter((id) => id !== answerId)
        if (cur.length >= parsed.maxSelections) return cur
        return [...cur, answerId]
      }
      return cur.includes(answerId) ? [] : [answerId]
    })
  }

  const submitVote = async () => {
    if (!pollId || ended || busy) return
    const answers = pending ?? tally.myAnswers
    if (!answers.length) {
      setError('Выберите вариант')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await client.sendEvent(
        room.roomId,
        'org.matrix.msc3381.poll.response' as any,
        buildPollResponseContent(pollId, answers) as any,
      )
      setPending(null)
      await refresh()
      onChanged?.()
    } catch (err) {
      console.error('Poll vote failed', err)
      setError('Не удалось проголосовать')
    } finally {
      setBusy(false)
    }
  }

  const endPoll = async () => {
    if (!pollId || ended || busy || !isOwn) return
    setBusy(true)
    setError(null)
    try {
      await client.sendEvent(
        room.roomId,
        'org.matrix.msc3381.poll.end' as any,
        buildPollEndContent(pollId) as any,
      )
      await refresh()
      onChanged?.()
    } catch (err) {
      console.error('Poll end failed', err)
      setError('Не удалось завершить опрос')
    } finally {
      setBusy(false)
    }
  }

  const dirty =
    pending != null &&
    (pending.length !== tally.myAnswers.length ||
      pending.some((id) => !tally.myAnswers.includes(id)))

  return (
    <div className="tg-poll-card w-full min-w-[220px] max-w-[320px]">
      <div className="flex items-start gap-2 mb-2.5">
        <BarChart3 className="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
        <div className="tg-title text-[14px] font-semibold leading-snug">
          {parsed.question}
        </div>
      </div>

      <div className="space-y-1.5">
        {parsed.answers.map((answer) => {
          const count = tally.counts[answer.id] || 0
          const pct =
            tally.totalVoters === 0
              ? 0
              : Math.round((count / total) * 100)
          const selected = selection.includes(answer.id)
          return (
            <button
              key={answer.id}
              type="button"
              disabled={ended || busy}
              onClick={() => toggle(answer.id)}
              className={clsx(
                'tg-poll-option relative w-full text-left rounded-xl px-3 py-2 overflow-hidden transition-colors',
                selected && 'tg-poll-option--selected',
                ended && 'opacity-90',
              )}
            >
              <span
                className="tg-poll-option-bar absolute inset-y-0 left-0"
                style={{ width: `${pct}%` }}
              />
              <span className="relative z-[1] flex items-center gap-2">
                <span
                  className={clsx(
                    'w-4 h-4 rounded-full border flex items-center justify-center shrink-0',
                    selected
                      ? 'border-transparent bg-accent text-[10px]'
                      : 'border-hairline-strong',
                  )}
                >
                  {selected && (
                    <Check
                      className="w-2.5 h-2.5 text-[var(--color-on-accent)]"
                      strokeWidth={3}
                    />
                  )}
                </span>
                <span className="tg-title text-[13px] flex-1 min-w-0 truncate">
                  {answer.text}
                </span>
                <span className="tg-muted text-[11.5px] tabular-nums shrink-0">
                  {count}
                  {tally.totalVoters > 0 ? ` · ${pct}%` : ''}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="tg-muted text-[11.5px] mt-2.5 flex items-center gap-2 flex-wrap">
        <span>
          {tally.totalVoters}{' '}
          {tally.totalVoters === 1
            ? 'голос'
            : tally.totalVoters > 1 && tally.totalVoters < 5
              ? 'голоса'
              : 'голосов'}
        </span>
        {multi && <span>· несколько</span>}
        {ended && <span>· завершён</span>}
      </div>

      {!ended && (
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={busy || (!dirty && tally.myAnswers.length > 0 && pending == null)}
            onClick={() => void submitVote()}
            className="h-8 px-3 rounded-lg text-[12.5px] font-semibold border border-accent/50 bg-accent/35 hover:bg-accent/50 text-chatText inline-flex items-center gap-1.5 disabled:opacity-40"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            {tally.myAnswers.length ? 'Изменить голос' : 'Голосовать'}
          </button>
          {isOwn && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void endPoll()}
              className="h-8 px-3 rounded-lg text-[12.5px] font-medium border border-hairline bg-surface-inset hover:bg-surface-inset text-ink disabled:opacity-40"
            >
              Завершить
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="tg-admin-dialog-error mt-2 text-[12px] rounded-lg px-2.5 py-1.5">
          {error}
        </div>
      )}
    </div>
  )
}
