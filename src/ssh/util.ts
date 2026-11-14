/**
 * Small async helpers shared by the SSH modules.
 */

import { SshAbortError, SshTimeoutError } from './errors.js'

export interface RaceOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Human readable operation name used in error messages. */
  label: string
}

/**
 * Await `promise`, rejecting with {@link SshAbortError} when `signal` aborts or
 * with {@link SshTimeoutError} when `timeoutMs` elapses first.
 *
 * The underlying promise is still observed so a late rejection does not become
 * an unhandled rejection.
 */
export function withAbortAndTimeout<T>(promise: Promise<T>, options: RaceOptions): Promise<T> {
  const { signal, timeoutMs, label } = options
  if (signal?.aborted) return Promise.reject(new SshAbortError(`${label} aborted`))
  if (signal === undefined && (timeoutMs === undefined || timeoutMs <= 0)) return promise

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const onAbort = () => settle(() => reject(new SshAbortError(`${label} aborted`)))
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(
        () => settle(() => reject(new SshTimeoutError(`${label} timed out after ${timeoutMs}ms`, timeoutMs))),
        timeoutMs,
      )
    }
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    )
  })
}
