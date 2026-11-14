/**
 * npm registry lookups for "latest version" checks.
 *
 * Only `GET <registry>/<name>/latest` is used: no auth, no writes, and a hard
 * 5s timeout per package so a blocked network cannot stall status collection.
 */

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** Per-package registry request timeout. */
const REQUEST_TIMEOUT_MS = 5000

/** Bounded concurrency so a long plugin list cannot open dozens of sockets. */
const CONCURRENCY = 5

/**
 * URL of the `latest` dist-tag document for one package.
 *
 * Scoped names keep the `@` while the `/` is encoded, matching the registry
 * layout (`/@hydrooj%2Fui-default/latest`).
 */
export function registryUrl(base: string, name: string): string {
  const root = (base.trim() === '' ? DEFAULT_REGISTRY : base.trim()).replace(/\/+$/, '')
  const encoded = encodeURIComponent(name).replace(/%40/g, '@')
  return `${root}/${encoded}/latest`
}

async function fetchOne(registry: string, name: string): Promise<string | null> {
  try {
    const response = await fetch(registryUrl(registry, name), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { version?: unknown }
    return typeof data.version === 'string' && data.version.trim() !== '' ? data.version : null
  } catch {
    return null
  }
}

/**
 * Fetch the newest published version for each package.
 *
 * Always returns one entry per requested name; failures are `null` rather than
 * thrown. Empty input returns an empty record without a network request.
 */
export async function fetchLatestVersions(
  names: string[],
  registry: string,
): Promise<Record<string, string | null>> {
  const unique = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))]
  const result: Record<string, string | null> = {}
  for (const name of unique) result[name] = null
  if (unique.length === 0) return result

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const name = unique[cursor]
      cursor += 1
      if (name === undefined) return
      result[name] = await fetchOne(registry, name)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker()))
  return result
}
