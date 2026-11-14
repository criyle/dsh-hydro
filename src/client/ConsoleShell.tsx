/**
 * Console shell v6.
 *
 * Header: identity + top-right host/Hydro-account switchers and the global
 * readonly switch. Below: a component-oriented left menu — 概览 first, then
 * HydroOJ (install/upgrade, plugins, CLI), Nix, Caddy, PM2, MongoDB and
 * Troubleshoot as single entries, then Site and Settings groups. Visited
 * pages stay mounted (hidden) so state — including streamed terminals — is
 * preserved; the menu collapses to a select on narrow screens.
 */
import { useEffect, useState } from 'react'
import type { ConsolePage } from './console-context.js'
import { useConsole } from './console-context.js'
import { describeError } from './api.js'
import { useMediaQuery } from './hooks.js'
import { useI18n } from './i18n.js'
import type { MessageKey } from './locales.js'
import { ReadonlyToggle } from './ReadonlyToggle.js'
import {
  button,
  headerControls,
  menu,
  menuItem,
  menuItemActive,
  menuSection,
  menuSectionTitle,
  select,
  selectField,
  subtitle,
  title,
  topBar,
  workspace,
} from './styles.js'
import { ErrorLine } from './ui.js'
import { MongoPage } from './pages/DataPages.js'
import { ContestsPage } from './pages/ContestsPage.js'
import { DomainsPage } from './pages/DomainsPage.js'
import { ProblemsPage } from './pages/ProblemsPage.js'
import { QuestionsPage } from './pages/QuestionsPage.js'
import { NeedSiteAccount } from './pages/SiteShared.js'
import { CommunityPage } from './pages/CommunityPage.js'
import { SiteAccountsPage } from './pages/SiteAccountsPage.js'
import { HostsPage } from './pages/HostsPage.js'
import { CaddyPage } from './pages/CaddyPage.js'
import { HydroCliPage } from './pages/HydroCliPage.js'
import { NixPage } from './pages/NixPage.js'
import { InstallUpgradePage, OverviewPage, TroubleshootPage } from './pages/OpsPages.js'
import { PluginsPage } from './pages/PluginsPage.js'
import { ServicesPage } from './pages/ServicesPage.js'
import { JudgePage } from './pages/JudgePage.js'

/** One menu entry. */
interface MenuEntry {
  page: ConsolePage
  label: MessageKey
}

/** A top-level single page or a labelled group. */
type MenuBlock =
  | { kind: 'single'; page: ConsolePage; label: MessageKey }
  | { kind: 'group'; label: MessageKey; entries: readonly MenuEntry[] }

/** The left menu definition (component-oriented). */
const MENU: readonly MenuBlock[] = [
  { kind: 'single', page: 'ops/overview', label: 'menu.overview' },
  {
    kind: 'group',
    label: 'menu.server',
    entries: [
      { page: 'ops/install-upgrade', label: 'menu.installUpgrade' },
      { page: 'ops/plugins', label: 'menu.plugins' },
      { page: 'ops/cli', label: 'menu.cli' },
      { page: 'ops/nix', label: 'menu.nix' },
      { page: 'ops/caddy', label: 'menu.caddy' },
      { page: 'ops/services', label: 'menu.pm2' },
      { page: 'ops/judge', label: 'menu.judge' },
      { page: 'ops/mongodb', label: 'menu.mongodb' },
      { page: 'ops/troubleshoot', label: 'menu.troubleshoot' },
    ],
  },
  {
    kind: 'group',
    label: 'menu.site',
    entries: [
      { page: 'site/domain', label: 'menu.domain' },
      { page: 'site/questions', label: 'menu.questions' },
      { page: 'site/problems', label: 'menu.problems' },
      { page: 'site/contests', label: 'menu.contests' },
      { page: 'site/community', label: 'menu.community' },
    ],
  },
  {
    kind: 'group',
    label: 'menu.settings',
    entries: [
      { page: 'settings/hosts', label: 'menu.hosts' },
      { page: 'settings/site-accounts', label: 'menu.siteAccounts' },
    ],
  },
]

/** Render one page by id. */
function renderPage(pageId: ConsolePage) {
  switch (pageId) {
    case 'ops/overview': return <OverviewPage />
    case 'ops/install-upgrade': return <InstallUpgradePage />
    case 'ops/plugins': return <PluginsPage />
    case 'ops/cli': return <HydroCliPage />
    case 'ops/nix': return <NixPage />
    case 'ops/caddy': return <CaddyPage />
    case 'ops/services': return <ServicesPage />
    case 'ops/judge': return <JudgePage />
    case 'ops/mongodb': return <MongoPage />
    case 'ops/troubleshoot': return <TroubleshootPage />
    case 'site/domain': return <DomainsPage />
    case 'site/questions': return <QuestionsPage />
    case 'site/problems': return <ProblemsPage />
    case 'site/contests': return <ContestsPage />
    case 'site/community': return <CommunityPage />
    case 'settings/hosts': return <HostsPage />
    case 'settings/site-accounts': return <SiteAccountsPage />
    default: return <NeedSiteAccount />
  }
}

/** Render one menu entry button. */
function MenuButton({ entry, active, navigate }: { entry: MenuEntry; active: boolean; navigate(page: ConsolePage): void }) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      data-page={entry.page}
      aria-current={active ? 'page' : undefined}
      style={active ? menuItemActive : menuItem}
      onClick={() => { navigate(entry.page) }}
    >
      {t(entry.label)}
    </button>
  )
}

/**
 * Render the console header, component menu and active page.
 * @returns the shell element.
 */
export function ConsoleShell() {
  const { t } = useI18n()
  const { hosts, site, settings, page: activePage, navigate, selectHost, selectSiteAccount, requestWrites } = useConsole()
  const narrow = useMediaQuery('(max-width: 760px)')
  const [switching, setSwitching] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [visited, setVisited] = useState<readonly ConsolePage[]>([activePage])

  useEffect(() => {
    setVisited((current) => (current.includes(activePage) ? current : [...current, activePage]))
  }, [activePage])

  const changeHost = (id: string): void => {
    if (id === '') return
    setSwitching(true)
    setSwitchError(null)
    void selectHost(id).catch((cause: unknown) => {
      setSwitchError(t('header.hostSwitchFailed', { message: describeError(cause, t) }))
    }).finally(() => { setSwitching(false) })
  }

  const changeSiteAccount = (id: string): void => {
    if (id === '') return
    setSwitching(true)
    setSwitchError(null)
    void selectSiteAccount(id).catch((cause: unknown) => {
      setSwitchError(t('header.siteSwitchFailed', { message: describeError(cause, t) }))
    }).finally(() => { setSwitching(false) })
  }

  const changeReadonly = (next: boolean): void => {
    if (!next) {
      void requestWrites()
      return
    }
    void settings.setReadonly(true)
  }

  return (
    <div data-hydro-console="" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header style={topBar}>
        <div>
          <h1 style={title}>{t('panel.title')}</h1>
          <p style={subtitle}>{t('panel.subtitle')}</p>
        </div>
        <div style={headerControls}>
          <label style={selectField}>
            <span>{t('header.host')}</span>
            <select
              style={select}
              value={hosts.activeAccountId ?? ''}
              disabled={switching || hosts.phase === 'loading' || hosts.accounts.length === 0}
              onChange={(event) => { changeHost(event.currentTarget.value) }}
            >
              {hosts.accounts.length === 0 ? (
                <option value="">{t('header.noHost')}</option>
              ) : hosts.activeAccountId === null ? (
                <option value="" disabled>{t('header.chooseHost')}</option>
              ) : null}
              {hosts.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} · {account.username}@{account.host}
                </option>
              ))}
            </select>
          </label>
          <button type="button" style={button} onClick={() => { navigate('settings/hosts') }}>
            {t('header.manageHosts')}
          </button>
          <label style={selectField}>
            <span>{t('header.siteAccount')}</span>
            <select
              style={select}
              value={site.activeSiteAccountId ?? ''}
              disabled={switching || site.phase === 'loading' || site.accounts.length === 0}
              onChange={(event) => { changeSiteAccount(event.currentTarget.value) }}
            >
              {site.accounts.length === 0 ? (
                <option value="">{t('header.noSite')}</option>
              ) : site.activeSiteAccountId === null ? (
                <option value="" disabled>{t('header.chooseSite')}</option>
              ) : null}
              {site.accounts.map((account) => {
                const statusKey = account.sessionState === 'expired'
                  ? 'header.sessionExpired'
                  : account.sessionState === 'active'
                    ? 'header.sessionActive'
                    : account.hasSession ? 'header.sessionUnknown' : 'header.sessionMissing'
                return (
                  <option key={account.id} value={account.id}>
                    {account.uname} · {t(statusKey)}
                    {account.hostId === hosts.activeAccountId ? '' : ` · ${account.hostLabel}`}
                  </option>
                )
              })}
            </select>
          </label>
          <ReadonlyToggle
            readonly={settings.readonlyMode}
            busy={settings.saving || settings.phase === 'loading'}
            onChange={changeReadonly}
          />
        </div>
      </header>

      <ErrorLine text={switchError} />
      <ErrorLine text={settings.error} />

      <div style={narrow ? { ...workspace, gridTemplateColumns: 'minmax(0, 1fr)' } : { ...workspace, gridTemplateColumns: '200px minmax(0, 1fr)' }}>
        {narrow ? (
          <label style={selectField}>
            <span>{t('menu.narrowLabel')}</span>
            <select style={select} value={activePage} onChange={(event) => { navigate(event.currentTarget.value as ConsolePage) }}>
              {MENU.map((block) => block.kind === 'single' ? (
                <option key={block.page} value={block.page}>{t(block.label)}</option>
              ) : (
                <optgroup key={block.label} label={t(block.label)}>
                  {block.entries.map((entry) => (
                    <option key={entry.page} value={entry.page}>{t(entry.label)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        ) : (
          <nav aria-label={t('panel.title')} style={menu}>
            {MENU.map((block) => block.kind === 'single' ? (
              <MenuButton key={block.page} entry={{ page: block.page, label: block.label }} active={activePage === block.page} navigate={navigate} />
            ) : (
              <div key={block.label} style={menuSection}>
                <h3 style={{ ...menuSectionTitle }}>{t(block.label)}</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingLeft: 9 }}>
                  {block.entries.map((entry) => (
                    <MenuButton key={entry.page} entry={entry} active={activePage === entry.page} navigate={navigate} />
                  ))}
                </div>
              </div>
            ))}
          </nav>
        )}
        <main style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {visited.map((pageId) => (
            <div key={pageId} style={pageId === activePage ? undefined : { display: 'none' }}>
              {renderPage(pageId)}
            </div>
          ))}
        </main>
      </div>
    </div>
  )
}
