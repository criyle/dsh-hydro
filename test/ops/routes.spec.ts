import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import type { HydroOpsApi } from '../../src/ops/hydro-ops.js'
import { ApiPaths } from '../../src/shared/api.js'
import { registerHydroRoutes, type RouteContext } from '../../src/routes.js'
import type { SiteService } from '../../src/site/service.js'
import { fakeOps, sampleAccount, sampleSiteAccount } from '../helpers/fake-ops.js'

interface Captured {
  status: number | null
  headers: Record<string, string>
  body: string
  ended: boolean
}

function makeResponse(): { response: unknown; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, body: '', ended: false }
  const response = {
    writableEnded: false,
    destroyed: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      if (headers !== undefined) captured.headers = headers
      return this
    },
    write(chunk?: string) {
      captured.body += chunk ?? ''
      return true
    },
    end(chunk?: string) {
      captured.body += chunk ?? ''
      captured.ended = true
      this.writableEnded = true
    },
  }
  return { response, captured }
}

function makeRequest(method: string, body?: unknown, headers: Record<string, string> = {}): unknown {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text)])
  return Object.assign(stream, { method, headers: { host: '127.0.0.1:3080', ...headers } })
}

function makeContext() {
  const handlers = new Map<string, (request: never, response: never) => Promise<void>>()
  const ctx = {
    get: () => undefined,
    effect: (factory: () => () => void) => factory(),
    webServer: {
      register(route: { path: string; handler: (request: never, response: never) => Promise<void> }) {
        handlers.set(route.path, route.handler)
        return () => undefined
      },
    },
  }
  return { ctx: ctx as unknown as RouteContext, handlers }
}

async function call(
  handlers: Map<string, (request: never, response: never) => Promise<void>>,
  path: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Captured> {
  const handler = handlers.get(path)
  if (handler === undefined) throw new Error(`no route ${path}`)
  const { response, captured } = makeResponse()
  await handler(makeRequest(method, body, headers) as never, response as never)
  return captured
}

function fakeSite(overrides: Partial<SiteService> = {}): SiteService {
  return {
    listAccounts: () => [sampleSiteAccount],
    getAccount: (id) => (id === sampleSiteAccount.id ? sampleSiteAccount : undefined),
    saveAccount: async (input) => {
      if (input.id === undefined) {
        if (input.uname === undefined || input.uname.trim() === '') throw new Error('请填写 Hydro 管理员用户名')
      }
      return {
        ...sampleSiteAccount,
        uname: input.uname ?? sampleSiteAccount.uname,
        label: input.label ?? sampleSiteAccount.label,
        domain: input.domain ?? sampleSiteAccount.domain,
        role: input.role ?? sampleSiteAccount.role,
      }
    },
    removeAccount: async () => true,
    setActive: async () => undefined,
    activeSiteAccountId: () => sampleSiteAccount.id,
    inspect: async (siteAccountId) => ({
      siteAccountId,
      hostId: 'acc-1',
      warnings: [],
      domain: { current: { name: 'x' }, settings: {} },
      collectedAt: '2026-01-01T00:00:00.000Z',
    }),
    sessionStatus: async (siteAccountId) => ({
      siteAccountId,
      state: 'active' as const,
      capturedAt: '2026-01-01T00:00:00.000Z',
      message: null,
    }),
    setDomain: async () => undefined,
    importHydroZip: async () => ({ ok: true, message: 'imported' }),
    listDomains: async () => ({ domains: [{ id: 'system', name: 'System' }, { id: 'class1', name: 'Class 1' }] }),
    listCollection: async (_id, collection) => ({ collection, documents: [{ title: collection }] }),
    authoringPrompt: async (_id, input) => `prompt:${input.kind}`,
    dispose: async () => undefined,
    ...overrides,
  }
}

describe('host operation routes', () => {
  it('guards install/upgrade/service mutations with confirm', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const rejected = await call(handlers, ApiPaths.hostsInstall, 'POST', { id: 'acc-1' })
    expect(rejected.status).toBe(400)
    expect(ops.install).not.toHaveBeenCalled()

    const installed = await call(handlers, ApiPaths.hostsInstall, 'POST', { id: 'acc-1', judge: true, confirm: true })
    expect(installed.status).toBe(200)
    expect(ops.install).toHaveBeenCalledWith('acc-1', { judge: true })

    const upgradePlan = await call(handlers, ApiPaths.hostsUpgrade, 'POST', { id: 'acc-1' })
    expect(upgradePlan.status).toBe(200)
    expect(JSON.parse(upgradePlan.body)).toMatchObject({ result: { ok: true } })
    expect(ops.upgrade).toHaveBeenCalledWith('acc-1', { dryRun: true })

    const upgradeNoConfirm = await call(handlers, ApiPaths.hostsUpgrade, 'POST', { id: 'acc-1', dryRun: false })
    expect(upgradeNoConfirm.status).toBe(400)
    const upgrade = await call(handlers, ApiPaths.hostsUpgrade, 'POST', { id: 'acc-1', dryRun: false, confirm: true })
    expect(upgrade.status).toBe(200)
    expect(ops.upgrade).toHaveBeenCalledWith('acc-1', { dryRun: false })

    const serviceStatus = await call(handlers, ApiPaths.hostsService, 'POST', { id: 'acc-1', target: 'hydro', action: 'status' })
    expect(serviceStatus.status).toBe(200)
    const serviceNoConfirm = await call(handlers, ApiPaths.hostsService, 'POST', { id: 'acc-1', target: 'hydro', action: 'restart' })
    expect(serviceNoConfirm.status).toBe(400)
    const serviceRestart = await call(handlers, ApiPaths.hostsService, 'POST', { id: 'acc-1', target: 'hydro', action: 'restart', confirm: true })
    expect(serviceRestart.status).toBe(200)
    const badTarget = await call(handlers, ApiPaths.hostsService, 'POST', { id: 'acc-1', target: 'db', action: 'status' })
    expect(badTarget.status).toBe(400)
  })

  it('returns system-check warnings and read-only data', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      collectStatus: vi.fn(async () => ({
        accountId: 'acc-1',
        collectedAt: '2026-01-01T00:00:00.000Z',
        reachable: true,
        error: null,
        host: null,
        hydro: { installed: true, installDir: null, version: null, latestVersion: null, updateAvailable: false, service: null, url: null, health: null },
        plugins: [],
        judge: null,
        mongo: null,
        warnings: [{ severity: 'warning' as const, code: 'hydro.ws.warn.1', message: 'SMTP', hint: null }],
      })) as never,
      listCollections: vi.fn(async () => [{ name: 'user', count: 1, sizeBytes: 2 }]) as never,
      queryDatabase: vi.fn(async () => ({ documents: [{ _id: 1 }], truncated: false, collection: 'user' })) as never,
      queryOplog: vi.fn(async () => ({ source: 'hydro' as const, entries: [], fallback: false, note: null, mongo: null })) as never,
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const warnings = await call(handlers, ApiPaths.hostsWarnings, 'POST', { id: 'acc-1' })
    expect(warnings.status).toBe(200)
    expect((JSON.parse(warnings.body) as { warnings: unknown[] }).warnings).toHaveLength(1)

    const collections = await call(handlers, ApiPaths.hostsData, 'POST', { id: 'acc-1', action: 'collections' })
    expect(collections.status).toBe(200)
    const find = await call(handlers, ApiPaths.hostsData, 'POST', { id: 'acc-1', action: 'find', collection: 'user', filter: { a: 1 }, limit: 3 })
    expect((JSON.parse(find.body) as { collection: string }).collection).toBe('user')
    const badAction = await call(handlers, ApiPaths.hostsData, 'POST', { id: 'acc-1', action: 'delete' })
    expect(badAction.status).toBe(400)
  })
})

describe('site routes', () => {
  it('serves site accounts and creates/edits them', async () => {
    const { ctx, handlers } = makeContext()
    const site = fakeSite()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site })

    const list = await call(handlers, ApiPaths.siteAccounts, 'GET')
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body)).toMatchObject({
      accounts: [{ id: 'site-1', hostId: 'acc-1', uname: 'admin' }],
      activeSiteAccountId: 'site-1',
    })

    const created = await call(handlers, ApiPaths.siteSave, 'POST', {
      hostId: 'acc-1', uname: 'domainadmin', domain: 'class1', role: 'domain-admin',
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ account: { uname: 'domainadmin' } })

    const edited = await call(handlers, ApiPaths.siteSave, 'POST', {
      id: 'site-1', hostId: 'acc-1', label: 'renamed',
    })
    expect(edited.status).toBe(200)

    const badRole = await call(handlers, ApiPaths.siteSave, 'POST', {
      hostId: 'acc-1', uname: 'x', role: 'owner',
    })
    expect(badRole.status).toBe(400)

    const noPassword = await call(handlers, ApiPaths.siteSave, 'POST', { hostId: 'acc-1', uname: 'x' })
    expect(noPassword.status).toBe(200)
  })

  it('removes and activates site accounts', async () => {
    const { ctx, handlers } = makeContext()
    const site = fakeSite({
      saveAccount: async () => sampleSiteAccount,
    })
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site })
    const activated = await call(handlers, ApiPaths.siteActivate, 'POST', { id: 'site-1' })
    expect(activated.status).toBe(200)
    expect(JSON.parse(activated.body)).toEqual({ activeSiteAccountId: 'site-1' })

    const removed = await call(handlers, ApiPaths.siteRemove, 'POST', { id: 'site-1' })
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.body)).toEqual({ removed: true })
  })

  it('inspects a site account by id', async () => {
    const { ctx, handlers } = makeContext()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site: fakeSite() })
    const inspected = await call(handlers, ApiPaths.siteInspect, 'POST', { siteAccountId: 'site-1' })
    expect(inspected.status).toBe(200)
    expect(JSON.parse(inspected.body)).toMatchObject({
      siteAccountId: 'site-1',
      hostId: 'acc-1',
      domain: { current: { name: 'x' } },
    })
    const missing = await call(handlers, ApiPaths.siteInspect, 'POST', { siteAccountId: 'site-x' })
    expect(missing.status).toBe(404)
  })

  it('enforces readonly accounts and confirm rules for writes', async () => {
    const { ctx, handlers } = makeContext()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site: fakeSite() })
    const noConfirm = await call(handlers, ApiPaths.siteDomainSet, 'POST', { siteAccountId: 'site-1', values: { name: 'n' } })
    expect(noConfirm.status).toBe(400)
    const setDomain = await call(handlers, ApiPaths.siteDomainSet, 'POST', {
      siteAccountId: 'site-1', values: { name: 'n' }, confirm: true,
    })
    expect(setDomain.status).toBe(200)

    const readonly = makeContext()
    registerHydroRoutes({
      ctx: readonly.ctx,
      ops: fakeOps(),
      version: '0.1.0',
      site: fakeSite({ getAccount: () => ({ ...sampleSiteAccount, readonly: true }) }),
    })
    const refused = await call(readonly.handlers, ApiPaths.siteDomainSet, 'POST', {
      siteAccountId: 'site-1', values: { name: 'n' }, confirm: true,
    })
    expect(refused.status).toBe(403)
  })

  it('lists collections and builds authoring prompts', async () => {
    const { ctx, handlers } = makeContext()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site: fakeSite() })
    const problems = await call(handlers, ApiPaths.siteCollection, 'POST', { siteAccountId: 'site-1', collection: 'problem' })
    expect(problems.status).toBe(200)
    const contests = await call(handlers, ApiPaths.siteCollection, 'POST', { siteAccountId: 'site-1', collection: 'contest' })
    expect(JSON.parse(contests.body)).toMatchObject({ collection: 'contest' })
    const bad = await call(handlers, ApiPaths.siteCollection, 'POST', { siteAccountId: 'site-1', collection: 'user' })
    expect(bad.status).toBe(400)
    const prompt = await call(handlers, ApiPaths.siteAuthoringPrompt, 'POST', { siteAccountId: 'site-1', kind: 'problem' })
    expect(JSON.parse(prompt.body)).toEqual({ prompt: 'prompt:problem' })
  })
})

describe('operator settings and visual service overview', () => {
  it('reads and toggles the global read-only switch', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      setGlobalReadonly: vi.fn(async (readonly: boolean) => ({ readonlyMode: readonly, updatedAt: '2026-01-01T00:00:00.000Z' })) as never,
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const settings = await call(handlers, ApiPaths.settings, 'GET')
    expect(settings.status).toBe(200)
    expect(JSON.parse(settings.body)).toMatchObject({ readonlyMode: false })

    const bad = await call(handlers, ApiPaths.settingsReadonly, 'POST', { readonly: 'yes' })
    expect(bad.status).toBe(400)
    const toggled = await call(handlers, ApiPaths.settingsReadonly, 'POST', { readonly: true })
    expect(toggled.status).toBe(200)
    expect(ops.setGlobalReadonly).toHaveBeenCalledWith(true)
    expect(JSON.parse(toggled.body)).toMatchObject({ updatedAt: '2026-01-01T00:00:00.000Z' })
  })

  it('returns the structured pm2/service overview', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const overview = await call(handlers, ApiPaths.hostsServices, 'POST', { id: 'acc-1' })
    expect(overview.status).toBe(200)
    expect(JSON.parse(overview.body)).toMatchObject({
      manager: 'pm2',
      processes: [{ name: 'hydrooj', target: 'hydro', cpuPercent: 3 }],
      hydro: { version: '5.1.0', health: { ok: true } },
    })
    expect(ops.serviceOverview).toHaveBeenCalledWith('acc-1')
  })

  it('forwards oplog filters to the host data helper', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      queryOplog: vi.fn(async (_id, spec) => ({
        source: 'hydro',
        entries: [],
        fallback: false,
        note: null,
        mongo: null,
        spec,
      })) as never,
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const result = await call(handlers, ApiPaths.hostsData, 'POST', {
      id: 'acc-1',
      action: 'oplog',
      source: 'hydro',
      type: 'problem.edit',
      contains: 'P1000',
      limit: 5,
    })
    expect(result.status).toBe(200)
    expect(ops.queryOplog).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      source: 'hydro',
      type: 'problem.edit',
      contains: 'P1000',
      limit: 5,
    }))
  })
})

describe('phase-2 host diagnostics and content helpers', () => {
  it('returns metrics, issues, packages, address and process logs', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const metrics = await call(handlers, ApiPaths.hostsMetrics, 'POST', { id: 'acc-1' })
    expect(metrics.status).toBe(200)
    expect(JSON.parse(metrics.body)).toMatchObject({ cpu: { usagePercent: 12.5 }, judge: { queueDepth: 3 } })

    const issues = await call(handlers, ApiPaths.hostsIssues, 'POST', { id: 'acc-1' })
    expect(issues.status).toBe(200)
    expect((JSON.parse(issues.body) as { issues: unknown[] }).issues).toHaveLength(1)

    const packages = await call(handlers, ApiPaths.hostsPackages, 'POST', { id: 'acc-1' })
    expect(packages.status).toBe(200)
    expect(JSON.parse(packages.body)).toMatchObject({ packages: [{ name: 'hydrooj', updateAvailable: true }] })

    const address = await call(handlers, ApiPaths.hostsAddress, 'POST', { id: 'acc-1' })
    expect(JSON.parse(address.body)).toEqual({ url: 'http://127.0.0.1:1234', source: 'proxy' })

    const logs = await call(handlers, ApiPaths.hostsLogs, 'POST', { id: 'acc-1', process: 'hydrooj', lines: 50 })
    expect(logs.status).toBe(200)
    expect(JSON.parse(logs.body)).toMatchObject({ process: 'hydrooj', stdout: 'out' })
    expect(ops.processLogs).toHaveBeenCalledWith('acc-1', { process: 'hydrooj', lines: 50 })

    const badLogs = await call(handlers, ApiPaths.hostsLogs, 'POST', { id: 'acc-1' })
    expect(badLogs.status).toBe(400)
  })

  it('guards Nix maintenance with confirm and validates the action', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const noConfirm = await call(handlers, ApiPaths.hostsNix, 'POST', { id: 'acc-1', action: 'set-mirror', mirror: 'https://mirror.example' })
    expect(noConfirm.status).toBe(400)
    const result = await call(handlers, ApiPaths.hostsNix, 'POST', {
      id: 'acc-1', action: 'set-mirror', mirror: 'https://mirror.example', confirm: true,
    })
    expect(result.status).toBe(200)
    expect(ops.nixMaintenance).toHaveBeenCalledWith('acc-1', { action: 'set-mirror', mirror: 'https://mirror.example' })

    const badPackage = await call(handlers, ApiPaths.hostsNix, 'POST', {
      id: 'acc-1', action: 'upgrade-package', package: 'python3', confirm: true,
    })
    expect(badPackage.status).toBe(400)
  })

  it('applies allow-listed known-issue fixes', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const noConfirm = await call(handlers, ApiPaths.hostsIssueFix, 'POST', { id: 'acc-1', fix: 'restart-service', target: 'sandbox' })
    expect(noConfirm.status).toBe(400)
    const fixed = await call(handlers, ApiPaths.hostsIssueFix, 'POST', {
      id: 'acc-1', fix: 'restart-service', target: 'sandbox', confirm: true,
    })
    expect(fixed.status).toBe(200)
    expect(ops.fixIssue).toHaveBeenCalledWith('acc-1', { fix: 'restart-service', target: 'sandbox' })

    const plugin = await call(handlers, ApiPaths.hostsIssueFix, 'POST', {
      id: 'acc-1', fix: 'install-ui-plugin', confirm: true,
    })
    expect(plugin.status).toBe(200)
    expect(ops.fixIssue).toHaveBeenCalledWith('acc-1', { fix: 'install-ui-plugin' })

    const bad = await call(handlers, ApiPaths.hostsIssueFix, 'POST', { id: 'acc-1', fix: 'rm-rf', confirm: true })
    expect(bad.status).toBe(400)
  })

  it('passes selected packages to the upgrade route and stream', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    await call(handlers, ApiPaths.hostsUpgrade, 'POST', { id: 'acc-1', dryRun: true, packages: ['hydrooj'] })
    expect(ops.upgrade).toHaveBeenCalledWith('acc-1', { dryRun: true, packages: ['hydrooj'] })

    await call(handlers, ApiPaths.hostsUpgradeStream, 'POST', { id: 'acc-1', confirm: true, packages: ['hydrooj'] })
    expect(ops.upgrade).toHaveBeenLastCalledWith('acc-1', expect.objectContaining({ dryRun: false, packages: ['hydrooj'] }))
  })

  it('reports the current embedded browser context', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const context = await call(handlers, ApiPaths.hostsContext, 'POST', { id: 'acc-1' })
    expect(context.status).toBe(200)
    expect(JSON.parse(context.body)).toMatchObject({ kind: 'problem', id: 'P1000', domain: 'system' })
  })

  it('serves site domains and imports a Hydro ZIP', async () => {
    const { ctx, handlers } = makeContext()
    const site = fakeSite()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0', site })

    const domains = await call(handlers, ApiPaths.siteDomains, 'POST', { siteAccountId: 'site-1' })
    expect(domains.status).toBe(200)
    expect(JSON.parse(domains.body)).toMatchObject({ domains: [{ id: 'system' }, { id: 'class1' }] })

    const zip = await call(handlers, ApiPaths.siteQuestionsImportZip, 'POST', {
      siteAccountId: 'site-1',
      filename: 'problems.zip',
      data: Buffer.from('PK-test').toString('base64'),
      hidden: true,
    })
    expect(zip.status).toBe(200)
    expect(JSON.parse(zip.body)).toMatchObject({ ok: true })
    const badExt = await call(handlers, ApiPaths.siteQuestionsImportZip, 'POST', {
      siteAccountId: 'site-1', filename: 'x.tar', data: 'AAAA',
    })
    expect(badExt.status).toBe(400)
  })
})

describe('Caddy, backups and Hydro CLI routes', () => {
  it('reads and writes Caddy config with confirmation', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const read = await call(handlers, ApiPaths.hostsCaddy, 'POST', { id: 'acc-1', action: 'read' })
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body)).toMatchObject({ path: '/etc/caddy/Caddyfile', running: true })
    const noConfirm = await call(handlers, ApiPaths.hostsCaddy, 'POST', {
      id: 'acc-1', action: 'write', path: '/etc/caddy/Caddyfile', content: ':80 {}',
    })
    expect(noConfirm.status).toBe(400)
    const write = await call(handlers, ApiPaths.hostsCaddy, 'POST', {
      id: 'acc-1', action: 'write', path: '/etc/caddy/Caddyfile', content: ':80 {}', reload: true, confirm: true,
    })
    expect(write.status).toBe(200)
    expect(ops.writeCaddy).toHaveBeenCalledWith('acc-1', { path: '/etc/caddy/Caddyfile', content: ':80 {}', reload: true })
    const reload = await call(handlers, ApiPaths.hostsCaddy, 'POST', { id: 'acc-1', action: 'reload', confirm: true })
    expect(reload.status).toBe(200)
    expect(ops.applyCaddy).toHaveBeenCalledWith('acc-1', 'reload')
  })

  it('lists and manages Hydro plugins', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const list = await call(handlers, ApiPaths.hostsPlugins, 'POST', { id: 'acc-1', action: 'list' })
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body)).toMatchObject({ plugins: [{ name: '@hydrooj/ui-default', enabled: true }] })
    const noConfirm = await call(handlers, ApiPaths.hostsPlugins, 'POST', {
      id: 'acc-1', action: 'install', name: '@hydrooj/fps-importer',
    })
    expect(noConfirm.status).toBe(400)
    const installed = await call(handlers, ApiPaths.hostsPlugins, 'POST', {
      id: 'acc-1', action: 'install', name: '@hydrooj/fps-importer', confirm: true,
    })
    expect(installed.status).toBe(200)
    expect(ops.managePlugin).toHaveBeenCalledWith('acc-1', { action: 'install', name: '@hydrooj/fps-importer' })
    const bad = await call(handlers, ApiPaths.hostsPlugins, 'POST', { id: 'acc-1', action: 'list', name: '' })
    expect(bad.status).toBe(200)
  })

  it('lists backups and streams Hydro CLI output', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const backups = await call(handlers, ApiPaths.hostsBackups, 'POST', { id: 'acc-1' })
    expect(backups.status).toBe(200)
    expect(JSON.parse(backups.body)).toMatchObject({ backups: [{ name: 'backup-1.zip' }] })

    const streamed = await call(handlers, ApiPaths.hostsCliStream, 'POST', { id: 'acc-1', action: 'run', command: 'backup' })
    expect(streamed.status).toBe(200)
    expect(streamed.body).toContain('event: output')
    expect(streamed.body).toContain('running hydrooj backup')
    expect(streamed.body).toContain('event: result')
    expect(ops.runCli).toHaveBeenCalledWith('acc-1', 'backup', expect.any(Function))
  })

  it('requires explicit confirmation for restore and rejects arbitrary shell syntax', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const noConfirm = await call(handlers, ApiPaths.hostsCliStream, 'POST', {
      id: 'acc-1', action: 'restore', filename: 'backup-1.zip',
    })
    expect(noConfirm.status).toBe(400)
    const restore = await call(handlers, ApiPaths.hostsCliStream, 'POST', {
      id: 'acc-1', action: 'restore', filename: 'backup-1.zip', confirm: true,
    })
    expect(restore.status).toBe(200)
    expect(restore.body).toContain('event: result')
    expect(ops.restoreBackup).toHaveBeenCalledWith('acc-1', 'backup-1.zip', expect.any(Function))
  })
})

describe('streaming install/upgrade and diagnose routes', () => {
  it('streams install output and the final result as SSE', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      install: vi.fn(async (_id, options) => {
        options?.onOutput?.({ stream: 'stdout', text: 'installing...\n' })
        options?.onOutput?.({ stream: 'stderr', text: 'warning\n' })
        return { ok: true, message: 'installed' }
      }) as never,
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const denied = await call(handlers, ApiPaths.hostsInstallStream, 'POST', { id: 'acc-1' })
    expect(denied.status).toBe(400)

    const streamed = await call(handlers, ApiPaths.hostsInstallStream, 'POST', { id: 'acc-1', confirm: true })
    expect(streamed.status).toBe(200)
    expect(streamed.headers['content-type']).toContain('text/event-stream')
    expect(streamed.body).toContain('event: output')
    expect(streamed.body).toContain('installing...')
    expect(streamed.body).toContain('event: result')
    expect(streamed.body).toContain('"ok":true')
    expect(streamed.body).not.toContain('event: error')
  })

  it('streams upgrade output and maps failures to an error event', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      upgrade: vi.fn(async () => {
        throw new Error('yarn registry unreachable')
      }) as never,
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const streamed = await call(handlers, ApiPaths.hostsUpgradeStream, 'POST', { id: 'acc-1', confirm: true })
    expect(streamed.status).toBe(200)
    expect(streamed.body).toContain('event: error')
    expect(streamed.body).toContain('yarn registry unreachable')
  })

  it('builds a diagnose prompt for the selected host', async () => {
    const { ctx, handlers } = makeContext()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0' })
    const diagnose = await call(handlers, ApiPaths.hostsDiagnose, 'POST', {
      id: 'acc-1',
      kind: 'install',
      output: 'boom',
      message: 'exit 1',
    })
    expect(diagnose.status).toBe(200)
    const prompt = (JSON.parse(diagnose.body) as { prompt: string }).prompt
    expect(prompt).toContain('root@example.org')
    expect(prompt).toContain('boom')
    expect(prompt).toContain('exit 1')
  })
})

describe('hydro HTTP routes', () => {
  it('lists accounts and returns info', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const list = await call(handlers, ApiPaths.accounts, 'GET')
    expect(list.status).toBe(200)
    const payload = JSON.parse(list.body) as { accounts: unknown[]; activeAccountId: string }
    expect(payload.accounts).toHaveLength(1)
    expect(payload.activeAccountId).toBe('acc-1')

    const info = await call(handlers, ApiPaths.info, 'GET')
    expect(info.status).toBe(200)
    expect(JSON.parse(info.body)).toMatchObject({ name: 'dsh-hydro', version: '0.1.0', features: { ssh: true } })
  })

  it('creates, updates, activates and removes accounts', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps()
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })

    const created = await call(handlers, ApiPaths.accountCreate, 'POST', {
      host: 'example.org',
      username: 'root',
      authMethod: 'password',
      password: 'pw',
      label: 'prod',
    })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toMatchObject({ account: { id: 'acc-2', label: 'prod' } })
    expect(ops.addAccount).toHaveBeenCalledWith(expect.objectContaining({ host: 'example.org', password: 'pw' }), expect.any(Function))

    const updated = await call(handlers, ApiPaths.accountUpdate, 'POST', { id: 'acc-1', label: 'renamed', readonly: true })
    expect(updated.status).toBe(200)
    expect(ops.updateAccount).toHaveBeenCalledWith('acc-1', expect.objectContaining({ label: 'renamed', readonly: true }))

    const activated = await call(handlers, ApiPaths.accountActivate, 'POST', { id: 'acc-2' })
    expect(activated.status).toBe(200)
    expect(ops.setActiveAccount).toHaveBeenCalledWith('acc-2')

    const removed = await call(handlers, ApiPaths.accountRemove, 'POST', { id: 'acc-2' })
    expect(removed.status).toBe(200)
    expect(JSON.parse(removed.body)).toEqual({ removed: true })
  })

  it('validates input and rejects cross-origin mutations', async () => {
    const { ctx, handlers } = makeContext()
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0' })

    const missing = await call(handlers, ApiPaths.accountCreate, 'POST', { username: 'root' })
    expect(missing.status).toBe(400)
    expect(JSON.parse(missing.body).error).toContain('host')

    const wrongMethod = await call(handlers, ApiPaths.accountCreate, 'GET')
    expect(wrongMethod.status).toBe(405)

    const crossOrigin = await call(handlers, ApiPaths.accountRemove, 'POST', { id: 'acc-1' }, { origin: 'https://evil.example' })
    expect(crossOrigin.status).toBe(403)

    const sameOrigin = await call(handlers, ApiPaths.accountRemove, 'POST', { id: 'acc-1' }, { origin: 'http://127.0.0.1:3080' })
    expect(sameOrigin.status).toBe(200)
  })

  it('maps thrown errors to JSON errors', async () => {
    const { ctx, handlers } = makeContext()
    const ops = fakeOps({
      removeAccount: async () => {
        throw new Error('删除失败：远端繁忙')
      },
    })
    registerHydroRoutes({ ctx, ops, version: '0.1.0' })
    const result = await call(handlers, ApiPaths.accountRemove, 'POST', { id: 'acc-1' })
    expect(result.status).toBe(500)
    expect(JSON.parse(result.body)).toMatchObject({ error: '删除失败：远端繁忙' })
  })

  it('rejects requests the host gate refuses', async () => {
    const handlers = new Map<string, (request: never, response: never) => Promise<void>>()
    const ctx = {
      get: (name: string) => (name === 'connection' ? { requestRejection: () => 401 } : undefined),
      effect: (factory: () => () => void) => factory(),
      webServer: {
        register(route: { path: string; handler: (request: never, response: never) => Promise<void> }) {
          handlers.set(route.path, route.handler)
          return () => undefined
        },
      },
    } as unknown as RouteContext
    registerHydroRoutes({ ctx, ops: fakeOps(), version: '0.1.0' })
    const result = await call(handlers, ApiPaths.accounts, 'GET')
    expect(result.status).toBe(401)
  })
})
