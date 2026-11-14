/**
 * Contracts shared by every Hydro operation module.
 *
 * An `AccountContext` is the only thing a Hydro module needs: it names the
 * connected remote host, the effective read-only state, the plugin config, and
 * a cancellation signal. Modules never create SSH connections themselves — the
 * caller owns the connection pool — which keeps them unit-testable with a fake
 * `SshConnection`.
 */
import type { AccountRecord } from '../accounts/store.js'
import type { Config } from '../config.js'
import type { SshConnection } from '../ssh/index.js'

/** Everything one operation needs to run against one remote account. */
export interface AccountContext {
  /** The persisted account (secret-free metadata). */
  account: AccountRecord
  /** Validated plugin configuration snapshot. */
  config: Config
  /** Live SSH connection owned by the caller; do not close it here. */
  connection: SshConnection
  /** Effective read-only state: global switch OR account-level switch. */
  readonly: boolean
  /** Plugin data directory (keys, snapshots, temporary files). */
  dataDir: string
  /** Cancels long-running operations. */
  signal?: AbortSignal
  /** Diagnostic sink; never receives secrets. */
  log(message: string): void
  /**
   * Always `undefined`: dsh-hydro does not store sudo/SSH passwords. Non-root
   * hosts are configured for passwordless sudo once during key bootstrap.
   */
  elevationPassword(): string | undefined
  /**
   * Hydro browser session captured by the embedded proxy. WS checks and the
   * management HTTP API use this sid cookie instead of a stored password.
   */
  hydroSession?(): { sid: string; uname: string | null } | undefined
}

/** Where Hydro lives on the remote, as detected by the probe. */
export interface HydroProbe {
  installed: boolean
  /** Whether the host runs the web installer, a judge-only install, or both. */
  installMode: 'none' | 'web' | 'judge' | 'web+judge'
  /** Detected components, used to hide unusable config/UI. */
  components: {
    web: boolean
    judge: boolean
    caddy: boolean
    mongo: boolean
    sandbox: boolean
  }
  installDir: string | null
  /** `yarn global dir`, when yarn is available. */
  yarnGlobalDir: string | null
  serviceManager: 'systemd' | 'pm2' | 'docker' | 'manual' | 'unknown'
  /** Raw `pm2 jlist` entries (name/status/pid/restarts/uptime/execPath). */
  pm2: Array<{
    name: string
    status: string
    pid: number | null
    restarts: number | null
    uptimeMs: number | null
    execPath: string | null
    /** pm2 monit CPU usage in percent, when reported. */
    cpuPercent?: number | null
    /** pm2 monit memory usage in bytes, when reported. */
    memoryBytes?: number | null
    /** pm2 stdout/stderr log paths, when reported. */
    outLogPath?: string | null
    errLogPath?: string | null
  }>
  hydrooj: { name: string; version: string | null; path: string | null } | null
  config: {
    path: string | null
    uri: string | null
    /** Mongo database name parsed out of the URI. */
    database: string | null
    host: string
    port: number
  } | null
  addons: Array<{ name: string; version: string | null; path: string | null }>
  /** The addon.json list (names as the user configured them). */
  addonNames: string[]
  ports: { hydro: number | null; mongo: number | null; sandbox: number | null }
  health: { status: number | null; ok: boolean; latencyMs: number | null }
  sandbox: { running: boolean; version: string | null; address: string | null }
  judge: { installed: boolean; running: boolean; configPath: string | null }
  os: { prettyName: string | null; kernel: string | null; arch: string | null }
  node: { version: string | null; path: string | null }
  marker: string | null
  /** Raw diagnostics for troubleshooting; never included in model output blindly. */
  warnings: string[]
}

/** Option bag for {@link collectStatus}-style aggregation. */
export interface StatusOptions {
  includeMongo: boolean
  includeOplog: boolean
  includeWsWarnings: boolean
  includeLatestVersions: boolean
  timeoutMs: number
}

/** Mongo query spec accepted by the read-only `hydro_db` tool. */
export interface MongoQuerySpec {
  collection: string
  filter?: Record<string, unknown>
  projection?: Record<string, 0 | 1>
  sort?: Record<string, 1 | -1>
  limit?: number
  skip?: number
}

/** Query spec for the Hydro application oplog (`oplog` collection). */
export interface OplogQuerySpec {
  /** e.g. `problem.edit`, `user.login`; substring match when `contains` is set. */
  type?: string
  contains?: string
  operator?: number
  limit?: number
  since?: string
  source: 'hydro' | 'mongo' | 'auto'
}

export interface OplogEntry {
  id: string
  source: 'hydro' | 'mongo'
  type: string
  time: string
  operator: number | null
  domainId: string | null
  path: string | null
  args: unknown
  ip: string | null
}

export interface OplogResult {
  source: 'hydro' | 'mongo'
  entries: OplogEntry[]
  /** True when the requested source is unavailable and the other one answered. */
  fallback: boolean
  note: string | null
  /** Mongo oplog availability facts. */
  mongo: {
    available: boolean
    sizeBytes: number | null
    firstTs: string | null
    lastTs: string | null
  } | null
}

/** Result of a remote service action (`pm2 restart hydrooj`, ...). */
export interface ServiceActionResult {
  target: 'hydro' | 'mongodb' | 'sandbox' | 'caddy' | 'judge'
  manager: 'pm2' | 'systemd' | 'manual'
  action: 'start' | 'stop' | 'restart' | 'reload' | 'status'
  ok: boolean
  output: string
}
