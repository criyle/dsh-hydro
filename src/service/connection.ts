/**
 * Per-account SSH connection management.
 *
 * The pool keeps at most one live connection per account (plus one per distinct
 * target/auth fingerprint), reconnects after transport failures, and closes
 * everything when the plugin unloads. It is deliberately transport-agnostic:
 * `connect` and `generateKeyPair` are injected so unit tests can run without a
 * real server.
 */
import { posix } from 'node:path'

import type { SshAuth, SshConnectOptions, SshConnection } from '../ssh/index.js'
import { connectSsh, generateKeyPair, shellQuote } from '../ssh/index.js'
import type { AccountRecord } from '../accounts/store.js'
import type { AccountStore } from '../accounts/store.js'
import type { HostKeyPolicy } from '../config.js'

/** Everything the pool needs from the plugin configuration. */
export interface ConnectionPoolOptions {
  knownHostsPath: string
  hostKeyPolicy: HostKeyPolicy
  connectTimeoutMs: number
  keepaliveMs?: number
}

/** Injectable transport primitives (defaults point at the real implementation). */
export interface Transport {
  connect(options: SshConnectOptions): Promise<SshConnection>
  generateKeyPair(comment?: string): Promise<{ privateKey: string; publicKey: string }>
}

export const defaultTransport: Transport = {
  connect: connectSsh,
  generateKeyPair: (comment) => generateKeyPair(comment),
}

/** A failure that explains why an account cannot be connected right now. */
export class AccountConnectionError extends Error {
  constructor(
    message: string,
    readonly accountId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AccountConnectionError'
  }
}

interface PoolEntry {
  connection: SshConnection | null
  pending: Promise<SshConnection> | null
  fingerprint: string
}

function fingerprintOf(account: AccountRecord): string {
  return [account.id, account.host, String(account.port), account.username, account.authMethod, account.privateKeyPath ?? ''].join('|')
}

/** Resolve the authentication material for an account from the store. */
export async function resolveAuth(account: AccountRecord, store: AccountStore): Promise<SshAuth> {
  if (account.authMethod === 'key') {
    const privateKey = await store.getManagedPrivateKey(account.id)
    if (privateKey === undefined) {
      throw new AccountConnectionError(
        `账号 ${account.label} 配置为密钥登录，但本地私钥不存在；请重新添加账号以重新安装托管密钥`,
        account.id,
      )
    }
    return { kind: 'privateKey', privateKey }
  }
  throw new AccountConnectionError(
    `账号 ${account.label} 没有可用的托管密钥；请重新添加账号（一次性密码只用于首次安装密钥）。`,
    account.id,
  )
}

export class ConnectionPool {
  private readonly entries = new Map<string, PoolEntry>()
  private closed = false

  constructor(
    private readonly store: AccountStore,
    private readonly options: ConnectionPoolOptions,
    private readonly transport: Transport = defaultTransport,
  ) {}

  /** Return a live connection for the account, connecting when necessary. */
  async acquire(account: AccountRecord, signal?: AbortSignal): Promise<SshConnection> {
    if (this.closed) throw new Error('dsh-hydro: connection pool is closed')
    const key = account.id
    const fingerprint = fingerprintOf(account)
    let entry = this.entries.get(key)

    if (entry !== undefined && entry.fingerprint !== fingerprint) {
      // Credentials or target changed: drop the stale connection.
      await this.drop(key)
      entry = undefined
    }
    if (entry?.connection !== null && entry?.connection !== undefined && !entry.connection.closed) {
      return entry.connection
    }
    if (entry?.pending !== null && entry?.pending !== undefined) return entry.pending

    const pending = this.connect(account, signal)
    if (entry === undefined) {
      entry = { connection: null, pending, fingerprint }
      this.entries.set(key, entry)
    } else {
      entry.pending = pending
    }
    try {
      const connection = await pending
      entry.connection = connection
      entry.pending = null
      return connection
    } catch (error) {
      this.entries.delete(key)
      throw error
    }
  }

  /** Drop one account's connection (called after auth/target changes). */
  async drop(accountId: string): Promise<void> {
    const entry = this.entries.get(accountId)
    this.entries.delete(accountId)
    if (entry?.pending !== null && entry?.pending !== undefined) {
      await entry.pending.catch(() => undefined)
    }
    if (entry?.connection !== null && entry?.connection !== undefined) {
      await entry.connection.close().catch(() => undefined)
    }
  }

  /** Close every live connection. Safe to call repeatedly. */
  async closeAll(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const ids = [...this.entries.keys()]
    await Promise.all(ids.map((id) => this.drop(id)))
  }

  private async connect(account: AccountRecord, signal?: AbortSignal): Promise<SshConnection> {
    const auth = await resolveAuth(account, this.store)
    try {
      return await this.transport.connect({
        target: { host: account.host, port: account.port, username: account.username },
        auth,
        hostKeyPolicy: this.options.hostKeyPolicy,
        knownHostsPath: this.options.knownHostsPath,
        timeoutMs: this.options.connectTimeoutMs,
        ...(this.options.keepaliveMs === undefined ? {} : { keepaliveMs: this.options.keepaliveMs }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new AccountConnectionError(`无法连接 ${account.username}@${account.host}:${account.port}：${(error as Error).message}`, account.id, { cause: error })
    }
  }

  /**
   * Verify a password connection and install the plugin-managed key pair.
   *
   * Steps: generate key pair → append the public key to `~/.ssh/authorized_keys`
   * (idempotent) → verify a key-auth connection → persist the private key and
   * switch the account to key auth. If verification fails the account keeps its
   * password auth and the generated key is discarded.
   */
  async bootstrapManagedKey(
    account: AccountRecord,
    password: string | undefined,
    onLog?: (line: string) => void,
  ): Promise<{ publicKey: string; authorizedKeysPath: string }> {
    const log = (line: string): void => { onLog?.(line) }
    log(`[1/6] 使用一次性密码连接 ${account.username}@${account.host}:${String(account.port)}`)
    const effectivePassword = password
    if (effectivePassword === undefined || effectivePassword === '') {
      throw new AccountConnectionError('安装密钥需要一次性 SSH 密码（不会保存）', account.id)
    }
    const passwordConnection = await this.transport.connect({
      target: { host: account.host, port: account.port, username: account.username },
      auth: { kind: 'password', password: effectivePassword },
      hostKeyPolicy: this.options.hostKeyPolicy,
      knownHostsPath: this.options.knownHostsPath,
      timeoutMs: this.options.connectTimeoutMs,
    })
    const home = await passwordConnection.exec('printf %s "$HOME"')
    const remoteHome = home.stdout.trim()
    if (home.code !== 0 || remoteHome === '') {
      throw new AccountConnectionError('无法获取远端 $HOME，未安装密钥', account.id)
    }
    const sshDir = posix.join(remoteHome, '.ssh')
    const authorizedKeys = posix.join(sshDir, 'authorized_keys')
    log('[2/6] 生成 ed25519 托管密钥')
    const pair = await this.transport.generateKeyPair('dsh-hydro')

    const script = [
      'set -e',
      `mkdir -p ${shellQuote(sshDir)}`,
      `chmod 700 ${shellQuote(sshDir)}`,
      `touch ${shellQuote(authorizedKeys)}`,
      `grep -qxF ${shellQuote(pair.publicKey)} ${shellQuote(authorizedKeys)} || printf '%s\\n' ${shellQuote(pair.publicKey)} >> ${shellQuote(authorizedKeys)}`,
      `chmod 600 ${shellQuote(authorizedKeys)}`,
    ].join('\n')
    log('[3/6] 写入 ~/.ssh/authorized_keys')
    const install = await passwordConnection.exec(script)
    if (install.code !== 0) {
      throw new AccountConnectionError(`写入 authorized_keys 失败：${install.stderr.trim() || install.stdout.trim()}`, account.id)
    }

    log('[4/6] 验证密钥登录')
    // Verify the key really works before dropping the password connection.
    let keyConnection: SshConnection | undefined
    try {
      keyConnection = await this.transport.connect({
        target: { host: account.host, port: account.port, username: account.username },
        auth: { kind: 'privateKey', privateKey: pair.privateKey },
        hostKeyPolicy: this.options.hostKeyPolicy,
        knownHostsPath: this.options.knownHostsPath,
        timeoutMs: this.options.connectTimeoutMs,
      })
      const probe = await keyConnection.exec('id -un')
      if (probe.code !== 0) throw new Error(probe.stderr.trim() || 'key auth probe failed')
    } finally {
      await keyConnection?.close().catch(() => undefined)
    }

    // Configure passwordless sudo for non-root users while the one-time
    // password connection is still available. No sudo password is stored.
    const uid = await passwordConnection.exec('id -u')
    if (uid.code === 0 && uid.stdout.trim() !== '0') {
      log('[5/6] 配置免密 sudo（/etc/sudoers.d/dsh-hydro）')
      const sudoers = [
        'set -e',
        'dir=/etc/sudoers.d',
        'mkdir -p "$dir"',
        `file="$dir/dsh-hydro-${account.id.replace(/[^A-Za-z0-9_-]/g, '_')}"`,
        `printf '%s\n' ${shellQuote(`${account.username} ALL=(ALL) NOPASSWD: ALL`)} > "$file"`,
        'chmod 440 "$file"',
        'visudo -cf "$file" >/dev/null',
      ].join('\n')
      const elevated = await passwordConnection.elevate(sudoers, {
        password: effectivePassword,
        timeoutMs: 30_000,
      })
      if (elevated.code !== 0) {
        throw new AccountConnectionError(
          `配置免密 sudo 失败：${(elevated.stderr || elevated.stdout).trim().slice(0, 500)}`,
          account.id,
        )
      }
      const sudoCheck = await passwordConnection.exec('sudo -n true >/dev/null 2>&1 && echo yes || echo no')
      if (sudoCheck.stdout.trim() !== 'yes') {
        throw new AccountConnectionError('免密 sudo 验证失败，已取消安装密钥', account.id)
      }
    } else {
      log('[5/6] 当前用户是 root，跳过免密 sudo')
    }

    log('[6/6] 保存托管密钥并丢弃一次性密码')
    await this.store.setManagedKey(account.id, pair.privateKey, pair.publicKey)
    await passwordConnection.close().catch(() => undefined)
    await this.drop(account.id)
    return { publicKey: pair.publicKey, authorizedKeysPath: authorizedKeys }
  }
}
