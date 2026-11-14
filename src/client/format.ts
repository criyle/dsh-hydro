/**
 * Display formatters shared by the panel components.
 *
 * All user-visible text goes through the locale translator; dates use the host
 * locale (`zh-CN` / `en-US` / …) via `Intl`.
 */
import type { SiteRole } from '../shared/api.js'
import type { MessageKey, TranslateFn } from './locales.js'

/** All site roles, in select order. */
export const SITE_ROLES: readonly SiteRole[] = ['superadmin', 'domain-admin', 'problem-setter', 'judge', 'custom']

/** Locale keys for the operator-declared Hydro site role. */
const CONTENT_ROLE_KEYS: Record<SiteRole, MessageKey> = {
  superadmin: 'site.role.superadmin',
  'domain-admin': 'site.role.domainAdmin',
  'problem-setter': 'site.role.problemSetter',
  judge: 'site.role.judge',
  custom: 'site.role.custom',
}

/**
 * Localize one site-role value.
 * @param role - role from the shared contract.
 * @param t - translator; falls back to the raw value.
 * @returns localized role label.
 */
export function formatSiteRole(role: SiteRole, t?: TranslateFn): string {
  return t === undefined ? role : t(CONTENT_ROLE_KEYS[role])
}

/** BCP 47 tag for a DSH locale id. */
function htmlLocale(locale: string): string {
  if (locale === 'zh') return 'zh-CN'
  if (locale === 'en') return 'en-US'
  return locale
}

/**
 * Format an ISO timestamp for the panel, in the browser's local time.
 * @param iso - ISO-8601 string, or null/undefined when nothing was recorded.
 * @param locale - active DSH locale id.
 * @param t - translator for the "never" fallback.
 * @returns localized date-time.
 */
export function formatTime(iso: string | null | undefined, locale = 'en', t?: TranslateFn): string {
  if (iso === null || iso === undefined || iso === '') {
    return t === undefined ? '—' : t('common.never')
  }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return date.toLocaleString(htmlLocale(locale), { hour12: false })
  } catch {
    return date.toLocaleString(undefined, { hour12: false })
  }
}

/**
 * Format a byte count with binary units.
 * @param bytes - byte count, or null.
 * @returns human-readable size, or null when the value is absent.
 */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return null
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? 'B'}`
}

/**
 * Format a second count as days/hours/minutes.
 * @param seconds - seconds, or null.
 * @param t - translator for the unit labels.
 * @returns human-readable duration, or null when absent.
 */
export function formatDuration(seconds: number | null | undefined, t?: TranslateFn): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (t !== undefined) {
    if (days > 0) return t('duration.daysHours', { days, hours })
    if (hours > 0) return t('duration.hoursMinutes', { hours, minutes })
    return t('duration.minutes', { minutes })
  }
  if (days > 0) return `${String(days)}d ${String(hours)}h`
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  return `${String(minutes)}m`
}

/**
 * Join non-empty values with ` · `.
 * @param parts - values to join; null/undefined/empty entries are dropped.
 * @returns the joined line, or null when nothing remains.
 */


/** Narrow an unknown JSON value to a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Render one scalar-ish cell for a data table (objects/arrays become JSON). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** True when every value in the record is a primitive (table-friendly). */
export function isFlatRecord(record: Record<string, unknown>): boolean {
  return Object.values(record).every((value) => value === null || value === undefined || typeof value !== 'object')
}


/** CJK detection shared by views that must not surface backend Chinese. */
export function containsCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}
