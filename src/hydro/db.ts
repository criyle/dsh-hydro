/**
 * Read-only MongoDB access through an SSH tunnel.
 *
 * The default Hydro install keeps mongod on `127.0.0.1:27017` with auth and
 * only stores the (credential-bearing) URI in `~/.hydro/config.json`. dsh-hydro
 * opens a local forward, rewrites the URI to the tunnel endpoint, and uses the
 * official driver read-only. The URI/password is never logged.
 */
import { MongoClient, type Db, type Document } from 'mongodb'

import { openTunnel, type Tunnel } from '../ops/tunnel.js'
import type { AccountContext, HydroProbe, MongoQuerySpec } from '../ops/types.js'
import type { MongoState } from '../shared/types.js'
import {
  buildTunnelUri,
  parseMongoUri,
  redactSensitive,
  bsonTimeToIso,
  type ParsedMongoUri,
} from './remote.js'
import { probeHydro } from './detect.js'

/** Hard cap for `find` in the read-only DB tool. */
export const MAX_FIND_LIMIT = 50

/** Hard cap for the number of collections described by `listCollections`. */
const MAX_COLLECTIONS = 100

const DEFAULT_MONGO_PORT = 27017
const DEFAULT_DB_NAME = 'hydro'

/** A live Mongo client bound to one SSH tunnel. */
export interface MongoSession {
  client: MongoClient
  dbName: string
  parsed: ParsedMongoUri
  tunnel: Tunnel
  close(): Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mongoTimeoutMs(context: AccountContext): number {
  const configured = context.config.status.timeoutMs
  if (!Number.isFinite(configured) || configured <= 0) return 8000
  return Math.max(2000, Math.min(configured, 10_000))
}

/**
 * Resolve `~/.hydro/config.json` into a tunnel + connected client.
 *
 * Throws a Chinese, credential-free error when the URI is missing,
 * `mongodb+srv://` (not tunnel-friendly), or the connection fails. Callers in
 * read-only paths catch and degrade; tools surface the error to the model.
 */
export async function openMongoSession(
  context: AccountContext,
  probe?: HydroProbe,
): Promise<MongoSession> {
  const resolved = probe ?? (await probeHydro(context))
  const uri = resolved.config?.uri ?? null
  if (uri === null || uri.trim() === '') {
    throw new Error('未找到 MongoDB 连接配置（~/.hydro/config.json 缺失或没有 uri）')
  }
  if (/^mongodb\+srv:/i.test(uri.trim())) {
    throw new Error('不支持 mongodb+srv:// 连接串（SSH 隧道无法解析 SRV），请改用 mongodb:// 直连地址')
  }
  let parsed: ParsedMongoUri
  try {
    parsed = parseMongoUri(uri)
  } catch (error) {
    throw new Error(`无法解析 MongoDB 连接串：${errorMessage(error)}`)
  }
  if (parsed.database === null && context.config.mongo.db !== '') {
    parsed = { ...parsed, database: context.config.mongo.db }
  }
  const remoteHost = parsed.host === 'localhost' ? '127.0.0.1' : parsed.host
  const remotePort = parsed.port > 0 ? parsed.port : DEFAULT_MONGO_PORT
  const tunnel = await openTunnel(context, { remoteHost, remotePort })
  const timeoutMs = mongoTimeoutMs(context)
  const client = new MongoClient(buildTunnelUri(uri, tunnel.localHost, tunnel.localPort), {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    appName: 'dsh-hydro',
  })
  try {
    await client.connect()
  } catch (error) {
    await client.close().catch(() => undefined)
    await tunnel.release().catch(() => undefined)
    throw new Error(`无法通过 SSH 隧道连接 MongoDB：${redactSensitive(errorMessage(error))}`)
  }
  const dbName = parsed.database ?? (context.config.mongo.db !== '' ? context.config.mongo.db : DEFAULT_DB_NAME)
  return {
    client,
    dbName,
    parsed,
    tunnel,
    async close() {
      await client.close().catch(() => undefined)
      await tunnel.release().catch(() => undefined)
    },
  }
}

function addressOf(probe: HydroProbe | undefined, context: AccountContext): string | null {
  if (probe?.config !== null && probe?.config !== undefined) {
    return `${probe.config.host}:${String(probe.config.port)}`
  }
  if (context.config.mongo.host !== '') {
    return `${context.config.mongo.host}:${String(context.config.mongo.port || DEFAULT_MONGO_PORT)}`
  }
  return null
}

function emptyOplog(): MongoState['oplog'] {
  return { available: false, sizeBytes: null, firstTs: null, lastTs: null, entries: null }
}

/**
 * Read MongoDB oplog facts (`local.oplog.rs`).
 *
 * Standalone mongod — the default Hydro install — has no `local.oplog.rs`, so
 * this normally reports `available: false`. No writes/commands are attempted.
 */
export async function readMongoOplogFacts(client: MongoClient): Promise<MongoState['oplog']> {
  const empty = emptyOplog()
  try {
    const local = client.db('local')
    const stats = (await local
      .command({ collStats: 'oplog.rs', scale: 1 })
      .catch(() => null)) as Record<string, unknown> | null
    if (stats === null) return empty
    const collection = local.collection('oplog.rs')
    const first = await collection
      .find({}, { sort: { $natural: 1 }, limit: 1 })
      .next()
      .catch(() => null)
    const last = await collection
      .find({}, { sort: { $natural: -1 }, limit: 1 })
      .next()
      .catch(() => null)
    const sizeBytes = typeof stats.size === 'number' ? stats.size : null
    const entries = typeof stats.count === 'number' ? stats.count : null
    return {
      available: true,
      sizeBytes,
      firstTs: first === null ? null : bsonTimeToIso((first as Record<string, unknown>).ts),
      lastTs: last === null ? null : bsonTimeToIso((last as Record<string, unknown>).ts),
      entries,
    }
  } catch {
    return empty
  }
}

/**
 * Inspect MongoDB reachability/version/collection count/oplog facts.
 *
 * Degrades to `reachable: false` instead of throwing, so status aggregation can
 * continue.
 */
export async function inspectMongo(
  context: AccountContext,
  probe?: HydroProbe,
): Promise<MongoState> {
  const base: MongoState = {
    reachable: false,
    address: addressOf(probe, context),
    db: probe?.config?.database ?? (context.config.mongo.db !== '' ? context.config.mongo.db : null),
    version: null,
    collections: null,
    oplog: emptyOplog(),
  }
  let session: MongoSession
  try {
    session = await openMongoSession(context, probe)
  } catch (error) {
    context.log(`MongoDB 不可达：${errorMessage(error)}`)
    return base
  }
  try {
    const db: Db = session.client.db(session.dbName)
    const buildInfo = (await db.command({ buildInfo: 1 })) as Record<string, unknown>
    const collections = await db.listCollections().toArray()
    const oplog = await readMongoOplogFacts(session.client)
    return {
      reachable: true,
      address: `${session.parsed.host}:${String(session.parsed.port)}`,
      db: session.dbName,
      version: typeof buildInfo.version === 'string' ? buildInfo.version : null,
      collections: collections.length,
      oplog,
    }
  } catch (error) {
    context.log(`MongoDB 检查失败：${errorMessage(error)}`)
    return { ...base, db: session.dbName }
  } finally {
    await session.close()
  }
}

function validateCollectionName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('集合名不能为空')
  if (trimmed.length > 120) throw new Error('集合名过长（最多 120 字符）')
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(trimmed)) {
    throw new Error(`集合名非法：${JSON.stringify(trimmed)}（只允许字母、数字、下划线、点、连字符）`)
  }
  return trimmed
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.floor(value), max))
}

/** Convert BSON values into JSON-safe ones for model/tool output. */
export function sanitizeDocument(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) {
    if (depth > 8) return '[depth limit]'
    return value.slice(0, 200).map((entry) => sanitizeDocument(entry, depth + 1))
  }
  const record = value as Record<string, unknown> & {
    _bsontype?: string
    toHexString?: () => string
    toString?: () => string
  }
  if (typeof record._bsontype === 'string') {
    if (typeof record.toHexString === 'function') return record.toHexString()
    if (typeof record.toString === 'function') return record.toString()
    return `[${record._bsontype}]`
  }
  if (depth > 8) return '[depth limit]'
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(record).slice(0, 200)) {
    result[key] = sanitizeDocument(entry, depth + 1)
  }
  return result
}

/**
 * List collections with a document count and on-disk size.
 *
 * Read-only (`listCollections` + `estimatedDocumentCount` + `collStats`).
 */
export async function listCollections(
  context: AccountContext,
  probe?: HydroProbe,
): Promise<Array<{ name: string; count: number | null; sizeBytes: number | null }>> {
  const session = await openMongoSession(context, probe)
  try {
    const db = session.client.db(session.dbName)
    const infos = await db.listCollections({}, { nameOnly: true }).toArray()
    const result: Array<{ name: string; count: number | null; sizeBytes: number | null }> = []
    for (const info of infos.slice(0, MAX_COLLECTIONS)) {
      const name = info.name
      if (name.startsWith('system.')) continue
      let count: number | null = null
      let sizeBytes: number | null = null
      try {
        count = await db.collection(name).countDocuments({}, { maxTimeMS: 2000 })
      } catch {
        try {
          count = await db.collection(name).estimatedDocumentCount({ maxTimeMS: 2000 })
        } catch {
          count = null
        }
      }
      try {
        const stats = (await db.command({ collStats: name, scale: 1 })) as Record<string, unknown>
        sizeBytes = typeof stats.size === 'number' ? stats.size : null
      } catch {
        sizeBytes = null
      }
      result.push({ name, count, sizeBytes })
    }
    return result.sort((left, right) => left.name.localeCompare(right.name))
  } finally {
    await session.close()
  }
}

/**
 * Run a bounded read-only `find`.
 *
 * `limit` is clamped to {@link MAX_FIND_LIMIT}; one extra document is fetched to
 * report truncation without a second round-trip.
 */
export async function queryDatabase(
  context: AccountContext,
  spec: MongoQuerySpec,
  probe?: HydroProbe,
): Promise<{ documents: unknown[]; truncated: boolean; collection: string }> {
  const collectionName = validateCollectionName(spec.collection)
  const limit = clampLimit(spec.limit, 20, MAX_FIND_LIMIT)
  const session = await openMongoSession(context, probe)
  try {
    const db = session.client.db(session.dbName)
    const documents = await db
      .collection(collectionName)
      .find((spec.filter ?? {}) as Document, {
        projection: (spec.projection ?? {}) as Document,
        sort: (spec.sort ?? { _id: -1 }) as Document,
        skip: Math.max(0, Math.floor(spec.skip ?? 0)),
        limit: limit + 1,
        maxTimeMS: 5000,
      })
      .toArray()
    const truncated = documents.length > limit
    return {
      documents: documents.slice(0, limit).map((document) => sanitizeDocument(document)),
      truncated,
      collection: collectionName,
    }
  } catch (error) {
    throw new Error(`查询集合 ${collectionName} 失败：${redactSensitive(errorMessage(error))}`)
  } finally {
    await session.close()
  }
}

/** Count documents in one collection with an optional filter (read-only). */
export async function countDatabase(
  context: AccountContext,
  spec: { collection: string; filter?: Record<string, unknown> },
  probe?: HydroProbe,
): Promise<number> {
  const collectionName = validateCollectionName(spec.collection)
  const session = await openMongoSession(context, probe)
  try {
    const db = session.client.db(session.dbName)
    return await db.collection(collectionName).countDocuments((spec.filter ?? {}) as Document, { maxTimeMS: 3000 })
  } catch (error) {
    throw new Error(`统计集合 ${collectionName} 失败：${redactSensitive(errorMessage(error))}`)
  } finally {
    await session.close()
  }
}

/** Read one `system` setting value (e.g. `server.url`, `hydrooj.langs`). */
export async function getSystemSetting(
  context: AccountContext,
  key: string,
  probe?: HydroProbe,
): Promise<unknown> {
  const session = await openMongoSession(context, probe)
  try {
    const db = session.client.db(session.dbName)
    const document = await db.collection('system').findOne({ _id: key } as Document, { maxTimeMS: 3000 })
    return document === null ? undefined : (sanitizeDocument(document) as { value?: unknown }).value
  } finally {
    await session.close()
  }
}
