import { afterEach, describe, expect, it } from 'vitest'
import { connectSsh, type SshConnection } from '../../src/ssh/index.js'
import { startTestServer, type ExecRequest, type TestSshServer } from './helpers/server.js'

const servers: TestSshServer[] = []
const connections: SshConnection[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close()
  for (const server of servers.splice(0)) await server.stop()
})

interface ElevateServerConfig {
  uid: string
  sudoPath?: string | null
  sudoPassword?: string
  sudoAuthFailure?: boolean
  sudoExitCode?: number
  suPassword?: string
  suOutput?: string
}

/** Scripted server responses for the elevate detection + execution protocol. */
function elevateExecHandler(config: ElevateServerConfig): (request: ExecRequest) => void | Promise<void> {
  return (request) => {
    const command = request.command
    if (command === 'id -u') {
      request.finish(`${config.uid}\n`)
      return
    }
    if (command === 'command -v sudo') {
      if (config.sudoPath === undefined || config.sudoPath === null) request.finish('', '', 1)
      else request.finish(`${config.sudoPath}\n`)
      return
    }
    if (command === 'whoami') {
      request.finish('root\n')
      return
    }
    if (command.startsWith('sudo -S ')) {
      return (async () => {
        const stdin = (await request.stdin()).toString('utf8')
        expect(stdin).toBe(`${config.sudoPassword ?? 'secret'}\n`)
        if (config.sudoAuthFailure === true) {
          request.finish('', 'Sorry, try again.\nsudo: 1 incorrect password attempt\n', 1)
          return
        }
        request.finish(config.sudoExitCode === undefined ? 'root\n' : '', config.sudoExitCode === undefined ? '' : 'sudo command failed\n', config.sudoExitCode ?? 0)
      })()
    }
    if (command.startsWith('sudo -n ')) {
      request.finish('root\n')
      return
    }
    if (command === 'su - root') {
      expect(request.pty).toBe(true)
      let received = ''
      let stage: 'password' | 'command' = 'password'
      request.channel.write('Password: ')
      request.channel.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8')
        if (stage === 'password') {
          const newline = received.indexOf('\n')
          if (newline < 0) return
          const password = received.slice(0, newline)
          if (password !== (config.suPassword ?? 'rootpass')) {
            request.channel.write('\r\nsu: Authentication failure\r\n')
            request.finish('', '', 1)
            return
          }
          stage = 'command'
          request.channel.write('\r\n# ')
          return
        }
        const start = /__DSH_HYDRO_SU_START_[0-9a-f]+__/.exec(received)
        const end = /__DSH_HYDRO_SU_END_[0-9a-f]+__/.exec(received)
        if (start !== null && end !== null) {
          request.channel.write(`${start[0]}${config.suOutput ?? 'uid=0(root)\n'}\n\n${end[0]}0\n`)
          request.finish('', '', 0)
        }
      })
      return
    }
    request.finish('', `unknown command: ${command}\n`, 127)
  }
}

async function startWith(config: ElevateServerConfig): Promise<TestSshServer> {
  const server = await startTestServer({ password: 'pw', onExec: elevateExecHandler(config) })
  servers.push(server)
  return server
}

async function openConnection(server: TestSshServer): Promise<SshConnection> {
  const connection = await connectSsh({
    target: { host: '127.0.0.1', port: server.port, username: 'tester' },
    auth: { kind: 'password', password: 'pw' },
    hostKeyPolicy: 'off',
    timeoutMs: 5_000,
  })
  connections.push(connection)
  return connection
}

describe('SshConnection.elevate', () => {
  it('runs the command directly when already root', async () => {
    const server = await startWith({ uid: '0' })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'secret' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('root\n')

    const commands = server.commands.map((command) => command.command)
    expect(commands).toContain('whoami')
    expect(commands.some((command) => command.startsWith('sudo'))).toBe(false)
    expect(commands).not.toContain('su - root')
  })

  it('uses sudo -S and feeds the password on stdin', async () => {
    const server = await startWith({ uid: '1000', sudoPath: '/usr/bin/sudo', sudoPassword: 'secret' })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'secret' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('root\n')

    const sudoCommand = server.commands.find((command) => command.command.startsWith('sudo -S '))
    expect(sudoCommand).toBeDefined()
    expect(sudoCommand?.command).toContain("sudo -S -p '' -- sh -c 'whoami'")
    expect(sudoCommand?.stdin).toBe('secret\n')
  })

  it('uses sudo -n when no password is provided', async () => {
    const server = await startWith({ uid: '1000', sudoPath: '/usr/bin/sudo' })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami')
    expect(result.code).toBe(0)
    expect(server.commands.some((command) => command.command === "sudo -n -- sh -c 'whoami'")).toBe(true)
  })

  it('reports sudo authentication failures as a result with a marker', async () => {
    const server = await startWith({
      uid: '1000',
      sudoPath: '/usr/bin/sudo',
      sudoAuthFailure: true,
      sudoPassword: 'wrong',
    })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'wrong' })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('incorrect password attempt')
    expect(result.stderr).toContain('[dsh-hydro] sudo authentication failed')
  })

  it('does not misreport a failing elevated command as an auth failure', async () => {
    const server = await startWith({ uid: '1000', sudoPath: '/usr/bin/sudo', sudoExitCode: 4 })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'secret' })
    expect(result.code).toBe(4)
    expect(result.stderr).not.toContain('sudo authentication failed')
  })

  it('falls back to su over a pty when sudo is missing', async () => {
    const server = await startWith({ uid: '1000', sudoPath: null, suPassword: 'rootpass', suOutput: 'hello-from-root\n' })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'rootpass' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello-from-root')
    expect(result.stderr).toBe('')

    const suCommand = server.commands.find((command) => command.command === 'su - root')
    expect(suCommand).toBeDefined()
    expect(suCommand?.pty).toBe(true)
  })

  it('reports su authentication failure', async () => {
    const server = await startWith({ uid: '1000', sudoPath: null, suPassword: 'rootpass' })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'wrongpass' })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('su authentication failed')
  })

  it('refuses the su fallback without a password', async () => {
    const server = await startWith({ uid: '1000', sudoPath: null })
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami')
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('su fallback requires a password')
    expect(server.commands.some((command) => command.command === 'su - root')).toBe(false)
  })

  it('reports when privileges cannot be detected', async () => {
    const server = await startTestServer({
      password: 'pw',
      onExec: (request) => request.finish('', 'id: not found\n', 127),
    })
    servers.push(server)
    const connection = await openConnection(server)

    const result = await connection.elevate('whoami', { password: 'secret' })
    expect(result.code).toBeNull()
    expect(result.stderr).toContain('could not detect the current user')
  })
})
