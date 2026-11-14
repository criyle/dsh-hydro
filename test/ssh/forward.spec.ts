import { createServer, Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh, type SshConnection } from '../../src/ssh/index.js'
import { startTestServer, type TestSshServer } from './helpers/server.js'

const servers: TestSshServer[] = []
const connections: SshConnection[] = []
const echoServers: Server[] = []
const echoSockets: Socket[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const socket of echoSockets.splice(0)) socket.destroy()
  for (const server of echoServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function startEchoServer(): Promise<number> {
  const server = createServer((socket: Socket) => {
    echoSockets.push(socket)
    socket.on('error', () => {})
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  echoServers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('echo server did not bind')
  return address.port
}

async function startForwardingServer(forwardPort: number): Promise<TestSshServer> {
  const server = await startTestServer({
    password: 'pw',
    forwardTarget: { host: '127.0.0.1', port: forwardPort },
  })
  servers.push(server)
  return server
}

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

async function roundTrip(host: string, port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('forwarded connection timed out'))
    }, 2_000)
    socket.connect(port, host, () => socket.write(payload))
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (Buffer.concat(chunks).length >= Buffer.byteLength(payload)) {
        clearTimeout(timer)
        socket.destroy()
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('forwardLocalToRemote', () => {
  it('forwards a local TCP connection to the remote target', async () => {
    const echoPort = await startEchoServer()
    const server = await startForwardingServer(echoPort)
    const connection = await openConnection(server)

    const forward = await connection.forwardLocalToRemote({
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    })
    expect(forward.localPort).toBeGreaterThan(0)
    expect(forward.localHost).toBe('127.0.0.1')

    const reply = await roundTrip(forward.localHost, forward.localPort, 'ping-through-ssh')
    expect(reply).toBe('ping-through-ssh')
    await forward.close()
  })

  it('closes the listener when the forward is closed (idempotently)', async () => {
    const echoPort = await startEchoServer()
    const server = await startForwardingServer(echoPort)
    const connection = await openConnection(server)

    const forward = await connection.forwardLocalToRemote({
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
    })
    await forward.close()
    await forward.close()
    await expect(roundTrip(forward.localHost, forward.localPort, 'x')).rejects.toThrow()
  })

  it('cleans up forwards when the connection closes', async () => {
    const echoPort = await startEchoServer()
    const server = await startForwardingServer(echoPort)
    const connection = await openConnection(server)

    const forward = await connection.forwardLocalToRemote({
      remoteHost: '127.0.0.1',
      remotePort: echoPort,
      localPort: 0,
    })
    await connection.close()
    await expect(roundTrip(forward.localHost, forward.localPort, 'x')).rejects.toThrow()
  })

  it('drops the local socket when the remote side refuses the channel', async () => {
    const echoPort = await startEchoServer()
    const server = await startTestServer({ password: 'pw' }) // no forwardTarget -> rejects tcpip
    servers.push(server)
    const connection = await openConnection(server)

    const forward = await connection.forwardLocalToRemote({
      remoteHost: '10.255.255.1',
      remotePort: echoPort,
    })
    const socket = new Socket()
    const closed = new Promise<void>((resolve) => {
      socket.on('close', () => resolve())
      socket.on('error', () => {})
      socket.connect(forward.localPort, forward.localHost, () => socket.write('x'))
    })
    await closed
    socket.destroy()
    await forward.close()
  })
})
