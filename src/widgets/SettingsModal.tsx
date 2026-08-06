import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  ArrowUpDown,
  Bell,
  BellOff,
  Bug,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  KeyRound,
  LogOut,
  Mail,
  Palette,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sticker,
  Trash2,
  X,
} from 'lucide-react'
import { useSessionStore } from '@/entities/session/model/session'
import { useRoomStore } from '@/entities/session/model/room.store'
import { getGradient } from '@/shared/lib/color'
import {
  loadAuthenticatedMxcObjectUrl,
  releaseAuthenticatedMxcObjectUrl,
} from '@/shared/lib/matrixMedia'
import {
  applyTheme,
  applyVibrancyEnabled,
  readStoredTheme,
  readVibrancyEnabled,
  THEME_OPTIONS,
  type AppTheme,
} from '@/shared/lib/theme'
import { CustomThemeEditor } from '@/widgets/CustomThemeEditor'
import {
  CHAT_SORT_OPTIONS,
  useChatListPrefsStore,
  type ChatSortMode,
} from '@/shared/lib/chatListPrefs'
import { useStickersStore } from '@/shared/lib/stickersStore'
import { StickerPacksPanel } from '@/widgets/StickerPacksPanel'
import {
  buildDiagnosticReport,
  buildMailtoUrl,
  buildShortMailtoReport,
  downloadTextFile,
  formatDiagnosticReportText,
  readSavedReportEmail,
  saveReportEmail,
  useErrorLogStore,
} from '@/shared/lib/errorLog'
import { pushBreadcrumb } from '@/shared/lib/breadcrumbs'
import { useNotificationPrefsStore } from '@/shared/lib/notificationPrefs'
import { showNotificationsSelfTest } from '@/shared/lib/desktopNotifications'
import { DecryptHistoryModal } from './DecryptHistoryModal'
import { ChatProtectionWizard } from './ChatProtectionWizard'
import { clsx } from 'clsx'
import { matrixService } from '@/shared/api/MatrixService'
import { useVerificationUiStore } from '@/shared/lib/verificationUi'
import {
  checkForAppUpdates,
  getBundledAppVersion,
  openUpdatePage,
  type AppUpdateCheckResult,
  GITHUB_RELEASES_URL,
} from '@/shared/lib/appUpdate'
import { showAppToast } from '@/shared/lib/appToast'

type SettingsModalProps = {
  isOpen: boolean
  onClose: () => void
}

type SettingsPage =
  | 'home'
  | 'themes'
  | 'chats'
  | 'notifications'
  | 'stickers'
  | 'errors'

const PAGE_TITLE: Record<SettingsPage, string> = {
  home: 'Настройки',
  themes: 'Темы',
  chats: 'Список чатов',
  notifications: 'Уведомления',
  stickers: 'Стикеры',
  errors: 'Ошибки',
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const client = useSessionStore((state) => state.client)
  const logout = useSessionStore((state) => state.logout)
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const rooms = useRoomStore((state) => state.rooms)
  const activeRoom =
    rooms.find((r) => r.roomId === activeRoomId) ?? rooms[0] ?? null

  const [page, setPage] = useState<SettingsPage>('home')
  const [displayName, setDisplayName] = useState('')
  const [loadedDisplayName, setLoadedDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [profileStatus, setProfileStatus] = useState<string | null>(null)
  const [nameBusy, setNameBusy] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const avatarMxcRef = useRef<string | null>(null)
  const avatarAcquiredRef = useRef(false)
  const [deviceStatus, setDeviceStatus] = useState<
    'loading' | 'verified' | 'unverified' | 'unknown'
  >('loading')
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isDecryptOpen, setDecryptOpen] = useState(false)
  const [protectionOpen, setProtectionOpen] = useState(false)
  const [theme, setTheme] = useState<AppTheme>(() => readStoredTheme())
  const [vibrancyEnabled, setVibrancyEnabled] = useState(() =>
    readVibrancyEnabled(),
  )
  const isDarwin = window.electronAPI?.platform === 'darwin'
  const chatSortMode = useChatListPrefsStore((s) => s.sortMode)
  const setChatSortMode = useChatListPrefsStore((s) => s.setSortMode)
  const refreshRooms = useRoomStore((s) => s.actions.refreshRooms)
  const notificationsEnabled = useNotificationPrefsStore((s) => s.enabled)
  const minimizeToTray = useNotificationPrefsStore((s) => s.minimizeToTray)
  const mutedRoomIds = useNotificationPrefsStore((s) => s.mutedRoomIds)
  const setNotificationsEnabled = useNotificationPrefsStore((s) => s.setEnabled)
  const setMinimizeToTray = useNotificationPrefsStore((s) => s.setMinimizeToTray)
  const [reportEmail, setReportEmail] = useState(() => readSavedReportEmail())
  const [reportComment, setReportComment] = useState('')
  const [reportStatus, setReportStatus] = useState<string | null>(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState(() => getBundledAppVersion())
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateResult, setUpdateResult] =
    useState<AppUpdateCheckResult | null>(null)

  const packs = useStickersStore((s) => s.packs)

  const errorEntries = useErrorLogStore((s) => s.entries)
  const clearErrors = useErrorLogStore((s) => s.clear)
  const removeError = useErrorLogStore((s) => s.remove)
  const openOutgoingVerification = useVerificationUiStore((s) => s.openOutgoing)
  const verifiedTick = useVerificationUiStore((s) => s.verifiedTick)

  const userId = client?.getUserId() ?? ''
  const deviceId = client?.getDeviceId() ?? ''
  const avatarSize = 96
  const nameDirty = displayName.trim() !== loadedDisplayName.trim()
  const themeLabel =
    theme === 'custom'
      ? 'Своя тема'
      : THEME_OPTIONS.find((o) => o.id === theme)?.label ?? 'Тема'
  const chatSortLabel =
    CHAT_SORT_OPTIONS.find((o) => o.id === chatSortMode)?.label ??
    'Сортировка чатов'
  const notificationsLabel = notificationsEnabled
    ? mutedRoomIds.length
      ? `Вкл. · ${mutedRoomIds.length} без звука`
      : 'Включены'
    : 'Выключены'

  useEffect(() => {
    if (!isOpen) {
      setPage('home')
      setUpdateResult(null)
      return
    }
    pushBreadcrumb('settings_open')
    useErrorLogStore.getState().hydrate()
    useChatListPrefsStore.getState().hydrate()
    useNotificationPrefsStore.getState().hydrate()
    void window.electronAPI?.getAppVersion?.().then((v) => {
      if (typeof v === 'string' && v.trim()) setAppVersion(v.trim())
    })
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    void useStickersStore.getState().hydrate(client)
  }, [isOpen, client])

  useEffect(() => {
    if (!profileStatus) return
    const timer = window.setTimeout(() => setProfileStatus(null), 3500)
    return () => clearTimeout(timer)
  }, [profileStatus])

  const releaseCurrentAvatar = useCallback(() => {
    if (avatarAcquiredRef.current && avatarMxcRef.current) {
      releaseAuthenticatedMxcObjectUrl(avatarMxcRef.current, avatarSize)
      avatarAcquiredRef.current = false
    }
  }, [avatarSize])

  const refreshProfile = useCallback(async () => {
    if (!client || !userId) return

    try {
      const profile = await client.getProfileInfo(userId)
      const name =
        profile.displayname ||
        userId.split(':')[0].substring(1) ||
        userId
      setDisplayName(name)
      setLoadedDisplayName(name)

      releaseCurrentAvatar()
      setAvatarUrl(null)

      if (profile.avatar_url) {
        avatarMxcRef.current = profile.avatar_url
        try {
          const objectUrl = await loadAuthenticatedMxcObjectUrl(
            client,
            profile.avatar_url,
            avatarSize,
          )
          avatarAcquiredRef.current = true
          setAvatarUrl(objectUrl)
        } catch (err) {
          console.warn('Failed to load avatar', err)
          avatarMxcRef.current = null
          setAvatarUrl(null)
        }
      } else {
        avatarMxcRef.current = null
      }
    } catch {
      const fallback = userId.split(':')[0].substring(1) || userId
      setDisplayName(fallback)
      setLoadedDisplayName(fallback)
      releaseCurrentAvatar()
      avatarMxcRef.current = null
      setAvatarUrl(null)
    }
  }, [client, userId, avatarSize, releaseCurrentAvatar])

  useEffect(() => {
    if (!isOpen || !client || !userId) return

    void refreshProfile()

    return () => {
      releaseCurrentAvatar()
    }
  }, [isOpen, client, userId, refreshProfile, releaseCurrentAvatar])

  useEffect(() => {
    if (!isOpen || !client || !userId) return

    let cancelled = false

    const loadDeviceStatus = async () => {
      try {
        const crypto = client.getCrypto()
        if (!crypto || !deviceId) {
          setDeviceStatus('unknown')
          return
        }
        const status = await crypto.getDeviceVerificationStatus(
          userId,
          deviceId,
        )
        if (cancelled) return
        if (!status) {
          setDeviceStatus('unknown')
          return
        }
        setDeviceStatus(status.isVerified() ? 'verified' : 'unverified')
      } catch {
        if (!cancelled) setDeviceStatus('unknown')
      }
    }

    void loadDeviceStatus()

    return () => {
      cancelled = true
    }
  }, [isOpen, client, userId, deviceId])

  useEffect(() => {
    if (!isOpen || !client || !userId || !deviceId || verifiedTick === 0) return
    let cancelled = false
    const refresh = async () => {
      try {
        const crypto = client.getCrypto()
        if (!crypto) return
        const status = await crypto.getDeviceVerificationStatus(
          userId,
          deviceId,
        )
        if (cancelled || !status) return
        setDeviceStatus(status.isVerified() ? 'verified' : 'unverified')
      } catch {
        /* keep previous status */
      }
    }
    void refresh()
    return () => {
      cancelled = true
    }
  }, [verifiedTick, isOpen, client, userId, deviceId])

  const handleSaveDisplayName = async () => {
    if (!client || nameBusy || avatarBusy) return
    const name = displayName.trim()
    if (!name || !nameDirty) return

    setNameBusy(true)
    setProfileStatus(null)
    try {
      await client.setDisplayName(name)
      setLoadedDisplayName(name)
      setDisplayName(name)
      setProfileStatus('Имя сохранено')
    } catch (err) {
      setProfileStatus(
        err instanceof Error ? err.message : 'Не удалось сохранить имя',
      )
    } finally {
      setNameBusy(false)
    }
  }

  const handleAvatarPick = () => {
    if (nameBusy || avatarBusy) return
    avatarInputRef.current?.click()
  }

  const handleAvatarFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !client || nameBusy || avatarBusy) return

    setAvatarBusy(true)
    setProfileStatus(null)
    try {
      const uploaded = await client.uploadContent(file, {
        type: file.type || undefined,
        name: file.name,
      })
      await client.setAvatarUrl(uploaded.content_uri)
      await refreshProfile()
      setProfileStatus('Фото обновлено')
    } catch (err) {
      setProfileStatus(
        err instanceof Error ? err.message : 'Не удалось загрузить фото',
      )
    } finally {
      setAvatarBusy(false)
    }
  }

  const startDeviceVerification = async () => {
    if (!client) return
    try {
      await matrixService.ensureCryptoReady()
      openOutgoingVerification()
    } catch (err) {
      console.error('Failed to start device verification', err)
    }
  }
  const handleCheckUpdates = async () => {
    if (updateBusy) return
    setUpdateBusy(true)
    setUpdateResult(null)
    try {
      const result = await checkForAppUpdates()
      setUpdateResult(result)
      if (result.currentVersion) setAppVersion(result.currentVersion)
      pushBreadcrumb('settings_check_updates', { status: result.status })
    } catch (err) {
      console.error('Update check failed', err)
      setUpdateResult({
        ok: false,
        status: 'error',
        currentVersion: appVersion,
        releaseUrl: GITHUB_RELEASES_URL,
        message:
          err instanceof Error ? err.message : 'Не удалось проверить обновления',
      })
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleOpenUpdateLink = async (url: string | undefined) => {
    const href = (url || GITHUB_RELEASES_URL).trim()
    const ok = await openUpdatePage(href)
    if (!ok) {
      showAppToast('Не удалось открыть ссылку. Попробуйте «Открыть на GitHub».')
    }
  }

  const handleLogout = async () => {
    if (isLoggingOut) return
    setIsLoggingOut(true)
    try {
      await logout()
      onClose()
    } catch (err) {
      console.error('Logout failed:', err)
      setIsLoggingOut(false)
    }
  }

  const onThemePick = (next: AppTheme) => {
    setTheme(next)
    applyTheme(next)
  }

  const onChatSortPick = (next: ChatSortMode) => {
    const roomIds = useRoomStore.getState().rooms.map((r) => r.roomId)
    setChatSortMode(next, roomIds)
    refreshRooms()
  }

  const makeReport = () => {
    const homeserver =
      (client as { baseUrl?: string } | null)?.baseUrl ||
      matrixService.client?.baseUrl ||
      null
    return buildDiagnosticReport({
      entries: errorEntries,
      comment: reportComment,
      userId,
      deviceId,
      homeserver,
      activeRoomId,
    })
  }

  const downloadErrorReport = async () => {
    setReportBusy(true)
    setReportStatus(null)
    try {
      const report = makeReport()
      const text = formatDiagnosticReportText(report)
      const filename = `matrix-error-report-${report.reportId.slice(0, 8)}.txt`
      const result = await downloadTextFile(filename, text)
      if (result.ok === false && result.method === 'electron') {
        setReportStatus('Сохранение отменено')
        return
      }
      setReportStatus(
        result.path
          ? `Отчёт сохранён: ${result.path}`
          : `Отчёт скачан (${filename}). Для отладки лучше приложить этот файл к письму.`,
      )
    } catch (err) {
      setReportStatus(
        err instanceof Error ? err.message : 'Не удалось сохранить отчёт',
      )
    } finally {
      setReportBusy(false)
    }
  }

  const copyErrorReport = async () => {
    setReportBusy(true)
    setReportStatus(null)
    try {
      const report = makeReport()
      const text = formatDiagnosticReportText(report)
      await navigator.clipboard.writeText(text)
      setReportStatus(
        `Полный отчёт скопирован (ID ${report.reportId.slice(0, 8)}…). Вставьте Cmd+V в письмо или чат.`,
      )
    } catch (err) {
      setReportStatus(
        err instanceof Error
          ? err.message
          : 'Не удалось скопировать в буфер обмена',
      )
    } finally {
      setReportBusy(false)
    }
  }

  const sendErrorReport = async () => {
    const email = reportEmail.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setReportStatus('Укажите корректный email получателя')
      return
    }
    setReportBusy(true)
    setReportStatus(null)
    try {
      saveReportEmail(email)
      const report = makeReport()
      const fullText = formatDiagnosticReportText(report)
      try {
        await navigator.clipboard.writeText(fullText)
      } catch {
        /* clipboard may be denied */
      }
      const { subject, body } = buildShortMailtoReport({ report })
      const mailto = buildMailtoUrl(email, subject, body)
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(mailto)
      } else {
        window.location.href = mailto
      }
      setReportStatus(
        'Краткое письмо открыто. Полный отчёт в буфере — лучше скачайте файл и приложите его к письму.',
      )
    } catch (err) {
      setReportStatus(
        err instanceof Error ? err.message : 'Не удалось открыть почту',
      )
    } finally {
      setReportBusy(false)
    }
  }

  const goBack = () => setPage('home')

  return createPortal(
    <>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="fixed inset-0 z-[900] flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/55 backdrop-blur-xs"
              aria-label="Close settings"
              onClick={onClose}
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              className={clsx(
                'relative w-full max-w-md max-h-[min(88vh,720px)] rounded-2xl border border-hairline shadow-panel backdrop-blur-md overflow-hidden flex flex-col text-chatText',
                vibrancyEnabled && isDarwin
                  ? 'bg-chatSidebar/65'
                  : 'bg-chatSidebar',
              )}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-hairline shrink-0 gap-2">
                <div className="flex items-center gap-1 min-w-0">
                  {page !== 'home' && (
                    <button
                      type="button"
                      onClick={goBack}
                      className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors shrink-0"
                      aria-label="Назад"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                  )}
                  <h2
                    id="settings-title"
                    className="text-lg font-semibold text-ink truncate"
                  >
                    {PAGE_TITLE[page]}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 transition-colors shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="px-5 py-5 overflow-y-auto flex-1 min-h-0">
                <AnimatePresence mode="wait" initial={false}>
                  {page === 'home' && (
                    <motion.div
                      key="home"
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -8 }}
                      transition={{ duration: 0.14 }}
                      className="space-y-5"
                    >
                      {/* Profile */}
                      <div className="tg-settings-profile space-y-3">
                        <div className="flex items-center gap-4">
                          <button
                            type="button"
                            onClick={handleAvatarPick}
                            disabled={!client || nameBusy || avatarBusy}
                            className={clsx(
                              'tg-settings-avatar relative w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-semibold shrink-0 overflow-hidden transition-opacity',
                              'disabled:opacity-60 disabled:cursor-not-allowed group',
                            )}
                            style={{
                              background: avatarUrl
                                ? 'transparent'
                                : getGradient(userId || 'user'),
                            }}
                            aria-label="Изменить фото"
                          >
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                onError={() => setAvatarUrl(null)}
                              />
                            ) : (
                              (displayName || '?').charAt(0).toUpperCase()
                            )}
                            <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 group-disabled:opacity-0 transition-opacity">
                              <Camera className="w-5 h-5 text-white" />
                            </span>
                          </button>
                          <input
                            ref={avatarInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => void handleAvatarFile(event)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] text-ink-muted truncate font-mono">
                              {userId}
                            </div>
                            {deviceId && (
                              <div className="text-[11px] text-ink-faint mt-0.5 truncate">
                                Device: {deviceId}
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={handleAvatarPick}
                              disabled={!client || nameBusy || avatarBusy}
                              className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:text-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Camera className="w-3.5 h-3.5" />
                              {avatarBusy ? 'Загрузка…' : 'Изменить фото'}
                            </button>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label
                            htmlFor="settings-display-name"
                            className="text-[12px] text-ink-muted font-medium"
                          >
                            Отображаемое имя
                          </label>
                          <div className="flex gap-2">
                            <input
                              id="settings-display-name"
                              type="text"
                              value={displayName}
                              onChange={(event) =>
                                setDisplayName(event.target.value)
                              }
                              disabled={!client || nameBusy || avatarBusy}
                              placeholder="Имя"
                              className="flex-1 min-w-0 h-9 rounded-lg bg-surface-inset border border-hairline px-3 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent/80 disabled:opacity-50"
                            />
                            <button
                              type="button"
                              onClick={() => void handleSaveDisplayName()}
                              disabled={
                                !client ||
                                nameBusy ||
                                avatarBusy ||
                                !nameDirty ||
                                !displayName.trim()
                              }
                              className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-[12.5px] font-medium px-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Check className="w-4 h-4" />
                              {nameBusy ? 'Сохранение…' : 'Сохранить'}
                            </button>
                          </div>
                        </div>

                        {profileStatus && (
                          <div className="text-[12px] text-ink-muted leading-relaxed">
                            {profileStatus}
                          </div>
                        )}
                      </div>

                      {/* Menu */}
                      <div className="rounded-xl bg-surface-inset border border-hairline overflow-hidden">
                        <SettingsNavItem
                          icon={<Palette className="w-4 h-4" />}
                          title="Темы оформления"
                          subtitle={themeLabel}
                          onClick={() => setPage('themes')}
                        />
                        <SettingsNavItem
                          icon={<ArrowUpDown className="w-4 h-4" />}
                          title="Список чатов"
                          subtitle={chatSortLabel}
                          onClick={() => setPage('chats')}
                        />
                        <SettingsNavItem
                          icon={<Bell className="w-4 h-4" />}
                          title="Уведомления"
                          subtitle={notificationsLabel}
                          onClick={() => setPage('notifications')}
                        />
                        <SettingsNavItem
                          icon={<Sticker className="w-4 h-4" />}
                          title="Мои стикеры"
                          subtitle={
                            packs.length
                              ? `${packs.length} пак${packs.length === 1 ? '' : packs.length < 5 ? 'а' : 'ов'}`
                              : 'Пока пусто'
                          }
                          onClick={() => setPage('stickers')}
                        />
                        <SettingsNavItem
                          icon={<Bug className="w-4 h-4" />}
                          title="Ошибки"
                          subtitle={
                            errorEntries.length
                              ? `${errorEntries.length} в журнале`
                              : 'Журнал пуст'
                          }
                          badge={
                            errorEntries.length > 0
                              ? String(errorEntries.length)
                              : undefined
                          }
                          onClick={() => setPage('errors')}
                          last
                        />
                      </div>

                      {/* Security */}
                      <div className="rounded-xl bg-surface-inset border border-hairline p-4 space-y-3">
                        <div className="text-[12px] uppercase tracking-wide text-ink-muted font-medium">
                          Защита чатов
                        </div>

                        <div className="flex items-center gap-3">
                          <DeviceStatusIcon status={deviceStatus} />
                          <div className="min-w-0">
                            <div className="text-sm text-ink">
                              {deviceStatusLabel(deviceStatus)}
                            </div>
                            <div className="text-xs text-ink-muted">
                              Статус этого устройства
                            </div>
                          </div>
                        </div>

                        {deviceStatus === 'unverified' && (
                          <button
                            type="button"
                            onClick={() => void startDeviceVerification()}
                            disabled={!client}
                            className="tg-btn-emerald w-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium py-2.5"
                          >
                            <ShieldCheck className="w-4 h-4" />
                            Подтвердить через другое устройство
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => setProtectionOpen(true)}
                          disabled={!client}
                          className="tg-btn-emerald w-full flex items-center justify-center gap-2 rounded-lg text-sm font-medium py-2.5"
                        >
                          <Shield className="w-4 h-4" />
                          Настроить защиту чатов
                        </button>

                        <button
                          type="button"
                          onClick={() => setDecryptOpen(true)}
                          disabled={!client}
                          className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-sm font-medium py-2.5 transition-colors disabled:opacity-50"
                        >
                          <KeyRound className="w-4 h-4" />
                          Восстановить доступ к истории
                        </button>
                      </div>

                      <div className="rounded-xl bg-surface-inset border border-hairline p-4 space-y-3">
                        <div className="text-[12px] uppercase tracking-wide text-ink-muted font-medium">
                          О приложении
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm text-ink font-medium">
                              Planetar
                            </div>
                            <div className="text-xs text-ink-muted mt-0.5">
                              Версия {appVersion}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleCheckUpdates()}
                            disabled={updateBusy}
                            className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-[12.5px] font-medium px-3 py-2 transition-colors disabled:opacity-50"
                          >
                            <RefreshCw
                              className={clsx(
                                'w-3.5 h-3.5',
                                updateBusy && 'animate-spin',
                              )}
                            />
                            {updateBusy ? 'Проверка…' : 'Проверить обновления'}
                          </button>
                        </div>

                        {updateResult && (
                          <div className="space-y-2">
                            <div
                              className={clsx(
                                'text-[12.5px] leading-relaxed',
                                updateResult.status === 'update-available'
                                  ? 'text-ink'
                                  : updateResult.status === 'error'
                                    ? 'text-red-300'
                                    : 'text-ink-muted',
                              )}
                            >
                              {updateResult.message ||
                                (updateResult.status === 'up-to-date'
                                  ? 'Установлена актуальная версия'
                                  : updateResult.status === 'update-available'
                                    ? `Доступна версия ${updateResult.latestVersion}`
                                    : 'Не удалось проверить обновления')}
                            </div>
                            {(updateResult.status === 'update-available' ||
                              updateResult.status === 'no-release' ||
                              updateResult.status === 'error') && (
                              <div className="flex flex-wrap gap-2">
                                {updateResult.status === 'update-available' &&
                                  updateResult.downloadUrl && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void handleOpenUpdateLink(
                                          updateResult.downloadUrl,
                                        )
                                      }
                                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-[12px] font-medium px-2.5 py-1.5 transition-colors"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      Скачать
                                    </button>
                                  )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleOpenUpdateLink(
                                      updateResult.releaseUrl ||
                                        GITHUB_RELEASES_URL,
                                    )
                                  }
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface-inset hover:bg-white/5 text-ink text-[12px] font-medium px-2.5 py-1.5 transition-colors"
                                >
                                  Открыть на GitHub
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={() => void handleLogout()}
                        disabled={isLoggingOut}
                        className={clsx(
                          'w-full flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-semibold transition-colors',
                          'bg-red-500/15 hover:bg-red-500/25 border border-red-500/40 text-red-300',
                          'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                      >
                        <LogOut className="w-4 h-4" />
                        {isLoggingOut ? 'Signing out…' : 'Log out'}
                      </button>
                    </motion.div>
                  )}

                  {page === 'themes' && (
                    <motion.div
                      key="themes"
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.14 }}
                      className="space-y-3"
                    >
                      <p className="text-[12.5px] text-chatMuted leading-relaxed">
                        Выберите оформление или соберите свою палитру. Тема
                        применяется сразу и сохраняется.
                      </p>

                      {isDarwin && (
                        <div className="rounded-xl border border-hairline bg-surface-inset px-3.5 py-3 flex items-center gap-3">
                          <div
                            className={clsx(
                              'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                              vibrancyEnabled
                                ? 'bg-accent/25 border-accent/40 text-ink'
                                : 'bg-surface-inset border-hairline text-ink-muted',
                            )}
                          >
                            <Sparkles className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13.5px] font-semibold text-ink">
                              Размытие фона (macOS Vibrancy)
                            </div>
                            <div className="text-[12px] text-ink-muted mt-0.5 leading-snug">
                              Прозрачный фон с эффектом акрилового стекла
                            </div>
                          </div>
                          <SettingsSwitch
                            checked={vibrancyEnabled}
                            onChange={(next) => {
                              setVibrancyEnabled(next)
                              applyVibrancyEnabled(next)
                            }}
                            label="Размытие фона (macOS Vibrancy)"
                          />
                        </div>
                      )}

                      <CustomThemeEditor
                        active={theme === 'custom'}
                        onActivate={() => onThemePick('custom')}
                        onApplied={() => setTheme('custom')}
                      />

                      <div className="grid grid-cols-1 gap-2.5">
                        {THEME_OPTIONS.map((opt) => {
                          const active = theme === opt.id
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => onThemePick(opt.id)}
                              className={clsx(
                                'rounded-2xl border p-3 text-left transition-all duration-ui overflow-hidden',
                                active
                                  ? 'border-chatAccent ring-2 ring-chatAccent/35 shadow-lg shadow-black/20'
                                  : 'border-hairline hover:border-hairline-strong',
                              )}
                              style={{ background: opt.bg }}
                            >
                              <div className="flex items-stretch gap-3">
                                <div
                                  className="w-[72px] shrink-0 rounded-xl overflow-hidden border border-black/10 flex"
                                  aria-hidden
                                >
                                  <div
                                    className="w-[28%] h-14"
                                    style={{ background: opt.sidebar }}
                                  />
                                  <div
                                    className="flex-1 h-14 p-1.5 flex flex-col gap-1"
                                    style={{ background: opt.bg }}
                                  >
                                    <div
                                      className="h-2.5 w-[70%] rounded-xs ml-auto"
                                      style={{ background: opt.surface }}
                                    />
                                    <div
                                      className="h-2.5 w-[55%] rounded-xs"
                                      style={{ background: opt.surfaceIn }}
                                    />
                                    <div
                                      className="mt-auto h-1.5 w-4 rounded-full"
                                      style={{ background: opt.accent }}
                                    />
                                  </div>
                                </div>
                                <div className="min-w-0 flex-1 py-0.5">
                                  <div
                                    className="text-[13.5px] font-semibold truncate"
                                    style={{ color: opt.text }}
                                  >
                                    {opt.label}
                                    {active && (
                                      <span
                                        className="ml-2 text-[10px] font-bold uppercase tracking-wide"
                                        style={{ color: opt.accent }}
                                      >
                                        активна
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    className="text-[12px] mt-0.5 leading-snug"
                                    style={{ color: opt.muted }}
                                  >
                                    {opt.hint}
                                  </div>
                                </div>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </motion.div>
                  )}

                  {page === 'chats' && (
                    <motion.div
                      key="chats"
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.14 }}
                      className="space-y-3"
                    >
                      <p className="text-[12.5px] text-ink-muted leading-relaxed">
                        Как упорядочивать чаты в левом списке.
                      </p>
                      <div className="grid grid-cols-1 gap-2">
                        {CHAT_SORT_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => onChatSortPick(opt.id)}
                            className={clsx(
                              'rounded-xl border px-3.5 py-3 text-left transition-colors',
                              chatSortMode === opt.id
                                ? 'border-accent-hover/55 bg-accent/35'
                                : 'border-hairline bg-surface-inset hover:bg-black/5',
                            )}
                          >
                            <div className="text-[13.5px] font-semibold text-ink">
                              {opt.label}
                            </div>
                            <div className="text-[12px] text-ink-muted mt-0.5 leading-snug">
                              {opt.hint}
                            </div>
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}

                  {page === 'notifications' && (
                    <motion.div
                      key="notifications"
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.14 }}
                      className="space-y-3"
                    >
                      <p className="text-[12.5px] text-ink-muted leading-relaxed">
                        Desktop-уведомления о новых сообщениях, когда чат не в
                        фокусе. Отдельные чаты можно отключить через ПКМ в
                        списке.
                      </p>

                      <div className="rounded-xl border border-hairline bg-surface-inset px-3.5 py-3 flex items-center gap-3">
                        <div
                          className={clsx(
                            'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                            notificationsEnabled
                              ? 'bg-accent/25 border-accent/40 text-ink'
                              : 'bg-surface-inset border-hairline text-ink-muted',
                          )}
                        >
                          {notificationsEnabled ? (
                            <Bell className="w-4 h-4" />
                          ) : (
                            <BellOff className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold text-ink">
                            Показывать уведомления
                          </div>
                          <div className="text-[12px] text-ink-muted mt-0.5 leading-snug">
                            {notificationsEnabled
                              ? 'Включено для всех чатов, кроме заглушённых'
                              : 'Все desktop-уведомления выключены'}
                          </div>
                        </div>
                        <SettingsSwitch
                          checked={notificationsEnabled}
                          onChange={(next) => {
                            setNotificationsEnabled(next)
                            if (next) showNotificationsSelfTest()
                          }}
                          label="Показывать уведомления"
                        />
                      </div>

                      <div className="rounded-xl border border-hairline bg-surface-inset px-3.5 py-3 flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl border border-hairline bg-surface-inset flex items-center justify-center shrink-0 text-ink-muted">
                          <Bell className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold text-ink">
                            Сворачивать в меню
                          </div>
                          <div className="text-[12px] text-ink-muted mt-0.5 leading-snug">
                            {minimizeToTray
                              ? 'Закрытие окна оставляет приложение в menu bar — уведомления продолжают приходить'
                              : 'Закрытие окна завершает приложение'}
                          </div>
                        </div>
                        <SettingsSwitch
                          checked={minimizeToTray}
                          onChange={setMinimizeToTray}
                          label="Сворачивать в меню"
                        />
                      </div>

                      {mutedRoomIds.length > 0 && (
                        <div className="rounded-xl border border-hairline bg-surface-inset px-3.5 py-3 text-[12.5px] text-ink-muted leading-relaxed">
                          Без звука: {mutedRoomIds.length}{' '}
                          {mutedRoomIds.length === 1
                            ? 'чат'
                            : mutedRoomIds.length < 5
                              ? 'чата'
                              : 'чатов'}
                          . Размутить можно ПКМ по чату в списке.
                        </div>
                      )}
                    </motion.div>
                  )}

                  {page === 'stickers' && (
                    <motion.div
                      key="stickers"
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.14 }}
                    >
                      <StickerPacksPanel client={client} />
                    </motion.div>
                  )}

                  {page === 'errors' && (
                    <motion.div
                      key="errors"
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 12 }}
                      transition={{ duration: 0.14 }}
                      className="space-y-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[12.5px] text-ink-muted leading-relaxed">
                          Сбои интерфейса и фона сохраняются здесь. Для отладки
                          лучше скачать файл отчёта и приложить его к письму.
                        </p>
                        {errorEntries.length > 0 && (
                          <button
                            type="button"
                            onClick={() => clearErrors()}
                            className="shrink-0 text-[11px] text-ink-muted hover:text-red-300 transition-colors"
                          >
                            Очистить
                          </button>
                        )}
                      </div>

                      <div className="space-y-2 max-h-[32vh] overflow-y-auto">
                        {errorEntries.length === 0 ? (
                          <div className="flex items-start gap-2 rounded-lg bg-surface-inset border border-hairline px-3 py-2.5 text-[12.5px] text-ink-muted">
                            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 opacity-60" />
                            Пока ошибок нет — журнал пуст.
                          </div>
                        ) : (
                          errorEntries.map((entry) => {
                            const open = expandedErrorId === entry.id
                            return (
                              <div
                                key={entry.id}
                                className="rounded-lg bg-surface-inset border border-hairline overflow-hidden"
                              >
                                <div className="flex items-start gap-1 pr-1.5">
                                  <button
                                    type="button"
                                    className="min-w-0 flex-1 text-left px-3 py-2.5 flex items-start gap-2 hover:bg-black/[0.03]"
                                    onClick={() =>
                                      setExpandedErrorId(open ? null : entry.id)
                                    }
                                  >
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-300/90 shrink-0 mt-0.5" />
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[13px] font-medium text-ink truncate">
                                        {entry.title}
                                        {entry.count > 1 && (
                                          <span className="ml-1.5 text-[11px] font-normal text-ink-muted tabular-nums">
                                            ×{entry.count}
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-[11.5px] text-ink-muted mt-0.5 line-clamp-2">
                                        {entry.summary}
                                      </div>
                                      <div className="text-[10.5px] text-ink-faint mt-1 tabular-nums">
                                        {new Date(
                                          entry.lastSeen || entry.ts,
                                        ).toLocaleString('ru-RU')}
                                      </div>
                                    </div>
                                  </button>
                                  <button
                                    type="button"
                                    className="shrink-0 w-7 h-7 mt-2 flex items-center justify-center rounded-md text-ink-faint hover:text-red-300 hover:bg-red-500/10"
                                    title="Удалить"
                                    aria-label="Удалить ошибку"
                                    onClick={() => removeError(entry.id)}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                                {open && (
                                  <div className="px-3 pb-2.5 border-t border-hairline pt-2 space-y-1.5">
                                    <div className="text-[11.5px] text-ink-muted whitespace-pre-wrap break-words">
                                      {entry.detail}
                                    </div>
                                    {entry.context?.roomId && (
                                      <div className="text-[10.5px] text-ink-faint font-mono">
                                        room: {entry.context.roomId}
                                      </div>
                                    )}
                                    {entry.stack && (
                                      <pre className="max-h-24 overflow-auto rounded-md bg-surface-inset p-2 text-[10px] text-ink-faint whitespace-pre-wrap break-words">
                                        {entry.stack}
                                      </pre>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })
                        )}
                      </div>

                      <div className="pt-2 space-y-2 border-t border-hairline">
                        <div className="text-[12px] text-ink-muted font-medium">
                          Диагностический отчёт
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={reportBusy}
                            onClick={() => void downloadErrorReport()}
                            className="flex items-center justify-center gap-2 rounded-lg bg-accent/40 hover:bg-accent/60 border border-accent/50 text-ink text-[12.5px] font-medium py-2.5 transition-colors disabled:opacity-50"
                          >
                            <Download className="w-4 h-4" />
                            Скачать отчёт
                          </button>
                          <button
                            type="button"
                            disabled={reportBusy}
                            onClick={() => void copyErrorReport()}
                            className="flex items-center justify-center gap-2 rounded-lg bg-surface-inset hover:bg-black/[0.04] border border-hairline text-ink text-[12.5px] font-medium py-2.5 transition-colors disabled:opacity-50"
                          >
                            <ClipboardCopy className="w-4 h-4" />
                            Копировать
                          </button>
                        </div>
                        <p className="text-[11px] text-ink-faint leading-relaxed">
                          Для отладки лучше приложить скачанный файл. Письмо
                          ниже — только краткая сводка.
                        </p>
                        <div className="text-[12px] text-ink-muted font-medium flex items-center gap-1.5 pt-1">
                          <Mail className="w-3.5 h-3.5" />
                          Отправить по почте
                        </div>
                        <input
                          type="email"
                          value={reportEmail}
                          onChange={(e) => setReportEmail(e.target.value)}
                          placeholder="email@example.com"
                          className="w-full h-9 rounded-lg bg-surface-inset border border-hairline px-3 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent/80"
                        />
                        <textarea
                          value={reportComment}
                          onChange={(e) => setReportComment(e.target.value)}
                          placeholder="Комментарий: что вы делали, когда появилась ошибка…"
                          rows={3}
                          className="w-full rounded-lg bg-surface-inset border border-hairline px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:border-accent/80 resize-y min-h-[72px]"
                        />
                        <button
                          type="button"
                          disabled={reportBusy}
                          onClick={() => void sendErrorReport()}
                          className="w-full flex items-center justify-center gap-2 rounded-lg bg-surface-inset hover:bg-black/[0.04] border border-hairline text-ink text-[12.5px] font-medium py-2.5 transition-colors disabled:opacity-50"
                        >
                          <Mail className="w-4 h-4" />
                          {reportBusy ? 'Открытие почты…' : 'Открыть письмо'}
                        </button>
                        {reportStatus && (
                          <div className="text-[12px] text-ink-muted leading-relaxed">
                            {reportStatus}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {client && (
        <DecryptHistoryModal
          isOpen={isDecryptOpen}
          onClose={() => setDecryptOpen(false)}
          client={client}
          room={activeRoom}
        />
      )}
      {client && (
        <ChatProtectionWizard
          client={client}
          open={protectionOpen}
          onClose={() => setProtectionOpen(false)}
        />
      )}
    </>,
    document.body,
  )
}

function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (disabled) return
        onChange(!checked)
      }}
      className={clsx(
        'relative inline-flex h-[26px] w-[46px] shrink-0 items-center rounded-full p-[3px] transition-[background,box-shadow,opacity] duration-200 ease-out',
        checked ? 'justify-end' : 'justify-start',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
      style={{
        background: checked
          ? 'var(--color-accent)'
          : 'color-mix(in srgb, var(--color-text) 12%, transparent)',
        boxShadow: checked
          ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, white), 0 0 14px color-mix(in srgb, var(--color-accent) 32%, transparent)'
          : 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 22%, transparent)',
      }}
    >
      <span
        aria-hidden
        className="block h-5 w-5 rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-transform duration-200 ease-out"
        style={{
          background: checked
            ? 'var(--color-on-accent)'
            : 'color-mix(in srgb, var(--color-text) 92%, transparent)',
        }}
      />
    </button>
  )
}

function SettingsNavItem({
  icon,
  title,
  subtitle,
  badge,
  last = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  subtitle: string
  badge?: string
  last?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-black/[0.04] transition-colors',
        !last && 'border-b border-hairline',
      )}
    >
      <div className="w-9 h-9 rounded-xl bg-surface-inset border border-hairline flex items-center justify-center text-ink-muted shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-ink flex items-center gap-2">
          <span className="truncate">{title}</span>
          {badge && (
            <span className="rounded-full bg-amber-500/15 text-amber-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
              {badge}
            </span>
          )}
        </div>
        <div className="text-[12px] text-ink-muted truncate mt-0.5">
          {subtitle}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" />
    </button>
  )
}

function deviceStatusLabel(
  status: 'loading' | 'verified' | 'unverified' | 'unknown',
) {
  switch (status) {
    case 'loading':
      return 'Checking…'
    case 'verified':
      return 'Device verified'
    case 'unverified':
      return 'Device not verified'
    default:
      return 'Verification status unknown'
  }
}

function DeviceStatusIcon({
  status,
}: {
  status: 'loading' | 'verified' | 'unverified' | 'unknown'
}) {
  if (status === 'verified') {
    return (
      <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
        <ShieldCheck className="w-5 h-5 text-emerald-400" />
      </div>
    )
  }
  if (status === 'unverified') {
    return (
      <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
        <ShieldAlert className="w-5 h-5 text-amber-400" />
      </div>
    )
  }
  return (
    <div className="w-10 h-10 rounded-full bg-surface-inset flex items-center justify-center shrink-0">
      <Shield className="w-5 h-5 text-ink-muted" />
    </div>
  )
}
