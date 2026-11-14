/**
 * Client-side localization of Host status warnings.
 *
 * The Host sends stable warning codes (`hydro.<area>.<kind>[.<hash>]`) plus a
 * Chinese `message`/`hint` meant for the model. The console must never render
 * those backend strings as primary copy, so every known code maps to a
 * localized, operator-friendly title here. Raw technical text is only offered
 * inside an expandable "details" disclosure (never the backend `hint`), and
 * dynamic Hydro admin messages (`hydro.ws.warn|error|log.<hash>`) keep their
 * original message as detail because it is Hydro's own user-facing text.
 */
import type { StatusWarning } from '../shared/types.js'
import { useConsole } from './console-context.js'
import { useI18n } from './i18n.js'
import type { TranslateFn } from './locales.js'
import {
  colors,
  detailText,
  inlineDetails,
  linkButton,
  okText,
  stack,
  time,
  warningItem,
} from './styles.js'

/** One warning with operator-facing, localized copy. */
export interface LocalizedWarning {
  severity: StatusWarning['severity']
  /** Localized headline (never a backend string). */
  title: string
  /** Raw technical text, shown behind "details" only when safe/useful. */
  detail: string | null
  /** Stable backend code, shown in the details disclosure. */
  code: string
  /** Optional navigation shortcut for the fix. */
  action: 'site-accounts' | null
}

/** CJK detection used to keep backend Chinese out of primary/detail copy. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** True when the code is exactly `prefix` or starts with `prefix.`. */
function isCode(code: string, prefix: string): boolean {
  return code === prefix || code.startsWith(`${prefix}.`)
}

/** Keep raw text only when it is not Chinese (backend messages are mostly zh). */
function safeDetail(text: string): string | null {
  return text.trim() === '' || CJK.test(text) ? null : text
}

/**
 * Map one Host warning code to localized copy.
 * @param warning - warning from the Host.
 * @param t - active translator.
 * @returns the localized warning.
 */
export function localizeWarning(warning: StatusWarning, t: TranslateFn): LocalizedWarning {
  const code = warning.code
  const base = { severity: warning.severity, detail: null as string | null, code, action: null as 'site-accounts' | null }

  if (code === 'hydro.ws.credentials') {
    return { ...base, title: t('warn.wsCredentials'), action: 'site-accounts' }
  }
  if (isCode(code, 'hydro.ws.permission')) {
    return { ...base, title: t('warn.wsPermission'), action: 'site-accounts' }
  }
  if (isCode(code, 'hydro.ws.connect')) return { ...base, title: t('warn.wsConnect') }
  if (isCode(code, 'hydro.ws.login')) return { ...base, title: t('warn.wsLogin') }
  if (isCode(code, 'hydro.ws.failed')) return { ...base, title: t('warn.wsFailed') }
  if (isCode(code, 'hydro.ws.warn') || isCode(code, 'hydro.ws.error') || isCode(code, 'hydro.ws.log')) {
    // Hydro's own admin message; usually English and safe to show as detail.
    return { ...base, title: t('warn.wsMessage'), detail: warning.message === '' ? null : warning.message }
  }
  if (isCode(code, 'hydro.oplog')) return { ...base, title: t('warn.oplogStandalone') }
  if (isCode(code, 'hydro.not-installed')) return { ...base, title: t('warn.notInstalled') }
  if (isCode(code, 'hydro.registry')) return { ...base, title: t('warn.registry') }
  if (isCode(code, 'hydro.update-available')) return { ...base, title: t('warn.updateAvailable') }
  if (isCode(code, 'hydro.mongo.failed')) return { ...base, title: t('warn.mongoFailed'), detail: safeDetail(warning.message) }
  if (isCode(code, 'hydro.mongo')) return { ...base, title: t('warn.mongo') }
  if (isCode(code, 'hydro.health')) return { ...base, title: t('warn.health') }
  if (isCode(code, 'hydro.probe.failed')) {
    // Probe failures are the one case where raw detail is useful for support.
    return { ...base, title: t('warn.probeFailed'), detail: warning.message === '' ? null : warning.message }
  }
  if (isCode(code, 'hydro.probe')) return { ...base, title: t('warn.probe') }
  return { ...base, title: t('warn.unknown'), detail: safeDetail(warning.message) }
}

/** Props of {@link WarningList}. */
export interface WarningListProps {
  /** Warnings from the Host (status or system-check payload). */
  warnings: StatusWarning[]
  /** Text shown when there are none. */
  emptyText?: string
}

/**
 * Render localized, severity-colored warnings with an optional details
 * disclosure and navigation shortcut.
 * @param props - warnings and empty text.
 * @returns the list element.
 */
export function WarningList({ warnings, emptyText }: WarningListProps) {
  const { t } = useI18n()
  const { navigate } = useConsole()
  if (warnings.length === 0) return <p style={okText}>{emptyText ?? t('status.noWarnings')}</p>

  const severityLabel = {
    error: t('severity.error'),
    warning: t('severity.warning'),
    info: t('severity.info'),
  }
  const severityStyle = (severity: StatusWarning['severity']): { borderColor: string; color: string } => {
    if (severity === 'error') return { borderColor: colors.danger, color: colors.danger }
    if (severity === 'warning') return { borderColor: colors.warning, color: colors.warning }
    return { borderColor: colors.info, color: colors.muted }
  }

  return (
    <div style={stack}>
      {warnings.map((warning, index) => {
        const localized = localizeWarning(warning, t)
        return (
          <div key={`${warning.code}-${String(index)}`} style={{ ...warningItem, ...severityStyle(warning.severity) }}>
            <span style={{ fontWeight: 600 }}>{localized.title}</span>
            <span style={time}>{severityLabel[warning.severity]}</span>
            {localized.action === 'site-accounts' ? (
              <span>
                <button type="button" style={linkButton} onClick={() => { navigate('settings/site-accounts') }}>
                  {t('warn.actionSite')}
                </button>
              </span>
            ) : null}
            {localized.detail === null ? null : (
              <details style={inlineDetails} open>
                <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
                <p style={detailText}>{localized.detail}</p>
                <span style={time}>{localized.code}</span>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
