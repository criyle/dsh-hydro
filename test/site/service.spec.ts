import { describe, expect, it, vi } from 'vitest'

import { createSiteService, hostData, hostWarnings } from '../../src/site/service.js'
import { buildDiagnosePrompt } from '../../src/site/diagnose.js'
import type { HydroSession } from '../../src/hydro/api.js'
import type { AccountContext } from '../../src/ops/types.js'
import { fakeOps, sampleAccount, sampleSiteAccount, sampleStatus } from '../helpers/fake-ops.js'
import { fakeContext } from '../helpers/fake-ssh.js'

/** Minimal fake Hydro HTTP session used by the content service. */
function fakeSession(): HydroSession & { calls: Array<{ kind: string; path: string }> } {
  const calls: Array<{ kind: string; path: string }> = []
  return {
    calls,
    baseUrl: 'http://127.0.0.1:1',
    async request() {
      return { status: 200, body: {}, headers: new Headers() }
    },
    async getJson<T>(path: string): Promise<T> {
      calls.push({ kind: 'get', path })
      if (path.includes('/domain/edit')) {
        return { current: { name: 'old', bulletin: '' }, settings: [{ key: 'name' }] } as T
      }
      return {} as T
    },
    async postForm<T>(path: string): Promise<T> {
      calls.push({ kind: 'form', path })
      if (path.includes('/problem/create')) return { pid: 'P1000' } as T
      return {} as T
    },
    async postMultipart<T>(path: string): Promise<T> {
      calls.push({ kind: 'multipart', path })
      return {} as T
    },
    async close() {
      calls.push({ kind: 'close', path: '' })
    },
  } as unknown as HydroSession & { calls: Array<{ kind: string; path: string }> }
}

function setup(overrides: Parameters<typeof fakeOps>[0] = {}) {
  const context = fakeContext()
  const session = fakeSession()
  let opened = 0
  const ops = fakeOps({
    listSiteAccounts: () => [sampleSiteAccount],
    getSiteAccountSummary: (id) => (id === sampleSiteAccount.id ? sampleSiteAccount : undefined),
    getSiteCredentials: vi.fn(async (id: string) => ({
      id,
      hostId: 'acc-1',
      uname: 'admin',
      sid: 'sid-test',
      domain: 'system',
    })) as never,
    getAccountSummary: (id) => (id === 'acc-1' ? sampleAccount : undefined),
    hydroPort: async () => 8888,
    withContext: (async (_id: string | undefined, fn: (context: AccountContext) => Promise<unknown>) => fn(context)) as never,
    collectStatus: vi.fn(async () => ({
      ...sampleStatus,
      warnings: [
        { severity: 'warning', code: 'hydro.ws.warn.abc', message: 'SMTP missing', hint: null },
        { severity: 'info', code: 'hydro.oplog.abc', message: 'standalone', hint: null },
        { severity: 'error', code: 'hydro.probe.failed', message: 'probe failed', hint: null },
      ],
    })) as never,
    queryDatabase: vi.fn(async (_id, spec) => ({
      documents: [{ _id: '1', title: `${spec.collection}-doc` }],
      truncated: false,
      collection: spec.collection,
    })) as never,
    ...overrides,
  })
  const service = createSiteService({
    ops,
    openSession: async () => {
      opened += 1
      return session
    },
  })
  return { service, ops, session, openedSessions: () => opened }
}

describe('site accounts', () => {
  it('lists and looks up site accounts', () => {
    const { service } = setup()
    expect(service.listAccounts()).toHaveLength(1)
    expect(service.getAccount('site-1')?.uname).toBe('admin')
    expect(service.activeSiteAccountId()).toBe('site-1')
  })

  it('creates a site account for an existing host', async () => {
    const { service, ops } = setup()
    const saved = await service.saveAccount({
      hostId: 'acc-1',
      label: 'limited',
      uname: 'domainadmin',
      domain: 'class1',
      role: 'domain-admin',
    })
    expect(saved.uname).toBe('domainadmin')
    expect(ops.addSiteAccount).toHaveBeenCalledWith(expect.objectContaining({
      hostId: 'acc-1',
      uname: 'domainadmin',
      domain: 'class1',
      role: 'domain-admin',
    }))
    expect(ops.addSiteAccount).not.toHaveBeenCalledWith(expect.objectContaining({ password: expect.anything() }))
  })

  it('creates a site account without asking for a password', async () => {
    const { service } = setup()
    const saved = await service.saveAccount({ hostId: 'acc-1', uname: 'x' })
    expect(saved.uname).toBe('x')
  })

  it('updates a site account and drops its cached session on username change', async () => {
    const { service, ops, session, openedSessions } = setup()
    await service.inspect('site-1')
    expect(openedSessions()).toBe(1)
    await service.saveAccount({ id: 'site-1', hostId: 'acc-1', uname: 'newadmin' })
    expect(ops.updateSiteAccount).toHaveBeenCalledWith('site-1', expect.objectContaining({ uname: 'newadmin' }))
    expect(session.calls.at(-1)?.kind).toBe('close')
  })

  it('reports missing and expired browser sessions', async () => {
    const { service: missingService } = setup({
      getSiteAccountSummary: (id) => (id === sampleSiteAccount.id
        ? { ...sampleSiteAccount, hasSession: false, sessionCapturedAt: null }
        : undefined),
    })
    await expect(missingService.sessionStatus('site-1')).resolves.toMatchObject({ state: 'missing' })

    const { service: expiredService, session } = setup()
    session.request = (async () => ({ status: 302, body: '', headers: new Headers({ location: '/login' }) })) as never
    await expect(expiredService.sessionStatus('site-1')).resolves.toMatchObject({ state: 'expired' })
  })

  it('removes a site account and closes its session', async () => {
    const { service, ops, session } = setup()
    await service.inspect('site-1')
    await service.removeAccount('site-1')
    expect(ops.removeSiteAccount).toHaveBeenCalledWith('site-1')
    expect(session.calls.at(-1)?.kind).toBe('close')
  })
})

describe('content service', () => {
  it('inspects warnings and domain config, then updates the domain', async () => {
    const { service, session } = setup()
    const inspected = await service.inspect('site-1')
    expect(inspected.siteAccountId).toBe('site-1')
    expect(inspected.hostId).toBe('acc-1')
    expect(inspected.warnings.map((warning) => warning.code)).toEqual(['hydro.ws.warn.abc', 'hydro.oplog.abc'])
    expect(inspected.domain.current).toMatchObject({ name: 'old' })
    await service.setDomain('site-1', { name: 'new' }, { share: true })
    expect(session.calls.some((call) => call.path.includes('/domain/edit'))).toBe(true)
    expect(session.calls.at(-1)?.kind).toBe('form')
  })

  it('reuses one Hydro web session per site account and closes it on dispose', async () => {
    const { service, session, openedSessions } = setup()
    await service.inspect('site-1')
    await service.setDomain('site-1', { name: 'new' })
    expect(openedSessions()).toBe(1)
    await service.dispose()
    expect(session.calls.at(-1)?.kind).toBe('close')
  })

  it('reconnects once when a cached session died because a host action reset the tunnels', async () => {
    const context = fakeContext()
    const first = fakeSession()
    const second = fakeSession()
    let opened = 0
    const ops = fakeOps({
      listSiteAccounts: () => [sampleSiteAccount],
      getSiteAccountSummary: (id) => (id === sampleSiteAccount.id ? sampleSiteAccount : undefined),
      getSiteCredentials: vi.fn(async () => ({
        id: 'site-1', hostId: 'acc-1', uname: 'admin', sid: 'sid-test', domain: 'system',
      })) as never,
      hydroPort: async () => 8888,
      withContext: (async (_id: string | undefined, fn: (c: AccountContext) => Promise<unknown>) => fn(context)) as never,
      collectStatus: vi.fn(async () => ({ ...sampleStatus, warnings: [] })) as never,
    })
    const service = createSiteService({
      ops,
      openSession: async () => {
        opened += 1
        return opened === 1 ? first : second
      },
    })
    await service.inspect('site-1')
    const originalGet = first.getJson.bind(first)
    let threw = false
    first.getJson = async <T,>(path: string): Promise<T> => {
      if (!threw && path.includes('/domain/edit')) {
        threw = true
        throw new TypeError('fetch failed')
      }
      return originalGet<T>(path)
    }
    const again = await service.inspect('site-1')
    expect(again.siteAccountId).toBe('site-1')
    expect(opened).toBe(2)
    expect(first.calls.at(-1)?.kind).toBe('close')
  })

  it('imports a Hydro ZIP package through the multipart import route', async () => {
    const { service, session } = setup()
    const result = await service.importHydroZip('site-1', {
      filename: 'problems.zip',
      data: Buffer.from('PK'),
      hidden: true,
      preferredPrefix: 'ABC',
    })
    expect(result.ok).toBe(true)
    const multipart = session.calls.find((call) => call.kind === 'multipart')
    expect(multipart?.path).toBe('/d/system/problem/import/hydro')
  })

  it('lists domains for the account and includes the current one', async () => {
    const { service } = setup({
      queryDatabase: vi.fn(async () => ({
        documents: [{ _id: 'system', name: 'System' }, { _id: 'class1' }],
        truncated: false,
        collection: 'domain',
      })) as never,
    })
    const result = await service.listDomains('site-1')
    expect(result.domains).toEqual([
      { id: 'system', name: 'System' },
      { id: 'class1', name: 'class1' },
    ])
  })

  it('builds context-aware edit prompts for problems, contests and domains', async () => {
    const { service } = setup()
    const problem = await service.authoringPrompt('site-1', {
      kind: 'problem', problemId: 'P1000', action: '修改题面', requirements: '改成 A+B',
    })
    expect(problem).toContain('修改题目 P1000')
    expect(problem).toContain('hydro_problem action=edit')
    const contest = await service.authoringPrompt('site-1', {
      kind: 'contest', contestId: 'C1', requirements: '加一道题',
    })
    expect(contest).toContain('修改比赛 C1')
    expect(contest).toContain('hydro_contest')
    const bulletin = await service.authoringPrompt('site-1', {
      kind: 'domain-bulletin', requirements: '欢迎新同学',
    })
    expect(bulletin).toContain('hydro_domain_config')
    expect(bulletin).toContain('bulletin')
    const permissions = await service.authoringPrompt('site-1', { kind: 'domain-permissions' })
    expect(permissions).toContain('hydro_domain_roles')
  })

  it('lists recent problems and contests from the Hydro 5 document collection', async () => {
    const { service, ops } = setup()
    const problems = await service.listCollection('site-1', 'problem', 5)
    expect(problems.collection).toBe('problem')
    expect(ops.queryDatabase).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      collection: 'document',
      filter: { docType: 10 },
    }))
    const contests = await service.listCollection('site-1', 'contest')
    expect(ops.queryDatabase).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      collection: 'document',
      filter: { docType: 30 },
    }))
    expect(contests.collection).toBe('contest')
  })

  it('builds a Chinese authoring prompt with host/site account/domain/tool workflow', async () => {
    const { service } = setup()
    const problem = await service.authoringPrompt('site-1', {
      kind: 'problem',
      title: '求和',
      requirements: 'n <= 1e5',
    })
    expect(problem).toContain('求和')
    expect(problem).toContain('n <= 1e5')
    expect(problem).toContain('hydro_problem')
    expect(problem).toContain('域：system')
    expect(problem).toContain('权限：superadmin')
    const contest = await service.authoringPrompt('site-1', { kind: 'contest' })
    expect(contest).toContain('hydro_contest')
  })
})

describe('host helpers', () => {
  it('filters system-check warnings', async () => {
    const { ops } = setup()
    const result = await hostWarnings(ops, 'acc-1')
    expect(result.warnings.map((warning) => warning.code)).toEqual(['hydro.ws.warn.abc', 'hydro.oplog.abc'])
  })

  it('collects collections/find/oplog through the read-only helpers', async () => {
    const ops = fakeOps({
      listCollections: vi.fn(async () => [{ name: 'user', count: 1, sizeBytes: 2 }]) as never,
      queryDatabase: vi.fn(async () => ({ documents: [{ _id: 1 }], truncated: false, collection: 'user' })) as never,
      queryOplog: vi.fn(async () => ({ source: 'hydro', entries: [], fallback: false, note: null, mongo: null })) as never,
    })
    expect((await hostData(ops, { hostId: 'h', action: 'collections' })).documents).toHaveLength(1)
    const find = await hostData(ops, { hostId: 'h', action: 'find', collection: 'user', filter: { a: 1 }, limit: 5 })
    expect(find.collection).toBe('user')
    const oplog = await hostData(ops, { hostId: 'h', action: 'oplog', source: 'hydro', limit: 5 })
    expect(oplog.action).toBe('oplog')
  })
})

describe('diagnose prompt', () => {
  it('includes host identity, task, error, tail and safety rules', () => {
    const prompt = buildDiagnosePrompt({
      hostLabel: 'Demo LXC',
      address: '203.0.113.10:22',
      username: 'root',
      kind: 'install',
      message: 'installer exited 1',
      output: 'line1\nline2',
    })
    expect(prompt).toContain('Demo LXC')
    expect(prompt).toContain('root@203.0.113.10:22')
    expect(prompt).toContain('installer exited 1')
    expect(prompt).toContain('line2')
    expect(prompt).toContain('hydro_status')
    expect(prompt).toContain('不要擅自重装')
  })
})
