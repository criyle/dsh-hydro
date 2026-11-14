/**
 * Safe one-click fixes for known-issue diagnostics.
 *
 * Only a small allow-list is executable; anything riskier stays a suggestion
 * for the operator/AI. Fixes still pass through the global read-only gate.
 */
import type { AccountContext, HydroProbe, ServiceActionResult } from '../ops/types.js'
import type { OperationResult } from '../shared/types.js'
import { probeHydro } from './detect.js'
import { resolveElevationPassword, runAsRoot, redactSensitive, tailText } from './remote.js'
import { buildRestartCommand, resolveServiceManager, serviceAction } from './service.js'
import { shellQuote } from '../ssh/shell.js'

export type IssueFix =
  | { fix: 'restart-service'; target: ServiceActionResult['target'] }
  | { fix: 'install-ui-plugin' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Apply one known fix; returns a normalized operation result. */
export async function applyIssueFix(context: AccountContext, action: IssueFix): Promise<OperationResult> {
  if (context.readonly) {
    return { ok: false, message: '全局只读已开启，拒绝执行修复操作。' }
  }
  if (action.fix === 'restart-service') {
    const result = await serviceAction(context, action.target, 'restart')
    return {
      ok: result.ok,
      message: result.ok ? `已重启 ${action.target}` : `重启 ${action.target} 失败`,
      log: tailText(result.output, 4000),
    }
  }

  let probe: HydroProbe | null = null
  try {
    probe = await probeHydro(context)
  } catch {
    probe = null
  }
  if (probe === null || !probe.installed) {
    return { ok: false, message: '未检测到 Hydro 安装，无法安装插件。' }
  }
  const manager = resolveServiceManager(context, probe)
  const restart = buildRestartCommand(context, probe)
  const registry = context.config.hydro.registry.trim()
  const install = registry === ''
    ? 'yarn global add @hydrooj/ui-default@latest'
    : `yarn global add @hydrooj/ui-default@latest --registry ${shellQuote(registry)}`
  const command = manager === 'pm2' && restart !== '' ? `${install} && ${restart}` : install
  const password = resolveElevationPassword(context)
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 10 * 60_000,
    })
    const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
    let healthOk = false
    try {
      const after = await probeHydro(context)
      healthOk = after.health.ok
    } catch {
      healthOk = false
    }
    return {
      ok: result.code === 0 && healthOk,
      message: result.code === 0 && healthOk
        ? '已安装 @hydrooj/ui-default 并重启 Hydro'
        : '插件安装/重启未完全成功，请查看输出',
      log: tailText(output, 8000),
    }
  } catch (error) {
    return { ok: false, message: `修复失败：${errorMessage(error)}` }
  }
}
