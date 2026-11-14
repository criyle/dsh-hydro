/**
 * Settings page for Hydro site accounts: multi-account CRUD, session checks and
 * activity switch. Kept separate from the site content pages.
 */
import { useEffect, useRef, useState } from 'react'
import type { SiteAccountSummary, SiteSessionStatus } from '../../shared/api.js'
import { hydroApi } from '../api.js'
import type { SiteSavePayload } from '../api.js'
import { SiteAccountForm } from '../SiteAccountForm.js'
import { EmbeddedHydro } from '../EmbeddedHydro.js'
import { useConsole } from '../console-context.js'
import { formatSiteRole, formatTime } from '../format.js'
import { useActionRunner } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  accountRow,
  accountRowActive,
  activeBadge,
  badge,
  button,
  dangerButton,
  errorBadge,
  errorText,
  flashError,
  inlineRow,
  mutedText,
  okBadge,
  page,
  primaryButton,
  sectionTitle,
  stack,
  time,
  warningText,
} from '../styles.js'
import { Card, EmptyState, Flash, PageHeading } from '../ui.js'

/** One form's open state. */
interface SiteAccountFormState {
  initial: SiteAccountSummary | null
}

/** Site accounts page (Settings): multi-account CRUD and activity switch. */
export function SiteAccountsPage() {
  const { t, locale } = useI18n()
  const { site, hosts, navigate, requestWrites, requestConfirm } = useConsole()
  const runner = useActionRunner(t)
  const [form, setForm] = useState<SiteAccountFormState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Record<string, SiteSessionStatus>>({})
  const [checking, setChecking] = useState(false)
  const [loginAccountId, setLoginAccountId] = useState<string | null>(null)
  const sessionGeneration = useRef(0)
  const noHosts = hosts.phase === 'ready' && hosts.accounts.length === 0
  const accountIds = site.accounts.map((account) => account.id).join('|')

  useEffect(() => {
    setSelectedId((current) => {
      if (site.accounts.length === 0) return null
      if (current !== null && site.accounts.some((account) => account.id === current)) return current
      return site.activeSiteAccountId ?? site.accounts[0]?.id ?? null
    })
  }, [site.accounts, site.activeSiteAccountId])

  const refresh = (): void => {
    site.reload()
    hosts.reload()
  }

  const checkSessions = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    setChecking(true)
    const generation = ++sessionGeneration.current
    void Promise.all(ids.map(async (id) => {
      const status = await hydroApi.siteSession(id)
      return [id, status] as const
    })).then((entries) => {
      if (generation !== sessionGeneration.current) return
      setSessions((current) => {
        const next = { ...current }
        for (const [id, status] of entries) next[id] = status
        return next
      })
      // Refresh summaries so the header dropdown reflects the validated state.
      site.reload()
    }, () => undefined).finally(() => {
      if (generation === sessionGeneration.current) setChecking(false)
    })
  }

  useEffect(() => {
    if (site.accounts.length === 0) return
    checkSessions(site.accounts.map((account) => account.id))
    // Refresh session state when accounts are added/removed, not on every reload.
  }, [accountIds])

  const openLogin = (account: SiteAccountSummary): void => {
    setLoginAccountId(account.id)
    if (site.activeSiteAccountId !== account.id) {
      void hydroApi.activateSiteAccount(account.id).then(() => { site.reload() }, () => undefined)
    }
  }

  const sessionOf = (account: SiteAccountSummary): SiteSessionStatus => {
    const status = sessions[account.id]
    if (status !== undefined) return status
    return {
      siteAccountId: account.id,
      state: account.sessionState,
      capturedAt: account.sessionCapturedAt,
      checkedAt: account.sessionCheckedAt,
      message: null,
    }
  }

  const save = async (payload: SiteSavePayload): Promise<boolean> => {
    if (!(await requestWrites())) return false
    return runner.run(
      t('site.saved'),
      (signal) => hydroApi.saveSiteAccount(payload, signal),
      () => { refresh() },
    )
  }

  const activate = (account: SiteAccountSummary): void => {
    void runner.run(
      t('site.activateFlash', { label: account.label }),
      (signal) => hydroApi.activateSiteAccount(account.id, signal),
      () => { site.reload() },
    )
  }

  const remove = (account: SiteAccountSummary): void => {
    void (async () => {
    if (!(await requestWrites())) return
    const confirmed = await requestConfirm({ title: t('site.confirmRemove', {
      label: account.label,
      uname: account.uname,
      hostLabel: account.hostLabel,
    }) })
    if (!confirmed) return
    void runner.run(
      t('site.removed', { label: account.label }),
      (signal) => hydroApi.removeSiteAccount(account.id, signal),
      () => { refresh() },
    )
    })()
  }

  const displayLabel = (account: SiteAccountSummary): string | null => {
    const label = account.label.trim()
    if (label === '' || label === account.uname || label.includes(account.hostLabel)) return null
    return label
  }

  const groups = new Map<string, SiteAccountSummary[]>()
  for (const account of site.accounts) {
    const existing = groups.get(account.hostLabel)
    if (existing === undefined) groups.set(account.hostLabel, [account])
    else existing.push(account)
  }

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.siteAccounts')}
        hint={t('siteAccounts.manageHint')}
        actions={(
          <span style={inlineRow}>
            <button
              type="button"
              style={button}
              disabled={checking || site.accounts.length === 0}
              onClick={() => { checkSessions(site.accounts.map((account) => account.id)) }}
            >
              {checking ? t('session.checking') : t('session.refreshAll')}
            </button>
            <button
              type="button"
              style={form === null ? primaryButton : button}
              disabled={runner.busy || noHosts}
              onClick={() => { setForm((current) => (current === null ? { initial: null } : null)) }}
            >
              {form === null ? t('siteAccounts.add') : t('panel.hideForm')}
            </button>
          </span>
        )}
      />
      <Flash flash={runner.flash} />

      {site.error === null ? null : (
        <div style={flashError}>
          <div style={errorText}>{t('panel.accountsError', { message: site.error })}</div>
          <button type="button" style={button} onClick={site.reload}>{t('panel.retry')}</button>
        </div>
      )}

      {form === null ? null : (
        <SiteAccountForm
          key={form.initial?.id ?? 'new'}
          hosts={hosts.accounts}
          initial={form.initial}
          busy={runner.busy}
          onSave={save}
          onCancel={() => { setForm(null) }}
        />
      )}

      {site.phase === 'loading' && site.accounts.length === 0 ? (
        <p style={mutedText}>{t('site.loadingAccounts')}</p>
      ) : null}

      {site.phase === 'ready' && site.accounts.length === 0 ? (
        <Card>
          <EmptyState
            message={noHosts ? t('siteAccounts.noHost') : t('siteAccounts.empty')}
            {...(noHosts
              ? { actionLabel: t('page.goHosts'), onAction: () => { navigate('settings/hosts') } }
              : { actionLabel: t('siteAccounts.add'), onAction: () => { setForm({ initial: null }) } })}
          />
        </Card>
      ) : null}

      {[...groups.entries()].map(([hostLabel, rows]) => (
        <section key={hostLabel} style={stack}>
          <h3 style={{ ...sectionTitle, margin: 0 }}>{t('siteAccounts.group', { hostLabel, count: rows.length })}</h3>
          <div style={stack}>
            {rows.map((account) => {
              const isActive = account.id === site.activeSiteAccountId
              return (
                <div
                  key={account.id}
                  style={selectedId === account.id ? accountRowActive : accountRow}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedId === account.id}
                  onClick={() => { setSelectedId(account.id) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedId(account.id)
                    }
                  }}
                >
                  <div style={inlineRow}>
                    <strong>{account.uname}</strong>
                    {isActive ? <span style={activeBadge}>{t('siteAccounts.active')}</span> : null}
                    <span style={badge}>{formatSiteRole(account.role, t)}</span>
                    <span style={badge}>{account.domain}</span>
                    {sessionOf(account).state === 'active'
                      ? <span style={okBadge}>{t('session.active')}</span>
                      : sessionOf(account).state === 'expired'
                        ? <span style={errorBadge}>{t('session.expired')}</span>
                        : <span style={badge}>{t('session.missing')}</span>}
                    {sessionOf(account).capturedAt === null ? null : (
                      <span style={time}>{t('session.capturedAt', { time: formatTime(sessionOf(account).capturedAt, locale, t) })}</span>
                    )}
                  </div>
                  <div style={inlineRow}>
                    {displayLabel(account) === null ? null : <span style={mutedText}>{displayLabel(account)}</span>}
                    <span style={time}>{t('siteAccounts.lastUsed', { time: formatTime(account.lastUsedAt, locale, t) })}</span>
                  </div>
                  {account.note === null || account.note === '' ? null : (
                    <span style={time}>{t('siteAccounts.note')}: {account.note}</span>
                  )}
                  {sessionOf(account).state === 'expired' ? (
                    <span style={warningText}>{t('session.expiredHint')}</span>
                  ) : null}
                  <div style={inlineRow}>
                    <button
                      type="button"
                      style={button}
                      disabled={runner.busy || isActive}
                      onClick={(event) => { event.stopPropagation(); activate(account) }}
                    >
                      {t('siteAccounts.activate')}
                    </button>
                    <button
                      type="button"
                      style={primaryButton}
                      onClick={(event) => { event.stopPropagation(); openLogin(account) }}
                    >
                      {t('session.login')}
                    </button>
                    <button
                      type="button"
                      style={button}
                      disabled={checking}
                      onClick={(event) => { event.stopPropagation(); checkSessions([account.id]) }}
                    >
                      {checking ? t('session.checking') : t('session.check')}
                    </button>
                    <button
                      type="button"
                      style={button}
                      disabled={runner.busy}
                      onClick={(event) => { event.stopPropagation(); setForm({ initial: account }) }}
                    >
                      {t('siteAccounts.edit')}
                    </button>
                    <button
                      type="button"
                      style={dangerButton}
                      disabled={runner.busy}
                      onClick={(event) => { event.stopPropagation(); remove(account) }}
                    >
                      {t('siteAccounts.remove')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}

      {(() => {
        const loginAccount = loginAccountId === null
          ? undefined
          : site.accounts.find((account) => account.id === loginAccountId)
        if (loginAccount === undefined) return null
        const session = sessionOf(loginAccount)
        return (
          <section style={stack}>
            <div style={inlineRow}>
              <strong style={{ fontSize: 13 }}>{t('login.title')} · {loginAccount.uname}</strong>
              <button
                type="button"
                style={button}
                disabled={checking}
                onClick={() => { checkSessions([loginAccount.id]) }}
              >
                {checking ? t('session.checking') : t('session.check')}
              </button>
              <button type="button" style={button} onClick={() => { setLoginAccountId(null) }}>{t('login.close')}</button>
              {session.state === 'active'
                ? <span style={okBadge}>{t('session.active')}</span>
                : session.state === 'expired'
                  ? <span style={errorBadge}>{t('session.expired')}</span>
                  : session.state === 'unknown'
                    ? <span style={badge}>{t('session.unknown')}</span>
                    : <span style={badge}>{t('session.missing')}</span>}
            </div>
            <p style={{ ...mutedText, margin: 0 }}>{t('login.hint')}</p>
            <EmbeddedHydro hostId={loginAccount.hostId} path="/login" title={t('login.title')} sessionKey={loginAccount.id} initialPath="/login" />
          </section>
        )
      })()}
    </div>
  )
}

