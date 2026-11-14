/**
 * Low-level pieces for operating a remote Hydro install over SSH.
 *
 * This module is deliberately pure where possible: the parse helpers take the
 * raw text of one batched probe script (see `detect.ts`), so they are cheap to
 * unit-test with recorded fixtures. The exec helpers (`runAsRoot`, ...) are the
 * only place where root elevation is chosen, which keeps install/upgrade/
 * service behavior consistent.
 */
import type { ExecResult } from '../ssh/index.js'
import { truncate, OUTPUT_LIMIT, withRemotePath } from '../ops/exec.js'
import type { AccountContext, HydroProbe } from '../ops/types.js'

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

/** MongoDB defaults used when a config file omits connection fields. */
const DEFAULT_MONGO_HOST = '127.0.0.1'
const DEFAULT_MONGO_PORT = 27017

/** A MongoDB connection string split into the pieces dsh-hydro needs. */
export interface ParsedMongoUri {
  host: string
  port: number
  database: string | null
  username: string | null
  password: string | null
  authSource: string | null
  options: Record<string, string>
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10)
    return parsed > 0 && parsed <= 65535 ? parsed : null
  }
  return null
}

/** Split `host`, `host:port`, `[v6]`, `[v6]:port` into host + port. */
function splitHostPort(entry: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = entry.trim()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close !== -1) {
      const host = trimmed.slice(1, close)
      const rest = trimmed.slice(close + 1)
      const port = rest.startsWith(':') ? parsePort(rest.slice(1)) : null
      return { host, port: port ?? fallbackPort }
    }
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    const port = parsePort(trimmed.slice(colon + 1))
    if (port !== null) return { host: trimmed.slice(0, colon), port }
  }
  return { host: trimmed, port: fallbackPort }
}

/**
 * Parse a `mongodb://` (or `mongodb+srv://`) connection string.
 *
 * Credentials are percent-decoded. Only the first host of a replica-set host
 * list is returned; dsh-hydro tunnels a single endpoint.
 * Throws when the string is empty or has no host.
 */
export function parseMongoUri(uri: string): ParsedMongoUri {
  const trimmed = uri.trim()
  if (trimmed.length === 0) throw new Error('MongoDB 连接串为空')
  const scheme = /^(mongodb(?:\+srv)?):\/\//i.exec(trimmed)
  let rest = scheme === null ? trimmed : trimmed.slice(scheme[0].length)
  rest = rest.replace(/^\/+/, '')
  if (rest.length === 0) throw new Error('MongoDB 连接串缺少主机地址')

  let query = ''
  const question = rest.indexOf('?')
  if (question !== -1) {
    query = rest.slice(question + 1)
    rest = rest.slice(0, question)
  }
  let authority = rest
  let path = ''
  const slash = rest.indexOf('/')
  if (slash !== -1) {
    authority = rest.slice(0, slash)
    path = rest.slice(slash + 1)
  }

  let username: string | null = null
  let password: string | null = null
  const at = authority.lastIndexOf('@')
  if (at !== -1) {
    const userinfo = authority.slice(0, at)
    authority = authority.slice(at + 1)
    const colon = userinfo.indexOf(':')
    const rawUser = colon === -1 ? userinfo : userinfo.slice(0, colon)
    const rawPassword = colon === -1 ? '' : userinfo.slice(colon + 1)
    username = safeDecode(rawUser)
    password = colon === -1 ? null : safeDecode(rawPassword)
    if (username === '') username = null
  }

  const hostEntry = authority.split(',')[0]?.trim() ?? ''
  if (hostEntry === '') throw new Error('MongoDB 连接串缺少主机地址')
  const { host, port } = splitHostPort(hostEntry, DEFAULT_MONGO_PORT)

  const pathFirst = path.split('/')[0] ?? ''
  const database = pathFirst === '' ? null : safeDecode(pathFirst) || null

  const options: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq))
    const value = eq === -1 ? '' : safeDecode(pair.slice(eq + 1))
    if (key.length > 0) options[key] = value
  }

  return {
    host,
    port,
    database,
    username,
    password,
    authSource: options.authSource ?? null,
    options,
  }
}

function encodeUserInfo(username: string | null, password: string | null): string {
  if (username === null) return ''
  const user = encodeURIComponent(username)
  const pass = password === null ? '' : `:${encodeURIComponent(password)}`
  return `${user}${pass}@`
}

/** Host part for a URI, bracketing IPv6 literals. */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * Rewrite a MongoDB URI so it points at the local end of an SSH tunnel while
 * preserving credentials, database and options.
 */
export function buildTunnelUri(uri: string, localHost: string, localPort: number): string {
  const parsed = parseMongoUri(uri)
  const userinfo = encodeUserInfo(parsed.username, parsed.password)
  const database = parsed.database === null ? '' : `/${encodeURIComponent(parsed.database)}`
  const options = Object.entries(parsed.options)
  const query =
    options.length === 0
      ? ''
      : `?${options.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
  return `mongodb://${userinfo}${formatHost(localHost)}:${String(localPort)}${database}${query}`
}

/**
 * Parse `~/.hydro/config.json`.
 *
 * The current installer writes `{ "uri": "mongodb://..." }`. `path` is only set
 * when the payload carries one (the probe records the config file path
 * separately).
 */
export function parseHydroConfig(json: string | null): {
  uri: string | null
  database: string | null
  host: string
  port: number
  path: string | null
} {
  const empty = {
    uri: null as string | null,
    database: null as string | null,
    host: DEFAULT_MONGO_HOST,
    port: DEFAULT_MONGO_PORT,
    path: null as string | null,
  }
  if (json === null || json.trim() === '') return empty
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return empty
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return empty
  const record = data as Record<string, unknown>
  const path = typeof record.path === 'string' ? record.path : null

  const uriValue =
    typeof record.uri === 'string'
      ? record.uri
      : typeof record.url === 'string'
        ? record.url
        : null
  if (uriValue !== null && uriValue.trim() !== '') {
    try {
      const parsed = parseMongoUri(uriValue)
      return { uri: uriValue, database: parsed.database, host: parsed.host, port: parsed.port, path }
    } catch {
      return { ...empty, uri: uriValue, path }
    }
  }

  return empty
}

/** Parse the JSON array printed by `pm2 jlist`; returns `[]` for junk. */
export function parsePm2Jlist(text: string): HydroProbe['pm2'] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const candidates = [trimmed]
  const begin = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (begin !== -1 && end > begin) candidates.push(trimmed.slice(begin, end + 1))
  let data: unknown
  for (const candidate of candidates) {
    try {
      data = JSON.parse(candidate)
      break
    } catch {
      // Try the next candidate.
    }
  }
  if (!Array.isArray(data)) return []
  const now = Date.now()
  const result: HydroProbe['pm2'] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const env =
      typeof record.pm2_env === 'object' && record.pm2_env !== null
        ? (record.pm2_env as Record<string, unknown>)
        : {}
    const name = typeof record.name === 'string' ? record.name : typeof env.name === 'string' ? env.name : null
    if (name === null) continue
    const rawPid = record.pid
    const pid = typeof rawPid === 'number' && rawPid > 0 ? rawPid : null
    const restarts = typeof env.restart_time === 'number' ? env.restart_time : null
    const pmUptime = typeof env.pm_uptime === 'number' ? env.pm_uptime : null
    const uptimeMs = pmUptime === null ? null : Math.max(0, now - pmUptime)
    const status = typeof env.status === 'string' ? env.status : 'unknown'
    const execPath = typeof env.pm_exec_path === 'string' ? env.pm_exec_path : null
    const monit =
      typeof record.monit === 'object' && record.monit !== null
        ? (record.monit as Record<string, unknown>)
        : {}
    const cpuPercent = typeof monit.cpu === 'number' ? monit.cpu : null
    const memoryBytes = typeof monit.memory === 'number' ? monit.memory : null
    const outLogPath = typeof env.pm_out_log_path === 'string' ? env.pm_out_log_path : null
    const errLogPath = typeof env.pm_err_log_path === 'string' ? env.pm_err_log_path : null
    result.push({ name, status, pid, restarts, uptimeMs, execPath, cpuPercent, memoryBytes, outLogPath, errLogPath })
  }
  return result
}

/** Extract `yarn global dir` from its (possibly banner-polluted) output. */
export function parseYarnGlobalDir(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const absolute = lines.filter(
    (line) => line.startsWith('/') && !/^(?:Done|info|warning|error)\b/i.test(line),
  )
  if (absolute.length === 0) return null
  const preferred = absolute.filter((line) => /\/yarn\/global\/?$/.test(line) || /\/\.config\/yarn\/global\/?$/.test(line))
  const pool = preferred.length > 0 ? preferred : absolute
  const last = pool[pool.length - 1]
  if (last === undefined) return null
  const normalized = last.replace(/\/+$/, '')
  return normalized === '' ? '/' : normalized
}

/**
 * Classify the remote SSH user from `id -u` and a passwordless-sudo probe.
 *
 * `sudoOutput` is the probe token (`yes`/`no`), but common variants and raw
 * exit codes are accepted so scripts other than the built-in probe also work.
 */
export function detectRole(idOutput: string, sudoOutput: string): 'root' | 'sudo' | 'user' {
  const uid = (idOutput.split(/\s+/)[0] ?? '').trim()
  if (uid === '0' || uid === 'root') return 'root'
  const token = sudoOutput.trim().toLowerCase()
  if (['yes', 'ok', 'true', '0', 'sudo', 'sudo-ok', 'available'].includes(token)) return 'sudo'
  return 'user'
}

/* ------------------------------------------------------------------ */
/* Small shared utilities                                              */
/* ------------------------------------------------------------------ */

/** Stable short hash used to build reproducible warning codes. */
export function shortHash(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Build a stable `prefix.<hash>` code for a warning/message pair. */
export function warningCode(prefix: string, message: string): string {
  return `${prefix}.${shortHash(message)}`
}

/**
 * Remove secrets from captured command output before it reaches logs/models.
 *
 * Installers print the generated Mongo password, and Mongo URIs embed
 * credentials; neither may be persisted or echoed.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s'"]+/gi, '$1***')
    .replace(/((?:数据库)?(?:密码|口令)|password|passwd|pwd)(\s*[:：=]\s*)\S+/gi, '$1$2***')
}

/** Keep the last `limit` characters of a possibly huge command output. */
export function tailText(text: string, limit: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `…[省略前 ${String(trimmed.length - limit)} 字符]\n${trimmed.slice(trimmed.length - limit)}`
}

/** True when a string looks like a publishable npm package name. */
export function isNpmPackageName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.startsWith('.')) return false
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
}

/* ------------------------------------------------------------------ */
/* Root-elevated execution                                             */
/* ------------------------------------------------------------------ */

/** Upper bound of output kept while a long install/upgrade runs. */
const MAX_CAPTURED_BYTES = 4 * 1024 * 1024

export interface OutputSink {
  (chunk: { stream: 'stdout' | 'stderr'; text: string }): void
}

export interface RootExecOptions {
  /** sudo/su password when the caller resolved one. */
  password?: string
  timeoutMs?: number
  /** Receive command output live (used by the streaming install/upgrade UI). */
  onOutput?: OutputSink
}

/**
 * Resolve the password to use for `sudo -S` / `su` elevation.
 *
 * Explicit call-site options win; otherwise the caller-provided
 * {@link AccountContext.elevationPassword} (always undefined now) is used.
 */
export function resolveElevationPassword(
  context: AccountContext,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit
  try {
    const resolve = context.elevationPassword
    if (typeof resolve !== 'function') return undefined
    const value = resolve()
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Run a command that may need root.
 *
 * Root accounts run directly; everyone else goes through
 * {@link SshConnection.elevate} (sudo `-n` when no password is supplied, so a
 * missing sudo grant fails fast instead of blocking on a prompt).
 */
export async function runAsRoot(
  context: AccountContext,
  command: string,
  options: RootExecOptions = {},
): Promise<ExecResult> {
  context.log(`$ ${command.length > 400 ? `${command.slice(0, 400)}…` : command}`)
  const timeoutMs = options.timeoutMs ?? context.config.commandTimeoutMs
  const signal = context.signal
  const cap = Math.max(OUTPUT_LIMIT, MAX_CAPTURED_BYTES)
  const password = resolveElevationPassword(context, options.password)
  const effective = withRemotePath(command)
  const sink = options.onOutput
  const streamCallbacks = sink === undefined ? {} : {
    onStdout: (text: string) => sink({ stream: 'stdout', text }),
    onStderr: (text: string) => sink({ stream: 'stderr', text }),
  }
  const result =
    context.account.role === 'root'
      ? await context.connection.exec(effective, {
          timeoutMs,
          maxOutputBytes: cap,
          ...(signal === undefined ? {} : { signal }),
          ...streamCallbacks,
        })
      : await context.connection.elevate(effective, {
          ...(password === undefined ? {} : { password }),
          timeoutMs,
          ...(signal === undefined ? {} : { signal }),
          ...streamCallbacks,
        })
  return {
    ...result,
    stdout: truncate(result.stdout, cap),
    stderr: truncate(result.stderr, cap),
  }
}

/** Convert a BSON timestamp/date/number-ish value to an ISO string. */
export function bsonTimeToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000
    return new Date(millis).toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  if (typeof value === 'object') {
    const record = value as {
      _bsontype?: string
      getHighBits?: () => number
      toJSON?: () => unknown
      toString?: () => string
    }
    if (typeof record.getHighBits === 'function') {
      try {
        return new Date(record.getHighBits() * 1000).toISOString()
      } catch {
        return null
      }
    }
    const asString = typeof record.toString === 'function' ? record.toString() : null
    if (asString !== null && record._bsontype !== undefined) {
      const parsed = Date.parse(asString)
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
    }
  }
  return null
}
