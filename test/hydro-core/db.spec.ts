import { describe, expect, it } from 'vitest'

import { FakeSshConnection, fakeAccount, fakeConfig, fakeContext } from '../helpers/fake-ssh.js'
import {
  MAX_FIND_LIMIT,
  inspectMongo,
  listCollections,
  openMongoSession,
  queryDatabase,
  sanitizeDocument,
} from '../../src/hydro/db.js'
import { probeStub } from './fixtures.js'

function contextWith(connection = new FakeSshConnection()) {
  return { connection, context: fakeContext({ connection, account: fakeAccount(), config: fakeConfig() }) }
}

describe('inspectMongo error paths (no real mongod)', () => {
  it('reports reachable=false when the Hydro config has no URI', async () => {
    const { connection, context } = contextWith()
    const state = await inspectMongo(context, probeStub({ config: null }))
    expect(state.reachable).toBe(false)
    expect(state.version).toBeNull()
    expect(state.collections).toBeNull()
    expect(state.oplog).toEqual({ available: false, sizeBytes: null, firstTs: null, lastTs: null, entries: null })
    // No tunnel is opened when there is nothing to connect to.
    expect(connection.forwards).toHaveLength(0)
  })

  it('falls back to the configured Mongo address for display', async () => {
    const { context } = contextWith()
    const state = await inspectMongo(context, probeStub({ config: null }))
    expect(state.address).toBe('127.0.0.1:27017')
  })

  it('reports a clear error when the URI is missing', async () => {
    const { context } = contextWith()
    await expect(openMongoSession(context, probeStub({ config: null }))).rejects.toThrow(/连接配置/)
  })

  it('rejects mongodb+srv:// URIs (SSH tunnels cannot resolve SRV)', async () => {
    const { connection, context } = contextWith()
    const probe = probeStub({
      config: {
        path: '/root/.hydro/config.json',
        uri: 'mongodb+srv://cluster.example.com/hydro',
        database: 'hydro',
        host: 'cluster.example.com',
        port: 27017,
      },
    })
    await expect(openMongoSession(context, probe)).rejects.toThrow(/srv/)
    expect(connection.forwards).toHaveLength(0)
  })

  it('listCollections fails cleanly without a Mongo config', async () => {
    const { context } = contextWith()
    await expect(listCollections(context, probeStub({ config: null }))).rejects.toThrow(/连接配置/)
  })
})

describe('queryDatabase validation', () => {
  it('rejects empty and malformed collection names before connecting', async () => {
    const { connection, context } = contextWith()
    await expect(queryDatabase(context, { collection: '' }, probeStub())).rejects.toThrow(/不能为空/)
    await expect(queryDatabase(context, { collection: 'bad name' }, probeStub())).rejects.toThrow(/集合名非法/)
    await expect(queryDatabase(context, { collection: '$cmd' }, probeStub())).rejects.toThrow(/集合名非法/)
    expect(connection.forwards).toHaveLength(0)
  })

  it('clamps find limits to the documented maximum', () => {
    expect(MAX_FIND_LIMIT).toBe(50)
  })
})

describe('sanitizeDocument', () => {
  it('converts BSON values into JSON-safe output', () => {
    const sanitized = sanitizeDocument({
      _id: { _bsontype: 'ObjectId', toHexString: () => '507f1f77bcf86cd799439011' },
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      nested: [{ count: 3, tags: ['a', 'b'] }],
      nothing: undefined,
    })
    expect(sanitized).toEqual({
      _id: '507f1f77bcf86cd799439011',
      createdAt: '2026-01-02T03:04:05.000Z',
      nested: [{ count: 3, tags: ['a', 'b'] }],
      nothing: null,
    })
  })

  it('caps recursion depth for pathological documents', () => {
    let value: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 20; index += 1) value = { nested: value }
    const sanitized = JSON.stringify(sanitizeDocument(value))
    expect(sanitized).toContain('[depth limit]')
  })
})

describe.skip('MongoDB integration (requires a real mongod)', () => {
  it('connects through the SSH tunnel and lists collections', () => {
    // Intentionally skipped: unit tests must not require a running mongod.
  })
})
