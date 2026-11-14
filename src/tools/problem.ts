/**
 * `hydro_problem` — one grouped tool for the whole problem-authoring loop.
 *
 * `scaffold` is local-only; every other action goes through an authenticated
 * Hydro admin session over the SSH tunnel. Remote mutations are wrapped in
 * `withWritableContext`, so the global/account read-only switch is enforced in
 * one place.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  createProblem,
  editProblem,
  getProblemConfig,
  getProblemMeta,
  submitSolution,
  uploadTestdataFile,
} from '../hydro/api.js'
import { pollJudge } from '../hydro/judge.js'
import type { JudgeResult } from '../hydro/judge.js'
import { judgeStatusText } from '../hydro/judge.js'
import { inferLangFromPath } from '../agent/language.js'
import {
  collectProblemPackage,
  readSolutionDirectory,
  verifyProblem,
} from '../agent/problem-pipeline.js'
import type { VerifyPartialOption } from '../agent/problem-pipeline.js'
import { withHydroSession } from '../agent/session.js'
import type { ToolDeps } from './types.js'

/** Resolve a local path against the workspace root (process cwd). */
function resolveLocal(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

/** A filesystem-friendly fallback directory name from a title. */
function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug === '' ? 'problem' : slug
}

/** Default package directory: `<workspaceDir>/<pid|slug|problem>`. */
function defaultPackageDir(deps: ToolDeps, pid?: string, title?: string): string {
  const workspace = resolveLocal(deps.config.problem.workspaceDir)
  const name = pid !== undefined && pid !== '' ? pid : title !== undefined ? slugify(title) : 'problem'
  return join(workspace, name)
}

/** Directory used by upload/verify/scaffold: explicit `dir` or the default. */
function packageDir(deps: ToolDeps, args: { dir?: string; pid?: string; title?: string }): string {
  if (args.dir !== undefined && args.dir !== '') return resolveLocal(args.dir)
  return defaultPackageDir(deps, args.pid, args.title)
}

/** Resolve the domain: explicit arg, then the account default, then config. */
function resolveDomain(domain: string | undefined, deps: ToolDeps): string {
  if (domain !== undefined && domain.trim() !== '') return domain.trim()
  return deps.config.problem.defaultDomain
}

function requirePid(pid: string | undefined): string {
  if (pid === undefined || pid.trim() === '') throw new Error('缺少 pid：该动作需要已有题目编号')
  return pid.trim()
}

/** Extract a title from a markdown statement's first `# heading`. */
function extractTitle(content: string): string | undefined {
  const match = /^#\s+(.+)$/m.exec(content)
  const title = match?.[1]?.trim()
  return title === undefined || title === '' ? undefined : title
}

/** Read `<dir>/statement.md`, with a model-facing error when missing. */
async function readStatementFile(dir: string): Promise<string> {
  const path = join(dir, 'statement.md')
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`未找到题面文件 ${path}：请先运行 action=scaffold 或直接传 statement`)
    }
    throw error
  }
}

/** Write a file only when it does not exist yet (`wx`), reporting whether it was created. */
async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

const SCAFFOLD_STATEMENT = `# 题目标题

## 题目描述

在这里写题面。说明背景与要求，但不要提示解法。

## 输入格式

## 输出格式

## 样例

\`\`\`text
1 2
\`\`\`

\`\`\`text
3
\`\`\`

## 数据范围

- 对于 30% 的数据，……
- 对于 100% 的数据，……
`

const SCAFFOLD_CONFIG = `type: default
time: 1000ms
memory: 256MB
subtasks:
  - type: sum
    score: 100
    cases:
      - input: 1.in
        output: 1.out
`

const SCAFFOLD_TESTDATA_README = `# testdata

把测试数据放在这里：\`1.in / 1.out\`、\`2.in / 2.out\` …

- 文件名按字典序就是测试点顺序。
- \`config.yaml\` 是普通 testdata 文件，\`hydro_problem action=upload\` 会一起上传。
- 生成器/validator 放 \`../gen/\`，std 放 \`../std/\`，部分分程序放 \`../partial/\`。
- 上传后用 \`hydro_problem action=verify\` 提交 std 与 partial 并断言判题结果。
`

/** Human summary of one judge result for the tool message. */
function formatJudgeResult(result: JudgeResult): string {
  const lines = [
    `判题记录 ${result.rid}：${result.statusText}，得分 ${String(result.score)}`,
    `时间 ${result.timeMs === null ? '?' : `${String(result.timeMs)}ms`}，` +
      `内存 ${result.memoryKb === null ? '?' : `${String(Math.round(result.memoryKb / 1024))}MB`}`,
  ]
  if (result.compilerText !== null) {
    lines.push(`编译器输出：\n\`\`\`\n${result.compilerText.trim().slice(0, 2000)}\n\`\`\``)
  }
  const failed = result.cases.filter((item) => item.status !== 1)
  if (failed.length > 0) {
    lines.push(
      `未通过测试点（最多列出 10 个）：${failed
        .slice(0, 10)
        .map(
          (item) =>
            `#${item.id} ${judgeStatusText(item.status)}` +
            `${item.message === null ? '' : `(${item.message.slice(0, 120)})`}`,
        )
        .join('；')}`,
    )
  }
  if (!result.finished) lines.push('注意：判题超时，记录仍在进行中。')
  return lines.join('\n')
}

/** Resolve the std solution from args, falling back to `<dir>/std/`. */
async function resolveStd(
  args: { stdLang?: string; stdCode?: string },
  dir: string,
): Promise<{ lang: string; code: string }> {
  let lang = args.stdLang
  let code = args.stdCode
  if (lang === undefined || code === undefined) {
    const solutions = await readSolutionDirectory(dir, 'std')
    const first = solutions[0]
    if (first === undefined) {
      throw new Error(`std 目录（${join(dir, 'std')}）里没有可识别的源码文件，或请显式提供 stdLang/stdCode`)
    }
    if (lang === undefined) lang = first.lang
    if (code === undefined) code = first.code
  }
  if (lang.trim() === '' || code.trim() === '') throw new Error('std 解法不能为空（需要 lang 与 code）')
  return { lang, code }
}

/** Resolve partial solutions from args, falling back to `<dir>/partial/`. */
async function resolvePartials(
  args: {
    partials?: Array<{
      name: string
      lang?: string
      code?: string
      expectedMinScore?: number
      expectedMaxScore?: number
    }>
  },
  dir: string,
  deps: ToolDeps,
): Promise<VerifyPartialOption[]> {
  if (args.partials !== undefined) {
    return args.partials.map((partial) => {
      if (partial.code === undefined || partial.code.trim() === '') {
        throw new Error(`partials 里的 ${partial.name} 缺少 code`)
      }
      const lang = partial.lang ?? inferLangFromPath(partial.name)
      if (lang === null) {
        throw new Error(`无法从文件名 ${partial.name} 推断语言，请显式提供 lang`)
      }
      return {
        name: partial.name,
        lang,
        code: partial.code,
        expectedMinScore: partial.expectedMinScore ?? deps.config.problem.partialMinScore,
        ...(partial.expectedMaxScore === undefined ? {} : { expectedMaxScore: partial.expectedMaxScore }),
      }
    })
  }
  const solutions = await readSolutionDirectory(dir, 'partial')
  return solutions.map((solution) => ({
    name: solution.name,
    lang: solution.lang,
    code: solution.code,
    expectedMinScore: deps.config.problem.partialMinScore,
  }))
}

/** Output schema shared by every action. */
const problemOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true, description: '执行的动作' },
    ok: { type: 'boolean', required: true, description: '动作是否成功' },
    message: { type: 'string', required: true, description: '中文摘要' },
    accountId: { type: 'string', description: '账号 id' },
    domain: { type: 'string', description: '域 id' },
    pid: { type: 'string', description: '题目编号' },
    rid: { type: 'string', description: '判题记录 id' },
    dir: { type: 'string', description: '本地题目包目录' },
    files: { type: 'array', items: { type: 'string' }, description: '涉及的文件列表' },
    uploaded: { type: 'integer', description: '本次上传的测试数据文件数' },
    judgeStatus: { type: 'string', description: '判题状态名（如 AC/WA）' },
    score: { type: 'number', description: '得分' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          score: { type: 'number', required: true },
          message: { type: 'string' },
        },
      },
      description: '测试点摘要',
    },
  },
} as const

/** Register the grouped `hydro_problem` tool. */
export function registerProblemTools(deps: ToolDeps): void {
  const { ctx, config } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_problem',
      description: [
        'HydroOJ 题目全流程工具（动作由 action 决定）：',
        'scaffold=在本地 dir 生成题目包骨架（statement.md、std/、partial/、gen/、testdata/、config.yaml 模板，仅本地写入）；',
        'create=在远端建题（domain+title+statement，返回 pid）；',
        'upload=把题目包 testdata/ 下所有文件（含 config.yaml）逐个上传到 pid；',
        'submit=提交一段代码（lang+code）并轮询判题，返回判题结果摘要；',
        'verify=上传数据后提交 dir/std 与 dir/partial 中的解法，断言 std AC、partial 分数在预期区间；',
        'publish=把题目 hidden 改为 false（发布）；',
        'info=读取题目标题/隐藏状态/config.yaml/testdata 列表。',
        '远端写操作受只读模式保护；需要先在内嵌浏览器登录 Hydro 站点账号。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: {
          type: 'string',
          enum: ['scaffold', 'create', 'edit', 'upload', 'submit', 'verify', 'publish', 'info'],
          required: true,
          description: '操作类型',
        },
        domain: { type: 'string', description: '域 id，默认账号默认域（通常 system）' },
        pid: { type: 'string', description: '题目编号（upload/submit/verify/publish/info 必需；create 可自定义）' },
        dir: { type: 'string', description: '本地题目包目录（相对 workspace 或绝对路径）' },
        title: { type: 'string', description: '题目标题（create 必需，缺省从 statement.md 一级标题提取）' },
        statement: { type: 'string', description: '题面 markdown；缺省读取 <dir>/statement.md' },
        hidden: { type: 'boolean', description: 'create 时是否隐藏（默认不传=Hydro 默认）' },
        difficulty: { type: 'integer', description: '难度 0-10' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
        lang: { type: 'string', description: 'submit 的判题语言 id，如 cc/py/java' },
        code: { type: 'string', description: 'submit 的源代码' },
        stdLang: { type: 'string', description: 'verify 的标准程序语言；缺省从 std/ 扩展名推断' },
        stdCode: { type: 'string', description: 'verify 的标准程序代码；缺省读取 std/ 中第一个源码文件' },
        partials: {
          type: 'array',
          description: 'verify 的部分分程序列表；缺省读取 partial/ 目录',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true, description: '名称（用于报告）' },
              lang: { type: 'string', description: '语言；缺省按 name 扩展名推断' },
              code: { type: 'string', description: '源码' },
              expectedMinScore: { type: 'number', description: '期望最低分（含）' },
              expectedMaxScore: { type: 'number', description: '期望最高分（含）' },
            },
          },
        },
        skipUpload: {
          type: 'boolean',
          description: 'verify 时跳过测试数据上传（假设远端已是最新数据）',
        },
        timeoutMs: { type: 'integer', description: '单次判题轮询上限毫秒，默认取插件配置' },
        confirm: { type: 'boolean', description: 'edit/upload/submit/verify/publish 写操作需要 true' },
      },
      output: {
        schema: problemOutputSchema,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const action = args.action
        const signal = exec.signal

        if (action === 'scaffold') {
          const dir = packageDir(deps, args)
          const title = args.title ?? '题目标题'
          const statement = SCAFFOLD_STATEMENT.replace('# 题目标题', `# ${title}`)
          await mkdir(join(dir, 'std'), { recursive: true })
          await mkdir(join(dir, 'partial'), { recursive: true })
          await mkdir(join(dir, 'gen'), { recursive: true })
          await mkdir(join(dir, 'testdata'), { recursive: true })
          const created: string[] = []
          if (await writeIfMissing(join(dir, 'statement.md'), statement)) created.push('statement.md')
          // config.yaml lives inside testdata/ so the upload action (which
          // walks testdata/) always ships it together with the data files.
          if (await writeIfMissing(join(dir, 'testdata', 'config.yaml'), SCAFFOLD_CONFIG)) {
            created.push('testdata/config.yaml')
          }
          if (await writeIfMissing(join(dir, 'testdata', 'README.md'), SCAFFOLD_TESTDATA_README)) {
            created.push('testdata/README.md')
          }
          return {
            action,
            ok: true,
            message:
              `已在 ${dir} 生成题目包骨架（新建：${created.length === 0 ? '无（文件已存在）' : created.join(', ')}）。` +
              '接下来：写 statement.md / std/ / partial/ / gen/，生成 testdata 后依次调用 create → upload → verify → publish。',
            dir,
            files: created,
          }
        }

        if (action === 'create') {
          const dir = packageDir(deps, args)
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.create',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              const content = args.statement ?? (await readStatementFile(dir))
              const title = args.title ?? extractTitle(content)
              if (title === undefined || title.trim() === '') {
                throw new Error('缺少 title：请提供 title，或在 statement.md 第一行写 "# 标题"')
              }
              const created = await createProblem(session, {
                domain,
                title: title.trim(),
                content,
                ...(args.pid === undefined ? {} : { pid: args.pid }),
                ...(args.hidden === undefined ? {} : { hidden: args.hidden }),
                ...(args.difficulty === undefined ? {} : { difficulty: args.difficulty }),
                ...(args.tags === undefined ? {} : { tags: args.tags }),
              })
              return {
                action,
                ok: true,
                message:
                  `已创建题目 ${created.pid}（域 ${domain}，${args.hidden === true ? 'hidden=true' : 'hidden=false'}）。` +
                  `下一步：hydro_problem action=upload pid=${created.pid}。`,
                accountId: context.account.id,
                domain,
                pid: created.pid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'upload') {
          const pid = requirePid(args.pid)
          const dir = packageDir(deps, args)
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.upload',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              const pkg = await collectProblemPackage(dir)
              if (pkg.testdata.length === 0) {
                throw new Error(`目录 ${join(dir, 'testdata')} 中没有测试数据文件`)
              }
              const uploaded: string[] = []
              for (const file of pkg.testdata) {
                signal?.throwIfAborted()
                await uploadTestdataFile(session, {
                  domain,
                  pid,
                  name: file.path,
                  data: file.data,
                  type: 'testdata',
                })
                uploaded.push(file.path)
              }
              const shown = uploaded.slice(0, 30).join(', ')
              return {
                action,
                ok: true,
                message:
                  `已上传 ${String(uploaded.length)} 个测试数据文件到题目 ${pid}（域 ${domain}）：${shown}` +
                  `${uploaded.length > 30 ? '…' : ''}` +
                  `${pkg.hasConfig ? '；config.yaml 已包含' : '；警告：未发现 config.yaml（Hydro 将使用默认配置）'}`,
                accountId: context.account.id,
                domain,
                pid,
                uploaded: uploaded.length,
                files: uploaded,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'submit') {
          const pid = requirePid(args.pid)
          const lang = args.lang
          const code = args.code
          if (lang === undefined || lang.trim() === '') throw new Error('submit 需要 lang（判题语言 id）')
          if (code === undefined || code.trim() === '') throw new Error('submit 需要 code（源代码）')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.submit',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              const submission = await submitSolution(session, { domain, pid, lang, code })
              const result = await pollJudge(session, {
                domain,
                rid: submission.rid,
                timeoutMs: args.timeoutMs ?? config.problem.judgeTimeoutMs,
                ...(signal === undefined ? {} : { signal }),
              })
              return {
                action,
                ok: result.finished,
                message: formatJudgeResult(result),
                accountId: context.account.id,
                domain,
                pid,
                rid: submission.rid,
                judgeStatus: result.statusText,
                score: result.score,
                cases: result.cases.map((item) => ({
                  id: item.id,
                  status: judgeStatusText(item.status),
                  score: item.score,
                  ...(item.message === null ? {} : { message: item.message.slice(0, 200) }),
                })),
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'verify') {
          const pid = requirePid(args.pid)
          const dir = packageDir(deps, args)
          const std = await resolveStd(args, dir)
          const partials = await resolvePartials(args, dir, deps)
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.verify',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              const report = await verifyProblem(session, {
                domain,
                pid,
                dir,
                std,
                partials,
                timeoutMs: args.timeoutMs ?? config.problem.judgeTimeoutMs,
                ...(args.skipUpload === true ? { readonly: true } : {}),
                ...(signal === undefined ? {} : { signal }),
              })
              return {
                action,
                ok: report.ok,
                message: report.message,
                accountId: context.account.id,
                domain,
                pid,
                uploaded: report.uploaded,
                judgeStatus: report.std.statusText,
                score: report.std.score,
                cases: report.std.cases.map((item) => ({
                  id: item.id,
                  status: judgeStatusText(item.status),
                  score: item.score,
                  ...(item.message === null ? {} : { message: item.message.slice(0, 200) }),
                })),
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'edit') {
          const pid = requirePid(args.pid)
          if (args.confirm !== true) throw new Error('拒绝执行：修改题目需要 confirm=true')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.edit',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              if (args.title === undefined && args.statement === undefined
                && args.difficulty === undefined && args.hidden === undefined
                && (args.tags === undefined || args.tags.length === 0)) {
                throw new Error('edit 至少需要 title/statement/difficulty/hidden/tags 之一')
              }
              const edited = await editProblem(session, {
                domain,
                pid,
                ...(args.title === undefined ? {} : { title: args.title }),
                ...(args.statement === undefined ? {} : { content: args.statement }),
                ...(args.hidden === undefined ? {} : { hidden: args.hidden }),
                ...(args.difficulty === undefined ? {} : { difficulty: args.difficulty }),
                ...(args.tags === undefined ? {} : { tags: args.tags }),
              })
              return {
                action: 'edit',
                ok: true,
                message: `已修改题目 ${edited.pid}（域 ${domain}）。请用 hydro_problem action=info 复核，或打开题目页确认。`,
                accountId: context.account.id,
                domain,
                pid: edited.pid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'publish') {
          const pid = requirePid(args.pid)
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_problem.publish',
            async ({ session, context }) => {
              const domain = resolveDomain(args.domain, deps)
              const edited = await editProblem(session, { domain, pid, hidden: false })
              return {
                action,
                ok: true,
                message: `已发布题目 ${edited.pid}（域 ${domain}，hidden=false）。请把题目链接发给用户确认。`,
                accountId: context.account.id,
                domain,
                pid: edited.pid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        const pid = requirePid(args.pid)
        return withHydroSession(
          deps,
          args.accountId,
          'hydro_problem.info',
          async ({ session, context }) => {
            const domain = resolveDomain(args.domain, deps)
            const [meta, problemConfig] = await Promise.all([
              getProblemMeta(session, { domain, pid }),
              getProblemConfig(session, { domain, pid }),
            ])
            return {
              action: 'info',
              ok: true,
              message:
                `题目 ${meta.pid}（域 ${domain}）：标题「${meta.title ?? '未知'}」，` +
                `hidden=${meta.hidden === null ? '未知' : String(meta.hidden)}，` +
                `difficulty=${meta.difficulty === null ? '未知' : String(meta.difficulty)}。\n` +
                `testdata（${String(problemConfig.testdata.length)} 个文件）：` +
                `${problemConfig.testdata.slice(0, 40).join(', ') || '(空)'}\n` +
                `config.yaml：\n\`\`\`yaml\n${problemConfig.config.slice(0, 4000) || '(空)'}\n\`\`\``,
              accountId: context.account.id,
              domain,
              pid: meta.pid,
              files: problemConfig.testdata,
            }
          },
          { writable: false, ...(signal === undefined ? {} : { signal }) },
        )
      },
    }),
  )
}
