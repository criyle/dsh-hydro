/**
 * Status aggregation for one remote Hydro account.
 *
 * `collectHydroStatus` fans out to the independent probes (SSH probe, host
 * facts, Mongo, admin WebSocket, npm registry) and degrades gracefully: a
 * failing sub-probe becomes a warning, never an exception. The result is the
 * single payload the UI card and the `hydro_status` tool render.
 */
import { run } from '../ops/exec.js'
import type { AccountContext, HydroProbe, StatusOptions } from '../ops/types.js'
import type {
  HydroStatus,
  JudgeInfo,
  MongoState,
  PluginInfo,
  RemoteHostInfo,
  ServiceState,
  StatusWarning,
} from '../shared/types.js'
import { isNpmPackageName, warningCode } from './remote.js'
import { probeHydro } from './detect.js'
import { isUpdateAvailable, sortPlugins, parseVersion } from './versions.js'
import { inspectMongo } from './db.js'
import { collectWsWarnings } from './ws.js'
import { fetchLatestVersions } from './registry.js'

/** Marker comment used to identify the host-facts command in tests. */
const HOST_FACTS_SCRIPT = `# dsh-hydro host facts
set +e
printf 'hostname=%s\\n' "$(uname -n 2>/dev/null)"
printf 'platform=%s\\n' "$(uname -s 2>/dev/null)"
printf 'release=%s\\n' "$(uname -r 2>/dev/null)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"
printf 'node=%s\\n' "$(node -v 2>/dev/null)"
printf 'uptime=%s\\n' "$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"
printf 'load=%s\\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
printf 'memfree=%s\\n' "$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)"
printf 'diskfree=%s\\n' "$(df -Pk / 2>/dev/null | awk 'NR==2{print $4}')"
`

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function numberOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** Collect CPU/memory/disk facts in one small command; null on failure. */
async function collectHostInfo(context: AccountContext): Promise<RemoteHostInfo | null> {
  try {
    const result = await run(context, HOST_FACTS_SCRIPT, {
      timeoutMs: Math.min(context.config.commandTimeoutMs, 15_000),
    })
    const values = new Map<string, string>()
    for (const line of result.stdout.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
    }
    const load = (values.get('load') ?? '')
      .split(/\s+/)
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value))
    const memoryKb = numberOrNull(values.get('memfree'))
    const diskKb = numberOrNull(values.get('diskfree'))
    return {
      hostname: nonEmpty(values.get('hostname')),
      platform: nonEmpty(values.get('platform')),
      release: nonEmpty(values.get('release')),
      arch: nonEmpty(values.get('arch')),
      node: nonEmpty(values.get('node')),
      uptimeSeconds: numberOrNull(values.get('uptime')),
      load,
      diskFreeBytes: diskKb === null ? null : Math.round(diskKb * 1024),
      memoryFreeBytes: memoryKb === null ? null : Math.round(memoryKb * 1024),
    }
  } catch {
    return null
  }
}

function makeWarning(
  severity: StatusWarning['severity'],
  prefix: string,
  message: string,
  hint: string | null = null,
): StatusWarning {
  return { severity, code: warningCode(prefix, message), message, hint }
}

function emptyStatus(accountId: string): HydroStatus {
  return {
    accountId,
    collectedAt: new Date().toISOString(),
    reachable: false,
    error: null,
    installMode: 'none',
    components: { web: false, judge: false, caddy: false, mongo: false, sandbox: false },
    host: null,
    hydro: {
      installed: false,
      installDir: null,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      service: null,
      url: null,
      health: null,
    },
    plugins: [],
    judge: null,
    mongo: null,
    warnings: [],
  }
}

function buildService(probe: HydroProbe): ServiceState | null {
  if (!probe.installed) return null
  const manager = probe.serviceManager
  if (manager === 'pm2') {
    const procs = probe.pm2.filter((entry) => entry.name.includes('hydrooj'))
    const proc = procs.find((entry) => entry.name === 'hydrooj') ?? procs[0]
    if (proc === undefined) {
      return {
        manager: 'pm2',
        name: probe.hydrooj?.name ?? 'hydrooj',
        running: probe.health.ok,
        pid: null,
        since: null,
        restarts: null,
      }
    }
    return {
      manager: 'pm2',
      name: proc.name,
      running: proc.status === 'online',
      pid: proc.pid,
      since: proc.uptimeMs === null ? null : new Date(Date.now() - proc.uptimeMs).toISOString(),
      restarts: proc.restarts,
    }
  }
  if (manager === 'systemd') {
    return {
      manager: 'systemd',
      name: probe.hydrooj?.name ?? 'hydrooj',
      running: probe.health.ok,
      pid: null,
      since: null,
      restarts: null,
    }
  }
  if (manager === 'docker') {
    return {
      manager: 'docker',
      name: 'oj-backend',
      running: probe.health.ok,
      pid: null,
      since: null,
      restarts: null,
    }
  }
  return {
    manager: manager === 'manual' ? 'manual' : 'unknown',
    name: null,
    running: probe.health.ok,
    pid: null,
    since: null,
    restarts: null,
  }
}

function buildJudge(probe: HydroProbe): JudgeInfo | null {
  if (!probe.installed) return null
  const judgeProc = probe.pm2.find((entry) => entry.name.includes('hydrojudge')) ?? null
  const sandboxProc = probe.pm2.find((entry) => entry.name.includes('sandbox')) ?? null
  if (!probe.judge.installed && probe.sandbox.version === null && sandboxProc === null) return null
  const sandbox =
    probe.sandbox.version?.toLowerCase().includes('go-judge') === true
      ? 'go-judge'
      : probe.sandbox.version !== null
        ? 'sandbox'
        : (sandboxProc?.name ?? null)
  return {
    sandbox,
    sandboxVersion: probe.sandbox.version,
    workers: judgeProc !== null ? 1 : null,
    queue: null,
    running: null,
    lastHeartbeat: null,
  }
}

function buildPlugins(probe: HydroProbe, latest: Record<string, string | null>): PluginInfo[] {
  const versions = new Map(probe.addons.map((addon) => [addon.name, addon.version]))
  const names = new Set<string>(probe.addonNames)
  for (const addon of probe.addons) names.add(addon.name)
  const plugins: PluginInfo[] = []
  for (const name of names) {
    const version = versions.get(name) ?? null
    const latestVersion = latest[name] ?? null
    plugins.push({
      name,
      version,
      latest: latestVersion,
      updateAvailable: isUpdateAvailable(version, latestVersion),
      builtin: name === 'hydrooj' || name.startsWith('@hydrooj/'),
      enabled: true,
    })
  }
  return sortPlugins(plugins)
}


function logLatestFailure(context: AccountContext, error: unknown): void {
  context.log(`获取最新版本失败：${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Aggregate the full status for one account.
 *
 * `options.includeMongo` / `includeWsWarnings` / `includeLatestVersions` gate
 * the slow or network-touching parts. An SSH/probe failure yields a
 * `reachable: false` status instead of throwing (cancellation still
 * propagates).
 */
export async function collectHydroStatus(
  context: AccountContext,
  options: StatusOptions,
): Promise<HydroStatus> {
  const status = emptyStatus(context.account.id)
  const warnings: StatusWarning[] = []

  const [probeOutcome, hostOutcome] = await Promise.allSettled([
    probeHydro(context),
    collectHostInfo(context),
  ])

  if (context.signal?.aborted === true) {
    throw context.signal.reason instanceof Error ? context.signal.reason : new Error('操作已取消')
  }

  status.host = hostOutcome.status === 'fulfilled' ? hostOutcome.value : null

  if (probeOutcome.status === 'rejected') {
    const message = probeOutcome.reason instanceof Error ? probeOutcome.reason.message : String(probeOutcome.reason)
    status.error = message
    warnings.push(
      makeWarning('error', 'hydro.probe.failed', `无法探测远端 Hydro：${message}`, '请检查 SSH 连接与账号权限'),
    )
    status.warnings = warnings
    return status
  }

  const probe = probeOutcome.value
  status.reachable = true

  /* Latest versions (optional, network) ------------------------------ */
  let latest: Record<string, string | null> = {}
  if (options.includeLatestVersions) {
    const names = [
      probe.hydrooj?.name ?? 'hydrooj',
      ...probe.addonNames.filter((name) => isNpmPackageName(name)),
    ].filter((name, index, all) => all.indexOf(name) === index)
    try {
      latest = await fetchLatestVersions(names, context.config.npmRegistry)
      if (names.length > 0 && names.every((name) => (latest[name] ?? null) === null)) {
        warnings.push(
          makeWarning(
            'info',
            'hydro.registry',
            '无法从 npm registry 获取最新版本',
            `检查网络或配置 status.includeLatestVersions / config.npmRegistry（当前 ${context.config.npmRegistry}）`,
          ),
        )
      }
    } catch (error) {
      logLatestFailure(context, error)
      latest = {}
    }
  }

  const coreName = probe.hydrooj?.name ?? 'hydrooj'
  const currentVersion = parseVersion(probe.hydrooj?.version ?? null) ?? probe.hydrooj?.version ?? null
  const latestVersion = latest[coreName] ?? null

  status.installMode = probe.installMode
  status.components = { ...probe.components }
  status.hydro = {
    installed: probe.installed,
    installDir: probe.installDir,
    version: currentVersion,
    latestVersion,
    updateAvailable: isUpdateAvailable(currentVersion, latestVersion),
    service: buildService(probe),
    url: null,
    health: probe.installed
      ? {
          ok: probe.health.ok,
          status: probe.health.status,
          latencyMs: probe.health.latencyMs,
          error: probe.health.ok ? null : '健康检查未通过',
        }
      : null,
  }
  status.plugins = buildPlugins(probe, latest)
  status.judge = buildJudge(probe)

  /* Probe warnings --------------------------------------------------- */
  for (const warning of probe.warnings) {
    warnings.push(makeWarning('warning', 'hydro.probe', warning))
  }
  if (!probe.installed) {
    warnings.push(
      makeWarning(
        'info',
        'hydro.not-installed',
        '未检测到 Hydro 安装',
        '可使用 hydro_install 工具一键安装（需要 root 权限）',
      ),
    )
  } else if (!probe.health.ok) {
    warnings.push(
      makeWarning(
        'warning',
        'hydro.health',
        `Hydro 健康检查未通过（HTTP ${probe.health.status === null ? '无响应' : String(probe.health.status)}）`,
        '检查 pm2 进程与 ~/.hydro/config.json，必要时重启 hydrooj',
      ),
    )
  }
  if (status.hydro.updateAvailable && latestVersion !== null) {
    warnings.push(
      makeWarning(
        'info',
        'hydro.update-available',
        `Hydro 有新版本可用：${currentVersion ?? '未知'} → ${latestVersion}`,
        '可使用 hydro_upgrade 工具升级',
      ),
    )
  }

  /* Mongo (optional) -------------------------------------------------- */
  let mongo: MongoState | null = null
  if (options.includeMongo && probe.installed) {
    try {
      mongo = await inspectMongo(context, probe)
      if (!mongo.reachable) {
        warnings.push(
          makeWarning(
            'warning',
            'hydro.mongo',
            'MongoDB 不可达或无法读取连接配置',
            '确认 ~/.hydro/config.json 存在且 mongod 正在运行；本插件只通过 SSH 隧道只读访问',
          ),
        )
      } else if (options.includeOplog && !mongo.oplog.available) {
        warnings.push(
          makeWarning(
            'info',
            'hydro.oplog',
            '当前 MongoDB 没有可读的 local.oplog.rs（单机模式）',
            '如需原生 oplog，请改为单节点副本集（mongod --replSet rs0 + rs.initiate()），本插件不会自动修改',
          ),
        )
      }
    } catch (error) {
      warnings.push(
        makeWarning('warning', 'hydro.mongo.failed', `MongoDB 检查失败：${error instanceof Error ? error.message : String(error)}`),
      )
      mongo = null
    }
  }
  status.mongo = mongo

  /* Admin WebSocket warnings (optional) ------------------------------- */
  if (options.includeWsWarnings && probe.installed) {
    try {
      const session = context.hydroSession?.()
      const wsWarnings = await collectWsWarnings(context, probe, {
        timeoutMs: options.timeoutMs > 0 ? Math.min(3000, options.timeoutMs) : 3000,
        ...(session?.sid === undefined ? {} : { sid: session.sid }),
      })
      warnings.push(...wsWarnings)
    } catch (error) {
      warnings.push(
        makeWarning('warning', 'hydro.ws.failed', `获取管理员 WS 警告失败：${error instanceof Error ? error.message : String(error)}`),
      )
    }
  }

  status.warnings = warnings.slice(0, 100)
  return status
}

/** Fast status: probe + host facts only (no Mongo/WS/registry work). */
export async function quickStatus(context: AccountContext): Promise<HydroStatus> {
  return collectHydroStatus(context, {
    includeMongo: false,
    includeOplog: false,
    includeWsWarnings: false,
    includeLatestVersions: false,
    timeoutMs: Math.min(context.config.status.timeoutMs, 15_000),
  })
}
