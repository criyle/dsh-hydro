/**
 * Browser-side HTTP client for the dsh-hydro Host routes.
 *
 * Route constants and DTOs come from `src/shared` so a rename cannot drift; the
 * request helper only adds the wire conventions the Host expects:
 *
 * - same-origin URL resolved against `document.baseURI` (`apiUrl`), so a Web GUI
 *   mounted under an app-directory prefix keeps that prefix;
 * - `credentials: 'same-origin'` so the DSH browser-session cookie is sent and
 *   no token ever has to be plumbed through plugin code;
 * - `cache: 'no-store'` because every payload is live status;
 * - JSON in/out, with the error body decoded from either shape the Host side
 *   may send (nested `{ error: { code, message } }` or the flat
 *   `ApiErrorBody` from `src/shared/types.ts`).
 *
 * The install/upgrade operations additionally support a POST + SSE transport
 * (`POST` a JSON body, receive `text/event-stream`) so the terminal card can
 * show live output. `streamHostOperation` throws {@link StreamUnavailableError}
 * when the Host has no stream route (non-2xx / non-SSE / no body); callers fall
 * back to the plain JSON routes in that case.
 *
 * The Host routes must run the Host's own admission check
 * (`ctx.connection.requestRejection`) because these prefix routes bypass the
 * `/api` trust fence; see `docs/research/client-api.md` §5.4.
 */
import { apiUrl, ApiPaths } from '../shared/api.js'
import type {
  AuthoringPromptResponse,
  SiteAccountsResponse,
  SiteActivateResponse,
  SiteCollectionResponse,
  SiteDomainsResponse,
  SiteInspectResponse,
  SiteRole,
  SiteSaveResponse,
  SiteSessionStatus,
  BackupsResponse,
  CaddyResponse,
  CommunityConfigResponse,
  CommunityFeedResponse,
  CommunityPollResponse,
  CommunityThreadResponse,
  EmbeddedContextResponse,
  HostAddressResponse,
  HostDataResponse,
  HostDiagnoseResponse,
  HostIssuesResponse,
  HostMetricsResponse,
  HostServiceResponse,
  HostStreamOutput,
  HostUpgradeResponse,
  HostWarningsResponse,
  HostUpgradePlan,
  InfoResponse,
  PackageListResponse,
  PluginListResponse,
  ProcessLogsResponse,
  QuestionZipImportResponse,
  ServiceOverviewResponse,
  UiSettingsResponse,
} from '../shared/api.js'
import type { TranslateFn } from './locales.js'
import type {
  AccountId,
  AccountSummary,
  ActivateAccountResponse,
  CreateAccountRequest,
  HydroStatus,
  ListAccountsResponse,
  OperationResult,
  StatusResponse,
  TestConnectionResponse,
  UpdateAccountRequest,
} from '../shared/types.js'

/**
 * `POST {prefix}/accounts/create` payload.
 *
 * `CreateAccountRequest` carries the fields both halves agreed on. The Host
 * additionally needs the sudo/Hydro admin credentials the add-account form
 * collects; sending them is an extension of the shared request type (reported
 * to the Lead instead of editing `src/shared`). A Host that does not read them
 * simply ignores the extra members.
 */
export type CreateAccountPayload = CreateAccountRequest

/** `POST {prefix}/accounts/update` payload. */
export interface UpdateAccountPayload extends UpdateAccountRequest {
  /** Account to update. */
  id: AccountId
  /** Mark the account read-only (read tools only) or clear that flag. */
  readonly?: boolean
}

/** Response of create/update: the refreshed secret-free account projection. */
export interface AccountMutationResponse {
  account: AccountSummary
  /** Bootstrap step log (key install / passwordless sudo), no secrets. */
  log?: string[]
}

/** Response of remove. */
export interface RemoveAccountResponse {
  removed: boolean
}

/* ------------------------------------------------------------------ */
/* Host operations                                                     */
/* ------------------------------------------------------------------ */

/** Targets accepted by `POST hosts/service` (route validates this list). */
export type ServiceTarget = HostServiceResponse['target']

/** Actions accepted by `POST hosts/service`. */
export type ServiceAction = HostServiceResponse['action']

/** Response of `POST hosts/service`. */
export type ServiceActionResult = HostServiceResponse

/** Dry-run upgrade plan (shared DTO). */
export type UpgradePlan = HostUpgradePlan

/** Response of `POST hosts/upgrade`: the operation result plus its plan. */
export type UpgradeResponse = HostUpgradeResponse

/** Request body of `POST hosts/install`. */
export interface InstallHostRequest {
  id: AccountId
  judge?: boolean
  noCaddy?: boolean
  force?: boolean
  confirm: true
}

/** Request body of `POST hosts/data` (read-only Mongo/oplog access). */
export interface HostDataRequest {
  action: 'collections' | 'find' | 'oplog'
  collection?: string
  filter?: Record<string, unknown>
  limit?: number
  source?: 'auto' | 'hydro' | 'mongo'
  /** Oplog only: exact/prefix audit-log type, e.g. `problem.edit`. */
  type?: string
  /** Oplog only: substring match on the audit-log message. */
  contains?: string
}

/** `POST hosts/diagnose` payload. */
export interface DiagnosePayload {
  /** SSH host record id. */
  hostId: AccountId
  /** Which operation failed (troubleshooting sends `issues`). */
  kind: 'install' | 'upgrade' | 'issues'
  /** Terminal output tail (the host bounds it further). */
  output: string
  /** Final result/error message, when there is one. */
  message?: string
}

/* ------------------------------------------------------------------ */
/* Site operations                                                  */
/* ------------------------------------------------------------------ */

/** `POST site/save` payload (no `id` = create, `id` = edit). */
export interface SiteSavePayload {
  /** Site-account id; present when editing. */
  id?: string
  /** SSH host record id (required for create). */
  hostId: string
  label?: string
  uname?: string
  domain?: string
  role?: SiteRole
  note?: string
  readonly?: boolean
}

/** Response of `POST site/remove`. */
export interface SiteRemoveResponse {
  removed: boolean
}

/** `POST site/domain/set` payload. */
export interface DomainSetPayload {
  siteAccountId: string
  values: Record<string, string | number | boolean>
  booleanKeys?: Record<string, boolean>
  /** The Host route requires confirm=true for this mutation. */
  confirm: true
}

/** Response of `POST site/domain/set`. */
export interface DomainSetResponse {
  ok: boolean
  message: string
}

/** `POST site/authoring-prompt` payload. */
export interface AuthoringPromptPayload {
  siteAccountId: string
  kind: 'problem' | 'contest' | 'domain-bulletin' | 'domain-permissions' | 'discussion-reply'
  title?: string
  requirements?: string
  domain?: string
  /** Problem targeted by the prompt (context-aware AI actions). */
  problemId?: string
  /** Contest targeted by the prompt (context-aware AI actions). */
  contestId?: string
  /** Stable action key for the prompt builder, e.g. `edit-statement`. */
  action?: string
  /** Hydro discussion targeted by an AI reply prompt. */
  discussionId?: string
}

/** A failed Host call: HTTP status plus the Host's stable error code. */
export class ApiRequestError extends Error {
  /**
   * @param status - HTTP status of the failed response.
   * @param code - Host error code when the body carried one.
   * @param message - human-readable Host message.
   */
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

/**
 * The Host did not serve the streaming variant of an operation.
 *
 * Callers treat this as "use the plain JSON route instead"; it must never be
 * shown as the operation's own failure. It is thrown for a non-2xx response, a
 * missing response body, a non-SSE content type, or a fetch-level failure
 * before any stream was established.
 */
export class StreamUnavailableError extends ApiRequestError {
  constructor(status: number, code: string | undefined, message: string) {
    super(status, code, message)
    this.name = 'StreamUnavailableError'
  }
}

/** Decoded error body of either shape. */
interface DecodedError {
  code: string | undefined
  message: string
}

/** Whether a parsed JSON value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a thrown value is an AbortController cancellation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Decode the Host's error body.
 * @param text - raw response text.
 * @returns the decoded code/message, or undefined for an unrecognized body.
 */
function decodeError(text: string): DecodedError | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const nested = parsed.error
  if (isRecord(nested)) {
    return {
      code: typeof nested.code === 'string' ? nested.code : undefined,
      message: typeof nested.message === 'string' ? nested.message : 'request rejected',
    }
  }
  if (typeof nested === 'string') {
    return { code: typeof parsed.code === 'string' ? parsed.code : undefined, message: nested }
  }
  return typeof parsed.message === 'string'
    ? { code: typeof parsed.code === 'string' ? parsed.code : undefined, message: parsed.message }
    : undefined
}

/** One request's optional parts. */
interface ApiCallOptions {
  body?: unknown
  signal?: AbortSignal
}

/** Request init shared by JSON and streaming calls. */
function baseInit(method: 'GET' | 'POST', signal: AbortSignal | undefined, accept: string): RequestInit {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept },
  }
  if (signal !== undefined) init.signal = signal
  return init
}

/**
 * Perform one JSON request against a Host route.
 * @param method - HTTP method.
 * @param path - path from {@link ApiPaths}.
 * @param options - optional JSON body and caller lifetime.
 * @returns the decoded JSON response.
 * @throws {ApiRequestError} for a non-2xx response or an unreadable body.
 */
async function request<T>(method: 'GET' | 'POST', path: string, options: ApiCallOptions = {}): Promise<T> {
  const init = baseInit(method, options.signal, 'application/json')
  const headers = init.headers as Record<string, string>
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(apiUrl(path), init)
  const text = await response.text()
  if (!response.ok) {
    const decoded = decodeError(text)
    throw new ApiRequestError(
      response.status,
      decoded?.code,
      decoded?.message ?? `HTTP ${String(response.status)}`,
    )
  }
  if (text === '') {
    throw new ApiRequestError(response.status, 'hydro/empty-response', 'empty response')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiRequestError(response.status, 'hydro/bad-response', 'non-JSON response')
  }
}

/** Turn any thrown value into one localized display line. */
export function describeError(error: unknown, t?: TranslateFn): string {
  if (error instanceof ApiRequestError) {
    if (t !== undefined && error.code === 'hydro/empty-response') return t('api.emptyResponse')
    if (t !== undefined && error.code === 'hydro/bad-response') return t('api.badResponse')
    if (t !== undefined && error.code === 'hydro/stream-incomplete') return t('api.streamIncomplete')
    if (error.code === 'hydro/stream-error') return error.message
    if (t !== undefined && error.status === 405) return t('api.methodNotAllowed')
    return error.code === undefined ? error.message : `${error.code}: ${error.message}`
  }
  if (isAbortError(error)) return t?.('api.cancelled') ?? 'Request cancelled'
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ */
/* SSE transport (POST body -> text/event-stream)                      */
/* ------------------------------------------------------------------ */

/** One parsed SSE frame. */
interface SseFrame {
  event: string
  data: string
}

/** Find the earliest SSE event separator; handles \n, \r\n and \r. */
function eventBoundary(text: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null
  for (const separator of ['\r\n\r\n', '\n\n', '\r\r']) {
    const index = text.indexOf(separator)
    if (index === -1) continue
    if (best === null || index < best.index) best = { index, length: separator.length }
  }
  return best
}

/** Parse one SSE block into a frame (event defaults to `message`). */
function parseFrame(block: string): SseFrame | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

/** Parse a JSON frame payload, ignoring malformed frames. */
function parseJsonData(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Handlers accepted by {@link streamHostOperation}. */
export interface HostStreamHandlers {
  /** Called for every `output` event, in order. */
  onOutput?(chunk: HostStreamOutput): void
}

/** One Hydro CLI (`hydrooj ...`) run result. */
export interface CliRunResult {
  ok: boolean
  exitCode: number | null
  output: string
}

/** Request body variants of the CLI SSE route. */
export type CliStreamBody =
  | { action: 'run'; command: string }
  | { action: 'restore'; filename: string; confirm: true }

/** Parser for install/upgrade `result` frames. */
function operationResultFrom(value: unknown): OperationResult | null {
  return isRecord(value) && typeof value.ok === 'boolean' && typeof value.message === 'string'
    ? value as unknown as OperationResult
    : null
}

/** Parser for CLI `result` frames (`{ok, exitCode, output}`). */
function cliResultFrom(value: unknown): CliRunResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  return {
    ok: value.ok,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    output: typeof value.output === 'string' ? value.output : '',
  }
}

/**
 * Read one POST + SSE route generically.
 * @param path - stream route from {@link ApiPaths}.
 * @param body - JSON request body.
 * @param parseResult - parser for the `result` frame data.
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime.
 * @returns the parsed result frame.
 */
async function streamSseResult<T>(
  path: string,
  body: unknown,
  parseResult: (value: unknown) => T | null,
  handlers: HostStreamHandlers,
  signal?: AbortSignal,
): Promise<T> {
  const init = baseInit('POST', signal, 'text/event-stream')
  const headers = init.headers as Record<string, string>
  headers['content-type'] = 'application/json'
  init.body = JSON.stringify(body)

  let response: Response
  try {
    response = await fetch(apiUrl(path), init)
  } catch (cause) {
    if (isAbortError(cause)) throw cause
    throw new StreamUnavailableError(0, 'hydro/stream-unavailable', cause instanceof Error ? cause.message : String(cause))
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const decoded = decodeError(text)
    throw new StreamUnavailableError(
      response.status,
      decoded?.code ?? 'hydro/stream-unavailable',
      decoded?.message ?? `HTTP ${String(response.status)}`,
    )
  }
  const contentType = response.headers.get('content-type') ?? ''
  const reader = response.body?.getReader()
  if (reader === undefined || !contentType.toLowerCase().includes('text/event-stream')) {
    // The route answered with plain JSON (older Host) or no body at all.
    try { await reader?.cancel() } catch { /* ignore */ }
    throw new StreamUnavailableError(response.status, 'hydro/stream-unavailable', 'stream unavailable')
  }

  let result: T | null = null
  let streamError: string | null = null
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (block: string): void => {
    const frame = parseFrame(block)
    if (frame === null) return
    if (frame.event === 'output') {
      const parsed = parseJsonData(frame.data)
      if (isRecord(parsed) && (parsed.stream === 'stdout' || parsed.stream === 'stderr') && typeof parsed.text === 'string') {
        handlers.onOutput?.({ stream: parsed.stream, text: parsed.text })
      }
      return
    }
    if (frame.event === 'result') {
      const parsed = parseResult(parseJsonData(frame.data))
      if (parsed !== null) result = parsed
      return
    }
    if (frame.event === 'error') {
      const parsed = parseJsonData(frame.data)
      streamError = isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : 'operation failed'
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let boundary = eventBoundary(buffer); boundary !== null; boundary = eventBoundary(buffer)) {
        const block = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        if (block.trim() !== '') dispatch(block)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') dispatch(buffer)
  } catch (cause) {
    // A transport hiccup after the `result` frame must not discard a settled
    // operation; only fail when nothing usable arrived.
    if (result === null && streamError === null) throw cause
  } finally {
    try { await reader.cancel() } catch { /* already closed */ }
  }

  if (streamError !== null) throw new ApiRequestError(200, 'hydro/stream-error', streamError)
  if (result === null) throw new ApiRequestError(200, 'hydro/stream-incomplete', 'stream ended without a result')
  return result
}

/**
 * Run an install/upgrade operation over the SSE transport.
 * @param path - stream route from {@link ApiPaths}.
 * @param body - JSON request body (already includes `confirm: true`).
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime; aborting stops reading (the Host keeps running).
 * @returns the final `OperationResult` from the `result` event.
 * @throws {StreamUnavailableError} when the Host has no usable stream route.
 * @throws {ApiRequestError} for a Host `error` event or an incomplete stream.
 */
export async function streamHostOperation(
  path: string,
  body: unknown,
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<OperationResult> {
  return streamSseResult(path, body, operationResultFrom, handlers, signal)
}

/**
 * Run a Hydro CLI command (or restore a backup) over the SSE transport.
 * @param id - SSH account id.
 * @param body - `run` with a `hydrooj` argument string, or `restore` with a filename.
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime (aborting stops reading; the CLI keeps running).
 * @returns `{ok, exitCode, output}` from the `result` event.
 */
export function streamHydroCli(
  id: AccountId,
  body: CliStreamBody,
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<CliRunResult> {
  return streamSseResult(ApiPaths.hostsCliStream, { id, ...body }, cliResultFrom, handlers, signal)
}

/**
 * Run `hydrooj <command>` in the remote /data directory.
 * @param id - SSH account id.
 * @param command - arguments to `hydrooj` (no shell metacharacters).
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime.
 * @returns the CLI run result.
 */
export function runHydroCli(
  id: AccountId,
  command: string,
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<CliRunResult> {
  return streamHydroCli(id, { action: 'run', command }, handlers, signal)
}

/**
 * Restore one backup archive (confirmed, streamed).
 * @param id - SSH account id.
 * @param filename - backup file name from {@link hydroApi.listBackups}.
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime.
 * @returns the CLI run result.
 */
export function restoreHydroBackup(
  id: AccountId,
  filename: string,
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<CliRunResult> {
  return streamHydroCli(id, { action: 'restore', filename, confirm: true }, handlers, signal)
}

/**
 * Install Hydro with live output.
 * @param id - SSH account id.
 * @param options - optional judge-only / no-Caddy flags.
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime.
 * @returns the final operation result.
 */
export function streamInstallHost(
  id: AccountId,
  options: { judge?: boolean; noCaddy?: boolean; force?: boolean } = {},
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<OperationResult> {
  const body: InstallHostRequest = { id, confirm: true, ...options }
  return streamHostOperation(ApiPaths.hostsInstallStream, body, handlers, signal)
}

/**
 * Execute an upgrade with live output (run a dry run first for the plan).
 * @param id - SSH account id.
 * @param options - optional judge inclusion.
 * @param handlers - incremental output sink.
 * @param signal - caller lifetime.
 * @returns the final operation result.
 */
export function streamUpgradeHost(
  id: AccountId,
  options: {
    includeJudge?: boolean
    /** Package names to upgrade; empty/omitted means "all". */
    packages?: string[]
  } = {},
  handlers: HostStreamHandlers = {},
  signal?: AbortSignal,
): Promise<OperationResult> {
  const body = { id, confirm: true, ...options }
  return streamHostOperation(ApiPaths.hostsUpgradeStream, body, handlers, signal)
}

/** `POST hosts/logs` request body. */
export interface HostLogsRequest {
  /** pm2 process name. */
  process: string
  /** Number of lines to tail (Host clamps it). */
  lines?: number
}

/** `POST site/questions/import-zip` payload. */
export interface QuestionZipImportPayload {
  siteAccountId: string
  /** Original archive filename shown in the result/logs. */
  filename: string
  /** Base64-encoded ZIP bytes (no data-URL prefix). */
  data: string
  /** Import the problems hidden. */
  hidden?: boolean
  /** Preferred Hydro problem id prefix. */
  preferredPrefix?: string
}

/** `POST hosts/nix` payload. */
export interface HostNixPayload {
  /** `set-mirror` updates substituters; `upgrade-package` updates node/go-judge. */
  action: 'set-mirror' | 'upgrade-package'
  /** Mirror URL / substituters value (set-mirror). */
  mirror?: string
  /** Nix-managed package (upgrade-package). */
  package?: 'nodejs' | 'go-judge'
  confirm: true
}

/** `POST hosts/issues/fix` payload. */
export type HostIssueFixPayload =
  | { fix: 'restart-service'; target: ServiceTarget; confirm: true }
  | { fix: 'install-ui-plugin'; confirm: true }

/* ------------------------------------------------------------------ */
/* API surface                                                         */
/* ------------------------------------------------------------------ */

/** Every Host call the panel makes. */
export const hydroApi = {
  /**
   * Read plugin metadata and feature flags (used for the global readonly state).
   * @param signal - caller lifetime.
   * @returns version/features payload.
   */
  getInfo(signal?: AbortSignal): Promise<InfoResponse> {
    return request<InfoResponse>('GET', ApiPaths.info, { signal })
  },
  /**
   * List accounts and the active account.
   * @param signal - caller lifetime.
   * @returns the account list and active id.
   */
  listAccounts(signal?: AbortSignal): Promise<ListAccountsResponse> {
    return request<ListAccountsResponse>('GET', ApiPaths.accounts, { signal })
  },
  /**
   * Create an account from the add-host form.
   * @param payload - account fields; password is one-time bootstrap only.
   * @param signal - caller lifetime.
   * @returns the new account projection.
   */
  createAccount(payload: CreateAccountPayload, signal?: AbortSignal): Promise<AccountMutationResponse> {
    return request<AccountMutationResponse>('POST', ApiPaths.accountCreate, { body: payload, signal })
  },
  /**
   * Update mutable account fields (label, role, readonly).
   * @param payload - account id plus changed fields.
   * @param signal - caller lifetime.
   * @returns the refreshed account projection.
   */
  updateAccount(payload: UpdateAccountPayload, signal?: AbortSignal): Promise<AccountMutationResponse> {
    return request<AccountMutationResponse>('POST', ApiPaths.accountUpdate, { body: payload, signal })
  },
  /**
   * Remove one account.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns whether a row was removed.
   */
  removeAccount(id: AccountId, signal?: AbortSignal): Promise<RemoveAccountResponse> {
    return request<RemoveAccountResponse>('POST', ApiPaths.accountRemove, { body: { id }, signal })
  },
  /**
   * Make one account the active account.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the new active id.
   */
  activateAccount(id: AccountId, signal?: AbortSignal): Promise<ActivateAccountResponse> {
    return request<ActivateAccountResponse>('POST', ApiPaths.accountActivate, { body: { id }, signal })
  },
  /**
   * SSH-connect once and report latency/role/host facts.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the connection test result.
   */
  testAccount(id: AccountId, signal?: AbortSignal): Promise<TestConnectionResponse> {
    return request<TestConnectionResponse>('POST', ApiPaths.accountTest, { body: { id }, signal })
  },
  /**
   * Probe one account and collect its Hydro status (may be slow: SSH + HTTP).
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the collected status snapshot.
   */
  collectStatus(id: AccountId, signal?: AbortSignal): Promise<HydroStatus> {
    return request<StatusResponse>('POST', ApiPaths.accountStatus, { body: { id }, signal })
      .then((response) => response.status)
  },

  /* Host operations ------------------------------------------------- */

  /**
   * Install Hydro on the selected host (long-running; no live output).
   * @param id - account id.
   * @param options - optional judge-only / no-Caddy install flags.
   * @param signal - caller lifetime.
   * @returns the install operation result (message + log tail).
   */
  installHost(id: AccountId, options: { judge?: boolean; noCaddy?: boolean; force?: boolean } = {}, signal?: AbortSignal): Promise<OperationResult> {
    const body: InstallHostRequest = { id, confirm: true, ...options }
    return request<OperationResult>('POST', ApiPaths.hostsInstall, { body, signal })
  },
  /**
   * Check for updates (`dryRun:true`) or upgrade (`dryRun:false`, confirmed).
   * @param id - account id.
   * @param options - dry-run flag and optional judge inclusion.
   * @param signal - caller lifetime.
   * @returns the operation result and the dry-run plan when present.
   */
  upgradeHost(id: AccountId, options: { dryRun: boolean; includeJudge?: boolean; packages?: string[] }, signal?: AbortSignal): Promise<UpgradeResponse> {
    const body = {
      id,
      ...options,
      ...(options.dryRun ? {} : { confirm: true }),
    }
    return request<UpgradeResponse>('POST', ApiPaths.hostsUpgrade, { body, signal })
  },
  /**
   * Query or control one remote service.
   * @param id - account id.
   * @param target - which service.
   * @param action - status read or a confirmed mutation.
   * @param signal - caller lifetime.
   * @returns the command result with its output.
   */
  serviceAction(id: AccountId, target: ServiceTarget, action: ServiceAction, signal?: AbortSignal): Promise<ServiceActionResult> {
    const body = { id, target, action, ...(action === 'status' ? {} : { confirm: true }) }
    return request<ServiceActionResult>('POST', ApiPaths.hostsService, { body, signal })
  },
  /**
   * Collect Hydro WebSocket/oplog warnings for one host.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the warnings and collection time.
   */
  hostWarnings(id: AccountId, signal?: AbortSignal): Promise<HostWarningsResponse> {
    return request<HostWarningsResponse>('POST', ApiPaths.hostsWarnings, { body: { id }, signal })
  },
  /**
   * Read Mongo collections, documents or the oplog (never writes).
   * @param id - account id.
   * @param payload - action plus its optional collection/filter/limit/source.
   * @param signal - caller lifetime.
   * @returns the documents and truncation/note metadata.
   */
  hostData(id: AccountId, payload: HostDataRequest, signal?: AbortSignal): Promise<HostDataResponse> {
    return request<HostDataResponse>('POST', ApiPaths.hostsData, { body: { id, ...payload }, signal })
  },
  /**
   * Read the structured pm2/component service overview (read-only).
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns processes plus Hydro/sandbox/judge state.
   */
  hostServices(id: AccountId, signal?: AbortSignal): Promise<ServiceOverviewResponse> {
    return request<ServiceOverviewResponse>('POST', ApiPaths.hostsServices, { body: { id }, signal })
  },
  /**
   * List installed Hydro addons/plugins and enabled names.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the plugin table payload.
   */
  listPlugins(id: AccountId, signal?: AbortSignal): Promise<PluginListResponse> {
    return request<PluginListResponse>('POST', ApiPaths.hostsPlugins, { body: { id, action: 'list' }, signal })
  },
  /**
   * Install / uninstall / enable / disable one Hydro addon.
   * @param id - account id.
   * @param action - plugin mutation.
   * @param name - npm package / addon name.
   * @param signal - caller lifetime.
   * @returns the operation result with output/log.
   */
  managePlugin(
    id: AccountId,
    action: 'install' | 'uninstall' | 'enable' | 'disable',
    name: string,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    return request<OperationResult>('POST', ApiPaths.hostsPlugins, { body: { id, action, name, confirm: true }, signal })
  },
  /**
   * Resolve a browser-reachable Hydro URL for the embedded pages.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the URL and where it came from (`server.url`, detected, or null).
   */
  hostAddress(id: AccountId, signal?: AbortSignal): Promise<HostAddressResponse> {
    return request<HostAddressResponse>('POST', ApiPaths.hostsAddress, { body: { id }, signal })
  },
  /**
   * Read what page the embedded Caddy proxy last served (context-aware AI).
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the embedded page context (`kind`, domain, id, path).
   */
  getEmbeddedContext(id: AccountId, signal?: AbortSignal): Promise<EmbeddedContextResponse> {
    return request<EmbeddedContextResponse>('POST', ApiPaths.hostsContext, { body: { id }, signal })
  },
  /**
   * Read the Caddy status and Caddyfile contents (or just the status).
   * @param id - account id.
   * @param action - `read` includes the file content; `status` may omit it.
   * @param signal - caller lifetime.
   * @returns the Caddy status/config payload.
   */
  getCaddy(id: AccountId, action: 'status' | 'read' = 'read', signal?: AbortSignal): Promise<CaddyResponse> {
    return request<CaddyResponse>('POST', ApiPaths.hostsCaddy, { body: { id, action }, signal })
  },
  /**
   * Write the Caddyfile (optionally followed by a reload).
   * @param id - account id.
   * @param payload - target path, new content and reload flag.
   * @param signal - caller lifetime.
   * @returns the operation result with output/log.
   */
  writeCaddy(id: AccountId, payload: { path: string; content: string; reload?: boolean }, signal?: AbortSignal): Promise<OperationResult> {
    return request<OperationResult>('POST', ApiPaths.hostsCaddy, {
      body: { id, action: 'write', path: payload.path, content: payload.content, reload: payload.reload !== false, confirm: true },
      signal,
    })
  },
  /**
   * Validate or reload the remote Caddy configuration.
   * @param id - account id.
   * @param action - `validate` or `reload`.
   * @param signal - caller lifetime.
   * @returns the operation result.
   */
  applyCaddy(id: AccountId, action: 'validate' | 'reload', signal?: AbortSignal): Promise<OperationResult> {
    return request<OperationResult>('POST', ApiPaths.hostsCaddy, { body: { id, action, confirm: true }, signal })
  },
  /**
   * Read standalone judge config/process state.
   * @param id - account id.
   * @param signal - caller lifetime.
   */
  hostJudge(id: AccountId, signal?: AbortSignal): Promise<import('../shared/api.js').JudgeConfigResponse> {
    return request('POST', ApiPaths.hostsJudge, { body: { id }, signal })
  },
  /** Save judge.yaml (path/content) and restart hydrojudge. */
  saveJudgeConfig(id: AccountId, path: string, content: string, signal?: AbortSignal): Promise<import('../shared/types.js').OperationResult> {
    return request('POST', ApiPaths.hostsJudge, { body: { id, action: 'save', path, content, confirm: true }, signal })
  },
  /** Restart hydrojudge. */
  restartJudge(id: AccountId, signal?: AbortSignal): Promise<import('../shared/types.js').OperationResult> {
    return request('POST', ApiPaths.hostsJudge, { body: { id, action: 'restart', confirm: true }, signal })
  },
  /** Rejudge stale in-flight records (max 50). */
  rejudgeStale(id: AccountId, signal?: AbortSignal): Promise<import('../shared/types.js').OperationResult> {
    return request('POST', ApiPaths.hostsRejudge, { body: { id, confirm: true }, signal })
  },
  /**
   * Read MongoDB install/running state.
   * @param id - account id.
   * @param signal - caller lifetime.
   */
  hostDatabase(id: AccountId, signal?: AbortSignal): Promise<import('../shared/api.js').HostDatabaseStatusResponse> {
    return request('POST', ApiPaths.hostsDatabase, { body: { id }, signal })
  },
  /**
   * Run the official read-only `hydrooj diagnosis` script.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns captured diagnosis output.
   */
  hostDiagnosis(id: AccountId, signal?: AbortSignal): Promise<{ ok: boolean; message: string; log: string }> {
    return request('POST', ApiPaths.hostsDiagnosis, { body: { id }, signal })
  },
  /**
   * List backup archives under the remote /data directory.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the backup file list.
   */
  listBackups(id: AccountId, signal?: AbortSignal): Promise<BackupsResponse> {
    return request<BackupsResponse>('POST', ApiPaths.hostsBackups, { body: { id }, signal })
  },
  /**
   * Tail one remote process log (read-only).
   * @param id - account id.
   * @param request - process name plus optional line count.
   * @param signal - caller lifetime.
   * @returns stdout/stderr tails and a truncation flag.
   */
  hostLogs(id: AccountId, payload: HostLogsRequest, signal?: AbortSignal): Promise<ProcessLogsResponse> {
    return request<ProcessLogsResponse>('POST', ApiPaths.hostsLogs, { body: { id, ...payload }, signal })
  },
  /**
   * Sample CPU/memory/disk/judge-queue metrics (read-only).
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the metrics sample plus threshold alerts.
   */
  hostMetrics(id: AccountId, signal?: AbortSignal): Promise<HostMetricsResponse> {
    return request<HostMetricsResponse>('POST', ApiPaths.hostsMetrics, { body: { id }, signal })
  },
  /**
   * Run known-issue diagnostics (read-only).
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns issues with severity, details and optional fix ids.
   */
  hostIssues(id: AccountId, signal?: AbortSignal): Promise<HostIssuesResponse> {
    return request<HostIssuesResponse>('POST', ApiPaths.hostsIssues, { body: { id }, signal })
  },
  /**
   * List yarn packages and node/go-judge/nix facts for upgrade planning.
   * @param id - account id.
   * @param signal - caller lifetime.
   * @returns the package list payload.
   */
  hostPackages(id: AccountId, signal?: AbortSignal): Promise<PackageListResponse> {
    return request<PackageListResponse>('POST', ApiPaths.hostsPackages, { body: { id }, signal })
  },
  /**
   * Run a nix maintenance action (currently: set the substituters mirror).
   * @param id - account id.
   * @param payload - action plus mirror value.
   * @param signal - caller lifetime.
   * @returns the operation result with output/log.
   */
  hostNix(id: AccountId, payload: HostNixPayload, signal?: AbortSignal): Promise<OperationResult> {
    return request<OperationResult>('POST', ApiPaths.hostsNix, { body: { id, ...payload }, signal })
  },
  /**
   * Apply one safe known-issue fix.
   * @param id - account id.
   * @param payload - fix id plus its target/confirm fields.
   * @param signal - caller lifetime.
   * @returns the operation result with output/log.
   */
  fixHostIssue(id: AccountId, payload: HostIssueFixPayload, signal?: AbortSignal): Promise<OperationResult> {
    return request<OperationResult>('POST', ApiPaths.hostsIssueFix, { body: { id, ...payload }, signal })
  },
  /**
   * Read the global operator settings (readonly mode + update time).
   * @param signal - caller lifetime.
   * @returns the settings payload.
   */
  getUiSettings(signal?: AbortSignal): Promise<UiSettingsResponse> {
    return request<UiSettingsResponse>('GET', ApiPaths.settings, { signal })
  },
  /**
   * Turn the global readonly switch on/off.
   * @param readonly - next state.
   * @param signal - caller lifetime.
   * @returns the persisted settings payload.
   */
  setGlobalReadonly(readonly: boolean, signal?: AbortSignal): Promise<UiSettingsResponse> {
    return request<UiSettingsResponse>('POST', ApiPaths.settingsReadonly, { body: { readonly }, signal })
  },
  /**
   * Ask the Host for an AI troubleshooting prompt for a failed operation.
   * @param payload - host id, operation kind, terminal tail and final message.
   * @param signal - caller lifetime.
   * @returns the generated prompt.
   */
  diagnoseHost(payload: DiagnosePayload, signal?: AbortSignal): Promise<HostDiagnoseResponse> {
    // The shared contract documents `hostId`, while the current route still
    // resolves `requireId(body)` (i.e. `id`). Send both so the call works with
    // either spelling until the host side settles on one.
    const body = {
      id: payload.hostId,
      hostId: payload.hostId,
      kind: payload.kind,
      output: payload.output,
      ...(payload.message === undefined ? {} : { message: payload.message }),
    }
    return request<HostDiagnoseResponse>('POST', ApiPaths.hostsDiagnose, { body, signal })
  },

  /* Site operations ---------------------------------------------- */

  /**
   * List the Hydro web admin accounts (one host can own several).
   * @param signal - caller lifetime.
   * @returns the site accounts and the active site-account id.
   */
  listSiteAccounts(signal?: AbortSignal): Promise<SiteAccountsResponse> {
    return request<SiteAccountsResponse>('GET', ApiPaths.siteAccounts, { signal })
  },
  /**
   * Create or update one Hydro web admin account.
   * @param payload - `id` present = edit; no password is ever stored.
   * @param signal - caller lifetime.
   * @returns the refreshed site account projection.
   */
  saveSiteAccount(payload: SiteSavePayload, signal?: AbortSignal): Promise<SiteSaveResponse> {
    return request<SiteSaveResponse>('POST', ApiPaths.siteSave, { body: payload, signal })
  },
  /**
   * Remove one Hydro web admin account.
   * @param id - site-account id.
   * @param signal - caller lifetime.
   * @returns whether a row was removed.
   */
  removeSiteAccount(id: string, signal?: AbortSignal): Promise<SiteRemoveResponse> {
    return request<SiteRemoveResponse>('POST', ApiPaths.siteRemove, { body: { id }, signal })
  },
  /**
   * Mark one site account as the active one.
   * @param id - site-account id.
   * @param signal - caller lifetime.
   * @returns the new active site-account id.
   */
  activateSiteAccount(id: string, signal?: AbortSignal): Promise<SiteActivateResponse> {
    return request<SiteActivateResponse>('POST', ApiPaths.siteActivate, { body: { id }, signal })
  },
  /**
   * Sign in to the Hydro web admin and read warnings + domain configuration.
   * @param siteAccountId - site-account id.
   * @param signal - caller lifetime.
   * @returns warnings and the current domain values.
   */
  inspectSite(siteAccountId: string, signal?: AbortSignal): Promise<SiteInspectResponse> {
    return request<SiteInspectResponse>('POST', ApiPaths.siteInspect, { body: { siteAccountId }, signal })
  },
  /**
   * Update a domain's configuration through the Hydro web admin.
   * @param payload - site-account id, scalar values and boolean keys.
   * @param signal - caller lifetime.
   * @returns the host's success message.
   */
  setSiteDomain(payload: DomainSetPayload, signal?: AbortSignal): Promise<DomainSetResponse> {
    return request<DomainSetResponse>('POST', ApiPaths.siteDomainSet, { body: payload, signal })
  },
  /**
   * Import a Hydro ZIP problem package.
   * @param payload - site-account id, filename, base64 data and options.
   * @param signal - caller lifetime.
   * @returns ok/message from the Host.
   */
  importQuestionsZip(payload: QuestionZipImportPayload, signal?: AbortSignal): Promise<QuestionZipImportResponse> {
    return request<QuestionZipImportResponse>('POST', ApiPaths.siteQuestionsImportZip, { body: payload, signal })
  },
  /**
   * List the domains available to one Hydro account.
   * @param siteAccountId - site-account id.
   * @param signal - caller lifetime.
   * @returns known domains `{id,name}`.
   */
  listSiteDomains(siteAccountId: string, signal?: AbortSignal): Promise<SiteDomainsResponse> {
    return request<SiteDomainsResponse>('POST', ApiPaths.siteDomains, { body: { siteAccountId }, signal })
  },
  /**
   * Read the browser-captured Hydro login session state of one account.
   * @param siteAccountId - site-account id.
   * @param signal - caller lifetime.
   * @returns session state, capture time and optional Host message.
   */
  siteSession(siteAccountId: string, signal?: AbortSignal): Promise<SiteSessionStatus> {
    return request<SiteSessionStatus>('POST', ApiPaths.siteSession, { body: { siteAccountId }, signal })
  },
  /**
   * Read the community polling config + last-seen state.
   * @param signal - caller lifetime.
   * @returns the community config payload.
   */
  communityStatus(signal?: AbortSignal): Promise<CommunityConfigResponse> {
    return request<CommunityConfigResponse>('POST', ApiPaths.communityStatus, { body: {}, signal })
  },
  /**
   * Save the community polling config (enabling starts a read-only host poll).
   * @param payload - enabled flag, interval, target domain and Hydro account.
   * @param signal - caller lifetime.
   * @returns the saved config.
   */
  saveCommunityConfig(
    payload: { enabled: boolean; intervalMinutes: number; domain: string; siteAccountId: string | null; replyPersona?: string },
    signal?: AbortSignal,
  ): Promise<CommunityConfigResponse> {
    return request<CommunityConfigResponse>('POST', ApiPaths.communityConfig, { body: payload, signal })
  },
  /**
   * List recent discussions for one Hydro account/domain.
   * @param payload - site account, optional domain and limit.
   * @param signal - caller lifetime.
   * @returns discussions plus new-activity count.
   */
  communityFeed(
    payload: { siteAccountId: string; domain?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<CommunityFeedResponse> {
    return request<CommunityFeedResponse>('POST', ApiPaths.communityFeed, { body: payload, signal })
  },
  /**
   * Read one discussion thread with replies.
   * @param payload - site account and discussion id.
   * @param signal - caller lifetime.
   * @returns the thread payload.
   */
  communityThread(
    payload: { siteAccountId: string; did: string },
    signal?: AbortSignal,
  ): Promise<CommunityThreadResponse> {
    return request<CommunityThreadResponse>('POST', ApiPaths.communityThread, { body: payload, signal })
  },
  /**
   * Post a manual reply to a discussion (confirmed, readonly-aware).
   * @param payload - site account, discussion id and reply text.
   * @param signal - caller lifetime.
   * @returns ok/message.
   */
  communityReply(
    payload: { siteAccountId: string; did: string; content: string },
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; message: string }> {
    return request<{ ok: boolean; message: string }>('POST', ApiPaths.communityReply, {
      body: { ...payload, confirm: true },
      signal,
    })
  },
  /**
   * Run one manual read-only community poll.
   * @param siteAccountId - optional site account to persist as target.
   * @param signal - caller lifetime.
   * @returns the poll summary.
   */
  communityPoll(siteAccountId?: string, signal?: AbortSignal): Promise<CommunityPollResponse> {
    return request<CommunityPollResponse>('POST', ApiPaths.communityPoll, {
      body: siteAccountId === undefined || siteAccountId === '' ? {} : { siteAccountId },
      signal,
    })
  },
  /**
   * List recent problems or contests from the Hydro database.
   * @param siteAccountId - site-account id.
   * @param collection - `problem` or `contest`.
   * @param limit - page size (host clamps 1–50).
   * @param signal - caller lifetime.
   * @returns the collection name and documents.
   */
  listSiteCollection(
    siteAccountId: string,
    collection: 'problem' | 'contest',
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SiteCollectionResponse> {
    return request<SiteCollectionResponse>('POST', ApiPaths.siteCollection, {
      body: { siteAccountId, collection, ...(limit === undefined ? {} : { limit }) },
      signal,
    })
  },
  /**
   * Build the prompt that launches an AI authoring conversation.
   * @param payload - site-account id, kind and optional title/requirements/domain.
   * @param signal - caller lifetime.
   * @returns the generated prompt.
   */
  authoringPrompt(payload: AuthoringPromptPayload, signal?: AbortSignal): Promise<AuthoringPromptResponse> {
    return request<AuthoringPromptResponse>('POST', ApiPaths.siteAuthoringPrompt, { body: payload, signal })
  },
}
