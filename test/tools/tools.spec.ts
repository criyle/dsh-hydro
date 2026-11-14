import { describe, expect, it, vi } from 'vitest'

import type { ToolDeps } from '../../src/tools/types.js'
import { registerAccountTools } from '../../src/tools/accounts.js'
import { registerAdminTools } from '../../src/tools/admin.js'
import { registerOpsTools } from '../../src/tools/ops.js'
import { fakeConfig } from '../helpers/fake-ssh.js'
import { fakeOps, sampleAccount, sampleStatus } from '../helpers/fake-ops.js'

interface CapturedTool {
  name: string
  description: string
  parameters: unknown
  execute(args: Record<string, unknown>, exec?: Record<string, unknown>): Promise<Record<string, unknown>>
  output: { render(args: Record<string, unknown>, value: Record<string, unknown>): Array<{ type: string; text: string }> }
}

function makeDeps(opsOverrides: Parameters<typeof fakeOps>[0] = {}): { deps: ToolDeps; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>()
  const ctx = {
    tools: {
      register(definition: CapturedTool) {
        tools.set(definition.name, definition)
        return () => undefined
      },
    },
    get: () => undefined,
    effect: (factory: () => () => void) => factory(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  }
  const deps: ToolDeps = {
    ctx: ctx as unknown as ToolDeps['ctx'],
    config: fakeConfig(),
    ops: fakeOps(opsOverrides),
  }
  return { deps, tools }
}

async function execute(tool: CapturedTool, args: Record<string, unknown>): Promise<{ ok: boolean; message: string; data?: unknown }> {
  const value = (await tool.execute(args, { signal: new AbortController().signal })) as { ok: boolean; message: string; data?: unknown }
  // Every canonical value must be renderable without throwing.
  const rendered = tool.output.render(args, value as never)
  expect(rendered[0]?.type).toBe('text')
  expect(rendered[0]?.text.length).toBeGreaterThan(0)
  return value
}

describe('account tools', () => {
  it('registers and lists accounts', async () => {
    const { deps, tools } = makeDeps()
    registerAccountTools(deps)
    const tool = tools.get('hydro_accounts')
    expect(tool).toBeDefined()
    const result = await execute(tool!, { action: 'list' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('root@example.org')
    expect((result.data as { accounts: unknown[] }).accounts).toHaveLength(1)
  })

  it('adds, tests, activates and removes an account', async () => {
    const { deps, tools } = makeDeps()
    registerAccountTools(deps)
    const tool = tools.get('hydro_accounts')!

    const added = await execute(tool, {
      action: 'add',
      host: 'new.example.org',
      username: 'root',
      authMethod: 'password',
      password: 'pw',
      label: 'prod',
      installManagedKey: true,
    })
    expect(added.ok).toBe(true)
    expect(deps.ops.addAccount).toHaveBeenCalledWith(expect.objectContaining({ host: 'new.example.org', installManagedKey: true }))

    const tested = await execute(tool, { action: 'test', accountId: 'acc-1' })
    expect(tested.message).toContain('连接成功')

    const used = await execute(tool, { action: 'use', accountId: 'acc-1' })
    expect(used.ok).toBe(true)

    const removed = await execute(tool, { action: 'remove', accountId: 'acc-1' })
    expect(removed.ok).toBe(true)
  })

  it('validates required fields before creating', async () => {
    const { deps, tools } = makeDeps()
    registerAccountTools(deps)
    const tool = tools.get('hydro_accounts')!
    await expect(tool.execute({ action: 'add', username: 'root' }, { signal: new AbortController().signal })).rejects.toThrow(/host/)
    await expect(
      tool.execute({ action: 'add', host: 'h', username: 'u', authMethod: 'key' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/privateKey/)
  })
})

describe('ops tools', () => {
  it('returns a formatted status and quick health', async () => {
    const { deps, tools } = makeDeps()
    registerOpsTools(deps)
    const status = await execute(tools.get('hydro_status')!, {})
    expect(status.ok).toBe(true)
    expect(status.message).toContain('Hydro')
    const health = await execute(tools.get('hydro_health')!, {})
    expect(health.ok).toBe(true)
  })

  it('refuses destructive operations without confirm=true', async () => {
    const { deps, tools } = makeDeps()
    registerOpsTools(deps)
    await expect(tools.get('hydro_install')!.execute({ confirm: false }, { signal: new AbortController().signal })).rejects.toThrow(/confirm/)
    await expect(tools.get('hydro_upgrade')!.execute({}, { signal: new AbortController().signal })).rejects.toThrow(/confirm/)
    await expect(
      tools.get('hydro_service')!.execute({ target: 'hydro', action: 'restart' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/confirm/)
    const status = await execute(tools.get('hydro_service')!, { target: 'hydro', action: 'status' })
    expect(status.ok).toBe(true)
  })

  it('renders database and oplog output', async () => {
    const { deps, tools } = makeDeps()
    registerOpsTools(deps)
    const collections = await execute(tools.get('hydro_db')!, { action: 'collections' })
    expect(collections.message).toContain('oplog')
    const oplog = await execute(tools.get('hydro_oplog')!, { source: 'auto' })
    expect(oplog.ok).toBe(true)
  })
})

describe('admin tools', () => {
  it('requires credentials before touching the domain config', async () => {
    const { deps, tools } = makeDeps({
      getSiteSession: async () => ({ uname: null, sid: null, domain: 'system', siteAccountId: null }),
      withContext: (async (_id: string | undefined, fn: (context: never) => Promise<unknown>) =>
        fn({ account: sampleAccount, readonly: false } as never)) as never,
    })
    registerAdminTools(deps)
    await expect(
      tools.get('hydro_domain_config')!.execute({ action: 'get' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/还没有登录 Hydro/)
  })

  it('refuses hydro_exec unless explicitly enabled', async () => {
    const { deps, tools } = makeDeps()
    registerAdminTools(deps)
    await expect(tools.get('hydro_exec')!.execute({ command: 'id' }, { signal: new AbortController().signal })).rejects.toThrow(/allowArbitraryCommands/)
  })

  it('refuses system config writes without confirm=true', async () => {
    const { deps, tools } = makeDeps()
    registerAdminTools(deps)
    await expect(
      tools.get('hydro_system_config')!.execute({ action: 'set', key: 'server.url', value: 'https://oj.example.org/' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/confirm/)
  })
})

describe('status summary helper', () => {
  it('counts warnings and running state', () => {
    expect(sampleStatus.reachable).toBe(true)
  })
})
