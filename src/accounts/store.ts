/**
 * Persistent account records for `dsh-hydro`.
 *
 * Layout under `dataDir` (defaults to `$DSH_HOME/dsh-hydro`):
 *
 * ```text
 * accounts.json      metadata, 0600
 * keys/<id>         plugin-managed private key (OpenSSH PEM), 0600
 * keys/<id>.pub     authorized_keys line, 0644
 * known_hosts       TOFU host keys, 0600
 * ```
 *
 * The managed SSH private key is the only credential persisted here. Account
 * summaries (what tools and the UI see) deliberately contain no secret fields;
 * one-time bootstrap passwords are passed in memory and never stored.
 */
import { randomUUID } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { AuthMethod, AccountRole, AccountSummary } from '../shared/types.js'
import {
  ensurePrivateDir,
  readFileIfExists,
  readJsonIfExists,
  removeIfExists,
  serializeJson,
  writeFileAtomic,
} from '../util/atomic-file.js'

/** Current on-disk schema version; bump when a migration is required. */
export const ACCOUNT_STORE_VERSION = 1

/** Persisted account metadata. Never contains a password or private key. */
export interface AccountRecord {
  id: string
  label: string
  host: string
  port: number
  username: string
  /**
   * Authentication the plugin *prefers* for the next connection. Password
   * accounts are expected to be converted to key auth on first successful
   * login (`bootstrapKey: true`), after which `authMethod` becomes `key`.
   */
  authMethod: AuthMethod
  /** True when the plugin manages (generated) the key pair for this account. */
  managedKey: boolean
  /** Absolute path to the private key used for key auth, when one is configured. */
  privateKeyPath: string | null
  /** Public key line installed on the remote (`ssh-ed25519 AAAA... comment`). */
  publicKey: string | null
  role: AccountRole
  /** User-requested read-only mode: tools refuse mutating operations. */
  readonly: boolean
  /** Default Hydro domain for problem/contest operations. */
  createdAt: string
  updatedAt: string
  lastConnectedAt: string | null
  lastStatusAt: string | null
  hydro: AccountSummary['hydro']
}

/** Non-secret file envelope. */
interface AccountFile {
  version: number
  activeAccountId: string | null
  accounts: AccountRecord[]
}

/** Secret material for one account. Values are optional and independent. */
export interface CreateAccountRecordInput {
  label?: string
  host: string
  port?: number
  username: string
  authMethod: AuthMethod
  /** One-time bootstrap password (memory only). */
  password?: string
  privateKey?: string
  managedKey?: boolean
  role?: AccountRole
  readonly?: boolean
}

export interface AccountStoreOptions {
  /** Directory holding accounts.json, keys/ and known_hosts. */
  dataDir?: string
}

/** Default data directory, honoring `DSH_HOME` like the rest of the harness. */
export function defaultDataDir(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'dsh-hydro')
}

/** Short human-friendly unique account id, safe in a credential key segment. */
function newAccountId(): string {
  return `acc-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function now(): string {
  return new Date().toISOString()
}

/** A human label derived from user@host when none was supplied. */
function defaultLabel(username: string, host: string): string {
  return `${username}@${host}`
}

/**
 * Durable account store. All reads are in-memory after `load()`; every write
 * is durable before the promise resolves.
 */
export class AccountStore {
  readonly dataDir: string
  readonly keysDir: string
  readonly knownHostsPath: string
  readonly accountsPath: string

  private accounts: AccountRecord[] = []
  private active: string | null = null
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: AccountStoreOptions = {}) {
    this.dataDir = resolve(options.dataDir?.trim() !== undefined && options.dataDir.trim() !== '' ? options.dataDir : defaultDataDir())
    this.keysDir = join(this.dataDir, 'keys')
    this.accountsPath = join(this.dataDir, 'accounts.json')
    this.knownHostsPath = join(this.dataDir, 'known_hosts')
  }

  /** Load (and create, on first use) the on-disk store. */
  async load(): Promise<void> {
    if (this.loaded) return
    await ensurePrivateDir(this.dataDir)
    await ensurePrivateDir(this.keysDir)
    const file = await readJsonIfExists<AccountFile>(this.accountsPath)
    if (file !== undefined) {
      if (file.version !== ACCOUNT_STORE_VERSION) {
        throw new Error(`dsh-hydro: unsupported accounts.json version ${String(file.version)} (expected ${ACCOUNT_STORE_VERSION})`)
      }
      this.accounts = Array.isArray(file.accounts) ? file.accounts : []
      this.active = typeof file.activeAccountId === 'string' ? file.activeAccountId : null
    }
    // A stale active id must never point at a removed account.
    if (this.active !== null && !this.accounts.some((account) => account.id === this.active)) {
      this.active = this.accounts[0]?.id ?? null
    }
    this.loaded = true
  }

  /** All accounts in creation order. */
  list(): AccountRecord[] {
    this.assertLoaded()
    return [...this.accounts]
  }

  get(id: string): AccountRecord | undefined {
    this.assertLoaded()
    return this.accounts.find((account) => account.id === id)
  }

  /** The id tools use when no account is named. */
  activeAccountId(): string | null {
    this.assertLoaded()
    return this.active
  }

  async setActive(id: string | null): Promise<void> {
    this.assertLoaded()
    if (id !== null && this.get(id) === undefined) throw new Error(`dsh-hydro: unknown account id ${id}`)
    this.active = id
    await this.persistAccounts()
  }

  async create(input: CreateAccountRecordInput): Promise<AccountRecord> {
    this.assertLoaded()
    const host = input.host.trim()
    const username = input.username.trim()
    if (host === '') throw new Error('dsh-hydro: host must not be empty')
    if (username === '') throw new Error('dsh-hydro: username must not be empty')
    const port = input.port ?? 22
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('dsh-hydro: port must be an integer between 1 and 65535')

    const id = newAccountId()
    const timestamp = now()
    const record: AccountRecord = {
      id,
      label: input.label?.trim() !== undefined && input.label.trim() !== '' ? input.label.trim() : defaultLabel(username, host),
      host,
      port,
      username,
      authMethod: input.privateKey !== undefined && input.privateKey.trim() !== '' ? 'key' : input.authMethod,
      managedKey: input.managedKey ?? input.authMethod === 'key',
      privateKeyPath: null,
      publicKey: null,
      role: input.role ?? 'user',
      readonly: input.readonly ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastConnectedAt: null,
      lastStatusAt: null,
      hydro: null,
    }

    let privateKeyPath: string | null = null
    if (input.privateKey !== undefined && input.privateKey.trim() !== '') {
      privateKeyPath = join(this.keysDir, id)
      await writeFileAtomic(privateKeyPath, normalizePrivateKey(input.privateKey), 0o600)
    }
    // A managed key pair is generated and written by the caller after creation
    // (`setManagedKey`); the one-time bootstrap password is passed to the
    // connection pool directly and is never kept in this record.
    record.privateKeyPath = privateKeyPath

    this.accounts.push(record)
    if (this.active === null) this.active = id
    await this.persistAccounts()
    return record
  }

  async update(id: string, patch: Partial<Pick<AccountRecord, 'label' | 'host' | 'port' | 'username' | 'role' | 'readonly' | 'authMethod' | 'managedKey'>> & {
    publicKey?: string | null
    privateKeyPath?: string | null
    hydro?: AccountRecord['hydro']
    lastConnectedAt?: string | null
    lastStatusAt?: string | null
  }): Promise<AccountRecord> {
    this.assertLoaded()
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) throw new Error(`dsh-hydro: unknown account id ${id}`)
    const current = this.accounts[index]!
    const next: AccountRecord = { ...current, updatedAt: now() }
    for (const key of ['label', 'host', 'port', 'username', 'role', 'readonly', 'authMethod', 'managedKey', 'publicKey', 'privateKeyPath', 'hydro', 'lastConnectedAt', 'lastStatusAt'] as const) {
      const value = patch[key]
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value
    }
    this.accounts[index] = next
    await this.persistAccounts()
    return next
  }

  async remove(id: string): Promise<boolean> {
    this.assertLoaded()
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index === -1) return false
    const [removed] = this.accounts.splice(index, 1)
    if (this.active === id) this.active = this.accounts[0]?.id ?? null
    await this.persistAccounts()
    const keyPath = removed?.privateKeyPath
    if (keyPath !== null && keyPath !== undefined) {
      await removeIfExists(keyPath)
      await removeIfExists(`${keyPath}.pub`)
    }
    return true
  }

  /* -------------------------------------------------------------- */
  /* Managed key pair                                                */
  /* -------------------------------------------------------------- */

  async getManagedPrivateKey(id: string): Promise<string | undefined> {
    const record = this.get(id)
    if (record === undefined) return undefined
    const path = record.privateKeyPath ?? join(this.keysDir, id)
    return readFileIfExists(path)
  }

  async getManagedPublicKey(id: string): Promise<string | undefined> {
    const record = this.get(id)
    if (record === undefined) return undefined
    if (record.publicKey !== null) return record.publicKey
    const path = record.privateKeyPath ?? join(this.keysDir, id)
    return readFileIfExists(`${path}.pub`)
  }

  /** Persist a generated key pair for an account and switch it to key auth. */
  async setManagedKey(id: string, privateKey: string, publicKey: string): Promise<AccountRecord> {
    const record = this.get(id)
    if (record === undefined) throw new Error(`dsh-hydro: unknown account id ${id}`)
    const path = join(this.keysDir, id)
    await writeFileAtomic(path, normalizePrivateKey(privateKey), 0o600)
    await writeFileAtomic(`${path}.pub`, `${publicKey.trim()}\n`, 0o644)
    try {
      await chmod(`${path}.pub`, 0o644)
    } catch {
      // ignore unsupported filesystems
    }
    return this.update(id, { privateKeyPath: path, publicKey: publicKey.trim(), authMethod: 'key' })
  }

  /** Install a user-supplied private key for an account. */
  async setPrivateKey(id: string, privateKey: string, publicKey?: string): Promise<AccountRecord> {
    const record = this.get(id)
    if (record === undefined) throw new Error(`dsh-hydro: unknown account id ${id}`)
    const path = join(this.keysDir, id)
    await writeFileAtomic(path, normalizePrivateKey(privateKey), 0o600)
    if (publicKey !== undefined) await writeFileAtomic(`${path}.pub`, `${publicKey.trim()}\n`, 0o644)
    return this.update(id, {
      privateKeyPath: path,
      authMethod: 'key',
      ...(publicKey === undefined ? {} : { publicKey: publicKey.trim() }),
    })
  }

  /** Remove the managed key pair from disk (metadata is cleared by the caller). */
  async clearManagedKey(id: string): Promise<void> {
    const record = this.get(id)
    if (record === undefined) return
    const path = record.privateKeyPath ?? join(this.keysDir, id)
    await removeIfExists(path)
    await removeIfExists(`${path}.pub`)
    await this.update(id, { privateKeyPath: null, publicKey: null, authMethod: 'key' })
  }

  hasManagedKey(id: string): boolean {
    const record = this.get(id)
    if (record === undefined) return false
    return record.privateKeyPath !== null
  }

  /** True when the account has enough material to attempt a connection. */
  canConnect(id: string): boolean {
    const record = this.get(id)
    if (record === undefined) return false
    return record.privateKeyPath !== null
  }

  /* -------------------------------------------------------------- */
  /* Projections                                                     */
  /* -------------------------------------------------------------- */

  toSummary(record: AccountRecord): AccountSummary {
    return {
      id: record.id,
      label: record.label,
      host: record.host,
      port: record.port,
      username: record.username,
      authMethod: record.authMethod,
      hasManagedKey: record.privateKeyPath !== null,
      publicKey: record.publicKey,
      role: record.role,
      readonly: record.readonly,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastConnectedAt: record.lastConnectedAt,
      lastStatusAt: record.lastStatusAt,
      hydro: record.hydro,
    }
  }

  /* -------------------------------------------------------------- */
  /* Internals                                                       */
  /* -------------------------------------------------------------- */

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('dsh-hydro: account store used before load()')
  }

  /** Serialize writes so concurrent tool calls cannot interleave files. */
  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task)
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private persistAccounts(): Promise<void> {
    return this.enqueueWrite(async () => {
      const file: AccountFile = {
        version: ACCOUNT_STORE_VERSION,
        activeAccountId: this.active,
        accounts: this.accounts,
      }
      await writeFileAtomic(this.accountsPath, serializeJson(file), 0o600)
    })
  }

}

/** Ensure a user-pasted key ends with exactly one trailing newline. */
export function normalizePrivateKey(privateKey: string): string {
  return `${privateKey.trimEnd()}\n`
}
