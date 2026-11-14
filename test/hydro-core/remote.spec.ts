import { describe, expect, it } from 'vitest'

import {
  buildTunnelUri,
  detectRole,
  parseHydroConfig,
  parseMongoUri,
  parsePm2Jlist,
  parseYarnGlobalDir,
  redactSensitive,
  bsonTimeToIso,
} from '../../src/hydro/remote.js'

describe('parseMongoUri', () => {
  it('parses a standard authenticated URI', () => {
    const parsed = parseMongoUri('mongodb://hydro:secret@127.0.0.1:27017/hydro')
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(27017)
    expect(parsed.database).toBe('hydro')
    expect(parsed.username).toBe('hydro')
    expect(parsed.password).toBe('secret')
    expect(parsed.authSource).toBeNull()
    expect(parsed.options).toEqual({})
  })

  it('decodes credentials and keeps URI options', () => {
    const parsed = parseMongoUri(
      'mongodb://admin:p%40ss%3Aword@db.example.com:27018/oj?authSource=admin&replicaSet=rs0&tls=true',
    )
    expect(parsed.host).toBe('db.example.com')
    expect(parsed.port).toBe(27018)
    expect(parsed.database).toBe('oj')
    expect(parsed.username).toBe('admin')
    expect(parsed.password).toBe('p@ss:word')
    expect(parsed.authSource).toBe('admin')
    expect(parsed.options.replicaSet).toBe('rs0')
    expect(parsed.options.tls).toBe('true')
  })

  it('uses the first host of a replica-set host list', () => {
    const parsed = parseMongoUri('mongodb://user:pass@mongo1:27017,mongo2:27018/hydro')
    expect(parsed.host).toBe('mongo1')
    expect(parsed.port).toBe(27017)
  })

  it('supports IPv6 literals and defaults the port', () => {
    const parsed = parseMongoUri('mongodb://[::1]/hydro')
    expect(parsed.host).toBe('::1')
    expect(parsed.port).toBe(27017)
  })

  it('omits credentials when the URI is unauthenticated', () => {
    const parsed = parseMongoUri('mongodb+srv://cluster.example.com/hydro')
    expect(parsed.host).toBe('cluster.example.com')
    expect(parsed.username).toBeNull()
    expect(parsed.password).toBeNull()
  })

  it('rejects empty / host-less URIs', () => {
    expect(() => parseMongoUri('   ')).toThrow(/为空/)
    expect(() => parseMongoUri('mongodb://')).toThrow(/主机/)
  })
})

describe('buildTunnelUri', () => {
  it('rewrites the endpoint and preserves credentials/db/options', () => {
    const original = 'mongodb://hydro:p%40ss@127.0.0.1:27017/hydro?authSource=hydro&directConnection=true'
    const rewritten = buildTunnelUri(original, '127.0.0.1', 53210)
    const parsed = parseMongoUri(rewritten)
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(53210)
    expect(parsed.database).toBe('hydro')
    expect(parsed.username).toBe('hydro')
    expect(parsed.password).toBe('p@ss')
    expect(parsed.authSource).toBe('hydro')
    expect(parsed.options.directConnection).toBe('true')
  })

  it('brackets IPv6 tunnel hosts', () => {
    const rewritten = buildTunnelUri('mongodb://127.0.0.1:27017/hydro', '::1', 40000)
    expect(rewritten.startsWith('mongodb://[::1]:40000')).toBe(true)
    expect(parseMongoUri(rewritten).port).toBe(40000)
  })
})

describe('parseHydroConfig', () => {
  it('parses the installer uri form', () => {
    const config = parseHydroConfig('{"uri":"mongodb://hydro:pw@127.0.0.1:27017/hydro"}')
    expect(config.uri).toBe('mongodb://hydro:pw@127.0.0.1:27017/hydro')
    expect(config.database).toBe('hydro')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(27017)
    expect(config.path).toBeNull()
  })

  it('returns defaults for null / invalid input', () => {
    expect(parseHydroConfig(null)).toMatchObject({ uri: null, database: null, host: '127.0.0.1', port: 27017 })
    expect(parseHydroConfig('not json')).toMatchObject({ uri: null, host: '127.0.0.1' })
  })
})

describe('parsePm2Jlist', () => {
  it('maps pm2 entries to the probe shape', () => {
    const now = Date.now()
    const text = JSON.stringify([
      {
        name: 'hydrooj',
        pid: 42,
        pm2_env: { status: 'online', restart_time: 7, pm_uptime: now - 5000, pm_exec_path: '/x/hydrooj.js' },
      },
      { name: 'stopped-one', pid: 0, pm2_env: { status: 'stopped', restart_time: 0 } },
    ])
    const entries = parsePm2Jlist(text)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ name: 'hydrooj', status: 'online', pid: 42, restarts: 7, execPath: '/x/hydrooj.js' })
    expect(entries[0]?.uptimeMs).toBeGreaterThanOrEqual(5000)
    expect(entries[1]).toMatchObject({ name: 'stopped-one', pid: null, status: 'stopped' })
  })

  it('tolerates banners before the JSON array', () => {
    const entries = parsePm2Jlist('Please start pm2\n[{"name":"caddy","pm2_env":{"status":"online"}}]\nDone')
    expect(entries.map((entry) => entry.name)).toEqual(['caddy'])
  })

  it('returns [] for empty or junk output', () => {
    expect(parsePm2Jlist('')).toEqual([])
    expect(parsePm2Jlist('not json at all')).toEqual([])
  })
})

describe('parseYarnGlobalDir', () => {
  it('extracts the path from yarn output', () => {
    expect(parseYarnGlobalDir('yarn global dir v1.22.22\n/usr/local/share/.config/yarn/global\nDone in 0.05s.')).toBe(
      '/usr/local/share/.config/yarn/global',
    )
  })

  it('returns null when no absolute path is present', () => {
    expect(parseYarnGlobalDir('error No global folder')).toBeNull()
  })
})

describe('detectRole', () => {
  it('detects root from uid 0', () => {
    expect(detectRole('0\n', 'no')).toBe('root')
  })

  it('detects sudo from a successful passwordless-sudo probe', () => {
    expect(detectRole('1000\n', 'yes')).toBe('sudo')
  })

  it('falls back to user', () => {
    expect(detectRole('1000', 'no')).toBe('user')
    expect(detectRole('1000', '')).toBe('user')
  })
})

describe('redaction helpers', () => {
  it('never leaks Mongo credentials or password lines', () => {
    const redacted = redactSensitive(
      '数据库密码： deadbeef\nuri=mongodb://hydro:deadbeef@127.0.0.1:27017/hydro\npassword: hunter2',
    )
    expect(redacted).not.toContain('deadbeef')
    expect(redacted).not.toContain('hunter2')
    expect(redacted).toContain('mongodb://***')
    expect(redacted).toContain('密码： ***')
  })

  it('converts BSON timestamps and dates to ISO strings', () => {
    expect(bsonTimeToIso(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(bsonTimeToIso({ _bsontype: 'Timestamp', getHighBits: () => 1767323045 })).toBe('2026-01-02T03:04:05.000Z')
  })
})
