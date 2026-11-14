/**
 * Caddy reverse-proxy configuration management.
 *
 * The official Hydro installer exposes Hydro through Caddy on :80. This module
 * reads/edits the Caddyfile, validates it, and reloads Caddy; it never exposes
 * port 8888 to the browser. All writes go through root elevation and keep a
 * `.dsh-hydro.bak` copy.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { CaddyResponse } from '../shared/api.js'
import type { OperationResult } from '../shared/types.js'
import { probeHydro } from './detect.js'
import { redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'
import { shellQuote } from '../ssh/shell.js'

const CANDIDATES = ['/root/.hydro/Caddyfile', '/etc/caddy/Caddyfile', '/root/Caddyfile', '/data/Caddyfile', '/etc/caddy/caddyfile']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Locate the Caddyfile and read its contents (empty when none exists). */
export async function readCaddy(context: AccountContext, probe?: HydroProbe): Promise<CaddyResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const caddyProcess = resolved.pm2.find((entry) => entry.name.toLowerCase().includes('caddy'))
  const manager = resolved.serviceManager === 'pm2' ? 'pm2' : resolved.serviceManager === 'systemd' ? 'systemd' : 'manual'
  const find = CANDIDATES.map((path) => `[ -f ${shellQuote(path)} ] && echo ${shellQuote(path)}`).join('; ')
  const password = resolveElevationPassword(context)
  const result = await runAsRoot(context, `${find} 2>/dev/null | head -1; command -v caddy 2>/dev/null || true`, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: 15_000,
  }).catch(() => null)
  const lines = (result?.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const path = CANDIDATES.find((candidate) => lines.includes(candidate)) ?? null
  let content = ''
  if (path !== null) {
    const read = await runAsRoot(context, `cat ${shellQuote(path)} 2>/dev/null || true`, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 15_000,
    }).catch(() => null)
    content = redactSensitive(read?.stdout ?? '')
  }
  return {
    installed: caddyProcess !== undefined || lines.some((line) => line.includes('caddy')),
    running: caddyProcess?.status === 'online' || caddyProcess?.status === 'running',
    manager,
    path,
    content: tailText(content, 120_000),
    version: resolved.sandbox.version === null ? null : null,
  }
}

function caddyCommand(probe: HydroProbe): string {
  const exec = probe.pm2.find((entry) => entry.name.toLowerCase().includes('caddy'))?.execPath
  return exec === null || exec === undefined ? 'caddy' : shellQuote(exec)
}

async function runCaddy(
  context: AccountContext,
  probe: HydroProbe,
  action: 'validate' | 'reload',
  path: string | null,
): Promise<OperationResult> {
  const binary = caddyCommand(probe)
  const config = path === null ? '' : ` --config ${shellQuote(path)} --adapter caddyfile`
  const password = resolveElevationPassword(context)
  const command = action === 'validate'
    ? `${binary} validate${config}`
    : `if ! ${binary} reload${config}; then pm2 restart caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true; fi`
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 60_000,
    })
    return {
      ok: result.code === 0,
      message: result.code === 0
        ? action === 'validate' ? 'Caddyfile 校验通过' : 'Caddy 已重载'
        : `Caddy ${action} 失败（退出码 ${String(result.code)}）`,
      log: tailText(redactSensitive(`${result.stdout}\n${result.stderr}`), 8000),
    }
  } catch (error) {
    return { ok: false, message: `Caddy ${action} 失败：${errorMessage(error)}` }
  }
}

/** Write a Caddyfile (with backup), optionally validating/reloading. */
export async function writeCaddy(
  context: AccountContext,
  input: { path: string; content: string; reload: boolean },
  probe?: HydroProbe,
): Promise<OperationResult> {
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝修改 Caddy 配置。' }
  const resolved = probe ?? (await probeHydro(context))
  const allowed = CANDIDATES.includes(input.path) || input.path.startsWith('/etc/caddy/') || /(^|\/)\.hydro\/Caddyfile$/.test(input.path)
  if (!allowed) return { ok: false, message: '只允许写入 /etc/caddy/ 下的配置文件' }
  const password = resolveElevationPassword(context)
  const encoded = Buffer.from(input.content, 'utf8').toString('base64')
  const command = [
    `mkdir -p ${shellQuote(input.path.replace(/\/[^/]+$/, ''))}`,
    `[ -f ${shellQuote(input.path)} ] && cp -f ${shellQuote(input.path)} ${shellQuote(`${input.path}.dsh-hydro.bak`)} || true`,
    `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(input.path)}`,
    `${caddyCommand(resolved)} validate --config ${shellQuote(input.path)} --adapter caddyfile`,
    ...(input.reload ? [`if ! ${caddyCommand(resolved)} reload --config ${shellQuote(input.path)} --adapter caddyfile; then pm2 restart caddy 2>/dev/null || true; fi`] : []),
  ].join(' && ')
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 90_000,
    })
    return {
      ok: result.code === 0,
      message: result.code === 0 ? (input.reload ? 'Caddy 配置已保存并重载' : 'Caddy 配置已保存并通过校验') : 'Caddy 配置保存/校验失败',
      log: tailText(redactSensitive(`${result.stdout}\n${result.stderr}`), 8000),
    }
  } catch (error) {
    return { ok: false, message: `Caddy 配置保存失败：${errorMessage(error)}` }
  }
}

/** Validate or reload the current Caddyfile. */
export async function applyCaddy(
  context: AccountContext,
  action: 'validate' | 'reload',
  probe?: HydroProbe,
): Promise<OperationResult> {
  const resolved = probe ?? (await probeHydro(context))
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝重载 Caddy。' }
  const state = await readCaddy(context, resolved)
  return runCaddy(context, resolved, action, state.path)
}
