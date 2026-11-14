/** ZIP question-package import page. */
import { useI18n } from '../i18n.js'
import { ZipQuestionImport } from '../ZipQuestionImport.js'
import { useConsole } from '../console-context.js'
import { page } from '../styles.js'
import { Card, PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'
import { DomainSelect, NeedSiteAccount, SiteSessionGate } from './SiteShared.js'

/** Question import page: official Hydro ZIP problem-package import. */
export function QuestionsPage() {
  const { t } = useI18n()
  const { activeHost, activeSiteAccount } = useConsole()
  if (activeHost === undefined) return <NeedHost />
  if (activeSiteAccount === undefined) return <NeedSiteAccount />
  return (
    <SiteSessionGate account={activeSiteAccount}>
    <div style={page}>
      <PageHeading
        title={t('menu.questions')}
        hint={t('qzip.hint')}
        actions={<DomainSelect account={activeSiteAccount} />}
      />
      <Card title={t('qzip.title')} hint={t('qzip.zipHint')}>
        <ZipQuestionImport siteAccountId={activeSiteAccount.id} />
      </Card>
    </div>
    </SiteSessionGate>
  )
}
