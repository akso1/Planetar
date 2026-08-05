import { showAppToast } from '@/shared/lib/appToast'

/** Clipboard write with execCommand fallback (Electron often denies clipboard-write). */
export async function copyTextToClipboard(
  text: string,
  opts?: { toast?: string | false },
): Promise<boolean> {
  const value = text.trim()
  if (!value) return false
  let ok = false
  try {
    await navigator.clipboard.writeText(value)
    ok = true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      ta.style.top = '0'
      document.body.appendChild(ta)
      ta.select()
      ta.setSelectionRange(0, value.length)
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      ok = false
    }
  }
  if (ok && opts?.toast !== false) {
    showAppToast(opts?.toast || 'Скопировано')
  }
  return ok
}
