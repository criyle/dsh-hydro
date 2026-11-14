/**
 * Recent pm2 process log tails for the visual service monitor.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { ProcessLogsResponse } from '../shared/api.js'
import { redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'
import { probeHydro } from './detect.js'
import { shellQuote } from '../ssh/shell.js'

const MAX_LINES = 500
const DEFAULT_LINES = 200
const MAX_BYTES = 80_000

/** Default root pm2 log path for a process name. */
function fallbackPath(processName: string, kind: 'out' | 'err'): string {
  return `/root/.pm2/logs/${processName}-${kind}.log`
}

/**
 * Read the last N lines of one process's pm2 stdout/stderr logs.
 * @param context - remote account context.
 * @param input - process name and line count.
 * @param probe - reuse an existing probe when available.
 */
export async function readProcessLogs(
  context: AccountContext,
  input: { process: string; lines?: number },
  probe?: HydroProbe,
): Promise<ProcessLogsResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const processName = input.process.trim()
  const lines = Math.min(Math.max(input.lines ?? DEFAULT_LINES, 1), MAX_LINES)
  const entry = resolved.pm2.find((process) => process.name === processName)
  if (entry === undefined) throw new Error(`未找到进程 ${processName}`)
  const outPath = entry.outLogPath ?? fallbackPath(processName, 'out')
  const errPath = entry.errLogPath ?? fallbackPath(processName, 'err')
  const command = [
    `printf '\\n===== stdout =====\\n'`,
    `tail -n ${String(lines)} ${shellQuote(outPath)} 2>&1 || true`,
    `printf '\\n===== stderr =====\\n'`,
    `tail -n ${String(lines)} ${shellQuote(errPath)} 2>&1 || true`,
  ].join('; ')
  const result = await runAsRoot(context, command, {
    ...(resolveElevationPassword(context) === undefined ? {} : { password: resolveElevationPassword(context) }),
    timeoutMs: 20_000,
  })
  const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
  const marker = output.indexOf('===== stderr =====')
  const stdout = (marker === -1 ? output : output.slice(0, marker)).replace(/^\s*===== stdout =====\s*/, '')
  const stderr = marker === -1 ? '' : output.slice(marker + '===== stderr ====='.length)
  const truncated = stdout.length > MAX_BYTES || stderr.length > MAX_BYTES
  return {
    process: processName,
    manager: resolved.serviceManager === 'systemd' ? 'systemd' : resolved.serviceManager === 'manual' ? 'manual' : 'pm2',
    stdout: tailText(stdout, MAX_BYTES).trimEnd(),
    stderr: tailText(stderr, MAX_BYTES).trimEnd(),
    truncated,
  }
}
