import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AccountStore } from '../src/accounts/store.js'

let dir: string
let store: AccountStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-store-'))
  store = new AccountStore({ dataDir: dir })
  await store.load()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AccountStore', () => {
  it('creates, lists and never persists bootstrap passwords', async () => {
    const account = await store.create({
      host: 'example.org',
      username: 'root',
      authMethod: 'password',
      password: 'secret',
    })
    expect(account.id).toMatch(/^acc-[0-9a-f]{12}$/)
    expect(account.label).toBe('root@example.org')
    expect(store.list()).toHaveLength(1)
    expect(store.activeAccountId()).toBe(account.id)

    expect(store.canConnect(account.id)).toBe(false)
    const reloaded = new AccountStore({ dataDir: dir })
    await reloaded.load()
    expect(reloaded.get(account.id)?.username).toBe('root')
    expect(reloaded.canConnect(account.id)).toBe(false)

    const mode = (await stat(join(dir, 'accounts.json'))).mode & 0o777
    expect(mode).toBe(0o600)
    const raw = await readFile(join(dir, 'accounts.json'), 'utf8')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('sudo')
  })

  it('persists managed key pairs and exposes secret-free summaries', async () => {
    const account = await store.create({ host: 'h', username: 'u', authMethod: 'password', password: 'pw' })
    expect(store.canConnect(account.id)).toBe(false)
    await store.setManagedKey(account.id, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n', 'ssh-ed25519 AAAACC dsh-hydro')
    const updated = store.get(account.id)
    expect(updated?.authMethod).toBe('key')
    expect(updated?.privateKeyPath).toBe(join(dir, 'keys', account.id))
    expect(await store.getManagedPrivateKey(account.id)).toContain('OPENSSH')
    expect(await store.getManagedPublicKey(account.id)).toBe('ssh-ed25519 AAAACC dsh-hydro')
    const summary = store.toSummary(updated!)
    expect(summary.hasManagedKey).toBe(true)
    expect(JSON.stringify(summary)).not.toContain('pw')
  })

  it('removes accounts and their keys, keeping active id valid', async () => {
    const first = await store.create({ host: 'a', username: 'u', authMethod: 'password', password: 'p' })
    const second = await store.create({ host: 'b', username: 'u', authMethod: 'password', password: 'p' })
    await store.setManagedKey(second.id, 'key', 'ssh-ed25519 AAA b')
    await store.setActive(second.id)
    expect(await store.remove(second.id)).toBe(true)
    expect(store.list().map((account) => account.id)).toEqual([first.id])
    expect(store.activeAccountId()).toBe(first.id)
    expect(await store.getManagedPrivateKey(second.id)).toBeUndefined()
  })

  it('creates a custom private key and switches auth method', async () => {
    const account = await store.create({
      host: 'a',
      username: 'u',
      authMethod: 'password',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n',
      password: 'p',
    })
    const reloaded = new AccountStore({ dataDir: dir })
    await reloaded.load()
    expect(reloaded.get(account.id)?.authMethod).toBe('key')
    expect(await reloaded.getManagedPrivateKey(account.id)).toContain('xyz')
  })

  it('rejects invalid input and unknown accounts', async () => {
    await expect(store.create({ host: ' ', username: 'u', authMethod: 'password', password: 'p' })).rejects.toThrow()
    await expect(store.create({ host: 'a', username: 'u', authMethod: 'password', password: 'p', port: 0 })).rejects.toThrow()
    await expect(store.update('missing', { label: 'x' })).rejects.toThrow()
    await expect(store.setActive('missing')).rejects.toThrow()
    expect(await store.remove('missing')).toBe(false)
  })

  it('serializes concurrent writes without corrupting the file', async () => {
    const account = await store.create({ host: 'a', username: 'u', authMethod: 'password', password: 'p' })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.update(account.id, { label: `label-${index}` })),
    )
    const reloaded = new AccountStore({ dataDir: dir })
    await reloaded.load()
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]?.label).toMatch(/^label-\d+$/)
  })
})
