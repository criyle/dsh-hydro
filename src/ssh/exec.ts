/**
 * Remote command execution over an SSH session channel.
 *
 * `runExec` implements the public `SshConnection.exec` contract. The lower
 * level `openExecSession` is also used by `elevate` for the interactive `su`
 * fallback, where output has to be observed while the channel stays open.
 *
 * NOTE: channel event listeners are installed synchronously inside the
 * `client.exec` callback. ssh2 processes every SSH packet contained in one
 * socket read in the same call stack, so a fast server reply (output, exit
 * status, close) can be emitted before a promise continuation after `await`
 * would get a chance to attach listeners.
 */

import type { Client, ClientChannel } from 'ssh2'
import { SshAbortError, SshError, SshTimeoutError } from './errors.js'
import { withEnvironment } from './shell.js'
import type { ExecOptions, ExecResult } from './types.js'

/** Default per-stream output cap (4 MiB). */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** How long a command channel may take to open before it is considered failed. */
const CHANNEL_OPEN_TIMEOUT_MS = 15_000

/** State shared with a live connection. */
export interface ExecContext {
  readonly client: Client
  /** `user@host:port` label used in error messages. */
  readonly targetLabel: string
  /** Open channels, tracked so `close()` can destroy them. */
  readonly channels: Set<ClientChannel>
  isClosed(): boolean
}

/** An open command channel, used for interactive flows. */
export interface ExecSession {
  readonly channel: ClientChannel
  /** Resolves when the remote command finishes (never rejects for command exit codes). */
  readonly result: Promise<ExecResult>
  write(data: string | Buffer): void
  endInput(): void
  destroy(): void
  /**
   * Observe output as it arrives. Already-received output is replayed to the
   * listener on registration (so prompt detection cannot miss early chunks).
   * Returns an unsubscribe function.
   */
  onOutput(listener: (chunk: Buffer, stream: 'stdout' | 'stderr') => void): () => void
}

class OutputCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (this.bytes >= this.maxBytes) {
      this.truncated = true
      return
    }
    const room = this.maxBytes - this.bytes
    if (chunk.length <= room) {
      this.chunks.push(chunk)
      this.bytes += chunk.length
    } else {
      this.chunks.push(chunk.subarray(0, room))
      this.bytes = this.maxBytes
      this.truncated = true
    }
  }

  render(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    if (!this.truncated) return text
    return `${text}\n[dsh-hydro] output truncated at ${this.maxBytes} bytes\n`
  }
}

function mapChannelOpenError(error: Error, targetLabel: string): SshError {
  const message = error.message.length > 0 ? error.message : 'unknown error'
  return new SshError(`Failed to open an SSH command channel on ${targetLabel}: ${message}`, {
    cause: error,
    code: 'CHANNEL_OPEN_FAILED',
  })
}

interface SessionFactoryOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes: number
  readonly targetLabel: string
  readonly channels: Set<ClientChannel>
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

/**
 * Install all listeners for an opened channel synchronously. Must be called
 * from within the ssh2 `exec` callback.
 */
function createSession(
  channel: ClientChannel,
  options: SessionFactoryOptions,
): ExecSession {
  const { signal, timeoutMs, maxOutputBytes, targetLabel, channels, onStdout: onStdoutChunk, onStderr: onStderrChunk } = options

  channels.add(channel)

  const stdout = new OutputCollector(maxOutputBytes)
  const stderr = new OutputCollector(maxOutputBytes)
  const outputHistory: Array<{ chunk: Buffer; stream: 'stdout' | 'stderr' }> = []
  const HISTORY_LIMIT = 64 * 1024
  let historyBytes = 0
  const outputListeners = new Set<(chunk: Buffer, stream: 'stdout' | 'stderr') => void>()

  let completed = false
  let exitCode: number | null = null
  let exitSignal: string | undefined
  let timedOut = false
  let timer: NodeJS.Timeout | undefined

  let resolveResult!: (value: ExecResult) => void
  let rejectResult!: (error: Error) => void
  const result = new Promise<ExecResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    signal?.removeEventListener('abort', onAbort)
    channel.removeListener('close', onClose)
    channel.removeListener('error', onError)
    channel.removeListener('exit', onExit)
    channel.removeListener('data', onStdout)
    channel.stderr.removeListener('data', onStderr)
  }

  const notify = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    if (historyBytes < HISTORY_LIMIT) {
      outputHistory.push({ chunk, stream })
      historyBytes += chunk.length
    }
    for (const listener of outputListeners) {
      try {
        listener(chunk, stream)
      } catch {
        // Listener errors must not break output collection.
      }
    }
  }

  const finish = (): void => {
    if (completed) return
    completed = true
    cleanup()
    channels.delete(channel)
    resolveResult({
      code: exitCode,
      ...(exitSignal === undefined ? {} : { signal: exitSignal }),
      stdout: stdout.render(),
      stderr: stderr.render(),
      timedOut,
    })
  }

  const failResult = (error: Error): void => {
    if (completed) return
    completed = true
    cleanup()
    channels.delete(channel)
    rejectResult(error)
  }

  function onClose(): void {
    finish()
  }

  function onError(error: Error): void {
    failResult(
      new SshError(
        `SSH command channel to ${targetLabel} failed: ${error.message.length > 0 ? error.message : 'unknown error'}`,
        { cause: error, code: 'CHANNEL_FAILED' },
      ),
    )
  }

  function onExit(code: number | null, signalName?: string): void {
    exitCode = code ?? null
    if (typeof signalName === 'string' && signalName.length > 0) exitSignal = signalName
  }

  function onStdout(chunk: Buffer): void {
    stdout.push(chunk)
    notify(chunk, 'stdout')
    if (onStdoutChunk !== undefined) {
      try { onStdoutChunk(chunk.toString('utf8')) } catch { /* streaming listener must not break exec */ }
    }
  }

  function onStderr(chunk: Buffer): void {
    stderr.push(chunk)
    notify(chunk, 'stderr')
    if (onStderrChunk !== undefined) {
      try { onStderrChunk(chunk.toString('utf8')) } catch { /* streaming listener must not break exec */ }
    }
  }

  function onAbort(): void {
    if (completed) return
    channel.destroy()
    failResult(new SshAbortError('SSH command aborted'))
  }

  channel.on('close', onClose)
  channel.on('error', onError)
  channel.on('exit', onExit)
  channel.on('data', onStdout)
  channel.stderr.on('data', onStderr)
  signal?.addEventListener('abort', onAbort, { once: true })

  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (completed) return
      timedOut = true
      stderr.push(Buffer.from(`\n[dsh-hydro] command timed out after ${timeoutMs}ms\n`))
      channel.destroy()
      finish()
    }, timeoutMs)
  }

  if (signal?.aborted) onAbort()

  return {
    channel,
    result,
    write(data: string | Buffer): void {
      if (completed) throw new SshError('SSH command channel is already closed')
      channel.stdin.write(data)
    },
    endInput(): void {
      if (completed) return
      try {
        channel.stdin.end()
      } catch {
        // Channel already closed; nothing to do.
      }
    },
    destroy(): void {
      if (completed) return
      channel.destroy()
      finish()
    },
    onOutput(listener): () => void {
      for (const entry of outputHistory) listener(entry.chunk, entry.stream)
      outputListeners.add(listener)
      return () => {
        outputListeners.delete(listener)
      }
    },
  }
}

/**
 * Open a command channel without sending any stdin. Used by both `exec` and
 * the interactive `su` elevation fallback.
 */
export async function openExecSession(
  ctx: ExecContext,
  command: string,
  options: ExecOptions = {},
): Promise<ExecSession> {
  if (ctx.isClosed()) throw new SshError('SSH connection is closed', { code: 'CONNECTION_CLOSED' })
  const signal = options.signal
  if (signal?.aborted) throw new SshAbortError('SSH command aborted')

  const remoteCommand = withEnvironment(command, options.env)
  const usePty = options.pty === true
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isFinite(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new SshError(`Invalid maxOutputBytes: ${String(options.maxOutputBytes)}`)
  }

  return new Promise<ExecSession>((resolve, reject) => {
    let settled = false
    let aborted = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(
        new SshTimeoutError(
          `Timed out opening an SSH command channel after ${CHANNEL_OPEN_TIMEOUT_MS}ms`,
          CHANNEL_OPEN_TIMEOUT_MS,
        ),
      )
    }, CHANNEL_OPEN_TIMEOUT_MS)

    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    function onAbort(): void {
      aborted = true
      fail(new SshAbortError('SSH command aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    const onChannel = (error: Error | undefined | null, openedChannel: ClientChannel | undefined): void => {
      if (aborted) {
        openedChannel?.destroy()
        return
      }
      if (error) {
        fail(mapChannelOpenError(error, ctx.targetLabel))
        return
      }
      if (!openedChannel) {
        fail(new SshError('SSH server did not provide a command channel'))
        return
      }
      if (settled) {
        openedChannel.destroy()
        return
      }
      settled = true
      cleanup()
      try {
        // Listeners MUST be installed in this synchronous turn (see file header).
        resolve(
          createSession(openedChannel, {
            signal,
            timeoutMs: options.timeoutMs,
            maxOutputBytes,
            targetLabel: ctx.targetLabel,
            channels: ctx.channels,
            ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
            ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
          }),
        )
      } catch (sessionError) {
        openedChannel.destroy()
        reject(sessionError instanceof Error ? sessionError : new SshError(String(sessionError)))
      }
    }

    if (usePty) {
      ctx.client.exec(remoteCommand, { pty: true }, onChannel)
    } else {
      ctx.client.exec(remoteCommand, onChannel)
    }
  })
}

/** Run a command and wait for it to finish, collecting output and exit status. */
export async function runExec(
  ctx: ExecContext,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const session = await openExecSession(ctx, command, options)
  try {
    if (options.stdin !== undefined) session.write(options.stdin)
    session.endInput()
  } catch (error) {
    session.destroy()
    throw error
  }
  return session.result
}
