const MAX_BREADCRUMBS = 30

export type Breadcrumb = {
  ts: number
  type: string
  /** Non-PII metadata only (ids, counts, codes) */
  data?: Record<string, string | number | boolean | null | undefined>
}

const buffer: Breadcrumb[] = []

export function pushBreadcrumb(
  type: string,
  data?: Breadcrumb['data'],
): void {
  buffer.push({ ts: Date.now(), type, data })
  if (buffer.length > MAX_BREADCRUMBS) {
    buffer.splice(0, buffer.length - MAX_BREADCRUMBS)
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  return buffer.slice()
}

export function clearBreadcrumbs(): void {
  buffer.length = 0
}
