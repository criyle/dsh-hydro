import { describe, expect, it } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import { serviceAction } from '../../src/hydro/service.js'
import { probeStub } from './fixtures.js'

const PM2_ONLINE = JSON.stringify([
  { name: 'hydrooj', pid: 4242, pm2_env: { status: 'online', restart_time: 1, pm_uptime: Date.now() - 10_000 } },
])

function pm2Connection(handlers: Array<[string, string]> = []): FakeSshConnection {
  const connection = new FakeSshConnection({
    commands: [
      { match: 'pm2 jlist', result: { stdout: PM2_ONLINE, code: 0 } },
      ...handlers.map(([match, stdout]) => ({ match, result: { stdout, code: 0 } })),
    ],
  })
  return connection
}

describe('serviceAction (pm2)', () => {
  it('reports the status of the Hydro process', async () => {
    const connection = pm2Connection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await serviceAction(context, 'hydro', 'status', probeStub())
    expect(result).toMatchObject({ target: 'hydro', manager: 'pm2', action: 'status', ok: true })
    expect(result.output).toContain('hydrooj: online')
    expect(result.output).toContain('pid=4242')
  })

  it('restarts through pm2 as root', async () => {
    const connection = pm2Connection([['pm2 restart', '[PM2] Applying action restartProcessId']])
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await serviceAction(context, 'hydro', 'restart', probeStub())
    expect(result.ok).toBe(true)
    expect(result.manager).toBe('pm2')
    expect(connection.commands.some((command) => command.includes("pm2 restart 'hydrooj'"))).toBe(true)
  })

  it('refuses mutating actions in read-only mode', async () => {
    const connection = pm2Connection()
    const context = fakeContext({
      connection,
      account: fakeAccount(),
      config: fakeConfig(),
      readonly: true,
    })
    const result = await serviceAction(context, 'sandbox', 'restart', probeStub())
    expect(result.ok).toBe(false)
    expect(result.output).toContain('只读')
    expect(connection.commands).toHaveLength(0)
  })

  it('reports a missing process instead of throwing', async () => {
    const connection = pm2Connection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await serviceAction(context, 'judge', 'status', probeStub())
    expect(result.ok).toBe(false)
    expect(result.output).toContain('hydrojudge')
  })

  it('refuses when Hydro is not installed', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await serviceAction(context, 'hydro', 'status', probeStub({ installed: false }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain('未检测到 Hydro')
  })
})

describe('serviceAction (systemd)', () => {
  it('reads unit state through systemctl', async () => {
    const connection = new FakeSshConnection({
      commands: [{ match: 'systemctl is-active', result: { stdout: 'active\n', code: 0 } }],
    })
    const config = fakeConfig()
    const context = fakeContext({
      connection,
      account: fakeAccount(),
      config: { ...config, hydro: { ...config.hydro, serviceManager: 'systemd' } },
    })
    const result = await serviceAction(context, 'hydro', 'status', probeStub())
    expect(result).toMatchObject({ manager: 'systemd', ok: true })
    expect(result.output).toContain('hydrooj: active')
  })
})
