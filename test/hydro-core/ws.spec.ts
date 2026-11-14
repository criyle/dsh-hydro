import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import { collectWsWarnings, parseCheckMessage } from '../../src/hydro/ws.js'
import { probeStub } from './fixtures.js'

interface FakeHydroOptions {
  rejectLogin?: boolean
  closeCode?: number
}

interface FakeHydro {
  port: number
  loginBodies: string[]
  wsCookies: string[]
  close(): Promise<void>
}

async function startFakeHydro(options: FakeHydroOptions = {}): Promise<FakeHydro> {
  const loginBodies: string[] = []
  const wsCookies: string[] = []
  const httpServer = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/login' && options.rejectLogin !== true) {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        loginBodies.push(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'sid=test-session; Path=/',
        })
        response.end('{"url":"/"}')
      })
      return
    }
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end('{"error":{"name":"InvalidPasswordError"}}')
  })
  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (request, socket, head) => {
    if (options.rejectLogin === true || request.url?.startsWith('/manage/check-conn') !== true) {
      socket.destroy()
      return
    }
    wsCookies.push(request.headers.cookie ?? '')
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'warn', payload: "server.url isn't set." }))
      ws.send(JSON.stringify({ type: 'error', payload: 'Mongo Error: Database read-write failed.' }))
      ws.send(JSON.stringify({ type: 'warn', payload: "server.url isn't set." }))
      setTimeout(() => ws.close(options.closeCode ?? 1000, 'done'), 30).unref()
    })
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    loginBodies,
    wsCookies,
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

describe('parseCheckMessage', () => {
  it('maps warn/error/log payloads to warnings', () => {
    const warn = parseCheckMessage({ type: 'warn', payload: "server.url isn't set." })
    expect(warn).toMatchObject({ severity: 'warning', code: expect.stringMatching(/^hydro\.ws\.warn\./) })
    expect(warn?.message).toBe("server.url isn't set.")
    expect(warn?.hint).toContain('server.url')

    const error = parseCheckMessage({ type: 'error', payload: 'Mongo Error: Database read-write failed.' })
    expect(error?.severity).toBe('error')
    expect(error?.hint).toContain('MongoDB')

    const log = parseCheckMessage({ type: 'log', payload: 'checking storage' })
    expect(log?.severity).toBe('info')
  })

  it('accepts JSON strings and Buffers', () => {
    const fromString = parseCheckMessage(JSON.stringify({ type: 'warn', payload: 'SMTP account is not provided' }))
    const fromBuffer = parseCheckMessage(Buffer.from(JSON.stringify({ type: 'error', payload: 'Inspector enabled' })))
    expect(fromString?.severity).toBe('warning')
    expect(fromBuffer?.severity).toBe('error')
  })

  it('ignores heartbeats, malformed JSON and unknown types', () => {
    expect(parseCheckMessage('ping')).toBeNull()
    expect(parseCheckMessage('pong')).toBeNull()
    expect(parseCheckMessage('{not json')).toBeNull()
    expect(parseCheckMessage({ type: 'other', payload: 'x' })).toBeNull()
    expect(parseCheckMessage({ type: 'warn' })).toBeNull()
    expect(parseCheckMessage({ error: { name: 'PrivilegeError' } })).toBeNull()
  })

  it('produces stable codes for identical payloads', () => {
    const first = parseCheckMessage({ type: 'warn', payload: 'same message' })
    const second = parseCheckMessage({ type: 'warn', payload: 'same message' })
    const other = parseCheckMessage({ type: 'warn', payload: 'other message' })
    expect(first?.code).toBe(second?.code)
    expect(first?.code).not.toBe(other?.code)
  })
})

describe('collectWsWarnings', () => {
  it('returns an actionable info warning without credentials', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({
      connection,
      account: fakeAccount(),
      config: fakeConfig(),
    })
    const warnings = await collectWsWarnings(context, probeStub())
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ severity: 'info', code: 'hydro.ws.credentials' })
    expect(warnings[0]?.hint).toContain('站点')
    expect(connection.commands).toHaveLength(0)
  })

  it('returns an info warning when the browser session is missing', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const warnings = await collectWsWarnings(context, probeStub())
    expect(warnings[0]?.code).toBe('hydro.ws.credentials')
  })

  it('logs in and collects deduplicated warnings through the tunnel', async () => {
    const fake = await startFakeHydro()
    try {
      const connection = new FakeSshConnection({ forwardTarget: { host: '127.0.0.1', port: fake.port } })
      const context = fakeContext({
        connection,
        account: fakeAccount(),
        config: fakeConfig(),
      })
      const warnings = await collectWsWarnings(context, probeStub(), { timeoutMs: 400, sid: 'test-session' })
      expect(warnings).toHaveLength(2)
      expect(warnings.map((warning) => warning.severity).sort()).toEqual(['error', 'warning'])
      expect(fake.wsCookies[0]).toContain('sid=test-session')
    } finally {
      await fake.close()
    }
  })

  it('maps an unauthorized close code 4000 to a permission warning', async () => {
    const fake = await startFakeHydro({ closeCode: 4000 })
    try {
      const connection = new FakeSshConnection({ forwardTarget: { host: '127.0.0.1', port: fake.port } })
      const context = fakeContext({
        connection,
        account: fakeAccount(),
        config: fakeConfig(),
      })
      const warnings = await collectWsWarnings(context, probeStub(), { timeoutMs: 400, sid: 'test-session' })
      expect(warnings.some((warning) => warning.code === 'hydro.ws.permission')).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it('skips collection when Hydro is not installed', async () => {
    const connection = new FakeSshConnection()
    const context = fakeContext({ connection, account: fakeAccount(), config: fakeConfig() })
    const warnings = await collectWsWarnings(context, probeStub({ installed: false }), { sid: 'test-session' })
    expect(warnings).toEqual([])
  })
})
