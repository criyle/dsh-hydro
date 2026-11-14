/**
 * Shared embedded Problems/Contests page. Each concrete page only supplies the
 * kind so both keep identical AI/domain affordances.
 */
import { SiteAiButton, EmbeddedContextBadge } from '../SiteAiActions.js'
import { EmbeddedHydro } from '../EmbeddedHydro.js'
import { useConsole } from '../console-context.js'
import { useEmbeddedContext } from '../hooks.js'
import { useI18n } from '../i18n.js'
import { page, stack } from '../styles.js'
import { PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'
import { DomainSelect, NeedSiteAccount, SiteSessionGate } from './SiteShared.js'

/** Shared embedded page for Problems and Contests. */
export function EmbeddedCollectionPage({ kind }: { kind: 'problem' | 'contest' }) {
  const { t } = useI18n()
  const { activeHost, activeSiteAccount, page: activePage } = useConsole()
  const embedded = useEmbeddedContext(
    activeHost?.id ?? null,
    activePage === (kind === 'problem' ? 'site/problems' : 'site/contests'),
    t,
  )
  if (activeHost === undefined) return <NeedHost />
  if (activeSiteAccount === undefined) return <NeedSiteAccount />
  const domain = activeSiteAccount.domain
  const title = kind === 'problem' ? t('problems.title') : t('contests.title')
  const hint = kind === 'problem'
    ? `${t('problems.hint')} ${t('problem.aiCapabilities')}`
    : `${t('contests.hint')} ${t('contest.aiCapabilities')}`
  const path = kind === 'problem'
    ? `/d/${encodeURIComponent(domain)}/p`
    : `/d/${encodeURIComponent(domain)}/contest`
  return (
    <SiteSessionGate account={activeSiteAccount}>
    <div style={page}>
      <PageHeading
        title={title}
        hint={hint}
        meta={<EmbeddedContextBadge context={embedded.context} pageKind={kind} />}
        actions={(
          <div style={stack}>
            <DomainSelect account={activeSiteAccount} />
            <SiteAiButton
              siteAccountId={activeSiteAccount.id}
              pageKind={kind}
              domain={domain}
              context={embedded.context}
            />
          </div>
        )}
      />
      <EmbeddedHydro
        hostId={activeHost.id}
        path={path}
        title={title}
        sessionKey={activeSiteAccount.id}
        initialPath={path}
        onRefresh={embedded.refresh}
      />
    </div>
    </SiteSessionGate>
  )
}
