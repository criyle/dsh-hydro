/**
 * 服务: visual PM2 process monitor plus Hydro/sandbox/judge health.
 *
 * Shows one row per remote process with status dot, CPU, memory, uptime,
 * restarts and mapped component; per-row start/stop/restart actions are only
 * offered for processes mapped to a known Hydro component and are disabled by
 * the global readonly switch.
 */
import { useEffect, useState } from 'react'
import type { Pm2ProcessSummary, ProcessLogsResponse, ServiceOverviewResponse } from '../../shared/api.js'
import { hydroApi, type ServiceAction, type ServiceActionResult, type ServiceTarget } from '../api.js'
import { useConsole } from '../console-context.js'
import { formatBytes, formatDuration, formatTime } from '../format.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import type { MessageKey } from '../locales.js'
import {
  button,
  card,
  colors,
  dangerButton,
  detailText,
  details,
  errorBadge,
  inlineRow,
  metricGrid,
  metricLabel,
  metricValue,
  mutedText,
  okBadge,
  page,
  pre,
  stack,
  statusDot,
  table,
  tableCell,
  tableHeadCell,
  time,
} from '../styles.js'
import { Card, ErrorLine, PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'

const TARGET_LABEL_KEYS: Record<ServiceTarget, MessageKey> = {
  hydro: 'hosts.service.target.hydro',
  mongodb: 'hosts.service.target.mongodb',
  sandbox: 'hosts.service.target.sandbox',
  caddy: 'hosts.service.target.caddy',
  judge: 'hosts.service.target.judge',
}

const ACTION_LABEL_KEYS: Record<ServiceAction, MessageKey> = {
  status: 'hosts.service.action.status',
  start: 'hosts.service.action.start',
  stop: 'hosts.service.action.stop',
  restart: 'hosts.service.action.restart',
  reload: 'hosts.service.action.reload',
}

/** Dot color for a pm2 status string. */
function statusColor(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized === 'online' || normalized === 'running') return colors.success
  if (normalized === 'stopped' || normalized === 'errored' || normalized === 'offline') return colors.danger
  return colors.muted
}

/** Render one process row's action buttons. */
function ProcessActions({
  onAction,
  pending,
}: {
  onAction(action: ServiceAction): void
  pending: boolean
}) {
  const { t } = useI18n()
  return (
    <span style={inlineRow}>
      <button type="button" style={button} disabled={pending} onClick={() => { onAction('start') }}>
        {t('hosts.service.action.start')}
      </button>
      <button type="button" style={button} disabled={pending} onClick={() => { onAction('restart') }}>
        {t('hosts.service.action.restart')}
      </button>
      <button type="button" style={dangerButton} disabled={pending} onClick={() => { onAction('stop') }}>
        {t('hosts.service.action.stop')}
      </button>
    </span>
  )
}

/**
 * Render the services page.
 * @returns the page element.
 */
export function ServicesPage() {
  const { t, locale } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const overview = useAsyncTask<ServiceOverviewResponse>(t)
  const action = useAsyncTask<ServiceActionResult>(t)
  const logs = useAsyncTask<ProcessLogsResponse>(t)
  const [pending, setPending] = useState<string | null>(null)
  const [logsProcess, setLogsProcess] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  useEffect(() => {
    if (hostId === null) return
    void overview.run((signal) => hydroApi.hostServices(hostId, signal))
    // Reload only when the active host changes; run is stable.
  }, [hostId])

  if (activeHost === undefined) return <NeedHost />

  const targetLabel = (target: ServiceTarget): string => t(TARGET_LABEL_KEYS[target])
  const actionLabel = (value: ServiceAction): string => t(ACTION_LABEL_KEYS[value])

  const openLogs = (process: Pm2ProcessSummary): void => {
    setLogsProcess(process.name)
    void logs.run((signal) => hydroApi.hostLogs(activeHost.id, { process: process.name, lines: 200 }, signal))
  }

  const runAction = (process: Pm2ProcessSummary, next: ServiceAction): void => {
    const target = process.target
    if (target === null) return
    void (async () => {
      if (!(await requestWrites())) return
      const confirmed = await requestConfirm({ title: t('hosts.service.confirm', {
        target: targetLabel(target),
        action: actionLabel(next),
      }) })
      if (!confirmed) return
      const key = `${process.name}:${next}`
      setPending(key)
      const result = await action.run((signal) => hydroApi.serviceAction(activeHost.id, target, next, signal))
      setPending(null)
      if (result !== null) void overview.run((signal) => hydroApi.hostServices(activeHost.id, signal))
    })()
  }

  const data = overview.data
  const processes = data?.processes ?? []

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.pm2')}
        hint={t('services.hint')}
        actions={(
          <button type="button" style={button} disabled={overview.busy} onClick={() => { void overview.run((signal) => hydroApi.hostServices(activeHost.id, signal)) }}>
            {overview.busy ? t('panel.refreshing') : t('panel.refresh')}
          </button>
        )}
      />
      <ErrorLine text={overview.error} />
      {data === null ? null : (
        <p style={{ ...mutedText, margin: 0 }}>
          {t('services.manager', { manager: data.manager })} · {t('services.collectedAt', { time: formatTime(data.collectedAt, locale, t) })}
        </p>
      )}

      <Card title={t('services.processes', { count: processes.length })} hint={t('services.pm2Only')}>
        {processes.length === 0 ? (
          <p style={{ ...mutedText, margin: 0 }}>{t('services.empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={tableHeadCell}>{t('services.name')}</th>
                  <th style={tableHeadCell}>{t('services.status')}</th>
                  <th style={tableHeadCell}>{t('services.target')}</th>
                  <th style={tableHeadCell}>{t('services.cpu')}</th>
                  <th style={tableHeadCell}>{t('services.memory')}</th>
                  <th style={tableHeadCell}>{t('services.uptime')}</th>
                  <th style={tableHeadCell}>{t('services.restarts')}</th>
                  <th style={tableHeadCell}>{t('services.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {processes.map((process) => {
                  const target = process.target
                  const running = process.status.toLowerCase() === 'online' || process.status.toLowerCase() === 'running'
                  return (
                    <tr key={`${process.name}:${String(process.pid ?? 0)}`}>
                      <td style={tableCell}>
                        <span style={{ fontWeight: 600 }}>{process.name}</span>
                        {process.execPath === null ? null : (
                          <details style={details}>
                            <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
                            <p style={detailText}>{process.execPath}</p>
                          </details>
                        )}
                      </td>
                      <td style={tableCell}>
                        <span style={{ ...statusDot, background: statusColor(process.status) }} />
                        {running ? t('services.running') : process.status === 'stopped' ? t('services.stopped') : t('services.unknownState')}
                        <span style={time}> · {process.status}</span>
                      </td>
                      <td style={tableCell}>
                        {target === null ? t('services.other') : targetLabel(target)}
                      </td>
                      <td style={tableCell}>
                        {process.cpuPercent === null ? t('common.none') : t('services.cpuValue', { value: process.cpuPercent.toFixed(1) })}
                      </td>
                      <td style={tableCell}>{formatBytes(process.memoryBytes) ?? t('common.none')}</td>
                      <td style={tableCell}>
                        {process.uptimeMs === null ? t('common.none') : formatDuration(Math.round(process.uptimeMs / 1000), t) ?? t('common.none')}
                      </td>
                      <td style={tableCell}>{process.restarts === null ? t('common.none') : String(process.restarts)}</td>
                      <td style={tableCell}>
                        <span style={inlineRow}>
                          <button type="button" style={button} disabled={logs.busy} onClick={() => { openLogs(process) }}>
                            {t('logs.open')}
                          </button>
                          {target === null ? null : (
                            <ProcessActions
                              onAction={(next) => { runAction(process, next) }}
                              pending={pending !== null && pending.startsWith(`${process.name}:`)}
                            />
                          )}
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

      {logsProcess === null ? null : (
        <Card
          title={t('logs.title', { process: logsProcess })}
          actions={(
            <span style={inlineRow}>
              <button
                type="button"
                style={button}
                disabled={logs.busy}
                onClick={() => {
                  void logs.run((signal) => hydroApi.hostLogs(activeHost.id, { process: logsProcess, lines: 200 }, signal))
                }}
              >
                {logs.busy ? t('logs.loading') : t('logs.refresh')}
              </button>
              <button type="button" style={button} onClick={() => { setLogsProcess(null); logs.reset() }}>
                {t('logs.close')}
              </button>
            </span>
          )}
        >
          <ErrorLine text={logs.error} />
          {logs.data === null ? null : (
            <div style={stack}>
              {logs.data.truncated ? <span style={{ ...time, color: colors.warning }}>{t('logs.truncated')}</span> : null}
              <span style={metricLabel}>{t('logs.stdout')}</span>
              {logs.data.stdout === '' ? <p style={{ ...mutedText, margin: 0 }}>{t('logs.empty')}</p> : <pre style={pre}>{logs.data.stdout}</pre>}
              <span style={metricLabel}>{t('logs.stderr')}</span>
              {logs.data.stderr === '' ? <p style={{ ...mutedText, margin: 0 }}>{t('logs.empty')}</p> : <pre style={pre}>{logs.data.stderr}</pre>}
            </div>
          )}
        </Card>
      )}

      <ErrorLine text={action.error} />
      {action.data === null ? null : (
        <Card tone={action.data.ok ? 'ok' : 'error'} title={t('services.actionOutput')}>
          <p style={{ margin: 0 }}>
            {actionLabel(action.data.action)} · {action.data.manager} · {action.data.ok ? t('status.ok') : t('services.failed')}
          </p>
          {action.data.output === '' ? null : <pre style={pre}>{action.data.output}</pre>}
        </Card>
      )}

      {data === null ? null : (
        <>
          <div style={metricGrid}>
            <div style={{ ...card, ...stack }}>
              <span style={metricLabel}>{t('services.health')}</span>
              <div style={inlineRow}>
                {data.hydro.installed ? <span style={okBadge}>{t('services.installed')}</span> : <span style={errorBadge}>{t('services.notInstalled')}</span>}
                {data.hydro.health.ok ? <span style={okBadge}>{t('services.healthOk')}</span> : <span style={errorBadge}>{t('services.healthDown')}</span>}
              </div>
              <span style={metricValue}>{data.hydro.version ?? t('common.none')}</span>
              <span style={time}>{data.hydro.serviceName ?? ''}</span>
              <span style={time}>
                {data.hydro.health.status === null ? '' : `HTTP ${String(data.hydro.health.status)}`}
                {data.hydro.health.latencyMs === null ? '' : ` · ${String(data.hydro.health.latencyMs)} ms`}
              </span>
            </div>
            <div style={{ ...card, ...stack }}>
              <span style={metricLabel}>{t('services.sandbox')}</span>
              <span style={metricValue}>
                {data.sandbox.address ?? data.sandbox.version ?? t('services.noSandbox')}
              </span>
              <span style={time}>
                {data.sandbox.running ? t('services.running') : t('services.stopped')}
                {data.sandbox.version === null ? '' : ` · v${data.sandbox.version}`}
              </span>
            </div>
            <div style={{ ...card, ...stack }}>
              <span style={metricLabel}>{t('services.judge')}</span>
              <span style={metricValue}>
                {data.judge.installed ? t('services.installed') : t('services.notInstalled')}
                {' · '}
                {data.judge.running ? t('services.running') : t('services.stopped')}
              </span>
              {data.judge.configPath === null ? null : (
                <details style={details}>
                  <summary style={{ ...time, cursor: 'pointer' }}>{t('services.configPath')}</summary>
                  <p style={detailText}>{data.judge.configPath}</p>
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
