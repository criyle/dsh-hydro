import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import { collectHydroStatus, quickStatus } from '../../src/hydro/status.js'
import { SECTION, hostFactsOutput, probeOutput } from './fixtures.js'

const ALL_OFF = {
  includeMongo: false,
  includeOplog: false,
  includeWsWarnings: false,
  includeLatestVersions: false,
  timeoutMs: 5000,
}

function statusContext(output: string, overrides: Parameters<typeof fakeConfig>[0] = {}) {
  const connection = new FakeSshConnection({
    commands: [
      { match: SECTION, result: { stdout: output, code: 0 } },
      { match: 'dsh-hydro host facts', result: { stdout: hostFactsOutput(), code: 0 } },
    ],
  })
  return { connection, context: fakeContext({ connection, account: fakeAccount(), config: fakeConfig(overrides) }) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('collectHydroStatus', () => {
  it('assembles host, Hydro service, health and plugins from one probe', async () => {
    const { context } = statusContext(probeOutput({ installed: true }))
    const status = await collectHydroStatus(context, ALL_OFF)

    expect(status.reachable).toBe(true)
    expect(status.error).toBeNull()
    expect(status.accountId).toBe('acc-test')
    expect(new Date(status.collectedAt).toString()).not.toBe('Invalid Date')

    expect(status.host).toMatchObject({
      hostname: 'oj',
      platform: 'Linux',
      arch: 'x86_64',
      node: 'v22.14.0',
      uptimeSeconds: 123456.78,
    })
    expect(status.host?.load).toEqual([0.12, 0.34, 0.56])
    expect(status.host?.memoryFreeBytes).toBe(1048576 * 1024)
    expect(status.host?.diskFreeBytes).toBe(20971520 * 1024)

    expect(status.hydro).toMatchObject({
      installed: true,
      version: '5.0.7',
      latestVersion: null,
      updateAvailable: false,
    })
    expect(status.hydro.installDir).toContain('node_modules/hydrooj')
    expect(status.hydro.health).toMatchObject({ ok: true, status: 200 })
    expect(status.hydro.service).toMatchObject({
      manager: 'pm2',
      name: 'hydrooj',
      running: true,
      pid: 1001,
      restarts: 3,
    })
    expect(status.hydro.service?.since).not.toBeNull()

    expect(status.plugins).toHaveLength(3)
    const judgePlugin = status.plugins.find((plugin) => plugin.name === '@hydrooj/hydrojudge')
    expect(judgePlugin).toMatchObject({ version: '4.0.6', updateAvailable: false, builtin: true, enabled: true })
    expect(judgePlugin?.latest).toBeNull()

    expect(status.judge).toMatchObject({ sandboxVersion: '1.9.4' })
    expect(status.mongo).toBeNull()
    expect(status.warnings.some((warning) => warning.severity === 'error')).toBe(false)
  })

  it('does not open Mongo tunnels or hit the registry unless asked', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { connection, context } = statusContext(probeOutput({ installed: true }))
    await collectHydroStatus(context, ALL_OFF)
    expect(connection.forwards).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('adds latest-version data and an update warning when enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input)
        const version = url.includes('hydrooj%2Fhydrojudge')
          ? '4.1.0'
          : url.endsWith('/hydrooj/latest')
            ? '5.0.8'
            : '4.58.5'
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    )
    const { context } = statusContext(probeOutput({ installed: true }))
    const status = await collectHydroStatus(context, {
      ...ALL_OFF,
      includeLatestVersions: true,
      ...{},
    })

    expect(status.hydro.latestVersion).toBe('5.0.8')
    expect(status.hydro.updateAvailable).toBe(true)
    const judgePlugin = status.plugins.find((plugin) => plugin.name === '@hydrooj/hydrojudge')
    expect(judgePlugin?.latest).toBe('4.1.0')
    expect(judgePlugin?.updateAvailable).toBe(true)
    const uiPlugin = status.plugins.find((plugin) => plugin.name === '@hydrooj/ui-default')
    expect(uiPlugin?.updateAvailable).toBe(false)
    expect(status.warnings.some((warning) => warning.code.startsWith('hydro.update-available'))).toBe(true)
  })

  it('reports a bare host as not installed with an install hint', async () => {
    const { context } = statusContext(probeOutput({ installed: false }))
    const status = await collectHydroStatus(context, ALL_OFF)
    expect(status.reachable).toBe(true)
    expect(status.hydro.installed).toBe(false)
    expect(status.hydro.health).toBeNull()
    expect(status.plugins).toEqual([])
    expect(status.judge).toBeNull()
    const info = status.warnings.find((warning) => warning.code.startsWith('hydro.not-installed'))
    expect(info?.severity).toBe('info')
    expect(info?.hint).toContain('hydro_install')
  })

  it('degrades to reachable=false when the probe transport fails', async () => {
    const connection = new FakeSshConnection()
    connection.failWith = new Error('ssh boom')
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const status = await collectHydroStatus(context, ALL_OFF)
    expect(status.reachable).toBe(false)
    expect(status.error).toContain('ssh boom')
    expect(status.warnings[0]?.severity).toBe('error')
    expect(status.hydro.installed).toBe(false)
  })

  it('quickStatus returns the same shape without slow probes', async () => {
    const { connection, context } = statusContext(probeOutput({ installed: true }))
    const status = await quickStatus(context)
    expect(status.reachable).toBe(true)
    expect(status.hydro.version).toBe('5.0.7')
    expect(status.mongo).toBeNull()
    expect(connection.forwards).toHaveLength(0)
  })
})
