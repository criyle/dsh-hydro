/**
 * In-process ssh2 server used by the SSH transport tests.
 *
 * It implements password/publickey auth, scriptable exec handlers, an
 * in-memory SFTP filesystem and optional TCP forwarding, so the client can be
 * exercised end-to-end over a real loopback SSH connection (no network).
 */

import { connect as netConnect, type Server as NetServer, type Socket } from 'node:net'
import ssh2 from 'ssh2'
import type {
  Attributes,
  AuthContext,
  Connection,
  ServerChannel,
  SFTPWrapper,
  Session,
} from 'ssh2'
import { generateKeyPair } from '../../../src/ssh/index.js'

const { Server, utils: ssh2Utils } = ssh2

const SFTP_STATUS_OK = 0
const SFTP_STATUS_EOF = 1
const SFTP_STATUS_NO_SUCH_FILE = 2
const SFTP_STATUS_FAILURE = 4

const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
} as const

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

export interface RecordedCommand {
  command: string
  stdin: string
  pty: boolean
}

export interface ExecRequest {
  command: string
  pty: boolean
  channel: ServerChannel
  /** Resolves with all stdin bytes once the client sends EOF (or closes). */
  stdin(): Promise<Buffer>
  /** Write output and finish the command with an exit status. */
  finish(stdout?: string, stderr?: string, code?: number): void
}

export type ExecHandler = (request: ExecRequest) => void | Promise<void>

export interface TestSshServerOptions {
  password?: string
  /** `authorized_keys` lines accepted for publickey authentication. */
  authorizedKeys?: string[]
  /** Private host key (OpenSSH format). Generated when omitted. */
  hostKey?: string
  onExec?: ExecHandler
  /** When set, `tcpip` channels are bridged to this local target. */
  forwardTarget?: { host: string; port: number }
}

interface MemoryEntry {
  content: Buffer
  mode: number
  isDirectory: boolean
}

interface AuthorizedKey {
  algo: string
  /** Full SSH public key blob (`string algo` + `string key`); this is what ssh2 exposes as `ctx.key.data`. */
  blob: Buffer
}

function decodeAuthorizedKey(publicKeyLine: string): AuthorizedKey {
  const parts = publicKeyLine.trim().split(/\s+/)
  const base64 = parts[1]
  if (base64 === undefined) throw new Error(`not an authorized_keys line: ${publicKeyLine}`)
  const blob = Buffer.from(base64, 'base64')
  const algoLength = blob.readUInt32BE(0)
  const algo = blob.subarray(4, 4 + algoLength).toString('utf8')
  return { algo, blob }
}

/** Collapse duplicate slashes and resolve trailing slashes (posix). */
function normalizeRemotePath(path: string): string {
  if (path === '') return '.'
  let normalized = path.replace(/\/+/g, '/')
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.replace(/\/+$/, '')
  return normalized
}

function parentPath(path: string): string {
  const normalized = normalizeRemotePath(path)
  const index = normalized.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return normalized.slice(0, index)
}

export class TestSshServer {
  readonly commands: RecordedCommand[] = []
  readonly files = new Map<string, MemoryEntry>()
  hostKeyPrivate!: string
  hostKeyPublicLine!: string

  port = 0
  onExec: ExecHandler | undefined
  forwardTarget: { host: string; port: number } | undefined

  private readonly options: TestSshServerOptions
  private readonly password: string | undefined
  private readonly authorizedKeys: AuthorizedKey[] = []
  private server: NetServer | undefined
  private readonly connections = new Set<Connection>()

  constructor(options: TestSshServerOptions = {}) {
    this.options = options
    this.password = options.password
    this.onExec = options.onExec
    this.forwardTarget = options.forwardTarget
    for (const line of options.authorizedKeys ?? []) {
      this.authorizedKeys.push(decodeAuthorizedKey(line))
    }
  }

  /** The known_hosts line a client should have after trust-on-first-use. */
  knownHostsLine(host = '127.0.0.1', port = this.port): string {
    const parsed = ssh2Utils.parseKey(this.hostKeyPrivate)
    if (parsed instanceof Error) throw parsed
    return `${port === 22 ? host : `[${host}]:${port}`} ${parsed.type} ${parsed.getPublicSSH().toString('base64')}`
  }

  addAuthorizedKey(publicKeyLine: string): void {
    this.authorizedKeys.push(decodeAuthorizedKey(publicKeyLine))
  }

  seedFile(path: string, content: string | Buffer, mode = 0o644): void {
    this.files.set(normalizeRemotePath(path), {
      content: Buffer.isBuffer(content) ? content : Buffer.from(content),
      mode,
      isDirectory: false,
    })
  }

  seedDirectory(path: string, mode = 0o755): void {
    this.files.set(normalizeRemotePath(path), { content: Buffer.alloc(0), mode, isDirectory: true })
  }

  getFileContent(path: string): string {
    const entry = this.files.get(normalizeRemotePath(path))
    if (entry === undefined) throw new Error(`no such test file: ${path}`)
    return entry.content.toString('utf8')
  }

  async start(port = 0): Promise<this> {
    // Host keys are generated with the project's own keypair generator: it
    // produces a stable OpenSSH-format ed25519 key accepted by ssh2.
    const keyPair = this.options.hostKey === undefined ? await generateKeyPair('test-server-host-key') : undefined
    this.hostKeyPrivate = this.options.hostKey ?? (keyPair as { privateKey: string }).privateKey
    this.hostKeyPublicLine = keyPair?.publicKey ?? ''
    const server = new Server({ hostKeys: [this.hostKeyPrivate] }, (connection: Connection) => {
      this.connections.add(connection)
      connection.on('close', () => this.connections.delete(connection))
      connection.on('error', () => this.connections.delete(connection))
      this.handleConnection(connection)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test SSH server did not bind')
    this.port = address.port
    return this
  }

  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    for (const connection of this.connections) {
      try {
        connection.end()
      } catch {
        // ignore
      }
    }
    this.connections.clear()
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
  }

  private handleConnection(connection: Connection): void {
    connection.on('authentication', (context: AuthContext) => {
      if (context.method === 'password') {
        if (this.password !== undefined && context.password === this.password) {
          context.accept()
          return
        }
        context.reject(['password', 'publickey'])
        return
      }
      if (context.method === 'publickey') {
        const accepted = this.authorizedKeys.some(
          (key) => key.algo === context.key.algo && key.blob.equals(context.key.data),
        )
        if (accepted) {
          // Accepting a probe (no signature) makes ssh2 send a signed request;
          // accepting the signed request completes authentication.
          context.accept()
          return
        }
        context.reject(['password', 'publickey'])
        return
      }
      context.reject(['password', 'publickey'])
    })

    connection.on('session', (accept) => {
      const session: Session = accept()
      this.handleSession(session)
    })

    connection.on('tcpip', (accept, reject) => {
      if (this.forwardTarget === undefined) {
        reject()
        return
      }
      const channel = accept()
      const target: Socket = netConnect(this.forwardTarget.port, this.forwardTarget.host, () => {
        channel.pipe(target)
        target.pipe(channel)
      })
      target.on('error', () => channel.destroy())
      channel.on('error', () => target.destroy())
      channel.on('close', () => target.destroy())
    })
  }

  private handleSession(session: Session): void {
    let pty = false
    session.on('pty', (accept) => {
      pty = true
      accept()
    })
    session.on('env', (accept) => accept())
    session.on('window-change', (accept) => accept())

    session.on('exec', (accept, reject, info) => {
      if (this.onExec === undefined) {
        reject()
        return
      }
      const channel = accept()
      const chunks: Buffer[] = []
      channel.on('data', (chunk: Buffer) => chunks.push(chunk))
      const command = info.command
      const request: ExecRequest = {
        command,
        pty,
        channel,
        stdin: () =>
          new Promise<Buffer>((resolve) => {
            const done = (): void => {
              channel.removeListener('end', done)
              resolve(Buffer.concat(chunks))
            }
            if (channel.readableEnded) {
              done()
              return
            }
            channel.once('end', done)
          }),
        finish: (stdout = '', stderr = '', code = 0) => {
          if (stdout.length > 0) channel.write(stdout)
          if (stderr.length > 0) channel.stderr.write(stderr)
          channel.exit(code)
          setTimeout(() => {
            try {
              channel.end()
            } catch {
              // Channel already closed.
            }
          }, 10)
        },
      }
      const record: RecordedCommand = { command, stdin: '', pty }
      this.commands.push(record)
      void (async () => {
        try {
          await this.onExec?.(request)
        } catch {
          request.finish('', 'test exec handler threw\n', 1)
        } finally {
          record.stdin = Buffer.concat(chunks).toString('utf8')
        }
      })()
    })

    session.on('shell', (accept, reject) => {
      // Not used by the client; reject to surface mistakes in tests.
      reject()
    })

    session.on('sftp', (accept) => {
      const sftp: SFTPWrapper = accept()
      this.handleSftp(sftp)
    })
  }

  private statEntry(path: string): { mode: number; size: number; uid: number; gid: number; atime: number; mtime: number } | undefined {
    const normalized = normalizeRemotePath(path)
    const entry = this.files.get(normalized)
    if (entry !== undefined) {
      return {
        mode: (entry.isDirectory ? S_IFDIR : S_IFREG) | entry.mode,
        size: entry.content.length,
        uid: 0,
        gid: 0,
        atime: 0,
        mtime: 0,
      }
    }
    // Implicit parent directories.
    for (const key of this.files.keys()) {
      if (key.startsWith(`${normalized}/`)) {
        return { mode: S_IFDIR | 0o755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
      }
    }
    return undefined
  }

  private handleSftp(sftp: SFTPWrapper): void {
    const handles = new Map<number, { path: string; flags: number }>()
    let nextHandle = 1
    const status = (reqId: number, code: number, message?: string): void => {
      sftp.status(reqId, code, message)
    }

    sftp.on('OPEN', (reqId, filename, flags, attrs: Attributes) => {
      const path = normalizeRemotePath(filename)
      const existing = this.files.get(path)
      if (existing !== undefined && existing.isDirectory) {
        status(reqId, SFTP_STATUS_FAILURE, 'is a directory')
        return
      }
      if (existing === undefined && (flags & OPEN_MODE.CREAT) === 0) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      if ((flags & OPEN_MODE.EXCL) !== 0 && existing !== undefined) {
        status(reqId, SFTP_STATUS_FAILURE, 'file exists')
        return
      }
      if (existing === undefined) {
        const mode = typeof attrs.mode === 'number' ? attrs.mode & 0o777 : 0o666
        this.files.set(path, { content: Buffer.alloc(0), mode, isDirectory: false })
      } else if ((flags & OPEN_MODE.TRUNC) !== 0) {
        existing.content = Buffer.alloc(0)
      }
      const handle = nextHandle++
      handles.set(handle, { path, flags })
      const handleBuffer = Buffer.alloc(4)
      handleBuffer.writeUInt32BE(handle, 0)
      sftp.handle(reqId, handleBuffer)
    })

    sftp.on('READ', (reqId, handle, offset, length) => {
      const entryId = handle.readUInt32BE(0)
      const entry = handles.get(entryId)
      if (entry === undefined) {
        status(reqId, SFTP_STATUS_FAILURE, 'unknown handle')
        return
      }
      const file = this.files.get(entry.path)
      if (file === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      if (offset >= file.content.length) {
        status(reqId, SFTP_STATUS_EOF)
        return
      }
      sftp.data(reqId, file.content.subarray(offset, Math.min(offset + length, file.content.length)))
    })

    sftp.on('WRITE', (reqId, handle, offset, data) => {
      const entryId = handle.readUInt32BE(0)
      const entry = handles.get(entryId)
      if (entry === undefined) {
        status(reqId, SFTP_STATUS_FAILURE, 'unknown handle')
        return
      }
      const file = this.files.get(entry.path)
      if (file === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      const end = offset + data.length
      const merged = Buffer.alloc(Math.max(file.content.length, end))
      file.content.copy(merged, 0)
      data.copy(merged, offset)
      file.content = merged
      status(reqId, SFTP_STATUS_OK)
    })

    sftp.on('CLOSE', (reqId, handle) => {
      handles.delete(handle.readUInt32BE(0))
      status(reqId, SFTP_STATUS_OK)
    })

    sftp.on('FSTAT', (reqId, handle) => {
      const entryId = handle.readUInt32BE(0)
      const entry = handles.get(entryId)
      if (entry === undefined) {
        status(reqId, SFTP_STATUS_FAILURE, 'unknown handle')
        return
      }
      const attrs = this.statEntry(entry.path)
      if (attrs === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      sftp.attrs(reqId, attrs)
    })

    sftp.on('STAT', (reqId, path) => {
      const attrs = this.statEntry(path)
      if (attrs === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      sftp.attrs(reqId, attrs)
    })

    sftp.on('LSTAT', (reqId, path) => {
      const attrs = this.statEntry(path)
      if (attrs === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE)
        return
      }
      sftp.attrs(reqId, attrs)
    })

    sftp.on('MKDIR', (reqId, path, attrs: Attributes) => {
      const normalized = normalizeRemotePath(path)
      if (this.statEntry(normalized) !== undefined) {
        status(reqId, SFTP_STATUS_FAILURE, 'already exists')
        return
      }
      const parent = parentPath(normalized)
      if (parent !== '.' && parent !== '/' && this.statEntry(parent) === undefined) {
        status(reqId, SFTP_STATUS_NO_SUCH_FILE, 'parent missing')
        return
      }
      this.files.set(normalized, {
        content: Buffer.alloc(0),
        mode: typeof attrs.mode === 'number' ? attrs.mode & 0o777 : 0o755,
        isDirectory: true,
      })
      status(reqId, SFTP_STATUS_OK)
    })

    sftp.on('SETSTAT', (reqId) => status(reqId, SFTP_STATUS_OK))
    sftp.on('FSETSTAT', (reqId) => status(reqId, SFTP_STATUS_OK))
    sftp.on('REALPATH', (reqId, path) => {
      const normalized = normalizeRemotePath(path)
      sftp.name(reqId, [{ filename: normalized, longname: normalized, attrs: { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }])
    })
  }
}

/** Convenience factory: start a server and return it. */
export async function startTestServer(options: TestSshServerOptions = {}): Promise<TestSshServer> {
  return new TestSshServer(options).start()
}
