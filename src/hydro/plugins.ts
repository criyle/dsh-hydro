/**
 * Hydro plugin/addon management through the official CLI.
 *
 * Hydro addons are yarn-global packages registered in `~/.hydro/addon.json`.
 * `hydrooj addon add/remove` edits that list; yarn installs/removes the code.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { OperationResult } from '../shared/types.js'
import { probeHydro } from './detect.js'
import { isNpmPackageName, redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'
import { buildRestartCommand } from './service.js'
import { shellQuote } from '../ssh/shell.js'

export interface PluginInfo {
  name: string
  version: string | null
  enabled: boolean
}

export interface PluginList {
  plugins: PluginInfo[]
  enabled: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** List installed addons (with versions) and enabled addon names. */
export async function listPlugins(context: AccountContext, probe?: HydroProbe): Promise<PluginList> {
  const resolved = probe ?? (await probeHydro(context))
  const byName = new Map<string, PluginInfo>()
  for (const addon of resolved.addons) {
    byName.set(addon.name, { name: addon.name, version: addon.version, enabled: resolved.addonNames.includes(addon.name) })
  }
  for (const name of resolved.addonNames) {
    if (!byName.has(name)) byName.set(name, { name, version: null, enabled: true })
  }
  return { plugins: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), enabled: [...resolved.addonNames] }
}

export type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable'

/** Install/uninstall/enable/disable one addon and restart Hydro. */
export async function managePlugin(
  context: AccountContext,
  input: { action: PluginAction; name: string },
  probe?: HydroProbe,
): Promise<OperationResult> {
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝修改插件。' }
  const name = input.name.trim()
  if (!isNpmPackageName(name)) return { ok: false, message: '插件名必须是 npm 包名' }
  const resolved = probe ?? (await probeHydro(context))
  const restart = buildRestartCommand(context, resolved)
  const registry = context.config.hydro.registry.trim()
  const yarnAdd = registry === '' ? `yarn global add ${shellQuote(name)}` : `yarn global add ${shellQuote(name)} --registry ${shellQuote(registry)}`
  const commands: Record<PluginAction, string[]> = {
    install: [yarnAdd, `hydrooj addon add ${shellQuote(name)}`],
    uninstall: [`hydrooj addon remove ${shellQuote(name)}`, `yarn global remove ${shellQuote(name)}`],
    enable: [`hydrooj addon add ${shellQuote(name)}`],
    disable: [`hydrooj addon remove ${shellQuote(name)}`],
  }
  const command = [...commands[input.action], ...(restart === '' ? [] : [restart])].join(' && ')
  const password = resolveElevationPassword(context)
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 10 * 60_000,
    })
    const log = redactSensitive(`${result.stdout}\n${result.stderr}`)
    return {
      ok: result.code === 0,
      message: result.code === 0 ? `${input.action} 插件 ${name} 完成，Hydro 已重启` : `${input.action} 插件 ${name} 失败（退出码 ${String(result.code)}）`,
      log: tailText(log, 8000),
    }
  } catch (error) {
    return { ok: false, message: `插件操作失败：${errorMessage(error)}` }
  }
}
