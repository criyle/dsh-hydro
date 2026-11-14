/**
 * 主机管理: host record CRUD, connection test and activity switch.
 *
 * This is the only page that edits host records; every ops page consumes the
 * active host selected here (or in the top-right switcher).
 */
import { useState } from 'react'
import type { AccountSummary } from '../../shared/types.js'
import type { CreateAccountPayload, UpdateAccountPayload } from '../api.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { formatTime } from '../format.js'
import { HostForm, type HostFormPayload } from '../HostForm.js'
import { useActionRunner } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  activeBadge,
  badge,
  button,
  dangerButton,
  errorText,
  flashError,
  inlineRow,
  mutedText,
  okBadge,
  page,
  primaryButton,
  stack,
  table,
  tableCell,
  tableHeadCell,
  time,
} from '../styles.js'
import { Card, EmptyState, Flash, PageHeading, LogBlock } from '../ui.js'

/** Which form is open: adding (null initial) or editing one host. */
interface HostFormState {
  initial: AccountSummary | null
}

/**
 * Render the host management page.
 * @returns the page element.
 */
export function HostsPage() {
  const { t, locale } = useI18n()
  const { hosts, requestWrites, requestConfirm } = useConsole()
  const runner = useActionRunner(t)
  const [form, setForm] = useState<HostFormState | null>(null)
  const [bootstrapLog, setBootstrapLog] = useState<string[]>([])

  const save = async (payload: HostFormPayload): Promise<boolean> => {
    if (!(await requestWrites())) return false
    const label = payload.label === '' ? payload.host : payload.label
    const target = form?.initial ?? null
    if (target === null) {
      const create: CreateAccountPayload = {
        host: payload.host,
        port: payload.port,
        username: payload.username,
        authMethod: payload.authMethod,
        ...(payload.label === '' ? {} : { label: payload.label }),
        ...(payload.password === undefined ? {} : { password: payload.password }),
        ...(payload.privateKey === undefined ? {} : { privateKey: payload.privateKey }),
        installManagedKey: true,
      }
      return runner.run(
        t('hosts.created', { label }),
        (signal) => hydroApi.createAccount(create, signal),
        (result) => {
          setBootstrapLog(result.log ?? [])
          void hydroApi.activateAccount(result.account.id).catch(() => undefined).then(() => { hosts.reload() })
        },
      )
    }
    const update: UpdateAccountPayload = {
      id: target.id,
      host: payload.host,
      port: payload.port,
      username: payload.username,
      ...(payload.label === '' ? {} : { label: payload.label }),
    }
    return runner.run(
      t('hosts.updated', { label }),
      (signal) => hydroApi.updateAccount(update, signal),
      () => { hosts.reload() },
    )
  }

  const test = (account: AccountSummary): void => {
    void runner.run(
      (result: { latencyMs: number | null; hostname: string | null }) => t('hosts.testOk', {
        latency: result.latencyMs === null ? '' : ` (${String(result.latencyMs)} ms)`,
        hostname: result.hostname === null ? '' : ` · ${result.hostname}`,
      }),
      async (signal) => {
        const result = await hydroApi.testAccount(account.id, signal)
        if (!result.ok) throw new Error(result.message)
        return result
      },
    )
  }

  const activate = (account: AccountSummary): void => {
    void runner.run(
      t('hosts.activated', { label: account.label }),
      (signal) => hydroApi.activateAccount(account.id, signal),
      () => { hosts.reload() },
    )
  }

  const remove = (account: AccountSummary): void => {
    void (async () => {
    if (!(await requestWrites())) return
    const confirmed = await requestConfirm({ title: t('accounts.confirmRemove', {
      label: account.label,
      username: account.username,
      host: account.host,
      port: account.port,
    }) })
    if (!confirmed) return
    void runner.run(
      t('hosts.removed', { label: account.label }),
      (signal) => hydroApi.removeAccount(account.id, signal),
      () => { hosts.reload() },
    )
    })()
  }


  return (
    <div style={page}>
      <PageHeading
        title={t('menu.hosts')}
        hint={t('hosts.manageHint')}
        actions={(
          <button
            type="button"
            style={form === null ? primaryButton : button}
            disabled={runner.busy}
            onClick={() => { setForm((current) => (current === null ? { initial: null } : null)) }}
          >
            {form === null ? t('hosts.add') : t('panel.hideForm')}
          </button>
        )}
      />
      <Flash flash={runner.flash} />
      {bootstrapLog.length === 0 ? null : (
        <Card title={t('hosts.bootstrapLogTitle')}>
          <LogBlock text={bootstrapLog.join('\n')} maxHeight={220} />
          <button type="button" style={button} onClick={() => { setBootstrapLog([]) }}>{t('common.close')}</button>
        </Card>
      )}

      {hosts.error === null ? null : (
        <div style={flashError}>
          <div style={errorText}>{t('panel.accountsError', { message: hosts.error })}</div>
          <button type="button" style={button} onClick={hosts.reload}>{t('panel.retry')}</button>
        </div>
      )}

      {form === null ? null : (
        <HostForm
          key={form.initial?.id ?? 'new'}
          initial={form.initial}
          busy={runner.busy}
          onSave={save}
          onCancel={() => { setForm(null) }}
        />
      )}

      {hosts.phase === 'loading' && hosts.accounts.length === 0 ? (
        <p style={mutedText}>{t('panel.loadingAccounts')}</p>
      ) : null}

      {hosts.phase === 'ready' && hosts.accounts.length === 0 ? (
        <Card>
          <EmptyState
            message={t('panel.empty')}
            actionLabel={t('panel.emptyCta')}
            onAction={() => { setForm({ initial: null }) }}
          />
        </Card>
      ) : null}

      {hosts.accounts.length === 0 ? null : (
        <Card>
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={tableHeadCell}>{t('hosts.tableHost')}</th>
                  <th style={tableHeadCell}>{t('hosts.tableIdentity')}</th>
                  <th style={tableHeadCell}>{t('hosts.tableRole')}</th>
                  <th style={tableHeadCell}>{t('hosts.tableAuth')}</th>
                  <th style={tableHeadCell}>{t('hosts.tableHydro')}</th>
                  <th style={tableHeadCell}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {hosts.accounts.map((account) => {
                  const isActive = account.id === hosts.activeAccountId
                  const hydro = account.hydro
                  return (
                    <tr key={account.id}>
                      <td style={tableCell}>
                        <div style={stack}>
                          <span style={{ fontWeight: 600 }}>{account.label}</span>
                          {isActive ? <span style={{ ...activeBadge, alignSelf: 'flex-start' }}>{t('hosts.current')}</span> : null}
                        </div>
                      </td>
                      <td style={tableCell}>
                        <div style={stack}>
                          <span>{account.username}@{account.host}:{String(account.port)}</span>
                          <span style={time}>{t('accounts.lastStatus', { time: formatTime(account.lastStatusAt, locale, t) })}</span>
                        </div>
                      </td>
                      <td style={tableCell}><span style={badge}>{account.role}</span></td>
                      <td style={tableCell}>{account.authMethod === 'key' ? t('accounts.authKey') : t('accounts.authPassword')}</td>
                      <td style={tableCell}>
                        {hydro === null ? <span style={time}>{t('hosts.untested')}</span> : (
                          <div style={stack}>
                            <span>{hydro.installed ? <span style={okBadge}>{t('hosts.installed')}</span> : <span style={badge}>{t('hosts.notInstalled')}</span>}</span>
                            <span style={time}>{hydro.version ?? t('common.none')}</span>
                          </div>
                        )}
                      </td>
                      <td style={tableCell}>
                        <div style={inlineRow}>
                          <button type="button" style={button} disabled={runner.busy} onClick={() => { test(account) }}>
                            {t('hosts.test')}
                          </button>
                          <button type="button" style={button} disabled={runner.busy || isActive} onClick={() => { activate(account) }}>
                            {t('hosts.activate')}
                          </button>
                          <button type="button" style={button} disabled={runner.busy} onClick={() => { setForm({ initial: account }) }}>
                            {t('hosts.edit')}
                          </button>
                          <button type="button" style={dangerButton} disabled={runner.busy} onClick={() => { remove(account) }}>
                            {t('hosts.remove')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
