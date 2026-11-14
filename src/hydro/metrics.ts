/**
 * Host-level metrics and known-issue diagnostics for the visual overview and
 * the smart-troubleshooting page.
 *
 * Metrics are sampled over SSH (one round-trip): CPU delta from `/proc/stat`,
 * memory from `/proc/meminfo`, root filesystem from `df`, load average and CPU
 * cores; judge queue depth comes from a read-only Mongo count.
 */
import type { AccountContext, HydroProbe, ServiceActionResult } from '../ops/types.js'
import type {
  HostIssue,
  HostIssuesResponse,
  HostMetricsResponse,
  MetricAlert,
} from '../shared/api.js'
import { ObjectId } from 'mongodb'
import { probeHydro } from './detect.js'
import { countDatabase, getSystemSetting } from './db.js'
import { run } from '../ops/exec.js'
import { targetForProcessName } from './service.js'

/**
 * Hydro record statuses that are still in flight:
 * 0 waiting, 20 judging, 21 compiling, 22 fetched.
 * 1 is Accepted and 2 is Wrong Answer — those are completed, never "stale".
 */
const IN_FLIGHT_STATUSES = [0, 20, 21, 22] as const
/** Only records in flight for longer than this are considered stale. */
const STALE_AFTER_MS = 10 * 60_000

const METRICS_COMMAND = `cat /proc/stat; sleep 0.4; cat /proc/stat; cat /proc/meminfo; df -P -B1 / | tail -1; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN; cat /proc/loadavg`

interface CpuSnapshot {
  total: number
  idle: number
}

function parseCpuLine(line: string): CpuSnapshot | null {
  const match = /^cpu\s+(.+)$/.exec(line.trim())
  if (match === null) return null
  const values = match[1]!.trim().split(/\s+/).map(Number).filter((value) => Number.isFinite(value))
  if (values.length < 4) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  // idle + iowait
  const idle = (values[3] ?? 0) + (values[4] ?? 0)
  return { total, idle }
}

function parseMemory(text: string): { totalBytes: number | null; availableBytes: number | null } {
  let totalKb: number | null = null
  let availableKb: number | null = null
  for (const line of text.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB/.exec(line.trim())
    if (match === null) continue
    if (match[1] === 'MemTotal') totalKb = Number(match[2])
    else availableKb = Number(match[2])
  }
  return {
    totalBytes: totalKb === null ? null : totalKb * 1024,
    availableBytes: availableKb === null ? null : availableKb * 1024,
  }
}

function parseDisk(line: string): { mount: string; totalBytes: number | null; usedBytes: number | null; usagePercent: number | null } {
  const parts = line.trim().split(/\s+/)
  // Filesystem 1B-blocks Used Available Use% Mounted
  if (parts.length < 6) return { mount: '/', totalBytes: null, usedBytes: null, usagePercent: null }
  const total = Number(parts[1])
  const used = Number(parts[2])
  const percent = Number.parseFloat(parts[4]!.replace('%', ''))
  return {
    mount: parts.slice(5).join(' '),
    totalBytes: Number.isFinite(total) ? total : null,
    usedBytes: Number.isFinite(used) ? used : null,
    usagePercent: Number.isFinite(percent) ? percent : null,
  }
}

function percent(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) return null
  return Math.round((part / whole) * 1000) / 10
}

function thresholds(input: {
  cpuPercent: number | null
  memPercent: number | null
  diskPercent: number | null
  queueDepth: number | null
  load1: number | null
  cores: number | null
}): MetricAlert[] {
  const alerts: MetricAlert[] = []
  const push = (code: MetricAlert['code'], value: number | null, warning: number, error: number): void => {
    if (value === null) return
    if (value >= error) alerts.push({ severity: 'error', code, value })
    else if (value >= warning) alerts.push({ severity: 'warning', code, value })
  }
  push('disk', input.diskPercent, 85, 95)
  push('memory', input.memPercent, 85, 95)
  push('cpu', input.cpuPercent, 85, 95)
  push('queue', input.queueDepth, 50, 200)
  if (input.load1 !== null && input.cores !== null && input.cores > 0) {
    const ratio = input.load1 / input.cores
    if (ratio >= 2) alerts.push({ severity: 'error', code: 'load', value: Math.round(ratio * 10) / 10 })
    else if (ratio >= 1) alerts.push({ severity: 'warning', code: 'load', value: Math.round(ratio * 10) / 10 })
  }
  return alerts
}

/** Collect one metrics sample; Mongo failures only null out the queue depth. */
export async function collectMetrics(context: AccountContext, probe?: HydroProbe): Promise<HostMetricsResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const result = await run(context, METRICS_COMMAND, { timeoutMs: 15_000 })
  if (result.timedOut) throw new Error('采集主机指标超时')
  if (result.code !== 0) throw new Error(`采集主机指标失败：${result.stderr.slice(0, 300)}`)

  const lines = result.stdout.split('\n')
  const cpuLines = lines.filter((line) => line.startsWith('cpu ')).slice(0, 2)
  const first = cpuLines[0] === undefined ? null : parseCpuLine(cpuLines[0])
  const second = cpuLines[1] === undefined ? null : parseCpuLine(cpuLines[1])
  let cpuPercent: number | null = null
  if (first !== null && second !== null && second.total > first.total) {
    const totalDelta = second.total - first.total
    const idleDelta = second.idle - first.idle
    cpuPercent = Math.round((1 - idleDelta / totalDelta) * 1000) / 10
  }

  const memory = parseMemory(result.stdout)
  const diskLine = lines.find((line) => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%/.test(line) && /\/$|\/\S*$/.test(line)) ?? ''
  const disk = parseDisk(diskLine)
  const coresLine = lines.find((line) => /^\d+$/.test(line.trim()))
  const loadLine = lines.find((line) => /^\d+\.\d+\s+\d+\.\d+/.test(line.trim()))
  const cores = coresLine === undefined ? null : Number(coresLine.trim())
  const load1 = loadLine === undefined ? null : Number.parseFloat(loadLine.trim().split(/\s+/)[0]!)

  // The real judge queue is the `task` collection: Hydro removes tasks as the
  // daemon consumes them. `record.status` can stay Fetched/Compiling forever
  // after a daemon restart, which is why counting records made the depth look
  // frozen. Keep stale records as a separate diagnostic.
  let queueDepth: number | null = null
  let staleRecords: number | null = null
  let submissionsLastHour: number | null = null
  let acceptedLastHour: number | null = null
  const now = Date.now()
  const since = new ObjectId(Math.floor((now - 60 * 60_000) / 1000).toString(16).padStart(8, '0') + '0000000000000000')
  const staleSince = new ObjectId(Math.floor((now - STALE_AFTER_MS) / 1000).toString(16).padStart(8, '0') + '0000000000000000')
  await Promise.all([
    countDatabase(context, { collection: 'task' }, resolved).then((value) => { queueDepth = value }).catch(() => undefined),
    countDatabase(context, {
      collection: 'record',
      filter: { status: { $in: [...IN_FLIGHT_STATUSES] }, _id: { $lt: staleSince } },
    }, resolved)
      .then((value) => { staleRecords = value }).catch(() => undefined),
    countDatabase(context, { collection: 'record', filter: { _id: { $gt: since } } }, resolved)
      .then((value) => { submissionsLastHour = value }).catch(() => undefined),
    countDatabase(context, { collection: 'record', filter: { _id: { $gt: since }, status: 1 } }, resolved)
      .then((value) => { acceptedLastHour = value }).catch(() => undefined),
  ])

  const usedBytes = memory.totalBytes === null || memory.availableBytes === null
    ? null
    : memory.totalBytes - memory.availableBytes
  const memPercent = percent(usedBytes, memory.totalBytes)
  const alerts = thresholds({ cpuPercent, memPercent, diskPercent: disk.usagePercent, queueDepth, load1, cores })
  if (staleRecords !== null && staleRecords > 0 && (queueDepth ?? 0) === 0) {
    alerts.push({ severity: 'warning', code: 'stale', value: staleRecords })
  }

  return {
    collectedAt: new Date().toISOString(),
    cpu: { usagePercent: cpuPercent, load1, cores },
    memory: { totalBytes: memory.totalBytes, usedBytes, usagePercent: memPercent },
    disk,
    judge: { queueDepth, submissionsLastHour, acceptedLastHour, staleRecords },
    alerts,
  }
}

const KNOWN_TARGET_LABELS: Record<ServiceActionResult['target'], string> = {
  hydro: 'Hydro',
  mongodb: 'MongoDB',
  sandbox: '评测沙箱',
  caddy: 'Caddy',
  judge: '评测机',
}

/**
 * Run the known-issue checklist: stopped processes, health, disk/memory alerts,
 * abnormal restarts, missing language config/plugin (the classic "没有可以
 * 评测的语言" cause) and missing UI plugin.
 */
export async function collectIssues(context: AccountContext, probe?: HydroProbe): Promise<HostIssuesResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const issues: HostIssue[] = []
  const add = (issue: HostIssue): void => { issues.push(issue) }

  if (!resolved.installed) {
    return {
      collectedAt: new Date().toISOString(),
      issues: [{
        severity: 'warning',
        code: 'issue.notInstalled',
        detail: null,
        fix: null,
        fixTarget: null,
      }],
    }
  }

  if (!resolved.health.ok) {
    add({ severity: 'error', code: 'issue.health', detail: resolved.health.status === null ? null : `HTTP ${String(resolved.health.status)}`, fix: 'restart-service', fixTarget: 'hydro' })
  }

  for (const process of resolved.pm2) {
    const target = targetForProcessName(process.name)
    if (target === null) continue
    if (process.status !== 'online' && process.status !== 'running') {
      add({ severity: 'error', code: `issue.serviceStopped.${target}`, detail: process.status, fix: 'restart-service', fixTarget: target })
    }
    if (process.restarts !== null && process.restarts >= 10) {
      add({ severity: 'warning', code: 'issue.restarts', detail: `${process.name}: ${String(process.restarts)}`, fix: null, fixTarget: null })
    }
  }
  if (!resolved.sandbox.running) {
    add({ severity: 'warning', code: 'issue.sandbox', detail: resolved.sandbox.version, fix: 'restart-service', fixTarget: 'sandbox' })
  }
  if (resolved.judge.installed && !resolved.judge.running) {
    add({ severity: 'warning', code: 'issue.judge', detail: null, fix: 'restart-service', fixTarget: 'judge' })
  }

  let metrics: HostMetricsResponse | null = null
  try {
    metrics = await collectMetrics(context, resolved)
    for (const alert of metrics.alerts) {
      const code = alert.code === 'disk' ? 'issue.disk'
        : alert.code === 'memory' ? 'issue.memory'
          : alert.code === 'cpu' ? 'issue.cpu'
            : alert.code === 'queue' ? 'issue.queue'
              : alert.code === 'stale' ? 'issue.staleQueue'
                : 'issue.load'
      add({ severity: alert.severity === 'error' ? 'error' : 'warning', code, detail: String(alert.value), fix: null, fixTarget: null })
    }
  } catch {
    // Metrics are optional for diagnostics.
  }

  // Classic cause of "没有可以评测的语言": missing language configuration or
  // the UI/language plugin not installed.
  try {
    const langs = await getSystemSetting(context, 'hydrooj.langs', resolved)
    // `undefined` means no DB override: Hydro then uses the packaged default
    // language list, which is healthy. Only an explicitly empty value is a
    // problem (the classic "没有可以评测的语言" after a plugin/config mistake).
    const explicitlyEmpty = langs === ''
      || (langs !== null && typeof langs === 'object' && Object.keys(langs as Record<string, unknown>).length === 0)
    if (explicitlyEmpty) {
      add({ severity: 'warning', code: 'issue.langsMissing', detail: null, fix: null, fixTarget: null })
    }
  } catch {
    // Mongo unavailable; skip.
  }
  const hasUiDefault = resolved.addons.some((addon) => addon.name === '@hydrooj/ui-default')
  if (!hasUiDefault) {
    add({ severity: 'warning', code: 'issue.uiDefaultMissing', detail: null, fix: null, fixTarget: null })
  }

  if (issues.length === 0) {
    add({ severity: 'info', code: 'issue.allGood', detail: null, fix: null, fixTarget: null })
  }
  return { collectedAt: new Date().toISOString(), issues }
}

/** Human-readable target label used by issue details/diagnostics. */
export function targetLabel(target: ServiceActionResult['target']): string {
  return KNOWN_TARGET_LABELS[target]
}
