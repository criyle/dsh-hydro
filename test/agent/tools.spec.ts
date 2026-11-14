import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { fakeConfig } from '../helpers/fake-ssh.js'
import { startFakeHydroHarness } from '../hydro-api/harness.js'
import type { FakeHydroHarness } from '../hydro-api/harness.js'
import { registerContestTools } from '../../src/tools/contest.js'
import { registerProblemTools } from '../../src/tools/problem.js'
import type { ToolDeps } from '../../src/tools/types.js'
import type { HydroOpsApi } from '../../src/ops/hydro-ops.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { hydroOpsSkill, problemAuthoringSkill } from '../../src/skills/index.js'
import { OPS_GUIDE, PROBLEM_AUTHORING_GUIDE } from '../../src/agent/prompts.js'

let harness: FakeHydroHarness
let definitions: ToolDefinition[]
let deps: ToolDeps

function fakeExec(): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'hydro_problem',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('token'),
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
}

function makeDeps(harnessValue: FakeHydroHarness, store: ToolDefinition[]): ToolDeps {
  const ctx = {
    tools: {
      register(definition: ToolDefinition): () => void {
        store.push(definition)
        return () => undefined
      },
    },
  } as unknown as Context
  const ops = {
    resolveAccountId: (accountId?: string) => accountId ?? harnessValue.context.account.id,
    withContext: async (_accountId: string | undefined, fn: (context: never) => Promise<unknown>) =>
      fn(harnessValue.context as never),
    withWritableContext: async (
      _accountId: string | undefined,
      action: string,
      fn: (context: never) => Promise<unknown>,
    ) => {
      if (harnessValue.context.readonly) throw new Error(`只读模式：拒绝执行 ${action}`)
      return fn(harnessValue.context as never)
    },
    hydroPort: async () => 8888,
    getSiteSession: async () => ({
      uname: 'admin', sid: harnessValue.hydro.state.sid, domain: 'system', siteAccountId: 'site-1',
    }),
    assertWritable: (context: { readonly: boolean }, action: string) => {
      if (context.readonly) throw new Error(`只读模式：拒绝执行 ${action}`)
    },
  } as unknown as HydroOpsApi
  return { ctx, config: fakeConfig(), ops }
}

function definition(name: string): ToolDefinition {
  const found = definitions.find((item) => item.name === name)
  if (found === undefined) throw new Error(`tool ${name} not registered`)
  return found
}

async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = definition(name)
  // The real registry validates arguments before execute and the canonical
  // value against output.schema after; mirror both here so tests catch drift.
  expect(validateJsonSchemaValue(def.parameters, args)).toEqual([])
  const result = await def.execute(args, fakeExec())
  expect(validateJsonSchemaValue(def.output.schema, result)).toEqual([])
  return result as Record<string, unknown>
}

beforeEach(async () => {
  harness = await startFakeHydroHarness()
  definitions = []
  deps = makeDeps(harness, definitions)
  registerProblemTools(deps)
  registerContestTools(deps)
})

afterEach(async () => {
  await harness.close()
})

describe('tool registration', () => {
  it('registers both grouped tools once', () => {
    expect(definitions.map((item) => item.name).sort()).toEqual([
      'hydro_contest',
      'hydro_problem',
    ])
    for (const item of definitions) {
      expect(item.description.length).toBeGreaterThan(20)
      expect(item.output.schema).toBeDefined()
      expect(typeof item.execute).toBe('function')
    }
  })

  it('exposes the shared skills and guidance', () => {
    expect(problemAuthoringSkill.name).toBe('hydro-problem-authoring')
    expect(hydroOpsSkill.name).toBe('hydro-ops')
    expect(problemAuthoringSkill.modelInvocable).toBe(true)
    expect(hydroOpsSkill.userInvocable).toBe(true)
    expect(PROBLEM_AUTHORING_GUIDE).toContain('hydro_problem')
    expect(PROBLEM_AUTHORING_GUIDE).toContain('验证')
    expect(OPS_GUIDE).toContain('只读')
    expect(OPS_GUIDE).toContain('备份')
  })
})

describe('hydro_problem tool', () => {
  it('scaffolds a local problem package without touching the remote', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-hydro-scaffold-'))
    try {
      const result = await runTool('hydro_problem', { action: 'scaffold', dir, title: 'A+B' })
      expect(result.ok).toBe(true)
      expect(result.dir).toBe(dir)
      expect(result.files).toContain('statement.md')
      const statement = await readFile(join(dir, 'statement.md'), 'utf8')
      expect(statement).toContain('# A+B')
      expect(await readFile(join(dir, 'testdata', 'config.yaml'), 'utf8')).toContain('type: default')
      expect(await readFile(join(dir, 'testdata', 'README.md'), 'utf8')).toContain('testdata')
      expect(harness.hydro.state.requests).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates a problem through the admin session', async () => {
    const result = await runTool('hydro_problem', {
      action: 'create',
      domain: 'system',
      title: 'A+B',
      statement: '# A+B\n\n输入两个整数，输出它们的和。\n',
    })
    expect(result.ok).toBe(true)
    expect(result.pid).toBe('P1000')
    const problem = harness.hydro.state.problems.get('P1000')
    expect(problem?.title).toBe('A+B')
    expect(problem?.content).toContain('输入两个整数')
  })

  it('submits code and reports the judge status', async () => {
    await runTool('hydro_problem', {
      action: 'create',
      domain: 'system',
      title: 'A+B',
      statement: '# A+B',
    })
    const result = await runTool('hydro_problem', {
      action: 'submit',
      domain: 'system',
      pid: 'P1000',
      lang: 'cc',
      code: 'int main() { /* // WA */ }',
      timeoutMs: 5_000,
    })
    expect(result.rid).toBe('r1')
    expect(result.judgeStatus).toBe('WA')
    expect(result.score).toBe(50)
    expect(Array.isArray(result.cases)).toBe(true)
  })

  it('refuses remote mutations in read-only mode', async () => {
    const readonlyHarness = await startFakeHydroHarness({ context: { readonly: true } })
    try {
      const captured: ToolDefinition[] = []
      const ctx = {
        tools: {
          register(definition: ToolDefinition) {
            captured.push(definition)
            return () => undefined
          },
        },
      } as unknown as Context
      const readonlyDeps = makeDeps(readonlyHarness, captured)
      readonlyDeps.ctx = ctx
      registerProblemTools(readonlyDeps)
      const problemTool = captured.find((item) => item.name === 'hydro_problem')
      await expect(
        problemTool?.execute({ action: 'create', domain: 'system', title: 'T', statement: '# T' }, fakeExec()),
      ).rejects.toThrow(/只读/)
    } finally {
      await readonlyHarness.close()
    }
  })
})

describe('hydro_contest tool', () => {
  it('creates a contest and reports the tid', async () => {
    const result = await runTool('hydro_contest', {
      action: 'create',
      domain: 'system',
      title: 'Weekly',
      statement: 'welcome',
      rule: 'acm',
      beginAtDate: '2026-03-01',
      beginAtTime: '19:00',
      durationHours: 2,
      pids: ['P1000', 1001],
      rated: true,
    })
    expect(result.ok).toBe(true)
    expect(result.tid).toBe('c1')
    const contest = harness.hydro.state.contests.get('c1')
    expect(contest?.form.pids).toBe('P1000,1001')
    expect(contest?.form.rule).toBe('acm')
  })

  it('deletes a contest', async () => {
    await runTool('hydro_contest', {
      action: 'create',
      domain: 'system',
      title: 'Weekly',
      statement: 'welcome',
      rule: 'acm',
      beginAtDate: '2026-03-01',
      beginAtTime: '19:00',
      durationHours: 2,
      pids: ['P1000'],
    })
    const result = await runTool('hydro_contest', { action: 'delete', domain: 'system', tid: 'c1', confirm: true })
    expect(result.ok).toBe(true)
    expect(harness.hydro.state.deletedContests).toEqual(['c1'])
  })
})
