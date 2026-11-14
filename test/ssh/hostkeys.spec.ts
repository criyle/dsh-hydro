import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh, type SshConnectOptions } from '../../src/ssh/index.js'
import { startTestServer, TestSshServer } from './helpers/server.js'

const servers: TestSshServer[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempKnownHostsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-known-hosts-'))
  tempDirs.push(dir)
  return join(dir, 'known_hosts')
}

async function start(password = 'pw'): Promise<TestSshServer> {
  const server = await startTestServer({ password })
  servers.push(server)
  return server
}

function options(server: TestSshServer, knownHostsPath: string, hostKeyPolicy: 'off' | 'accept-new' | 'strict'): SshConnectOptions {
  return {
    target: { host: '127.0.0.1', port: server.port, username: 'tester' },
    auth: { kind: 'password', password: 'pw' },
    hostKeyPolicy,
    knownHostsPath,
    timeoutMs: 5_000,
  }
}

describe('host key verification', () => {
  it('accept-new trusts and persists the key on first use', async () => {
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()

    const connection = await connectSsh(options(server, knownHostsPath, 'accept-new'))
    await connection.close()

    const contents = await readFile(knownHostsPath, 'utf8')
    expect(contents).toContain('# dsh-hydro known_hosts')
    expect(contents).toContain(server.knownHostsLine())
    const fileStat = await stat(knownHostsPath)
    expect(fileStat.mode & 0o777).toBe(0o600)

    // Second connection reuses the persisted entry.
    const again = await connectSsh(options(server, knownHostsPath, 'accept-new'))
    await again.close()
    const lines = (await readFile(knownHostsPath, 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('['))
    expect(lines).toHaveLength(1)
  })

  it('strict fails when there is no known_hosts entry', async () => {
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()
    await expect(connectSsh(options(server, knownHostsPath, 'strict'))).rejects.toThrow(
      /no known_hosts entry.*strict|strict.*no known_hosts entry/is,
    )
    await expect(access(knownHostsPath)).rejects.toThrow()
  })

  it('strict succeeds when the entry already exists', async () => {
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(knownHostsPath, `${server.knownHostsLine()}\n`, { mode: 0o600 })
    const connection = await connectSsh(options(server, knownHostsPath, 'strict'))
    await connection.close()
  })

  it('fails when the server host key changes (accept-new mismatch)', async () => {
    const { readFile: read, writeFile } = await import('node:fs/promises')
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()
    const first = await connectSsh(options(server, knownHostsPath, 'accept-new'))
    await first.close()
    const trustedLine = server.knownHostsLine()

    // A different server (different host key) on a different port: move the
    // trusted entry to that port so the negotiated key must mismatch.
    const replacementKey = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'replacement-host-key' })
    const replacement = await new TestSshServer({ password: 'pw', hostKey: replacementKey.private }).start()
    servers.push(replacement)
    const movedLine = trustedLine.replace(`[127.0.0.1]:${server.port}`, `[127.0.0.1]:${replacement.port}`)
    expect(movedLine).not.toBe(trustedLine)
    await writeFile(knownHostsPath, `${movedLine}
`, { mode: 0o600 })
    expect(await read(knownHostsPath, 'utf8')).toContain(movedLine)

    await expect(connectSsh(options(replacement, knownHostsPath, 'accept-new'))).rejects.toThrow(/host key mismatch/i)
  })

  it('off does not create or read known_hosts', async () => {
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()
    const connection = await connectSsh(options(server, knownHostsPath, 'off'))
    await connection.close()
    await expect(access(knownHostsPath)).rejects.toThrow()
  })

  it('tracks key types separately for the same host', async () => {
    const server = await start()
    const knownHostsPath = await tempKnownHostsPath()
    const { writeFile, readFile: read } = await import('node:fs/promises')
    // An entry for the same host with a different key type must not be treated as a match.
    await writeFile(knownHostsPath, `[127.0.0.1]:${server.port} ssh-rsa AAAAB3NzaC1yc2E= bogus\n`, {
      mode: 0o600,
    })
    const connection = await connectSsh(options(server, knownHostsPath, 'accept-new'))
    await connection.close()
    const contents = await read(knownHostsPath, 'utf8')
    expect(contents).toContain(server.knownHostsLine())
  })
})
