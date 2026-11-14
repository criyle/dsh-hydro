/**
 * Hydro CLI console and backup listing.
 *
 * The UI exposes a terminal-like console for `hydrooj <command>` only (backup,
 * restore, system settings, etc.); arbitrary shell access stays behind the
 * existing `hydro_exec` opt-in. Commands that restore or delete require an
 * explicit confirmation flag.
 */
import type { AccountContext } from '../ops/types.js'
import type { BackupsResponse } from '../shared/api.js'
import { redactSensitive, resolveElevationPassword, runAsRoot, tailText, type OutputSink } from './remote.js'
import { shellQuote } from '../ssh/shell.js'

const CLI_TIMEOUT_MS = 20 * 60_000
const FORBIDDEN = /[;&|`$<>\n\r]/

/** Validate a Hydro CLI argument string (no shell metacharacters). */
export function validateCliCommand(command: string): string {
  const trimmed = command.trim().replace(/^hydrooj\s+/, '')
  if (trimmed === '') throw new Error('请输入要执行的 hydrooj 命令')
  if (FORBIDDEN.test(trimmed)) throw new Error('CLI 参数不能包含 shell 控制字符（; & | ` $ < > 换行）')
  return trimmed
}

/** Run one `hydrooj <command>` with cwd /data and live output. */
function redactedSink(onOutput?: OutputSink): OutputSink | undefined {
  if (onOutput === undefined) return undefined
  return (chunk) => { onOutput({ stream: chunk.stream, text: redactSensitive(chunk.text) }) }
}

export async function runHydroCli(
  context: AccountContext,
  command: string,
  onOutput?: OutputSink,
): Promise<{ exitCode: number | null; output: string }> {
  const sink = redactedSink(onOutput)
  if (context.readonly) throw new Error('全局只读已开启，拒绝执行 Hydro CLI 命令')
  const args = validateCliCommand(command)
  if (/^restore\b/i.test(args)) {
    throw new Error('restore 必须通过备份页面确认后执行')
  }
  const password = resolveElevationPassword(context)
  const remote = `cd /data && PATH=/usr/local/bin:/root/.nix-profile/bin:$PATH hydrooj ${args}`
  const result = await runAsRoot(context, remote, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: CLI_TIMEOUT_MS,
    ...(sink === undefined ? {} : { onOutput: sink }),
  })
  const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
  return { exitCode: result.code, output: tailText(output, 200_000) }
}

/** Restore one backup archive (explicit confirmation already handled by route). */
export async function restoreBackup(
  context: AccountContext,
  filename: string,
  onOutput?: OutputSink,
): Promise<{ exitCode: number | null; output: string }> {
  const sink = redactedSink(onOutput)
  if (context.readonly) throw new Error('全局只读已开启，拒绝恢复备份')
  const safe = filename.trim()
  if (!/^[A-Za-z0-9._-]+$/.test(safe) || !safe.endsWith('.zip')) throw new Error('备份文件名不合法')
  const password = resolveElevationPassword(context)
  const remote = `cd /data && PATH=/usr/local/bin:/root/.nix-profile/bin:$PATH hydrooj restore /data/${shellQuote(safe)} -y`
  const result = await runAsRoot(context, remote, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: CLI_TIMEOUT_MS,
    ...(sink === undefined ? {} : { onOutput: sink }),
  })
  const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
  return { exitCode: result.code, output: tailText(output, 200_000) }
}

/** List `/data/backup-*.zip` files. */
export async function listBackups(context: AccountContext): Promise<BackupsResponse> {
  const password = resolveElevationPassword(context)
  const command = `ls -l --time-style=long-iso /data/backup-*.zip 2>/dev/null || true`
  const result = await runAsRoot(context, command, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: 20_000,
  })
  const backups = result.stdout.split('\n').flatMap((line) => {
    const match = /^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+\.zip)$/.exec(line.trim())
    if (match === null) return []
    return [{
      name: match[4]!.split('/').pop() ?? match[4]!,
      path: match[4]!,
      sizeBytes: Number(match[2]),
      modifiedAt: match[3]!,
    }]
  }).sort((a, b) => (a.modifiedAt ?? '').localeCompare(b.modifiedAt ?? '')).reverse()
  return { backups }
}

/** Run the official read-only `hydrooj diagnosis` script and capture its output. */
export async function runHydroDiagnosis(context: AccountContext): Promise<{ ok: boolean; message: string; log: string }> {
  const password = resolveElevationPassword(context)
  const remote = 'cd /data && PATH=/usr/local/bin:/root/.nix-profile/bin:$PATH NO_COLOR=1 hydrooj diagnosis'
  const result = await runAsRoot(context, remote, {
    ...(password === undefined ? {} : { password }),
    timeoutMs: 120_000,
  })
  const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
  return {
    ok: result.code === 0,
    message: result.code === 0 ? 'Hydro 官方诊断完成' : `Hydro 诊断退出码 ${String(result.code)}`,
    log: tailText(output, 30_000),
  }
}
