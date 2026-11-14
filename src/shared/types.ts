/**
 * DTOs shared by the host half and the browser half of `dsh-hydro`.
 *
 * This module must stay dependency-free (no `node:` imports, no DSH imports):
 * the client bundle imports it directly, and the host half must keep the same
 * shapes when it serializes them over HTTP.
 */

/** Prefix of every host route the browser half calls. */
export const HYDRO_API_PREFIX = '/dsh-hydro/api/v1'

/** Every status/operation payload carries the account it belongs to. */
export type AccountId = string

/** How the plugin authenticates to the remote host. */
export type AuthMethod = 'key' | 'password'

/** What the remote SSH user is allowed to do. */
export type AccountRole = 'root' | 'sudo' | 'user'

/** The small, secret-free projection of an account the UI and the model see. */
export interface AccountSummary {
  id: AccountId
  label: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** True when the managed key pair exists locally. */
  hasManagedKey: boolean
  /** ssh-ed25519 public key installed on the remote (masked-ish, full value is fine). */
  publicKey: string | null
  role: AccountRole
  readonly: boolean
  /** Default domain used by tools (`system` when unset). */
  createdAt: string
  updatedAt: string
  lastConnectedAt: string | null
  lastStatusAt: string | null
  hydro: HydroLocation | null
}

/** Where Hydro lives on the remote, as detected by the last probe. */
export interface HydroLocation {
  installed: boolean
  /** Detected installation shape (web, judge-only, or both). */
  installMode?: 'none' | 'web' | 'judge' | 'web+judge'
  installDir: string | null
  serviceManager: ServiceManager
  serviceName: string | null
  port: number | null
  domain: string | null
  version: string | null
}

export type ServiceManager = 'systemd' | 'pm2' | 'docker' | 'manual' | 'unknown'

export interface ServiceState {
  manager: ServiceManager
  name: string | null
  running: boolean
  pid: number | null
  /** ISO time the service started, when the manager exposes it. */
  since: string | null
  restarts: number | null
}

export interface HealthState {
  ok: boolean
  status: number | null
  latencyMs: number | null
  error: string | null
}

/** One installed Hydro plugin/module. */
export interface PluginInfo {
  name: string
  version: string | null
  latest: string | null
  updateAvailable: boolean
  builtin: boolean
  enabled: boolean
}

/** Judge/sandbox status plus queue depth when Hydro exposes it. */
export interface JudgeInfo {
  /** Sandbox implementation detected on the remote, e.g. `sandbox`/`go-judge`. */
  sandbox: string | null
  sandboxVersion: string | null
  /** Number of judge worker processes / judge containers seen. */
  workers: number | null
  queue: number | null
  running: number | null
  lastHeartbeat: string | null
}

export interface MongoState {
  reachable: boolean
  address: string | null
  db: string | null
  version: string | null
  collections: number | null
  oplog: {
    available: boolean
    sizeBytes: number | null
    firstTs: string | null
    lastTs: string | null
    entries: number | null
  }
}

export interface RemoteHostInfo {
  hostname: string | null
  platform: string | null
  release: string | null
  arch: string | null
  node: string | null
  uptimeSeconds: number | null
  load: number[]
  diskFreeBytes: number | null
  memoryFreeBytes: number | null
}

/** A warning equivalent to what Hydro shows an admin over the WebSocket. */
export interface StatusWarning {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  hint: string | null
}

export interface HydroStatus {
  accountId: AccountId
  collectedAt: string
  reachable: boolean
  error: string | null
  installMode: 'none' | 'web' | 'judge' | 'web+judge'
  components: {
    web: boolean
    judge: boolean
    caddy: boolean
    mongo: boolean
    sandbox: boolean
  }
  host: RemoteHostInfo | null
  hydro: {
    installed: boolean
    installDir: string | null
    version: string | null
    latestVersion: string | null
    updateAvailable: boolean
    service: ServiceState | null
    url: string | null
    health: HealthState | null
  }
  plugins: PluginInfo[]
  judge: JudgeInfo | null
  mongo: MongoState | null
  warnings: StatusWarning[]
}

/** Result of a mutating operation (install, upgrade, config change, ...). */
export interface OperationResult<T = unknown> {
  ok: boolean
  message: string
  details?: T
  /** Collected command output tail, useful for the model. */
  log?: string
}

/* ------------------------------------------------------------------ */
/* Host API payloads                                                   */
/* ------------------------------------------------------------------ */

export interface ListAccountsResponse {
  accounts: AccountSummary[]
  activeAccountId: AccountId | null
}

export interface CreateAccountRequest {
  label?: string
  host: string
  port?: number
  username: string
  authMethod: AuthMethod
  /** One-time SSH password: installs the managed key and passwordless sudo, never persisted. */
  password?: string
  privateKey?: string
  /** Install the plugin-managed public key on first password login. */
  installManagedKey?: boolean
  role?: AccountRole
  readonly?: boolean
}

export interface UpdateAccountRequest {
  label?: string
  host?: string
  port?: number
  username?: string
  role?: AccountRole
  readonly?: boolean
}

export interface TestConnectionResponse {
  ok: boolean
  latencyMs: number | null
  message: string
  role: AccountRole | null
  hostname: string | null
  node: string | null
  hydro: HydroLocation | null
}

export interface StatusResponse {
  status: HydroStatus
}

export interface ActivateAccountResponse {
  activeAccountId: AccountId | null
}

export interface ApiErrorBody {
  error: string
  code?: string
}
