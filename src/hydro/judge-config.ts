/**
 * Hydro judge configuration management (`~/.hydro/judge.yaml`).
 *
 * Mirrors the Caddy manager: read status/config, write with backup, restart the
 * judge service, and keep the whole surface read-only guarded/confirm-gated.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { JudgeConfigResponse } from '../shared/api.js'
import type { OperationResult } from '../shared/types.js'
import { probeHydro } from './detect.js'
import { redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'
import { shellQuote } from '../ssh/shell.js'

const CANDIDATES = ['/root/.hydro/judge.yaml', '/etc/hydro/judge.yaml', '/data/judge.yaml', '/root/judge.yaml']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read the judge config and process state. */
export async function readJudgeConfig(context: AccountContext, probe?: HydroProbe): Promise<JudgeConfigResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const process = resolved.pm2.find((entry) => entry.name.toLowerCase().includes('hydrojudge'))
  const password = resolveElevationPassword(context)
  const find = CANDIDATES.map((path) => `[ -f ${shellQuote(path)} ] && echo ${shellQuote(path)}`).join('; ')
  const result = await runAsRoot(context, `${find} 2>/dev/null | head -1`, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: 15_000,
  }).catch(() => null)
  const lines = (result?.stdout ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const path = resolved.judge.configPath ?? CANDIDATES.find((candidate) => lines.includes(candidate)) ?? null
  let content = ''
  if (path !== null) {
    const read = await runAsRoot(context, `cat ${shellQuote(path)} 2>/dev/null || true`, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 15_000,
    }).catch(() => null)
    content = redactSensitive(read?.stdout ?? '')
  }
  return {
    installed: resolved.judge.installed,
    running: process?.status === 'online' || process?.status === 'running' || resolved.judge.running,
    path,
    content: tailText(content, 120_000),
    manager: resolved.serviceManager,
  }
}

/** Save judge.yaml with backup and restart the judge process. */
export async function writeJudgeConfig(
  context: AccountContext,
  input: { path: string; content: string },
  probe?: HydroProbe,
): Promise<OperationResult> {
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝修改评测机配置。' }
  const resolved = probe ?? (await probeHydro(context))
  if (!resolved.judge.installed) return { ok: false, message: '未检测到独立评测机，无法修改 judge.yaml。' }
  const allowed = input.path.endsWith('judge.yaml')
    && (CANDIDATES.includes(input.path) || input.path.startsWith('/etc/hydro/') || input.path.startsWith('/root/.hydro/'))
  if (!allowed) return { ok: false, message: '只允许写入 ~/.hydro/judge.yaml 或 /etc/hydro/judge.yaml' }
  const encoded = Buffer.from(input.content, 'utf8').toString('base64')
  const password = resolveElevationPassword(context)
  const command = [
    `mkdir -p ${shellQuote(input.path.replace(/\/[^/]+$/, ''))}`,
    `[ -f ${shellQuote(input.path)} ] && cp -f ${shellQuote(input.path)} ${shellQuote(`${input.path}.dsh-hydro.bak`)} || true`,
    `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(input.path)}`,
    'pm2 restart hydrojudge >/dev/null 2>&1 || true',
  ].join(' && ')
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 90_000,
    })
    let after: HydroProbe | null = null
    try { after = await probeHydro(context) } catch { after = null }
    const running = after?.judge.running === true
    return {
      ok: result.code === 0 && running,
      message: result.code === 0 && running
        ? '评测机配置已保存，hydrojudge 已重启'
        : '配置已写入，但评测机可能未恢复运行，请检查日志',
      log: tailText(redactSensitive(`${result.stdout}\n${result.stderr}`), 8000),
    }
  } catch (error) {
    return { ok: false, message: `评测机配置保存失败：${errorMessage(error)}` }
  }
}

/** Restart the standalone judge process. */
export async function restartJudge(context: AccountContext): Promise<OperationResult> {
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝重启评测机。' }
  const password = resolveElevationPassword(context)
  try {
    const result = await runAsRoot(context, 'pm2 restart hydrojudge', {
      ...(password === undefined ? {} : { password }),
      timeoutMs: 60_000,
    })
    return {
      ok: result.code === 0,
      message: result.code === 0 ? '已重启 hydrojudge' : '重启 hydrojudge 失败',
      log: tailText(redactSensitive(`${result.stdout}\n${result.stderr}`), 8000),
    }
  } catch (error) {
    return { ok: false, message: `重启评测机失败：${errorMessage(error)}` }
  }
}
