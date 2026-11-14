/**
 * HydroOJ plugin management: list installed addons and install/enable/disable/
 * uninstall them (writes confirm; addons are yarn-global + ~/.hydro/addon.json).
 */
import { useEffect, useState } from 'react'
import type { OperationResult } from '../../shared/types.js'
import type { PluginListResponse, PluginSummary } from '../../shared/api.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  button,
  colors,
  compactInput,
  dangerButton,
  details,
  errorBadge,
  inlineRow,
  mutedText,
  okBadge,
  page,
  primaryButton,
  table,
  tableCell,
  tableHeadCell,
  time,
} from '../styles.js'
import { Card, ErrorLine, PageHeading, LogBlock } from '../ui.js'
import { NeedHost } from './OpsPages.js'

/** One plugin action. */
type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable'

/**
 * Render the HydroOJ plugin manager.
 * @returns the page element.
 */
export function PluginsPage() {
  const { t } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const list = useAsyncTask<PluginListResponse>(t)
  const action = useAsyncTask<OperationResult>(t)
  const [installName, setInstallName] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const [pending, setPending] = useState<{ action: PluginAction; name: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  const load = (): void => {
    if (hostId === null) return
    void list.run((signal) => hydroApi.listPlugins(hostId, signal))
  }

  useEffect(() => {
    load()
    // Reload only when the active host changes.
  }, [hostId])

  if (activeHost === undefined) return <NeedHost />

  const run = (next: PluginAction, name: string): void => {
    if (name.trim() === '') { setValidation(t('plugins.nameRequired')); return }
    const trimmed = name.trim()
    const confirmText = next === 'install'
      ? t('plugins.installConfirm', { name: trimmed })
      : next === 'uninstall'
        ? t('plugins.uninstallConfirm', { name: trimmed })
        : t('plugins.toggleConfirm', {
            action: next === 'enable' ? t('plugins.enable') : t('plugins.disable'),
            name: trimmed,
          })
    setValidation(null)
    void requestWrites().then(async (allowed) => {
      if (!allowed) return
      if (!(await requestConfirm({ title: confirmText }))) return
      setNotice(null)
      setPending({ action: next, name: trimmed })
      void action.run((signal) => hydroApi.managePlugin(activeHost.id, next, trimmed, signal)).then((result) => {
        if (result === null) return
        setNotice(result.ok ? t('plugins.operationDone') : t('plugins.operationFailed'))
        if (result.ok) load()
      }).finally(() => { setPending(null) })
    })
  }

  const install = (): void => {
    run('install', installName)
  }

  const rows = list.data?.plugins ?? []

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.plugins')}
        hint={t('plugins.hint')}
        actions={(
          <button type="button" style={button} disabled={list.busy} onClick={load}>
            {list.busy ? t('panel.refreshing') : t('plugins.refresh')}
          </button>
        )}
      />
      <ErrorLine text={list.error === null ? null : t('plugins.listFailed')} />

      <Card title={t('plugins.installName')}>
        <div style={inlineRow}>
          <input
            style={{ ...compactInput, minWidth: 220 }}
            value={installName}
            placeholder={t('plugins.installPlaceholder')}
            onChange={(event) => { setInstallName(event.currentTarget.value) }}
          />
          <button type="button" style={primaryButton} disabled={action.busy} onClick={install}>
            {pending?.action === 'install' ? t('plugins.installing') : t('plugins.install')}
          </button>
        </div>
        <ErrorLine text={validation} />
      </Card>

      <Card
        title={t('plugins.title', { count: rows.length })}
        hint={t('plugins.enabledCount', { count: list.data?.enabled.length ?? rows.filter((row) => row.enabled).length })}
      >
        {rows.length === 0 ? (
          <p style={{ ...mutedText, margin: 0 }}>{list.data === null && list.busy ? t('metrics.collecting') : t('plugins.empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={tableHeadCell}>{t('plugins.name')}</th>
                  <th style={tableHeadCell}>{t('plugins.version')}</th>
                  <th style={tableHeadCell}>{t('plugins.enabled')}</th>
                  <th style={tableHeadCell}>{t('plugins.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((plugin: PluginSummary) => {
                  const busy = action.busy && pending?.name === plugin.name
                  return (
                    <tr key={plugin.name}>
                      <td style={tableCell}><span style={{ fontWeight: 600 }}>{plugin.name}</span></td>
                      <td style={tableCell}>{plugin.version ?? t('common.none')}</td>
                      <td style={tableCell}>
                        {plugin.enabled ? <span style={okBadge}>{t('plugins.enabled')}</span> : <span style={errorBadge}>{t('plugins.disabled')}</span>}
                      </td>
                      <td style={tableCell}>
                        <span style={inlineRow}>
                          <button
                            type="button"
                            style={button}
                            disabled={action.busy}
                            onClick={() => { run(plugin.enabled ? 'disable' : 'enable', plugin.name) }}
                          >
                            {busy ? t('plugins.operationDone') : plugin.enabled ? t('plugins.disable') : t('plugins.enable')}
                          </button>
                          <button
                            type="button"
                            style={dangerButton}
                            disabled={action.busy}
                            onClick={() => { run('uninstall', plugin.name) }}
                          >
                            {t('plugins.uninstall')}
                          </button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {action.data === null ? null : (
        <Card tone={action.data.ok ? 'ok' : 'error'} title={t('plugins.output')}>
          <p style={{ margin: 0, color: action.data.ok ? colors.success : colors.danger }}>
            {action.data.ok ? t('plugins.operationDone') : t('plugins.operationFailed')}
          </p>
          {action.data.message === '' ? null : <p style={{ margin: 0 }}>{action.data.message}</p>}
          {action.data.log === undefined || action.data.log === '' ? null : (
            <details style={details}>
              <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
              <LogBlock text={action.data.log} />
            </details>
          )}
        </Card>
      )}
      {notice === null ? null : <p style={{ margin: 0, color: colors.muted }}>{notice}</p>}
      <ErrorLine text={action.error === null ? null : t('plugins.operationFailed')} />
    </div>
  )
}
