/**
 * HTTP routes for the browser half.
 *
 * These are exact-path registrations on the shared web server. They are
 * reachable from the DSH page (same origin) and are guarded by the host's own
 * request gate when the host publishes one, plus a same-origin check for
 * mutating requests. All payloads are JSON.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Context } from '@deepseek-ai/cordis'

import type { HydroOpsApi } from './ops/hydro-ops.js'
import { buildDiagnosePrompt } from './site/diagnose.js'
import { hostData, hostWarnings, type SiteService } from './site/service.js'
import type { CommunityService } from './community/service.js'
import {
  ApiPaths,
  type AuthoringPromptResponse,
  type SiteAccountsResponse,
  type SiteCollectionResponse,
  type SiteSaveResponse,
  type SiteInspectResponse,
  type HostDataResponse,
  type HostDiagnoseResponse,
  type HostMetricsResponse,
  type HostIssuesResponse,
  type CaddyResponse,
  type BackupsResponse,
  type HostAddressResponse,
  type EmbeddedContextResponse,
  type PackageListResponse,
  type PluginListResponse,
  type SiteSessionStatus,
  type CommunityConfigResponse,
  type CommunityFeedResponse,
  type CommunityThreadResponse,
  type CommunityPollResponse,
  type ProcessLogsResponse,
  type QuestionZipImportResponse,
  type SiteDomainsResponse,
  type ServiceOverviewResponse,
  type UiSettingsResponse,
  type HostServiceResponse,
  type HostUpgradeResponse,
  type HostWarningsResponse,
  type InfoResponse,
} from './shared/api.js'
import type {
  ActivateAccountResponse,
  ApiErrorBody,
  CreateAccountRequest,
  ListAccountsResponse,
  StatusResponse,
  TestConnectionResponse,
  UpdateAccountRequest,
} from './shared/types.js'

/** Host-side context narrowed to the web server service. */
export interface RouteContext extends Context {
  webServer: {
    register(route: { kind: 'exact'; path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
  }
}

export interface RouteDeps {
  ctx: RouteContext
  ops: HydroOpsApi
  version: string
  /** Hydro web-admin surface; omitted in host-only test setups. */
  site?: SiteService
  /** Community/discussion polling service. */
  community?: CommunityService
}

const MAX_BODY_BYTES = 1024 * 1024

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function sendError(response: ServerResponse, status: number, message: string, code?: string): void {
  const body: ApiErrorBody = { error: message, ...(code === undefined ? {} : { code }) }
  sendJson(response, status, body)
}

async function readJsonBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > maxBytes) throw new HttpError(413, '请求体过大')
    chunks.push(buffer)
  }
  if (total === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** Check the host's own request gate; returns the rejection status or undefined. */
function gateStatus(ctx: Context, request: IncomingMessage): number | undefined {
  const connection = ctx.get('connection') as
    | { requestRejection?: (request: IncomingMessage) => number | undefined }
    | undefined
  const gate = connection?.requestRejection
  if (typeof gate !== 'function') return undefined
  try {
    return gate.call(connection, request)
  } catch {
    return 403
  }
}

/** True when a mutating request clearly comes from a different http(s) origin. */
function crossOrigin(request: IncomingMessage): boolean {
  const candidate = request.headers.origin ?? request.headers.referer
  if (typeof candidate !== 'string' || candidate === '') return false
  if (!/^https?:/i.test(candidate)) return false
  try {
    return new URL(candidate).host !== request.headers.host
  } catch {
    return true
  }
}

/** Wrap an async handler with gate + same-origin checks and JSON error mapping. */
function guarded(
  deps: RouteDeps,
  options: { mutating: boolean; maxBodyBytes?: number },
  handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const rejection = gateStatus(deps.ctx, request)
      if (rejection !== undefined) {
        sendError(response, rejection, rejection === 401 ? '需要先登录 DSH' : '请求来源不受信任', 'forbidden')
        return
      }
      if (options.mutating && crossOrigin(request)) {
        sendError(response, 403, '跨站请求已拒绝', 'cross-origin')
        return
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { allow: 'GET, POST, OPTIONS' })
        response.end()
        return
      }
      await deps.ops.ready()
      const body = await readJsonBody(request, options.maxBodyBytes)
      await handler(request, response, body)
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message)
        return
      }
      sendError(response, 500, error instanceof Error ? error.message : String(error))
    }
  }
}

function methodNotAllowed(response: ServerResponse, expected: string): void {
  response.writeHead(405, { allow: expected })
  response.end()
}

function requireId(body: Record<string, unknown>): string {
  const id = body.id
  if (typeof id !== 'string' || id.trim() === '') throw new HttpError(400, '缺少 id')
  return id.trim()
}

function requireConfirm(body: Record<string, unknown>, action: string): void {
  if (body.confirm !== true) throw new HttpError(400, `执行「${action}」需要 confirm=true`)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Start an SSE response for a long-running operation. */
function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write(': connected\n\n')
}

/** Write one named SSE event unless the client already went away. */
function writeSse(response: ServerResponse, event: string, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return
  try {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // The client disconnected mid-install; the operation itself keeps running.
  }
}

/** Wrap a streaming handler with the same auth/origin guards as JSON routes. */
function streaming(
  deps: RouteDeps,
  handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const rejection = gateStatus(deps.ctx, request)
      if (rejection !== undefined) {
        sendError(response, rejection, rejection === 401 ? '需要先登录 DSH' : '请求来源不受信任', 'forbidden')
        return
      }
      if (crossOrigin(request)) {
        sendError(response, 403, '跨站请求已拒绝', 'cross-origin')
        return
      }
      if (request.method !== 'POST') {
        sendError(response, 405, '仅支持 POST', 'method')
        return
      }
      await deps.ops.ready()
      const body = await readJsonBody(request)
      await handler(request, response, body)
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, 'error', { message: errorMessage(error) })
        response.end()
        return
      }
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message)
        return
      }
      sendError(response, 500, errorMessage(error))
    }
  }
}

/** Register every client-facing route. Returns unnecessary: registrations are effects. */
export function registerHydroRoutes(deps: RouteDeps): void {
  const { ctx, ops } = deps
  const register = (path: string, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): void => {
    const route = {
      kind: 'exact' as const,
      path,
      handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        if (typeof response.on === 'function') {
          response.on('finish', () => {
            if (response.statusCode !== 405) return
            try {
              ctx.logger.warn(`dsh-hydro: 405 ${request.method ?? '?'} ${path}`)
            } catch {
              // Logging must never affect the response.
            }
          })
        }
        await handler(request, response)
      },
    }
    ctx.effect(() => ctx.webServer.register(route), `dsh-hydro: route ${path}`)
  }

  register(
    ApiPaths.info,
    guarded({ ctx, ops, version: deps.version }, { mutating: false }, async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, 'GET')
        return
      }
      const base: Omit<InfoResponse, 'features'> = { name: 'dsh-hydro', version: deps.version }
      const payload: InfoResponse = {
        ...base,
        features: {
          ssh: true,
          install: true,
          status: true,
          mongo: true,
          oplog: true,
          wsWarnings: true,
          problem: true,
          contest: true,
          readonlyMode: ops.isGloballyReadonly(),
        },
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.accounts,
    guarded({ ctx, ops, version: deps.version }, { mutating: false }, async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, 'GET')
        return
      }
      const payload: ListAccountsResponse = {
        accounts: ops.listAccounts(),
        activeAccountId: ops.activeAccountId(),
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.accountCreate,
    guarded({ ctx, ops, version: deps.version }, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const host = body.host
      const username = body.username
      if (typeof host !== 'string' || host.trim() === '') throw new HttpError(400, 'host 不能为空')
      if (typeof username !== 'string' || username.trim() === '') throw new HttpError(400, 'username 不能为空')
      const input: CreateAccountRequest = {
        host: host.trim(),
        username: username.trim(),
        authMethod: body.authMethod === 'key' ? 'key' : 'password',
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.port === 'number' ? { port: body.port } : {}),
        ...(typeof body.password === 'string' ? { password: body.password } : {}),
        ...(typeof body.privateKey === 'string' ? { privateKey: body.privateKey } : {}),
        ...(typeof body.installManagedKey === 'boolean' ? { installManagedKey: body.installManagedKey } : {}),
        ...(body.role === 'root' || body.role === 'sudo' || body.role === 'user' ? { role: body.role } : {}),
        ...(typeof body.readonly === 'boolean' ? { readonly: body.readonly } : {}),
      }
      const log: string[] = []
      const account = await ops.addAccount({
        ...input,
      }, (line) => { log.push(line) })
      sendJson(response, 200, { account, log })
    }),
  )

  register(
    ApiPaths.accountUpdate,
    guarded({ ctx, ops, version: deps.version }, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const id = requireId(body)
      const patch: Record<string, string | number | boolean> = {}
      for (const key of ['label', 'host', 'username', 'role'] as const) {
        const value = body[key]
        if (typeof value === 'string') patch[key] = value
      }
      if (typeof body.port === 'number') patch.port = body.port
      if (typeof body.readonly === 'boolean') patch.readonly = body.readonly
      const account = await ops.updateAccount(id, patch as unknown as UpdateAccountRequest)
      sendJson(response, 200, { account })
    }),
  )

  register(
    ApiPaths.accountRemove,
    guarded({ ctx, ops, version: deps.version }, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const id = requireId(body)
      const removed = await ops.removeAccount(id)
      sendJson(response, 200, { removed })
    }),
  )

  register(
    ApiPaths.accountActivate,
    guarded({ ctx, ops, version: deps.version }, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const raw = body.id
      const id = raw === null ? null : typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
      if (id === undefined) throw new HttpError(400, '缺少 id')
      await ops.setActiveAccount(id)
      const payload: ActivateAccountResponse = { activeAccountId: ops.activeAccountId() }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.accountTest,
    guarded({ ctx, ops, version: deps.version }, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const result = await ops.testAccount(requireId(body))
      const payload: TestConnectionResponse = result
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.accountStatus,
    guarded({ ctx, ops, version: deps.version }, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') {
        methodNotAllowed(response, 'POST')
        return
      }
      const id = requireId(body)
      const status = await ops.collectStatus(id)
      const payload: StatusResponse = { status }
      sendJson(response, 200, payload)
    }),
  )

  /* ------------------------------------------------------------------ */
  /* Host operations                                                     */
  /* ------------------------------------------------------------------ */

  register(
    ApiPaths.hostsInstall,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      requireConfirm(body, '安装 Hydro')
      const result = await ops.install(id, {
        ...(typeof body.judge === 'boolean' ? { judge: body.judge } : {}),
        ...(typeof body.noCaddy === 'boolean' ? { noCaddy: body.noCaddy } : {}),
        ...(typeof body.force === 'boolean' ? { force: body.force } : {}),
      })
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsUpgrade,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const dryRun = body.dryRun !== false
      if (!dryRun) requireConfirm(body, '升级 Hydro')
      const packages = Array.isArray(body.packages)
        ? body.packages.filter((name): name is string => typeof name === 'string')
        : undefined
      const result = await ops.upgrade(id, {
        dryRun,
        ...(typeof body.includeJudge === 'boolean' ? { includeJudge: body.includeJudge } : {}),
        ...(packages === undefined ? {} : { packages }),
      })
      const payload: HostUpgradeResponse = {
        result,
        plan: (result.details ?? null) as HostUpgradeResponse['plan'],
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.hostsService,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const target = body.target
      const action = body.action
      const targets = ['hydro', 'mongodb', 'sandbox', 'caddy', 'judge'] as const
      const actions = ['status', 'start', 'stop', 'restart', 'reload'] as const
      if (typeof target !== 'string' || !targets.includes(target as (typeof targets)[number])) {
        throw new HttpError(400, `target 必须是 ${targets.join('/')}`)
      }
      if (typeof action !== 'string' || !actions.includes(action as (typeof actions)[number])) {
        throw new HttpError(400, `action 必须是 ${actions.join('/')}`)
      }
      if (action !== 'status') requireConfirm(body, `${target} ${action}`)
      const result: HostServiceResponse = await ops.serviceAction(
        id,
        target as (typeof targets)[number],
        action as (typeof actions)[number],
      )
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsWarnings,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const result = await hostWarnings(ops, id)
      const payload: HostWarningsResponse = { hostId: id, ...result }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.hostsData,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const actions = ['collections', 'find', 'oplog'] as const
      if (typeof body.action !== 'string' || !actions.includes(body.action as (typeof actions)[number])) {
        throw new HttpError(400, `action 必须是 ${actions.join('/')}`)
      }
      const limit = typeof body.limit === 'number' ? body.limit : undefined
      const source = body.source === 'hydro' || body.source === 'mongo' || body.source === 'auto' ? body.source : undefined
      const result: HostDataResponse = await hostData(ops, {
        hostId: id,
        action: body.action as (typeof actions)[number],
        ...(optionalString(body.collection) === undefined ? {} : { collection: optionalString(body.collection)! }),
        ...(optionalObject(body.filter) === undefined ? {} : { filter: optionalObject(body.filter)! }),
        ...(limit === undefined ? {} : { limit }),
        ...(source === undefined ? {} : { source }),
        ...(optionalString(body.type) === undefined ? {} : { type: optionalString(body.type)! }),
        ...(optionalString(body.contains) === undefined ? {} : { contains: optionalString(body.contains)! }),
      })
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsInstallStream,
    streaming(deps, async (_request, response, body) => {
      const id = requireId(body)
      requireConfirm(body, '安装 Hydro')
      openSse(response)
      try {
        const result = await ops.install(id, {
          ...(typeof body.judge === 'boolean' ? { judge: body.judge } : {}),
          ...(typeof body.noCaddy === 'boolean' ? { noCaddy: body.noCaddy } : {}),
          ...(typeof body.force === 'boolean' ? { force: body.force } : {}),
          onOutput: (chunk) => { writeSse(response, 'output', chunk) },
        })
        writeSse(response, 'result', result)
      } catch (error) {
        writeSse(response, 'error', { message: errorMessage(error) })
      } finally {
        response.end()
      }
    }),
  )

  register(
    ApiPaths.hostsUpgradeStream,
    streaming(deps, async (_request, response, body) => {
      const id = requireId(body)
      requireConfirm(body, '升级 Hydro')
      openSse(response)
      try {
        const packages = Array.isArray(body.packages)
          ? body.packages.filter((name): name is string => typeof name === 'string')
          : undefined
        const result = await ops.upgrade(id, {
          dryRun: false,
          ...(typeof body.includeJudge === 'boolean' ? { includeJudge: body.includeJudge } : {}),
          ...(packages === undefined ? {} : { packages }),
          onOutput: (chunk) => { writeSse(response, 'output', chunk) },
        })
        writeSse(response, 'result', result)
      } catch (error) {
        writeSse(response, 'error', { message: errorMessage(error) })
      } finally {
        response.end()
      }
    }),
  )

  register(
    ApiPaths.hostsDiagnose,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = (optionalString(body.hostId) ?? '').trim() !== '' ? optionalString(body.hostId)!.trim() : requireId(body)
      const account = ops.getAccountSummary(id)
      if (account === undefined) throw new HttpError(404, `未知主机 ${id}`)
      if (body.kind !== 'install' && body.kind !== 'upgrade' && body.kind !== 'issues') {
        throw new HttpError(400, "kind 必须是 'install'、'upgrade' 或 'issues'")
      }
      const output = typeof body.output === 'string' ? body.output.slice(-4000) : ''
      const message = optionalString(body.message)
      const payload: HostDiagnoseResponse = {
        prompt: buildDiagnosePrompt({
          hostLabel: account.label,
          address: `${account.host}:${String(account.port)}`,
          username: account.username,
          kind: body.kind,
          ...(message === undefined ? {} : { message }),
          output,
        }),
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.hostsServices,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const overview = await ops.serviceOverview(id)
      const payload: ServiceOverviewResponse = overview
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.hostsLogs,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const processName = optionalString(body.process)
      if (processName === undefined || processName.trim() === '') throw new HttpError(400, '缺少 process')
      const lines = typeof body.lines === 'number' ? body.lines : undefined
      const logs: ProcessLogsResponse = await ops.processLogs(id, {
        process: processName.trim(),
        ...(lines === undefined ? {} : { lines }),
      })
      sendJson(response, 200, logs)
    }),
  )

  register(
    ApiPaths.hostsMetrics,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const metrics: HostMetricsResponse = await ops.metrics(id)
      sendJson(response, 200, metrics)
    }),
  )

  register(
    ApiPaths.hostsIssues,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const issues: HostIssuesResponse = await ops.issues(id)
      sendJson(response, 200, issues)
    }),
  )

  register(
    ApiPaths.hostsIssueFix,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      requireConfirm(body, '修复已知问题')
      if (body.fix === 'restart-service') {
        const targets = ['hydro', 'mongodb', 'sandbox', 'caddy', 'judge'] as const
        if (typeof body.target !== 'string' || !targets.includes(body.target as (typeof targets)[number])) {
          throw new HttpError(400, 'restart-service 需要目标组件 target')
        }
        const result = await ops.fixIssue(id, { fix: 'restart-service', target: body.target as (typeof targets)[number] })
        sendJson(response, 200, result)
        return
      }
      if (body.fix === 'install-ui-plugin') {
        const result = await ops.fixIssue(id, { fix: 'install-ui-plugin' })
        sendJson(response, 200, result)
        return
      }
      throw new HttpError(400, "fix 必须是 'restart-service' 或 'install-ui-plugin'")
    }),
  )

  register(
    ApiPaths.hostsPackages,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const packages: PackageListResponse = await ops.packages(id)
      sendJson(response, 200, packages)
    }),
  )

  register(
    ApiPaths.hostsAddress,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const address: HostAddressResponse = await ops.address(id)
      sendJson(response, 200, address)
    }),
  )

  register(
    ApiPaths.hostsNix,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      requireConfirm(body, 'Nix 维护')
      if (body.action !== 'set-mirror' && body.action !== 'upgrade-package') {
        throw new HttpError(400, "action 必须是 'set-mirror' 或 'upgrade-package'")
      }
      if (body.action === 'set-mirror') {
        const mirror = optionalString(body.mirror)
        if (mirror === undefined || mirror.trim() === '') throw new HttpError(400, '缺少 mirror')
        const result = await ops.nixMaintenance(id, { action: 'set-mirror', mirror: mirror.trim() })
        sendJson(response, 200, result)
        return
      }
      if (body.package !== 'nodejs' && body.package !== 'go-judge') {
        throw new HttpError(400, "package 必须是 'nodejs' 或 'go-judge'")
      }
      const result = await ops.nixMaintenance(id, { action: 'upgrade-package', package: body.package })
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsContext,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const context: EmbeddedContextResponse = ops.embeddedContext(id) ?? { kind: null, domain: null, id: null, page: null, path: null }
      sendJson(response, 200, context)
    }),
  )

  register(
    ApiPaths.hostsJudge,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      if (body.action === undefined) {
        sendJson(response, 200, await ops.readJudgeConfig(id))
        return
      }
      requireConfirm(body, body.action === 'restart' ? '重启评测机' : '保存评测机配置')
      if (body.action === 'restart') {
        sendJson(response, 200, await ops.restartJudge(id))
        return
      }
      if (body.action === 'save') {
        const path = optionalString(body.path)
        const content = optionalString(body.content)
        if (path === undefined || path === '') throw new HttpError(400, '缺少 path')
        if (content === undefined) throw new HttpError(400, '缺少 content')
        sendJson(response, 200, await ops.writeJudgeConfig(id, { path, content }))
        return
      }
      throw new HttpError(400, 'action 必须是 save/restart')
    }),
  )

  register(
    ApiPaths.hostsRejudge,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      requireConfirm(body, 'rejudge 滞留记录')
      const result = await ops.rejudgeStale(id)
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsDatabase,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const status = await ops.databaseStatus(id)
      sendJson(response, 200, status)
    }),
  )

  register(
    ApiPaths.hostsDiagnosis,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const result = await ops.diagnosis(id)
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsPlugins,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      if (body.action === 'list') {
        const plugins: PluginListResponse = await ops.listPlugins(id)
        sendJson(response, 200, plugins)
        return
      }
      if (body.action !== 'install' && body.action !== 'uninstall' && body.action !== 'enable' && body.action !== 'disable') {
        throw new HttpError(400, 'action 必须是 list/install/uninstall/enable/disable')
      }
      requireConfirm(body, '修改 Hydro 插件')
      const name = optionalString(body.name)
      if (name === undefined || name.trim() === '') throw new HttpError(400, '缺少插件名 name')
      const result = await ops.managePlugin(id, { action: body.action, name: name.trim() })
      sendJson(response, 200, result)
    }),
  )

  register(
    ApiPaths.hostsBackups,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const backups: BackupsResponse = await ops.listBackups(id)
      sendJson(response, 200, backups)
    }),
  )

  register(
    ApiPaths.hostsCaddy,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = requireId(body)
      const action = body.action
      if (action === 'status' || action === 'read') {
        const caddy: CaddyResponse = await ops.readCaddy(id)
        sendJson(response, 200, caddy)
        return
      }
      if (action === 'write') {
        requireConfirm(body, '保存 Caddy 配置')
        const path = optionalString(body.path)
        if (path === undefined || path.trim() === '') throw new HttpError(400, '缺少 Caddyfile 路径')
        if (typeof body.content !== 'string') throw new HttpError(400, '缺少配置内容')
        const result = await ops.writeCaddy(id, {
          path: path.trim(),
          content: body.content,
          reload: body.reload !== false,
        })
        sendJson(response, 200, result)
        return
      }
      if (action === 'validate' || action === 'reload') {
        requireConfirm(body, action === 'reload' ? '重载 Caddy' : '校验 Caddy 配置')
        const result = await ops.applyCaddy(id, action)
        sendJson(response, 200, result)
        return
      }
      throw new HttpError(400, "action 必须是 status/read/write/validate/reload")
    }),
  )

  register(
    ApiPaths.hostsCliStream,
    streaming(deps, async (_request, response, body) => {
      const id = requireId(body)
      const action = body.action === 'restore' ? 'restore' : 'run'
      if (action === 'restore') {
        requireConfirm(body, '恢复备份')
        const filename = optionalString(body.filename)
        if (filename === undefined || filename.trim() === '') throw new HttpError(400, '缺少备份文件名')
        openSse(response)
        try {
          const result = await ops.restoreBackup(id, filename.trim(), (chunk) => { writeSse(response, 'output', chunk) })
          writeSse(response, 'result', { ok: result.exitCode === 0, exitCode: result.exitCode, output: '' })
        } catch (error) {
          writeSse(response, 'error', { message: errorMessage(error) })
        } finally {
          response.end()
        }
        return
      }
      const command = optionalString(body.command)
      if (command === undefined || command.trim() === '') throw new HttpError(400, '缺少 command')
      openSse(response)
      try {
        const result = await ops.runCli(id, command.trim(), (chunk) => { writeSse(response, 'output', chunk) })
        writeSse(response, 'result', { ok: result.exitCode === 0, exitCode: result.exitCode, output: result.output })
      } catch (error) {
        writeSse(response, 'error', { message: errorMessage(error) })
      } finally {
        response.end()
      }
    }),
  )

  const community = deps.community
  if (community !== undefined) {
    register(
      ApiPaths.communityStatus,
      guarded(deps, { mutating: false }, async (request, response) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        await community.load()
        const payload: CommunityConfigResponse = community.getConfig()
        sendJson(response, 200, payload)
      }),
    )
    register(
      ApiPaths.communityConfig,
      guarded(deps, { mutating: true }, async (request, response, body) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值')
        const intervalMinutes = typeof body.intervalMinutes === 'number' ? body.intervalMinutes : 10
        const domain = optionalString(body.domain) ?? 'system'
        const siteAccountId = optionalString(body.siteAccountId)
        const replyPersona = optionalString(body.replyPersona) ?? community.getConfig().replyPersona
        await community.load()
        const config = await community.saveConfig({
          enabled: body.enabled,
          intervalMinutes,
          domain,
          siteAccountId: siteAccountId === '' ? null : siteAccountId,
          replyPersona,
        })
        const payload: CommunityConfigResponse = config
        sendJson(response, 200, payload)
      }),
    )
    register(
      ApiPaths.communityFeed,
      guarded(deps, { mutating: false }, async (request, response, body) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        const siteAccountId = optionalString(body.siteAccountId)
        if (siteAccountId === undefined || siteAccountId === '') throw new HttpError(400, '缺少 siteAccountId')
        const domain = optionalString(body.domain) ?? community.getConfig().domain
        const limit = typeof body.limit === 'number' ? body.limit : 20
        await community.load()
        const feed = await community.feed(siteAccountId, domain, limit)
        const payload: CommunityFeedResponse = feed
        sendJson(response, 200, payload)
      }),
    )
    register(
      ApiPaths.communityThread,
      guarded(deps, { mutating: false }, async (request, response, body) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        const siteAccountId = optionalString(body.siteAccountId)
        const did = optionalString(body.did)
        if (siteAccountId === undefined || siteAccountId === '') throw new HttpError(400, '缺少 siteAccountId')
        if (did === undefined || did === '') throw new HttpError(400, '缺少 did')
        await community.load()
        const thread = await community.thread(siteAccountId, did)
        const payload: CommunityThreadResponse = thread
        sendJson(response, 200, payload)
      }),
    )
    register(
      ApiPaths.communityReply,
      guarded(deps, { mutating: true }, async (request, response, body) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        if (ops.isGloballyReadonly()) throw new HttpError(403, '全局只读已开启，拒绝回复讨论')
        requireConfirm(body, '回复讨论')
        const siteAccountId = optionalString(body.siteAccountId)
        const did = optionalString(body.did)
        const content = optionalString(body.content)
        if (siteAccountId === undefined || siteAccountId === '') throw new HttpError(400, '缺少 siteAccountId')
        if (did === undefined || did === '') throw new HttpError(400, '缺少 did')
        if (content === undefined || content.trim() === '') throw new HttpError(400, '回复内容不能为空')
        await community.load()
        await community.reply(siteAccountId, did, content)
        sendJson(response, 200, { ok: true, message: '已回复讨论' })
      }),
    )
    register(
      ApiPaths.communityPoll,
      guarded(deps, { mutating: true }, async (request, response, body) => {
        if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
        await community.load()
        const siteAccountId = optionalString(body.siteAccountId)
        if (siteAccountId !== undefined && siteAccountId !== '') {
          await community.saveConfig({ siteAccountId })
        }
        const result = await community.poll()
        const payload: CommunityPollResponse = result
        sendJson(response, 200, payload)
      }),
    )
  }

  register(
    ApiPaths.settings,
    guarded(deps, { mutating: false }, async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response, 'GET'); return }
      const settings = ops.getUiSettings()
      const payload: UiSettingsResponse = {
        readonlyMode: ops.isGloballyReadonly(),
        updatedAt: settings.updatedAt,
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.settingsReadonly,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      if (typeof body.readonly !== 'boolean') throw new HttpError(400, 'readonly 必须是布尔值')
      const settings = await ops.setGlobalReadonly(body.readonly)
      const payload: UiSettingsResponse = {
        readonlyMode: ops.isGloballyReadonly(),
        updatedAt: settings.updatedAt,
      }
      sendJson(response, 200, payload)
    }),
  )

  /* ------------------------------------------------------------------ */
  /* Site operations                                                  */
  /* ------------------------------------------------------------------ */

  const site = deps.site
  if (site === undefined) return

  /** Resolve one site account and enforce the effective read-only state. */
  const requireSiteAccount = (id: string): import('./shared/api.js').SiteAccountSummary => {
    const account = site.getAccount(id)
    if (account === undefined) throw new HttpError(404, `未知站点账号 ${id}`)
    return account
  }
  const assertSiteWritable = (account: import('./shared/api.js').SiteAccountSummary): void => {
    if (ops.isGloballyReadonly()) throw new HttpError(403, '全局只读已开启，拒绝修改站点；请先在右上角关闭只读开关。')
    if (account.readonly) throw new HttpError(403, '该站点账号仍带有旧的只读标记，拒绝修改站点')
    const host = ops.getAccountSummary(account.hostId)
    if (host?.readonly === true) throw new HttpError(403, '该主机仍带有旧的只读标记，拒绝修改站点')
  }
  const siteIdFrom = (body: Record<string, unknown>): string => {
    const id = body.siteAccountId ?? body.id
    if (typeof id !== 'string' || id.trim() === '') throw new HttpError(400, '缺少 siteAccountId')
    return id.trim()
  }

  register(
    ApiPaths.siteAccounts,
    guarded(deps, { mutating: false }, async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response, 'GET'); return }
      const payload: SiteAccountsResponse = {
        accounts: site.listAccounts(),
        activeSiteAccountId: site.activeSiteAccountId(),
      }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.siteSave,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id.trim() : undefined
      const hostId = typeof body.hostId === 'string' ? body.hostId.trim() : ''
      if (id === undefined && hostId === '') throw new HttpError(400, '缺少 hostId')
      if (id !== undefined) {
        requireSiteAccount(id)
      } else {
        const host = ops.getAccountSummary(hostId)
        if (host === undefined) throw new HttpError(404, `未知主机 ${hostId}`)
        if (optionalString(body.uname) === undefined || optionalString(body.uname)!.trim() === '') {
          throw new HttpError(400, '请填写 Hydro 管理员用户名')
        }
      }
      const role = body.role
      const roles = ['superadmin', 'domain-admin', 'problem-setter', 'judge', 'custom'] as const
      if (role !== undefined && (typeof role !== 'string' || !roles.includes(role as (typeof roles)[number]))) {
        throw new HttpError(400, `role 必须是 ${roles.join('/')}`)
      }
      const account = await site.saveAccount({
        ...(id === undefined ? {} : { id }),
        hostId,
        ...(optionalString(body.label) === undefined ? {} : { label: optionalString(body.label)! }),
        ...(optionalString(body.uname) === undefined ? {} : { uname: optionalString(body.uname)! }),
        ...(optionalString(body.domain) === undefined ? {} : { domain: optionalString(body.domain)! }),
        ...(role === undefined ? {} : { role: role as (typeof roles)[number] }),
        ...(optionalString(body.note) === undefined ? {} : { note: optionalString(body.note)! }),
        ...(typeof body.readonly === 'boolean' ? { readonly: body.readonly } : {}),
      })
      const payload: SiteSaveResponse = { account }
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.siteRemove,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') throw new HttpError(400, '缺少 id')
      requireSiteAccount(id)
      const removed = await site.removeAccount(id)
      sendJson(response, 200, { removed })
    }),
  )

  register(
    ApiPaths.siteActivate,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const raw = body.id
      const id = raw === null ? null : typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
      if (id === undefined) throw new HttpError(400, '缺少 id')
      if (id !== null) requireSiteAccount(id)
      await site.setActive(id)
      sendJson(response, 200, { activeSiteAccountId: site.activeSiteAccountId() })
    }),
  )

  register(
    ApiPaths.siteInspect,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      requireSiteAccount(id)
      const payload: SiteInspectResponse = await site.inspect(id)
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.siteDomainSet,
    guarded(deps, { mutating: true }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      const account = requireSiteAccount(id)
      assertSiteWritable(account)
      requireConfirm(body, '修改域配置')
      const values = optionalObject(body.values)
      if (values === undefined) throw new HttpError(400, 'values 必须是 JSON 对象')
      const booleanKeys = optionalObject(body.booleanKeys) as Record<string, boolean> | undefined
      await site.setDomain(id, values as Record<string, string | number | boolean>, booleanKeys)
      sendJson(response, 200, { ok: true, message: '域配置已更新' })
    }),
  )

  register(
    ApiPaths.siteCollection,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      requireSiteAccount(id)
      if (body.collection !== 'problem' && body.collection !== 'contest') {
        throw new HttpError(400, "collection 必须是 'problem' 或 'contest'")
      }
      const limit = typeof body.limit === 'number' ? body.limit : 20
      const payload: SiteCollectionResponse = await site.listCollection(id, body.collection, limit)
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.siteDomains,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      requireSiteAccount(id)
      const domains: SiteDomainsResponse = await site.listDomains(id)
      sendJson(response, 200, domains)
    }),
  )

  register(
    ApiPaths.siteSession,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const siteAccountId = optionalString(body.siteAccountId)
      if (siteAccountId === undefined || siteAccountId === '') throw new HttpError(400, '缺少 siteAccountId')
      if (site === undefined) throw new HttpError(503, '站点服务未启用')
      const status: SiteSessionStatus = await site.sessionStatus(siteAccountId)
      sendJson(response, 200, status)
    }),
  )

  register(
    ApiPaths.siteQuestionsImportZip,
    guarded(deps, { mutating: true, maxBodyBytes: 96 * 1024 * 1024 }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      const account = requireSiteAccount(id)
      assertSiteWritable(account)
      const filename = optionalString(body.filename)
      const data = optionalString(body.data)
      if (filename === undefined || filename.trim() === '') throw new HttpError(400, '缺少 filename')
      if (data === undefined || data === '') throw new HttpError(400, '缺少 ZIP 文件内容')
      let buffer: Buffer
      try {
        buffer = Buffer.from(data, 'base64')
      } catch {
        throw new HttpError(400, 'ZIP 文件不是合法 base64')
      }
      if (buffer.length === 0) throw new HttpError(400, 'ZIP 文件为空')
      if (buffer.length > 64 * 1024 * 1024) throw new HttpError(413, 'ZIP 文件超过 64 MiB')
      if (!filename.trim().toLowerCase().endsWith('.zip')) throw new HttpError(400, '只支持 .zip 题包')
      const result = await site.importHydroZip(id, {
        filename: filename.trim(),
        data: buffer,
        ...(typeof body.hidden === 'boolean' ? { hidden: body.hidden } : {}),
        ...(optionalString(body.preferredPrefix) === undefined ? {} : { preferredPrefix: optionalString(body.preferredPrefix)! }),
      })
      const payload: QuestionZipImportResponse = result
      sendJson(response, 200, payload)
    }),
  )

  register(
    ApiPaths.siteAuthoringPrompt,
    guarded(deps, { mutating: false }, async (request, response, body) => {
      if (request.method !== 'POST') { methodNotAllowed(response, 'POST'); return }
      const id = siteIdFrom(body)
      requireSiteAccount(id)
      const kinds = ['problem', 'contest', 'domain-bulletin', 'domain-permissions', 'discussion-reply'] as const
      if (typeof body.kind !== 'string' || !kinds.includes(body.kind as (typeof kinds)[number])) {
        throw new HttpError(400, `kind 必须是 ${kinds.join('/')}`)
      }
      const prompt = await site.authoringPrompt(id, {
        kind: body.kind as (typeof kinds)[number],
        ...(optionalString(body.title) === undefined ? {} : { title: optionalString(body.title)! }),
        ...(optionalString(body.requirements) === undefined ? {} : { requirements: optionalString(body.requirements)! }),
        ...(optionalString(body.domain) === undefined ? {} : { domain: optionalString(body.domain)! }),
        ...(optionalString(body.problemId) === undefined ? {} : { problemId: optionalString(body.problemId)! }),
        ...(optionalString(body.contestId) === undefined ? {} : { contestId: optionalString(body.contestId)! }),
        ...(optionalString(body.discussionId) === undefined ? {} : { discussionId: optionalString(body.discussionId)! }),
        ...(optionalString(body.action) === undefined ? {} : { action: optionalString(body.action)! }),
      })
      const payload: AuthoringPromptResponse = { prompt }
      sendJson(response, 200, payload)
    }),
  )
}
