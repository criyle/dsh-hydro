/**
 * Pure version helpers for Hydro core/plugin upgrade planning.
 *
 * Node-side only; no network here, so it is trivially unit-testable.
 */
import semver from 'semver'

import type { PluginInfo } from '../shared/types.js'

/** Extract a SemVer from strings such as `v1.2.3`, `1.2.3-beta.1`, `^1.2.3`. */
export function parseVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const cleaned = value.trim().replace(/^[=v\s]+/, '')
  const valid = semver.valid(cleaned)
  if (valid !== null) return valid
  const coerced = semver.coerce(cleaned)
  return coerced === null ? null : coerced.version
}

/** True when `latest` is a strictly newer release than `current`. */
export function isUpdateAvailable(current: string | null | undefined, latest: string | null | undefined): boolean {
  const a = parseVersion(current)
  const b = parseVersion(latest)
  if (a === null || b === null) return false
  return semver.gt(b, a)
}

/** Sort a plugin list by update availability first, then name. */
export function sortPlugins(plugins: PluginInfo[]): PluginInfo[] {
  return [...plugins].sort((left, right) => {
    if (left.updateAvailable !== right.updateAvailable) return left.updateAvailable ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

/** Human summary used in tool output and the UI: `2 个更新可用 / 12 个插件`. */
export function summarizePlugins(plugins: PluginInfo[]): { total: number; updates: number; outOfDate: PluginInfo[] } {
  const outOfDate = plugins.filter((plugin) => plugin.updateAvailable)
  return { total: plugins.length, updates: outOfDate.length, outOfDate }
}

/**
 * Compute the `yarn add` targets that upgrade every outdated plugin.
 * Hydro keeps the core and its plugins as regular dependencies, so a single
 * `yarn add name@version ...` both upgrades and records the new range.
 */
export function upgradeTargets(plugins: PluginInfo[]): Array<{ name: string; version: string }> {
  const targets: Array<{ name: string; version: string }> = []
  for (const plugin of plugins) {
    if (!plugin.updateAvailable || plugin.latest === null) continue
    targets.push({ name: plugin.name, version: plugin.latest })
  }
  return targets
}

/** Format `name@version` arguments for a package manager command. */
export function packageSpecs(targets: Array<{ name: string; version: string }>): string[] {
  return targets.map(({ name, version }) => `${name}@${version}`)
}

/**
 * Decide whether a version report means "the install is healthy".
 * A missing version is not unhealthy by itself, but an update pending is a hint.
 */
export function versionHealth(current: string | null, latest: string | null): 'ok' | 'outdated' | 'unknown' {
  if (current === null) return 'unknown'
  if (latest === null) return 'ok'
  return isUpdateAvailable(current, latest) ? 'outdated' : 'ok'
}
