/**
 * Formatting and parsing helpers shared by the tool registrars.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { AccountSummary, HydroStatus, StatusWarning } from '../shared/types.js'

/**
 * Convert an arbitrary value into the canonical JSON value a tool output
 * schema accepts (drops `undefined`, `Date` becomes an ISO string, ...).
 */
export function jsonSafe<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Build the canonical content block array for `output.render`. */
export function textResult(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }]
}

/** Parse a JSON object argument, returning undefined for empty input. */
export function parseJsonObject(raw: string | undefined, name: string): Record<string, unknown> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`参数 ${name} 不是合法 JSON：${(error as Error).message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`参数 ${name} 必须是 JSON 对象`)
  }
  return value as Record<string, unknown>
}

/** Format a byte count as a short human string. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '未知'
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit] ?? 'TB'}`
}

/** Format a duration in seconds as a compact human string. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '未知'
  if (seconds < 60) return `${String(Math.round(seconds))}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / 86_400).toFixed(1)}d`
}

/** One-line account description used in lists and tool output. */
export function formatAccountLine(account: AccountSummary, active: boolean): string {
  const role = account.role === 'root' ? 'root' : account.role === 'sudo' ? 'sudo' : 'user'
  const auth = account.authMethod === 'key' ? '密钥' : '密码'
  const flags = [account.readonly ? '只读' : null, active ? '当前' : null].filter((flag) => flag !== null)
  const hydro = account.hydro?.installed === true ? `Hydro ${account.hydro.version ?? '?'}` : '未安装 Hydro'
  return `- ${account.label} (${account.username}@${account.host}:${String(account.port)}, ${auth}, ${role}) — ${hydro}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`
}

/** Render every account, marking the active one. */
export function formatAccounts(accounts: AccountSummary[], activeId: string | null): string {
  if (accounts.length === 0) return '还没有配置任何账号。用 hydro_accounts 的 add 动作添加一个远端。'
  const lines = accounts.map((account) => formatAccountLine(account, account.id === activeId))
  return [`共 ${String(accounts.length)} 个账号：`, ...lines].join('\n')
}

/** Severity prefix for warnings. */
export function warningPrefix(severity: StatusWarning['severity']): string {
  return severity === 'error' ? '[错误]' : severity === 'warning' ? '[警告]' : '[提示]'
}

/** Render a full status snapshot as Chinese markdown-ish text. */
export function formatStatus(status: HydroStatus): string {
  const lines: string[] = []
  lines.push(`状态采集于 ${status.collectedAt}（账号 ${status.accountId}）`)
  if (!status.reachable) {
    lines.push(`无法访问远端：${status.error ?? '未知错误'}`)
    return lines.join('\n')
  }
  const host = status.host
  if (host !== null) {
    lines.push(`主机：${host.hostname ?? '?'} ${host.platform ?? ''} ${host.release ?? ''} ${host.arch ?? ''}`)
    if (host.node !== null) lines.push(`Node：${host.node}`)
    if (host.load.length > 0) lines.push(`负载：${host.load.map((value) => value.toFixed(2)).join(' / ')}`)
  }
  if (!status.hydro.installed) {
    lines.push('Hydro：未安装（可用 hydro_install 一键安装）')
  } else {
    const update = status.hydro.updateAvailable ? `，可升级到 ${status.hydro.latestVersion ?? '?'}` : ''
    lines.push(`Hydro：${status.hydro.version ?? '未知版本'}${update}`)
    if (status.hydro.service !== null) {
      const service = status.hydro.service
      lines.push(
        `服务：${service.manager} · ${service.running ? '运行中' : '未运行'}${service.pid === null ? '' : ` · pid ${String(service.pid)}`}`,
      )
    }
    if (status.hydro.health !== null) {
      lines.push(`健康检查：${status.hydro.health.ok ? `正常（${String(status.hydro.health.latencyMs ?? '?')}ms）` : `失败（${status.hydro.health.error ?? '?'}）`}`)
    }
  }
  if (status.plugins.length > 0) {
    const outdated = status.plugins.filter((plugin) => plugin.updateAvailable)
    lines.push(`插件：${String(status.plugins.length)} 个${outdated.length > 0 ? `，${String(outdated.length)} 个可升级：${outdated.map((plugin) => plugin.name).join(', ')}` : ''}`)
  }
  if (status.judge !== null) {
    lines.push(
      `评测：沙箱 ${status.judge.sandbox ?? '未知'}${status.judge.sandboxVersion === null ? '' : ` ${status.judge.sandboxVersion}`}` +
        ` · 队列 ${status.judge.queue === null ? '未知' : String(status.judge.queue)}`,
    )
  }
  if (status.mongo !== null) {
    const mongo = status.mongo
    lines.push(
      `MongoDB：${mongo.reachable ? `可连接 ${mongo.version ?? ''}，${String(mongo.collections ?? '?')} 个集合` : '不可达'}` +
        ` · oplog ${mongo.oplog.available ? '可用' : '不可用（单机 mongod）'}`,
    )
  }
  if (status.warnings.length > 0) {
    lines.push('检查结果：')
    for (const warning of status.warnings) lines.push(`  ${warningPrefix(warning.severity)} ${warning.message}`)
  }
  return lines.join('\n')
}
