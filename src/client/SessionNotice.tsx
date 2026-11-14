/**
 * Session-expiry hint shared by site pages.
 *
 * Backend site tools fail with a "Hydro 登录已过期…" message when the
 * proxy-captured session is missing/expired; API tasks keep that localized
 * message as a plain string, so detection is text-based. The notice is a clear
 * localized banner plus a shortcut to the Hydro-accounts login browser.
 */
import { ApiRequestError } from './api.js'
import { useConsole } from './console-context.js'
import { useI18n } from './i18n.js'
import { linkButton, warningText } from './styles.js'

/** Whether an error looks like a missing/expired Hydro browser session. */
export function isSessionError(error: unknown): boolean {
  let text = ''
  if (typeof error === 'string') text = error
  else if (error instanceof ApiRequestError) text = `${error.code} ${error.message}`
  else if (error instanceof Error) text = error.message
  if (text === '') return false
  return /\u767b\u5f55|session|sid|expired|unauth/i.test(text)
}

/** Props of {@link SessionNotice}. */
export interface SessionNoticeProps {
  /** Task error (string or Error); rendered only for session failures. */
  error: unknown
}

/**
 * Render the localized "log in again" banner when the error is session-related.
 * @param props - task error.
 * @returns the banner or null.
 */
export function SessionNotice({ error }: SessionNoticeProps) {
  const { t } = useI18n()
  const { navigate } = useConsole()
  if (!isSessionError(error)) return null
  return (
    <div style={warningText}>
      <span>{t('session.expiredHint')} </span>
      <button type="button" style={linkButton} onClick={() => { navigate('settings/site-accounts') }}>
        {t('session.openLogin')}
      </button>
    </div>
  )
}
