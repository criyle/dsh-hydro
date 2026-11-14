import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import { planUpgrade, upgradeHydro } from '../../src/hydro/upgrade.js'
import { SECTION, probeOutput, probeStub } from './fixtures.js'

function stubRegistry(versions: Record<string, string>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      for (const [name, version] of Object.entries(versions)) {
        const encoded = encodeURIComponent(name).replace(/%40/g, '@')
        if (url.endsWith(`/${encoded}/latest`)) {
          return new Response(JSON.stringify({ version }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }
      return new Response('{}', { status: 404 })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('planUpgrade', () => {
  it('builds yarn specifiers and the pm2 restart command', async () => {
    stubRegistry({ hydrooj: '5.0.8', '@hydrooj/hydrojudge': '4.1.0' })
    const context = fakeContext({ account: fakeAccount(), config: fakeConfig() })
    const plan = await planUpgrade(context, probeStub())

    expect(plan.targets).toEqual([
      { name: 'hydrooj', version: '5.0.8' },
      { name: '@hydrooj/hydrojudge', version: '4.1.0' },
    ])
    expect(plan.current.hydrooj).toBe('5.0.7')
    expect(plan.current['@hydrooj/hydrojudge']).toBe('4.0.6')
    expect(plan.command).toContain('yarn global add')
    expect(plan.command).toContain("'hydrooj@5.0.8'")
    expect(plan.command).toContain("'@hydrooj/hydrojudge@4.1.0'")
    expect(plan.command).toContain("pm2 restart 'hydrooj'")
  })

  it('passes a configured yarn registry mirror', async () => {
    stubRegistry({ hydrooj: '5.0.8' })
    const config = fakeConfig()
    const context = fakeContext({
      account: fakeAccount(),
      config: { ...config, hydro: { ...config.hydro, registry: 'https://registry.npmmirror.com' } },
    })
    const plan = await planUpgrade(context, probeStub({ addons: [], addonNames: [] }))
    expect(plan.command).toContain('--registry')
    expect(plan.command).toContain("'https://registry.npmmirror.com'")
  })

  it('returns an empty plan when everything is current', async () => {
    stubRegistry({ hydrooj: '5.0.7', '@hydrooj/hydrojudge': '4.0.6' })
    const context = fakeContext({ account: fakeAccount(), config: fakeConfig() })
    const plan = await planUpgrade(context, probeStub())
    expect(plan.targets).toEqual([])
    expect(plan.command).toBe('')
  })
})

describe('upgradeHydro', () => {
  it('refuses in read-only mode', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({
      connection,
      account: fakeAccount(),
      config: fakeConfig(),
      readonly: true,
    })
    const result = await upgradeHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('只读')
    expect(connection.commands).toHaveLength(0)
  })

  it('supports dry-run without executing the upgrade', async () => {
    stubRegistry({ hydrooj: '5.0.8' })
    const connection = new FakeSshConnection({
      commands: [{ match: SECTION, result: { code: 0, stdout: probeOutput({ installed: true }) } }],
    })
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await upgradeHydro(context, { dryRun: true })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('升级计划')
    expect(result.log).toContain('yarn global add')
    expect(result.log).toContain("pm2 restart 'hydrooj'")
    // Only the probe ran; the upgrade command was not executed.
    expect(connection.commands).toHaveLength(1)
    expect(connection.commands.some((command) => command.includes('yarn global add'))).toBe(false)
  })

  it('executes the upgrade and reports the new version', async () => {
    stubRegistry({ hydrooj: '5.0.8', '@hydrooj/hydrojudge': '4.1.0' })
    let probes = 0
    const connection = new FakeSshConnection()
    connection.on(SECTION, () => {
      probes += 1
      return {
        stdout: probes === 1
          ? probeOutput({ installed: true })
          : probeOutput({
              installed: true,
              coreVersion: '5.0.8',
              addons: [
                { name: '@hydrooj/ui-default', version: '4.58.5' },
                { name: '@hydrooj/hydrojudge', version: '4.1.0' },
                { name: '@hydrooj/a11y', version: '4.0.6' },
              ],
            }),
        code: 0,
      }
    })
    connection.on('yarn global add', () => ({ stdout: 'success Installed packages.', code: 0 }))
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await upgradeHydro(context)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('升级完成')
    expect(probes).toBe(2)
    expect(connection.commands.some((command) => command.includes('yarn global add'))).toBe(true)
  })
})
