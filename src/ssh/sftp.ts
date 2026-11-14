/**
 * SFTP-backed file operations (read, write, mkdir -p, stat).
 *
 * A single SFTP session is opened lazily per SSH connection and shared by all
 * operations. Every operation is bounded by a timeout and can be aborted.
 */

import type { SFTPWrapper, Stats } from 'ssh2'
import { SshError } from './errors.js'
import type { RemoteStat } from './types.js'
import { withAbortAndTimeout } from './util.js'

/** Default timeout for a single SFTP request. */
const SFTP_TIMEOUT_MS = 30_000

/** Default upper bound for {@link readRemoteFile} when the caller does not set one. */
export const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024

/** Default mode used by {@link writeRemoteFile}. */
const DEFAULT_FILE_MODE = 0o644

/** Default mode used by {@link mkdirpRemote}. */
const DEFAULT_DIR_MODE = 0o755

/** Host interface required by the SFTP helpers. */
export interface SftpHost {
  readonly targetLabel: string
  getSftp(signal?: AbortSignal): Promise<SFTPWrapper>
  isClosed(): boolean
}

type SftpCallback<T> = (error: Error | undefined | null, value?: T) => void

function errorCode(error: Error & { code?: number | string }): number | undefined {
  return typeof error.code === 'number' ? error.code : undefined
}

function mapSftpError(error: Error & { code?: number | string }, label: string): SshError {
  const code = errorCode(error)
  const suffix =
    code === 2
      ? ' (no such file or directory)'
      : code === 3
        ? ' (permission denied)'
        : code === 8
          ? ' (operation unsupported)'
          : ''
  return new SshError(`SFTP ${label} failed: ${error.message}${suffix}`, {
    cause: error,
    code: code === undefined ? 'SFTP_FAILED' : `SFTP_${code}`,
  })
}

async function callSftp<T>(
  host: SftpHost,
  signal: AbortSignal | undefined,
  label: string,
  invoke: (sftp: SFTPWrapper, done: SftpCallback<T>) => void,
): Promise<T> {
  if (host.isClosed()) throw new SshError('SSH connection is closed', { code: 'CONNECTION_CLOSED' })
  const sftp = await host.getSftp(signal)
  const pending = new Promise<T>((resolve, reject) => {
    invoke(sftp, (error, value) => {
      if (error) reject(mapSftpError(error, label))
      else resolve(value as T)
    })
  })
  return withAbortAndTimeout(pending, { signal, timeoutMs: SFTP_TIMEOUT_MS, label: `SFTP ${label}` })
}

/** Stat a remote path; missing paths return `{ exists: false }` instead of throwing. */
export async function statRemote(
  host: SftpHost,
  remotePath: string,
  signal?: AbortSignal,
): Promise<RemoteStat> {
  try {
    const stats: Stats = await callSftp(host, signal, `stat ${remotePath}`, (sftp, done) => {
      sftp.stat(remotePath, done)
    })
    return {
      exists: true,
      isDirectory: stats.isDirectory(),
      size: typeof stats.size === 'number' ? stats.size : 0,
      mode: typeof stats.mode === 'number' ? stats.mode : 0,
    }
  } catch (error) {
    if (error instanceof SshError && error.code === 'SFTP_2') {
      return { exists: false, isDirectory: false, size: 0, mode: 0 }
    }
    throw error
  }
}

/** Read a remote file into memory, enforcing `maxBytes`. */
export async function readRemoteFile(
  host: SftpHost,
  remotePath: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new SshError(`Invalid maxBytes: ${String(options.maxBytes)}`)
  }

  const stats = await statRemote(host, remotePath, options.signal)
  if (!stats.exists) throw new SshError(`Remote file not found: ${remotePath}`, { code: 'NO_SUCH_FILE' })
  if (stats.isDirectory) throw new SshError(`Remote path is a directory, not a file: ${remotePath}`, { code: 'IS_DIRECTORY' })
  if (stats.size > maxBytes) {
    throw new SshError(
      `Remote file ${remotePath} is ${stats.size} bytes, which exceeds the maxBytes limit of ${maxBytes}`,
      { code: 'FILE_TOO_LARGE' },
    )
  }

  const data = await callSftp<Buffer>(host, options.signal, `readFile ${remotePath}`, (sftp, done) => {
    sftp.readFile(remotePath, done)
  })
  if (data.length > maxBytes) {
    throw new SshError(
      `Remote file ${remotePath} grew to ${data.length} bytes while reading, exceeding the maxBytes limit of ${maxBytes}`,
      { code: 'FILE_TOO_LARGE' },
    )
  }
  return data
}

/** Write a remote file (truncating it), applying `mode` on creation. */
export async function writeRemoteFile(
  host: SftpHost,
  remotePath: string,
  data: string | Buffer,
  options: { mode?: number; signal?: AbortSignal } = {},
): Promise<void> {
  await callSftp<void>(host, options.signal, `writeFile ${remotePath}`, (sftp, done) => {
    sftp.writeFile(remotePath, data, { mode: options.mode ?? DEFAULT_FILE_MODE }, done)
  })
}

/** Strip trailing slashes, preserving `/`. */
function trimTrailingSlashes(remotePath: string): string {
  if (remotePath === '/') return remotePath
  let result = remotePath
  while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  return result
}

/** POSIX dirname (remote paths are always POSIX). */
function parentDirectory(remotePath: string): string {
  const trimmed = trimTrailingSlashes(remotePath)
  const index = trimmed.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return trimmed.slice(0, index)
}

/** Recursively create `remotePath` (like `mkdir -p`). */
export async function mkdirpRemote(
  host: SftpHost,
  remotePath: string,
  options: { mode?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const target = trimTrailingSlashes(remotePath)
  if (target === '' || target === '.' || target === '/') return

  const missing: string[] = []
  let current = target
  while (current !== '' && current !== '.' && current !== '/') {
    const stats = await statRemote(host, current, options.signal)
    if (stats.exists) {
      if (!stats.isDirectory) {
        throw new SshError(`Remote path exists and is not a directory: ${current}`, { code: 'NOT_A_DIRECTORY' })
      }
      break
    }
    missing.push(current)
    const parent = parentDirectory(current)
    if (parent === current) break
    current = parent
  }

  for (const directory of missing.reverse()) {
    if (host.isClosed()) throw new SshError('SSH connection is closed', { code: 'CONNECTION_CLOSED' })
    await callSftp<void>(host, options.signal, `mkdir ${directory}`, (sftp, done) => {
      sftp.mkdir(directory, { mode: options.mode ?? DEFAULT_DIR_MODE }, done)
    })
  }
}
