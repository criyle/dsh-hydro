/**
 * Upgrade planning and execution for the Hydro core and its plugins.
 *
 * Hydro's core and plugins are yarn-global packages, so upgrading is
 * `yarn global add <name>@<version> ...` followed by a service restart (pm2 in
 * the official install). The plan is computed first so `--dry-run` and the
 * model/tool layer can show exactly what would run and how to roll back.
 */
import { shellQuote } from '../ssh/shell.js'
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { OperationResult, PluginInfo } from '../shared/types.js'
import { isNpmPackageName, redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'
import { probeHydro } from './detect.js'
import { fetchLatestVersions } from './registry.js'
import { isUpdateAvailable, packageSpecs, upgradeTargets } from './versions.js'
import {
  buildRestartCommand,
  hydroProcessName,
  resolveServiceManager,
  systemdUnitName,
} from './service.js'

/** Generous deadline for a yarn global upgrade + restart. */
const UPGRADE_TIMEOUT_MS = 15 * 60_000

export interface UpgradeOptions {
  /** Compute the plan and return it without touching the remote. */
  dryRun?: boolean
  /** Only upgrade these package names (interactive selection); omit for all. */
  packages?: string[]
  /** Also restart the standalone judge daemon when one is installed. */
  includeJudge?: boolean
  /** sudo/su password resolved by the caller (never logged). */
  password?: string
  /** Receive upgrade/restart output live (streaming terminal in the UI). */
  onOutput?: import('./remote.js').OutputSink
}

export interface UpgradePlan {
  /** Packages that would be upgraded, with their new version. */
  targets: Array<{ name: string; version: string }>
  /** Full shell command (install + restart); empty when nothing to upgrade. */
  command: string
  /** Currently installed versions of every managed package. */
  current: Record<string, string | null>
}

function buildYarnInstallCommand(context: AccountContext, targets: Array<{ name: string; version: string }>): string {
  const specs = packageSpecs(targets).map((spec) => shellQuote(spec)).join(' ')
  const registry = context.config.hydro.registry.trim()
  if (registry === '') return `yarn global add ${specs}`
  return `yarn global add ${specs} --registry ${shellQuote(registry)}`
}

function buildJudgeRestartCommand(context: AccountContext, probe: HydroProbe): string {
  const manager = resolveServiceManager(context, probe)
  if (manager === 'pm2') {
    return `pm2 restart ${shellQuote(probe.pm2.find((entry) => entry.name.includes('hydrojudge'))?.name ?? 'hydrojudge')}`
  }
  if (manager === 'systemd') return `systemctl restart ${shellQuote(systemdUnitName(context, 'judge'))}`
  return ''
}

/**
 * Compute what an upgrade would do, without changing the remote.
 *
 * Installed versions come from the probe (no `hydrooj --version`); the newest
 * versions come from the configured npm registry.
 */
export async function planUpgrade(context: AccountContext, probe?: HydroProbe, only?: string[]): Promise<UpgradePlan> {
  const resolved = probe ?? (await probeHydro(context))
  const current: Record<string, string | null> = {}
  const pluginInfos: PluginInfo[] = []
  const names: string[] = []

  if (resolved.hydrooj?.name !== undefined) {
    current[resolved.hydrooj.name] = resolved.hydrooj.version
    names.push(resolved.hydrooj.name)
  } else {
    current.hydrooj = null
    names.push('hydrooj')
  }
  for (const addon of resolved.addons) {
    current[addon.name] = addon.version
    if (isNpmPackageName(addon.name)) names.push(addon.name)
  }

  const latest = names.length === 0 ? {} : await fetchLatestVersions(names, context.config.npmRegistry)
  for (const name of names) {
    const version = current[name] ?? null
    const latestVersion = latest[name] ?? null
    pluginInfos.push({
      name,
      version,
      latest: latestVersion,
      updateAvailable: isUpdateAvailable(version, latestVersion),
      builtin: name === 'hydrooj' || name.startsWith('@hydrooj/'),
      enabled: true,
    })
  }

  const allTargets = upgradeTargets(pluginInfos)
  const targets = only === undefined
    ? allTargets
    : allTargets.filter((target) => only.includes(target.name))
  if (targets.length === 0) return { targets, command: '', current }

  const install = buildYarnInstallCommand(context, targets)
  const restart = buildRestartCommand(context, resolved)
  return { targets, command: restart === '' ? install : `${install} && ${restart}`, current }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function rollbackHint(current: Record<string, string | null>): string {
  const specs = Object.entries(current)
    .filter(([name, version]) => version !== null && isNpmPackageName(name))
    .map(([name, version]) => `${name}@${String(version)}`)
  if (specs.length === 0) return ''
  return `如需回滚：yarn global add ${specs.join(' ')}`
}

/**
 * Upgrade the Hydro core/plugins and restart the backend.
 *
 * Refuses in read-only mode and when Hydro is not installed. A failed upgrade
 * includes a concrete rollback command in the returned message.
 */
export async function upgradeHydro(
  context: AccountContext,
  options: UpgradeOptions = {},
): Promise<OperationResult> {
  if (context.readonly) {
    return { ok: false, message: '只读模式下不允许升级 Hydro。请先关闭只读模式后再试。' }
  }

  let probe: HydroProbe
  try {
    probe = await probeHydro(context)
  } catch (error) {
    return { ok: false, message: `升级前探测远端失败：${errorMessage(error)}` }
  }
  if (!probe.installed) {
    return { ok: false, message: '未检测到 Hydro 安装，无法升级。' }
  }

  let plan: UpgradePlan
  try {
    plan = await planUpgrade(context, probe, options.packages)
  } catch (error) {
    return { ok: false, message: `无法计算升级计划：${errorMessage(error)}` }
  }

  const judgeRestart =
    options.includeJudge === true && probe.judge.installed
      ? buildJudgeRestartCommand(context, probe)
      : ''
  let command = plan.command
  if (judgeRestart !== '') command = command === '' ? judgeRestart : `${command} && ${judgeRestart}`

  if (plan.targets.length === 0 && judgeRestart === '') {
    return {
      ok: true,
      message: 'Hydro 核心与插件均已是最新版本，无需升级。',
      details: plan,
    }
  }

  if (options.dryRun === true) {
    const targetText =
      plan.targets.length === 0
        ? '仅重启服务'
        : plan.targets.map((target) => `${target.name}@${target.version}`).join(', ')
    return {
      ok: true,
      message: `升级计划（未执行）：${targetText}`,
      details: plan,
      log: command,
    }
  }

  context.log(`$ ${command}`)
  const elevationPassword = resolveElevationPassword(context, options.password)
  let result
  try {
    result = await runAsRoot(context, command, {
      ...(elevationPassword === undefined ? {} : { password: elevationPassword }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
      timeoutMs: UPGRADE_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      ok: false,
      message: `升级命令执行失败：${errorMessage(error)}`,
      details: { plan },
      log: command,
    }
  }

  const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
  let after: HydroProbe | null = null
  try {
    after = await probeHydro(context)
  } catch {
    after = null
  }

  const exitOk = result.code === 0
  const healthOk = after?.health.ok ?? false
  const ok = exitOk && healthOk
  const before = plan.current
  const versionsAfter: Record<string, string | null> = {}
  if (after !== null) {
    versionsAfter[after.hydrooj?.name ?? 'hydrooj'] = after.hydrooj?.version ?? null
    for (const addon of after.addons) versionsAfter[addon.name] = addon.version
  }

  const details = {
    plan,
    before,
    after: versionsAfter,
    exitCode: result.code,
    health: after?.health ?? null,
    serviceName: hydroProcessName(context, after ?? probe),
    command,
  }

  if (ok) {
    const updated = Object.keys(before)
      .filter((name) => before[name] !== (versionsAfter[name] ?? before[name]))
      .map((name) => `${name}: ${before[name] ?? '?'} → ${versionsAfter[name] ?? '?'}`)
    return {
      ok: true,
      message: `Hydro 升级完成${updated.length === 0 ? '' : `（${updated.join('；')}）`}，服务健康检查通过。`,
      details,
      log: tailText(output, 8000),
    }
  }

  const reasons: string[] = []
  if (!exitOk) reasons.push(`升级命令退出码 ${String(result.code)}`)
  if (!healthOk) reasons.push('升级后 HTTP 健康检查未通过')
  const hint = rollbackHint(before)
  return {
    ok: false,
    message: `Hydro 升级失败：${reasons.join('；')}。${hint}`,
    details,
    log: tailText(output, 8000),
  }
}
