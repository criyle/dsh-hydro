/**
 * Error types used by the SSH transport layer.
 *
 * Error messages are intentionally free of secrets: passwords, passphrases and
 * private keys never appear in an `SshError` message.
 */

import type { SshTarget } from './types.js'

export interface SshErrorOptions {
  /** Original error, kept as `cause` for debugging (never stringified into messages). */
  cause?: unknown
  /** Short machine-readable code, e.g. `'ECONNREFUSED'` or `'AUTH_FAILED'`. */
  code?: string
}

/** Base class for all transport failures emitted by this module. */
export class SshError extends Error {
  override readonly name: string = 'SshError'
  readonly code?: string

  constructor(message: string, options: SshErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SshError'
    if (options.code !== undefined) this.code = options.code
  }
}

/** The operation exceeded its configured deadline. */
export class SshTimeoutError extends SshError {
  override readonly name: string = 'SshTimeoutError'
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number, options: SshErrorOptions = {}) {
    super(message, options)
    this.name = 'SshTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** The operation was aborted through an {@link AbortSignal}. */
export class SshAbortError extends SshError {
  override readonly name: string = 'AbortError'

  constructor(message = 'SSH operation aborted', options: SshErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'ABORT_ERR' })
    this.name = 'AbortError'
  }
}

/** Human readable `user@host:port` label, safe to put in error messages. */
export function describeTarget(target: SshTarget): string {
  return `${target.username}@${target.host}:${target.port ?? 22}`
}

/** Returns `true` when `error` is an abort error (ours or a `DOMException`). */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof SshAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

/** Throw an {@link SshAbortError} if `signal` has already been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw new SshAbortError(`${label} aborted`)
}
