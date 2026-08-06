export type AppUpdateCheckResult = {
  ok: boolean
  status: 'up-to-date' | 'update-available' | 'no-release' | 'error'
  currentVersion: string
  latestVersion?: string
  releaseUrl: string
  downloadUrl?: string
  releaseName?: string
  message?: string
}

const GITHUB_OWNER = 'akso1'
const GITHUB_REPO = 'Planetar'
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`
const GITHUB_LATEST_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

export function getBundledAppVersion(): string {
  return import.meta.env.VITE_APP_VERSION || '0.0.0'
}

function parseSemverParts(raw: string): number[] {
  const cleaned = raw.trim().replace(/^v/i, '').split(/[+-]/)[0] ?? ''
  return cleaned.split('.').map((p) => {
    const n = parseInt(p.replace(/[^\d].*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** Compare semver-ish tags. Returns >0 if a>b, <0 if a<b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a)
  const pb = parseSemverParts(b)
  const len = Math.max(pa.length, pb.length, 3)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d > 0) return 1
    if (d < 0) return -1
  }
  return 0
}

function detectPlatform(): { platform: string; arch: string } {
  const api = window.electronAPI
  const platform =
    api?.platform ||
    (typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
      ? 'win32'
      : typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform)
        ? 'linux'
        : 'darwin')
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const arch = /arm64|aarch64/i.test(ua) ? 'arm64' : 'x64'
  return { platform, arch }
}

function pickReleaseDownloadUrl(
  assets: Array<{ name?: string; browser_download_url?: string }>,
  platform: string,
  arch: string,
): string | undefined {
  const list = assets.filter(
    (a) =>
      typeof a.name === 'string' &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith('https://'),
  ) as Array<{ name: string; browser_download_url: string }>

  if (platform === 'darwin') {
    const dmg = list.filter((a) => /\.dmg$/i.test(a.name))
    if (arch === 'arm64') {
      return (
        dmg.find((a) => /arm64/i.test(a.name))?.browser_download_url ??
        dmg[0]?.browser_download_url
      )
    }
    return (
      dmg.find((a) => /x64|amd64|intel/i.test(a.name))?.browser_download_url ??
      dmg[0]?.browser_download_url
    )
  }

  if (platform === 'win32') {
    const exes = list.filter((a) => /\.exe$/i.test(a.name))
    return (
      exes.find((a) => /portable/i.test(a.name))?.browser_download_url ??
      exes[0]?.browser_download_url
    )
  }

  return list[0]?.browser_download_url
}

async function checkViaGitHubApi(
  currentVersion: string,
): Promise<AppUpdateCheckResult> {
  const releaseUrl = GITHUB_RELEASES_URL
  try {
    const res = await fetch(GITHUB_LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    if (res.status === 404) {
      return {
        ok: true,
        status: 'no-release',
        currentVersion,
        releaseUrl,
        message: 'На GitHub пока нет опубликованных релизов',
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status: 'error',
        currentVersion,
        releaseUrl,
        message: `GitHub ответил ${res.status}`,
      }
    }

    const data = (await res.json()) as {
      tag_name?: string
      name?: string
      html_url?: string
      assets?: Array<{ name?: string; browser_download_url?: string }>
    }

    const latestVersion = String(data.tag_name || data.name || '')
      .trim()
      .replace(/^v/i, '')
    if (!latestVersion) {
      return {
        ok: true,
        status: 'no-release',
        currentVersion,
        releaseUrl,
        message: 'Не удалось прочитать версию последнего релиза',
      }
    }

    const pageUrl =
      typeof data.html_url === 'string' && data.html_url.startsWith('https://')
        ? data.html_url
        : releaseUrl
    const { platform, arch } = detectPlatform()
    const downloadUrl = pickReleaseDownloadUrl(data.assets || [], platform, arch)

    if (compareSemver(latestVersion, currentVersion) <= 0) {
      return {
        ok: true,
        status: 'up-to-date',
        currentVersion,
        latestVersion,
        releaseUrl: pageUrl,
        message: 'Установлена актуальная версия',
      }
    }

    return {
      ok: true,
      status: 'update-available',
      currentVersion,
      latestVersion,
      releaseUrl: pageUrl,
      downloadUrl,
      releaseName: data.name,
      message: `Доступна версия ${latestVersion}`,
    }
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      currentVersion,
      releaseUrl,
      message:
        err instanceof Error ? err.message : 'Не удалось проверить обновления',
    }
  }
}

/** Check GitHub Releases for a newer Planetar build (manual download flow). */
export async function checkForAppUpdates(): Promise<AppUpdateCheckResult> {
  const api = window.electronAPI
  let currentVersion = getBundledAppVersion()

  try {
    if (api?.getAppVersion) {
      const v = await api.getAppVersion()
      if (typeof v === 'string' && v.trim()) currentVersion = v.trim()
    }
  } catch {
    /* keep bundled */
  }

  if (api?.checkForUpdates) {
    try {
      return await api.checkForUpdates()
    } catch (err) {
      console.warn(
        '[appUpdate] IPC check failed, falling back to GitHub fetch',
        err,
      )
    }
  }

  return checkViaGitHubApi(currentVersion)
}

export async function openUpdatePage(url: string): Promise<boolean> {
  const href = typeof url === 'string' ? url.trim() : ''
  if (!href.startsWith('https://')) {
    console.warn('[appUpdate] refused non-https update URL', url)
    return false
  }

  const api = window.electronAPI
  if (api?.openExternal) {
    try {
      const res = await api.openExternal(href)
      if (res && res.ok === false) {
        console.warn('[appUpdate] openExternal failed', res.reason, href)
        return false
      }
      return true
    } catch (err) {
      console.warn('[appUpdate] openExternal threw', err)
      return false
    }
  }
  window.open(href, '_blank', 'noopener,noreferrer')
  return true
}
