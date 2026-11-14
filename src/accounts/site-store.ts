/**
 * Hydro web-admin site accounts — the site-management half of the
 * plugin, separate from SSH hosts.
 *
 * A host is a machine + SSH credentials; a site account is one Hydro web
 * login on that machine (super admin, domain admin, problem setter, judge…).
 * One host can own several site accounts so operators can keep a privileged
 * account and a limited account side by side.
 *
 * Layout under the same data directory as `AccountStore`:
 *
 * ```text
 * site-accounts.json      metadata, 0600
 * site-sessions.json      browser-captured Hydro sid cookies, 0600
 * ```
 *
 */
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import type { SiteAccountSummary } from '../shared/api.js'
import {
  ensurePrivateDir,
  readJsonIfExists,
  serializeJson,
  writeFileAtomic,
} from '../util/atomic-file.js'

/** How much the Hydro account can do; informational, shown in the UI. */
export type SiteRole = 'superadmin' | 'domain-admin' | 'problem-setter' | 'judge' | 'custom'

/** Persisted site-account metadata (never contains the password). */
export interface SiteAccountRecord {
  id: string
  hostId: string
  label: string
  uname: string
  domain: string | null
  role: SiteRole
  note: string | null
  readonly: boolean
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

interface SiteAccountsFile {
  version: number
  activeSiteAccountId: string | null
  accounts: SiteAccountRecord[]
}

interface SiteSessionFile {
  version: number
  sessions: Record<string, { sid: string; capturedAt: string; state?: string; checkedAt?: string }>
}

const VERSION = 1

function newId(): string {
  return `site-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function now(): string {
  return new Date().toISOString()
}

/** Input accepted when creating a site account. */
export interface CreateSiteAccountInput {
  hostId: string
  label?: string
  uname: string
  domain?: string | null
  role?: SiteRole
  note?: string | null
  readonly?: boolean
}

export interface UpdateSiteAccountInput {
  label?: string
  uname?: string
  domain?: string | null
  role?: SiteRole
  note?: string | null
  readonly?: boolean
}

/** Durable store for site accounts and their browser session cookies. */
export class SiteAccountStore {
  readonly dataDir: string
  readonly accountsPath: string
  readonly sessionsPath: string
  private accounts: SiteAccountRecord[] = []
  private sessions: Record<string, { sid: string; capturedAt: string; state?: string; checkedAt?: string }> = {}
  private active: string | null = null
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: { dataDir: string }) {
    this.dataDir = resolve(options.dataDir)
    this.accountsPath = join(this.dataDir, 'site-accounts.json')
    this.sessionsPath = join(this.dataDir, 'site-sessions.json')
  }

  /** Load the persisted site accounts and browser sessions. */
  async load(): Promise<void> {
    if (this.loaded) return
    await ensurePrivateDir(this.dataDir)
    const file = await readJsonIfExists<SiteAccountsFile>(this.accountsPath)
    if (file !== undefined) {
      this.accounts = Array.isArray(file.accounts) ? file.accounts : []
      this.active = typeof file.activeSiteAccountId === 'string' ? file.activeSiteAccountId : null
    }
    const sessionFile = await readJsonIfExists<SiteSessionFile>(this.sessionsPath)
    if (sessionFile !== undefined && typeof sessionFile.sessions === 'object' && sessionFile.sessions !== null) {
      this.sessions = sessionFile.sessions
    }
    if (this.active !== null && !this.accounts.some((account) => account.id === this.active)) {
      this.active = this.accounts[0]?.id ?? null
    }
    this.loaded = true
  }

  list(hostId?: string): SiteAccountRecord[] {
    this.assertLoaded()
    return hostId === undefined ? [...this.accounts] : this.accounts.filter((account) => account.hostId === hostId)
  }

  get(id: string): SiteAccountRecord | undefined {
    this.assertLoaded()
    return this.accounts.find((account) => account.id === id)
  }

  activeSiteAccountId(): string | null {
    this.assertLoaded()
    return this.active
  }

  /** Active site account for one host (used by the chat tools). */
  activeForHost(hostId: string): SiteAccountRecord | undefined {
    this.assertLoaded()
    const active = this.active === null ? undefined : this.get(this.active)
    if (active !== undefined && active.hostId === hostId) return active
    return this.accounts.find((account) => account.hostId === hostId)
  }

  async setActive(id: string | null): Promise<void> {
    this.assertLoaded()
    if (id !== null && this.get(id) === undefined) throw new Error(`未知站点账号 ${id}`)
    this.active = id
    await this.persistAccounts()
  }

  async create(input: CreateSiteAccountInput): Promise<SiteAccountRecord> {
    this.assertLoaded()
    if (input.hostId.trim() === '') throw new Error('hostId 不能为空')
    if (input.uname.trim() === '') throw new Error('Hydro 管理员用户名不能为空')
    const id = newId()
    const timestamp = now()
    const record: SiteAccountRecord = {
      id,
      hostId: input.hostId,
      label: input.label?.trim() !== undefined && input.label.trim() !== '' ? input.label.trim() : input.uname.trim(),
      uname: input.uname.trim(),
      domain: input.domain?.trim() || null,
      role: input.role ?? 'custom',
      note: input.note?.trim() || null,
      readonly: input.readonly ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: null,
    }
    this.accounts.push(record)
    if (this.active === null) this.active = id
    await this.persistAccounts()
    return record
  }

  async update(id: string, patch: UpdateSiteAccountInput): Promise<SiteAccountRecord> {
    this.assertLoaded()
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) throw new Error(`未知站点账号 ${id}`)
    const next: SiteAccountRecord = { ...this.accounts[index]!, updatedAt: now() }
    if (patch.label !== undefined) next.label = patch.label.trim() === '' ? next.label : patch.label.trim()
    if (patch.uname !== undefined) {
      if (patch.uname.trim() === '') throw new Error('Hydro 管理员用户名不能为空')
      next.uname = patch.uname.trim()
    }
    if (patch.domain !== undefined) next.domain = patch.domain?.trim() || null
    if (patch.role !== undefined) next.role = patch.role
    if (patch.note !== undefined) next.note = patch.note?.trim() || null
    if (patch.readonly !== undefined) next.readonly = patch.readonly
    this.accounts[index] = next
    await this.persistAccounts()
    return next
  }

  async remove(id: string): Promise<boolean> {
    this.assertLoaded()
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) return false
    this.accounts.splice(index, 1)
    delete this.sessions[id]
    if (this.active === id) this.active = this.accounts[0]?.id ?? null
    await this.persistAccounts()
    await this.persistSessions()
    return true
  }

  /** Browser-captured Hydro session cookie (only sid is retained). */
  getSessionToken(id: string): string | undefined {
    this.assertLoaded()
    const sid = this.sessions[id]?.sid
    return sid === undefined || sid === '' ? undefined : sid
  }

  getSessionCapturedAt(id: string): string | undefined {
    this.assertLoaded()
    return this.sessions[id]?.capturedAt
  }

  getSessionState(id: string): 'missing' | 'unknown' | 'active' | 'expired' {
    this.assertLoaded()
    const session = this.sessions[id]
    if (session === undefined) return 'missing'
    const state = session.state
    return state === 'active' || state === 'expired' || state === 'unknown' ? state : 'unknown'
  }

  getSessionCheckedAt(id: string): string | null {
    this.assertLoaded()
    return this.sessions[id]?.checkedAt ?? null
  }

  /** Persist the result of probing a session; missing session is represented without a token. */
  async setSessionState(id: string, state: 'missing' | 'unknown' | 'active' | 'expired'): Promise<void> {
    this.assertLoaded()
    if (this.get(id) === undefined) throw new Error(`未知站点账号 ${id}`)
    if (state === 'missing') {
      delete this.sessions[id]
    } else if (this.sessions[id] !== undefined) {
      this.sessions[id] = { ...this.sessions[id]!, state, checkedAt: now() }
    } else {
      return
    }
    await this.persistSessions()
  }

  hasSession(id: string): boolean {
    return this.getSessionToken(id) !== undefined
  }

  /** Persist a sid captured from the embedded browser login response. */
  async setSessionToken(id: string, sid: string): Promise<void> {
    this.assertLoaded()
    if (this.get(id) === undefined) throw new Error(`未知站点账号 ${id}`)
    if (sid.trim() === '') return
    this.sessions[id] = { sid: sid.trim(), capturedAt: now(), state: 'unknown' }
    await this.persistSessions()
  }

  async clearSessionToken(id: string): Promise<void> {
    this.assertLoaded()
    delete this.sessions[id]
    await this.persistSessions()
  }

  /** Mark one account as just used (best effort; ordering only). */
  async touch(id: string): Promise<void> {
    this.assertLoaded()
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) return
    this.accounts[index] = { ...this.accounts[index]!, lastUsedAt: now() }
    await this.persistAccounts()
  }

  /** Projection used by the HTTP API and the UI. */
  toSummary(record: SiteAccountRecord, hostLabel?: string): SiteAccountSummary {
    return {
      id: record.id,
      hostId: record.hostId,
      hostLabel: hostLabel ?? record.hostId,
      label: record.label,
      uname: record.uname,
      domain: record.domain ?? 'system',
      role: record.role,
      note: record.note,
      readonly: record.readonly,
      hasSession: this.hasSession(record.id),
      sessionState: this.getSessionState(record.id),
      sessionCapturedAt: this.getSessionCapturedAt(record.id) ?? null,
      sessionCheckedAt: this.getSessionCheckedAt(record.id),
      lastUsedAt: record.lastUsedAt,
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('dsh-hydro: site account store used before load()')
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  private persistAccounts(): Promise<void> {
    return this.enqueue(async () => {
      const file: SiteAccountsFile = {
        version: VERSION,
        activeSiteAccountId: this.active,
        accounts: this.accounts,
      }
      await writeFileAtomic(this.accountsPath, serializeJson(file), 0o600)
    })
  }

  private persistSessions(): Promise<void> {
    return this.enqueue(async () => {
      const file: SiteSessionFile = { version: VERSION, sessions: this.sessions }
      await writeFileAtomic(this.sessionsPath, serializeJson(file), 0o600)
    })
  }
}
