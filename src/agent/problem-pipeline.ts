/**
 * Problem-package collection and end-to-end verification.
 *
 * The authoring loop is deterministic on purpose: the model writes local files
 * (`statement.md`, `testdata/`, `std/`, `partial/`, …), the tool uploads the
 * testdata, submits the standard solution and the partial-score solutions, then
 * asserts the judge result. Everything here is local-file + HTTP work so it can
 * be tested against a fake Hydro server.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { submitSolution, uploadTestdataFile } from '../hydro/api.js'
import type { HydroSession } from '../hydro/api.js'
import { pollJudge } from '../hydro/judge.js'
import type { JudgeResult } from '../hydro/judge.js'
import { inferLangFromPath } from './language.js'

/** Refuse packages with more files than this. */
export const MAX_PACKAGE_FILES = 200
/** Refuse single files larger than this (matches the HTTP body budget). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024

/** One local package file; `path` is relative to the package root. */
export interface ProblemPackageFile {
  path: string
  data: Buffer
}

/** Result of scanning a problem package directory. */
export interface CollectProblemPackageResult {
  /** Package sources (statement, std, partial, gen, …). Excludes testdata. */
  files: ProblemPackageFile[]
  /** Files under `testdata/` (or `options.testdataDir`), relative to that dir. */
  testdata: ProblemPackageFile[]
  /** True when the testdata dir contains `config.yaml`. */
  hasConfig: boolean
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

interface WalkState {
  count: number
}

async function walkDirectory(
  root: string,
  state: WalkState,
  skipDirectory: (absolutePath: string) => boolean,
  onFile: (absolutePath: string) => Promise<void>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const absolutePath = join(root, entry.name)
    // Symlinks are skipped so a package cannot read arbitrary local files.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (skipDirectory(absolutePath)) continue
      await walkDirectory(absolutePath, state, skipDirectory, onFile)
      continue
    }
    if (!entry.isFile()) continue
    state.count += 1
    if (state.count > MAX_PACKAGE_FILES) {
      throw new Error(`题目包文件过多（超过 ${String(MAX_PACKAGE_FILES)} 个），请拆分包`)
    }
    const info = await stat(absolutePath)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(
        `文件过大（${String(info.size)} bytes，上限 ${String(MAX_FILE_BYTES)}）：${absolutePath}`,
      )
    }
    await onFile(absolutePath)
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Scan a local problem package.
 *
 * Layout expected by the scaffold action:
 *
 * ```text
 * <dir>/statement.md
 * <dir>/std/…        standard solution(s)
 * <dir>/partial/…    partial-score solution(s)
 * <dir>/gen/…        generators / validators
 * <dir>/testdata/    *.in/*.out + config.yaml
 * ```
 *
 * `options.testdataDir` overrides the testdata location (relative to `dir` or
 * absolute). Package-source files exclude the testdata tree.
 */
export async function collectProblemPackage(
  dir: string,
  options: { testdataDir?: string } = {},
): Promise<CollectProblemPackageResult> {
  const dirAbsolute = resolve(dir)
  if (!(await directoryExists(dirAbsolute))) {
    throw new Error(`题目包目录不存在或不是目录：${dirAbsolute}`)
  }
  const testdataAbsolute =
    options.testdataDir === undefined ? join(dirAbsolute, 'testdata') : resolve(dirAbsolute, options.testdataDir)
  const testdataRelative = relative(dirAbsolute, testdataAbsolute)
  const testdataInside =
    testdataRelative === '' || (!testdataRelative.startsWith('..') && !isAbsolute(testdataRelative))

  const state: WalkState = { count: 0 }
  const files: ProblemPackageFile[] = []
  const testdata: ProblemPackageFile[] = []

  await walkDirectory(
    dirAbsolute,
    state,
    (absolutePath) =>
      testdataInside && (absolutePath === testdataAbsolute || absolutePath.startsWith(`${testdataAbsolute}${sep}`)),
    async (absolutePath) => {
      files.push({ path: toPosix(relative(dirAbsolute, absolutePath)), data: await readFile(absolutePath) })
    },
  )
  if (await directoryExists(testdataAbsolute)) {
    await walkDirectory(
      testdataAbsolute,
      state,
      () => false,
      async (absolutePath) => {
        testdata.push({ path: toPosix(relative(testdataAbsolute, absolutePath)), data: await readFile(absolutePath) })
      },
    )
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  testdata.sort((left, right) => left.path.localeCompare(right.path))
  return {
    files,
    testdata,
    hasConfig: testdata.some((file) => file.path.toLowerCase() === 'config.yaml'),
  }
}

/** One local solution picked up from `std/` or `partial/`. */
export interface LocalSolutionFile {
  /** File name relative to the solution directory. */
  name: string
  /** Absolute path on disk. */
  path: string
  /** Hydro language id inferred from the extension. */
  lang: string
  code: string
}

/**
 * Read executable solutions from `<dir>/<subdir>`.
 *
 * Only known source extensions are returned; a missing directory yields an
 * empty list (callers decide whether that is fatal).
 */
export async function readSolutionDirectory(
  dir: string,
  subdir: 'std' | 'partial',
): Promise<LocalSolutionFile[]> {
  const root = join(resolve(dir), subdir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const solutions: LocalSolutionFile[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const lang = inferLangFromPath(entry.name)
    if (lang === null) continue
    if (solutions.length >= 50) throw new Error(`<${subdir}> 目录解法文件过多（最多 50 个）`)
    const absolutePath = join(root, entry.name)
    const info = await stat(absolutePath)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`解法文件过大（${String(info.size)} bytes）：${absolutePath}`)
    }
    solutions.push({
      name: entry.name,
      path: absolutePath,
      lang,
      code: await readFile(absolutePath, 'utf8'),
    })
  }
  return solutions
}

/** One partial-score solution and its expected score band. */
export interface VerifyPartialOption {
  name: string
  lang: string
  code: string
  /** Inclusive lower bound; defaults to 0. */
  expectedMinScore?: number
  /** Inclusive upper bound; defaults to 100. */
  expectedMaxScore?: number
}

/** Options for {@link verifyProblem}. */
export interface VerifyOptions {
  domain: string
  pid: string
  dir: string
  std: { lang: string; code: string }
  partials?: VerifyPartialOption[]
  timeoutMs?: number
  signal?: AbortSignal
  /** Skip the upload step (verify against testdata already on the server). */
  readonly?: boolean
}

/** Verification outcome for one partial solution. */
export interface VerifyPartialReport {
  name: string
  result: JudgeResult
  ok: boolean
  /** Human-readable expectation, e.g. `期望 1–100 分`. */
  expected: string
}

/** Outcome of one full verification round. */
export interface VerifyReport {
  ok: boolean
  std: JudgeResult
  partials: VerifyPartialReport[]
  /** Number of testdata files uploaded in this run (0 when `readonly`). */
  uploaded: number
  message: string
}

function formatExpectation(min: number, max: number): string {
  return `期望 ${String(min)}–${String(max)} 分`
}

function shortCompilerText(result: JudgeResult): string {
  if (result.compilerText === null) return ''
  const text = result.compilerText.trim()
  if (text === '') return ''
  return `\n编译器输出：\n\`\`\`\n${text.slice(0, 2000)}\n\`\`\``
}

/**
 * Upload the package testdata, submit `std` + every partial, and assert results.
 *
 * Success requires the standard solution to be accepted (status 1) and every
 * partial solution to land inside its expected score band (defaults `0..100`,
 * so a partial only has to finish judging).
 */
export async function verifyProblem(session: HydroSession, options: VerifyOptions): Promise<VerifyReport> {
  const signal = options.signal
  const timeoutMs = options.timeoutMs ?? 60_000
  const judgeOptions = (rid: string) => ({
    domain: options.domain,
    rid,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  })
  const checkAborted = (): void => {
    signal?.throwIfAborted()
  }

  let uploaded = 0
  if (options.readonly !== true) {
    const pkg = await collectProblemPackage(options.dir)
    if (pkg.testdata.length === 0) {
      throw new Error(`题目包 ${options.dir} 的 testdata 目录为空：请先生成测试数据与 config.yaml`)
    }
    for (const file of pkg.testdata) {
      checkAborted()
      await uploadTestdataFile(session, {
        domain: options.domain,
        pid: options.pid,
        name: file.path,
        data: file.data,
        type: 'testdata',
      })
      uploaded += 1
    }
  }

  checkAborted()
  const stdSubmission = await submitSolution(session, {
    domain: options.domain,
    pid: options.pid,
    lang: options.std.lang,
    code: options.std.code,
  })
  const std = await pollJudge(session, judgeOptions(stdSubmission.rid))
  const stdOk = std.finished && std.status === 1

  const partials: VerifyPartialReport[] = []
  for (const partial of options.partials ?? []) {
    checkAborted()
    const submission = await submitSolution(session, {
      domain: options.domain,
      pid: options.pid,
      lang: partial.lang,
      code: partial.code,
    })
    const result = await pollJudge(session, judgeOptions(submission.rid))
    const min = partial.expectedMinScore ?? 0
    const max = partial.expectedMaxScore ?? 100
    const ok = result.finished && result.score >= min && result.score <= max
    partials.push({ name: partial.name, result, ok, expected: formatExpectation(min, max) })
  }

  const ok = stdOk && partials.every((partial) => partial.ok)
  const lines: string[] = []
  if (options.readonly === true) lines.push('验证模式：readonly（跳过测试数据上传）')
  else lines.push(`已上传 ${String(uploaded)} 个测试数据文件到题目 ${options.pid}`)
  lines.push(
    `std（${options.std.lang}）：${std.statusText}，得分 ${String(std.score)}，` +
      `时间 ${std.timeMs === null ? '?' : String(std.timeMs) + 'ms'}，` +
      `内存 ${std.memoryKb === null ? '?' : String(Math.round(std.memoryKb / 1024)) + 'MB'}` +
      (std.finished ? '' : '（判题超时，未完成）'),
  )
  if (!stdOk) lines.push(shortCompilerText(std).trim())
  for (const partial of partials) {
    const result = partial.result
    lines.push(
      `partial ${partial.name}：${result.statusText}，得分 ${String(result.score)} ` +
        `（${partial.expected}）${partial.ok ? '✓' : '✗'}` +
        (result.finished ? '' : '（判题超时，未完成）'),
    )
  }
  if (std.cases.length > 0) {
    const failed = std.cases.filter((item) => item.status !== 1).slice(0, 8)
    if (failed.length > 0) {
      lines.push(
        `std 失败测试点：${failed
          .map((item) => `#${item.id}=${String(item.status)}${item.message === null ? '' : `(${item.message.slice(0, 80)})`}`)
          .join(', ')}`,
      )
    }
  }
  if (ok) lines.push('结论：验证通过，可以发布（hydro_problem action=publish）。')
  else lines.push('结论：验证未通过，请修复后重新运行 verify。')

  return {
    ok,
    std,
    partials,
    uploaded,
    message: lines.join('\n'),
  }
}
