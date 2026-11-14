import { describe, expect, it } from 'vitest'

import type { PluginInfo } from '../src/shared/types.js'
import {
  isUpdateAvailable,
  packageSpecs,
  parseVersion,
  sortPlugins,
  summarizePlugins,
  upgradeTargets,
  versionHealth,
} from '../src/hydro/versions.js'

function plugin(name: string, version: string | null, latest: string | null = null): PluginInfo {
  return {
    name,
    version,
    latest,
    updateAvailable: isUpdateAvailable(version, latest),
    builtin: false,
    enabled: true,
  }
}

describe('parseVersion', () => {
  it('accepts common prefixes and prereleases', () => {
    expect(parseVersion('v1.2.3')).toBe('1.2.3')
    expect(parseVersion('^0.9.0')).toBe('0.9.0')
    expect(parseVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1')
    expect(parseVersion(' 2.0 ')).toBe('2.0.0')
  })

  it('returns null for garbage and empty values', () => {
    expect(parseVersion('unknown')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(null)).toBeNull()
  })
})

describe('isUpdateAvailable', () => {
  it('compares semver rather than strings', () => {
    expect(isUpdateAvailable('1.9.0', '1.10.0')).toBe(true)
    expect(isUpdateAvailable('2.0.0', '1.99.0')).toBe(false)
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false)
    expect(isUpdateAvailable(null, '1.0.0')).toBe(false)
    expect(isUpdateAvailable('1.0.0', 'not-a-version')).toBe(false)
  })
})

describe('upgrade planning', () => {
  it('lists targets, specs and a summary', () => {
    const plugins = [plugin('@hydrooj/hydrooj', '1.0.0', '1.1.0'), plugin('@hydrooj/plugin-a', '2.0.0', '2.0.0'), plugin('@hydrooj/plugin-b', '3.0.0', '3.1.0')]
    const targets = upgradeTargets(plugins)
    expect(targets).toEqual([
      { name: '@hydrooj/hydrooj', version: '1.1.0' },
      { name: '@hydrooj/plugin-b', version: '3.1.0' },
    ])
    expect(packageSpecs(targets)).toEqual(['@hydrooj/hydrooj@1.1.0', '@hydrooj/plugin-b@3.1.0'])
    expect(summarizePlugins(plugins)).toMatchObject({ total: 3, updates: 2 })
    expect(sortPlugins(plugins).map((entry) => entry.name)).toEqual(['@hydrooj/hydrooj', '@hydrooj/plugin-b', '@hydrooj/plugin-a'])
  })

  it('does not plan an upgrade when the installed version is unknown', () => {
    expect(upgradeTargets([plugin('@hydrooj/hydrooj', null, '1.1.0')])).toEqual([])
  })
})

describe('versionHealth', () => {
  it('labels outdated and unknown states', () => {
    expect(versionHealth('1.0.0', '1.1.0')).toBe('outdated')
    expect(versionHealth('1.1.0', '1.1.0')).toBe('ok')
    expect(versionHealth(null, '1.1.0')).toBe('unknown')
    expect(versionHealth('1.0.0', null)).toBe('ok')
  })
})
