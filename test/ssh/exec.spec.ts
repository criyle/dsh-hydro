import { afterEach, describe, expect, it } from 'vitest'
import {
  connectSsh,
  SshAbortError,
  type ExecResult,
  type SshConnection,
} from '../../src/ssh/index.js'
import { startTestServer, type ExecRequest, type TestSshServer } from './helpers/server.js'

const servers: TestSshServer[] = []
const connections: SshConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close()
  for (const server of servers.splice(0)) await server.stop()
})

async function openConnection(server: TestSshServer): Promise<SshConnection> {
  const connection = await connectSsh({
    target: { host: '127.0.0.1', port: server.port, username: 'tester' },
    auth: { kind: 'password', password: 'pw' },
    hostKeyPolicy: 'off',
    timeoutMs: 5_000,
  })
  connections.push(connection)
  return connection
}

const execHandler = async (request: ExecRequest): Promise<void> => {
  if (request.command.startsWith('export FOO=')) {
    request.finish(`${request.command}\n`)
    return
  }
  switch (request.command) {
    case 'uname -a':
      request.finish('Linux dsh-test 6.0.0 #1 SMP\n')
      return
    case 'fail-me':
      request.finish('partial\n', 'boom\n', 3)
      return
    case 'cat': {
      const stdin = await request.stdin()
      request.finish(stdin.toString('utf8'))
      return
    }
    case 'echo-args':
      request.finish(`${request.command}\n`)
      return
    case 'needs-pty':
      request.finish(request.pty ? 'pty yes\n' : 'pty no\n')
      return
    case 'big-output':
      request.finish('x'.repeat(4096))
      return
    case 'never-finishes':
      // Intentionally never finishes: used for timeout/abort tests.
      return
    default:
      request.finish('', `unknown command: ${request.command}\n`, 127)
  }
}

async function startServer(execHandlerOverride?: (request: ExecRequest) => void | Promise<void>): Promise<TestSshServer> {
  const server = await startTestServer({ password: 'pw', onExec: execHandlerOverride ?? execHandler })
  servers.push(server)
  return server
}

describe('SshConnection.exec', () => {
  it('collects stdout, stderr and the exit code', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const version = await connection.exec('uname -a')
    expect(version.stdout).toBe('Linux dsh-test 6.0.0 #1 SMP\n')
    expect(version.stderr).toBe('')
    expect(version.code).toBe(0)
    expect(version.timedOut).toBe(false)

    const failed = await connection.exec('fail-me')
    expect(failed.code).toBe(3)
    expect(failed.stdout).toBe('partial\n')
    expect(failed.stderr).toBe('boom\n')
  })

  it('sends stdin to the remote command', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const result = await connection.exec('cat', { stdin: 'hello stdin\ntwo\n' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello stdin\ntwo\n')
    expect(server.commands.find((command) => command.command === 'cat')?.stdin).toBe('hello stdin\ntwo\n')
  })

  it('passes environment variables through an export prefix', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const result = await connection.exec('echo-args', { env: { FOO: 'bar baz' } })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("export FOO='bar baz'; echo-args")
    expect(server.commands.some((command) => command.command === "export FOO='bar baz'; echo-args")).toBe(true)

  })

  it('allocates a pty when requested', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const withPty = await connection.exec('needs-pty', { pty: true })
    expect(withPty.stdout).toBe('pty yes\n')

    const withoutPty = await connection.exec('needs-pty')
    expect(withoutPty.stdout).toBe('pty no\n')
    expect(server.commands.map((command) => command.pty)).toEqual([true, false])
  })

  it('resolves with timedOut when the command exceeds its timeout', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const startedAt = Date.now()
    const result = await connection.exec('never-finishes', { timeoutMs: 150 })
    const elapsed = Date.now() - startedAt
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('timed out after 150ms')
    expect(elapsed).toBeLessThan(2_000)
  })

  it('rejects with an AbortError when aborted', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const controller = new AbortController()
    const promise = connection.exec('never-finishes', { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)

    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SshAbortError)
    expect((caught as Error).name).toBe('AbortError')
  })

  it('truncates large output with a marker', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const result = await connection.exec('big-output', { maxOutputBytes: 1024 })
    expect(result.code).toBe(0)
    expect(result.stdout.startsWith('x'.repeat(100))).toBe(true)
    expect(result.stdout.length).toBeLessThan(1_300)
    expect(result.stdout).toContain('output truncated at 1024 bytes')
  })

  it('destroys pending command channels when the connection closes', async () => {
    const server = await startServer()
    const connection = await openConnection(server)

    const pending = connection.exec('never-finishes')
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    await connection.close()

    const result = await pending
    expect(result.code).toBeNull()
    expect(result.timedOut).toBe(false)
  })

  it('rejects cleanly when the server rejects the command channel', async () => {
    const server = await startServer()
    // Replace the handler with none: the test server rejects exec requests.
    server.onExec = undefined
    const connection = await openConnection(server)
    await expect(connection.exec('uname -a')).rejects.toThrow(/failed to open an ssh command channel/i)
  })

  it('returns the full result shape', async () => {
    const server = await startServer()
    const connection = await openConnection(server)
    const result: ExecResult = await connection.exec('uname -a')
    expect(Object.keys(result).sort()).toEqual(['code', 'stderr', 'stdout', 'timedOut'])
  })
})
