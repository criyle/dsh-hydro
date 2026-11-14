/**
 * SSH connection management for the dsh-hydro plugin.
 *
 * Public entry points: {@link connectSsh} and {@link generateKeyPair} (see
 * `./keys.ts`). The rest of the plugin should depend on the
 * {@link SshConnection} interface only.
 */

import ssh2 from 'ssh2'
import type { Client as Ssh2Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { SshAbortError, SshError, SshTimeoutError, describeTarget } from './errors.js'
import { openExecSession, runExec, type ExecContext, type ExecSession } from './exec.js'
import { elevateCommand, type ElevationHost } from './elevate.js'
import { forwardLocalToRemote, type ForwardLocalToRemoteOptions } from './forward.js'
import { checkHostKey, resolveKnownHostsPath } from './known-hosts.js'
import {
  mkdirpRemote,
  readRemoteFile,
  statRemote,
  writeRemoteFile,
  type SftpHost,
} from './sftp.js'
import type {
  ExecOptions,
  ExecResult,
  LocalForward,
  RemoteStat,
  SshConnectOptions,
  SshConnection,
  SshTarget,
} from './types.js'
import { withAbortAndTimeout } from './util.js'

/** Default overall connect (TCP + handshake + auth) timeout. */
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000

/** How long starting an SFTP session may take. */
const SFTP_START_TIMEOUT_MS = 15_000

type ConnectionState = 'open' | 'closing' | 'closed'

function normalizeTarget(target: SshTarget): SshTarget {
  if (typeof target.host !== 'string' || target.host.length === 0) {
    throw new SshError('SSH target host is required')
  }
  if (typeof target.username !== 'string' || target.username.length === 0) {
    throw new SshError('SSH target username is required')
  }
  if (target.port !== undefined && (!Number.isInteger(target.port) || target.port <= 0 || target.port > 65535)) {
    throw new SshError(`Invalid SSH target port: ${String(target.port)}`)
  }
  return target.port === undefined
    ? { host: target.host, username: target.username }
    : { host: target.host, username: target.username, port: target.port }
}

/** Translate ssh2 errors into safe, typed errors (never containing credentials). */
function mapConnectError(
  error: Error & { code?: string },
  targetLabel: string,
  hostKeyFailure: string | undefined,
): SshError {
  if (hostKeyFailure !== undefined) {
    return new SshError(`Host key verification failed for ${targetLabel}: ${hostKeyFailure}`, {
      cause: error,
      code: 'HOST_KEY_VERIFICATION_FAILED',
    })
  }
  const message = error.message.length > 0 ? error.message : 'unknown error'
  if (/all configured authentication methods failed/i.test(message)) {
    return new SshError(
      `SSH authentication failed for ${targetLabel}: the server rejected the supplied credentials`,
      { cause: error, code: 'AUTH_FAILED' },
    )
  }
  if (/cannot parse privatekey|no start line|bad passphrase|unsupported key format|error:0/i.test(message)) {
    return new SshError(
      `SSH private key could not be used for ${targetLabel}: ${message}`,
      { cause: error, code: 'BAD_PRIVATE_KEY' },
    )
  }
  const code = typeof error.code === 'string' ? error.code : 'CONNECT_FAILED'
  return new SshError(`SSH connection to ${targetLabel} failed: ${message}`, { cause: error, code })
}

/**
 * Open an SSH connection.
 *
 * Host keys are verified according to `hostKeyPolicy` (default `accept-new`,
 * i.e. trust on first use with the entry persisted in `knownHostsPath`).
 */
export function connectSsh(options: SshConnectOptions): Promise<SshConnection> {
  const target = normalizeTarget(options.target)
  const targetLabel = describeTarget(target)
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new SshError(`Invalid SSH connect timeout: ${String(options.timeoutMs)}`))
  }
  const hostKeyPolicy = options.hostKeyPolicy ?? 'accept-new'
  const knownHostsPath = hostKeyPolicy === 'off' ? undefined : resolveKnownHostsPath(options.knownHostsPath)

  if (options.signal?.aborted) {
    return Promise.reject(new SshAbortError(`SSH connection to ${targetLabel} aborted`))
  }

  const client = new ssh2.Client()
  let hostKeyFailure: string | undefined

  return new Promise<SshConnection>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      options.signal?.removeEventListener('abort', onAbort)
      client.removeListener('error', onError)
      client.removeListener('ready', onReady)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      // ssh2 may emit more errors while the socket is being torn down.
      client.on('error', () => {})
      client.destroy()
      reject(error)
    }

    const onAbort = (): void => fail(new SshAbortError(`SSH connection to ${targetLabel} aborted`))

    const onError = (error: Error & { code?: string }): void => {
      fail(mapConnectError(error, targetLabel, hostKeyFailure))
    }

    const onReady = (): void => {
      if (settled) return
      settled = true
      cleanup()
      try {
        resolve(new SshConnectionImpl(client, target))
      } catch (error) {
        client.on('error', () => {})
        client.destroy()
        reject(error instanceof Error ? error : new SshError(String(error)))
      }
    }

    timer = setTimeout(() => {
      fail(new SshTimeoutError(`SSH connection to ${targetLabel} timed out after ${timeoutMs}ms`, timeoutMs))
    }, timeoutMs)
    timer.unref?.()

    options.signal?.addEventListener('abort', onAbort, { once: true })
    client.once('error', onError)
    client.once('ready', onReady)

    const config: ConnectConfig = {
      host: target.host,
      port: target.port ?? 22,
      username: target.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: options.keepaliveMs !== undefined && options.keepaliveMs > 0 ? options.keepaliveMs : 0,
      keepaliveCountMax: 3,
    }
    if (options.auth.kind === 'privateKey') {
      config.privateKey = options.auth.privateKey
      if (options.auth.passphrase !== undefined) config.passphrase = options.auth.passphrase
    } else {
      config.password = options.auth.password
    }
    if (hostKeyPolicy !== 'off' && knownHostsPath !== undefined) {
      const policy = hostKeyPolicy
      const path = knownHostsPath
      config.hostVerifier = (key: Buffer): boolean => {
        try {
          const result = checkHostKey(key, target, { policy, knownHostsPath: path })
          if (!result.ok) {
            hostKeyFailure = result.reason ?? 'host key verification failed'
            return false
          }
          return true
        } catch (error) {
          hostKeyFailure = `host key verification error: ${error instanceof Error ? error.message : String(error)}`
          return false
        }
      }
    }

    try {
      client.connect(config)
    } catch (error) {
      fail(error instanceof Error ? error : new SshError(String(error)))
    }
  })
}

/** Concrete {@link SshConnection} backed by an ssh2 `Client`. */
class SshConnectionImpl implements SshConnection {
  readonly target: SshTarget

  private readonly client: Ssh2Client
  private readonly targetLabel: string
  private readonly channels = new Set<ClientChannel>()
  private readonly forwards = new Set<LocalForward>()
  private readonly execContext: ExecContext
  private readonly sftpHost: SftpHost
  private state: ConnectionState = 'open'
  private closePromise: Promise<void> | undefined
  private sftpPromise: Promise<SFTPWrapper> | undefined
  private lastError: Error | undefined

  constructor(client: Ssh2Client, target: SshTarget) {
    this.client = client
    this.target = target
    this.targetLabel = describeTarget(target)
    this.execContext = {
      client,
      targetLabel: this.targetLabel,
      channels: this.channels,
      isClosed: () => this.closed,
    }
    this.sftpHost = {
      targetLabel: this.targetLabel,
      getSftp: (signal) => this.getSftp(signal),
      isClosed: () => this.closed,
    }

    client.on('error', (error: Error) => {
      this.lastError = error
      this.handleClientClosed()
    })
    client.on('end', () => this.handleClientClosed())
    client.on('close', () => this.handleClientClosed())
  }

  get closed(): boolean {
    return this.state !== 'open'
  }

  /** The last transport error observed after the connection became ready (debug aid). */
  get lastTransportError(): Error | undefined {
    return this.lastError
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    try {
      this.assertOpen('exec')
    } catch (error) {
      return Promise.reject(error)
    }
    return runExec(this.execContext, command, options)
  }

  /**
   * Internal helper used by {@link elevate}; not part of the public
   * {@link SshConnection} contract.
   */
  openExecSession(command: string, options: ExecOptions = {}): Promise<ExecSession> {
    try {
      this.assertOpen('exec')
    } catch (error) {
      return Promise.reject(error)
    }
    return openExecSession(this.execContext, command, options)
  }

  readFile(
    remotePath: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    return readRemoteFile(this.sftpHost, remotePath, options)
  }

  writeFile(
    remotePath: string,
    data: string | Buffer,
    options: { mode?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    return writeRemoteFile(this.sftpHost, remotePath, data, options)
  }

  mkdirp(remotePath: string, options: { mode?: number; signal?: AbortSignal } = {}): Promise<void> {
    return mkdirpRemote(this.sftpHost, remotePath, options)
  }

  stat(remotePath: string, signal?: AbortSignal): Promise<RemoteStat> {
    return statRemote(this.sftpHost, remotePath, signal)
  }

  elevate(
    command: string,
    options: { password?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    const host: ElevationHost = {
      exec: (cmd, execOptions) => this.exec(cmd, execOptions),
      openExecSession: (cmd, execOptions) => this.openExecSession(cmd, execOptions),
      isClosed: () => this.closed,
    }
    return elevateCommand(host, command, options)
  }

  async forwardLocalToRemote(options: ForwardLocalToRemoteOptions): Promise<LocalForward> {
    this.assertOpen('forward a local port')
    const forward = await forwardLocalToRemote(this.client, options)
    if (this.state !== 'open') {
      await forward.close()
      throw new SshError(`Cannot forward a local port: SSH connection to ${this.targetLabel} is closed`, {
        code: 'CONNECTION_CLOSED',
      })
    }
    this.forwards.add(forward)
    return forward
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) this.closePromise = this.doClose()
    return this.closePromise
  }

  private assertOpen(action: string): void {
    if (this.state === 'open') return
    throw new SshError(
      `Cannot ${action}: SSH connection to ${this.targetLabel} is ${this.state === 'closing' ? 'closing' : 'closed'}`,
      { code: 'CONNECTION_CLOSED' },
    )
  }

  private getSftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    if (this.state !== 'open') {
      return Promise.reject(
        new SshError(`Cannot start an SFTP session: SSH connection to ${this.targetLabel} is closed`, {
          code: 'CONNECTION_CLOSED',
        }),
      )
    }
    if (this.sftpPromise === undefined) {
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((error, sftp) => {
          if (error) {
            reject(
              new SshError(
                `Failed to start an SFTP session on ${this.targetLabel}: ${error.message.length > 0 ? error.message : 'unknown error'}`,
                { cause: error, code: 'SFTP_START_FAILED' },
              ),
            )
            return
          }
          resolve(sftp)
        })
      })
      this.sftpPromise.catch(() => {
        // Allow a retry after a failed SFTP start.
        this.sftpPromise = undefined
      })
    }
    return withAbortAndTimeout(this.sftpPromise, {
      signal,
      timeoutMs: SFTP_START_TIMEOUT_MS,
      label: `SFTP session on ${this.targetLabel}`,
    })
  }

  private disposeSftp(): void {
    const pending = this.sftpPromise
    this.sftpPromise = undefined
    if (pending === undefined) return
    void pending.then(
      (sftp) => {
        try {
          sftp.end()
        } catch {
          try {
            sftp.destroy()
          } catch {
            // Ignore: connection is being torn down.
          }
        }
      },
      () => {
        // SFTP never started; nothing to dispose.
      },
    )
  }

  private handleClientClosed(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    for (const channel of [...this.channels]) {
      try {
        channel.destroy()
      } catch {
        // Ignore channel teardown failures.
      }
    }
    this.channels.clear()
    const forwards = [...this.forwards]
    this.forwards.clear()
    for (const forward of forwards) {
      void forward.close().catch(() => {
        // Ignore forward teardown failures.
      })
    }
    this.disposeSftp()
  }

  private async doClose(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closing'

    for (const channel of [...this.channels]) {
      try {
        channel.destroy()
      } catch {
        // Ignore channel teardown failures.
      }
    }
    this.channels.clear()

    const forwards = [...this.forwards]
    this.forwards.clear()
    await Promise.allSettled(forwards.map((forward) => forward.close()))
    this.disposeSftp()

    await new Promise<void>((resolve) => {
      if (this.state === 'closed') {
        resolve()
        return
      }
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.state = 'closed'
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          this.client.destroy()
        } catch {
          // Ignore.
        }
        finish()
      }, 1_000)
      timer.unref?.()
      this.client.once('close', finish)
      try {
        this.client.end()
      } catch {
        finish()
      }
    })
  }
}
