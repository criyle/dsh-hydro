/**
 * Console data provider.
 *
 * One provider owns the data every page needs — the SSH host list (with its
 * active id), the site-account list (with its active id), and the global
 * operator settings (readonly switch) — so the top-right switchers and all
 * pages observe the same state. Pages are rendered by `ConsoleShell` and only
 * receive navigation through this context.
 *
 * A safe default value keeps individual pages renderable in isolation (SSR
 * tests, storybook-style previews) without a provider.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SiteAccountSummary } from '../shared/api.js'
import type { AccountSummary } from '../shared/types.js'
import { hydroApi } from './api.js'
import {
  useAccounts,
  useSiteAccounts,
  useUiSettings,
  type AccountsView,
  type SiteAccountsView,
  type SettingsView,
} from './hooks.js'
import { useI18n } from './i18n.js'
import { button, primaryButton } from './styles.js'
import { Dialog } from './ui.js'

/** Every page reachable from the left menu. */
export type ConsolePage =
  | 'ops/overview'
  | 'ops/install-upgrade'
  | 'ops/plugins'
  | 'ops/nix'
  | 'ops/caddy'
  | 'ops/cli'
  | 'ops/services'
  | 'ops/judge'
  | 'ops/mongodb'
  | 'ops/troubleshoot'
  | 'site/domain'
  | 'site/questions'
  | 'site/problems'
  | 'site/contests'
  | 'site/community'
  | 'settings/hosts'
  | 'settings/site-accounts'

/** Options for the plugin's host-styled confirmation dialog. */
export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
}

/** Value exposed to every console component. */
export interface ConsoleValue {
  /** SSH host records + active host id. */
  hosts: AccountsView
  /** Hydro web accounts + active site-account id. */
  site: SiteAccountsView
  /** Global readonly setting. */
  settings: SettingsView
  /** Currently rendered page. */
  page: ConsolePage
  /** Navigate to one page. */
  navigate(page: ConsolePage): void
  /** The active SSH host, when one is selected. */
  activeHost: AccountSummary | undefined
  /** The active site account, when one is selected. */
  activeSiteAccount: SiteAccountSummary | undefined
  /** Reload host + site account lists. */
  refreshAll(): void
  /** Activate a host and refresh the list (throws on Host error). */
  selectHost(id: string): Promise<void>
  /** Activate a site account and refresh the list (throws on Host error). */
  selectSiteAccount(id: string): Promise<void>
  /**
   * Ensure writes are allowed: when global readonly is on, open an in-app
   * confirmation and turn it off on approval. Resolves false when cancelled or
   * when the setting could not be changed.
   */
  requestWrites(): Promise<boolean>
  /** Ask for confirmation using the plugin's host-styled modal. */
  requestConfirm(options: ConfirmOptions): Promise<boolean>
}

const noop = (): void => undefined
const noopAsync = async (): Promise<void> => undefined
const noopReadonly = async (): Promise<boolean> => false

/** Safe default used outside a provider (SSR of one page). */
function createDefaultValue(): ConsoleValue {
  return {
    hosts: { accounts: [], activeAccountId: null, phase: 'ready', error: null, reload: noop },
    site: { accounts: [], activeSiteAccountId: null, phase: 'ready', error: null, reload: noop },
    settings: { readonlyMode: false, updatedAt: null, phase: 'ready', error: null, saving: false, reload: noop, setReadonly: noopReadonly },
    page: 'ops/overview',
    navigate: noop,
    activeHost: undefined,
    activeSiteAccount: undefined,
    refreshAll: noop,
    selectHost: noopAsync,
    selectSiteAccount: noopAsync,
    requestWrites: async () => true,
    requestConfirm: async () => false,
  }
}

const ConsoleContext = createContext<ConsoleValue>(createDefaultValue())

/**
 * Wrap the console and load its shared data.
 * @param props - children to render inside the provider.
 * @returns the provider element.
 */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const hosts = useAccounts(t)
  const site = useSiteAccounts(t)
  const settings = useUiSettings(t)
  const [page, setPage] = useState<ConsolePage>('ops/overview')
  const [confirmOptions, setConfirmOptions] = useState<ConfirmOptions | null>(null)
  const confirmResolver = useRef<((allowed: boolean) => void) | null>(null)
  const navigate = useCallback((next: ConsolePage): void => { setPage(next) }, [])

  const activeHost = hosts.accounts.find((account) => account.id === hosts.activeAccountId)
  const activeSiteAccount = site.accounts.find((account) => account.id === site.activeSiteAccountId)

  const refreshAll = useCallback((): void => {
    hosts.reload()
    site.reload()
  }, [hosts.reload, site.reload])

  const requestConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve
      setConfirmOptions(options)
    })
  }, [])

  const settleConfirm = useCallback((allowed: boolean): void => {
    setConfirmOptions(null)
    const resolve = confirmResolver.current
    confirmResolver.current = null
    resolve?.(allowed)
  }, [])

  const closeConfirm = useCallback((): void => { settleConfirm(false) }, [settleConfirm])

  const requestWrites = useCallback(async (): Promise<boolean> => {
    if (!settings.readonlyMode) return true
    const allowed = await requestConfirm({
      title: t('readonly.confirmTitle'),
      description: t('readonly.confirmBody'),
      confirmLabel: t('readonly.turnOff'),
      cancelLabel: t('form.cancel'),
    })
    if (!allowed) return false
    return settings.setReadonly(false)
  }, [settings.readonlyMode, settings.setReadonly, requestConfirm, t])

  const selectHost = useCallback(async (id: string): Promise<void> => {
    await hydroApi.activateAccount(id)
    hosts.reload()
  }, [hosts.reload])

  const selectSiteAccount = useCallback(async (id: string): Promise<void> => {
    await hydroApi.activateSiteAccount(id)
    site.reload()
  }, [site.reload])

  const value = useMemo<ConsoleValue>(() => ({
    hosts,
    site,
    settings,
    page,
    navigate,
    activeHost,
    activeSiteAccount,
    refreshAll,
    selectHost,
    selectSiteAccount,
    requestWrites,
    requestConfirm,
  }), [hosts, site, settings, page, navigate, activeHost, activeSiteAccount, refreshAll, selectHost, selectSiteAccount, requestWrites, requestConfirm])

  return (
    <ConsoleContext.Provider value={value}>
      {children}
      <Dialog
        open={confirmOptions !== null}
        title={confirmOptions?.title ?? ''}
        {...(confirmOptions?.description === undefined ? {} : { description: confirmOptions.description })}
        onClose={closeConfirm}
        footer={confirmOptions === null ? undefined : (
          <>
            <button type="button" style={button} data-modal-autofocus onClick={() => { settleConfirm(false) }}>
              {confirmOptions.cancelLabel ?? t('form.cancel')}
            </button>
            <button type="button" style={primaryButton} onClick={() => { settleConfirm(true) }}>
              {confirmOptions.confirmLabel ?? t('common.confirm')}
            </button>
          </>
        )}
      />
    </ConsoleContext.Provider>
  )
}

/** Read the console data/navigation context. */
export function useConsole(): ConsoleValue {
  return useContext(ConsoleContext)
}
