import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { UiSettingsStore } from '../../src/accounts/ui-settings.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-ui-settings-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })))
})

describe('UiSettingsStore', () => {
  it('defaults to read-only and persists the global switch', async () => {
    const dir = await tempDir()
    const store = new UiSettingsStore({ dataDir: dir })
    await store.load()
    expect(store.isReadonly()).toBe(true)

    const updated = await store.setReadonly(false)
    expect(updated.readonlyMode).toBe(false)
    expect(updated.updatedAt).toMatch(/T/)

    const file = await readFile(join(dir, 'ui-settings.json'), 'utf8')
    expect(JSON.parse(file)).toMatchObject({ readonlyMode: false })
    expect((await stat(join(dir, 'ui-settings.json'))).mode & 0o777).toBe(0o600)

    const reloaded = new UiSettingsStore({ dataDir: dir })
    await reloaded.load()
    expect(reloaded.isReadonly()).toBe(false)
    expect(reloaded.get().updatedAt).toBe(updated.updatedAt)
  })
})
