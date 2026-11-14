/**
 * Hydro community interaction (discussions) helper.
 *
 * Scheduled polling only READS new threads/replies and records unread activity;
 * posting a reply is always an explicit, confirmed action (from the panel or the
 * agent after user approval). No automatic replies are ever sent.
 */
import { join, resolve } from 'node:path'

import type { HydroOpsApi } from '../ops/hydro-ops.js'
import type { AccountContext } from '../ops/types.js'
import { domainPath, openHydroSession, type HydroSession } from '../hydro/api.js'
import {
  ensurePrivateDir,
  readJsonIfExists,
  serializeJson,
  writeFileAtomic,
} from '../util/atomic-file.js'

export interface CommunityDiscussion {
  did: string
  title: string
  content: string
  domain: string
  node: string | null
  owner: number | null
  ownerName: string | null
  url: string
  replyCount: number | null
  updatedAt: string | null
}

export interface CommunityThreadReply {
  id: string
  content: string
  owner: number | null
  ownerName: string | null
  time: string | null
}

export interface CommunityThread {
  did: string
  title: string
  content: string
  domain: string
  node: string | null
  owner: number | null
  ownerName: string | null
  url: string
  replies: CommunityThreadReply[]
}

export interface CommunityConfig {
  enabled: boolean
  intervalMinutes: number
  domain: string
  siteAccountId: string | null
  /** Optional persona/tone used when generating AI reply drafts. */
  replyPersona: string
  lastCheckedAt: string | null
  seenDids: Array<{ did: string; replyCount: number | null }>
  newActivity: number
}

interface CommunityFile {
  version: number
  config: CommunityConfig
}

const VERSION = 1
const DEFAULTS: CommunityConfig = {
  enabled: false,
  intervalMinutes: 10,
  domain: 'system',
  siteAccountId: null,
  replyPersona: '',
  lastCheckedAt: null,
  seenDids: [],
  newActivity: 0,
}

export interface CommunityDeps {
  ops: HydroOpsApi
  dataDir: string
  log?: (message: string) => void
}

function ownerNames(body: unknown): Map<number, string> {
  const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  const udict = record.udict !== null && typeof record.udict === 'object' ? record.udict as Record<string, unknown> : {}
  const names = new Map<number, string>()
  for (const [id, user] of Object.entries(udict)) {
    if (user === null || typeof user !== 'object') continue
    const uname = (user as Record<string, unknown>).uname
    if (typeof uname === 'string' && uname !== '') names.set(Number(id), uname)
  }
  return names
}

function summaryOf(value: unknown, domain: string, owners: Map<number, string>): CommunityDiscussion {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const did = String(record.docId ?? record._id ?? '')
  const owner = typeof record.owner === 'number' ? record.owner : null
  return {
    did,
    title: typeof record.title === 'string' ? record.title : '(无标题)',
    content: typeof record.content === 'string' ? record.content.slice(0, 3000) : '',
    domain,
    node: typeof record.parentId === 'string' && record.parentId !== '' ? record.parentId : null,
    owner,
    ownerName: owner === null ? null : owners.get(owner) ?? null,
    url: domainPath(domain, `/discuss/${encodeURIComponent(did)}`),
    replyCount: typeof record.nReply === 'number' ? record.nReply
      : typeof record.replyCount === 'number' ? record.replyCount : null,
    updatedAt: typeof record.updateAt === 'string' ? record.updateAt
      : typeof record.updateAt === 'object' && record.updateAt !== null ? String(record.updateAt) : null,
  }
}

function replyOf(value: unknown, owners: Map<number, string>): CommunityThreadReply {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const owner = typeof record.owner === 'number' ? record.owner : null
  return {
    id: String(record.docId ?? record._id ?? ''),
    content: typeof record.content === 'string' ? record.content : '',
    owner,
    ownerName: owner === null ? null : owners.get(owner) ?? null,
    time: typeof record.updateAt === 'string' ? record.updateAt : null,
  }
}

/** Community polling + read/reply operations bound to one data directory. */
export class CommunityService {
  private readonly ops: HydroOpsApi
  private readonly path: string
  private config: CommunityConfig = { ...DEFAULTS, seenDids: [] }
  private loaded = false
  private timer: NodeJS.Timeout | null = null
  private sessions = new Map<string, { session: HydroSession; openedAt: number }>()
  private readonly logger?: (message: string) => void

  constructor(deps: CommunityDeps) {
    this.ops = deps.ops
    this.path = join(resolve(deps.dataDir), 'community.json')
    this.logger = deps.log
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await ensurePrivateDir(resolve(this.path, '..'))
    const file = await readJsonIfExists<CommunityFile>(this.path)
    if (file?.config !== undefined) {
      this.config = {
        ...DEFAULTS,
        ...file.config,
        seenDids: Array.isArray(file.config.seenDids) ? file.config.seenDids : [],
      }
    }
    this.loaded = true
  }

  getConfig(): CommunityConfig {
    return { ...this.config, seenDids: [...this.config.seenDids] }
  }

  async saveConfig(patch: Partial<Pick<CommunityConfig, 'enabled' | 'intervalMinutes' | 'domain' | 'siteAccountId' | 'replyPersona'>>): Promise<CommunityConfig> {
    const interval = Math.min(Math.max(Math.round(patch.intervalMinutes ?? this.config.intervalMinutes), 1), 24 * 60)
    this.config = {
      ...this.config,
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      intervalMinutes: interval,
      ...(patch.domain === undefined ? {} : { domain: patch.domain.trim() || 'system' }),
      ...(patch.siteAccountId === undefined ? {} : { siteAccountId: patch.siteAccountId }),
      ...(patch.replyPersona === undefined ? {} : { replyPersona: patch.replyPersona.slice(0, 1000) }),
    }
    await this.persist()
    if (this.config.enabled) this.start()
    else this.stop()
    return this.getConfig()
  }

  /** Manual/status read of recent discussions. */
  async feed(siteAccountId: string, domain: string, limit = 20): Promise<{ discussions: CommunityDiscussion[]; newActivity: number; lastCheckedAt: string | null }> {
    const discussions = await this.withSession(siteAccountId, async (session) => {
      const body = await session.getJson(`/d/${encodeURIComponent(domain)}/discuss?page=1`)
      const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
      const list = Array.isArray(record.ddocs) ? record.ddocs : Array.isArray(record.docs) ? record.docs : []
      const owners = ownerNames(body)
      return list.map((item) => summaryOf(item, domain, owners)).filter((item) => item.did !== '').slice(0, Math.min(Math.max(limit, 1), 50))
    })
    return { discussions, newActivity: this.config.newActivity, lastCheckedAt: this.config.lastCheckedAt }
  }

  async thread(siteAccountId: string, did: string): Promise<CommunityThread> {
    return this.withSession(siteAccountId, async (session) => {
      const body = await session.getJson(`/d/__domain__/discuss/${encodeURIComponent(did)}`.replace('__domain__', encodeURIComponent(this.domainFor(siteAccountId))))
      const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
      const owners = ownerNames(body)
      const domain = this.domainFor(siteAccountId)
      const ddoc = summaryOf(record.ddoc ?? {}, domain, owners)
      const replies = Array.isArray(record.drdocs) ? record.drdocs : Array.isArray(record.replies) ? record.replies : []
      return {
        did: ddoc.did === '' ? did : ddoc.did,
        title: ddoc.title,
        content: ddoc.content,
        domain,
        node: ddoc.node,
        owner: ddoc.owner,
        ownerName: ddoc.ownerName,
        url: ddoc.url,
        replies: replies.map((reply) => replyOf(reply, owners)),
      }
    })
  }

  /** Post one reply (explicit confirmed manual action). */
  async reply(siteAccountId: string, did: string, content: string, domain?: string): Promise<void> {
    if (content.trim() === '') throw new Error('回复内容不能为空')
    const targetDomain = domain?.trim() !== undefined && domain.trim() !== '' ? domain.trim() : this.domainFor(siteAccountId)
    await this.withSession(siteAccountId, async (session) => {
      await session.postForm(`/d/${encodeURIComponent(targetDomain)}/discuss/${encodeURIComponent(did)}`, {
        operation: 'reply',
        content,
      })
    })
  }

  /** Start the read-only polling timer (no automatic replies). */
  start(): void {
    if (this.timer !== null) return
    const tick = (): void => {
      void this.poll().catch((error: unknown) => {
        this.logger?.(`dsh-hydro: community poll failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    this.timer = setInterval(tick, Math.max(1, this.config.intervalMinutes) * 60_000)
    this.timer.unref?.()
    tick()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Poll now and record newly seen threads/reply counts. */
  async poll(): Promise<{ newActivity: number; discussions: CommunityDiscussion[]; lastCheckedAt: string }> {
    const siteAccountId = this.config.siteAccountId
    if (siteAccountId === null) return { newActivity: 0, discussions: [], lastCheckedAt: this.config.lastCheckedAt ?? new Date().toISOString() }
    const { discussions } = await this.feed(siteAccountId, this.config.domain, 30)
    const previous = new Map(this.config.seenDids.map((entry) => [entry.did, entry.replyCount]))
    let newActivity = 0
    for (const discussion of discussions) {
      if (!previous.has(discussion.did)) newActivity += 1
      else if ((discussion.replyCount ?? 0) > (previous.get(discussion.did) ?? 0)) newActivity += 1
    }
    this.config.seenDids = discussions.map((discussion) => ({ did: discussion.did, replyCount: discussion.replyCount }))
    this.config.lastCheckedAt = new Date().toISOString()
    this.config.newActivity = newActivity
    await this.persist()
    return { newActivity, discussions, lastCheckedAt: this.config.lastCheckedAt }
  }

  async dispose(): Promise<void> {
    this.stop()
    for (const entry of this.sessions.values()) await entry.session.close().catch(() => undefined)
    this.sessions.clear()
  }

  private domainFor(siteAccountId: string): string {
    const summary = this.ops.getSiteAccountSummary(siteAccountId)
    return summary?.domain ?? this.config.domain
  }

  private async withSession<T>(siteAccountId: string, fn: (session: HydroSession) => Promise<T>): Promise<T> {
    const cached = this.sessions.get(siteAccountId)
    let session: HydroSession
    if (cached !== undefined && Date.now() - cached.openedAt < 15 * 60_000) {
      session = cached.session
    } else {
      if (cached !== undefined) await cached.session.close().catch(() => undefined)
      const credentials = await this.ops.getSiteCredentials(siteAccountId)
      session = await this.ops.withContext(credentials.hostId, async (context: AccountContext) => {
        const port = await this.ops.hydroPort(context)
        return openHydroSession(context, { port, sid: credentials.sid })
      })
      this.sessions.set(siteAccountId, { session, openedAt: Date.now() })
    }
    try {
      return await fn(session)
    } catch (error) {
      // A host action may have reset the SSH tunnels; reconnect once.
      if (cached !== undefined) {
        await this.sessions.get(siteAccountId)?.session.close().catch(() => undefined)
        this.sessions.delete(siteAccountId)
        return this.withSession(siteAccountId, fn)
      }
      throw error
    }
  }

  private async persist(): Promise<void> {
    const file: CommunityFile = { version: VERSION, config: this.config }
    await writeFileAtomic(this.path, serializeJson(file), 0o600)
  }
}
