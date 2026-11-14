import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { JUDGE_STATUS_TEXT, isJudgeFinished, judgeStatusText, parseRecordJson, pollJudge } from '../../src/hydro/judge.js'
import type { HydroSession } from '../../src/hydro/api.js'
import { openFakeSession, startFakeHydroHarness } from '../hydro-api/harness.js'
import type { FakeHydroHarness } from '../hydro-api/harness.js'

describe('judge status mapping', () => {
  it('covers every Hydro status code the plugin reports', () => {
    expect(JUDGE_STATUS_TEXT[0]).toBe('Waiting')
    expect(JUDGE_STATUS_TEXT[1]).toBe('AC')
    expect(JUDGE_STATUS_TEXT[2]).toBe('WA')
    expect(JUDGE_STATUS_TEXT[7]).toBe('CE')
    expect(JUDGE_STATUS_TEXT[11]).toBe('Hacked')
    expect(JUDGE_STATUS_TEXT[20]).toBe('Judging')
    expect(JUDGE_STATUS_TEXT[21]).toBe('Compiling')
    expect(JUDGE_STATUS_TEXT[22]).toBe('Fetched')
    expect(judgeStatusText(1)).toBe('AC')
    expect(judgeStatusText(999)).toBe('Unknown(999)')
  })

  it('classifies in-progress statuses', () => {
    for (const status of [0, 20, 21, 22]) expect(isJudgeFinished(status)).toBe(false)
    for (const status of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) expect(isJudgeFinished(status)).toBe(true)
  })
})

describe('parseRecordJson', () => {
  it('normalizes a record-detail envelope', () => {
    const result = parseRecordJson({
      rdoc: {
        _id: '64f000000000000000000001',
        status: 2,
        score: 50,
        time: 123,
        memory: 4096,
        compilerTexts: ['main.cpp:1: warning'],
        testCases: [
          { id: 1, status: 1, score: 50, time: 10, memory: 2048, message: 'Correct' },
          { id: 2, status: 2, score: 0, time: 9, memory: 2048, message: 'Wrong Answer' },
        ],
        subtasks: { '1': { score: 30, status: 2 }, '2': { score: 20, status: 1 } },
      },
    })
    expect(result.rid).toBe('64f000000000000000000001')
    expect(result.status).toBe(2)
    expect(result.statusText).toBe('WA')
    expect(result.score).toBe(50)
    expect(result.timeMs).toBe(123)
    expect(result.memoryKb).toBe(4096)
    expect(result.compilerText).toBe('main.cpp:1: warning')
    expect(result.cases).toHaveLength(2)
    expect(result.cases[1]).toMatchObject({
      id: '2',
      status: 2,
      score: 0,
      message: 'Wrong Answer',
      timeMs: 9,
      memoryKb: 2048,
    })
    expect(result.subtasks['1']).toEqual({ score: 30, status: 2 })
    expect(result.finished).toBe(true)
  })

  it('accepts a bare record document and defaults case ids', () => {
    const result = parseRecordJson({
      _id: 'rid-1',
      status: 20,
      score: 0,
      testCases: [{ status: 1, score: 100 }],
    })
    expect(result.statusText).toBe('Judging')
    expect(result.finished).toBe(false)
    expect(result.cases[0]?.id).toBe('1')
    expect(result.timeMs).toBeNull()
  })

  it('treats a testCases object as an id map', () => {
    const result = parseRecordJson({ rdoc: { status: 1, testCases: { '1.in': { status: 1, score: 100 } } } })
    expect(result.cases[0]?.id).toBe('1.in')
  })

  it('rejects malformed bodies', () => {
    expect(() => parseRecordJson(null)).toThrow(/不是 JSON 对象/)
    expect(() => parseRecordJson({ udoc: {} })).toThrow(/缺少 rdoc/)
  })
})

describe('pollJudge', () => {
  let harness: FakeHydroHarness
  let session: HydroSession

  beforeEach(async () => {
    harness = await startFakeHydroHarness()
    session = await openFakeSession(harness)
  })

  afterEach(async () => {
    await session.close()
    await harness.close()
  })

  it('returns the last unfinished result on timeout', async () => {
    harness.hydro.state.recordPlan = () => [{ status: 20, score: 0 }]
    const submission = await session.postForm<{ rid: string }>('/p/P1000/submit', {
      lang: 'cc',
      code: 'int main() {}',
    })
    const result = await pollJudge(session, {
      domain: 'system',
      rid: submission.rid,
      timeoutMs: 120,
      intervalMs: 20,
    })
    expect(result.finished).toBe(false)
    expect(result.status).toBe(20)
    expect(result.statusText).toBe('Judging')
  })

  it('stops polling when aborted', async () => {
    harness.hydro.state.recordPlan = () => [{ status: 20, score: 0 }]
    const submission = await session.postForm<{ rid: string }>('/p/P1000/submit', {
      lang: 'cc',
      code: 'int main() {}',
    })
    const controller = new AbortController()
    const pending = pollJudge(session, {
      domain: 'system',
      rid: submission.rid,
      timeoutMs: 5_000,
      intervalMs: 500,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toThrow()
  })

  it('returns WA records from the fake judge', async () => {
    const submission = await session.postForm<{ rid: string }>('/p/P1000/submit', {
      lang: 'cc',
      code: 'int main() { /* // WA */ }',
    })
    const result = await pollJudge(session, {
      domain: 'system',
      rid: submission.rid,
      timeoutMs: 5_000,
      intervalMs: 10,
    })
    expect(result.status).toBe(2)
    expect(result.score).toBe(50)
    expect(result.cases.map((item) => item.status)).toEqual([1, 2])
  })
})
