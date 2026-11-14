/**
 * Audit log / oplog queries.
 *
 * Two different things are called "oplog" in a Hydro deployment:
 *
 * 1. Hydro's application audit log: the `<db>.oplog` collection written by
 *    `model/oplog.ts` (`type/time/operator/domainId/path/args/operateIp`).
 * 2. MongoDB's native `local.oplog.rs`, which only exists in a replica set —
 *    the default standalone install does not have it.
 *
 * `source: 'auto'` prefers (1) and falls back to (2); when neither is
 * available the result explains why and how to enable a replica set, without
 * changing anything.
 */
import { ObjectId, Timestamp, type Document } from 'mongodb'

import type {
  AccountContext,
  HydroProbe,
  OplogEntry,
  OplogQuerySpec,
  OplogResult,
} from '../ops/types.js'
import type { MongoState } from '../shared/types.js'
import { openMongoSession, readMongoOplogFacts, sanitizeDocument, type MongoSession } from './db.js'
import { probeHydro } from './detect.js'
import { bsonTimeToIso, redactSensitive } from './remote.js'

const MAX_OPLOG_LIMIT = 200
const DEFAULT_OPLOG_LIMIT = 50

const STANDALONE_NOTE =
  '当前 MongoDB 以单机（standalone）模式运行，没有 local.oplog.rs；' +
  '如需 MongoDB 原生 oplog，请将部署改为单节点副本集（mongod 加 --replSet 并执行 rs.initiate()），本插件不会自动修改。'

const MONGO_OPS = new Set(['insert', 'update', 'delete', 'replace', 'command', 'db', 'drop', 'rename'])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OPLOG_LIMIT
  return Math.max(1, Math.min(Math.floor(value), MAX_OPLOG_LIMIT))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function emptyMongoFacts(available = false): MongoState['oplog'] {
  return { available, sizeBytes: null, firstTs: null, lastTs: null, entries: null }
}

/**
 * Hydro's `<db>.oplog` collection query.
 *
 * Throws on driver errors; the caller decides whether to fall back.
 */
async function queryHydroOplog(
  session: MongoSession,
  spec: OplogQuerySpec,
  limit: number,
): Promise<OplogEntry[]> {
  const db = session.client.db(session.dbName)
  const filter: Document = {}
  if (spec.type !== undefined && spec.type !== '') filter.type = spec.type
  if (spec.operator !== undefined) filter.operator = spec.operator
  if (spec.contains !== undefined && spec.contains !== '') {
    const pattern = new RegExp(escapeRegExp(spec.contains), 'i')
    filter.$or = [{ type: pattern }, { path: pattern }]
  }
  if (spec.since !== undefined && spec.since.trim() !== '') {
    const since = spec.since.trim()
    const asObjectId = /^[0-9a-fA-F]{24}$/.test(since) ? new ObjectId(since) : null
    if (asObjectId !== null) {
      filter._id = { $gte: asObjectId }
    } else {
      const date = new Date(since)
      if (!Number.isNaN(date.getTime())) filter.time = { $gte: date }
    }
  }
  const documents = await db
    .collection('oplog')
    .find(filter, { sort: { _id: -1 }, limit: limit + 1 })
    .toArray()
  return documents.slice(0, limit).map((document) => {
    const record = document as Record<string, unknown>
    return {
      id: record._id === undefined ? '' : String(record._id),
      source: 'hydro' as const,
      type: typeof record.type === 'string' ? record.type : '',
      time: bsonTimeToIso(record.time) ?? '',
      operator: typeof record.operator === 'number' ? record.operator : null,
      domainId:
        record.domainId === undefined || record.domainId === null ? null : String(record.domainId),
      path: typeof record.path === 'string' ? record.path : null,
      args: sanitizeDocument(record.args ?? null),
      ip: typeof record.operateIp === 'string' ? record.operateIp : null,
    }
  })
}

/** `local.oplog.rs` query over the same tunnel. */
async function queryMongoOplog(
  session: MongoSession,
  spec: OplogQuerySpec,
  limit: number,
): Promise<OplogEntry[]> {
  const local = session.client.db('local')
  const filter: Document = {}
  if (spec.since !== undefined && spec.since.trim() !== '') {
    const date = new Date(spec.since.trim())
    if (!Number.isNaN(date.getTime())) {
      try {
        const seconds = Math.floor(date.getTime() / 1000)
        const timestamp =
          typeof Timestamp.fromNumber === 'function'
            ? Timestamp.fromNumber(seconds)
            : new Timestamp({ t: seconds, i: 0 })
        filter.ts = { $gte: timestamp }
      } catch {
        // An unbuildable Timestamp simply means "no server-side time filter".
      }
    }
  }
  if (spec.type !== undefined && MONGO_OPS.has(spec.type)) filter.op = spec.type
  const requiresClientFilter = spec.contains !== undefined && spec.contains !== ''
  const fetchLimit = requiresClientFilter ? MAX_OPLOG_LIMIT : limit
  const documents = await local
    .collection('oplog.rs')
    .find(filter, { sort: { $natural: -1 }, limit: fetchLimit + 1 })
    .toArray()
  const entries: OplogEntry[] = []
  for (const document of documents) {
    const record = document as Record<string, unknown>
    const op = typeof record.op === 'string' ? record.op : ''
    const ns = typeof record.ns === 'string' ? record.ns : null
    const args = sanitizeDocument(record.o ?? null)
    if (requiresClientFilter) {
      const haystack = `${op} ${ns ?? ''} ${JSON.stringify(args)}`.toLowerCase()
      if (!haystack.includes((spec.contains as string).toLowerCase())) continue
    }
    const ts = record.ts
    entries.push({
      id: ts === undefined || ts === null ? String(record._id ?? '') : String(ts),
      source: 'mongo',
      type: op === '' ? 'mongo' : `mongo.${op}`,
      time: bsonTimeToIso(ts) ?? '',
      operator: null,
      domainId: null,
      path: ns,
      args,
      ip: null,
    })
    if (entries.length >= limit) break
  }
  return entries
}

/**
 * Query Hydro's audit log or MongoDB's native oplog.
 *
 * Never throws for availability/permission problems: the result carries
 * `fallback` + a Chinese `note` explaining what happened.
 */
export async function queryOplog(
  context: AccountContext,
  spec: OplogQuerySpec,
  probe?: HydroProbe,
): Promise<OplogResult> {
  const limit = clampLimit(spec.limit)
  const requested = spec.source ?? 'auto'
  const requestedHydro = requested === 'hydro'
  let resolved = probe ?? null
  if (resolved === null) {
    try {
      resolved = await probeHydro(context)
    } catch {
      resolved = null
    }
  }

  const holder: { session: MongoSession | null } = { session: null }
  let openAttempted = false
  let openError: string | null = null
  const ensureSession = async (): Promise<MongoSession | null> => {
    if (holder.session !== null) return holder.session
    if (openAttempted) return null
    openAttempted = true
    try {
      holder.session = await openMongoSession(context, resolved ?? undefined)
      return holder.session
    } catch (error) {
      openError = errorMessage(error)
      return null
    }
  }

  try {
    /* 1. Hydro application oplog -------------------------------------- */
    if (requested !== 'mongo') {
      const hydroSession = await ensureSession()
      if (hydroSession !== null) {
        try {
          const entries = await queryHydroOplog(hydroSession, spec, limit)
          if (entries.length > 0 || requestedHydro) {
            return {
              source: 'hydro',
              entries,
              fallback: false,
              note: entries.length === 0 ? 'Hydro 审计日志中没有匹配记录' : null,
              mongo: null,
            }
          }
        } catch (error) {
          if (requestedHydro) {
            return {
              source: 'hydro',
              entries: [],
              fallback: false,
              note: `读取 Hydro 审计日志失败：${redactSensitive(errorMessage(error))}`,
              mongo: null,
            }
          }
        }
      } else if (requestedHydro) {
        return {
          source: 'hydro',
          entries: [],
          fallback: true,
          note: `无法连接 MongoDB（Hydro 审计日志所在数据库）：${openError ?? '未知错误'}`,
          mongo: null,
        }
      }
    }

    /* 2. MongoDB native oplog ----------------------------------------- */
    const mongoSession = await ensureSession()
    if (mongoSession === null) {
      return {
        source: requestedHydro ? 'hydro' : 'mongo',
        entries: [],
        fallback: true,
        note: `无法连接 MongoDB：${openError ?? '未找到 MongoDB 连接配置'}`,
        mongo: null,
      }
    }
    const facts = await readMongoOplogFacts(mongoSession.client)
    if (!facts.available) {
      return { source: 'mongo', entries: [], fallback: true, note: STANDALONE_NOTE, mongo: facts }
    }
    const entries = await queryMongoOplog(mongoSession, spec, limit)
    const fallback = requested === 'auto'
    return {
      source: 'mongo',
      entries,
      fallback,
      note: fallback ? 'Hydro 审计日志无匹配记录，已回退到 MongoDB 原生 oplog' : null,
      mongo: facts,
    }
  } catch (error) {
    return {
      source: requestedHydro ? 'hydro' : 'mongo',
      entries: [],
      fallback: true,
      note: `查询 oplog 失败：${redactSensitive(errorMessage(error))}`,
      mongo: emptyMongoFacts(),
    }
  } finally {
    const closing = holder.session
    if (closing !== null) await closing.close().catch(() => undefined)
  }
}
