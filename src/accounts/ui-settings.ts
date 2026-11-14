/**
 * Small, durable store for operator-facing UI settings.
 *
 * The global read-only switch is deliberately NOT a host or site-account
 * property: it guards the whole plugin and can be flipped from the console
 * header. Persisted so a restart does not silently re-enable writes.
 */
import { dirname, join, resolve } from 'node:path'

import {
  ensurePrivateDir,
  readJsonIfExists,
  serializeJson,
  writeFileAtomic,
} from '../util/atomic-file.js'

export interface UiSettings {
  readonlyMode: boolean
  updatedAt: string | null
}

interface UiSettingsFile {
  version: number
  readonlyMode: boolean
  updatedAt: string | null
}

const VERSION = 1

/** Load/save operator settings under the plugin data directory. */
export class UiSettingsStore {
  readonly path: string
  private settings: UiSettings = { readonlyMode: true, updatedAt: null }
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: { dataDir: string }) {
    this.path = join(resolve(options.dataDir), 'ui-settings.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await ensurePrivateDir(dirname(this.path))
    const file = await readJsonIfExists<UiSettingsFile>(this.path)
    // Safe default: a fresh install starts in read-only mode.
    if (file !== undefined && typeof file.readonlyMode === 'boolean') {
      this.settings = {
        readonlyMode: file.readonlyMode,
        updatedAt: typeof file.updatedAt === 'string' ? file.updatedAt : null,
      }
    }
    this.loaded = true
  }

  get(): UiSettings {
    this.assertLoaded()
    return { ...this.settings }
  }

  isReadonly(): boolean {
    this.assertLoaded()
    return this.settings.readonlyMode
  }

  async setReadonly(readonly: boolean): Promise<UiSettings> {
    this.assertLoaded()
    this.settings = { readonlyMode: readonly, updatedAt: new Date().toISOString() }
    await this.enqueue(async () => {
      const file: UiSettingsFile = { version: VERSION, ...this.settings }
      await writeFileAtomic(this.path, serializeJson(file), 0o600)
    })
    return this.get()
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('dsh-hydro: UI settings used before load()')
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }
}
