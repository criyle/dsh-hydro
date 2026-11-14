import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SiteAccountStore } from '../../src/accounts/site-store.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-site-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })))
})

describe('SiteAccountStore', () => {
  it('supports multiple accounts per host with CRUD and an active account', async () => {
    const dir = await tempDir()
    const store = new SiteAccountStore({ dataDir: dir })
    await store.load()

    const superAdmin = await store.create({ hostId: 'acc-host', uname: 'admin', domain: 'system', role: 'superadmin' })
    const domainAdmin = await store.create({
      hostId: 'acc-host',
      label: 'class1 admin',
      uname: 'domainadmin',
      domain: 'class1',
      role: 'domain-admin',
      note: 'only class1',
    })
    expect(store.list('acc-host')).toHaveLength(2)
    expect(store.activeForHost('acc-host')?.id).toBe(superAdmin.id)

    await store.setActive(domainAdmin.id)
    expect(store.activeForHost('acc-host')?.id).toBe(domainAdmin.id)

    const updated = await store.update(domainAdmin.id, { domain: 'class2' })
    expect(updated.domain).toBe('class2')
    await store.setSessionToken(domainAdmin.id, 'sid-test')
    expect(store.getSessionToken(domainAdmin.id)).toBe('sid-test')
    expect(store.getSessionState(domainAdmin.id)).toBe('unknown')
    await store.setSessionState(domainAdmin.id, 'expired')
    expect(store.getSessionState(domainAdmin.id)).toBe('expired')
    expect(store.getSessionCheckedAt(domainAdmin.id)).not.toBeNull()

    expect(store.toSummary(updated, 'host label')).toMatchObject({
      hostId: 'acc-host',
      hostLabel: 'host label',
      role: 'domain-admin',
      hasSession: true,
      sessionState: 'expired',
      sessionCheckedAt: expect.any(String),
    })
    const sessionMode = (await stat(join(dir, 'site-sessions.json'))).mode & 0o777
    expect(sessionMode).toBe(0o600)

    expect(await store.remove(domainAdmin.id)).toBe(true)
    expect(store.list('acc-host')).toHaveLength(1)
    expect(store.getSessionToken(domainAdmin.id)).toBeUndefined()
    expect(store.activeSiteAccountId()).toBe(superAdmin.id)
  })

  it('rejects invalid input', async () => {
    const dir = await tempDir()
    const store = new SiteAccountStore({ dataDir: dir })
    await store.load()
    await expect(store.create({ hostId: '', uname: 'x' })).rejects.toThrow(/hostId/)
    await expect(store.create({ hostId: 'h', uname: '' })).rejects.toThrow(/用户名/)
    await expect(store.setSessionToken('missing', 'sid')).rejects.toThrow(/未知站点账号/)
  })

  it('never selects an active account from a different host', async () => {
    const dir = await tempDir()
    const store = new SiteAccountStore({ dataDir: dir })
    await store.load()
    const one = await store.create({ hostId: 'host-a', uname: 'a' })
    const two = await store.create({ hostId: 'host-b', uname: 'b' })
    await store.setActive(two.id)
    expect(store.activeForHost('host-a')?.id).toBe(one.id)
    expect(store.activeForHost('host-b')?.id).toBe(two.id)
    expect(store.activeForHost('host-c')).toBeUndefined()
  })
})
