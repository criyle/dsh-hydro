/**
 * Client-side localization of Host known-issue diagnostics.
 *
 * The Host sends a stable code plus a Chinese `detail`; primary copy is always
 * localized here, raw detail is only offered behind a "details" disclosure when
 * it is not Chinese. Fix ids are mapped to a safe action where possible:
 * `restart-service` becomes a concrete pm2 target derived from the issue code;
 * the two Hydro-setting fixes stay disabled until the Host exposes a route.
 */
import type { HostIssue } from '../shared/api.js'
import type { ServiceTarget } from './api.js'
import { containsCjk } from './format.js'
import type { TranslateFn } from './locales.js'

/** One issue with operator-facing copy and an executable fix. */
export interface LocalizedIssue {
  severity: HostIssue['severity']
  /** Localized headline. */
  title: string
  /** Localized suggestion. */
  suggestion: string
  /** Backend detail, only when it is not Chinese. */
  detail: string | null
  code: string
  /** Fix id from the Host, if any. */
  fix: HostIssue['fix']
  /** Concrete service to restart for `restart-service`, else null. */
  restartTarget: ServiceTarget | null
  /** True when the fix exists but cannot be executed from the console yet. */
  fixDisabled: boolean
}

/** Fix ids the Host route can execute today. */
const SUPPORTED_FIXES = new Set(['restart-service', 'install-ui-plugin'])

/** Classify one issue code into a localized message family. */
function classify(code: string): 'disk' | 'sandbox' | 'judge' | 'hydro' | 'health' | 'restarts' | 'langs' | 'ui' | 'stale' | 'queue' | 'unknown' {
  const lower = code.toLowerCase()
  if (lower.includes('disk')) return 'disk'
  if (lower.includes('sandbox')) return 'sandbox'
  if (lower.includes('judge')) return 'judge'
  if (lower.includes('health')) return 'health'
  if (lower.includes('stale')) return 'stale'
  if (lower.includes('queue')) return 'queue'
  if (lower.includes('restart')) return 'restarts'
  if (lower.includes('lang')) return 'langs'
  if (lower.includes('plugin') || lower.includes('ui')) return 'ui'
  if (lower.includes('hydro')) return 'hydro'
  return 'unknown'
}

/**
 * Map one Host issue to localized copy + fix metadata.
 * @param issue - issue from the Host.
 * @param t - active translator.
 * @returns the localized issue.
 */
export function localizeIssue(issue: HostIssue, t: TranslateFn): LocalizedIssue {
  const family = classify(issue.code)
  const detail = issue.detail === null || issue.detail.trim() === '' || containsCjk(issue.detail) ? null : issue.detail
  const restartTarget = issue.fix === 'restart-service' ? issue.fixTarget : null
  const fix = issue.fix
  const fixDisabled = fix !== null && (!SUPPORTED_FIXES.has(fix) || (fix === 'restart-service' && restartTarget === null))
  const base = { severity: issue.severity, detail, code: issue.code, fix, restartTarget, fixDisabled }
  switch (family) {
    case 'disk':
      return { ...base, title: t('issue.diskSpace'), suggestion: t('issue.suggest.diskSpace') }
    case 'sandbox':
      return { ...base, title: t('issue.sandboxStopped'), suggestion: t('issue.suggest.sandboxStopped') }
    case 'judge':
      return { ...base, title: t('issue.judgeStopped'), suggestion: t('issue.suggest.judgeStopped') }
    case 'health':
      return { ...base, title: t('issue.health'), suggestion: t('issue.suggest.health') }
    case 'stale':
      return { ...base, title: t('issue.staleQueue'), suggestion: t('issue.suggest.staleQueue') }
    case 'queue':
      return { ...base, title: t('issue.queue'), suggestion: t('issue.suggest.queue') }
    case 'restarts':
      return { ...base, title: t('issue.restarts'), suggestion: t('issue.suggest.restarts') }
    case 'langs':
      return { ...base, title: t('issue.langsMissing'), suggestion: t('issue.suggest.langsMissing') }
    case 'ui':
      return { ...base, title: t('issue.uiPluginMissing'), suggestion: t('issue.suggest.uiPluginMissing') }
    case 'hydro':
      return { ...base, title: t('issue.hydroStopped'), suggestion: t('issue.suggest.hydroStopped') }
    default:
      return { ...base, title: t('issue.unknown'), suggestion: t('issue.suggest.generic') }
  }
}
