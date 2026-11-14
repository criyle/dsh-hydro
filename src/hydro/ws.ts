/**
 * Admin `/manage/check-conn` WebSocket warnings.
 *
 * Flow: SSH tunnel to Hydro's loopback HTTP port → `POST /login` for an admin
 * `sid` cookie → WebSocket connection to `/manage/check-conn` with that
 * cookie. Hydro streams `{type: 'log'|'warn'|'error', payload}` messages and
 * never signals completion, so collection is time-boxed (default 3s).
 *
 * Missing credentials are reported as one actionable `info` warning instead of
 * failing the whole status collection.
 */
import WebSocket from 'ws'

import { openTunnel } from '../ops/tunnel.js'
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { StatusWarning } from '../shared/types.js'
import { warningCode } from './remote.js'

const DEFAULT_TIMEOUT_MS = 3000
const MAX_WARNINGS = 50
const MAX_MESSAGE_LENGTH = 1000
const DEFAULT_HYDRO_PORT = 8888

const MESSAGE_TYPES = new Set(['log', 'warn', 'error'])

const HINT_RULES: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /server\.url/i, hint: "使用 hydrooj cli system set server.url 'https://你的域名/' 后重启 hydrooj" },
  { pattern: /IP header/i, hint: '检查 server.xff / server.xhost 反代头设置（Caddy 安装器默认已设置）' },
  { pattern: /smtp|SMTP/, hint: '在 Hydro 系统设置中配置 smtp.* 以启用邮件功能' },
  { pattern: /sandbox|go-judge/i, hint: '检查 hydro-sandbox 是否运行（pm2 restart hydro-sandbox）与 judge.yaml 的 sandbox_host' },
  { pattern: /mongo|database/i, hint: '检查 MongoDB 是否运行、密码是否与 ~/.hydro/config.json 一致、磁盘是否写满' },
  { pattern: /inspector/i, hint: '非调试环境请关闭 Node inspector' },
  { pattern: /cgroup|memory/i, hint: '升级内核（>=5.19）或沙箱版本以修复内存统计' },
  { pattern: /storage/i, hint: '检查存储配置与磁盘空间' },
  { pattern: /vjudge/i, hint: '检查 vjudge worker 配置与网络连通性' },
]

function textOf(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data as Buffer[]).toString('utf8')
  }
  return null
}

function hintFor(message: string): string | null {
  for (const rule of HINT_RULES) {
    if (rule.pattern.test(message)) return rule.hint
  }
  return null
}

/**
 * Map one `/manage/check-conn` message to a {@link StatusWarning}.
 *
 * Accepts the parsed object, its JSON string, or its raw `Buffer`. Anything
 * else (heartbeat `ping`/`pong`, error envelopes, malformed JSON) returns
 * `null`. Codes are stable for identical payloads so duplicate messages dedupe.
 */
export function parseCheckMessage(data: unknown): StatusWarning | null {
  let value: unknown = data
  if (typeof data === 'string' || Buffer.isBuffer(data) || Array.isArray(data)) {
    const text = textOf(data)
    if (text === null) return null
    const trimmed = text.trim()
    if (trimmed === '' || trimmed === 'ping' || trimmed === 'pong') return null
    try {
      value = JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : null
  if (type === null || !MESSAGE_TYPES.has(type)) return null
  const payload = typeof record.payload === 'string' ? record.payload : null
  if (payload === null || payload.trim() === '') return null
  const message = payload.length > MAX_MESSAGE_LENGTH ? `${payload.slice(0, MAX_MESSAGE_LENGTH)}…` : payload
  const severity: StatusWarning['severity'] =
    type === 'error' ? 'error' : type === 'warn' ? 'warning' : 'info'
  return {
    severity,
    code: warningCode(`hydro.ws.${type}`, message),
    message,
    hint: hintFor(message),
  }
}

/** Cookie header parsing that works with and without `getSetCookie()`. */
function credentialsWarning(): StatusWarning {
  return {
    severity: 'info',
    code: 'hydro.ws.credentials',
    message: '还没有加载到 Hydro 浏览器登录态，所以暂时读不到管理端警告。',
    hint: '在站点页/内嵌浏览器中登录一个具有超级管理员权限的 站点账号即可。',
  }
}

function collectFromSocket(url: string, sid: string, timeoutMs: number): Promise<StatusWarning[]> {
  return new Promise((resolve) => {
    const warnings = new Map<string, StatusWarning>()
    let socket: WebSocket | undefined
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        socket?.terminate()
      } catch {
        // Ignore socket teardown races.
      }
      resolve([...warnings.values()].slice(0, MAX_WARNINGS))
    }
    const add = (warning: StatusWarning): void => {
      if (warnings.size >= MAX_WARNINGS) return
      if (!warnings.has(warning.code)) warnings.set(warning.code, warning)
    }

    try {
      socket = new WebSocket(url, {
        headers: { Cookie: `sid=${sid}` },
        handshakeTimeout: Math.min(timeoutMs, 5000),
      })
    } catch (error) {
      resolve([
        {
          severity: 'warning',
          code: 'hydro.ws.connect',
          message: '无法连接 Hydro 管理端，暂时读不到管理端警告。',
          hint: '确认 Hydro 正在运行；如果持续出现，请检查服务状态。',
        },
      ])
      return
    }

    timer = setTimeout(finish, timeoutMs)
    socket.on('message', (data) => {
      if (settled) return
      const text = textOf(data)
      if (text === 'ping') {
        try {
          socket?.send('pong')
        } catch {
          // Server is gone; the close handler settles the promise.
        }
        return
      }
      if (text === 'pong') return
      const warning = parseCheckMessage(data)
      if (warning !== null) add(warning)
    })
    socket.on('close', (code) => {
      if (code === 4000) {
        add({
          severity: 'error',
          code: 'hydro.ws.permission',
          message: '当前 站点账号权限不足，读不到管理端警告。',
          hint: '换用具有超级管理员权限的 站点账号。',
        })
      }
      finish()
    })
    socket.on('error', () => {
      if (!settled && warnings.size === 0) {
        add({
          severity: 'warning',
          code: 'hydro.ws.connect',
          message: 'Hydro 管理端连接异常，暂时读不到管理端警告。',
          hint: '确认 Hydro 正在运行；如果持续出现，请检查服务状态。',
        })
      }
      finish()
    })
  })
}

export interface CollectWsOptions {
  /** Collection window in milliseconds (default 3000). */
  timeoutMs?: number
  /** Browser-captured Hydro sid cookie; no password is used. */
  sid?: string
}

/**
 * Collect admin WS warnings through an SSH tunnel.
 *
 * Returns at most 50 deduplicated warnings. Never throws for auth/network
 * failures; an abort signal does propagate.
 */
export async function collectWsWarnings(
  context: AccountContext,
  probe: HydroProbe,
  options: CollectWsOptions = {},
): Promise<StatusWarning[]> {
  if (!probe.installed) return []
  if (options.sid === undefined || options.sid === '') return [credentialsWarning()]

  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000))
  const port =
    probe.ports.hydro ??
    (context.config.hydro.port > 0 ? context.config.hydro.port : DEFAULT_HYDRO_PORT)
  const tunnel = await openTunnel(context, { remoteHost: '127.0.0.1', remotePort: port })
  try {
    if (context.signal?.aborted === true) {
      throw context.signal.reason instanceof Error ? context.signal.reason : new Error('操作已取消')
    }
    const wsUrl = `${tunnel.baseUrl.replace(/^http/, 'ws')}/manage/check-conn`
    return await collectFromSocket(wsUrl, options.sid, timeoutMs)
  } finally {
    await tunnel.release().catch(() => undefined)
  }
}
