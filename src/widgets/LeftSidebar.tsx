import { useState, useMemo, type ReactNode } from 'react'
import {
  Send,
  Users,
  MessagesSquare,
  Cog,
  CheckCheck,
  LayoutGrid,
  ClipboardList,
} from 'lucide-react'
import { clsx } from 'clsx'
import {
  useRoomStore,
  type RoomFilter,
  isDirectRoom,
  isGroupRoom,
  getRoomUnread,
  getSpacesChildUnreadTotal,
} from '@/entities/session/model/room.store'
import { useSessionStore } from '@/entities/session/model/session'
import { useBizTasksStore } from '@/shared/lib/bizTasks'
import { AppContextMenu } from '@/shared/ui/AppContextMenu'
import { SettingsModal } from './SettingsModal'
import { InvitesBell } from './InvitesBell'
import { SyncStatusNav } from './SyncStatusBar'

const iconStyle = 'w-[18px] h-[18px] tg-nav-icon transition-colors'

export function LeftSidebar() {
  const rooms = useRoomStore((state) => state.rooms)
  const spaceRooms = useRoomStore((state) => state.spaceRooms)
  const roomFilter = useRoomStore((state) => state.roomFilter)
  const setRoomFilter = useRoomStore((state) => state.actions.setRoomFilter)
  const markAllRoomsAsRead = useRoomStore(
    (state) => state.actions.markAllRoomsAsRead,
  )
  const client = useSessionStore((state) => state.client)
  const tasksPanelOpen = useBizTasksStore((s) => s.panelOpen)
  const setTasksPanelOpen = useBizTasksStore((s) => s.setPanelOpen)
  const taskCount = useBizTasksStore((s) =>
    s.tasks.filter((t) => t.status !== 'archived').length,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [navMenu, setNavMenu] = useState<{ x: number; y: number } | null>(null)
  const [readAllBusy, setReadAllBusy] = useState(false)

  const directUnread = rooms
    .filter(isDirectRoom)
    .reduce((sum, room) => sum + getRoomUnread(room), 0)
  const groupsUnread = rooms
    .filter(isGroupRoom)
    .reduce((sum, room) => sum + getRoomUnread(room), 0)
  const spacesUnread = useMemo(() => {
    if (!client) return 0
    return getSpacesChildUnreadTotal(
      spaceRooms,
      client,
      client.getUserId() ?? null,
    )
  }, [spaceRooms, client])
  const totalUnread = rooms.reduce(
    (sum, room) => sum + getRoomUnread(room),
    0,
  )

  const folders: {
    id: RoomFilter
    name: string
    icon: ReactNode
    count?: number
  }[] = [
    {
      id: 'all',
      name: 'All Chats',
      icon: <MessagesSquare className={iconStyle} strokeWidth={1.75} />,
      count: totalUnread || undefined,
    },
    {
      id: 'direct',
      name: 'Direct',
      icon: <Send className={iconStyle} strokeWidth={1.75} />,
      count: directUnread || undefined,
    },
    {
      id: 'groups',
      name: 'Groups',
      icon: <Users className={iconStyle} strokeWidth={1.75} />,
      count: groupsUnread || undefined,
    },
    {
      id: 'spaces',
      name: 'Пространства',
      icon: <LayoutGrid className={iconStyle} strokeWidth={1.75} />,
      count: spacesUnread || undefined,
    },
  ]

  const markAllAsRead = () => {
    if (readAllBusy || totalUnread === 0) return
    setReadAllBusy(true)
    void markAllRoomsAsRead().finally(() => setReadAllBusy(false))
  }

  return (
    <>
      <div className="tg-sidebar w-[56px] shrink-0 flex flex-col items-center py-3 border-r">
        <div className="flex flex-col gap-2">
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className={clsx(
                'tg-nav-btn relative group',
                !tasksPanelOpen &&
                  roomFilter === folder.id &&
                  'tg-nav-btn--active',
              )}
              title={folder.name}
              onClick={() => {
                setTasksPanelOpen(false)
                setRoomFilter(folder.id)
              }}
              onContextMenu={(e) => {
                if (folder.id !== 'all') return
                e.preventDefault()
                e.stopPropagation()
                setNavMenu({ x: e.clientX, y: e.clientY })
              }}
            >
              {folder.icon}
              {folder.count != null && folder.count > 0 && (
                <span className="tg-nav-badge">
                  {folder.count > 99 ? '99+' : folder.count}
                </span>
              )}
            </button>
          ))}

          <button
            type="button"
            className={clsx(
              'tg-nav-btn relative group',
              tasksPanelOpen && 'tg-nav-btn--active',
            )}
            title="Задачи"
            onClick={() => setTasksPanelOpen(true)}
          >
            <ClipboardList className={iconStyle} strokeWidth={1.75} />
            {taskCount > 0 && (
              <span className="tg-nav-badge">
                {taskCount > 99 ? '99+' : taskCount}
              </span>
            )}
          </button>
        </div>

        <div className="mt-auto flex flex-col gap-2">
          <SyncStatusNav />
          <InvitesBell />
          <button
            type="button"
            className={clsx(
              'tg-nav-btn group',
              settingsOpen && 'tg-nav-btn--active',
            )}
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Cog className={iconStyle} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {navMenu && (
        <AppContextMenu
          x={navMenu.x}
          y={navMenu.y}
          onClose={() => setNavMenu(null)}
          items={[
            {
              id: 'read-all',
              label: readAllBusy ? 'Читаю…' : 'Прочитать все',
              icon: <CheckCheck className="w-4 h-4" />,
              disabled: totalUnread === 0 || readAllBusy,
              onSelect: markAllAsRead,
            },
          ]}
        />
      )}

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  )
}
