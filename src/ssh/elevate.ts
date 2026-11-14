/**
 * Root elevation over an SSH connection.
 *
 * Strategy:
 * 1. `id -u` — if already root, run the command directly.
 * 2. `command -v sudo` — if sudo exists, run `sudo -S -p '' -- sh -c <cmd>`
 *    feeding the password on stdin (`sudo -n` when no password was given).
 *    Sudo authentication failures are reported as an `ExecResult` with a
 *    marker in stderr instead of throwing (only transport failures throw).
 * 3. Otherwise fall back to `su - root` over a pty, typing the password when
 *    prompted and then the command wrapped in unique output markers.
 *
 * LIMITATIONS (deliberate):
 * - The `su` fallback opens a pty, so output is a terminal transcript: the
 *   password prompt and (`su`-provided) shell prompts are normally stripped by
 *   the marker parsing, but abnormal shells may still add noise. stderr is
 *   merged into stdout because a pty has a single stream.
 * - `su` requires a password; without one the fallback returns a failure
 *   `ExecResult` rather than blocking on an interactive prompt.
 * - Elevation does not preserve the caller's environment (sudo/su reset it).
 */

import { randomBytes } from 'node:crypto'
import { SshError } from './errors.js'
import { escapeRegExp, shellQuote } from './shell.js'
import type { ExecOptions, ExecResult } from './types.js'
import type { ExecSession } from './exec.js'

/** Default deadline for a full elevation (detection + command) unless overridden. */
const DEFAULT_ELEVATE_TIMEOUT_MS = 30_000

/** Deadline for privilege-detection commands. */
const DETECTION_TIMEOUT_MS = 10_000

/** Delay after sending the su password before sending the command. */
const SU_COMMAND_DELAY_MS = 600

/** Fallback if no password prompt is observed. */
const SU_PROMPT_FALLBACK_MS = 600

/** Hard fallback that guarantees the command is eventually sent. */
const SU_HARD_FALLBACK_MS = 3_000

const SUDO_AUTH_FAILURE_RE =
  /incorrect password|sorry, try again|not in the sudoers file|a password is required|no tty present|must have a tty|no password was provided|is not allowed to execute/i

const PASSWORD_PROMPT_RE = /(?:password|passphrase|密码)\s*[:：]?\s*$/i
const SHELL_PROMPT_RE = /[#$%>]\s*$/

/** Host interface required for elevation. */
export interface ElevationHost {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  openExecSession(command: string, options?: ExecOptions): Promise<ExecSession>
  isClosed(): boolean
}

export interface ElevateOptions {
  password?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Observe the elevated command's stdout as it arrives. */
  onStdout?: (chunk: string) => void
  /** Observe the elevated command's stderr as it arrives. */
  onStderr?: (chunk: string) => void
}

function failureResult(message: string, timedOut = false): ExecResult {
  return { code: null, stdout: '', stderr: `[dsh-hydro] ${message}\n`, timedOut }
}

function withMarker(result: ExecResult, marker: string): ExecResult {
  const trimmed = result.stderr.replace(/\s+$/, '')
  return {
    ...result,
    stderr: `${trimmed.length > 0 ? `${trimmed}\n` : ''}[dsh-hydro] ${marker}\n`,
  }
}

async function elevateWithSudo(
  host: ElevationHost,
  command: string,
  options: ElevateOptions,
  timeoutMs: number,
): Promise<ExecResult> {
  const quotedCommand = shellQuote(command)
  const password = options.password
  const sudoCommand =
    password === undefined
      ? `sudo -n -- sh -c ${quotedCommand}`
      : `sudo -S -p '' -- sh -c ${quotedCommand}`

  const result = await host.exec(sudoCommand, {
    ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    ...(password === undefined ? {} : { stdin: `${password}\n` }),
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  if (SUDO_AUTH_FAILURE_RE.test(result.stderr)) {
    return withMarker(
      result,
      'sudo authentication failed: the provided password may be wrong or the user lacks sudo privileges',
    )
  }
  return result
}

function parseSuResult(result: ExecResult, startMarker: string, endMarker: string): ExecResult {
  const combined = `${result.stdout}${result.stderr}`

  const endPattern = new RegExp(`${escapeRegExp(endMarker)}(\\d+)`, 'g')
  let lastMatch: RegExpExecArray | null = null
  for (let match = endPattern.exec(combined); match !== null; match = endPattern.exec(combined)) {
    lastMatch = match
  }

  if (lastMatch === null) {
    const text = combined.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    const authFailed = /(?:su: )?(?:authentication failure|incorrect password)|permission denied/i.test(text)
    const marker = authFailed
      ? 'su authentication failed: check the provided root password'
      : 'su elevation failed: could not capture the command result (su may be unavailable, or the password was rejected)'
    return {
      code: null,
      stdout: '',
      stderr: `${text.length > 0 ? `${text}\n` : ''}[dsh-hydro] ${marker}\n`,
      timedOut: result.timedOut,
    }
  }

  const exitCode = Number.parseInt(lastMatch[1] as string, 10)
  const startIndex = combined.lastIndexOf(startMarker)
  let output =
    startIndex >= 0 && startIndex < lastMatch.index
      ? combined.slice(startIndex + startMarker.length, lastMatch.index)
      : combined.slice(0, lastMatch.index)
  output = output
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '')

  return {
    code: Number.isFinite(exitCode) ? exitCode : null,
    stdout: output,
    stderr: '',
    timedOut: result.timedOut,
  }
}

async function elevateWithSu(
  host: ElevationHost,
  command: string,
  options: ElevateOptions,
  timeoutMs: number,
): Promise<ExecResult> {
  const password = options.password
  if (password === undefined) {
    return failureResult(
      'su fallback requires a password, but none was provided; refusing to block on an interactive prompt',
    )
  }

  const token = randomBytes(8).toString('hex')
  const startMarker = `__DSH_HYDRO_SU_START_${token}__`
  const endMarker = `__DSH_HYDRO_SU_END_${token}__`

  const session = await host.openExecSession('su - root', {
    pty: true,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  let passwordSent = false
  let commandSent = false
  let unsubscribe: (() => void) | undefined
  const timers: NodeJS.Timeout[] = []

  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer)
    timers.length = 0
  }

  const sendCommand = (): void => {
    if (commandSent || !passwordSent) return
    commandSent = true
    clearTimers()
    unsubscribe?.()
    const line = `printf ${shellQuote(startMarker)}; ${command}; __dsh_rc=$?; printf '\\n${endMarker}%s\\n' "$__dsh_rc"; exit`
    try {
      session.write(`${line}\n`)
    } catch {
      // The channel may already be gone; the result promise settles then.
    }
  }

  const sendPassword = (): void => {
    if (passwordSent || commandSent) return
    passwordSent = true
    try {
      session.write(`${password}\n`)
    } catch {
      return
    }
    timers.push(setTimeout(sendCommand, SU_COMMAND_DELAY_MS))
  }

  unsubscribe = session.onOutput((chunk) => {
    const text = chunk.toString('utf8')
    if (!passwordSent) {
      if (PASSWORD_PROMPT_RE.test(text)) sendPassword()
      return
    }
    if (!commandSent && SHELL_PROMPT_RE.test(text)) sendCommand()
  })

  timers.push(
    setTimeout(() => {
      if (!passwordSent) sendPassword()
    }, SU_PROMPT_FALLBACK_MS),
  )
  timers.push(
    setTimeout(() => {
      if (!passwordSent) sendPassword()
      else if (!commandSent) sendCommand()
    }, SU_HARD_FALLBACK_MS),
  )

  let result: ExecResult
  try {
    result = await session.result
  } finally {
    unsubscribe()
    clearTimers()
  }

  return parseSuResult(result, startMarker, endMarker)
}

/**
 * Run `command` as root through `host`.
 *
 * Returns an `ExecResult` for command failures (including sudo/su
 * authentication failures, marked in stderr). Only transport failures
 * (connection/abort) reject.
 */
export async function elevateCommand(
  host: ElevationHost,
  command: string,
  options: ElevateOptions = {},
): Promise<ExecResult> {
  if (host.isClosed()) {
    throw new SshError('SSH connection is closed', { code: 'CONNECTION_CLOSED' })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_ELEVATE_TIMEOUT_MS
  const signal = options.signal

  const probe = await host.exec('id -u', {
    timeoutMs: Math.min(timeoutMs, DETECTION_TIMEOUT_MS),
    ...(signal === undefined ? {} : { signal }),
  })
  if (probe.timedOut) {
    return failureResult('elevation failed: timed out while detecting the current user', true)
  }
  if (probe.code !== 0) {
    return failureResult(
      `elevation failed: could not detect the current user (id -u exited with ${String(probe.code)})`,
      probe.timedOut,
    )
  }
  if (probe.stdout.trim() === '0') {
    // Already root: run the command directly.
    return host.exec(command, {
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  const sudoProbe = await host.exec('command -v sudo', {
    timeoutMs: Math.min(timeoutMs, DETECTION_TIMEOUT_MS),
    ...(signal === undefined ? {} : { signal }),
  })
  if (sudoProbe.timedOut) {
    return failureResult('elevation failed: timed out while looking for sudo', true)
  }
  const sudoPath = sudoProbe.code === 0 ? (sudoProbe.stdout.split('\n')[0] ?? '').trim() : ''
  if (sudoPath.length > 0) return elevateWithSudo(host, command, options, timeoutMs)
  return elevateWithSu(host, command, options, timeoutMs)
}
