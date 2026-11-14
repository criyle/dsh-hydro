import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh, SshAbortError, type SshConnection } from '../../src/ssh/index.js'
import { startTestServer, type TestSshServer } from './helpers/server.js'

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

async function start(): Promise<TestSshServer> {
  const server = await startTestServer({ password: 'pw' })
  servers.push(server)
  return server
}

describe('SFTP file operations', () => {
  it('round-trips a written file', async () => {
    const server = await start()
    const connection = await openConnection(server)

    await connection.writeFile('/srv/app/config.yml', 'key: value\n', { mode: 0o600 })
    expect(server.files.get('/srv/app/config.yml')?.content.toString()).toBe('key: value\n')
    expect(server.files.get('/srv/app/config.yml')?.mode).toBe(0o600)

    const data = await connection.readFile('/srv/app/config.yml')
    expect(data.toString('utf8')).toBe('key: value\n')
  })

  it('round-trips binary data', async () => {
    const server = await start()
    const connection = await openConnection(server)
    const payload = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0])
    await connection.writeFile('/srv/blob.bin', payload)
    const readBack = await connection.readFile('/srv/blob.bin')
    expect(readBack.equals(payload)).toBe(true)
  })

  it('fails cleanly for a missing file', async () => {
    const server = await start()
    const connection = await openConnection(server)
    await expect(connection.readFile('/does/not/exist')).rejects.toThrow(/not found/i)
  })

  it('enforces maxBytes before reading', async () => {
    const server = await start()
    server.seedFile('/srv/large.txt', '0123456789')
    const connection = await openConnection(server)
    await expect(connection.readFile('/srv/large.txt', { maxBytes: 4 })).rejects.toThrow(
      /exceeds the maxBytes limit of 4/i,
    )
  })

  it('stats files, directories and missing paths', async () => {
    const server = await start()
    server.seedFile('/srv/app/config.yml', 'hello', 0o644)
    server.seedDirectory('/srv/app')
    const connection = await openConnection(server)

    const file = await connection.stat('/srv/app/config.yml')
    expect(file.exists).toBe(true)
    expect(file.isDirectory).toBe(false)
    expect(file.size).toBe(5)
    expect(file.mode & 0o777).toBe(0o644)

    const directory = await connection.stat('/srv/app')
    expect(directory.exists).toBe(true)
    expect(directory.isDirectory).toBe(true)

    const missing = await connection.stat('/srv/nope')
    expect(missing.exists).toBe(false)
    expect(missing.isDirectory).toBe(false)
  })

  it('creates nested directories with mkdirp', async () => {
    const server = await start()
    server.seedDirectory('/srv')
    const connection = await openConnection(server)

    await connection.mkdirp('/srv/app/logs/nested')
    for (const path of ['/srv/app', '/srv/app/logs', '/srv/app/logs/nested']) {
      expect(server.files.get(path)?.isDirectory).toBe(true)
      const stats = await connection.stat(path)
      expect(stats.exists).toBe(true)
      expect(stats.isDirectory).toBe(true)
    }

    // Re-running is a no-op.
    await connection.mkdirp('/srv/app/logs/nested')
    const created = server.files.get('/srv/app/logs/nested')
    expect(created?.isDirectory).toBe(true)
  })

  it('refuses to mkdirp over a regular file', async () => {
    const server = await start()
    server.seedFile('/srv/app/file.txt', 'x')
    const connection = await openConnection(server)
    await expect(connection.mkdirp('/srv/app/file.txt')).rejects.toThrow(/not a directory/i)
  })

  it('honours an aborted signal', async () => {
    const server = await start()
    const connection = await openConnection(server)
    const controller = new AbortController()
    controller.abort()
    let caught: unknown
    try {
      await connection.writeFile('/srv/aborted.txt', 'x', { signal: controller.signal })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SshAbortError)
  })
})
