/**
 * Wire contract between the host half and the browser half.
 *
 * Both sides import these constants, so a route rename cannot drift. Keep this
 * module browser-safe (no `node:` imports).
 */
import { HYDRO_API_PREFIX } from './types.js'
import type { OperationResult, StatusWarning } from './types.js'

/** Exact HTTP routes served by the host half. */
export const ApiPaths = {
  /** GET -> ListAccountsResponse */
  accounts: `${HYDRO_API_PREFIX}/accounts`,
  /** POST CreateAccountRequest -> { account: AccountSummary } */
  accountCreate: `${HYDRO_API_PREFIX}/accounts/create`,
  /** POST { id, ...UpdateAccountRequest } -> { account } */
  accountUpdate: `${HYDRO_API_PREFIX}/accounts/update`,
  /** POST { id } -> { removed: boolean } */
  accountRemove: `${HYDRO_API_PREFIX}/accounts/remove`,
  /** POST { id } -> ActivateAccountResponse */
  accountActivate: `${HYDRO_API_PREFIX}/accounts/activate`,
  /** POST { id } -> TestConnectionResponse */
  accountTest: `${HYDRO_API_PREFIX}/accounts/test`,
  /** POST { id } -> StatusResponse (may be slow: SSH + network probes) */
  accountStatus: `${HYDRO_API_PREFIX}/accounts/status`,
  /** GET -> { version, dshVersion, features } */
  info: `${HYDRO_API_PREFIX}/info`,

  /* Host management (SSH + Hydro daemon) ---------------------------- */
  /** POST { id, judge?, noCaddy?, confirm: true } -> OperationResult */
  hostsInstall: `${HYDRO_API_PREFIX}/hosts/install`,
  /** POST { id, dryRun, includeJudge?, confirm: true when dryRun=false } -> HostUpgradeResponse */
  hostsUpgrade: `${HYDRO_API_PREFIX}/hosts/upgrade`,
  /** POST { id, target, action, confirm: true for mutating actions } -> HostServiceResponse */
  hostsService: `${HYDRO_API_PREFIX}/hosts/service`,
  /** POST { id } -> { warnings, collectedAt } */
  hostsWarnings: `${HYDRO_API_PREFIX}/hosts/warnings`,
  /** POST { id, action, collection?, filter?, limit?, source? } -> read-only Mongo/oplog payload */
  hostsData: `${HYDRO_API_PREFIX}/hosts/data`,

  /* Site management (Hydro web admin + problems/contests) -------- */
  /** GET -> { accounts: SiteAccountSummary[], activeSiteAccountId } */
  siteAccounts: `${HYDRO_API_PREFIX}/site/accounts`,
  /** POST { id?, hostId, label?, uname, domain?, role?, note?, readonly? } -> { account: SiteAccountSummary } */
  siteSave: `${HYDRO_API_PREFIX}/site/save`,
  /** POST { id } -> { removed: boolean } */
  siteRemove: `${HYDRO_API_PREFIX}/site/remove`,
  /** POST { id } -> { activeSiteAccountId } */
  siteActivate: `${HYDRO_API_PREFIX}/site/activate`,
  /** POST { siteAccountId } -> SiteInspectResponse */
  siteInspect: `${HYDRO_API_PREFIX}/site/inspect`,
  /** POST { siteAccountId, values, booleanKeys?, confirm: true } -> OperationResult */
  siteDomainSet: `${HYDRO_API_PREFIX}/site/domain/set`,
  /** POST { siteAccountId, filename, data(base64), hidden?, preferredPrefix? } -> { ok, message } */
  siteQuestionsImportZip: `${HYDRO_API_PREFIX}/site/questions/import-zip`,
  /** POST { siteAccountId } -> { domains: Array<{ id, name }> } */
  siteDomains: `${HYDRO_API_PREFIX}/site/domains`,
  /** POST { siteAccountId } -> SiteSessionStatus */
  siteSession: `${HYDRO_API_PREFIX}/site/session`,

  /* Community interaction (discussions) -------------------------------- */
  /** POST { } -> CommunityConfigResponse */
  communityStatus: `${HYDRO_API_PREFIX}/community/status`,
  /** POST { enabled, intervalMinutes, domain, siteAccountId } -> CommunityConfigResponse */
  communityConfig: `${HYDRO_API_PREFIX}/community/config`,
  /** POST { siteAccountId, domain?, limit? } -> CommunityFeedResponse */
  communityFeed: `${HYDRO_API_PREFIX}/community/feed`,
  /** POST { siteAccountId, did } -> CommunityThreadResponse */
  communityThread: `${HYDRO_API_PREFIX}/community/thread`,
  /** POST { siteAccountId, did, content, confirm:true } -> { ok, message } */
  communityReply: `${HYDRO_API_PREFIX}/community/reply`,
  /** POST { siteAccountId? } -> CommunityPollResponse */
  communityPoll: `${HYDRO_API_PREFIX}/community/poll`,
  /** POST { siteAccountId, collection: 'problem'|'contest', limit? } -> { documents, collection } */
  siteCollection: `${HYDRO_API_PREFIX}/site/collection`,
  /** POST { siteAccountId, kind, title?, requirements?, domain? } -> { prompt } */
  siteAuthoringPrompt: `${HYDRO_API_PREFIX}/site/authoring-prompt`,

  /* Streaming tasks + troubleshooting --------------------------------- */
  /** POST { id, judge?, noCaddy?, confirm: true } -> text/event-stream (output/result/error events) */
  hostsInstallStream: `${HYDRO_API_PREFIX}/hosts/install/stream`,
  /** POST { id, includeJudge?, confirm: true } -> text/event-stream (output/result/error events) */
  hostsUpgradeStream: `${HYDRO_API_PREFIX}/hosts/upgrade/stream`,
  /** POST { hostId, kind:'install'|'upgrade'|'issues', output, message? } -> { prompt } */
  hostsDiagnose: `${HYDRO_API_PREFIX}/hosts/diagnose`,
  /** POST { id } -> ServiceOverviewResponse (pm2 processes + health, no writes) */
  hostsServices: `${HYDRO_API_PREFIX}/hosts/services`,
  /** POST { id, process, lines? } -> ProcessLogsResponse (recent pm2 log tail) */
  hostsLogs: `${HYDRO_API_PREFIX}/hosts/logs`,
  /** POST { id } -> HostMetricsResponse (CPU/memory/disk/judge queue sample) */
  hostsMetrics: `${HYDRO_API_PREFIX}/hosts/metrics`,
  /** POST { id } -> HostIssuesResponse (known-issue diagnostics) */
  hostsIssues: `${HYDRO_API_PREFIX}/hosts/issues`,
  /** POST { id, fix, target?, confirm: true } -> OperationResult */
  hostsIssueFix: `${HYDRO_API_PREFIX}/hosts/issues/fix`,
  /** POST { id } -> PackageListResponse (yarn packages, node/go-judge/nix info) */
  hostsPackages: `${HYDRO_API_PREFIX}/hosts/packages`,
  /** POST { id, action, mirror?, package?, confirm: true } -> OperationResult (nix maintenance) */
  hostsNix: `${HYDRO_API_PREFIX}/hosts/nix`,
  /** POST { id } -> HostAddressResponse (browser-reachable Hydro URL; local Caddy proxy) */
  hostsAddress: `${HYDRO_API_PREFIX}/hosts/address`,
  /** POST { id, action, content?, confirm? } -> CaddyResponse | OperationResult */
  hostsCaddy: `${HYDRO_API_PREFIX}/hosts/caddy`,
  /** POST { id, action:'list' } -> PluginListResponse; { action:'install'|'uninstall'|'enable'|'disable', name, confirm:true } -> OperationResult */
  hostsPlugins: `${HYDRO_API_PREFIX}/hosts/plugins`,
  /** POST { id } -> BackupsResponse (backup zip files under /data) */
  hostsBackups: `${HYDRO_API_PREFIX}/hosts/backups`,
  /** POST { id, command, confirm? } -> text/event-stream (Hydro CLI output/result/error) */
  hostsCliStream: `${HYDRO_API_PREFIX}/hosts/cli/stream`,
  /** POST { id } -> { ok, message, log } from the official hydrooj diagnosis script */
  hostsDiagnosis: `${HYDRO_API_PREFIX}/hosts/diagnosis`,
  /** POST { id } -> EmbeddedContextResponse (what the embedded browser is viewing) */
  hostsContext: `${HYDRO_API_PREFIX}/hosts/context`,
  /** POST { id } -> HostDatabaseStatusResponse (Mongo installed/running) */
  hostsDatabase: `${HYDRO_API_PREFIX}/hosts/database`,
  /** POST { id, confirm:true } -> OperationResult (rejudge stale in-flight records) */
  hostsRejudge: `${HYDRO_API_PREFIX}/hosts/rejudge`,
  /** POST { id } -> JudgeConfigResponse; POST { id, action:'save', path, content, confirm } -> OperationResult; POST { id, action:'restart', confirm } */
  hostsJudge: `${HYDRO_API_PREFIX}/hosts/judge`,

  /* Operator settings -------------------------------------------------- */
  /** GET -> UiSettingsResponse */
  settings: `${HYDRO_API_PREFIX}/settings`,
  /** POST { readonly: boolean } -> UiSettingsResponse */
  settingsReadonly: `${HYDRO_API_PREFIX}/settings/readonly`,
} as const


/**
 * The document base URI when running in a browser; `undefined` elsewhere.
 * Reading it through `globalThis` keeps this module compilable in the Node half,
 * which has no DOM library.
 */
function pageBase(): string | undefined {
  const globalDocument = (globalThis as { document?: { baseURI?: string } }).document
  return globalDocument?.baseURI
}

/** Join a host API path against the page base, as the market does. */
export function apiUrl(path: string, base: string | undefined = pageBase()): string {
  const relative = path.replace(/^\/+/, '')
  if (base === undefined) return `/${relative}`
  try {
    return new URL(relative, base).pathname
  } catch {
    return `/${relative}`
  }
}

/** How much a Hydro web account may do (informational; Hydro enforces it). */
export type SiteRole = 'superadmin' | 'domain-admin' | 'problem-setter' | 'judge' | 'custom'

/** Login state of a browser-captured Hydro site session. */
export type SiteSessionState = 'missing' | 'unknown' | 'active' | 'expired'

/** Session validity state for one site account. */
export interface SiteSessionStatus {
  siteAccountId: string
  state: SiteSessionState
  capturedAt: string | null
  checkedAt: string | null
  message: string | null
}

/** One Hydro web admin account (site management), stored independently of SSH hosts. */
export interface SiteAccountSummary {
  /** Site-account id (independent of the host id). */
  id: string
  /** SSH host record this login belongs to. */
  hostId: string
  /** Host display label for grouping in the UI. */
  hostLabel: string
  label: string
  /** Hydro web admin username. */
  uname: string
  /** Default Hydro domain for site operations. */
  domain: string
  /** Operator-declared privilege level (Hydro itself enforces the real ACL). */
  role: SiteRole
  /** Optional free-form note, e.g. "only domain class1". */
  note: string | null
  /** Read-only switch for this site account. */
  readonly: boolean
  /** True when the embedded browser has captured a Hydro sid for this account. */
  hasSession: boolean
  /** Last known validity of the captured session. */
  sessionState: SiteSessionState
  /** When the current browser session cookie was captured. */
  sessionCapturedAt: string | null
  /** When session validity was last checked, if ever. */
  sessionCheckedAt: string | null
  lastUsedAt: string | null
}

/** Response of {@link ApiPaths.siteAccounts}. */
export interface SiteAccountsResponse {
  accounts: SiteAccountSummary[]
  activeSiteAccountId: string | null
}

/** Response of {@link ApiPaths.siteInspect}. */
export interface SiteInspectResponse {
  siteAccountId: string
  hostId: string
  warnings: StatusWarning[]
  domain: { current: Record<string, unknown>; settings: unknown }
  collectedAt: string
}

/** Response of {@link ApiPaths.hostsWarnings}. */
export interface HostWarningsResponse {
  hostId: string
  warnings: StatusWarning[]
  collectedAt: string
}

/** Standalone Hydro judge config editor payload. */
export interface JudgeConfigResponse {
  installed: boolean
  running: boolean
  path: string | null
  content: string
  manager: string
}

/** MongoDB install/running state for hiding unusable data editors. */
export interface HostDatabaseStatusResponse {
  installed: boolean
  running: boolean
  source: 'pm2' | 'config' | 'none'
}

/** Response of {@link ApiPaths.hostsData}. */
export interface HostDataResponse {
  action: 'collections' | 'find' | 'oplog'
  documents: unknown[]
  collection: string | null
  truncated: boolean
  note: string | null
  mongoOplog: unknown
}

/** Response of {@link ApiPaths.siteCollection}. */
export interface SiteCollectionResponse {
  collection: 'problem' | 'contest'
  documents: unknown[]
}

/** Response of {@link ApiPaths.siteAuthoringPrompt}. */
export interface AuthoringPromptResponse {
  prompt: string
}

/** One recent pm2 log tail. */
export interface ProcessLogsResponse {
  process: string
  manager: 'pm2' | 'systemd' | 'manual'
  stdout: string
  stderr: string
  truncated: boolean
}

/** Threshold alert attached to a metrics sample. */
export interface MetricAlert {
  severity: 'warning' | 'error'
  code: 'cpu' | 'memory' | 'disk' | 'queue' | 'load' | 'stale'
  value: number
}

/** One point-in-time host metrics sample for the overview charts. */
export interface HostMetricsResponse {
  collectedAt: string
  cpu: { usagePercent: number | null; load1: number | null; cores: number | null }
  memory: { totalBytes: number | null; usedBytes: number | null; usagePercent: number | null }
  disk: { mount: string; totalBytes: number | null; usedBytes: number | null; usagePercent: number | null }
  judge: {
    /** Pending judge tasks in Hydro's `task` collection (actual queue). */
    queueDepth: number | null
    /** Submissions created in the last hour (throughput). */
    submissionsLastHour: number | null
    /** Accepted submissions created in the last hour. */
    acceptedLastHour: number | null
    /** Pending records without a corresponding task (stale/abandoned). */
    staleRecords: number | null
  }
  alerts: MetricAlert[]
}

/** One known-issue diagnostic result. */
export interface HostIssue {
  severity: 'info' | 'warning' | 'error'
  code: string
  detail: string | null
  /** Safe one-click fix id, when the host can repair it. */
  fix: 'restart-service' | 'install-ui-plugin' | 'enable-default-langs' | null
  /** Service target for `restart-service`, when applicable. */
  fixTarget: 'hydro' | 'mongodb' | 'sandbox' | 'caddy' | 'judge' | null
}

/** Response of {@link ApiPaths.hostsIssues}. */
export interface HostIssuesResponse {
  collectedAt: string
  issues: HostIssue[]
}

/** One upgradeable package row. */
export interface PackageSummary {
  name: string
  kind: 'core' | 'plugin'
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

/** Response of {@link ApiPaths.hostsPackages}. */
export interface PackageListResponse {
  packages: PackageSummary[]
  node: { version: string | null; latest: string | null; managedByNix: boolean }
  goJudge: { version: string | null; managedByNix: boolean } | null
  nix: { substituters: string }
  collectedAt: string
}

/** Response of {@link ApiPaths.hostsAddress}. */
export interface HostAddressResponse {
  url: string | null
  /** Local SSH-tunnel Caddy proxy, configured `server.url`, detected URL, or null. */
  source: 'proxy' | 'server.url' | 'detected' | null
}

/** What page the loopback Caddy proxy most recently served for embedded browsing. */
export interface EmbeddedContextResponse {
  kind: 'problem' | 'contest' | 'domain' | 'problem-list' | 'contest-list' | null
  domain: string | null
  id: string | null
  /** Sub-page: view/edit/files/management/clarification/problems/… */
  page: string | null
  path: string | null
}

/** One Hydro addon/plugin row. */
export interface PluginSummary {
  name: string
  version: string | null
  enabled: boolean
}

/** Response of {@link ApiPaths.hostsPlugins} list action. */
export interface PluginListResponse {
  plugins: PluginSummary[]
  enabled: string[]
}

/** Caddy status / configuration editor payload. */
export interface CaddyResponse {
  installed: boolean
  running: boolean
  manager: 'pm2' | 'systemd' | 'manual'
  /** Caddyfile path when found. */
  path: string | null
  /** Caddyfile contents. */
  content: string
  version: string | null
}

/** One Hydro backup archive. */
export interface BackupFile {
  name: string
  path: string
  sizeBytes: number | null
  modifiedAt: string | null
}

/** Response of {@link ApiPaths.hostsBackups}. */
export interface BackupsResponse {
  backups: BackupFile[]
}

/** Response of {@link ApiPaths.siteQuestionsImportZip}. */
export interface QuestionZipImportResponse {
  ok: boolean
  message: string
}

/** Community polling configuration + state. */
export interface CommunityConfigResponse {
  enabled: boolean
  intervalMinutes: number
  domain: string
  siteAccountId: string | null
  replyPersona: string
  lastCheckedAt: string | null
  newActivity: number
  seenDids: Array<{ did: string; replyCount: number | null }>
}

/** One Hydro discussion summary. */
export interface CommunityDiscussion {
  did: string
  title: string
  content: string
  domain: string
  /** Discussion node/source, e.g. `global`. */
  node: string | null
  owner: number | null
  ownerName: string | null
  /** Browser path for the embedded proxy, e.g. `/d/system/discuss/...`. */
  url: string
  replyCount: number | null
  updatedAt: string | null
}

/** Response of {@link ApiPaths.communityFeed}. */
export interface CommunityFeedResponse {
  discussions: CommunityDiscussion[]
  newActivity: number
  lastCheckedAt: string | null
}

/** One discussion reply. */
export interface CommunityThreadReply {
  id: string
  content: string
  owner: number | null
  ownerName: string | null
  time: string | null
}

/** Response of {@link ApiPaths.communityThread}. */
export interface CommunityThreadResponse {
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

/** Response of {@link ApiPaths.communityPoll}. */
export interface CommunityPollResponse {
  newActivity: number
  discussions: CommunityDiscussion[]
  lastCheckedAt: string
}

/** Response of {@link ApiPaths.siteDomains}. */
export interface SiteDomainsResponse {
  domains: Array<{ id: string; name: string }>
}

/** One increment of streamed operation output (SSE `output` event). */
export interface HostStreamOutput {
  stream: 'stdout' | 'stderr'
  text: string
}

/** Server-sent event names used by the streaming install/upgrade routes. */

/** Response of {@link ApiPaths.hostsDiagnose}. */
export interface HostDiagnoseResponse {
  prompt: string
}

/** Global operator settings shared by the whole plugin. */
export interface UiSettingsResponse {
  readonlyMode: boolean
  updatedAt: string | null
}

/** One pm2 process as shown in the visual service monitor. */
export interface Pm2ProcessSummary {
  name: string
  status: string
  pid: number | null
  restarts: number | null
  uptimeMs: number | null
  cpuPercent: number | null
  memoryBytes: number | null
  execPath: string | null
  /** Known Hydro component this process maps to, or null for unrelated pm2 apps. */
  target: 'hydro' | 'mongodb' | 'sandbox' | 'caddy' | 'judge' | null
}

/** Response of {@link ApiPaths.hostsServices}. */
export interface ServiceOverviewResponse {
  manager: 'pm2' | 'systemd' | 'manual'
  collectedAt: string
  processes: Pm2ProcessSummary[]
  hydro: {
    installed: boolean
    version: string | null
    serviceName: string | null
    health: { ok: boolean; status: number | null; latencyMs: number | null }
  }
  sandbox: { running: boolean; version: string | null; address: string | null }
  judge: { installed: boolean; running: boolean; configPath: string | null }
}

/** Plan returned by the host upgrade dry-run. */
export interface HostUpgradePlan {
  targets: Array<{ name: string; version: string }>
  command: string
  current: Record<string, string | null>
}

/** Response of {@link ApiPaths.hostsUpgrade}. */
export interface HostUpgradeResponse {
  result: OperationResult
  plan: HostUpgradePlan | null
}

/** Response of {@link ApiPaths.hostsService} (mirror of the host-side action result). */
export interface HostServiceResponse {
  target: 'hydro' | 'mongodb' | 'sandbox' | 'caddy' | 'judge'
  manager: 'pm2' | 'systemd' | 'manual'
  action: 'start' | 'stop' | 'restart' | 'reload' | 'status'
  ok: boolean
  output: string
}

/** Response of {@link ApiPaths.siteSave}. */
export interface SiteSaveResponse {
  account: SiteAccountSummary
}

/** Response of {@link ApiPaths.siteActivate}. */
export interface SiteActivateResponse {
  activeSiteAccountId: string | null
}

/** Response shape of {@link ApiPaths.info}. */
export interface InfoResponse {
  name: string
  version: string
  features: {
    ssh: boolean
    install: boolean
    status: boolean
    mongo: boolean
    oplog: boolean
    wsWarnings: boolean
    problem: boolean
    contest: boolean
    readonlyMode: boolean
  }
}
