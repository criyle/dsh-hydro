import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import {
  buildProbeScript,
  isHydroInstalled,
  locateHydro,
  parseProbeOutput,
  probeHydro,
} from '../../src/hydro/detect.js'
import { SECTION, probeOutput } from './fixtures.js'

function probeConnection(output: string): FakeSshConnection {
  return new FakeSshConnection({
    commands: [{ match: SECTION, result: { stdout: output, code: 0 } }],
  })
}

function contextFor(output: string) {
  const connection = probeConnection(output)
  return { connection, context: fakeContext({ connection, account: fakeAccount(), config: fakeConfig() }) }
}

describe('parseProbeOutput (installed host)', () => {
  const probe = parseProbeOutput(probeOutput({ installed: true }))

  it('detects the install, manager and core version', () => {
    expect(probe.installed).toBe(true)
    expect(probe.serviceManager).toBe('pm2')
    expect(probe.hydrooj).toMatchObject({
      name: 'hydrooj',
      version: '5.0.7',
      path: '/usr/local/share/.config/yarn/global/node_modules/hydrooj',
    })
    expect(probe.installDir).toBe('/usr/local/share/.config/yarn/global/node_modules/hydrooj')
    expect(probe.marker).toBe('layout=2')
  })

  it('reads the Mongo URI, database and ports without exposing them in warnings', () => {
    expect(probe.config?.uri).toBe('mongodb://hydro:secretpass@127.0.0.1:27017/hydro')
    expect(probe.config?.database).toBe('hydro')
    expect(probe.config?.path).toBe('/root/.hydro/config.json')
    expect(probe.ports).toEqual({ hydro: 8888, mongo: 27017, sandbox: 5050 })
  })

  it('parses pm2 processes and health', () => {
    expect(probe.pm2.map((entry) => entry.name)).toEqual(['hydrooj', 'mongodb', 'hydro-sandbox', 'caddy'])
    expect(probe.pm2[0]).toMatchObject({ status: 'online', pid: 1001, restarts: 3 })
    expect(probe.health).toMatchObject({ status: 200, ok: true })
    expect(probe.health.latencyMs).toBe(12)
  })

  it('lists addons with versions and the judge/sandbox facts', () => {
    expect(probe.addonNames).toContain('@hydrooj/hydrojudge')
    expect(probe.addons).toHaveLength(3)
    expect(probe.addons.find((addon) => addon.name === '@hydrooj/ui-default')?.version).toBe('4.58.5')
    expect(probe.sandbox).toMatchObject({ running: true, version: '1.9.4', address: 'http://127.0.0.1:5050' })
    expect(probe.judge).toMatchObject({ installed: true, running: true, configPath: '/root/.hydro/judge.yaml' })
    expect(probe.os).toMatchObject({ arch: 'x86_64', kernel: '6.1.0-18-amd64' })
    expect(probe.node.version).toBe('v22.14.0')
  })

  it('produces a secret-free HydroLocation', () => {
    const location = locateHydro(probe)
    expect(location).toMatchObject({
      installed: true,
      installDir: probe.installDir,
      serviceManager: 'pm2',
      serviceName: 'hydrooj',
      port: 8888,
      version: '5.0.7',
    })
    expect(isHydroInstalled(probe)).toBe(true)
  })

  it('honors config.hydro.port and config.hydro.installDir overrides', () => {
    const overridden = parseProbeOutput(probeOutput({ installed: true }), { hydroPort: 9999 })
    expect(overridden.ports.hydro).toBe(9999)
  })
})

describe('parseProbeOutput (payloads without trailing newlines)', () => {
  it('finds sections whose marker is glued to the previous payload line', () => {
    const stdout = [
      '__DSH_HYDRO_SECTION__ meta',
      'uid=0',
      'home=/root',
      '__DSH_HYDRO_SECTION__ config',
      'FILE /root/.hydro/config.json',
      '{"uri":"mongodb://hydro:pw@127.0.0.1:27017/hydro"}__DSH_HYDRO_SECTION__ pm2',
      '[{"name":"hydrooj","pm2_env":{"status":"online"}}]__DSH_HYDRO_SECTION__ marker',
      'layout=2',
    ].join('\n')
    const parsed = parseProbeOutput(stdout)
    expect(parsed.config?.uri).toBe('mongodb://hydro:pw@127.0.0.1:27017/hydro')
    expect(parsed.config?.database).toBe('hydro')
    expect(parsed.pm2.some((entry) => entry.name === 'hydrooj' && entry.status === 'online')).toBe(true)
    expect(parsed.marker).toBe('layout=2')
    expect(parsed.installed).toBe(true)
  })
})

describe('parseProbeOutput (bare host)', () => {
  const probe = parseProbeOutput(probeOutput({ installed: false }))

  it('reports not installed with a null config and failing health', () => {
    expect(probe.installed).toBe(false)
    expect(probe.hydrooj).toBeNull()
    expect(probe.config).toBeNull()
    expect(probe.addons).toEqual([])
    expect(probe.health.ok).toBe(false)
    expect(probe.health.status).toBeNull()
    expect(probe.serviceManager).not.toBe('pm2')
    expect(isHydroInstalled(probe)).toBe(false)
    expect(locateHydro(probe)).toMatchObject({ installed: false, version: null, serviceName: null })
  })

  it('flags the missing node runtime as a warning', () => {
    const text = probeOutput({ installed: false }).replace('node=/usr/local/bin/node', 'node=')
    const parsed = parseProbeOutput(text)
    expect(parsed.warnings.some((warning) => warning.includes('node'))).toBe(true)
  })
})

describe('probeHydro over a scripted SSH connection', () => {
  it('returns the parsed probe in a single batched command', async () => {
    const { connection, context } = contextFor(probeOutput({ installed: true }))
    const probe = await probeHydro(context)
    expect(probe.installed).toBe(true)
    expect(probe.hydrooj?.version).toBe('5.0.7')
    expect(connection.commands).toHaveLength(1)
    expect(connection.commands[0]).toContain(SECTION)
  })

  it('probes as root when a non-root account has a stored elevation password', async () => {
    const connection = probeConnection(probeOutput({ installed: true }))
    const context = fakeContext({
      connection,
      account: fakeAccount({ role: 'sudo' }),
      config: fakeConfig(),
      elevationPassword: () => 'stored-password',
    })
    const probe = await probeHydro(context)
    expect(probe.installed).toBe(true)
    expect(connection.commands.some((command) => command.startsWith('[elevate]'))).toBe(true)
  })

  it('throws when the remote returns unparseable output', async () => {
    const connection = new FakeSshConnection({
      commands: [{ match: SECTION, result: { stdout: 'bash: pm2: command not found', code: 127 } }],
    })
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    await expect(probeHydro(context)).rejects.toThrow(/没有返回可解析结果/)
  })
})

describe('buildProbeScript', () => {
  it('is syntactically valid POSIX shell', () => {
    const script = buildProbeScript(
      fakeContext({ account: fakeAccount(), config: fakeConfig({ hydro: { ...fakeConfig().hydro, installDir: '/srv/hydrooj', port: 8888 } }) }),
    )
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hydro-probe-'))
    try {
      const file = join(dir, 'probe.sh')
      writeFileSync(file, script, 'utf8')
      const result = spawnSync('sh', ['-n', file], { encoding: 'utf8' })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never calls hydrooj --version or hydrooj diag', () => {
    const script = buildProbeScript(fakeContext({ account: fakeAccount(), config: fakeConfig() }))
    expect(script).not.toContain('hydrooj --version')
    expect(script).not.toContain('hydrooj diag')
    expect(script).toContain('package.json')
    expect(script).toContain('addon.json')
  })
})
