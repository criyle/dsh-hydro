/**
 * Admin-side Hydro HTTP client speaking to the remote HydO over an SSH tunnel.
 *
 * Hydro and MongoDB listen on the remote loopback only, so every request here
 * goes through {@link openTunnel}. The session keeps the `sid` cookie returned
 * by `POST /login` and sends it with every later request; `Accept:
 * application/json` makes Hydro answer with JSON instead of rendered HTML.
 *
 * Design notes (see `docs/research/hydro-internals.md` §6):
 *  - POST needs a same-origin `Referer` or no `Referer` at all (CSRF check);
 *    the session always sends one, computed from its own tunnel URL.
 *  - A redirect response is not an error for our purposes; Hydro answers JSON
 *    as `{ "url": "..." }` on success and the body carries the created pid/rid.
 *  - Every mutating helper posts the `operation` dispatch key both in the query
 *    string and in the form body, because different Hydro handlers read it from
 *    different places.
 *  - Success payloads are returned as-is; 4xx/5xx become {@link HydroHttpError}
 *    with Hydro's `error.message` when present.
 */
import { openTunnel } from '../ops/tunnel.js'
import type { Tunnel } from '../ops/tunnel.js'
import type { AccountContext } from '../ops/types.js'

/** Form value accepted by {@link urlEncodeForm}. `undefined` values are dropped. */
export type HydroFormValue = string | number | boolean | undefined | ReadonlyArray<string | number>

/** Options for one low-level session request. */
export interface HydroRequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** Options for {@link openHydroSession}. */
export interface HydroSessionOptions {
  /** Remote Hydro HTTP port (usually 8888). */
  port: number
  /** Hydro admin username; informational only. */
  uname?: string
  /** Browser-captured `sid` session cookie. */
  sid?: string
  /** Cancels the session's in-flight requests. */
  signal?: AbortSignal
}

/** One multipart file upload. */
export interface HydroMultipartFile {
  name: string
  data: Buffer | string
  /** MIME type; defaults to `application/octet-stream`. */
  type?: string
}

/** Body variants accepted by {@link HydroSession.request}. */
export interface HydroRequestInit {
  method?: string
  form?: Record<string, HydroFormValue>
  multipart?: {
    fields?: Record<string, string>
    file?: HydroMultipartFile
  }
  json?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** A live, optionally authenticated admin HTTP session. */
export interface HydroSession {
  /** Local tunnel base URL, e.g. `http://127.0.0.1:53210`. */
  baseUrl: string
  /** One raw request; resolves for any HTTP status, throws only on transport errors. */
  request(
    path: string,
    init: HydroRequestInit,
  ): Promise<{ status: number; body: any; headers: Headers }>
  /** GET a JSON resource. Throws {@link HydroHttpError} for status >= 400. */
  getJson<T = any>(path: string, options?: HydroRequestOptions): Promise<T>
  /** POST an urlencoded form and return the JSON body. */
  postForm<T = any>(path: string, form: Record<string, HydroFormValue>, options?: HydroRequestOptions): Promise<T>
  /** POST one multipart file (plus text fields) and return the JSON body. */
  postMultipart<T = any>(
    path: string,
    file: HydroMultipartFile,
    fields?: Record<string, string>,
    options?: HydroRequestOptions,
  ): Promise<T>
  /** Release the SSH tunnel. Idempotent. */
  close(): Promise<void>
}

/** An HTTP response that Hydro answered with an error envelope. */
export class HydroHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: unknown,
  ) {
    super(`Hydro 请求失败（HTTP ${String(status)}，${path}）：${describeError(body)}`)
    this.name = 'HydroHttpError'
  }
}

/** Extract a human-readable message from Hydro's `{error:{message}}` envelope. */
function describeError(body: unknown): string {
  if (body === null || body === undefined) return '(empty response)'
  if (typeof body === 'string') return body.slice(0, 500) || '(empty response)'
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>
    const error = record.error
    if (typeof error === 'string') return error
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message !== '') return message
    }
    const message = record.message
    if (typeof message === 'string' && message !== '') return message
  }
  try {
    return JSON.stringify(body).slice(0, 500)
  } catch {
    return String(body).slice(0, 500)
  }
}

/**
 * Encode a flat form body as `application/x-www-form-urlencoded`.
 *
 * `undefined` entries are dropped; booleans become `true`/`false`. Hydro
 * checkboxes are better expressed as `'on'`/absent, so the operation helpers in
 * this module build those strings explicitly.
 */
export function urlEncodeForm(form: Record<string, HydroFormValue>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.append(key, String(value))
    }
  }
  return params.toString()
}

/** Minimal cookie jar: Hydro only needs the `sid` session cookie. */
class CookieJar {
  private readonly cookies = new Map<string, string>()

  seed(name: string, value: string): void {
    if (name.trim() !== '' && value.trim() !== '') this.cookies.set(name.trim(), value.trim())
  }

  addFrom(headers: Headers): void {
    for (const raw of setCookies(headers)) {
      const pair = raw.split(';', 1)[0]
      if (pair === undefined) continue
      const index = pair.indexOf('=')
      if (index <= 0) continue
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/** `Headers.getSetCookie` with a fallback for environments without it. */
function setCookies(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie()
  const single = headers.get('set-cookie')
  return single === null ? [] : [single]
}

/** Join a base URL and an absolute-ish path. */
function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
}

/**
 * Path prefix for one Hydro domain.
 *
 * Hydro's `system` domain has no prefix; every other domain lives under
 * `/d/<domainId>/...`. The domain middleware strips the prefix, so handlers see
 * the same path either way.
 */
export function domainPath(domain: string, path: string): string {
  const clean = domain.trim()
  if (clean === '' || clean === 'system') return path
  return `/d/${encodeURIComponent(clean)}${path}`
}

/**
 * Open a session to the remote Hydro through a fresh (or shared) SSH tunnel.
 *
 * When both `uname` and `password` are given the session logs in immediately;
 * otherwise it stays anonymous and callers may use {@link loginHydro} later.
 */
export async function openHydroSession(context: AccountContext, options: HydroSessionOptions): Promise<HydroSession> {
  const tunnel: Tunnel = await openTunnel(context, { remotePort: options.port })
  const jar = new CookieJar()
  if (options.sid !== undefined && options.sid !== '') jar.seed('sid', options.sid)
  const baseUrl = tunnel.baseUrl
  const defaultSignal = options.signal ?? context.signal

  async function request(
    path: string,
    init: HydroRequestInit,
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const url = joinUrl(baseUrl, path)
    const headers: Record<string, string> = { accept: 'application/json' }
    // Same-origin Referer keeps Hydro's CSRF check happy; the tunnel host is our
    // own local listener, so this is always same-host.
    headers.referer = `${baseUrl}/`
    for (const [name, value] of Object.entries(init.headers ?? {})) headers[name] = value
    const cookie = jar.header()
    if (cookie !== undefined) headers.cookie = cookie

    let body: RequestInit['body'] | undefined
    if (init.multipart !== undefined) {
      const form = new FormData()
      for (const [name, value] of Object.entries(init.multipart.fields ?? {})) form.set(name, value)
      if (init.multipart.file !== undefined) {
        const file = init.multipart.file
        const data = Buffer.isBuffer(file.data) ? new Uint8Array(file.data) : new TextEncoder().encode(file.data)
        form.set('file', new Blob([data], { type: file.type ?? 'application/octet-stream' }), file.name)
      }
      body = form
    } else if (init.form !== undefined) {
      body = urlEncodeForm(init.form)
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    } else if (init.json !== undefined) {
      body = JSON.stringify(init.json)
      headers['content-type'] = 'application/json; charset=utf-8'
    }

    const signal = init.signal ?? defaultSignal
    const response = await fetch(url, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    })
    jar.addFrom(response.headers)
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    let parsed: any = text
    if (contentType.includes('json')) {
      if (text.trim() === '') parsed = null
      else {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      }
    }
    return { status: response.status, body: parsed, headers: response.headers }
  }

  function ensureOk(path: string, response: { status: number; body: any; headers?: Headers }): void {
    const location = response.headers?.get('location') ?? ''
    if (response.status === 401 || (response.status === 302 && /\/login(?:[/?#]|$)/.test(location))) {
      throw new Error('Hydro 登录已过期：请在内嵌浏览器中重新登录该账号。')
    }
    if (response.status < 400) return
    throw new HydroHttpError(response.status, path, response.body)
  }

  const session: HydroSession = {
    baseUrl,
    request,
    async getJson<T = any>(path: string, requestOptions?: HydroRequestOptions): Promise<T> {
      const response = await request(path, {
        method: 'GET',
        ...(requestOptions?.headers === undefined ? {} : { headers: requestOptions.headers }),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      })
      ensureOk(path, response)
      return response.body as T
    },
    async postForm<T = any>(
      path: string,
      form: Record<string, HydroFormValue>,
      requestOptions?: HydroRequestOptions,
    ): Promise<T> {
      const response = await request(path, {
        method: 'POST',
        form,
        ...(requestOptions?.headers === undefined ? {} : { headers: requestOptions.headers }),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      })
      ensureOk(path, response)
      return response.body as T
    },
    async postMultipart<T = any>(
      path: string,
      file: HydroMultipartFile,
      fields?: Record<string, string>,
      requestOptions?: HydroRequestOptions,
    ): Promise<T> {
      const response = await request(path, {
        method: 'POST',
        multipart: { file, ...(fields === undefined ? {} : { fields }) },
        ...(requestOptions?.headers === undefined ? {} : { headers: requestOptions.headers }),
        ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
      })
      ensureOk(path, response)
      return response.body as T
    },
    async close(): Promise<void> {
      await tunnel.release()
    },
  }

  return session
}

/**
 * Log in with `POST /login` and keep the returned `sid` cookie in the session.
 *
 * Hydro rate-limits failed logins (per IP and per username); a failure surfaces
 * as {@link HydroHttpError} with Hydro's message.
 */
export async function loginHydro(
  context: AccountContext,
  session: HydroSession,
  uname: string,
  password: string,
): Promise<void> {
  const response = await session.request('/login', {
    method: 'POST',
    form: { uname, password, rememberme: 'on' },
  })
  if (response.status >= 400) {
    throw new HydroHttpError(response.status, '/login', response.body)
  }
  // A successful login must have produced a session cookie; without it every
  // later admin call would silently behave like an anonymous visitor.
  const hasSession = setCookies(response.headers).some((cookie) => /(?:^|;\s*)sid=/.test(cookie))
  if (!hasSession) {
    throw new Error('Hydro 登录成功但未返回 sid cookie，请确认账号/密码与站点登录方式')
  }
  context.log(`Hydro admin login ok for ${uname}`)
}

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

/** Extract a pid from `{pid}` or from a redirect url like `/p/P1000`. */
function extractPid(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.pid === 'string' && record.pid !== '') return record.pid
  if (typeof record.docId === 'string' && record.docId !== '') return record.docId
  const url = typeof record.url === 'string' ? record.url : typeof record.redirect === 'string' ? record.redirect : ''
  return matchUrlId(url, /\/p\/([^/?#]+)/)
}

/** Extract a rid from `{rid}` or from a redirect url like `/record/<id>`. */
function extractRid(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.rid === 'string' && record.rid !== '') return record.rid
  if (typeof record._id === 'string' && record._id !== '') return record._id
  const url = typeof record.url === 'string' ? record.url : typeof record.redirect === 'string' ? record.redirect : ''
  return matchUrlId(url, /\/record\/([^/?#]+)/)
}

/** Extract a tid from `{tid}` or from a redirect url like `/contest/<id>`. */
function extractTid(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (typeof record.tid === 'string' && record.tid !== '') return record.tid
  if (typeof record.docId === 'string' && record.docId !== '') return record.docId
  const url = typeof record.url === 'string' ? record.url : typeof record.redirect === 'string' ? record.redirect : ''
  return matchUrlId(url, /\/contest\/([^/?#]+)/)
}

function matchUrlId(url: string, pattern: RegExp): string | null {
  const match = pattern.exec(url)
  const value = match?.[1]
  if (value === undefined || value === '') return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Trim the problem content to a sane size before sending it to Hydro. */
function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

/* ------------------------------------------------------------------ */
/* Problem operations                                                  */
/* ------------------------------------------------------------------ */

/** Create a problem and return its pid. */
export async function createProblem(
  session: HydroSession,
  input: {
    domain: string
    title: string
    content: string
    pid?: string
    hidden?: boolean
    difficulty?: number
    tags?: string[]
  },
): Promise<{ pid: string }> {
  const path = domainPath(input.domain, '/problem/create')
  const form: Record<string, HydroFormValue> = {
    title: input.title,
    content: normalizeContent(input.content),
  }
  if (input.pid !== undefined && input.pid !== '') form.pid = input.pid
  if (input.hidden === true) form.hidden = 'on'
  if (input.difficulty !== undefined) form.difficulty = input.difficulty
  if (input.tags !== undefined && input.tags.length > 0) form.tag = input.tags.join(',')
  const body = await session.postForm(path, form)
  const pid = extractPid(body)
  if (pid === null) {
    throw new Error(`创建题目成功但响应中没有 pid：${JSON.stringify(body).slice(0, 500)}`)
  }
  return { pid }
}

/** Edit a problem's statement/visibility/difficulty. Returns the (possibly new) pid. */
export async function editProblem(
  session: HydroSession,
  input: {
    domain: string
    pid: string
    title?: string
    content?: string
    hidden?: boolean
    difficulty?: number
    tags?: string[]
  },
): Promise<{ pid: string }> {
  const path = domainPath(input.domain, `/p/${encodeURIComponent(input.pid)}/edit`)
  const form: Record<string, HydroFormValue> = {}
  if (input.title !== undefined) form.title = input.title
  if (input.content !== undefined) form.content = normalizeContent(input.content)
  // Checkbox semantics: `'on'` means checked; omitted means unchecked. Never
  // send a falsy string, because Hydro treats any present value as truthy.
  if (input.hidden === true) form.hidden = 'on'
  if (input.difficulty !== undefined) form.difficulty = input.difficulty
  if (input.tags !== undefined && input.tags.length > 0) form.tag = input.tags.join(',')
  const body = await session.postForm(path, form)
  return { pid: extractPid(body) ?? input.pid }
}

/** Build the multipart body of one testdata/config upload. */
function testdataUpload(
  session: HydroSession,
  input: { domain: string; pid: string; name: string; data: Buffer | string; type?: 'testdata' | 'additional_file' },
): Promise<unknown> {
  const type = input.type ?? 'testdata'
  const name = input.name
  const path = domainPath(
    input.domain,
    `/p/${encodeURIComponent(input.pid)}/files?operation=upload_file&type=${encodeURIComponent(type)}`,
  )
  return session.postMultipart(
    path,
    { name, data: input.data, type: 'application/octet-stream' },
    { operation: 'upload_file', filename: name, type },
  )
}

/**
 * Upload one file into a problem's `testdata` (or `additional_file`) store.
 *
 * `config.yaml` is a normal testdata file: upload it through this helper.
 */
export async function uploadTestdataFile(
  session: HydroSession,
  input: {
    domain: string
    pid: string
    name: string
    data: Buffer | string
    type?: 'testdata' | 'additional_file'
  },
): Promise<void> {
  await testdataUpload(session, input)
}

/** Upload a `.zip`; Hydro expands `testdata` archives automatically on its side. */
export async function uploadTestdataZip(
  session: HydroSession,
  input: { domain: string; pid: string; name: string; data: Buffer },
): Promise<void> {
  if (!input.name.toLowerCase().endsWith('.zip')) {
    throw new Error(`uploadTestdataZip 需要 .zip 文件名，收到：${input.name}`)
  }
  await testdataUpload(session, { ...input, type: 'testdata' })
}

/** Submit a solution and return the judge record id. */
export async function submitSolution(
  session: HydroSession,
  input: { domain: string; pid: string; lang: string; code: string },
): Promise<{ rid: string }> {
  const path = domainPath(input.domain, `/p/${encodeURIComponent(input.pid)}/submit`)
  const body = await session.postForm(path, { lang: input.lang, code: input.code })
  const rid = extractRid(body)
  if (rid === null) {
    throw new Error(`提交成功但响应中没有 rid：${JSON.stringify(body).slice(0, 500)}`)
  }
  return { rid }
}

/** Read one problem's config.yaml and testdata file names. */
export async function getProblemConfig(
  session: HydroSession,
  input: { domain: string; pid: string },
): Promise<{ config: string; testdata: string[] }> {
  const body = await session.getJson<any>(domainPath(input.domain, `/p/${encodeURIComponent(input.pid)}/config`))
  const record = (body ?? {}) as Record<string, unknown>
  const rawTestdata = record.testdata
  const testdata: string[] = []
  if (Array.isArray(rawTestdata)) {
    for (const item of rawTestdata) {
      if (typeof item === 'string') {
        testdata.push(item)
        continue
      }
      if (item !== null && typeof item === 'object') {
        const name = (item as Record<string, unknown>).name
        if (typeof name === 'string') testdata.push(name)
      }
    }
  } else if (rawTestdata !== null && typeof rawTestdata === 'object') {
    testdata.push(...Object.keys(rawTestdata as Record<string, unknown>))
  }
  return {
    config: typeof record.config === 'string' ? record.config : '',
    testdata: testdata.sort((left, right) => left.localeCompare(right)),
  }
}

/** Read a problem's title/hidden/difficulty for the `info` action. */
export async function getProblemMeta(
  session: HydroSession,
  input: { domain: string; pid: string },
): Promise<{ pid: string; title: string | null; hidden: boolean | null; difficulty: number | null }> {
  const body = await session.getJson<any>(domainPath(input.domain, `/p/${encodeURIComponent(input.pid)}`))
  const record = (body ?? {}) as Record<string, unknown>
  const pdoc = record.pdoc !== null && typeof record.pdoc === 'object'
    ? (record.pdoc as Record<string, unknown>)
    : record
  const title = typeof pdoc.title === 'string' ? pdoc.title : null
  const hidden = typeof pdoc.hidden === 'boolean' ? pdoc.hidden : null
  const difficulty = typeof pdoc.difficulty === 'number' ? pdoc.difficulty : null
  return { pid: extractPid(pdoc) ?? input.pid, title, hidden, difficulty }
}

/* ------------------------------------------------------------------ */
/* Domain config                                                       */
/* ------------------------------------------------------------------ */

/** Read a domain's current settings (and the settings schema Hydro exposes). */
export async function getDomainConfig(
  session: HydroSession,
  domain: string,
): Promise<{ current: Record<string, unknown>; settings: unknown }> {
  const body = await session.getJson<any>(domainPath(domain, '/domain/edit'))
  if (body === null || typeof body !== 'object') {
    throw new Error(`读取域 ${domain} 配置失败：响应不是 JSON 对象`)
  }
  const record = body as Record<string, unknown>
  const current = record.current !== null && typeof record.current === 'object'
    ? (record.current as Record<string, unknown>)
    : {}
  return { current, settings: record.settings ?? null }
}

/**
 * Update a domain's settings.
 *
 * Scalar values go in as normal form fields; booleans must be sent as
 * `booleanKeys[<key>]=on` (Hydro's convention for checkbox groups). Booleans
 * found in `values` are routed to `booleanKeys` automatically.
 */
export async function setDomainConfig(
  session: HydroSession,
  domain: string,
  values: Record<string, HydroFormValue>,
  booleanKeys?: Record<string, boolean>,
): Promise<void> {
  const path = domainPath(domain, '/domain/edit')
  const form: Record<string, HydroFormValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    if (typeof value === 'boolean') {
      if (value) form[`booleanKeys[${key}]`] = 'on'
      continue
    }
    form[key] = value
  }
  for (const [key, value] of Object.entries(booleanKeys ?? {})) {
    if (value) form[`booleanKeys[${key}]`] = 'on'
  }
  await session.postForm(path, form)
}

/* ------------------------------------------------------------------ */
/* Contests                                                            */
/* ------------------------------------------------------------------ */

/** Fields shared by contest create and edit. */
interface ContestPayload {
  domain: string
  title: string
  content: string
  rule: string
  beginAtDate: string
  beginAtTime: string
  durationHours: number
  pids: Array<string | number>
  rated?: boolean
  autoHide?: boolean
  lockMinutes?: number
}

function contestForm(input: ContestPayload): Record<string, HydroFormValue> {
  const form: Record<string, HydroFormValue> = {
    operation: 'update',
    title: input.title,
    content: normalizeContent(input.content),
    rule: input.rule,
    beginAtDate: input.beginAtDate,
    beginAtTime: input.beginAtTime,
    duration: input.durationHours,
    pids: input.pids.map(String).join(','),
  }
  if (input.rated === true) form.rated = 'on'
  if (input.autoHide === true) form.autoHide = 'on'
  if (input.lockMinutes !== undefined) form.lock = input.lockMinutes
  return form
}

/** Create a contest and return its tid. */
export async function createContest(
  session: HydroSession,
  input: ContestPayload,
): Promise<{ tid: string }> {
  const path = domainPath(input.domain, '/contest/create?operation=update')
  const body = await session.postForm(path, contestForm(input))
  const tid = extractTid(body)
  if (tid === null) {
    throw new Error(`创建比赛成功但响应中没有 tid：${JSON.stringify(body).slice(0, 500)}`)
  }
  return { tid }
}

/** Update a contest's metadata and problem list in one request. */
export async function editContestProblems(
  session: HydroSession,
  input: ContestPayload & { tid: string },
): Promise<void> {
  const path = domainPath(input.domain, `/contest/${encodeURIComponent(input.tid)}/edit?operation=update`)
  await session.postForm(path, contestForm(input))
}

/** Send a broadcast announcement (clarification) to contest participants. */
export async function announceContest(
  session: HydroSession,
  input: { domain: string; tid: string; content: string; subject?: number },
): Promise<void> {
  const path = domainPath(input.domain, `/contest/${encodeURIComponent(input.tid)}/clarification`)
  await session.postForm(path, {
    content: normalizeContent(input.content),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
  })
}

/** Delete a contest (Hydro removes its discussions, records and files). */
export async function deleteContest(
  session: HydroSession,
  input: { domain: string; tid: string },
): Promise<void> {
  const path = domainPath(input.domain, `/contest/${encodeURIComponent(input.tid)}/edit`)
  await session.postForm(path, { operation: 'delete' })
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Convert an instant to Hydro's contest form fields.
 *
 * `beginAtDate` is `YYYY-MM-DD` and `beginAtTime` is `HH:MM`. The conversion is
 * done in `timezone` (IANA name, e.g. `Asia/Shanghai`) or the process-local zone
 * when omitted.
 */
export function toHydroDate(date: Date, timezone?: string): { date: string; time: string } {
  if (Number.isNaN(date.getTime())) throw new Error('无效的日期对象')
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch (error) {
    throw new Error(`无效的时区 ${timezone ?? '(local)'}：${(error as Error).message}`)
  }
  const parts = formatter.formatToParts(date)
  const valueOf = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const dateText = `${valueOf('year')}-${valueOf('month')}-${valueOf('day')}`
  const timeText = `${valueOf('hour')}:${valueOf('minute')}`
  return { date: dateText, time: timeText }
}
