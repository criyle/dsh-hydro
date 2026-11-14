/**
 * Service control for the processes a Hydro install runs.
 *
 * The official installer manages everything through pm2 as root; older/hand
 * deployments use systemd. `serviceAction` transparently elevates for
 * mutating actions (root is required to touch pm2) and refuses in read-only
 * mode.
 */
import { shellQuote } from '../ssh/shell.js'
import { run } from '../ops/exec.js'
import type { AccountContext, HydroProbe, ServiceActionResult } from '../ops/types.js'
import { probeHydro } from './detect.js'
import { parsePm2Jlist, redactSensitive, runAsRoot, tailText } from './remote.js'

export type EffectiveServiceManager = 'pm2' | 'systemd' | 'manual'

const DEFAULT_PM2_NAMES: Record<ServiceActionResult['target'], string> = {
  hydro: 'hydrooj',
  mongodb: 'mongodb',
  sandbox: 'hydro-sandbox',
  caddy: 'caddy',
  judge: 'hydrojudge',
}

const DEFAULT_SYSTEMD_UNITS: Record<ServiceActionResult['target'], string> = {
  hydro: 'hydrooj',
  mongodb: 'mongod',
  sandbox: 'hydro-sandbox',
  caddy: 'caddy',
  judge: 'hydrojudge',
}

/**
 * Pick the manager dsh-hydro should drive.
 *
 * Explicit `config.hydro.serviceManager` wins; otherwise the probe decides.
 * docker/unknown deployments are reported as `manual` (no generic control).
 */
export function resolveServiceManager(
  context: AccountContext,
  probe: HydroProbe | null,
): EffectiveServiceManager {
  const configured = context.config.hydro.serviceManager
  if (configured === 'pm2' || configured === 'systemd' || configured === 'manual') return configured
  if (probe?.serviceManager === 'pm2') return 'pm2'
  if (probe?.serviceManager === 'systemd') return 'systemd'
  return 'manual'
}

/** pm2 process name for the Hydro HTTP backend. */
export function hydroProcessName(context: AccountContext, probe: HydroProbe | null): string {
  const detected = probe?.pm2.find((entry) => entry.name.includes('hydrooj'))?.name
  return detected ?? context.config.hydro.serviceName
}

/** pm2 process name for one target. */
export function pm2TargetName(
  context: AccountContext,
  probe: HydroProbe | null,
  target: ServiceActionResult['target'],
): string {
  if (target === 'hydro') return hydroProcessName(context, probe)
  const preferred = DEFAULT_PM2_NAMES[target]
  const detected = probe?.pm2.find((entry) => entry.name === preferred)?.name
  return detected ?? preferred
}

/** systemd unit name for one target. */
export function systemdUnitName(
  context: AccountContext,
  target: ServiceActionResult['target'],
): string {
  if (target === 'hydro') return context.config.hydro.serviceName
  return DEFAULT_SYSTEMD_UNITS[target]
}

/**
 * Restart command for the Hydro backend, or `''` when no manager is usable.
 * Shared with the upgrade planner.
 */
export function buildRestartCommand(context: AccountContext, probe: HydroProbe | null): string {
  const manager = resolveServiceManager(context, probe)
  if (manager === 'pm2') return `pm2 restart ${shellQuote(hydroProcessName(context, probe))}`
  if (manager === 'systemd') {
    return `systemctl restart ${shellQuote(systemdUnitName(context, 'hydro'))}`
  }
  return ''
}

/**
 * Read pm2's process list, preferring the root user's daemon when the local
 * one is empty (non-root SSH accounts in the default install).
 */
const PM2_JLIST_COMMAND = `PM2J="$(pm2 jlist 2>/dev/null)"; if [ -z "$PM2J" ] || [ "$PM2J" = "[]" ]; then PM2R="$(sudo -n pm2 jlist 2>/dev/null)"; if [ -n "$PM2R" ] && [ "$PM2R" != "[]" ]; then PM2J="$PM2R"; fi; fi; printf '%s' "$PM2J"`

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return tailText(redactSensitive(`${result.stdout}\n${result.stderr}`), 4000)
}

/**
 * Start/stop/restart/reload/status one Hydro component.
 *
 * Never throws for service-manager failures; the failure is reported in
 * `ok`/`output` so tools can render it. Read-only accounts are refused for
 * everything except `status`.
 */
export async function serviceAction(
  context: AccountContext,
  target: ServiceActionResult['target'],
  action: ServiceActionResult['action'],
  probe?: HydroProbe,
): Promise<ServiceActionResult> {
  let resolved = probe ?? null
  if (resolved === null) {
    try {
      resolved = await probeHydro(context)
    } catch {
      resolved = null
    }
  }
  const manager = resolveServiceManager(context, resolved)

  if (action !== 'status' && context.readonly) {
    return {
      target,
      manager,
      action,
      ok: false,
      output: '只读模式下不允许执行服务操作（start/stop/restart/reload）。',
    }
  }
  if (resolved === null || !resolved.installed) {
    return {
      target,
      manager,
      action,
      ok: false,
      output: '未检测到 Hydro 安装，无法执行服务操作。',
    }
  }

  if (manager === 'pm2') {
    const name = pm2TargetName(context, resolved, target)
    if (action === 'status') {
      try {
        const result = await run(context, PM2_JLIST_COMMAND, { timeoutMs: 20_000 })
        const entries = parsePm2Jlist(result.stdout)
        const proc = entries.find((entry) => entry.name === name)
        if (proc === undefined) {
          const names = entries.map((entry) => entry.name).join(', ')
          return {
            target,
            manager: 'pm2',
            action,
            ok: false,
            output: `未在 pm2 中找到进程 ${name}。当前进程：${names === '' ? '(无)' : names}`,
          }
        }
        const since =
          proc.uptimeMs === null ? null : new Date(Date.now() - proc.uptimeMs).toISOString()
        return {
          target,
          manager: 'pm2',
          action,
          ok: proc.status === 'online',
          output: `${proc.name}: ${proc.status} pid=${proc.pid === null ? '-' : String(proc.pid)} restarts=${
            proc.restarts === null ? '-' : String(proc.restarts)
          }${since === null ? '' : ` since=${since}`}`,
        }
      } catch (error) {
        return { target, manager: 'pm2', action, ok: false, output: `读取 pm2 状态失败：${errorMessage(error)}` }
      }
    }
    try {
      const result = await runAsRoot(context, `pm2 ${action} ${shellQuote(name)}`, {
        timeoutMs: 60_000,
      })
      return {
        target,
        manager: 'pm2',
        action,
        ok: result.code === 0,
        output: outputOf(result) || `pm2 ${action} ${name} 退出码 ${String(result.code)}`,
      }
    } catch (error) {
      return {
        target,
        manager: 'pm2',
        action,
        ok: false,
        output: `执行 pm2 ${action} 失败：${errorMessage(error)}`,
      }
    }
  }

  if (manager === 'systemd') {
    const unit = systemdUnitName(context, target)
    if (action === 'status') {
      try {
        const result = await run(context, `systemctl is-active ${shellQuote(unit)}`, { timeoutMs: 20_000 })
        const state = result.stdout.trim()
        return {
          target,
          manager: 'systemd',
          action,
          ok: state === 'active',
          output: `${unit}: ${state === '' ? (result.stderr.trim() || 'unknown') : state}`,
        }
      } catch (error) {
        return {
          target,
          manager: 'systemd',
          action,
          ok: false,
          output: `读取 systemd 状态失败：${errorMessage(error)}`,
        }
      }
    }
    try {
      const result = await runAsRoot(context, `systemctl ${action} ${shellQuote(unit)}`, {
        timeoutMs: 60_000,
      })
      return {
        target,
        manager: 'systemd',
        action,
        ok: result.code === 0,
        output: outputOf(result) || `systemctl ${action} ${unit} 退出码 ${String(result.code)}`,
      }
    } catch (error) {
      return {
        target,
        manager: 'systemd',
        action,
        ok: false,
        output: `执行 systemctl ${action} 失败：${errorMessage(error)}`,
      }
    }
  }

  return {
    target,
    manager: 'manual',
    action,
    ok: false,
    output:
      '未检测到可用的服务管理器（pm2/systemd）。docker/源码部署请手动管理对应进程或容器。',
  }
}

/** Structured pm2/service view for the visual service monitor. */
export interface ServiceOverview {
  manager: EffectiveServiceManager
  collectedAt: string
  processes: Array<{
    name: string
    status: string
    pid: number | null
    restarts: number | null
    uptimeMs: number | null
    cpuPercent: number | null
    memoryBytes: number | null
    execPath: string | null
    target: ServiceActionResult['target'] | null
  }>
  hydro: {
    installed: boolean
    version: string | null
    serviceName: string | null
    health: { ok: boolean; status: number | null; latencyMs: number | null }
  }
  sandbox: { running: boolean; version: string | null; address: string | null }
  judge: { installed: boolean; running: boolean; configPath: string | null }
}

/** Map a pm2 process name to a controllable Hydro component. */
export function targetForProcessName(name: string): ServiceActionResult['target'] | null {
  const lower = name.toLowerCase()
  if (lower.includes('hydrojudge')) return 'judge'
  if (lower.includes('hydrooj')) return 'hydro'
  if (lower.includes('mongo')) return 'mongodb'
  if (lower.includes('sandbox')) return 'sandbox'
  if (lower.includes('caddy')) return 'caddy'
  return null
}

/**
 * Collect the structured service overview without changing anything.
 * @param context - remote account context.
 * @param probe - reuse an existing probe when the caller has one.
 * @returns pm2 processes (CPU/memory/restarts) plus Hydro/sandbox/judge state.
 */
export async function serviceOverview(
  context: AccountContext,
  probe?: HydroProbe,
): Promise<ServiceOverview> {
  const resolved = probe ?? (await probeHydro(context))
  const manager = resolveServiceManager(context, resolved)
  return {
    manager,
    collectedAt: new Date().toISOString(),
    processes: resolved.pm2.map((entry) => ({
      name: entry.name,
      status: entry.status,
      pid: entry.pid,
      restarts: entry.restarts,
      uptimeMs: entry.uptimeMs,
      cpuPercent: entry.cpuPercent ?? null,
      memoryBytes: entry.memoryBytes ?? null,
      execPath: entry.execPath,
      target: targetForProcessName(entry.name),
    })),
    hydro: {
      installed: resolved.installed,
      version: resolved.hydrooj?.version ?? null,
      serviceName: resolved.pm2.find((entry) => entry.name.includes('hydrooj'))?.name ?? null,
      health: {
        ok: resolved.health.ok,
        status: resolved.health.status,
        latencyMs: resolved.health.latencyMs,
      },
    },
    sandbox: resolved.sandbox,
    judge: {
      installed: resolved.judge.installed,
      running: resolved.judge.running,
      configPath: resolved.judge.configPath,
    },
  }
}
