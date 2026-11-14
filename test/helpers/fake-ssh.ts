import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, connect } from 'node:net'
import { basename } from 'node:path'

import type { AccountRecord } from '../accounts/store.js'
import type { Config } from '../config.js'
import type { ExecOptions, ExecResult, LocalForward, RemoteStat, SshConnection, SshTarget } from '../ssh/index.js'
import type { AccountContext } from '../../src/ops/types.js'

/** One scripted command handler: match a command and return (part of) a result. */
export interface FakeCommand {
  match: RegExp | string
  result: Partial<ExecResult> | ((command: string, options: ExecOptions | undefined) => Partial<ExecResult> | Promise<Partial<ExecResult>>)
}

export interface FakeSshOptions {
  target?: SshTarget
  /** Handlers are tried in order; unmatched commands exit 127. */
  commands?: FakeCommand[]
  /** When set, forwarded connections are piped to this local TCP endpoint. */
  forwardTarget?: { host: string; port: number }
  /** Remote file map for sftp-style reads. */
  files?: Record<string, string | Buffer>
}

/** A scriptable in-memory {@link SshConnection} for unit tests. */
export class FakeSshConnection implements SshConnection {
  readonly target: SshTarget
  readonly commands: string[] = []
  readonly written = new Map<string, Buffer>()
  readonly closedFlag = { value: false }
  readonly files = new Map<string, Buffer>()
  readonly forwards: Array<{ remoteHost: string; remotePort: number; localPort: number; close: () => Promise<void> }> = []
  readonly options: FakeSshOptions
  private handlers: FakeCommand[]
  private server?: { close(cb?: () => void): void }
  /** Fail any `exec` when set. */
  failWith: Error | undefined

  constructor(options: FakeSshOptions = {}) {
    this.options = options
    this.target = options.target ?? { host: 'example.org', port: 22, username: 'root' }
    this.handlers = [...(options.commands ?? [])]
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
    }
  }

  get closed(): boolean {
    return this.closedFlag.value
  }

  /** Add a handler after construction. */
  on(match: RegExp | string, result: FakeCommand['result']): this {
    this.handlers.push({ match, result })
    return this
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.commands.push(command)
    if (this.failWith !== undefined) throw this.failWith
    for (const handler of this.handlers) {
      const matches = typeof handler.match === 'string' ? command.includes(handler.match) : handler.match.test(command)
      if (!matches) continue
      const value = typeof handler.result === 'function' ? await handler.result(command, options) : handler.result
      return {
        code: value.code === undefined ? 0 : value.code,
        stdout: value.stdout ?? '',
        stderr: value.stderr ?? '',
        timedOut: value.timedOut ?? false,
        ...(value.signal === undefined ? {} : { signal: value.signal }),
      }
    }
    return { code: 127, stdout: '', stderr: `FakeSsh: no handler for ${command}`, timedOut: false }
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const content = this.files.get(remotePath)
    if (content === undefined) throw new Error(`ENOENT: ${remotePath}`)
    return content
  }

  async writeFile(remotePath: string, data: string | Buffer): Promise<void> {
    this.written.set(remotePath, Buffer.isBuffer(data) ? data : Buffer.from(data))
    this.files.set(remotePath, Buffer.isBuffer(data) ? data : Buffer.from(data))
  }

  async mkdirp(): Promise<void> {
    // Directories are implicit in the fake.
  }

  async stat(remotePath: string): Promise<RemoteStat> {
    const content = this.files.get(remotePath)
    if (content === undefined) return { exists: false, isDirectory: false, size: 0, mode: 0 }
    return { exists: true, isDirectory: false, size: content.byteLength, mode: 0o600 }
  }

  async elevate(command: string, options?: { password?: string }): Promise<ExecResult> {
    this.commands.push(`[elevate] ${command}`)
    // Reuse the ordinary handlers so tests script one surface.
    return this.exec(command, options?.password === undefined ? {} : { stdin: options.password })
  }

  async forwardLocalToRemote(options: { remoteHost: string; remotePort: number; localHost?: string }): Promise<LocalForward> {
    const target = this.options.forwardTarget
    const server = createServer((socket) => {
      if (target === undefined) {
        socket.end()
        return
      }
      const upstream = connect({ host: target.host, port: target.port })
      socket.pipe(upstream).pipe(socket)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, options.localHost ?? '127.0.0.1', () => resolve())
    })
    const address = server.address()
    const localPort = typeof address === 'object' && address !== null ? address.port : 0
    this.server = server
    this.forwards.push({ remoteHost: options.remoteHost, remotePort: options.remotePort, localPort, close: async () => undefined })
    return {
      localHost: options.localHost ?? '127.0.0.1',
      localPort,
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        for (const forward of this.forwards) {
          if (forward.localPort === localPort) forward.close = async () => undefined
        }
      },
    }
  }

  async close(): Promise<void> {
    this.closedFlag.value = true
    if (this.server !== undefined) {
      const server = this.server
      this.server = undefined
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** Build a minimal {@link AccountRecord} for tests. */
export function fakeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: 'acc-test',
    label: 'root@example.org',
    host: 'example.org',
    port: 22,
    username: 'root',
    authMethod: 'key',
    managedKey: true,
    privateKeyPath: '/tmp/dsh-hydro-test/keys/acc-test',
    publicKey: 'ssh-ed25519 AAAA test',
    role: 'root',
    readonly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConnectedAt: null,
    lastStatusAt: null,
    hydro: null,
    ...overrides,
  }
}

/** Build a minimal validated {@link Config} for tests (schema defaults). */
export function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    dataDir: '/tmp/dsh-hydro-test',
    readonlyMode: { get: () => false } as unknown as Config['readonlyMode'],
    defaultReadonly: false,
    connectTimeoutMs: 5_000,
    commandTimeoutMs: 10_000,
    hostKeyPolicy: 'off',
    knownHostsPath: '/tmp/dsh-hydro-test/known_hosts',
    npmRegistry: 'https://registry.npmjs.org',
    hydro: {
      installDir: '',
      serviceName: 'hydrooj',
      port: 0,
      installerUrl: 'https://hydro.ac/setup.sh',
      registry: '',
      elevation: 'auto',
      serviceManager: 'auto',
      skipSystemPackages: false,
    },
    mongo: { host: '127.0.0.1', port: 27017, db: '' },
    status: {
      timeoutMs: 10_000,
      includeMongo: false,
      includeOplog: false,
      includeWsWarnings: false,
      includeLatestVersions: false,
    },
    problem: {
      defaultDomain: 'system',
      workspaceDir: 'hydro-problems',
      defaultTimeLimitMs: 1000,
      defaultMemoryLimitMb: 256,
      partialMinScore: 1,
      judgeTimeoutMs: 60_000,
    },
    security: { allowArbitraryCommands: false, maxCommandOutputBytes: 65536 },
    ui: { showPanel: true, registerSkill: true },
    ...overrides,
  }
}

/** Build an {@link AccountContext} around a fake connection. */
export function fakeContext(overrides: Partial<AccountContext> = {}): AccountContext {
  const account = overrides.account ?? fakeAccount()
  const config = overrides.config ?? fakeConfig()
  const connection = overrides.connection ?? new FakeSshConnection()
  return {
    account,
    config,
    connection,
    readonly: overrides.readonly ?? false,
    dataDir: overrides.dataDir ?? config.dataDir,
    log: overrides.log ?? (() => undefined),
    elevationPassword: overrides.elevationPassword ?? (() => 'sudo-password'),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  }
}

/** Run a local helper command, rejecting on a nonzero exit. */
export async function execLocal(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`))
      else resolve(stdout)
    })
  })
}

/** Start a local process and wait until it prints `ready` on stdout. */
export async function startLocal(command: string, args: string[], ready: RegExp): Promise<{ stop(): Promise<void> }> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${ready} in ${basename(command)}; stderr=${stderr}`)), 10_000)
    child.stdout.on('data', () => {
      if (ready.test(stdout)) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`process exited early (${String(code)}); stderr=${stderr}`))
    })
  })
  return {
    async stop() {
      child.kill('SIGTERM')
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))])
    },
  }
}
