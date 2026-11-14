/**
 * Domain settings page: switch the active site account's default domain and
 * embed Hydro's real domain editor. The selector itself lives in SiteShared.
 */
import { useEffect, useState } from 'react'
import type { SiteDomainsResponse, SiteSaveResponse } from '../../shared/api.js'
import { describeError, hydroApi } from '../api.js'
import { DomainAiAction, EmbeddedContextBadge } from '../SiteAiActions.js'
import { EmbeddedHydro } from '../EmbeddedHydro.js'
import { SessionNotice } from '../SessionNotice.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask, useEmbeddedContext } from '../hooks.js'
import { useI18n } from '../i18n.js'
import { inlineRow, mutedText, page, select, stack } from '../styles.js'
import { ErrorLine, PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'
import { NeedSiteAccount, SiteSessionGate } from './SiteShared.js'

/** Domains page: switch the active site account's default domain + embedded editor. */
export function DomainsPage() {
  const { t } = useI18n()
  const { activeHost, activeSiteAccount, site, page: activePage } = useConsole()
  const domains = useAsyncTask<SiteDomainsResponse>(t)
  const save = useAsyncTask<SiteSaveResponse>(t)
  const embedded = useEmbeddedContext(activeHost?.id ?? null, activePage === 'site/domain', t)
  const [selected, setSelected] = useState('')
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const siteAccountId = activeSiteAccount?.id ?? null

  useEffect(() => {
    if (siteAccountId === null) return
    void domains.run((signal) => hydroApi.listSiteDomains(siteAccountId, signal))
  }, [siteAccountId])

  useEffect(() => {
    setSelected(activeSiteAccount?.domain ?? '')
  }, [activeSiteAccount?.id, activeSiteAccount?.domain])

  if (activeHost === undefined) return <NeedHost />
  if (activeSiteAccount === undefined) return <NeedSiteAccount />

  const fallback = [{ id: activeSiteAccount.domain, name: activeSiteAccount.domain }]
  const options = domains.data !== null && (domains.data.domains ?? []).length > 0 ? domains.data.domains : fallback
  const domain = selected === '' ? activeSiteAccount.domain : selected

  const switchDomain = (next: string): void => {
    setSelected(next)
    setSaveNotice(null)
    void save.run((signal) => hydroApi.saveSiteAccount({
      id: activeSiteAccount.id,
      hostId: activeSiteAccount.hostId,
      domain: next,
    }, signal)).then((result) => {
      if (result === null) return
      setSaveNotice(t('domain.saved'))
      site.reload()
    }, (cause: unknown) => {
      setSaveNotice(t('domain.saveFailed', { message: describeError(cause, t) }))
    })
  }

  return (
    <SiteSessionGate account={activeSiteAccount}>
    <div style={page}>
      <PageHeading
        title={t('menu.domain')}
        hint={t('domain.hint')}
        meta={<EmbeddedContextBadge context={embedded.context} pageKind="domain" />}
        actions={(
          <div style={stack}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ ...mutedText, fontSize: 12 }}>{t('domain.select')}</span>
              <select
                style={select}
                value={domain}
                disabled={save.busy || domains.busy}
                onChange={(event) => { switchDomain(event.currentTarget.value) }}
              >
                {options.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.name === entry.id ? entry.name : `${entry.name} (${entry.id})`}</option>
                ))}
              </select>
            </label>
            <div style={inlineRow}>
              <DomainAiAction siteAccountId={activeSiteAccount.id} domain={domain} mode="bulletin" />
              <DomainAiAction siteAccountId={activeSiteAccount.id} domain={domain} mode="permissions" />
            </div>
          </div>
        )}
      />
      <ErrorLine text={domains.error} />
      <ErrorLine text={save.error} />
      <SessionNotice error={domains.error ?? save.error} />
      {saveNotice === null ? null : <p style={{ ...mutedText, margin: 0 }}>{saveNotice}</p>}
      <EmbeddedHydro
        hostId={activeHost.id}
        path={`/d/${encodeURIComponent(domain)}/domain/edit`}
        title={t('domain.editTitle')}
        sessionKey={activeSiteAccount.id}
        initialPath={`/d/${encodeURIComponent(domain)}/domain/edit`}
        onRefresh={embedded.refresh}
        links={[{ label: t('domain.openHome'), path: `/d/${encodeURIComponent(domain)}/` }]}
      />
    </div>
    </SiteSessionGate>
  )
}
