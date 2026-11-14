/**
 * Shared site-page building blocks: the missing-account gate and the domain
 * selector used by every embedded site page.
 */
import { useEffect, type ReactNode } from 'react'
import type {
  SiteAccountSummary,
  SiteDomainsResponse,
  SiteSaveResponse,
  SiteSessionStatus,
} from '../../shared/api.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import { mutedText, select, stack } from '../styles.js'
import { Card, EmptyState, ErrorLine } from '../ui.js'

/** Prompt shown on site pages that need an active site account. */
export function NeedSiteAccount() {
  const { t } = useI18n()
  const { navigate, activeHost } = useConsole()
  const judgeOnly = activeHost?.hydro?.installMode === 'judge'
  return (
    <Card>
      <EmptyState
        message={judgeOnly ? t('page.judgeOnlySite') : t('page.needSite')}
        {...(judgeOnly
          ? { actionLabel: t('menu.judge'), onAction: () => { navigate('ops/judge') } }
          : { actionLabel: t('page.goSiteAccounts'), onAction: () => { navigate('settings/site-accounts') } })}
      />
    </Card>
  )
}

/** Gate for pages that require a valid Hydro browser session. */
export function SiteSessionGate({ account, children }: { account: SiteAccountSummary; children: ReactNode }) {
  const { t } = useI18n()
  const { navigate, site } = useConsole()
  const status = useAsyncTask<SiteSessionStatus>(t)

  useEffect(() => {
    void status.run((signal) => hydroApi.siteSession(account.id, signal))
    // Re-check when the selected account changes.
  }, [account.id])

  useEffect(() => {
    if (status.data === null) return
    // Reflect the validated state in the header account switcher.
    site.reload()
    // Only when a new validation result arrives.
  }, [status.data?.checkedAt, status.data?.state])

  const current = status.data
  if (current !== null && current.state === 'active') return <>{children}</>

  return (
    <Card>
      <EmptyState
        message={current === null
          ? (status.busy ? t('session.checking') : t('session.checkFailed'))
          : current.state === 'expired'
            ? t('session.expiredHint')
            : t('session.requiredHint')}
        actionLabel={t('session.goLogin')}
        onAction={() => {
          site.reload()
          navigate('settings/site-accounts')
        }}
      />
      {status.error === null ? null : <ErrorLine text={status.error} />}
    </Card>
  )
}

/** Shared domain selector for every site page. */
export function DomainSelect({ account }: { account: SiteAccountSummary }) {
  const { t } = useI18n()
  const { site, requestWrites, requestConfirm } = useConsole()
  const domains = useAsyncTask<SiteDomainsResponse>(t)
  const save = useAsyncTask<SiteSaveResponse>(t)

  useEffect(() => {
    void domains.run((signal) => hydroApi.listSiteDomains(account.id, signal))
    // Reload when the site account changes.
  }, [account.id])

  const options = domains.data !== null && (domains.data.domains ?? []).length > 0
    ? domains.data.domains
    : [{ id: account.domain, name: account.domain }]

  const change = (next: string): void => {
    if (next === account.domain) return
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('domain.switchConfirm', { domain: next }) }))) return
      const result = await save.run((signal) => hydroApi.saveSiteAccount({
        id: account.id,
        hostId: account.hostId,
        domain: next,
      }, signal))
      if (result !== null) site.reload()
    })()
  }

  return (
    <span style={stack}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...mutedText, fontSize: 12 }}>{t('domain.select')}</span>
        <select style={select} value={account.domain} disabled={save.busy} onChange={(event) => { change(event.currentTarget.value) }}>
          {options.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name === entry.id ? entry.name : `${entry.name} (${entry.id})`}</option>
          ))}
        </select>
      </label>
      <ErrorLine text={domains.error ?? save.error} />
    </span>
  )
}
