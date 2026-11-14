import { createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { closeTunnels, openTunnel } from '../../src/ops/tunnel.js'
import { FakeSshConnection, fakeContext } from '../helpers/fake-ssh.js'

const servers: Array<{ close(callback: () => void): void }> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

async function localHttp(body: string): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

describe('openTunnel', () => {
  it('reuses one local listener per remote endpoint and closes on last release', async () => {
    const upstream = await localHttp('hello from hydro')
    const connection = new FakeSshConnection({ forwardTarget: { host: '127.0.0.1', port: upstream } })
    const context = fakeContext({ connection })
    const first = await openTunnel(context, { remotePort: 8888 })
    const second = await openTunnel(context, { remotePort: 8888 })
    expect(second.localPort).toBe(first.localPort)
    expect(connection.forwards).toHaveLength(1)

    const response = await fetch(`${first.baseUrl}/status`)
    expect(await response.text()).toBe('hello from hydro')

    await first.release()
    // Still open: one reference remains.
    expect(await (await fetch(`${second.baseUrl}/status`)).text()).toBe('hello from hydro')
    await second.release()
    await expect(fetch(`${first.baseUrl}/status`)).rejects.toThrow()
  })

  it('closeTunnels tears down everything for the context', async () => {
    const upstream = await localHttp('ok')
    const connection = new FakeSshConnection({ forwardTarget: { host: '127.0.0.1', port: upstream } })
    const context = fakeContext({ connection })
    const tunnel = await openTunnel(context, { remotePort: 27017 })
    await closeTunnels(context)
    await expect(fetch(`${tunnel.baseUrl}/`)).rejects.toThrow()
  })
})
