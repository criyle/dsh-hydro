import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { en, interpolate, translatorFor, translateChinese, zh } from '../../src/client/locales.js'
import { disposeClientI18n, installClientI18n, t } from '../../src/client/i18n.js'
import { currentThemeMode, installClientTheme } from '../../src/client/theme.js'
import type { ClientContext } from '../../src/client/context.js'

const CLIENT_DIR = join(process.cwd(), 'src', 'client')

/** Recursively list every .ts/.tsx file under src/client. */
async function clientFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await clientFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1] ?? '').sort()
}

describe('locale dictionaries', () => {
  it('defines the same keys for zh and en', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('keeps the same placeholders in both languages', () => {
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(zh[key]), `placeholders differ for ${key}`).toEqual(placeholders(en[key]))
    }
  })

  it('fills named placeholders and keeps unknown ones', () => {
    expect(interpolate('pid {pid} · {missing}', { pid: 42 })).toBe('pid 42 · {missing}')
    expect(interpolate('no params')).toBe('no params')
  })

  it('falls back to English for missing dictionary entries', () => {
    const partial = translatorFor({ 'panel.title': 'Hydro（自定义）' })
    expect(partial('panel.title')).toBe('Hydro（自定义）')
    expect(partial('panel.refresh')).toBe(en['panel.refresh'])
    expect(partial('menu.server')).toBe('Server')
  })

  it('translates the Chinese baseline', () => {
    expect(translateChinese('menu.server')).toBe('服务器')
  })
})

describe('locale runtime', () => {
  it('registers both baselines and binds the live translator', () => {
    const registrations: Array<{ ns: string; locale: string }> = []
    let listener: (() => void) | undefined
    const locale = {
      active: 'zh',
      register(ns: string, code: string) {
        registrations.push({ ns, locale: code })
        return () => undefined
      },
      bind(ns: string) {
        return (key: string, params?: Record<string, unknown>) => interpolate((zh as Record<string, string>)[key] ?? key, params)
      },
      getLocale() { return { active: locale.active } },
      subscribe(fn: () => void) {
        listener = fn
        return () => { listener = undefined }
      },
    }
    const ctx = {
      slots: { register: () => () => undefined, inject: () => () => undefined },
      effect: (body: () => () => void) => body(),
      get: (name: string) => (name === 'locale' ? locale : undefined),
    } as unknown as ClientContext
    const i18n = installClientI18n(ctx)
    try {
      expect(registrations.map((entry) => entry.locale).sort()).toEqual(['en', 'zh'])
      expect(i18n.locale()).toBe('zh')
      expect(t('menu.server')).toBe('服务器')
      let changes = 0
      const unsubscribe = i18n.subscribe(() => { changes += 1 })
      locale.active = 'en'
      listener?.()
      expect(changes).toBe(1)
      expect(i18n.locale()).toBe('en')
      unsubscribe()
    } finally {
      disposeClientI18n()
      i18n.dispose()
    }
  })
})

describe('theme runtime', () => {
  it('tracks light/dark from the shell palette', () => {
    let handler: (() => void) | undefined
    const theme = {
      mode: 'light' as 'light' | 'dark',
      getTheme() { return { active: { colorScheme: theme.mode } } },
    }
    const ctx = {
      slots: { register: () => () => undefined, inject: () => () => undefined },
      effect: (body: () => () => void) => body(),
      get: (name: string) => (name === 'theme' ? theme : undefined),
      on: (event: string, listener: () => void) => {
        if (event === 'theme/change') handler = listener
        return () => { handler = undefined }
      },
    } as unknown as ClientContext
    const dispose = installClientTheme(ctx)
    try {
      expect(currentThemeMode()).toBe('light')
      theme.mode = 'dark'
      handler?.()
      expect(currentThemeMode()).toBe('dark')
    } finally {
      dispose()
    }
  })
})

describe('client source guards', () => {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

  it('keeps user-visible copy out of components (locale files own translations)', async () => {
    // Every component/module under src/client (including pages/) except the
    // dictionaries themselves; new files are covered automatically.
    const files = (await clientFiles(CLIENT_DIR)).filter((file) => !file.endsWith('locales.ts')).sort()
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const offending = source.split('\n').filter((line) => CJK.test(line) && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      expect(offending, `${file} contains hard-coded CJK copy`).toEqual([])
    }
  })

  it('uses the DSH design-system tokens instead of invented variable names', async () => {
    const styles = await readFile(join(CLIENT_DIR, 'styles.ts'), 'utf8')
    expect(styles).not.toMatch(/--dsh-(text|surface|border|accent)-/)
    expect(styles.match(/--dsw-alias-/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
    const warnings = await readFile(join(CLIENT_DIR, 'warnings.tsx'), 'utf8')
    expect(warnings).toContain('colors.danger')
    expect(warnings).toContain('colors.warning')
    const services = await readFile(join(CLIENT_DIR, 'pages', 'ServicesPage.tsx'), 'utf8')
    expect(services).toContain('colors.success')
  })

  it('ships localized plugin metadata for zh and en', async () => {
    for (const locale of ['zh', 'en']) {
      const raw = await readFile(join(process.cwd(), 'locale', `${locale}.json`), 'utf8')
      const meta = (JSON.parse(raw) as { meta: { title?: string; description?: string } }).meta
      expect(meta.title).toBeTruthy()
      expect(meta.description).toBeTruthy()
    }
  })
})
