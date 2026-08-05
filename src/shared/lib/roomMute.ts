import {
  ConditionKind,
  PushRuleActionName,
  PushRuleKind,
  type IPushRule,
  type MatrixClient,
} from 'matrix-js-sdk'

function isDontNotifyRule(rule: IPushRule): boolean {
  const actions = rule.actions ?? []
  if (actions.length === 0) return true
  return (
    actions.length === 1 && actions[0] === PushRuleActionName.DontNotify
  )
}

/** Element-style full mute: override rule matching one room_id with dont_notify. */
export function isOverrideRoomMuteRule(rule: IPushRule, roomId?: string): boolean {
  if (!rule.enabled || !isDontNotifyRule(rule)) return false
  const conditions = rule.conditions
  if (!conditions || conditions.length !== 1) return false
  const c = conditions[0]
  if (c.kind !== ConditionKind.EventMatch || c.key !== 'room_id') return false
  const pattern = typeof c.pattern === 'string' ? c.pattern : undefined
  if (roomId != null) return pattern === roomId || rule.rule_id === roomId
  return typeof pattern === 'string' && pattern.length > 0
}

export function findOverrideMuteRule(
  client: MatrixClient,
  roomId: string,
): IPushRule | undefined {
  const overrides = client.pushRules?.global?.override
  if (!overrides) return undefined
  return overrides.find((rule) => isOverrideRoomMuteRule(rule, roomId))
}

export function isRoomMutedByPushRules(
  client: MatrixClient,
  roomId: string,
): boolean {
  try {
    if (findOverrideMuteRule(client, roomId)) return true
    const roomRule = client.getRoomPushRule?.('global', roomId)
    return !!(roomRule?.enabled && isDontNotifyRule(roomRule))
  } catch {
    return false
  }
}

/** Room ids muted via override (full mute) or room-kind dont_notify. */
export function listMutedRoomIdsFromPushRules(client: MatrixClient): string[] {
  const ids = new Set<string>()
  try {
    const overrides = client.pushRules?.global?.override ?? []
    for (const rule of overrides) {
      if (!isOverrideRoomMuteRule(rule)) continue
      const pattern = rule.conditions?.[0]?.pattern
      const id =
        typeof pattern === 'string' && pattern
          ? pattern
          : typeof rule.rule_id === 'string'
            ? rule.rule_id
            : null
      if (id) ids.add(id)
    }
    const roomRules = client.pushRules?.global?.room ?? []
    for (const rule of roomRules) {
      if (rule.enabled && isDontNotifyRule(rule) && typeof rule.rule_id === 'string') {
        ids.add(rule.rule_id)
      }
    }
  } catch {
    /* pushRules not ready */
  }
  return [...ids]
}

async function refreshPushRules(client: MatrixClient): Promise<void> {
  try {
    client.pushRules = await client.getPushRules()
  } catch (err) {
    console.error('Failed to refresh push rules', err)
  }
}

/**
 * Mute room on the homeserver (Element-compatible override dont_notify).
 * Also removes a room-kind rule so mute is unambiguous.
 */
export async function setRoomMutedOnServer(
  client: MatrixClient,
  roomId: string,
  muted: boolean,
): Promise<void> {
  if (muted) {
    const ops: Promise<unknown>[] = []
    try {
      const roomRule = client.getRoomPushRule('global', roomId)
      if (roomRule) {
        ops.push(
          client.deletePushRule('global', PushRuleKind.RoomSpecific, roomRule.rule_id),
        )
      }
    } catch {
      /* ignore */
    }
    const existing = findOverrideMuteRule(client, roomId)
    if (existing) {
      ops.push(
        client.deletePushRule('global', PushRuleKind.Override, existing.rule_id),
      )
    }
    if (ops.length) await Promise.all(ops)

    await client.addPushRule('global', PushRuleKind.Override, roomId, {
      conditions: [
        {
          kind: ConditionKind.EventMatch,
          key: 'room_id',
          pattern: roomId,
        },
      ],
      actions: [PushRuleActionName.DontNotify],
    })
  } else {
    const ops: Promise<unknown>[] = []
    const overrideMute = findOverrideMuteRule(client, roomId)
    if (overrideMute) {
      ops.push(
        client.deletePushRule(
          'global',
          PushRuleKind.Override,
          overrideMute.rule_id,
        ),
      )
    }
    try {
      const roomRule = client.getRoomPushRule('global', roomId)
      if (roomRule && isDontNotifyRule(roomRule)) {
        ops.push(
          client.deletePushRule(
            'global',
            PushRuleKind.RoomSpecific,
            roomRule.rule_id,
          ),
        )
      }
    } catch {
      /* ignore */
    }
    if (ops.length) await Promise.all(ops)
  }

  await refreshPushRules(client)
}
