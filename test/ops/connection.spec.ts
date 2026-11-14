import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AccountStore } from '../../src/accounts/store.js'
import { ConnectionPool, AccountConnectionError, type Transport } from '../../src/service/connection.js'
import { FakeSshConnection, fakeAccount } from '../helpers/fake-ssh.js'

let dir: string
let store: AccountStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-pool-'))
  store = new AccountStore({ dataDir: dir })
  await store.load()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ConnectionPool', () => {
  it('reuses one connection until it is dropped or closed', async () => {
    const account = await store.create({ host: 'h', username: 'root', authMethod: 'key', privateKey: 'pk' })
    const connections: FakeSshConnection[] = []
    const transport: Transport = {
      async connect() {
        const connection = new FakeSshConnection()
        connections.push(connection)
        return connection
      },
      async generateKeyPair() {
        return { privateKey: 'private', publicKey: 'ssh-ed25519 AAA test' }
      },
    }
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 }, transport)
    const first = await pool.acquire(account)
    const second = await pool.acquire(account)
    expect(first).toBe(second)
    expect(connections).toHaveLength(1)

    await first.close()
    const third = await pool.acquire(account)
    expect(third).not.toBe(first)
    expect(connections).toHaveLength(2)
    await pool.closeAll()
  })

  it('shares a concurrent connect instead of opening two sessions', async () => {
    const account = await store.create({ host: 'h', username: 'root', authMethod: 'key', privateKey: 'pk' })
    let connects = 0
    const transport: Transport = {
      async connect() {
        connects++
        await new Promise((resolve) => setTimeout(resolve, 10))
        return new FakeSshConnection()
      },
      async generateKeyPair() {
        return { privateKey: 'private', publicKey: 'ssh-ed25519 AAA test' }
      },
    }
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 }, transport)
    const [a, b, c] = await Promise.all([pool.acquire(account), pool.acquire(account), pool.acquire(account)])
    expect(connects).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    await pool.closeAll()
  })

  it('reports missing credentials as an account error', async () => {
    const account = await store.create({ host: 'h', username: 'root', authMethod: 'password' })
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 })
    await expect(pool.acquire(account)).rejects.toBeInstanceOf(AccountConnectionError)
  })

  it('installs a managed key and switches the account to key auth', async () => {
    const account = await store.create({ host: 'h', username: 'root', authMethod: 'password', password: 'pw' })
    const passwordConnection = new FakeSshConnection({
      commands: [
        { match: 'printf %s "$HOME"', result: { stdout: '/root' } },
        { match: 'set -e', result: { code: 0 } },
      ],
    })
    const keyConnection = new FakeSshConnection({ commands: [{ match: 'id -un', result: { stdout: 'root' } }] })
    const seenAuth: string[] = []
    const transport: Transport = {
      async connect(options) {
        const connection = options.auth.kind === 'password' ? passwordConnection : keyConnection
        if (options.auth.kind === 'privateKey') seenAuth.push(options.auth.privateKey)
        return connection
      },
      async generateKeyPair() {
        return { privateKey: 'generated-private-key', publicKey: 'ssh-ed25519 GENERATED dsh-hydro' }
      },
    }
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 }, transport)
    const result = await pool.bootstrapManagedKey(account, 'pw')
    expect(result.authorizedKeysPath).toBe('/root/.ssh/authorized_keys')
    expect(seenAuth).toContain('generated-private-key')
    const updated = store.get(account.id)
    expect(updated?.authMethod).toBe('key')
    expect(updated?.publicKey).toBe('ssh-ed25519 GENERATED dsh-hydro')
    expect(await store.getManagedPrivateKey(account.id)).toContain('generated-private-key')
    // The password connection was closed and the pool entry dropped.
    expect(passwordConnection.closed).toBe(true)
  })

  it('keeps password auth when key verification fails', async () => {
    const account = await store.create({ host: 'h', username: 'root', authMethod: 'password', password: 'pw' })
    const passwordConnection = new FakeSshConnection({
      commands: [
        { match: 'printf %s "$HOME"', result: { stdout: '/root' } },
        { match: 'set -e', result: { code: 0 } },
      ],
    })
    const transport: Transport = {
      async connect(options) {
        if (options.auth.kind === 'privateKey') throw new Error('key rejected')
        return passwordConnection
      },
      async generateKeyPair() {
        return { privateKey: 'private', publicKey: 'ssh-ed25519 AAA test' }
      },
    }
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 }, transport)
    await expect(pool.bootstrapManagedKey(account, 'pw')).rejects.toThrow(/key rejected/)
    expect(store.get(account.id)?.authMethod).toBe('password')
  })
})

describe('resolveAuth', () => {
  it('uses the stored password or managed private key', async () => {
    const passwordAccount = await store.create({ host: 'h', username: 'u', authMethod: 'password', password: 'pw' })
    await store.setManagedKey(passwordAccount.id, 'pk', 'ssh-ed25519 AAA test')
    const keyAccount = store.get(passwordAccount.id)!
    const pool = new ConnectionPool(store, { knownHostsPath: join(dir, 'known_hosts'), hostKeyPolicy: 'off', connectTimeoutMs: 1000 })
    void pool
    const { resolveAuth } = await import('../../src/service/connection.js')
    await expect(resolveAuth(keyAccount, store)).resolves.toMatchObject({ kind: 'privateKey' })
    const record = fakeAccount({ authMethod: 'password' })
    await store.create({ host: record.host, username: record.username, authMethod: 'key', privateKey: 'pk' })
    const keyOnly = store.list().find((item) => item.username === record.username)!
    await expect(resolveAuth(keyOnly, store)).resolves.toMatchObject({ kind: 'privateKey' })
  })
})
