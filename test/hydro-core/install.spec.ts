import { describe, expect, it } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import {
  buildInstallCommand,
  buildInstallVerifyCommand,
  installHydro,
  parseInstallVerification,
} from '../../src/hydro/install.js'
import { SECTION, probeOutput } from './fixtures.js'

describe('buildInstallCommand', () => {
  it('downloads to a temp file and runs the installer non-interactively', () => {
    const command = buildInstallCommand('https://hydro.ac/install.sh')
    expect(command).toContain("curl -fsSL 'https://hydro.ac/install.sh' -o /tmp/dsh-hydro-install.sh")
    expect(command).toContain("wget -qO /tmp/dsh-hydro-install.sh 'https://hydro.ac/install.sh'")
    expect(command).toContain('chmod +x /tmp/dsh-hydro-install.sh')
    expect(command).toContain('IGNORE_BT=1')
    expect(command).toContain('LANG=zh')
    expect(command).toContain("printf 'n\\n'")
    expect(command).toContain('bash /tmp/dsh-hydro-install.sh')
    // No optional flags by default.
    expect(command).not.toContain('--judge')
    expect(command).not.toContain('--no-caddy')
    expect(command).not.toContain('--expose-db')
  })

  it('passes the judge / no-caddy / expose-db flags through', () => {
    const command = buildInstallCommand('https://example.com/setup.sh', {
      judge: true,
      noCaddy: true,
      exposeDb: true,
    })
    expect(command).toContain('--judge')
    expect(command).toContain('--no-caddy')
    expect(command).toContain('--expose-db')
    expect(command).toContain("'https://example.com/setup.sh'")
  })

  it('verifies the install with pm2, HTTP and the install marker', () => {
    const verify = buildInstallVerifyCommand(8888)
    expect(verify).toContain('pm2 jlist')
    expect(verify).toContain('http://127.0.0.1:8888/status')
    expect(verify).toContain('/etc/HYDRO_INSTALLER')
    expect(parseInstallVerification('PM2=[]\nHTTP=200\nMARKER=layout=2\nCONFIG=yes\n')).toMatchObject({
      httpStatus: 200,
      marker: 'layout=2',
      configExists: true,
    })
  })
})

describe('installHydro refusals', () => {
  it('refuses when Hydro is already installed', async () => {
    const connection = new FakeSshConnection({
      commands: [{ match: SECTION, result: { stdout: probeOutput({ installed: true }), code: 0 } }],
    })
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await installHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已安装')
    expect(result.message).toContain('5.0.7')
    // Only the probe ran; the installer was never downloaded.
    expect(connection.commands).toHaveLength(1)
  })

  it('refuses in read-only mode without running any command', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig(), readonly: true })
    const result = await installHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('只读')
    expect(connection.commands).toHaveLength(0)
  })

  it('refuses unsupported architectures before installing', async () => {
    const connection = new FakeSshConnection({
      commands: [
        { match: SECTION, result: { stdout: probeOutput({ installed: false, arch: 'armv7l' }), code: 0 } },
      ],
    })
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await installHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('架构')
  })

  it('refuses non-root accounts without sudo/password', async () => {
    const connection = new FakeSshConnection({
      commands: [{ match: SECTION, result: { stdout: probeOutput({ installed: false }), code: 0 } }],
    })
    const context = fakeContext({
      connection,
      account: fakeAccount({ role: 'user' }),
      config: fakeConfig(),
      elevationPassword: () => undefined,
    })
    const result = await installHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('root 权限')
    // probe + passwordless-sudo check, no installer.
    expect(connection.commands).toHaveLength(2)
  })
})

describe('installHydro success path', () => {
  it('runs the installer, verifies it, and redacts the generated DB password', async () => {
    let probes = 0
    const connection = new FakeSshConnection()
    connection.on(SECTION, () => {
      probes += 1
      return { stdout: probeOutput({ installed: probes > 1 }), code: 0 }
    })
    connection.on('dsh-hydro-install.sh', () => ({
      stdout: [
        'Hydro 安装成功！',
        '安装已全部完成。',
        '数据库密码： deadbeefcafe',
        'mongodb://hydro:deadbeefcafe@127.0.0.1:27017/hydro',
      ].join('\n'),
      code: 0,
    }))
    connection.on('dsh-hydro-install-verify', () => ({
      stdout: [
        'PM2=[{"name":"hydrooj","pid":4242,"pm2_env":{"status":"online"}}]',
        'HTTP=200',
        'MARKER=layout=2 ',
        'CONFIG=yes',
      ].join('\n'),
      code: 0,
    }))

    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await installHydro(context)

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Hydro 安装成功')
    expect(result.message).toContain('健康检查通过')
    expect(result.details).toMatchObject({ exitCode: 0, successMarker: '安装成功', pm2Online: true })
    expect(result.log).not.toContain('deadbeefcafe')
    expect(result.log).toContain('***')
    expect(probes).toBe(2)
  })

  it('elevates with the stored password for non-root accounts', async () => {
    let probes = 0
    const connection = new FakeSshConnection()
    connection.on(SECTION, () => {
      probes += 1
      return { stdout: probeOutput({ installed: probes > 1 }), code: 0 }
    })
    connection.on('dsh-hydro-install.sh', () => ({
      stdout: 'Hydro 安装成功！\n安装已全部完成。',
      code: 0,
    }))
    connection.on('dsh-hydro-install-verify', () => ({
      stdout: 'PM2=[{"name":"hydrooj","pm2_env":{"status":"online"}}]\nHTTP=200\nMARKER=layout=2\nCONFIG=yes\n',
      code: 0,
    }))
    const context = fakeContext({
      connection,
      account: fakeAccount({ role: 'sudo' }),
      config: fakeConfig(),
      elevationPassword: () => 'stored-sudo-password',
    })
    const result = await installHydro(context)
    expect(result.ok).toBe(true)
    expect(connection.commands.some((command) => command.startsWith('[elevate]'))).toBe(true)
  })

  it('accepts a verified install when only the container sysctl step failed', async () => {
    let probes = 0
    const connection = new FakeSshConnection()
    connection.on(SECTION, () => {
      probes += 1
      return { stdout: probeOutput({ installed: probes > 1 }), code: 0 }
    })
    connection.on('dsh-hydro-install.sh', () => ({
      stdout: [
        'Hydro 安装成功！',
        'sysctl: permission denied on key "vm.swappiness"',
        'Error when running sysctl -p',
      ].join('\n'),
      code: 1,
    }))
    connection.on('dsh-hydro-install-verify', () => ({
      stdout: 'PM2=[{"name":"hydrooj","pm2_env":{"status":"online"}}]\nHTTP=200\nMARKER=\nCONFIG=yes\n',
      code: 0,
    }))
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await installHydro(context)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Hydro 安装成功')
    expect(result.message).toContain('sysctl')
    expect(result.details).toMatchObject({ exitCode: 1, lateFailure: true, containerSysctl: true, pm2Online: true })
  })

  it('reports failure when the installer exit code is nonzero', async () => {
    const connection = new FakeSshConnection()
    connection.on(SECTION, () => ({ stdout: probeOutput({ installed: false }), code: 0 }))
    connection.on('dsh-hydro-install.sh', () => ({ stdout: 'fatal: nix install failed', code: 1 }))
    connection.on('dsh-hydro-install-verify', () => ({
      stdout: 'PM2=[]\nHTTP=000\nMARKER=\nCONFIG=no\n',
      code: 0,
    }))
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const result = await installHydro(context)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('安装未成功')
    expect(result.message).toContain('退出码 1')
  })
})
