/**
 * Judge-record parsing and polling.
 *
 * Hydro exposes one record as JSON at `GET /record/<rid>` (domain-prefixed for
 * non-system domains). While judging, `rdoc.status` is one of 0/20/21/22; the
 * first other status is final. The functions here are transport-thin so both
 * the tools and the verifier can share the exact same normalization.
 *
 * Status table: `packages/common/status.ts` (see
 * `docs/research/hydro-internals.md` §6.7).
 */
import { ObjectId } from 'mongodb'

import type { HydroOpsApi } from '../ops/hydro-ops.js'
import type { AccountContext } from '../ops/types.js'
import type { OperationResult } from '../shared/types.js'
import { domainPath, openHydroSession } from './api.js'
import type { HydroSession } from './api.js'
import { queryDatabase } from './db.js'

/** One judge test-case detail. */
export interface JudgeCase {
  id: string
  status: number
  score: number
  message: string | null
  timeMs: number | null
  memoryKb: number | null
}

/** Normalized judge result used by tools and the verification loop. */
export interface JudgeResult {
  rid: string
  status: number
  statusText: string
  score: number
  timeMs: number | null
  memoryKb: number | null
  compilerText: string | null
  cases: Array<{
    id: string
    status: number
    score: number
    message: string | null
    timeMs: number | null
    memoryKb: number | null
  }>
  subtasks: Record<string, { score: number; status: number }>
  finished: boolean
}

/** Human-readable status names (Hydro status codes). */
export const JUDGE_STATUS_TEXT: Record<number, string> = {
  0: 'Waiting',
  1: 'AC',
  2: 'WA',
  3: 'TLE',
  4: 'MLE',
  5: 'OLE',
  6: 'RE',
  7: 'CE',
  8: 'SE',
  9: 'Canceled',
  11: 'Hacked',
  20: 'Judging',
  21: 'Compiling',
  22: 'Fetched',
}

/** Statuses that mean "the judge is still working". */
const IN_PROGRESS_STATUS = new Set([0, 20, 21, 22])

/** True once the record reached a terminal status. */
export function isJudgeFinished(status: number): boolean {
  return !IN_PROGRESS_STATUS.has(status)
}

/** Human-readable status name; unknown codes keep their number for debugging. */
export function judgeStatusText(status: number): string {
  return JUDGE_STATUS_TEXT[status] ?? `Unknown(${String(status)})`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : value
  }
  if (Array.isArray(value)) {
    const parts = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return parts.length === 0 ? null : parts.join('\n')
  }
  return null
}

function caseIdOf(entry: Record<string, unknown>, fallback: number): string {
  const raw = entry.id ?? entry.case ?? entry.caseId
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw !== '') return raw
  const subtask = toNumber(entry.subtaskId)
  return subtask === null ? String(fallback) : `${String(subtask)}-${String(fallback)}`
}

function parseCases(raw: unknown): JudgeResult['cases'] {
  const cases: JudgeResult['cases'] = []
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      const entry = asRecord(item)
      if (entry === null) return
      cases.push(normalizeCase(entry, index + 1))
    })
    return cases
  }
  const record = asRecord(raw)
  if (record !== null) {
    let index = 0
    for (const [key, item] of Object.entries(record)) {
      index += 1
      const entry = asRecord(item)
      if (entry === null) continue
      cases.push(normalizeCase({ id: key, ...entry }, index))
    }
  }
  return cases
}

function normalizeCase(entry: Record<string, unknown>, fallbackId: number): JudgeCase {
  return {
    id: caseIdOf(entry, fallbackId),
    status: toNumber(entry.status) ?? 0,
    score: toNumber(entry.score) ?? 0,
    message: toText(entry.message ?? entry.judgeText ?? entry.text),
    timeMs: toNumber(entry.time ?? entry.timeMs),
    memoryKb: toNumber(entry.memory ?? entry.memoryKb),
  }
}

function parseSubtasks(raw: unknown): JudgeResult['subtasks'] {
  const subtasks: JudgeResult['subtasks'] = {}
  const record = asRecord(raw)
  if (record === null) return subtasks
  for (const [key, item] of Object.entries(record)) {
    const entry = asRecord(item)
    if (entry === null) {
      const score = toNumber(item)
      if (score !== null) subtasks[key] = { score, status: 0 }
      continue
    }
    subtasks[key] = {
      score: toNumber(entry.score) ?? 0,
      status: toNumber(entry.status) ?? 0,
    }
  }
  return subtasks
}

/**
 * Normalize one `GET /record/<rid>` JSON body.
 *
 * Accepts the record-detail envelope (`{rdoc: {...}}`) and a bare record doc, so
 * the same parser works for the JSON API and for a Mongo-shaped record.
 */
export function parseRecordJson(body: unknown): JudgeResult {
  const root = asRecord(body)
  if (root === null) {
    throw new Error('判题结果格式不正确：响应不是 JSON 对象')
  }
  const nested = asRecord(root.rdoc)
  const rdoc = nested ?? root
  if (nested === null && rdoc.status === undefined && rdoc.testCases === undefined && rdoc.compilerTexts === undefined) {
    throw new Error('判题结果格式不正确：缺少 rdoc 字段')
  }
  const status = toNumber(rdoc.status) ?? 0
  const subtasks = parseSubtasks(rdoc.subtasks)
  return {
    rid: String(rdoc._id ?? root.rid ?? rdoc.rid ?? ''),
    status,
    statusText: judgeStatusText(status),
    score: toNumber(rdoc.score) ?? 0,
    timeMs: toNumber(rdoc.time ?? rdoc.timeMs),
    memoryKb: toNumber(rdoc.memory ?? rdoc.memoryKb),
    compilerText: toText(rdoc.compilerTexts) ?? toText(rdoc.compilerText),
    cases: parseCases(rdoc.testCases),
    subtasks,
    finished: isJudgeFinished(status),
  }
}

/** Abort-aware delay used between polls. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(1, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal === undefined ? new Error('已取消') : abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

/**
 * Poll one judge record until it reaches a terminal status or the timeout hits.
 *
 * On timeout the last (unfinished) result is returned with `finished: false`;
 * the caller decides whether that is a failure. Default timeout is 30s — the
 * tools pass `config.problem.judgeTimeoutMs` for longer-running judges.
 */
export async function pollJudge(
  session: HydroSession,
  input: {
    domain: string
    rid: string
    timeoutMs?: number
    intervalMs?: number
    signal?: AbortSignal
  },
): Promise<JudgeResult> {
  const timeoutMs = input.timeoutMs ?? 30_000
  const intervalMs = Math.max(10, input.intervalMs ?? 500)
  const path = domainPath(input.domain, `/record/${encodeURIComponent(input.rid)}`)
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let last: JudgeResult | null = null
  for (;;) {
    input.signal?.throwIfAborted()
    const body = await session.getJson<unknown>(path, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    last = parseRecordJson(body)
    if (last.finished) return last
    const remaining = deadline - Date.now()
    if (remaining <= 0) return last
    await sleep(Math.min(intervalMs, remaining), input.signal)
  }
}


const REJUDGE_STALE_STATUSES = [0, 20, 21, 22] as const
const REJUDGE_STALE_AFTER_MS = 10 * 60_000
const REJUDGE_MAX = 50

/** Rejudge up to 50 records stuck in an in-flight status for over 10 minutes. */
export async function rejudgeStaleRecords(ops: HydroOpsApi, context: AccountContext): Promise<OperationResult> {
  if (context.readonly) return { ok: false, message: '全局只读已开启，拒绝 rejudge。' }
  const staleSince = new ObjectId(Math.floor((Date.now() - REJUDGE_STALE_AFTER_MS) / 1000).toString(16).padStart(8, '0') + '0000000000000000')
  let records: Array<Record<string, unknown>>
  try {
    const result = await queryDatabase(context, {
      collection: 'record',
      filter: { status: { $in: [...REJUDGE_STALE_STATUSES] }, _id: { $lt: staleSince } },
      projection: { _id: 1, domainId: 1 },
      limit: REJUDGE_MAX,
      sort: { _id: 1 },
    })
    records = result.documents.map((doc) => doc as Record<string, unknown>)
  } catch (error) {
    return { ok: false, message: `读取滞留记录失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (records.length === 0) return { ok: true, message: '没有需要 rejudge 的滞留记录。' }
  const credentials = await ops.getSiteSession(context.account.id)
  if (credentials.sid === null) {
    return { ok: false, message: '需要先在内嵌浏览器登录 站点账号，才能 rejudge。' }
  }
  const port = await ops.hydroPort(context)
  const session = await openHydroSession(context, {
    port,
    sid: credentials.sid,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  })
  const fallbackDomain = credentials.domain ?? 'system'
  let ok = 0
  try {
    for (const record of records) {
      const rid = String(record._id ?? '')
      const domain = typeof record.domainId === 'string' ? record.domainId : fallbackDomain
      if (rid === '') continue
      try {
        await session.postForm(`/d/${encodeURIComponent(domain)}/record/${encodeURIComponent(rid)}`, { operation: 'rejudge' })
        ok += 1
      } catch {
        // Continue; the summary reports the successful count.
      }
    }
  } finally {
    await session.close().catch(() => undefined)
  }
  return {
    ok: ok > 0,
    message: ok === records.length
      ? `已 rejudge ${String(ok)} 条滞留记录。`
      : `已提交 ${String(ok)}/${String(records.length)} 条滞留记录；其余可能无权限或记录已变化。`,
    log: `records=${String(records.length)} ok=${String(ok)}`,
  }
}
