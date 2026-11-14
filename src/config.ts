/**
 * Plugin configuration, supplied through the profile patch:
 *
 * ```yaml
 * - id: dsh-hydro
 *   name: dsh-hydro
 *   config:
 *     readonlyMode: false
 *     hydro:
 *       installerUrl: https://hydro.ac/setup.sh
 * ```
 *
 * Everything two deployments may want to set differently is a field here rather
 * than a constant in the code.
 */
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export type ElevationStrategy = 'auto' | 'sudo' | 'su'
export type HostKeyPolicy = 'accept-new' | 'strict' | 'off'

export interface HydroConfig {
  /** Absolute install directory on the remote. Empty means "detect". */
  installDir: string
  /** systemd unit / pm2 app name installed by Hydro. */
  serviceName: string
  /** Override the detected HTTP port (Hydro default 8888). 0 means "detect". */
  port: number
  /** Official installer URL. */
  installerUrl: string
  /** Optional npm/yarn registry mirror used for installs and upgrades. */
  registry: string
  /** How non-root SSH users become root for install/upgrade operations. */
  elevation: ElevationStrategy
  /** Service manager to control after install/upgrade (`auto` detects). */
  serviceManager: 'auto' | 'systemd' | 'pm2' | 'manual'
  /** Skip host package-manager installs (node/mongo/yarn already present). */
  skipSystemPackages: boolean
}

export interface MongoConfig {
  /** Remote address reachable from the remote host (Hydro's default is loopback). */
  host: string
  port: number
  /** Database name; empty means "read from Hydro config". */
  db: string
}

export interface StatusConfig {
  /** Per-collection deadline for one status collection. */
  timeoutMs: number
  /** Open an SSH tunnel and inspect MongoDB. */
  includeMongo: boolean
  /** Read the oplog window. Only meaningful with `includeMongo`. */
  includeOplog: boolean
  /** Open a tunnel and connect a WebSocket as the Hydro admin to collect notices. */
  includeWsWarnings: boolean
  /** Ask the npm registry for the newest core/plugin versions. */
  includeLatestVersions: boolean
}

export interface SecurityConfig {
  /** Allow the model to run arbitrary remote commands through `hydro_exec`. */
  allowArbitraryCommands: boolean
  /** Maximum command output kept in memory for tool results. */
  maxCommandOutputBytes: number
}

export interface ProblemConfig {
  /** Domain used to create generated problems when the call names none. */
  defaultDomain: string
  /** Directory (local to the DSH workspace) where the agent writes problem packages. */
  workspaceDir: string
  /** Sandbox time limit applied to generated solutions when unspecified. */
  defaultTimeLimitMs: number
  /** Memory limit applied to generated solutions when unspecified. */
  defaultMemoryLimitMb: number
  /** Score a partial-score solution must beat to be accepted by the verifier. */
  partialMinScore: number
  /** Max seconds to wait for one judge result while verifying. */
  judgeTimeoutMs: number
}

export interface Config {
  /** Directory holding account metadata, keys and known_hosts. Empty uses `$DSH_HOME/dsh-hydro`. */
  dataDir: string
  /** Global read-only switch: mutating tools refuse to run while true. */
  readonlyMode: Volatile<boolean>
  /** Default read-only state for newly created accounts. */
  defaultReadonly: boolean
  /** SSH connect timeout. */
  connectTimeoutMs: number
  /** Default timeout for one remote command. */
  commandTimeoutMs: number
  /** Host key verification policy. */
  hostKeyPolicy: HostKeyPolicy
  /** Known-hosts file; empty means `<dataDir>/known_hosts`. */
  knownHostsPath: string
  /** npm registry used for the latest-version checks. */
  npmRegistry: string
  hydro: HydroConfig
  mongo: MongoConfig
  status: StatusConfig
  problem: ProblemConfig
  security: SecurityConfig
  ui: {
    /** Show the account/status panel in the Web UI. */
    showPanel: boolean
    /** Register the ops skill so the agent loads guidance on demand. */
    registerSkill: boolean
  }
}

// The exported schema and the `Config` interface share a name (type vs. value
// namespace). The interface keeps `Volatile<T>` fields typed as the live boxes
// Cordis passes at runtime; the schema infers the plain values it accepts.
export const Config = Schema.object({
  dataDir: Schema.string().default(''),
  readonlyMode: Schema.boolean().default(false).volatile().description('只读模式：所有会修改远端的工具都会拒绝执行'),
  defaultReadonly: Schema.boolean().default(false).description('新建账号默认是否为只读'),
  connectTimeoutMs: Schema.number().min(1000).default(20_000),
  commandTimeoutMs: Schema.number().min(1000).default(120_000),
  hostKeyPolicy: Schema.union(['accept-new', 'strict', 'off']).default('accept-new'),
  knownHostsPath: Schema.string().default(''),
  npmRegistry: Schema.string().default('https://registry.npmjs.org'),
  hydro: Schema.object({
    installDir: Schema.string().default(''),
    serviceName: Schema.string().default('hydrooj'),
    port: Schema.number().min(0).max(65535).default(0),
    installerUrl: Schema.string().default('https://hydro.ac/setup.sh'),
    registry: Schema.string().default(''),
    elevation: Schema.union(['auto', 'sudo', 'su']).default('auto'),
    serviceManager: Schema.union(['auto', 'systemd', 'pm2', 'manual']).default('auto'),
    skipSystemPackages: Schema.boolean().default(false),
  }),
  mongo: Schema.object({
    host: Schema.string().default('127.0.0.1'),
    port: Schema.number().min(1).max(65535).default(27017),
    db: Schema.string().default(''),
  }),
  status: Schema.object({
    timeoutMs: Schema.number().min(1000).default(30_000),
    includeMongo: Schema.boolean().default(true),
    includeOplog: Schema.boolean().default(true),
    includeWsWarnings: Schema.boolean().default(true),
    includeLatestVersions: Schema.boolean().default(true),
  }),
  problem: Schema.object({
    defaultDomain: Schema.string().default('system'),
    workspaceDir: Schema.string().default('hydro-problems'),
    defaultTimeLimitMs: Schema.number().min(100).default(1000),
    defaultMemoryLimitMb: Schema.number().min(16).default(256),
    partialMinScore: Schema.number().min(0).max(100).default(1),
    judgeTimeoutMs: Schema.number().min(10_000).default(180_000),
  }),
  security: Schema.object({
    allowArbitraryCommands: Schema.boolean().default(false).description('允许模型通过 hydro_exec 执行任意远端命令（高风险）'),
    maxCommandOutputBytes: Schema.number().min(4096).default(65536),
  }),
  ui: Schema.object({
    showPanel: Schema.boolean().default(true),
    registerSkill: Schema.boolean().default(true),
  }),
})
