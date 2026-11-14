import { describe, expect, it } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import { queryOplog } from '../../src/hydro/oplog.js'
import { probeStub } from './fixtures.js'

function contextWith() {
  const connection = new FakeSshConnection()
  return {
    connection,
    context: fakeContext({ connection, account: fakeAccount(), config: fakeConfig() }),
  }
}

describe('queryOplog fallbacks (no Mongo reachable)', () => {
  it('auto: falls back to mongo source with an explanatory note', async () => {
    const { connection, context } = contextWith()
    const result = await queryOplog(context, { source: 'auto' }, probeStub({ config: null }))
    expect(result.source).toBe('mongo')
    expect(result.fallback).toBe(true)
    expect(result.entries).toEqual([])
    expect(result.note).toContain('无法连接 MongoDB')
    expect(connection.forwards).toHaveLength(0)
  })

  it('hydro: reports the Hydro audit log as unavailable instead of throwing', async () => {
    const { context } = contextWith()
    const result = await queryOplog(context, { source: 'hydro', type: 'user.login' }, probeStub({ config: null }))
    expect(result.source).toBe('hydro')
    expect(result.fallback).toBe(true)
    expect(result.note).toContain('无法连接 MongoDB')
  })

  it('mongo: reports the unavailable oplog with a standalone explanation', async () => {
    const { context } = contextWith()
    const result = await queryOplog(context, { source: 'mongo' }, probeStub({ config: null }))
    expect(result.source).toBe('mongo')
    expect(result.fallback).toBe(true)
    expect(result.entries).toEqual([])
    expect(result.note).toContain('无法连接 MongoDB')
  })

  it('explains that mongodb+srv:// cannot be tunnelled', async () => {
    const { context } = contextWith()
    const probe = probeStub({
      config: {
        path: '/root/.hydro/config.json',
        uri: 'mongodb+srv://cluster.example.com/hydro',
        database: 'hydro',
        host: 'cluster.example.com',
        port: 27017,
      },
    })
    const result = await queryOplog(context, { source: 'auto' }, probe)
    expect(result.fallback).toBe(true)
    expect(result.note).toContain('srv')
  })

  it('accepts query filters without throwing when nothing is reachable', async () => {
    const { context } = contextWith()
    const result = await queryOplog(
      context,
      {
        source: 'auto',
        type: 'problem.edit',
        contains: 'edit',
        operator: 2,
        since: '2026-01-01T00:00:00.000Z',
        limit: 1000,
      },
      probeStub({ config: null }),
    )
    expect(result.entries).toEqual([])
    expect(result.mongo).toBeNull()
  })
})

describe.skip('oplog integration (requires a replica set)', () => {
  it('reads local.oplog.rs through the tunnel', () => {
    // Intentionally skipped: the default standalone install has no oplog.
  })
})
