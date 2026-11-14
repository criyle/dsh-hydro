/**
 * Concrete {@link HydroOpsApi} implementation.
 *
 * It wires the account store, the SSH connection pool and the Hydro operation
 * modules together. Every public method resolves the account first, builds (or
 * reuses) an `AccountContext`, and only then touches the remote host.
 */
import type { Context } from '@deepseek-ai/cordis'

import type { AccountStore, AccountRecord } from '../accounts/store.js'
import { SiteAccountStore, type SiteRole } from '../accounts/site-store.js'
import { UiSettingsStore } from '../accounts/ui-settings.js'
import { serviceOverview as buildServiceOverview } from '../hydro/service.js'
import { collectMetrics, collectIssues } from '../hydro/metrics.js'
import { readProcessLogs } from '../hydro/logs.js'
import { collectHydroAddress } from '../hydro/address.js'
import { collectPackages } from '../hydro/packages.js'
import { nixMaintenance as runNixMaintenance, type NixAction } from '../hydro/nix.js'
import { applyIssueFix, type IssueFix } from '../hydro/fixes.js'
import { applyCaddy, readCaddy, writeCaddy } from '../hydro/caddy.js'
import { listPlugins, managePlugin, type PluginAction } from '../hydro/plugins.js'
import { listBackups, restoreBackup, runHydroCli, runHydroDiagnosis } from '../hydro/cli.js'
import { readJudgeConfig, restartJudge, writeJudgeConfig } from '../hydro/judge-config.js'
import { rejudgeStaleRecords } from '../hydro/judge.js'
import { HydroProxyManager } from './proxy.js'
import type { Config } from '../config.js'
import {
  collectHydroStatus,
  detectRole,
  fetchLatestVersions,
  installHydro,
  locateHydro,
  probeHydro,
  queryDatabase,
  queryOplog,
  listCollections,
  serviceAction,
  upgradeHydro,
  type HydroProbe,
} from '../hydro/index.js'
import type { SiteAccountSummary } from '../shared/api.js'
import type {
  AccountSummary,
  HydroLocation,
  HydroStatus,
  MongoState,
  OperationResult,
  ServiceManager,
} from '../shared/types.js'
import type { AccountContext, MongoQuerySpec, OplogQuerySpec, OplogResult, ServiceActionResult, StatusOptions } from './types.js'
import type { AddAccountInput, HydroOpsApi, UpdateAccountInput } from './hydro-ops.js'
import { ConnectionPool } from '../service/connection.js'
import { closeTunnels } from './tunnel.js'

/** Minimal logging surface so the class does not depend on Cordis' Logger type. */
export interface OpsLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
}

export interface HydroOpsOptions {
  ctx: Context
  config: Config
  store: AccountStore
  knownHostsPath: string
  logger?: OpsLogger
  /** Injectable for tests. */
  pool?: ConnectionPool
  /** Injectable site-account store (defaults to one under the same dataDir). */
  siteStore?: SiteAccountStore
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Clamp a requested status option bag against the configured defaults. */
export function statusOptions(config: Config, overrides: Partial<StatusOptions> = {}): StatusOptions {
  return {
    includeMongo: config.status.includeMongo,
    includeOplog: config.status.includeOplog,
    includeWsWarnings: config.status.includeWsWarnings,
    includeLatestVersions: config.status.includeLatestVersions,
    timeoutMs: config.status.timeoutMs,
    ...overrides,
  }
}

export class HydroOps implements HydroOpsApi {
  readonly config: Config
  private readonly store: AccountStore
  private readonly pool: ConnectionPool
  private readonly siteStore: SiteAccountStore
  private readonly uiSettings: UiSettingsStore
  private readonly proxy = new HydroProxyManager()
  private readonly logger: OpsLogger
  private readonly contexts = new Map<string, AccountContext>()
  private readonly statusInflight = new Map<string, Promise<HydroStatus>>()
  private readonly probes = new Map<string, { at: number; probe: HydroProbe }>()
  private disposed = false
  private readonly readyPromise: Promise<void>

  constructor(options: HydroOpsOptions) {
    this.config = options.config
    this.store = options.store
    this.logger = options.logger ?? {
      debug: (message) => options.ctx.logger.debug(message),
      info: (message) => options.ctx.logger.info(message),
      warn: (message) => options.ctx.logger.warn(message),
    }
    this.pool =
      options.pool ??
      new ConnectionPool(this.store, {
        knownHostsPath: options.knownHostsPath,
        hostKeyPolicy: this.config.hostKeyPolicy,
        connectTimeoutMs: this.config.connectTimeoutMs,
      })
    const store = options.store
    const siteStore = options.siteStore ?? new SiteAccountStore({ dataDir: store.dataDir })
    const uiSettings = new UiSettingsStore({ dataDir: store.dataDir })
    this.siteStore = siteStore
    this.uiSettings = uiSettings
    this.readyPromise = (async () => {
      await store.load()
      await siteStore.load()
      await uiSettings.load()
    })()
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  isGloballyReadonly(): boolean {
    return this.readonlyFlag(this.config.readonlyMode) || this.uiSettings.isReadonly()
  }

  getUiSettings(): { readonlyMode: boolean; updatedAt: string | null } {
    return this.uiSettings.get()
  }

  async setGlobalReadonly(readonly: boolean): Promise<{ readonlyMode: boolean; updatedAt: string | null }> {
    await this.ready()
    return this.uiSettings.setReadonly(readonly)
  }

  async serviceOverview(accountId: string | undefined): Promise<import('../hydro/service.js').ServiceOverview> {
    return this.withContext(accountId, async (context) => buildServiceOverview(context))
  }

  async rejudgeStale(accountId: string | undefined): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => rejudgeStaleRecords(this, context))
  }

  async readJudgeConfig(accountId: string | undefined): Promise<import('../shared/api.js').JudgeConfigResponse> {
    return this.withContext(accountId, async (context) => readJudgeConfig(context))
  }

  async writeJudgeConfig(accountId: string | undefined, input: { path: string; content: string }): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => writeJudgeConfig(context, input))
  }

  async restartJudge(accountId: string | undefined): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => restartJudge(context))
  }

  async databaseStatus(accountId: string | undefined): Promise<import('../shared/api.js').HostDatabaseStatusResponse> {
    return this.withContext(accountId, async (context) => {
      const probe = await probeHydro(context)
      const process = probe.pm2.find((entry) => entry.name.toLowerCase().includes('mongodb') || entry.name.toLowerCase() === 'mongod')
      const fromConfig = probe.components.mongo
      return {
        installed: fromConfig,
        running: process?.status === 'online' || process?.status === 'running',
        source: process !== undefined ? 'pm2' : fromConfig ? 'config' : 'none',
      }
    })
  }

  async diagnosis(accountId: string | undefined): Promise<{ ok: boolean; message: string; log: string }> {
    return this.withContext(accountId, async (context) => runHydroDiagnosis(context))
  }

  async processLogs(accountId: string | undefined, input: { process: string; lines?: number }): Promise<import('../shared/api.js').ProcessLogsResponse> {
    return this.withContext(accountId, async (context) => readProcessLogs(context, input))
  }

  async metrics(accountId: string | undefined): Promise<import('../shared/api.js').HostMetricsResponse> {
    return this.withContext(accountId, async (context) => collectMetrics(context))
  }

  async issues(accountId: string | undefined): Promise<import('../shared/api.js').HostIssuesResponse> {
    return this.withContext(accountId, async (context) => collectIssues(context))
  }

  async fixIssue(accountId: string | undefined, action: IssueFix): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => applyIssueFix(context, action))
  }

  async address(accountId: string | undefined): Promise<import('../shared/api.js').HostAddressResponse> {
    return this.withContext(accountId, async (context) => {
      const probe = await this.probe(context)
      const direct = await collectHydroAddress(context, probe)
      const caddy = probe.pm2.find((process) => process.name.toLowerCase().includes('caddy')
        && (process.status === 'online' || process.status === 'running'))
      if (caddy === undefined) return direct
      try {
        const activeSiteAccount = this.siteStore.activeForHost(context.account.id)
        const proxied = await this.proxy.ensure(context.account.id, context, {
          remotePort: 80,
          upstreamUrl: direct.url,
          captureSession: activeSiteAccount === undefined
            ? null
            : (sid) => { void this.siteStore.setSessionToken(activeSiteAccount.id, sid) },
          seedSid: activeSiteAccount === undefined
            ? null
            : this.siteStore.getSessionToken(activeSiteAccount.id) ?? null,
        })
        return { url: proxied.url, source: 'proxy' as const }
      } catch {
        return direct
      }
    })
  }

  embeddedContext(accountId: string | undefined): import('../shared/api.js').EmbeddedContextResponse | null {
    const id = this.resolveAccountId(accountId)
    const context = this.proxy.context(id)
    if (context === null) return { kind: null, domain: null, id: null, page: null, path: null }
    return { kind: context.kind, domain: context.domain, id: context.id, page: context.page, path: context.path }
  }

  async listPlugins(accountId: string | undefined): Promise<import('../shared/api.js').PluginListResponse> {
    return this.withContext(accountId, async (context) => listPlugins(context))
  }

  async managePlugin(accountId: string | undefined, input: { action: PluginAction; name: string }): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => managePlugin(context, input))
  }

  async readCaddy(accountId: string | undefined): Promise<import('../shared/api.js').CaddyResponse> {
    return this.withContext(accountId, async (context) => readCaddy(context))
  }

  async writeCaddy(accountId: string | undefined, input: { path: string; content: string; reload: boolean }): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => writeCaddy(context, input))
  }

  async applyCaddy(accountId: string | undefined, action: 'validate' | 'reload'): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => applyCaddy(context, action))
  }

  async runCli(accountId: string | undefined, command: string, onOutput?: import('../hydro/remote.js').OutputSink): Promise<{ exitCode: number | null; output: string }> {
    return this.withContext(accountId, async (context) => runHydroCli(context, command, onOutput))
  }

  async restoreBackup(accountId: string | undefined, filename: string, onOutput?: import('../hydro/remote.js').OutputSink): Promise<{ exitCode: number | null; output: string }> {
    return this.withContext(accountId, async (context) => restoreBackup(context, filename, onOutput))
  }

  async listBackups(accountId: string | undefined): Promise<import('../shared/api.js').BackupsResponse> {
    return this.withContext(accountId, async (context) => listBackups(context))
  }

  async packages(accountId: string | undefined): Promise<import('../shared/api.js').PackageListResponse> {
    return this.withContext(accountId, async (context) => collectPackages(context))
  }

  async nixMaintenance(accountId: string | undefined, action: NixAction): Promise<OperationResult> {
    return this.withContext(accountId, async (context) => runNixMaintenance(context, action))
  }

  /* ------------------------------------------------------------------ */
  /* Accounts                                                            */
  /* ------------------------------------------------------------------ */

  listAccounts(): AccountSummary[] {
    return this.store.list().map((record) => this.store.toSummary(record))
  }

  activeAccountId(): string | null {
    return this.store.activeAccountId()
  }

  getAccountSummary(accountId: string): AccountSummary | undefined {
    const record = this.store.get(accountId)
    return record === undefined ? undefined : this.store.toSummary(record)
  }

  resolveAccountId(accountId?: string): string {
    const id = accountId?.trim()
    if (id !== undefined && id !== '') {
      if (this.store.get(id) === undefined) throw new Error(`dsh-hydro: 未知账号 ${id}`)
      return id
    }
    const active = this.store.activeAccountId()
    if (active === null) throw new Error('dsh-hydro: 还没有配置任何账号，请先用 hydro_accounts 添加一个远端')
    return active
  }

  async addAccount(input: AddAccountInput, onLog?: (line: string) => void): Promise<AccountSummary> {
    await this.ready()
    const record = await this.store.create({
      label: input.label,
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      privateKey: input.privateKey,
      managedKey: input.installManagedKey ?? input.authMethod === 'password',
      role: input.role ?? 'user',
      readonly: input.readonly ?? this.config.defaultReadonly,
    })
    // Password auth exists only for this one bootstrap. The password is used
    // in memory to install the managed key and passwordless sudo, then dropped.
    if (input.authMethod === 'password') {
      try {
        await this.pool.bootstrapManagedKey(record, input.password, onLog)
      } catch (error) {
        await this.store.remove(record.id)
        throw new Error(`安装密钥/免密 sudo 失败，账号未保存：${errorMessage(error)}`)
      }
    }
    this.invalidate(record.id)
    // Probe immediately after adding instead of trusting a previously cached
    // `hydro` field: the host may already have Hydro installed (or may not).
    onLog?.('[探测] 检查远端是否已安装 Hydro…')
    try {
      await this.testAccount(record.id)
      onLog?.('[探测] 完成')
    } catch {
      onLog?.('[探测] 失败：可稍后在主机管理中重试')
    }
    return this.store.toSummary(this.store.get(record.id) ?? record)
  }

  async updateAccount(accountId: string, input: UpdateAccountInput): Promise<AccountSummary> {
    const record = this.store.get(accountId)
    if (record === undefined) throw new Error(`dsh-hydro: 未知账号 ${accountId}`)
    await this.store.update(accountId, {
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.host === undefined ? {} : { host: input.host }),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.readonly === undefined ? {} : { readonly: input.readonly }),
    })
    this.invalidate(accountId)
    return this.store.toSummary(this.store.get(accountId)!)
  }

  async removeAccount(accountId: string): Promise<boolean> {
    await this.ready()
    // A removed host cannot keep orphan site accounts.
    for (const account of this.siteStore.list(accountId)) {
      await this.siteStore.remove(account.id).catch(() => undefined)
    }
    this.invalidate(accountId)
    return this.store.remove(accountId)
  }

  async setActiveAccount(accountId: string | null): Promise<void> {
    await this.store.setActive(accountId)
  }

  async testAccount(accountId: string): Promise<{
    ok: boolean
    latencyMs: number | null
    message: string
    role: 'root' | 'sudo' | 'user' | null
    hostname: string | null
    node: string | null
    hydro: HydroLocation | null
  }> {
    const started = Date.now()
    try {
      const record = this.store.get(accountId)
      if (record === undefined) throw new Error(`dsh-hydro: 未知账号 ${accountId}`)
      const connection = await this.pool.acquire(record)
      const [idResult, sudoResult, hostnameResult, nodeResult] = await Promise.all([
        connection.exec('id -u'),
        connection.exec('command -v sudo >/dev/null 2>&1 && echo yes || echo no'),
        connection.exec('hostname'),
        connection.exec('node -v 2>/dev/null || echo ""'),
      ])
      const role = detectRole(idResult.stdout, sudoResult.stdout)
      const context = await this.contextFor(record)
      const probe = await probeHydro(context)
      this.probes.set(record.id, { at: Date.now(), probe })
      await this.store.update(record.id, {
        lastConnectedAt: new Date().toISOString(),
        hydro: locateHydro(probe),
        ...(role === 'user' ? {} : { role }),
      })
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `连接成功（${role === 'root' ? 'root' : role === 'sudo' ? 'sudo' : '普通用户'}）`,
        role,
        hostname: hostnameResult.stdout.trim() || null,
        node: nodeResult.stdout.trim() || null,
        hydro: locateHydro(probe),
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: errorMessage(error),
        role: null,
        hostname: null,
        node: null,
        hydro: null,
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Context plumbing                                                    */
  /* ------------------------------------------------------------------ */

  async withContext<T>(
    accountId: string | undefined,
    fn: (context: AccountContext) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const id = this.resolveAccountId(accountId)
    const context = await this.contextForById(id, options.signal)
    // The global read-only switch can flip while a connection context is
    // cached; refresh the effective flag for every operation.
    context.readonly = this.readonlyFor(context.account)
    const result = await fn(context)
    return result
  }

  assertWritable(context: AccountContext, action: string): void {
    if (!context.readonly) return
    throw new Error(
      `dsh-hydro: 当前为全局只读模式，拒绝执行「${action}」。请先在控制台右上角关闭只读开关。`,
    )
  }

  async withWritableContext<T>(
    accountId: string | undefined,
    action: string,
    fn: (context: AccountContext) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.withContext(
      accountId,
      async (context) => {
        this.assertWritable(context, action)
        return fn(context)
      },
      options,
    )
  }

  async hydroPort(context: AccountContext): Promise<number> {
    const configured = this.config.hydro.port
    if (configured > 0) return configured
    const probe = await this.probe(context)
    return probe.ports.hydro ?? 8888
  }

  async getSiteSession(accountId: string, siteAccountId?: string): Promise<{
    uname: string | null
    sid: string | null
    domain: string | null
    siteAccountId: string | null
  }> {
    await this.ready()
    const record = this.store.get(accountId)
    if (record === undefined) throw new Error(`dsh-hydro: 未知账号 ${accountId}`)
    const chosen = siteAccountId === undefined
      ? this.siteStore.activeForHost(accountId)
      : this.siteStore.get(siteAccountId)
    if (chosen !== undefined) {
      if (chosen.hostId !== accountId) throw new Error(`站点账号 ${chosen.id} 不属于主机 ${accountId}`)
      return {
        uname: chosen.uname,
        sid: this.siteStore.getSessionToken(chosen.id) ?? null,
        domain: chosen.domain,
        siteAccountId: chosen.id,
      }
    }
    return { uname: null, sid: null, domain: null, siteAccountId: null }
  }

  /* ------------------------------------------------------------------ */
  /* Site accounts                                                    */
  /* ------------------------------------------------------------------ */

  listSiteAccounts(hostId?: string): SiteAccountSummary[] {
    return this.siteStore.list(hostId).map((record) => {
      const host = this.store.get(record.hostId)
      return this.siteStore.toSummary(record, host?.label)
    })
  }

  getSiteAccountSummary(id: string): SiteAccountSummary | undefined {
    const record = this.siteStore.get(id)
    if (record === undefined) return undefined
    return this.siteStore.toSummary(record, this.store.get(record.hostId)?.label)
  }

  activeSiteAccountId(): string | null {
    return this.siteStore.activeSiteAccountId()
  }

  async setSiteSessionState(siteAccountId: string, state: 'missing' | 'unknown' | 'active' | 'expired'): Promise<void> {
    await this.siteStore.setSessionState(siteAccountId, state)
  }

  async addSiteAccount(input: {
    hostId: string
    label?: string
    uname: string
    domain?: string
    role?: SiteRole
    note?: string
    readonly?: boolean
  }): Promise<SiteAccountSummary> {
    await this.ready()
    if (this.store.get(input.hostId) === undefined) throw new Error(`未知主机 ${input.hostId}`)
    const record = await this.siteStore.create(input)
    return this.siteStore.toSummary(record, this.store.get(input.hostId)?.label)
  }

  async updateSiteAccount(id: string, input: {
    label?: string
    uname?: string
    domain?: string
    role?: SiteRole
    note?: string
    readonly?: boolean
  }): Promise<SiteAccountSummary> {
    await this.ready()
    const record = await this.siteStore.update(id, input)
    return this.siteStore.toSummary(record, this.store.get(record.hostId)?.label)
  }

  async removeSiteAccount(id: string): Promise<boolean> {
    await this.ready()
    return this.siteStore.remove(id)
  }

  async setActiveSiteAccount(id: string | null): Promise<void> {
    await this.ready()
    await this.siteStore.setActive(id)
  }

  async getSiteCredentials(id: string): Promise<{ id: string; hostId: string; uname: string; sid: string; domain: string }> {
    await this.ready()
    const record = this.siteStore.get(id)
    if (record === undefined) throw new Error(`未知站点账号 ${id}`)
    const sid = this.siteStore.getSessionToken(id)
    if (sid === undefined) throw new Error(`站点账号 ${record.label} 还没有登录：请在内嵌浏览器中登录 Hydro`)
    return {
      id,
      hostId: record.hostId,
      uname: record.uname,
      sid,
      domain: record.domain ?? 'system',
    }
  }

  /** Capture a sid cookie from the embedded browser for the active account. */
  async captureSiteSession(hostId: string, sid: string): Promise<void> {
    const account = this.siteStore.activeForHost(hostId)
    if (account === undefined) return
    await this.siteStore.setSessionToken(account.id, sid)
  }

  /* ------------------------------------------------------------------ */
  /* Status / service                                                    */
  /* ------------------------------------------------------------------ */

  async collectStatus(accountId: string | undefined, overrides: Partial<StatusOptions> = {}): Promise<HydroStatus> {
    const id = this.resolveAccountId(accountId)
    // The browser half polls status when the account changes; a second caller
    // for the same account joins the in-flight probe instead of opening another
    // SSH+tunnel+Mongo round trip.
    const inflight = this.statusInflight.get(id)
    if (inflight !== undefined) return inflight
    const options = statusOptions(this.config, overrides)
    const task = this.withContext(id, async (context) => {
      const status = await collectHydroStatus(context, options)
      await this.store.update(id, {
        lastStatusAt: status.collectedAt,
        ...(status.hydro.installed ? { hydro: this.locationFromStatus(status, context) } : {}),
      })
      return status
    }).finally(() => {
      this.statusInflight.delete(id)
    })
    this.statusInflight.set(id, task)
    return task
  }

  async quickProbe(accountId: string | undefined): Promise<HydroStatus> {
    return this.collectStatus(accountId, {
      includeMongo: false,
      includeOplog: false,
      includeWsWarnings: false,
      includeLatestVersions: false,
    })
  }

  async latestVersions(names: string[]): Promise<Record<string, string | null>> {
    return fetchLatestVersions(names, this.config.npmRegistry)
  }

  async install(accountId: string | undefined, options: { judge?: boolean; noCaddy?: boolean; onOutput?: import('../hydro/remote.js').OutputSink } = {}): Promise<OperationResult> {
    return this.withWritableContext(accountId, '安装 Hydro', async (context) => {
      const result = await installHydro(context, options)
      if (result.ok) this.invalidate(context.account.id)
      return result
    })
  }

  async upgrade(accountId: string | undefined, options: { dryRun?: boolean; includeJudge?: boolean; packages?: string[]; onOutput?: import('../hydro/remote.js').OutputSink } = {}): Promise<OperationResult> {
    if (options.dryRun === true) {
      return this.withContext(accountId, async (context) => {
        const probe = await probeHydro(context)
        const { planUpgrade } = await import('../hydro/index.js')
        const plan = (await planUpgrade(context, probe)) as { targets: Array<{ name: string; version: string }>; command: string }
        return {
          ok: true,
          message:
            plan.targets.length === 0
              ? '所有组件已是可获取的最新版本，无需升级'
              : `将升级 ${String(plan.targets.length)} 个包：${plan.targets.map((target) => `${target.name}@${target.version}`).join(', ')}`,
          details: plan,
          log: plan.command,
        }
      })
    }
    return this.withWritableContext(accountId, '升级 Hydro', async (context) => {
      const result = await upgradeHydro(context, options)
      if (result.ok) this.invalidate(context.account.id)
      return result
    })
  }

  async serviceAction(
    accountId: string | undefined,
    target: ServiceActionResult['target'],
    action: ServiceActionResult['action'],
  ): Promise<ServiceActionResult> {
    const mutating = action !== 'status'
    const runner = mutating
      ? (id: string | undefined, _action: string, fn: (context: AccountContext) => Promise<ServiceActionResult>) =>
          this.withWritableContext(id, `${target} ${action}`, fn)
      : (id: string | undefined, _action: string, fn: (context: AccountContext) => Promise<ServiceActionResult>) => this.withContext(id, fn)
    return runner(accountId, action, async (context) => serviceAction(context, target, action))
  }

  /* ------------------------------------------------------------------ */
  /* Mongo                                                               */
  /* ------------------------------------------------------------------ */

  async inspectMongo(accountId: string | undefined): Promise<MongoState> {
    return this.withContext(accountId, async (context) => {
      const { inspectMongo } = await import('../hydro/index.js')
      return inspectMongo(context)
    })
  }

  async queryDatabase(
    accountId: string | undefined,
    spec: MongoQuerySpec,
  ): Promise<{ documents: unknown[]; truncated: boolean; collection: string }> {
    return this.withContext(accountId, async (context) => queryDatabase(context, spec))
  }

  async listCollections(
    accountId: string | undefined,
  ): Promise<Array<{ name: string; count: number | null; sizeBytes: number | null }>> {
    return this.withContext(accountId, async (context) => listCollections(context))
  }

  async queryOplog(accountId: string | undefined, spec: OplogQuerySpec): Promise<OplogResult> {
    return this.withContext(accountId, async (context) => queryOplog(context, spec))
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.statusInflight.clear()
    await this.proxy.dispose().catch(() => undefined)
    await Promise.all([...this.contexts.values()].map((context) => closeTunnels(context).catch(() => undefined)))
    this.contexts.clear()
    this.probes.clear()
    await this.pool.closeAll()
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private async contextForById(accountId: string, signal?: AbortSignal): Promise<AccountContext> {
    const record = this.store.get(accountId)
    if (record === undefined) throw new Error(`dsh-hydro: 未知账号 ${accountId}`)
    return this.contextFor(record, signal)
  }

  private async contextFor(record: AccountRecord, signal?: AbortSignal): Promise<AccountContext> {
    const cached = this.contexts.get(record.id)
    if (cached !== undefined && !cached.connection.closed) {
      const updated = this.store.get(record.id)
      return {
        ...cached,
        ...(updated === undefined ? {} : { account: updated }),
        ...(signal === undefined ? {} : { signal }),
      }
    }
    const connection = await this.pool.acquire(record)
    const context: AccountContext = {
      account: this.store.get(record.id) ?? record,
      config: this.config,
      connection,
      readonly: this.readonlyFor(record),
      dataDir: this.store.dataDir,
      log: (message) => this.logger.debug(`[dsh-hydro] ${message}`),
      elevationPassword: () => undefined,
      hydroSession: () => {
        const active = this.siteStore.activeForHost(record.id)
        const sid = active === undefined ? undefined : this.siteStore.getSessionToken(active.id)
        return sid === undefined ? undefined : { sid, uname: active?.uname ?? null }
      },
      ...(signal === undefined ? {} : { signal }),
    }
    this.contexts.set(record.id, context)
    this.probes.delete(record.id)
    return context
  }

  private readonlyFor(record: AccountRecord): boolean {
    return this.isGloballyReadonly() || record.readonly
  }

  private readonlyFlag(value: unknown): boolean {
    if (value !== null && typeof value === 'object' && typeof (value as { get?: () => boolean }).get === 'function') {
      return Boolean((value as { get: () => boolean }).get())
    }
    return Boolean(value)
  }

  private async probe(context: AccountContext): Promise<HydroProbe> {
    const cached = this.probes.get(context.account.id)
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.probe
    const probe = await probeHydro(context)
    this.probes.set(context.account.id, { at: Date.now(), probe })
    return probe
  }

  private locationFromStatus(status: HydroStatus, context: AccountContext): HydroLocation {
    return {
      installed: status.hydro.installed,
      installMode: status.installMode,
      installDir: status.hydro.installDir,
      serviceManager: (status.hydro.service?.manager ?? 'unknown') as ServiceManager,
      serviceName: status.hydro.service?.name ?? this.config.hydro.serviceName,
      port: context.config.hydro.port > 0 ? context.config.hydro.port : null,
      domain: null,
      version: status.hydro.version,
    }
  }

  private invalidate(accountId: string): void {
    void this.proxy.close(accountId).catch(() => undefined)
    this.probes.delete(accountId)
    const context = this.contexts.get(accountId)
    this.contexts.delete(accountId)
    if (context !== undefined) {
      void closeTunnels(context).catch(() => undefined)
      void this.pool.drop(accountId).catch(() => undefined)
    }
  }
}
