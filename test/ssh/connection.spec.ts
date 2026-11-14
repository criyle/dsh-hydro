import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectSsh,
  generateKeyPair,
  SshAbortError,
  type SshConnectOptions,
} from '../../src/ssh/index.js'
import { startTestServer, type TestSshServer } from './helpers/server.js'

interface TestContext {
  servers: TestSshServer[]
  silent: Server[]
  sockets: Socket[]
}

function createContext(): TestContext {
  return { servers: [], silent: [], sockets: [] }
}

const context = createContext()

afterEach(async () => {
  for (const socket of context.sockets.splice(0)) socket.destroy()
  for (const server of context.servers.splice(0)) await server.stop()
  for (const server of context.silent.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function baseOptions(server: TestSshServer, auth: SshConnectOptions['auth']): SshConnectOptions {
  return {
    target: { host: '127.0.0.1', port: server.port, username: 'tester' },
    auth,
    hostKeyPolicy: 'off',
    timeoutMs: 5_000,
  }
}

async function startServer(password = 'correct-horse'): Promise<TestSshServer> {
  const server = await startTestServer({ password })
  context.servers.push(server)
  return server
}

async function startSilentServer(): Promise<{ port: number }> {
  const server = createServer((socket) => {
    context.sockets.push(socket)
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  context.silent.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('silent server did not bind')
  return { port: address.port }
}

describe('connectSsh authentication', () => {
  it('authenticates with a password', async () => {
    const server = await startServer()
    const connection = await connectSsh(baseOptions(server, { kind: 'password', password: 'correct-horse' }))
    expect(connection.closed).toBe(false)
    expect(connection.target.host).toBe('127.0.0.1')
    await connection.close()
    expect(connection.closed).toBe(true)
  })

  it('rejects a wrong password without leaking it in the error message', async () => {
    const server = await startServer()
    const password = 'super-secret-wrong-password'
    await expect(connectSsh(baseOptions(server, { kind: 'password', password }))).rejects.toThrow(
      /authentication failed/i,
    )
    try {
      await connectSsh(baseOptions(server, { kind: 'password', password }))
    } catch (error) {
      expect((error as Error).message).not.toContain(password)
    }
  })

  it('authenticates with a generated private key', async () => {
    const keyPair = await generateKeyPair('client-key')
    const server = await startTestServer({ authorizedKeys: [keyPair.publicKey] })
    context.servers.push(server)
    const connection = await connectSsh(baseOptions(server, { kind: 'privateKey', privateKey: keyPair.privateKey }))
    expect(connection.closed).toBe(false)
    await connection.close()
  })

  it('rejects an unauthorized private key', async () => {
    const authorized = await generateKeyPair()
    const other = await generateKeyPair()
    const server = await startTestServer({ authorizedKeys: [authorized.publicKey] })
    context.servers.push(server)
    await expect(
      connectSsh(baseOptions(server, { kind: 'privateKey', privateKey: other.privateKey })),
    ).rejects.toThrow(/authentication failed/i)
  })
})

describe('connectSsh timeouts and aborts', () => {
  it('times out when the server never completes the handshake', async () => {
    const { port } = await startSilentServer()
    const promise = connectSsh({
      target: { host: '127.0.0.1', port, username: 'tester' },
      auth: { kind: 'password', password: 'x' },
      hostKeyPolicy: 'off',
      timeoutMs: 300,
    })
    await expect(promise).rejects.toThrow(/timed out/i)
  })

  it('aborts an in-flight connection attempt', async () => {
    const { port } = await startSilentServer()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 80)
    const promise = connectSsh({
      target: { host: '127.0.0.1', port, username: 'tester' },
      auth: { kind: 'password', password: 'x' },
      hostKeyPolicy: 'off',
      timeoutMs: 10_000,
      signal: controller.signal,
    })
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SshAbortError)
    expect((caught as Error).name).toBe('AbortError')
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { port } = await startSilentServer()
    await expect(
      connectSsh({
        target: { host: '127.0.0.1', port, username: 'tester' },
        auth: { kind: 'password', password: 'x' },
        hostKeyPolicy: 'off',
        timeoutMs: 500,
        signal: controller.signal,
      }),
    ).rejects.toThrow(SshAbortError)
  })

  it('reports connection refused cleanly', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    const port = address.port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await expect(
      connectSsh({
        target: { host: '127.0.0.1', port, username: 'tester' },
        auth: { kind: 'password', password: 'x' },
        hostKeyPolicy: 'off',
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(/SSH connection .* failed/i)
  })
})

describe('SshConnection lifecycle', () => {
  it('is idempotent on close and rejects exec once closed', async () => {
    const server = await startServer()
    const connection = await connectSsh(baseOptions(server, { kind: 'password', password: 'correct-horse' }))
    await connection.close()
    await connection.close()
    expect(connection.closed).toBe(true)
    await expect(connection.exec('true')).rejects.toThrow(/closed/i)
    await expect(connection.stat('/tmp/x')).rejects.toThrow(/closed/i)
  })

  it('marks the connection closed when the server disconnects', async () => {
    const server = await startServer()
    const connection = await connectSsh(baseOptions(server, { kind: 'password', password: 'correct-horse' }))
    await server.stop()
    context.servers = context.servers.filter((candidate) => candidate !== server)
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    expect(connection.closed).toBe(true)
    await expect(connection.exec('true')).rejects.toThrow(/closed/i)
  })
})
