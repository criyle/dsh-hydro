import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createContest,
  createProblem,
  deleteContest,
  domainPath,
  editContestProblems,
  editProblem,
  getDomainConfig,
  getProblemConfig,
  getProblemMeta,
  openHydroSession,
  setDomainConfig,
  submitSolution,
  toHydroDate,
  uploadTestdataFile,
  uploadTestdataZip,
  urlEncodeForm,
  loginHydro,
} from '../../src/hydro/api.js'
import type { HydroSession } from '../../src/hydro/api.js'
import { pollJudge } from '../../src/hydro/judge.js'
import { openFakeSession, startFakeHydroHarness } from './harness.js'
import type { FakeHydroHarness } from './harness.js'

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

describe('hydro admin HTTP session', () => {
  it('logs in and authenticates admin requests with the sid cookie', async () => {
    expect(harness.hydro.state.loginCount).toBe(1)
    const config = await getDomainConfig(session, 'system')
    expect(config.current).toEqual({})
    expect(harness.hydro.state.requests).toContain('GET /domain/edit')
  })

  it('rejects a bad login with the Hydro error message', async () => {
    await expect(loginHydro(harness.context, session, 'admin', 'wrong-password')).rejects.toThrow(
      /Invalid password/,
    )
  })

  it('refuses admin requests without a session', async () => {
    const anonymous = await openHydroSession(harness.context, { port: 8888 })
    try {
      await expect(getDomainConfig(anonymous, 'system')).rejects.toThrow(/Login required/)
    } finally {
      await anonymous.close()
    }
  })

  it('creates and edits problems, mapping system-domain paths without a prefix', async () => {
    const created = await createProblem(session, {
      domain: 'system',
      title: 'A+B',
      content: '# A+B\n\n输入两个整数。',
      difficulty: 3,
      tags: ['math', 'intro'],
      hidden: true,
    })
    expect(created.pid).toBe('P1000')
    const problem = harness.hydro.state.problems.get(created.pid)
    expect(problem?.title).toBe('A+B')
    expect(problem?.hidden).toBe(true)
    expect(problem?.difficulty).toBe(3)
    expect(problem?.tags).toEqual(['math', 'intro'])
    expect(harness.hydro.state.requests).toContain('POST /problem/create')

    const edited = await editProblem(session, {
      domain: 'system',
      pid: created.pid,
      title: 'A+B (hard)',
      hidden: false,
    })
    expect(edited.pid).toBe(created.pid)
    expect(harness.hydro.state.problems.get(created.pid)?.title).toBe('A+B (hard)')
    expect(harness.hydro.state.problems.get(created.pid)?.hidden).toBe(false)
  })

  it('uses the /d/<domain> prefix for non-system domains', async () => {
    const created = await createProblem(session, { domain: 'class1', title: 'T', content: 'C' })
    expect(created.pid).toBe('P1000')
    expect(harness.hydro.state.problems.get(created.pid)?.domain).toBe('class1')
    expect(harness.hydro.state.requests.some((entry) => entry === 'POST /d/class1/problem/create')).toBe(true)
    expect(domainPath('system', '/problem/create')).toBe('/problem/create')
    expect(domainPath('class1', '/problem/create')).toBe('/d/class1/problem/create')
  })

  it('uploads testdata files byte-for-byte as multipart', async () => {
    await uploadTestdataFile(session, {
      domain: 'system',
      pid: 'P1000',
      name: '1.in',
      data: '1 2\n',
    })
    await uploadTestdataFile(session, {
      domain: 'system',
      pid: 'P1000',
      name: 'config.yaml',
      data: 'type: default\n',
    })
    const uploads = harness.hydro.state.uploads
    expect(uploads).toHaveLength(2)
    expect(uploads[0]?.name).toBe('1.in')
    expect(uploads[0]?.data.toString('utf8')).toBe('1 2\n')
    expect(uploads[0]?.type).toBe('testdata')
    expect(uploads[1]?.name).toBe('config.yaml')
  })

  it('preserves binary bytes when uploading a zip', async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x01, 0x02])
    await uploadTestdataZip(session, { domain: 'system', pid: 'P1000', name: 'data.zip', data: zip })
    expect(harness.hydro.state.uploads[0]?.data.equals(zip)).toBe(true)
    await expect(
      uploadTestdataZip(session, { domain: 'system', pid: 'P1000', name: 'data.tar', data: zip }),
    ).rejects.toThrow(/\.zip/)
  })

  it('submits a solution and polls the judge from Judging to AC', async () => {
    const submission = await submitSolution(session, {
      domain: 'system',
      pid: 'P1000',
      lang: 'cc',
      code: 'int main() {}',
    })
    expect(submission.rid).toBe('r1')
    const stored = harness.hydro.state.submissions.get(submission.rid)
    expect(stored?.lang).toBe('cc')
    expect(stored?.code).toBe('int main() {}')

    const result = await pollJudge(session, {
      domain: 'system',
      rid: submission.rid,
      intervalMs: 10,
      timeoutMs: 5_000,
    })
    expect(result.finished).toBe(true)
    expect(result.status).toBe(1)
    expect(result.statusText).toBe('AC')
    expect(result.score).toBe(100)
    expect(result.cases).toHaveLength(1)
    expect(result.cases[0]?.status).toBe(1)
    expect(stored?.polls).toBe(2)
  })

  it('reads problem config and metadata', async () => {
    const created = await createProblem(session, { domain: 'system', title: 'Info', content: '# Info' })
    await uploadTestdataFile(session, {
      domain: 'system',
      pid: created.pid,
      name: 'config.yaml',
      data: 'type: default\n',
      type: 'testdata',
    })
    const config = await getProblemConfig(session, { domain: 'system', pid: created.pid })
    expect(config.config).toBe('type: default\n')
    expect(config.testdata).toContain('config.yaml')
    const meta = await getProblemMeta(session, { domain: 'system', pid: created.pid })
    expect(meta.title).toBe('Info')
    expect(meta.pid).toBe(created.pid)
  })

  it('creates, edits and deletes contests with the update operation', async () => {
    const created = await createContest(session, {
      domain: 'system',
      title: 'Weekly',
      content: 'welcome',
      rule: 'acm',
      beginAtDate: '2026-03-01',
      beginAtTime: '19:00',
      durationHours: 2,
      pids: ['P1000', 1001],
      rated: true,
      autoHide: true,
      lockMinutes: 30,
    })
    expect(created.tid).toBe('c1')
    const contest = harness.hydro.state.contests.get(created.tid)
    expect(contest?.form.operation).toBe('update')
    expect(contest?.form.pids).toBe('P1000,1001')
    expect(contest?.form.duration).toBe('2')
    expect(contest?.form.rated).toBe('on')
    expect(contest?.form.lock).toBe('30')
    expect(contest?.form.beginAtTime).toBe('19:00')

    await editContestProblems(session, {
      domain: 'system',
      tid: created.tid,
      title: 'Weekly (updated)',
      content: 'new welcome',
      rule: 'oi',
      beginAtDate: '2026-03-01',
      beginAtTime: '20:00',
      durationHours: 3,
      pids: ['P1000'],
    })
    expect(harness.hydro.state.contests.get(created.tid)?.form.title).toBe('Weekly (updated)')
    expect(harness.hydro.state.contests.get(created.tid)?.form.rule).toBe('oi')

    await deleteContest(session, { domain: 'system', tid: created.tid })
    expect(harness.hydro.state.deletedContests).toEqual([created.tid])
  })

  it('gets and sets domain config, routing boolean keys through booleanKeys', async () => {
    const initial = await getDomainConfig(session, 'system')
    expect(initial.current).toEqual({})

    await setDomainConfig(session, 'system', { name: '示例域', share: true }, { bulletin: true })
    const saved = harness.hydro.state.domainConfig.system
    expect(saved?.name).toBe('示例域')
    expect(saved?.share).toBe('true')
    expect(saved?.bulletin).toBe('true')
  })

  it('encodes forms and converts dates in the requested timezone', () => {
    expect(urlEncodeForm({ a: '1', b: 2, c: true, d: undefined })).toBe('a=1&b=2&c=true')
    const instant = new Date('2026-01-01T00:30:00Z')
    expect(toHydroDate(instant, 'Asia/Shanghai')).toEqual({ date: '2026-01-01', time: '08:30' })
    expect(toHydroDate(instant, 'America/New_York')).toEqual({ date: '2025-12-31', time: '19:30' })
    expect(toHydroDate(new Date('2026-06-15T12:05:00Z'), 'UTC')).toEqual({ date: '2026-06-15', time: '12:05' })
    expect(() => toHydroDate(instant, 'Not/AZone')).toThrow(/无效的时区/)
  })
})
