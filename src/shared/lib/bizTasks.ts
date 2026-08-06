import { create } from 'zustand'
import {
  ClientEvent,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk'
import { showAppToast } from '@/shared/lib/appToast'

export const BIZ_TASKS_STORAGE_KEY = 'planetar-biz-tasks'
/** Matrix account_data type — syncs across devices for the logged-in user. */
export const BIZ_TASKS_ACCOUNT_DATA_TYPE = 'app.planetar.biz_tasks'

export type BizTaskLinkKind = 'request' | 'reply'

/** List placement: active workspace vs archive (separate from pipeline). */
export type BizTaskListStatus = 'active' | 'archived'

/** BizDev pipeline statuses (цветные чипы в UI). */
export type BizTaskPipelineStatus =
  | 'active'
  | 'waiting'
  | 'no_offers'
  | 'done'

/** @deprecated use BizTaskPipelineStatus — kept for call-site aliases */
export type BizTaskStatus = BizTaskPipelineStatus

export const BIZ_TASK_PIPELINE_STATUSES: readonly BizTaskPipelineStatus[] = [
  'active',
  'waiting',
  'no_offers',
  'done',
] as const

/** Alias used by TaskManager UI */
export const BIZ_TASK_STATUSES = BIZ_TASK_PIPELINE_STATUSES

export const BIZ_TASK_PIPELINE_LABEL: Record<BizTaskPipelineStatus, string> = {
  active: 'В работе',
  waiting: 'Ожидаю',
  no_offers: 'Нет предложений',
  done: 'Завершена',
}

export const BIZ_TASK_STATUS_LABEL = BIZ_TASK_PIPELINE_LABEL

export type BizTaskLinkedMessage = {
  id: string
  kind: BizTaskLinkKind
  roomId: string
  roomName: string
  eventId: string
  senderId?: string
  senderName?: string
  body: string
  ts: number
}

export type BizTask = {
  /** Internal stable id */
  id: string
  /** Human-facing tag / ticket id (#TAG, [ID], …) */
  tag: string
  /** Question / summary */
  title: string
  /** active workspace | archive — NOT the colored pipeline chip */
  status: BizTaskListStatus
  /** Colored bizdev pipeline chip */
  pipelineStatus: BizTaskPipelineStatus
  createdAt: number
  updatedAt: number
  links: BizTaskLinkedMessage[]
}

export type BizTaskMessageRef = {
  roomId: string
  roomName: string
  eventId: string
  body: string
  senderId?: string
  senderName?: string
  ts?: number
}

export type BizTaskListTab = BizTaskListStatus

export type BizTaskFilters = {
  /** active | archived tab */
  list: BizTaskListTab
  /** Match title + tag/ID only */
  query: string
  /** Reply-room name; empty = all chats */
  roomName: string
}

type BizTasksAccountContent = {
  version: 1
  tasks: unknown[]
  updatedAt: number
}

export function isBizTaskPipelineStatus(
  v: unknown,
): v is BizTaskPipelineStatus {
  return (
    v === 'active' ||
    v === 'waiting' ||
    v === 'no_offers' ||
    v === 'done'
  )
}

export function normalizeBizTaskPipelineStatus(
  v: unknown,
): BizTaskPipelineStatus {
  return isBizTaskPipelineStatus(v) ? v : 'active'
}

/** Alias for existing UI imports */
export const normalizeBizTaskStatus = normalizeBizTaskPipelineStatus
export const isBizTaskStatus = isBizTaskPipelineStatus

export function isBizTaskListStatus(v: unknown): v is BizTaskListStatus {
  return v === 'active' || v === 'archived'
}

export function normalizeBizTaskListStatus(v: unknown): BizTaskListStatus {
  return isBizTaskListStatus(v) ? v : 'active'
}

/** Extract #TAG, [ID], ID:xxx from message text. */
export function extractTaskTag(text: string): string | null {
  const raw = text.trim()
  if (!raw) return null
  const hash = raw.match(/(?:^|\s)#([A-Za-zА-Яа-я0-9][\wА-Яа-я.-]{1,40})/)
  if (hash?.[1]) return hash[1]
  const bracket = raw.match(/\[([A-Za-zА-Яа-я0-9][\wА-Яа-я.\/-]{1,40})\]/)
  if (bracket?.[1]) return bracket[1]
  const labeled = raw.match(
    /\b(?:ID|id|Id|№|ticket|Ticket)\s*[:#]?\s*([A-Za-zА-Яа-я0-9][\wА-Яа-я.-]{1,40})/,
  )
  if (labeled?.[1]) return labeled[1]
  return null
}

function summarizeTitle(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return 'Без названия'
  return one.length > max ? `${one.slice(0, max)}…` : one
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Migrate older shapes:
 * - `status` used to mean pipeline (active/waiting/…)
 * - now `status` = active|archived, pipeline lives in `pipelineStatus`
 */
function normalizeTask(raw: Record<string, unknown>): BizTask {
  const links = Array.isArray(raw.links)
    ? (raw.links as BizTaskLinkedMessage[])
    : []

  let listStatus: BizTaskListStatus = 'active'
  let pipeline: BizTaskPipelineStatus = 'active'

  if (isBizTaskListStatus(raw.status) && 'pipelineStatus' in raw) {
    listStatus = raw.status
    pipeline = normalizeBizTaskPipelineStatus(raw.pipelineStatus)
  } else if (raw.status === 'archived') {
    listStatus = 'archived'
    pipeline = normalizeBizTaskPipelineStatus(raw.pipelineStatus)
  } else if (isBizTaskPipelineStatus(raw.status) && !('pipelineStatus' in raw)) {
    // Legacy: status was the pipeline chip
    listStatus = 'active'
    pipeline = raw.status
  } else {
    listStatus = normalizeBizTaskListStatus(raw.status)
    pipeline = normalizeBizTaskPipelineStatus(raw.pipelineStatus)
  }

  if (raw.archived === true) listStatus = 'archived'

  return {
    id: String(raw.id),
    tag: String(raw.tag ?? ''),
    title: String(raw.title ?? ''),
    status: listStatus,
    pipelineStatus: pipeline,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    links,
  }
}

function isBizTaskShape(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const t = v as BizTask
  return (
    typeof t.id === 'string' &&
    typeof t.tag === 'string' &&
    typeof t.title === 'string' &&
    Array.isArray(t.links)
  )
}

function parseTasksArray(parsed: unknown): BizTask[] {
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(isBizTaskShape)
    .map((t) => normalizeTask(t as unknown as Record<string, unknown>))
}

function readLocalTasks(): BizTask[] {
  try {
    const raw = localStorage.getItem(BIZ_TASKS_STORAGE_KEY)
    if (!raw) return []
    return parseTasksArray(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

function persistLocal(tasks: BizTask[]) {
  try {
    localStorage.setItem(BIZ_TASKS_STORAGE_KEY, JSON.stringify(tasks))
  } catch {
    /* ignore quota */
  }
}

/** null = no account_data event yet (migrate local). Array = cloud snapshot (may be empty). */
function readAccountTasks(client: MatrixClient): BizTask[] | null {
  try {
    const ev = client.getAccountData(BIZ_TASKS_ACCOUNT_DATA_TYPE as never)
    if (!ev) return null
    const content = ev.getContent?.() as Partial<BizTasksAccountContent> | undefined
    if (!content || !Array.isArray(content.tasks)) return []
    return parseTasksArray(content.tasks)
  } catch (err) {
    console.warn('[bizTasks] failed to read account data', err)
    return null
  }
}

const PIPELINE_ORDER: Record<BizTaskPipelineStatus, number> = {
  active: 0,
  waiting: 1,
  no_offers: 2,
  done: 3,
}

function sortTasks(tasks: BizTask[]): BizTask[] {
  return [...tasks].sort((a, b) => {
    const byPipeline =
      PIPELINE_ORDER[normalizeBizTaskPipelineStatus(a.pipelineStatus)] -
      PIPELINE_ORDER[normalizeBizTaskPipelineStatus(b.pipelineStatus)]
    if (byPipeline !== 0) return byPipeline
    return b.updatedAt - a.updatedAt
  })
}

function taskMatchesQuery(task: BizTask, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    task.tag.toLowerCase().includes(q) ||
    task.title.toLowerCase().includes(q) ||
    `#${task.tag}`.toLowerCase().includes(q)
  )
}

function taskHasReplyFromRoom(task: BizTask, roomName: string): boolean {
  const name = roomName.trim().toLowerCase()
  if (!name) return true
  return task.links.some(
    (l) =>
      l.kind === 'reply' && l.roomName.trim().toLowerCase() === name,
  )
}

/** Unique chat names that appear as reply attachments (across given tasks). */
export function collectReplyRoomNames(tasks: BizTask[]): string[] {
  const set = new Set<string>()
  for (const t of tasks) {
    for (const l of t.links) {
      if (l.kind !== 'reply') continue
      const name = l.roomName.trim()
      if (name) set.add(name)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'))
}

export function filterBizTasks(
  tasks: BizTask[],
  filters: BizTaskFilters,
): BizTask[] {
  return sortTasks(
    tasks.filter(
      (t) =>
        normalizeBizTaskListStatus(t.status) === filters.list &&
        taskMatchesQuery(t, filters.query) &&
        taskHasReplyFromRoom(t, filters.roomName),
    ),
  )
}

let hydrateClient: MatrixClient | null = null
let applyingRemote = false
let cloudPersistTimer: ReturnType<typeof setTimeout> | null = null
let cloudPersistInFlight = false
let cloudPersistQueued: BizTask[] | null = null

async function persistAccountData(
  client: MatrixClient | null | undefined,
  tasks: BizTask[],
) {
  if (!client) return
  const content: BizTasksAccountContent = {
    version: 1,
    tasks,
    updatedAt: Date.now(),
  }
  try {
    await client.setAccountData(BIZ_TASKS_ACCOUNT_DATA_TYPE as never, content)
  } catch (err) {
    console.warn('[bizTasks] failed to persist account data', err)
  }
}

function flushCloudPersist() {
  if (cloudPersistInFlight) return
  const client = hydrateClient
  const tasks = cloudPersistQueued
  cloudPersistQueued = null
  if (!client || !tasks || applyingRemote) return
  cloudPersistInFlight = true
  void persistAccountData(client, tasks).finally(() => {
    cloudPersistInFlight = false
    if (cloudPersistQueued) flushCloudPersist()
  })
}

function scheduleCloudPersist(tasks: BizTask[]) {
  cloudPersistQueued = tasks
  if (cloudPersistTimer) clearTimeout(cloudPersistTimer)
  cloudPersistTimer = setTimeout(() => {
    cloudPersistTimer = null
    flushCloudPersist()
  }, 400)
}

/** Local cache always; Matrix account data when logged in (same UX). */
function persistTasks(tasks: BizTask[]) {
  persistLocal(tasks)
  if (!applyingRemote) scheduleCloudPersist(tasks)
}

function tasksSignature(tasks: BizTask[]): string {
  return tasks
    .map(
      (t) =>
        `${t.id}:${t.updatedAt}:${t.status}:${t.pipelineStatus}:${t.links.length}`,
    )
    .join('|')
}

async function syncFromClient(client: MatrixClient) {
  const remote = readAccountTasks(client)
  const local = readLocalTasks()

  if (remote !== null) {
    const sorted = sortTasks(remote)
    applyingRemote = true
    try {
      persistLocal(sorted)
      useBizTasksStore.setState({ tasks: sorted })
    } finally {
      applyingRemote = false
    }
    return
  }

  // No cloud event yet — keep local UI and migrate once.
  if (local.length > 0) {
    useBizTasksStore.setState({ tasks: sortTasks(local) })
    await persistAccountData(client, local)
  }
}

type BizTasksState = {
  tasks: BizTask[]
  panelOpen: boolean
  selectedTaskId: string | null
  hydrate: () => void
  /** Attach Matrix client: load/migrate account data + live sync. */
  bindClient: (client: MatrixClient | null) => () => void
  setPanelOpen: (open: boolean) => void
  selectTask: (id: string | null) => void
  createTaskFromMessage: (ref: BizTaskMessageRef) => BizTask
  addMessageToTask: (
    taskId: string,
    kind: BizTaskLinkKind,
    ref: BizTaskMessageRef,
  ) => boolean
  /** Colored pipeline chip (В работе / Ожидаю / …) */
  setTaskStatus: (taskId: string, pipelineStatus: BizTaskPipelineStatus) => void
  setPipelineStatus: (
    taskId: string,
    pipelineStatus: BizTaskPipelineStatus,
  ) => void
  /** Soft archive — does NOT delete */
  archiveTask: (taskId: string) => void
  restoreTask: (taskId: string) => void
  renameTask: (taskId: string, title: string) => void
  /** Hard delete — permanent */
  deleteTask: (taskId: string) => void
  filterTasks: (filters: BizTaskFilters) => BizTask[]
  /** @deprecated prefer filterTasks — title/tag search over all lists */
  searchTasks: (query: string) => BizTask[]
  activeTaskCount: () => number
}

export const useBizTasksStore = create<BizTasksState>((set, get) => ({
  tasks: [],
  panelOpen: false,
  selectedTaskId: null,

  hydrate: () => {
    const tasks = sortTasks(readLocalTasks())
    set({ tasks })
  },

  bindClient: (client) => {
    if (!client) {
      hydrateClient = null
      return () => {}
    }
    hydrateClient = client
    void syncFromClient(client)

    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() !== BIZ_TASKS_ACCOUNT_DATA_TYPE) return
      if (applyingRemote) return
      try {
        const content = event.getContent?.() as
          | Partial<BizTasksAccountContent>
          | undefined
        if (!content || !Array.isArray(content.tasks)) return
        const next = sortTasks(parseTasksArray(content.tasks))
        if (tasksSignature(next) === tasksSignature(get().tasks)) return
        applyingRemote = true
        try {
          persistLocal(next)
          set({ tasks: next })
        } finally {
          applyingRemote = false
        }
      } catch (err) {
        console.warn('[bizTasks] account data listener failed', err)
      }
    }

    client.on(ClientEvent.AccountData, onAccountData)
    return () => {
      client.removeListener(ClientEvent.AccountData, onAccountData)
      if (hydrateClient === client) hydrateClient = null
      if (cloudPersistTimer) {
        clearTimeout(cloudPersistTimer)
        cloudPersistTimer = null
      }
    }
  },

  setPanelOpen: (open) => {
    set({ panelOpen: open })
    if (open && !get().tasks.length) get().hydrate()
  },

  selectTask: (id) => set({ selectedTaskId: id }),

  createTaskFromMessage: (ref) => {
    const now = Date.now()
    const tag = extractTaskTag(ref.body) || `T${String(now).slice(-6)}`
    const title = summarizeTitle(ref.body)
    const link: BizTaskLinkedMessage = {
      id: newId('link'),
      kind: 'request',
      roomId: ref.roomId,
      roomName: ref.roomName,
      eventId: ref.eventId,
      senderId: ref.senderId,
      senderName: ref.senderName,
      body: ref.body.trim() || title,
      ts: ref.ts ?? now,
    }
    const task: BizTask = {
      id: newId('task'),
      tag,
      title,
      status: 'active',
      pipelineStatus: 'active',
      createdAt: now,
      updatedAt: now,
      links: [link],
    }
    const tasks = sortTasks([task, ...get().tasks])
    persistTasks(tasks)
    set({ tasks, selectedTaskId: task.id })
    showAppToast(`Задача #${tag} успешно создана`)
    return task
  },

  addMessageToTask: (taskId, kind, ref) => {
    const tasks = get().tasks
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return false
    const now = Date.now()
    const link: BizTaskLinkedMessage = {
      id: newId('link'),
      kind,
      roomId: ref.roomId,
      roomName: ref.roomName,
      eventId: ref.eventId,
      senderId: ref.senderId,
      senderName: ref.senderName,
      body: ref.body.trim() || '…',
      ts: ref.ts ?? now,
    }
    const prev = tasks[idx]
    if (
      prev.links.some(
        (l) =>
          l.eventId === link.eventId &&
          l.kind === kind &&
          l.roomId === link.roomId,
      )
    ) {
      showAppToast('Сообщение уже привязано к этой задаче')
      return false
    }
    const next: BizTask = {
      ...prev,
      updatedAt: now,
      links: [...prev.links, link],
    }
    const updated = [...tasks]
    updated[idx] = next
    const sorted = sortTasks(updated)
    persistTasks(sorted)
    set({ tasks: sorted })
    showAppToast(
      kind === 'reply'
        ? `Ответ добавлен в #${next.tag}`
        : `Запрос добавлен в #${next.tag}`,
    )
    return true
  },

  setTaskStatus: (taskId, pipelineStatus) => {
    get().setPipelineStatus(taskId, pipelineStatus)
  },

  setPipelineStatus: (taskId, pipelineStatus) => {
    const tasks = get().tasks
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return
    const prev = tasks[idx]
    if (prev.pipelineStatus === pipelineStatus) return
    const next: BizTask = {
      ...prev,
      pipelineStatus,
      updatedAt: Date.now(),
    }
    const updated = [...tasks]
    updated[idx] = next
    const sorted = sortTasks(updated)
    persistTasks(sorted)
    set({ tasks: sorted })
    showAppToast(`#${next.tag}: ${BIZ_TASK_PIPELINE_LABEL[pipelineStatus]}`)
  },

  archiveTask: (taskId) => {
    const tasks = get().tasks
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return
    const prev = tasks[idx]
    if (prev.status === 'archived') return
    const next: BizTask = {
      ...prev,
      status: 'archived',
      updatedAt: Date.now(),
    }
    const updated = [...tasks]
    updated[idx] = next
    persistTasks(updated)
    set({ tasks: updated })
    showAppToast(`#${next.tag} в архиве`)
  },

  restoreTask: (taskId) => {
    const tasks = get().tasks
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return
    const prev = tasks[idx]
    if (prev.status === 'active') return
    const next: BizTask = {
      ...prev,
      status: 'active',
      updatedAt: Date.now(),
    }
    const updated = [...tasks]
    updated[idx] = next
    persistTasks(updated)
    set({ tasks: updated })
    showAppToast(`#${next.tag} восстановлена`)
  },

  renameTask: (taskId, title) => {
    const trimmed = title.trim()
    if (!trimmed) return
    const tasks = get().tasks.map((t) =>
      t.id === taskId
        ? { ...t, title: summarizeTitle(trimmed), updatedAt: Date.now() }
        : t,
    )
    persistTasks(tasks)
    set({ tasks: sortTasks(tasks) })
  },

  deleteTask: (taskId) => {
    const tasks = get().tasks.filter((t) => t.id !== taskId)
    persistTasks(tasks)
    set({
      tasks,
      selectedTaskId:
        get().selectedTaskId === taskId
          ? (tasks[0]?.id ?? null)
          : get().selectedTaskId,
    })
  },

  filterTasks: (filters) => filterBizTasks(get().tasks, filters),

  searchTasks: (query) => {
    const q = query.trim().toLowerCase()
    const tasks = get().tasks
    if (!q) return tasks
    return tasks.filter((t) => taskMatchesQuery(t, q))
  },

  activeTaskCount: () =>
    get().tasks.filter((t) => normalizeBizTaskListStatus(t.status) === 'active')
      .length,
}))

/** Call once at app start (idempotent) — loads local cache instantly. */
export function initBizTasks() {
  useBizTasksStore.getState().hydrate()
}
