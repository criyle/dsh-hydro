/**
 * Small remote-execution helpers shared by Hydro operation modules.
 *
 * Every helper works on an {@link AccountContext}, honors its cancellation
 * signal, and truncates captured output so one noisy command cannot exhaust
 * memory or flood the model.
 */
import type { ExecOptions, ExecResult } from '../ssh/index.js'
import type { AccountContext } from './types.js'

/** Default cap for command output kept in memory. */
export const OUTPUT_LIMIT = 256 * 1024

/**
 * PATH bootstrap for every remote command.
 *
 * The official Hydro installer puts Node, yarn, pm2, hydrooj, mongod, caddy and
 * go-judge into the root nix profile (`/root/.nix-profile/bin`). Non-interactive
 * SSH commands (`sh -c ...`, `sudo sh -c ...`) do not source profile files, so
 * without this prefix a perfectly healthy install looks "not installed" and
 * `hydrooj cli` / `pm2` fail with "command not found".
 */
export const REMOTE_PATH_PREFIX =
  'export PATH="$HOME/.nix-profile/bin:/root/.nix-profile/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"'

/** Prepend the remote PATH bootstrap unless the command already carries it. */
export function withRemotePath(command: string): string {
  if (command.includes(REMOTE_PATH_PREFIX)) return command
  return `${REMOTE_PATH_PREFIX}; ${command}`
}

export class RemoteCommandError extends Error {
  constructor(
    readonly command: string,
    readonly result: ExecResult,
  ) {
    super(`远端命令失败（exit ${String(result.code)}）：${(result.stderr || result.stdout).trim().slice(0, 2000) || '(no output)'}`)
    this.name = 'RemoteCommandError'
  }
}

/** Truncate long text with an explicit marker. */
export function truncate(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[truncated ${String(text.length - limit)} chars]`
}

/** Run a command and return its raw result (never throws for nonzero exits). */
export async function run(
  context: AccountContext,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const effective = withRemotePath(command)
  context.log(`$ ${effective.length > 400 ? `${effective.slice(0, 400)}…` : effective}`)
  const result = await context.connection.exec(effective, {
    timeoutMs: context.config.commandTimeoutMs,
    maxOutputBytes: OUTPUT_LIMIT,
    ...options,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  return {
    ...result,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  }
}

/** Run a command and throw {@link RemoteCommandError} on a nonzero exit. */
export async function runChecked(
  context: AccountContext,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const result = await run(context, command, options)
  if (result.code !== 0) throw new RemoteCommandError(command, result)
  return result
}



/** Quote a path for a POSIX shell (only single quotes need escaping). */
export function shellPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}
