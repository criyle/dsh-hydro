import { createServer } from 'node:http'

import { describe, expect, it } from 'vitest'

import { fetchLatestVersions, registryUrl } from '../../src/hydro/registry.js'

async function startRegistry(): Promise<{ port: number; close(): Promise<void>; paths: string[] }> {
  const paths: string[] = []
  const versions: Record<string, string> = {
    hydrooj: '5.0.8',
    '@hydrooj/ui-default': '4.59.0',
    '@hydrooj/hydrojudge': '4.1.0',
  }
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    paths.push(path)
    const decoded = decodeURIComponent(path.replace(/^\//, ''))
    const name = decoded.replace(/\/latest$/, '')
    if (request.method !== 'GET') {
      response.writeHead(405)
      response.end()
      return
    }
    if (request.headers.accept !== 'application/json') {
      response.writeHead(406)
      response.end()
      return
    }
    const version = versions[name]
    if (version === undefined) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":"Not found"}')
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ name, version }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    paths,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('registryUrl', () => {
  it('builds latest-tag URLs and keeps the @ of scoped packages', () => {
    expect(registryUrl('https://registry.npmjs.org', 'hydrooj')).toBe(
      'https://registry.npmjs.org/hydrooj/latest',
    )
    expect(registryUrl('https://registry.npmjs.org/', '@hydrooj/ui-default')).toBe(
      'https://registry.npmjs.org/@hydrooj%2Fui-default/latest',
    )
    expect(registryUrl('', 'hydrooj')).toBe('https://registry.npmjs.org/hydrooj/latest')
  })
})

describe('fetchLatestVersions', () => {
  it('fetches versions for unscoped, scoped and unknown packages', async () => {
    const registry = await startRegistry()
    try {
      const base = `http://127.0.0.1:${String(registry.port)}`
      const result = await fetchLatestVersions(
        ['hydrooj', '@hydrooj/ui-default', '@hydrooj/hydrojudge', 'does-not-exist-pkg'],
        base,
      )
      expect(result.hydrooj).toBe('5.0.8')
      expect(result['@hydrooj/ui-default']).toBe('4.59.0')
      expect(result['@hydrooj/hydrojudge']).toBe('4.1.0')
      expect(result['does-not-exist-pkg']).toBeNull()
      // Scoped request path keeps @ and encodes the slash.
      expect(registry.paths).toContain('/@hydrooj%2Fui-default/latest')
      expect(registry.paths).toContain('/hydrooj/latest')
    } finally {
      await registry.close()
    }
  })

  it('returns null instead of throwing on network failures', async () => {
    const result = await fetchLatestVersions(['hydrooj'], 'http://127.0.0.1:1')
    expect(result).toEqual({ hydrooj: null })
  })

  it('returns one entry per unique name and no duplicates', async () => {
    const registry = await startRegistry()
    try {
      const result = await fetchLatestVersions(
        ['hydrooj', 'hydrooj', ' '],
        `http://127.0.0.1:${String(registry.port)}`,
      )
      expect(Object.keys(result)).toEqual(['hydrooj'])
      expect(result.hydrooj).toBe('5.0.8')
    } finally {
      await registry.close()
    }
  })

  it('handles empty input without any request', async () => {
    const result = await fetchLatestVersions([], 'http://127.0.0.1:1')
    expect(result).toEqual({})
  })
})
