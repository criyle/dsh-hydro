import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_FILE_BYTES,
  collectProblemPackage,
  readSolutionDirectory,
  verifyProblem,
} from '../../src/agent/problem-pipeline.js'
import { inferLangFromPath } from '../../src/agent/language.js'
import { createProblem } from '../../src/hydro/api.js'
import type { HydroSession } from '../../src/hydro/api.js'
import { openFakeSession, startFakeHydroHarness } from '../hydro-api/harness.js'
import type { FakeHydroHarness } from '../hydro-api/harness.js'

let dir: string

async function writePackage(): Promise<void> {
  await mkdir(join(dir, 'std'), { recursive: true })
  await mkdir(join(dir, 'partial'), { recursive: true })
  await mkdir(join(dir, 'gen'), { recursive: true })
  await mkdir(join(dir, 'testdata'), { recursive: true })
  await writeFile(join(dir, 'statement.md'), '# 题目\n\n输入两个数，输出和。\n', 'utf8')
  await writeFile(join(dir, 'std', 'main.cpp'), 'int main() { /* // AC */ }\n', 'utf8')
  await writeFile(join(dir, 'partial', 'wa.cpp'), 'int main() { /* // WA */ }\n', 'utf8')
  await writeFile(join(dir, 'gen', 'gen.py'), 'print("1 2")\n', 'utf8')
  await writeFile(join(dir, 'testdata', '1.in'), '1 2\n', 'utf8')
  await writeFile(join(dir, 'testdata', '1.out'), '3\n', 'utf8')
  await writeFile(join(dir, 'testdata', 'config.yaml'), 'type: default\n', 'utf8')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-package-'))
  await writePackage()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('language inference', () => {
  it('maps known extensions to Hydro language ids', () => {
    expect(inferLangFromPath('std/main.cpp')).toBe('cc')
    expect(inferLangFromPath('std/main.cc')).toBe('cc')
    expect(inferLangFromPath('std/main.c')).toBe('c')
    expect(inferLangFromPath('std/main.py')).toBe('py')
    expect(inferLangFromPath('Main.java')).toBe('java')
    expect(inferLangFromPath('main.pas')).toBe('pas')
    expect(inferLangFromPath('README.md')).toBeNull()
  })
})

describe('collectProblemPackage', () => {
  it('separates package sources from testdata and finds config.yaml', async () => {
    const pkg = await collectProblemPackage(dir)
    expect(pkg.hasConfig).toBe(true)
    expect(pkg.testdata.map((file) => file.path)).toEqual(['1.in', '1.out', 'config.yaml'])
    expect(pkg.files.map((file) => file.path)).toEqual([
      'gen/gen.py',
      'partial/wa.cpp',
      'statement.md',
      'std/main.cpp',
    ])
    const input = pkg.testdata.find((file) => file.path === '1.in')
    expect(input?.data.toString('utf8')).toBe('1 2\n')
  })

  it('honors a custom testdataDir', async () => {
    const custom = join(dir, 'data')
    await mkdir(custom, { recursive: true })
    await writeFile(join(custom, '2.in'), '3 4\n', 'utf8')
    const pkg = await collectProblemPackage(dir, { testdataDir: 'data' })
    expect(pkg.testdata.map((file) => file.path)).toEqual(['2.in'])
    expect(pkg.hasConfig).toBe(false)
    expect(pkg.files.some((file) => file.path.startsWith('testdata/'))).toBe(true)
  })

  it('rejects a missing directory and oversized files', async () => {
    await expect(collectProblemPackage(join(dir, 'nope'))).rejects.toThrow(/不存在或不是目录/)
    const big = join(dir, 'testdata', 'big.bin')
    writeFileSync(big, Buffer.alloc(MAX_FILE_BYTES + 1))
    await expect(collectProblemPackage(dir)).rejects.toThrow(/文件过大/)
  })

  it('reads solutions from std/ and partial/ with inferred languages', async () => {
    const std = await readSolutionDirectory(dir, 'std')
    expect(std).toHaveLength(1)
    expect(std[0]?.lang).toBe('cc')
    expect(std[0]?.code).toContain('// AC')
    const partials = await readSolutionDirectory(dir, 'partial')
    expect(partials[0]?.name).toBe('wa.cpp')
    expect(await readSolutionDirectory(dir, 'missing')).toEqual([])
  })
})

describe('verifyProblem', () => {
  let harness: FakeHydroHarness
  let session: HydroSession
  let pid: string

  beforeEach(async () => {
    harness = await startFakeHydroHarness()
    session = await openFakeSession(harness)
    const created = await createProblem(session, { domain: 'system', title: 'Sum', content: '# Sum' })
    pid = created.pid
  })

  afterEach(async () => {
    await session.close()
    await harness.close()
  })

  it('uploads testdata, accepts std and checks partial scores', async () => {
    const report = await verifyProblem(session, {
      domain: 'system',
      pid,
      dir,
      std: { lang: 'cc', code: 'int main() { /* // AC */ }' },
      partials: [
        {
          name: 'wa.cpp',
          lang: 'cc',
          code: 'int main() { /* // WA */ }',
          expectedMinScore: 1,
          expectedMaxScore: 99,
        },
      ],
      timeoutMs: 5_000,
    })
    expect(report.ok).toBe(true)
    expect(report.uploaded).toBe(3)
    expect(report.std.statusText).toBe('AC')
    expect(report.std.score).toBe(100)
    expect(report.partials).toHaveLength(1)
    expect(report.partials[0]?.result.score).toBe(50)
    expect(report.partials[0]?.ok).toBe(true)
    expect(report.message).toContain('验证通过')
    expect(harness.hydro.state.uploads).toHaveLength(3)
  })

  it('fails when a partial solution misses its expected band', async () => {
    const report = await verifyProblem(session, {
      domain: 'system',
      pid,
      dir,
      std: { lang: 'cc', code: 'int main() { /* // AC */ }' },
      partials: [
        { name: 'wa.cpp', lang: 'cc', code: 'int main() { /* // WA */ }', expectedMinScore: 60 },
      ],
      timeoutMs: 5_000,
    })
    expect(report.ok).toBe(false)
    expect(report.partials[0]?.ok).toBe(false)
    expect(report.message).toContain('验证未通过')
  })

  it('fails when std is not accepted', async () => {
    const report = await verifyProblem(session, {
      domain: 'system',
      pid,
      dir,
      std: { lang: 'cc', code: 'int main() { /* // WA */ }' },
      timeoutMs: 5_000,
    })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('std')
  })

  it('can skip the upload step for readonly verification', async () => {
    const report = await verifyProblem(session, {
      domain: 'system',
      pid,
      dir,
      std: { lang: 'cc', code: 'int main() { /* // AC */ }' },
      readonly: true,
      timeoutMs: 5_000,
    })
    expect(report.ok).toBe(true)
    expect(report.uploaded).toBe(0)
    expect(harness.hydro.state.uploads).toHaveLength(0)
  })
})
