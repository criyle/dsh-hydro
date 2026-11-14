/**
 * The single entry point the tools, routes and client half call.
 *
 * `HydroOps` owns the account store, the SSH connection pool and the shared
 * tunnel/web-session caches. The module is split from its implementation so
 * tool registrars only depend on this narrow interface.
 */
import type { SiteAccountSummary, SiteRole } from '../shared/api.js'
import type { AccountSummary, HydroLocation, HydroStatus, OperationResult } from '../shared/types.js'
import type { Config } from '../config.js'
import type { AccountContext, MongoQuerySpec, OplogQuerySpec, OplogResult, ServiceActionResult, StatusOptions } from './types.js'
import type { OutputSink } from '../hydro/remote.js'

/** Account creation input accepted by the tool and HTTP surfaces. */
export interface AddAccountInput {
  label?: string
  host: string
  port?: number
  username: string
  authMethod: 'key' | 'password'
  /** One-time SSH password; not persisted. */
  password?: string
  privateKey?: string
  /** Generate and install the plugin key after a successful password login. */
  installManagedKey?: boolean
  role?: 'root' | 'sudo' | 'user'
  readonly?: boolean
}

export interface UpdateAccountInput {
  label?: string
  host?: string
  port?: number
  username?: string
  role?: 'root' | 'sudo' | 'user'
  readonly?: boolean
}

/** Everything the plugin exposes to tools, HTTP routes and the client half. */
export interface HydroOpsApi {
  /** Validated configuration snapshot (volatile fields read through `.get()`). */
  readonly config: Config
  /** Complete one-time initialization (account store load, directories). */
  ready(): Promise<void>
  /** Global read-only switch, regardless of account-level state. */
  isGloballyReadonly(): boolean
  /** Persisted operator settings (global read-only switch). */
  getUiSettings(): { readonlyMode: boolean; updatedAt: string | null }
  setGlobalReadonly(readonly: boolean): Promise<{ readonlyMode: boolean; updatedAt: string | null }>

  /* Accounts ------------------------------------------------------- */
  listAccounts(): AccountSummary[]
  activeAccountId(): string | null
  getAccountSummary(accountId: string): AccountSummary | undefined
  addAccount(input: AddAccountInput, onLog?: (line: string) => void): Promise<AccountSummary>
  updateAccount(accountId: string, input: UpdateAccountInput): Promise<AccountSummary>
  removeAccount(accountId: string): Promise<boolean>
  setActiveAccount(accountId: string | null): Promise<void>
  /** Test connectivity, detect the remote role and Hydro install state. */
  testAccount(accountId: string): Promise<{
    ok: boolean
    latencyMs: number | null
    message: string
    role: 'root' | 'sudo' | 'user' | null
    hostname: string | null
    node: string | null
    hydro: HydroLocation | null
  }>
  /** Resolve the account id, defaulting to the active account. */
  resolveAccountId(accountId?: string): string

  /* Context helpers ------------------------------------------------ */
  /** Open (or reuse) a connection and build the context passed to Hydro modules. */
  withContext<T>(accountId: string | undefined, fn: (context: AccountContext) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  /** Throw a model-facing error when the account is in read-only mode. */
  assertWritable(context: AccountContext, action: string): void
  /** Resolve + assert writable + run. */
  withWritableContext<T>(accountId: string | undefined, action: string, fn: (context: AccountContext) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  /** Effective remote Hydro HTTP port for the connected account. */
  hydroPort(context: AccountContext): Promise<number>
  /** Browser-captured Hydro session for a tool that needs an authenticated API. */
  getSiteSession(accountId: string, siteAccountId?: string): Promise<{
    uname: string | null
    sid: string | null
    domain: string | null
    siteAccountId: string | null
  }>

  /* Site accounts (Hydro web logins, N per host) ------------------ */
  listSiteAccounts(hostId?: string): SiteAccountSummary[]
  getSiteAccountSummary(id: string): SiteAccountSummary | undefined
  activeSiteAccountId(): string | null
  /** Persist the last known validity of a site-account browser session. */
  setSiteSessionState(siteAccountId: string, state: 'missing' | 'unknown' | 'active' | 'expired'): Promise<void>
  addSiteAccount(input: {
    hostId: string
    label?: string
    uname: string
    domain?: string
    role?: SiteRole
    note?: string
    readonly?: boolean
  }): Promise<SiteAccountSummary>
  updateSiteAccount(id: string, input: {
    label?: string
    uname?: string
    domain?: string
    role?: SiteRole
    note?: string
    readonly?: boolean
  }): Promise<SiteAccountSummary>
  removeSiteAccount(id: string): Promise<boolean>
  setActiveSiteAccount(id: string | null): Promise<void>
  /** Resolve the browser-captured session of one site account (throws when missing). */
  getSiteCredentials(id: string): Promise<{ id: string; hostId: string; uname: string; sid: string; domain: string }>
  /** Persist a sid captured from the embedded browser for the active site account. */
  captureSiteSession(hostId: string, sid: string): Promise<void>

  /* Status --------------------------------------------------------- */
  /** Mongo state only (used by the db/oplog tools' rendering). */
  inspectMongo(accountId: string | undefined): Promise<import('../shared/types.js').MongoState>
  collectStatus(accountId: string | undefined, options?: Partial<StatusOptions>): Promise<HydroStatus>
  /** Fast reachability + version probe without Mongo/WS/latest-version work. */
  quickProbe(accountId: string | undefined): Promise<HydroStatus>
  /** Visual pm2/service overview (fast probe, no writes). */
  serviceOverview(accountId: string | undefined): Promise<import('../hydro/service.js').ServiceOverview>
  /** Rejudge old in-flight records (stale queue diagnostic). */
  rejudgeStale(accountId: string | undefined): Promise<OperationResult>
  /** Read the standalone judge.yaml and process state. */
  readJudgeConfig(accountId: string | undefined): Promise<import('../shared/api.js').JudgeConfigResponse>
  /** Save judge.yaml + restart hydrojudge. */
  writeJudgeConfig(accountId: string | undefined, input: { path: string; content: string }): Promise<OperationResult>
  /** Restart hydrojudge. */
  restartJudge(accountId: string | undefined): Promise<OperationResult>
  /** Whether MongoDB is installed/running (read-only probe). */
  databaseStatus(accountId: string | undefined): Promise<import('../shared/api.js').HostDatabaseStatusResponse>
  /** Run the official `hydrooj diagnosis` script (read-only). */
  diagnosis(accountId: string | undefined): Promise<{ ok: boolean; message: string; log: string }>
  /** Recent pm2 logs for one process. */
  processLogs(accountId: string | undefined, input: { process: string; lines?: number }): Promise<import('../shared/api.js').ProcessLogsResponse>
  /** One host metrics sample (CPU/memory/disk/judge queue). */
  metrics(accountId: string | undefined): Promise<import('../shared/api.js').HostMetricsResponse>
  /** Known-issue diagnostics. */
  issues(accountId: string | undefined): Promise<import('../shared/api.js').HostIssuesResponse>
  /** Apply one allow-listed known-issue fix. */
  fixIssue(accountId: string | undefined, action: import('../hydro/fixes.js').IssueFix): Promise<OperationResult>
  /** Browser-reachable Hydro URL for embedded pages (loopback proxy to Caddy :80 when possible). */
  address(accountId: string | undefined): Promise<import('../shared/api.js').HostAddressResponse>
  /** What page the embedded browser currently shows (tracked by the proxy). */
  embeddedContext(accountId: string | undefined): import('../shared/api.js').EmbeddedContextResponse | null
  /** List Hydro addons/plugins. */
  listPlugins(accountId: string | undefined): Promise<import('../shared/api.js').PluginListResponse>
  /** Install/uninstall/enable/disable one addon. */
  managePlugin(accountId: string | undefined, input: { action: import('../hydro/plugins.js').PluginAction; name: string }): Promise<OperationResult>
  /** Read the Caddyfile + process state. */
  readCaddy(accountId: string | undefined): Promise<import('../shared/api.js').CaddyResponse>
  /** Write/validate/reload the Caddyfile. */
  writeCaddy(accountId: string | undefined, input: { path: string; content: string; reload: boolean }): Promise<OperationResult>
  /** Validate or reload the current Caddyfile. */
  applyCaddy(accountId: string | undefined, action: 'validate' | 'reload'): Promise<OperationResult>
  /** Run one `hydrooj <command>` (Hydro CLI only). */
  runCli(accountId: string | undefined, command: string, onOutput?: import('../hydro/remote.js').OutputSink): Promise<{ exitCode: number | null; output: string }>
  /** Restore a backup zip under /data. */
  restoreBackup(accountId: string | undefined, filename: string, onOutput?: import('../hydro/remote.js').OutputSink): Promise<{ exitCode: number | null; output: string }>
  /** List /data backup zips. */
  listBackups(accountId: string | undefined): Promise<import('../shared/api.js').BackupsResponse>
  /** Upgradeable package inventory + node/go-judge/nix facts. */
  packages(accountId: string | undefined): Promise<import('../shared/api.js').PackageListResponse>
  /** Advanced Nix maintenance (mirror / node / go-judge). */
  nixMaintenance(accountId: string | undefined, action: import('../hydro/nix.js').NixAction): Promise<OperationResult>
  /** Newest versions from the configured npm registry. */
  latestVersions(names: string[]): Promise<Record<string, string | null>>

  /* Service -------------------------------------------------------- */
  install(accountId: string | undefined, options?: { judge?: boolean; noCaddy?: boolean; onOutput?: OutputSink }): Promise<OperationResult>
  upgrade(accountId: string | undefined, options?: { dryRun?: boolean; includeJudge?: boolean; packages?: string[]; onOutput?: OutputSink }): Promise<OperationResult>
  serviceAction(accountId: string | undefined, target: ServiceActionResult['target'], action: ServiceActionResult['action']): Promise<ServiceActionResult>

  /* Mongo / oplog -------------------------------------------------- */
  queryDatabase(accountId: string | undefined, spec: MongoQuerySpec): Promise<{ documents: unknown[]; truncated: boolean; collection: string }>
  listCollections(accountId: string | undefined): Promise<Array<{ name: string; count: number | null; sizeBytes: number | null }>>
  queryOplog(accountId: string | undefined, spec: OplogQuerySpec): Promise<OplogResult>

  /* Cleanup -------------------------------------------------------- */
  dispose(): Promise<void>
}
