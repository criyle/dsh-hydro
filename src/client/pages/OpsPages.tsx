/**
 * Ops pages: overview (visual metrics + compact status + alerts), merged
 * install & upgrade (package selection, streamed
 * terminal) and the smart troubleshooting page.
 */
import { useEffect, useRef, useState } from 'react'
import type { HostIssuesResponse, PackageListResponse } from '../../shared/api.js'
import type { HostMetricsResponse, MetricAlert } from '../../shared/api.js'
import type { AccountSummary, OperationResult } from '../../shared/types.js'
import {
  describeError,
  hydroApi,
  streamUpgradeHost,
  type ServiceTarget,
  type UpgradeResponse,
} from '../api.js'
import { useConsole } from '../console-context.js'
import { formatBytes, formatDuration, formatTime } from '../format.js'
import { useAccountStatus, useAsyncTask, useHostMetrics, useHostStream, useActionRunner, type StatusView } from '../hooks.js'
import { useI18n } from '../i18n.js'
import type { MessageKey } from '../locales.js'
import { localizeIssue } from '../issues.js'
import { HostDiagnoseButton } from '../HostDiagnoseButton.js'
import { AutomationButton } from '../AutomationButton.js'
import { HostInstallCard } from '../HostInstallCard.js'
import { Gauge, MeterBar, MetricAlerts, MetricCard, metricAlertText, metricColor, percentText, Sparkline } from '../MetricCharts.js'
import { OperationTerminalCard, withStreamFallback } from '../OperationTerminalCard.js'
import {
  badge,
  button,
  checkboxRow,
  colors,
  detailText,
  errorBadge,
  grid,
  inlineRow,
  mutedText,
  okBadge,
  page,
  primaryButton,
  stack,
  statusDot,
  table,
  tableCell,
  tableHeadCell,
  time,
  warningItem,
} from '../styles.js'
import { Card, Collapsible, EmptyState, ErrorLine, Field, LogBlock, PageHeading } from '../ui.js'
import { WarningList, localizeWarning } from '../warnings.js'

/** Prompt shown on ops pages that need an active host. */
export function NeedHost() {
  const { t } = useI18n()
  const { navigate } = useConsole()
  return (
    <Card>
      <EmptyState
        message={t('page.needHost')}
        actionLabel={t('page.goHosts')}
        onAction={() => { navigate('settings/hosts') }}
      />
    </Card>
  )
}

/** Severity border color for one metrics alert code. */
function alertTone(alert: MetricAlert | undefined): string | undefined {
  if (alert === undefined) return undefined
  return alert.severity === 'error' ? colors.danger : colors.warning
}

/** Compact Hydro status card: badges + details behind a disclosure. */
function CompactStatus({ account, status }: { account: AccountSummary; status: StatusView }) {
  const { t, locale } = useI18n()
  const data = status.status
  return (
    <Card
      title={t('status.title')}
      actions={(
        <button type="button" style={button} disabled={status.phase === 'loading'} onClick={status.refresh}>
          {status.phase === 'loading' ? t('status.collecting') : t('status.refresh')}
        </button>
      )}
    >
      <ErrorLine text={status.error} />
      {data === null ? (
        <p style={{ ...mutedText, margin: 0 }}>{status.phase === 'loading' ? t('status.loadingHint') : t('status.selectAccount')}</p>
      ) : (
        <div style={stack}>
          <div style={inlineRow}>
            {data.reachable ? <span style={okBadge}>{t('status.reachable')}</span> : <span style={errorBadge}>{t('status.unreachable')}</span>}
            {data.hydro.installed ? <span style={okBadge}>{t('status.installed')}</span> : <span style={badge}>{t('hosts.notInstalled')}</span>}
            <span style={badge}>{t(({ web: 'mode.web', judge: 'mode.judge', 'web+judge': 'mode.webJudge', none: 'mode.none' } as Record<string, MessageKey>)[data.installMode] ?? 'mode.none')}</span>
            {data.hydro.updateAvailable ? <span style={errorBadge}>{t('status.updateAvailable')}</span> : <span style={okBadge}>{t('status.upToDate')}</span>}
            {data.hydro.health === null ? null : (data.hydro.health.ok ? <span style={okBadge}>{t('status.health')}: {t('status.ok')}</span> : <span style={errorBadge}>{t('services.healthDown')}</span>)}
          </div>
          <div style={grid}>
            <Field label={t('status.version')} value={data.hydro.version} />
            <Field
              label={t('status.service')}
              value={data.hydro.service === null ? null : `${data.hydro.service.running ? t('status.running') : t('status.stopped')} · ${data.hydro.service.manager}`}
            />
            <Field label={t('status.url')} value={data.hydro.url ?? account.hydro?.domain ?? null} />
            <Field label={t('status.collectedLabel')} value={formatTime(data.collectedAt, locale, t)} />
          </div>
          <div style={grid}>
            <Field label={t('status.installDir')} value={data.hydro.installDir} />
            <Field label={t('status.host')} value={data.host === null ? null : `${data.host.hostname ?? ''} ${data.host.platform ?? ''}`.trim()} />
            <Field
              label={t('status.mongo')}
              value={data.mongo === null ? null : data.mongo.reachable ? `${t('status.connectable')} ${data.mongo.version ?? ''}`.trim() : t('status.unreachable')}
            />
            <Field
              label={t('status.judge')}
              value={data.judge === null ? null : `${data.judge.sandbox ?? ''} ${data.judge.workers === null ? '' : String(data.judge.workers)}`.trim()}
            />
            <Field label={t('status.load')} value={data.host === null || data.host.load.length === 0 ? null : data.host.load.map((value) => value.toFixed(2)).join(' ')} />
            <Field
              label={t('status.uptime')}
              value={data.host === null || data.host.uptimeSeconds === null ? null : formatDuration(data.host.uptimeSeconds, t)}
            />
            <Field
              label={t('status.disk')}
              value={data.host === null || data.host.diskFreeBytes === null ? null : formatBytes(data.host.diskFreeBytes)}
            />
          </div>
          {data.error === null ? null : <p style={detailText}>{data.error}</p>}
        </div>
      )}
    </Card>
  )
}

/** Overview page: live metric charts, compact status and localized alerts. */
export function OverviewPage() {
  const { t, locale } = useI18n()
  const { activeHost, navigate, page: activePage } = useConsole()
  const metrics = useHostMetrics(activeHost?.id ?? null, activePage === 'ops/overview', t)
  const status = useAccountStatus(activeHost?.id ?? null, t)
  const retriedMongo = useRef<string | null>(null)
  const latest: HostMetricsResponse | null = metrics.latest

  useEffect(() => {
    const id = activeHost?.id
    if (id === undefined) return
    const hasMongoWarning = status.status?.warnings.some((warning) => warning.code.startsWith('hydro.mongo')) === true
    if (!hasMongoWarning) {
      retriedMongo.current = null
      return
    }
    if (retriedMongo.current === id) return
    retriedMongo.current = id
    // First load can hit a slow SSH/Mongo tunnel. Retry once in the background
    // so a transient "MongoDB unreachable" warning does not stick.
    const timer = window.setTimeout(() => {
      status.refresh()
      metrics.refresh()
    }, 3000)
    return () => { window.clearTimeout(timer) }
  }, [activeHost?.id, status.status, status.refresh, metrics.refresh])
  const history = metrics.history

  if (activeHost === undefined) {
    return <Card><EmptyState message={t('overview.noHost')} actionLabel={t('overview.goHosts')} onAction={() => { navigate('settings/hosts') }} /></Card>
  }

  const cpuValues = history.map((sample) => sample.cpu?.usagePercent ?? null).filter((value): value is number => value !== null)
  const memoryValues = history.map((sample) => sample.memory?.usagePercent ?? null).filter((value): value is number => value !== null)
  const diskValues = history.map((sample) => sample.disk?.usagePercent ?? null).filter((value): value is number => value !== null)
  const queueValues = history.map((sample) => sample.judge?.queueDepth ?? null).filter((value): value is number => value !== null)
  const latestAlerts = latest?.alerts ?? []
  const alert = (code: MetricAlert['code']): MetricAlert | undefined => latestAlerts.find((entry) => entry.code === code)
  const warningLines = (status.status?.warnings ?? []).map((warning) => {
    const localized = localizeWarning(warning, t)
    return warning.message === '' ? localized.title : `${localized.title}\n${warning.message}`
  })
  const alertLines = latestAlerts.map((entry) => `${metricAlertText(entry, t).title} (${entry.value.toFixed(1)})`)
  const aiOutput = [...warningLines, ...alertLines].join('\n')
  const aiCount = warningLines.length + alertLines.length
  const staleWarning = latest?.judge?.staleRecords !== null
    && latest?.judge?.staleRecords !== undefined
    && (latest.judge.staleRecords > 0)
    && (latest.judge.queueDepth === 0 || latest.judge.queueDepth === null)

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.overview')}
        hint={t('overview.hint')}
        actions={(
          <button type="button" style={button} onClick={metrics.refresh}>
            {t('metrics.refresh')}
          </button>
        )}
      />
      <p style={{ ...mutedText, margin: 0 }}>
        {activeHost.label} · {activeHost.username}@{activeHost.host}:{String(activeHost.port)}
      </p>

      <Card title={t('metrics.title')} hint={t('metrics.hint')}>
        <ErrorLine text={metrics.error} />
        {latest === null ? (
          <p style={{ ...mutedText, margin: 0 }}>{t('metrics.collecting')}</p>
        ) : (
          <div style={stack}>
            <div style={metricGridStyle}>
              <MetricCard label={t('metrics.cpu')} value={percentText(latest.cpu?.usagePercent ?? null)} tone={alertTone(alert('cpu'))}>
                <Gauge percent={latest.cpu?.usagePercent ?? null} color={metricColor(latest.cpu?.usagePercent ?? null)} />
                <span style={time}>
                  {t('metrics.load')} {latest.cpu?.load1 === null || latest.cpu?.load1 === undefined ? t('common.none') : latest.cpu.load1.toFixed(2)}
                  {latest.cpu?.cores === null || latest.cpu?.cores === undefined ? '' : ` · ${t('metrics.cores', { count: latest.cpu.cores })}`}
                </span>
                <Sparkline values={cpuValues} color={metricColor(latest.cpu?.usagePercent ?? null)} />
              </MetricCard>
              <MetricCard label={t('metrics.memory')} value={percentText(latest.memory?.usagePercent ?? null)} tone={alertTone(alert('memory'))}>
                <MeterBar percent={latest.memory?.usagePercent ?? null} color={metricColor(latest.memory?.usagePercent ?? null)} />
                <span style={time}>
                  {t('metrics.usedOf', {
                    used: formatBytes(latest.memory?.usedBytes ?? null) ?? t('common.none'),
                    total: formatBytes(latest.memory?.totalBytes ?? null) ?? t('common.none'),
                  })}
                </span>
                <Sparkline values={memoryValues} color={metricColor(latest.memory?.usagePercent ?? null)} />
              </MetricCard>
              <MetricCard label={t('metrics.disk')} value={percentText(latest.disk?.usagePercent ?? null)} tone={alertTone(alert('disk'))}>
                <MeterBar percent={latest.disk?.usagePercent ?? null} color={metricColor(latest.disk?.usagePercent ?? null, 85, 95)} />
                <span style={time}>
                  {latest.disk?.mount ?? t('common.none')} · {t('metrics.usedOf', {
                    used: formatBytes(latest.disk?.usedBytes ?? null) ?? t('common.none'),
                    total: formatBytes(latest.disk?.totalBytes ?? null) ?? t('common.none'),
                  })}
                </span>
                <Sparkline values={diskValues} color={metricColor(latest.disk?.usagePercent ?? null, 85, 95)} />
              </MetricCard>
              <MetricCard label={t('metrics.judgeQueue')} value={latest.judge?.queueDepth === null || latest.judge?.queueDepth === undefined ? t('common.none') : t('metrics.queueDepth', { count: latest.judge.queueDepth })} tone={alertTone(alert('queue')) ?? alertTone(alert('stale'))}>
                <Sparkline values={queueValues} color={alertTone(alert('queue')) ?? colors.info} />
                <span style={time}>
                  {t('metrics.judgeSubmissions', { count: latest.judge?.submissionsLastHour ?? 0 })}
                  {' · '}
                  {t('metrics.judgeAccepted', { count: latest.judge?.acceptedLastHour ?? 0 })}
                </span>
                {staleWarning ? (
                  <span style={{ ...time, color: colors.warning }}>{t('metrics.staleRecords', { count: latest.judge?.staleRecords ?? 0 })}</span>
                ) : null}
              </MetricCard>
            </div>
            <span style={time}>{t('metrics.updatedAt', { time: formatTime(latest.collectedAt, locale, t) })}</span>
          </div>
        )}
      </Card>

      <CompactStatus account={activeHost} status={status} />

      <Card
        title={t('overview.warningsTitle')}
        actions={(
          <button type="button" style={button} onClick={() => { status.refresh(); metrics.refresh() }}>
            {status.phase === 'loading' ? t('status.collecting') : t('status.refresh')}
          </button>
        )}
      >
        <div style={stack}>
          <ErrorLine text={status.error} />
          {status.status === null ? (
            <p style={{ ...mutedText, margin: 0 }}>{status.phase === 'loading' ? t('status.loadingHint') : t('status.noWarnings')}</p>
          ) : (
            <WarningList warnings={status.status.warnings} emptyText={t('status.noWarnings')} />
          )}
          {latestAlerts.length === 0 ? null : (
            <>
              <h3 style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>{t('metrics.alertTitle')}</h3>
              <MetricAlerts alerts={latestAlerts} />
            </>
          )}
          <HostDiagnoseButton
            hostId={activeHost.id}
            kind="issues"
            output={aiOutput}
            message={t('overview.aiPromptMessage', { count: aiCount })}
          />
        </div>
      </Card>
    </div>
  )
}

/** Row style for the metrics grid. */
const metricGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 8,
} as const

/** One package row's selection state. */
interface PackageSelection {
  names: Set<string>
}

/** Install & upgrade page: install when absent, package-selected upgrade otherwise. */
export function InstallUpgradePage() {
  const { t, locale } = useI18n()
  const { activeHost, hosts } = useConsole()
  const packages = useAsyncTask<PackageListResponse>(t)
  const stream = useHostStream(t)
  const [selection, setSelection] = useState<PackageSelection>({ names: new Set() })
  const [includeJudge, setIncludeJudge] = useState(false)
  const hostId = activeHost?.id ?? null
  const installed = activeHost?.hydro?.installed

  const loadPackages = (): void => {
    if (hostId === null || installed !== true) return
    void packages.run((signal) => hydroApi.hostPackages(hostId, signal))
  }

  useEffect(() => {
    if (hostId === null || installed !== true) return
    loadPackages()
    // Refresh only when the active host / install state changes.
  }, [hostId, installed])

  useEffect(() => {
    const data = packages.data
    if (data === null) return
    setSelection({ names: new Set((data.packages ?? []).filter((pkg) => pkg.updateAvailable).map((pkg) => pkg.name)) })
  }, [packages.data])

  if (activeHost === undefined) return <NeedHost />

  const updatable = (packages.data?.packages ?? []).filter((pkg) => pkg.updateAvailable)
  const selectedCount = selection.names.size
  const canStart = packages.data === null ? true : selectedCount > 0

  const togglePackage = (name: string): void => {
    setSelection((current) => {
      const names = new Set(current.names)
      if (names.has(name)) names.delete(name)
      else names.add(name)
      return { names }
    })
  }

  const startUpgrade = (): void => {
    stream.start((signal, onOutput) => withStreamFallback(
      () => streamUpgradeHost(activeHost.id, {
        ...(selectedCount === 0 ? {} : { packages: [...selection.names] }),
        ...(includeJudge ? { includeJudge: true } : {}),
      }, { onOutput }, signal),
      () => hydroApi.upgradeHost(activeHost.id, { dryRun: false, includeJudge }, signal).then((response: UpgradeResponse) => response.result),
      signal,
    ))
  }

  const installFinished = (): void => {
    void hydroApi.collectStatus(activeHost.id).finally(() => { hosts.reload() })
  }

  const refreshStatus = (): void => {
    void hydroApi.collectStatus(activeHost.id).finally(() => { hosts.reload() })
  }

  if (installed !== true) {
    return (
      <div style={page}>
        <PageHeading
          title={t('menu.installUpgrade')}
          hint={t('installUpgrade.hint')}
          actions={(
            <button type="button" style={button} onClick={refreshStatus}>
              {t('installUpgrade.probe')}
            </button>
          )}
        />
        {installed === false ? <p style={{ ...mutedText, margin: 0 }}>{t('installUpgrade.notInstalled')}</p> : null}
        <HostInstallCard account={activeHost} onInstalled={installFinished} />
      </div>
    )
  }

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.installUpgrade')}
        hint={t('installUpgrade.hint')}
        actions={(
          <span style={inlineRow}>
            <button type="button" style={button} disabled={packages.busy} onClick={loadPackages}>
              {packages.busy ? t('panel.refreshing') : t('packages.refresh')}
            </button>
            <button type="button" style={button} onClick={refreshStatus}>
              {t('installUpgrade.probe')}
            </button>
          </span>
        )}
      />

      <HostInstallCard account={activeHost} onInstalled={installFinished} />

      <OperationTerminalCard
        title={t('installUpgrade.upgradeTitle')}
        hint={t('installUpgrade.packagesHint')}
        startLabel={t('packages.upgradeSelected', { count: selectedCount })}
        confirmMessage={t('packages.confirm', { count: selectedCount === 0 ? updatable.length : selectedCount })}
        disabled={!canStart}
        task={stream}
        hostId={hostId as string}
        kind="upgrade"
        onStart={startUpgrade}
        onSuccess={() => { loadPackages(); hosts.reload() }}
        advanced={(
          <label style={checkboxRow}>
            <input type="checkbox" checked={includeJudge} onChange={(event) => { setIncludeJudge(event.currentTarget.checked) }} />
            {t('hosts.upgrade.includeJudge')}
          </label>
        )}
      >
        <div style={stack}>
          {packages.error === null ? null : (
            <ErrorLine text={t('packages.loadFailed', { message: packages.error })} />
          )}
          {packages.busy && packages.data === null ? <p style={{ ...mutedText, margin: 0 }}>{t('packages.loading')}</p> : null}
          {packages.error !== null ? (
            <p style={{ ...mutedText, margin: 0 }}>{t('packages.hint')}</p>
          ) : null}
          {packages.data !== null && (packages.data.packages ?? []).length === 0 ? (
            <p style={{ ...mutedText, margin: 0 }}>{t('packages.empty')}</p>
          ) : null}
          {packages.data === null ? null : (
            <div style={stack}>
              <div style={inlineRow}>
                <button type="button" style={button} onClick={() => {
                  setSelection({ names: new Set(updatable.map((pkg) => pkg.name)) })
                }}>
                  {t('packages.selectAll')}
                </button>
                <button type="button" style={button} onClick={() => { setSelection({ names: new Set() }) }}>
                  {t('packages.selectNone')}
                </button>
              </div>
              {updatable.length === 0 ? (
                <p style={{ ...mutedText, margin: 0 }}>{t('packages.noUpdates')}</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={table}>
                    <thead>
                      <tr>
                        <th style={tableHeadCell}>{t('packages.name')}</th>
                        <th style={tableHeadCell}>{t('packages.kind')}</th>
                        <th style={tableHeadCell}>{t('packages.current')}</th>
                        <th style={tableHeadCell}>{t('packages.latest')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(packages.data.packages ?? []).map((pkg) => (
                        <tr key={pkg.name}>
                          <td style={tableCell}>
                            <label style={checkboxRow}>
                              <input
                                type="checkbox"
                                disabled={!pkg.updateAvailable}
                                checked={selection.names.has(pkg.name)}
                                onChange={() => { togglePackage(pkg.name) }}
                              />
                              {pkg.name}
                            </label>
                          </td>
                          <td style={tableCell}>{pkg.kind === 'core' ? t('packages.kindCore') : t('packages.kindPlugin')}</td>
                          <td style={tableCell}>{pkg.current ?? t('common.none')}</td>
                          <td style={tableCell}>{pkg.latest ?? t('common.none')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <span style={time}>{t('metrics.updatedAt', { time: formatTime(packages.data.collectedAt, locale, t) })}</span>
            </div>
          )}
        </div>
      </OperationTerminalCard>
    </div>
  )
}

/** Known fix target labels (restart-service). */
const TARGET_LABEL_KEYS: Record<ServiceTarget, MessageKey> = {
  hydro: 'hosts.service.target.hydro',
  mongodb: 'hosts.service.target.mongodb',
  sandbox: 'hosts.service.target.sandbox',
  caddy: 'hosts.service.target.caddy',
  judge: 'hosts.service.target.judge',
}

/** Troubleshoot page: known-issue checks with localized copy and safe fixes. */
export function TroubleshootPage() {
  const { t, locale } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const issues = useAsyncTask<HostIssuesResponse>(t)
  const runner = useActionRunner(t)
  const [fixResult, setFixResult] = useState<OperationResult | null>(null)
  const [diagnosis, setDiagnosis] = useState<{ ok: boolean; message: string; log: string } | null>(null)
  const [diagnosisBusy, setDiagnosisBusy] = useState(false)
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null)
  const [rejudgeNotice, setRejudgeNotice] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  const runChecks = (): void => {
    if (hostId === null) return
    void issues.run((signal) => hydroApi.hostIssues(hostId, signal))
  }

  // Run the checklist automatically when the operator opens the page/host.
  useEffect(() => {
    if (hostId === null) return
    void issues.run((signal) => hydroApi.hostIssues(hostId, signal))
    // run callback is stable for a given translator; re-run per selected host.
  }, [hostId])

  if (activeHost === undefined) return <NeedHost />

  const list_ = issues.data?.issues ?? []
  const localized = list_.map((issue) => localizeIssue(issue, t))
  const issuesText = list_.map((issue) => `${issue.severity} ${issue.code}${issue.detail === null ? '' : `: ${issue.detail}`}`).join('\n')

  const rejudge = (): void => {
    if (activeHost === undefined) return
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('issues.rejudgeConfirm') }))) return
      const result = await hydroApi.rejudgeStale(activeHost.id)
      setRejudgeNotice(result.message)
    })()
  }

  const runDiagnosis = (): void => {
    if (activeHost === undefined) return
    void (async () => {
    if (!(await requestConfirm({ title: t('issues.diagnosisUploadWarning') }))) return
    setDiagnosisBusy(true)
    setDiagnosisError(null)
    void hydroApi.hostDiagnosis(activeHost.id).then((result) => {
      setDiagnosis(result)
    }, (cause: unknown) => {
      setDiagnosisError(describeError(cause, t))
    }).finally(() => { setDiagnosisBusy(false) })
    })()
  }

  const applyFix = (issue: ReturnType<typeof localizeIssue>): void => {
    if (issue.fix === null) return
    void (async () => {
      if (!(await requestWrites())) return
      if (issue.fix === 'restart-service') {
        if (issue.restartTarget === null) return
        const confirmed = await requestConfirm({ title: t('issues.fixConfirm', { target: t(TARGET_LABEL_KEYS[issue.restartTarget]) }) })
        if (!confirmed) return
        await runner.run(
          t('issues.fixDone'),
          (signal) => hydroApi.fixHostIssue(activeHost.id, { fix: 'restart-service', target: issue.restartTarget as ServiceTarget, confirm: true }, signal),
          (result) => { setFixResult(result); runChecks() },
        )
        return
      }
      if (issue.fix === 'install-ui-plugin') {
        const confirmed = await requestConfirm({ title: t('issues.fixConfirmPlugin') })
        if (!confirmed) return
        await runner.run(
          t('issues.fixDone'),
          (signal) => hydroApi.fixHostIssue(activeHost.id, { fix: 'install-ui-plugin', confirm: true }, signal),
          (result) => { setFixResult(result); runChecks() },
        )
      }
    })()
  }

  return (
    <div style={page}>
      <PageHeading
        title={t('issues.title')}
        hint={t('issues.hint')}
        actions={(
          <span style={inlineRow}>
            <button type="button" style={button} disabled={issues.busy} onClick={runChecks}>
              {issues.busy ? t('issues.running') : issues.data === null ? t('issues.run') : t('issues.rerun')}
            </button>
            <button type="button" style={button} onClick={rejudge}>{t('issues.rejudge')}</button>
            <AutomationButton label={t('automation.healthLabel')} prompt={t('automation.healthPrompt')} />
          </span>
        )}
      />
      <ErrorLine text={issues.error} />
      <ErrorLine text={runner.flash?.tone === 'error' ? runner.flash.text : null} />
      {rejudgeNotice === null ? null : <p style={{ margin: 0, color: colors.warning }}>{rejudgeNotice}</p>}
      <Card
        title={t('issues.diagnosisTitle')}
        hint={t('issues.diagnosisHint')}
        actions={(
          <button type="button" style={primaryButton} disabled={diagnosisBusy} onClick={runDiagnosis}>
            {diagnosisBusy ? t('issues.diagnosisRunning') : t('issues.diagnosisRun')}
          </button>
        )}
      >
        <ErrorLine text={diagnosisError} />
        {diagnosis === null ? (
          <p style={{ ...mutedText, margin: 0 }}>{t('issues.diagnosisHint')}</p>
        ) : (
          <div style={stack}>
            <span style={mutedText}>{diagnosis.message}</span>
            <LogBlock text={diagnosis.log === '' ? t('common.none') : diagnosis.log} maxHeight={320} />
          </div>
        )}
      </Card>
      {runner.flash?.tone === 'ok' ? <p style={{ margin: 0, color: colors.success }}>{runner.flash.text}</p> : null}
      {issues.data === null ? null : (
        <Card title={t('issues.title')} hint={t('issues.collectedAt', { time: formatTime(issues.data.collectedAt, locale, t) })}>
          {localized.length === 0 ? (
            <p style={{ ...mutedText, margin: 0 }}>{t('issues.empty')}</p>
          ) : (
            <div style={stack}>
              {localized.map((issue, index) => {
                const color = issue.severity === 'error' ? colors.danger : issue.severity === 'warning' ? colors.warning : colors.muted
                const canFix = issue.fix !== null && !issue.fixDisabled
                return (
                  <div key={`${issue.code}-${String(index)}`} style={{ ...warningItem, borderColor: color }}>
                    <span style={{ fontWeight: 600 }}><span style={{ ...statusDot, background: color }} />{issue.title}</span>
                    <span style={time}>{issue.suggestion}</span>
                    {issue.detail === null ? null : (
                      <p style={{ ...detailText, margin: 0 }}>
                        <span style={time}>
                          {issue.code === 'issue.staleQueue' ? t('issues.detailStale') : t('issues.rawDetail')}
                        </span>{' '}
                        {issue.detail}
                      </p>
                    )}
                    {issue.fix === null ? null : (
                      <div style={inlineRow}>
                        <button
                          type="button"
                          style={canFix ? primaryButton : button}
                          disabled={!canFix}
                          title={issue.fixDisabled || issue.restartTarget === null ? t('issues.fixUnavailable') : undefined}
                          onClick={() => { applyFix(issue) }}
                        >
                          {t('issues.fix')}
                        </button>
                        {issue.fixDisabled ? <span style={time}>{t('issues.fixUnavailable')}</span> : null}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <HostDiagnoseButton hostId={activeHost.id} kind="issues" output={issuesText} />
          </div>
          {fixResult === null ? null : (
            <Collapsible label={t('issues.fix')}>
              <p style={{ margin: 0 }}>{fixResult.message}</p>
              <LogBlock text={fixResult.log} />
            </Collapsible>
          )}
        </Card>
      )}
    </div>
  )
}
