/**
 * Operations tools: status/health, install, upgrade, service control,
 * MongoDB inspection and oplog queries.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MongoQuerySpec, OplogQuerySpec } from '../ops/types.js'
import type { HydroStatus } from '../shared/types.js'
import { formatBytes, formatStatus, jsonSafe, parseJsonObject, textResult, warningPrefix } from './format.js'
import type { ToolDeps } from './types.js'

/** Compact summary attached to every status-ish tool result. */
interface StatusSummary {
  installed: boolean
  running: boolean
  version: string | null
  updateAvailable: boolean
  warnings: number
}

export function summarizeStatus(status: HydroStatus): StatusSummary {
  return {
    installed: status.hydro.installed,
    running: status.hydro.service?.running ?? false,
    version: status.hydro.version,
    updateAvailable: status.hydro.updateAvailable,
    warnings: status.warnings.length,
  }
}

export function registerOpsTools(deps: ToolDeps): void {
  const { ctx, ops } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_status',
      description: [
        '采集远端 Hydro 的完整状态：主机信息、Hydro 版本/服务/健康检查、插件版本与可升级项、',
        '评测机与沙箱版本、MongoDB 可连接性、oplog 可用性，以及管理员 WebSocket 系统检查警告。',
        '这是“只读询问当前状态”的主要工具。默认账号为当前账号。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        includeMongo: { type: 'boolean', description: '是否经 SSH 隧道检查 MongoDB（默认跟随配置）' },
        includeOplog: { type: 'boolean', description: '是否检查 oplog（默认跟随配置）' },
        includeWsWarnings: { type: 'boolean', description: '是否用 Hydro 管理员登录并收集 WS 检查警告（默认跟随配置）' },
        includeLatestVersions: { type: 'boolean', description: '是否查询 npm registry 的最新版本（默认跟随配置）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            status: { type: 'json' },
            summary: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        const options = {
          ...(args.includeMongo === undefined ? {} : { includeMongo: args.includeMongo }),
          ...(args.includeOplog === undefined ? {} : { includeOplog: args.includeOplog }),
          ...(args.includeWsWarnings === undefined ? {} : { includeWsWarnings: args.includeWsWarnings }),
          ...(args.includeLatestVersions === undefined ? {} : { includeLatestVersions: args.includeLatestVersions }),
        }
        const status = await ops.collectStatus(args.accountId, options)
        const summary = summarizeStatus(status)
        return {
          ok: status.reachable,
          message: formatStatus(status),
          status: jsonSafe(status),
          summary: jsonSafe(summary),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_health',
      description: '快速健康检查：SSH 连通性、Hydro 服务是否运行、HTTP 健康检查；不查询数据库/WS/最新版本。',
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            status: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        const status = await ops.quickProbe(args.accountId)
        return {
          ok: status.reachable && status.hydro.service?.running !== false,
          message: formatStatus(status),
          status: jsonSafe(status),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_install',
      description: [
        '在远端一键安装 Hydro（官方安装脚本）。远端必须尚未安装 Hydro；',
        '非 root SSH 用户依赖首次添加时配置的免密 sudo；普通操作不会提示密码。',
        '安装会接管 80 端口、写入 /nix 与 /data，属于高风险操作，必须传 confirm=true。',
        '安装完成后会自动复查状态。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        judge: { type: 'boolean', description: '同时安装评测机 hydrojudge（默认 false）' },
        noCaddy: { type: 'boolean', description: '不安装 Caddy（仅监听 8888，默认 false）' },
        confirm: { type: 'boolean', required: true, description: '必须为 true 才会执行' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            result: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args, exec) {
        if (args.confirm !== true) throw new Error('拒绝执行：hydro_install 需要 confirm=true')
        const result = await ops.install(args.accountId, {
          ...(args.judge === undefined ? {} : { judge: args.judge }),
          ...(args.noCaddy === undefined ? {} : { noCaddy: args.noCaddy }),
        })
        let post = ''
        try {
          const status = await ops.quickProbe(args.accountId)
          post = `\n\n复查：${status.hydro.installed ? `已安装 Hydro ${status.hydro.version ?? '?'}` : '仍未检测到 Hydro'}，服务${status.hydro.service?.running === true ? '运行中' : '未运行'}。`
        } catch (error) {
          post = `\n\n复查失败：${(error as Error).message}`
        }
        void exec
        return { ok: result.ok, message: `${result.message}${post}`, result: jsonSafe(result) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_upgrade',
      description: [
        '升级远端 Hydro 本体与已安装插件到最新版本（yarn global add + pm2 重启）。',
        '先用 dryRun=true 查看升级计划；真正执行需要 confirm=true。升级前建议先备份数据库。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        dryRun: { type: 'boolean', description: '只输出升级计划，不执行' },
        includeJudge: { type: 'boolean', description: '同时升级评测机（hydrojudge）' },
        confirm: { type: 'boolean', description: '真正执行时必须为 true' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            result: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        const dryRun = args.dryRun ?? false
        if (!dryRun && args.confirm !== true) throw new Error('拒绝执行：hydro_upgrade 真正升级需要 confirm=true（可先用 dryRun=true 查看计划）')
        const result = await ops.upgrade(args.accountId, {
          dryRun,
          ...(args.includeJudge === undefined ? {} : { includeJudge: args.includeJudge }),
        })
        return {
          ok: result.ok,
          message: `${result.message}${result.log !== undefined && result.log !== '' ? `\n\n命令输出：\n${result.log}` : ''}`,
          result: jsonSafe(result),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_service',
      description: '查看或控制远端 Hydro 相关服务（pm2/systemd）：hydrooj、mongodb、hydro-sandbox、caddy、hydrojudge。',
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        target: { type: 'string', enum: ['hydro', 'mongodb', 'sandbox', 'caddy', 'judge'], required: true, description: '服务' },
        action: { type: 'string', enum: ['status', 'start', 'stop', 'restart', 'reload'], required: true, description: '操作' },
        confirm: { type: 'boolean', description: 'start/stop/restart/reload 必须为 true' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            result: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        if (args.action !== 'status' && args.confirm !== true) {
          throw new Error('拒绝执行：修改服务状态需要 confirm=true')
        }
        const result = await ops.serviceAction(args.accountId, args.target, args.action)
        return {
          ok: result.ok,
          message: `${result.manager} ${result.action} ${result.target}：${result.ok ? '成功' : '失败'}${result.output !== '' ? `\n${result.output}` : ''}`,
          result: jsonSafe(result),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_db',
      description: [
        '通过 SSH 隧道只读查询远端 Hydro 的 MongoDB（默认库 hydro）。',
        'action=collections 列出集合；find 查询文档（limit 最大 50）；count 统计数量。',
        '不会写入数据库；写入请使用 Hydro 的 HTTP API 或 hydrooj cli。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['collections', 'find', 'count'], required: true, description: '操作' },
        collection: { type: 'string', description: '集合名（find/count 必填）' },
        filter: { type: 'string', description: '查询条件 JSON，例如 {"type":"user.login"}' },
        projection: { type: 'string', description: '字段投影 JSON，例如 {"_id":1,"type":1}' },
        sort: { type: 'string', description: '排序 JSON，例如 {"_id":-1}' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 50' },
        skip: { type: 'number', description: '跳过条数' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        if (args.action === 'collections') {
          const collections = await ops.listCollections(args.accountId)
          const lines = collections.map(
            (collection) =>
              `- ${collection.name}: ${collection.count === null ? '?' : String(collection.count)} 条，${formatBytes(collection.sizeBytes)}`,
          )
          return {
            ok: true,
            message: [`共 ${String(collections.length)} 个集合：`, ...lines].join('\n'),
            data: jsonSafe(collections),
          }
        }
        if (args.collection === undefined) throw new Error(`${args.action} 需要 collection`)
        const filter = parseJsonObject(args.filter, 'filter')
        const projection = parseJsonObject(args.projection, 'projection')
        const sort = parseJsonObject(args.sort, 'sort') as Record<string, 1 | -1> | undefined
        if (args.action === 'count') {
          const spec: MongoQuerySpec = {
            collection: args.collection,
            ...(filter === undefined ? {} : { filter }),
            limit: 1,
          }
          const result = await ops.queryDatabase(args.accountId, { ...spec, limit: 1 })
          return {
            ok: true,
            message: `集合 ${args.collection} 共有 ${String(result.documents.length)} 条（count 模式仅返回是否命中，完整计数请用 find 的 limit=1 观察；建议直接看 collections 的统计）`,
            data: jsonSafe(result),
          }
        }
        const spec: MongoQuerySpec = {
          collection: args.collection,
          ...(filter === undefined ? {} : { filter }),
          ...(projection === undefined ? {} : { projection: projection as Record<string, 0 | 1> }),
          ...(sort === undefined ? {} : { sort }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.skip === undefined ? {} : { skip: args.skip }),
        }
        const result = await ops.queryDatabase(args.accountId, spec)
        return {
          ok: true,
          message: `集合 ${args.collection} 查询到 ${String(result.documents.length)} 条${result.truncated ? '（已截断到上限）' : ''}。\n\`\`\`json\n${JSON.stringify(result.documents, null, 2).slice(0, 12_000)}\n\`\`\``,
          data: jsonSafe(result),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_oplog',
      description: [
        '查询操作日志。source=hydro 查 Hydro 的 oplog 审计集合（谁在何时做了什么）；',
        'source=mongo 查 MongoDB 副本集原生 oplog（默认单机 mongod 没有，会返回说明）；auto 自动选择。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        source: { type: 'string', enum: ['auto', 'hydro', 'mongo'], description: '日志来源，默认 auto' },
        type: { type: 'string', description: '操作类型，例如 user.login、problem.edit' },
        contains: { type: 'string', description: '在类型/路径中模糊匹配' },
        operator: { type: 'number', description: '操作者 uid' },
        since: { type: 'string', description: '起始时间 ISO 字符串' },
        limit: { type: 'number', description: '条数，默认 20，最大 100' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        const spec: OplogQuerySpec = {
          source: args.source ?? 'auto',
          ...(args.type === undefined ? {} : { type: args.type }),
          ...(args.contains === undefined ? {} : { contains: args.contains }),
          ...(args.operator === undefined ? {} : { operator: args.operator }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.since === undefined ? {} : { since: args.since }),
        }
        const result = await ops.queryOplog(args.accountId, spec)
        const lines = result.entries.map((entry) => {
          const who = entry.operator === null ? '?' : String(entry.operator)
          return `- ${entry.time} [${entry.source}] ${entry.type} by ${who}${entry.path === null ? '' : ` @ ${entry.path}`}`
        })
        const note = result.note === null ? '' : `\n\n说明：${result.note}`
        return {
          ok: true,
          message: `共 ${String(result.entries.length)} 条日志（来源 ${result.source}${result.fallback ? '，已回退' : ''}）：\n${lines.join('\n')}${note}`,
          data: jsonSafe(result),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_warnings',
      description: '只收集 Hydro 管理员 WebSocket 系统检查的警告/错误（等价于管理面板的“系统检查”），不采集完整状态。',
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            warnings: { type: 'json' },
          },
        },
        render: (_args, value) => textResult(value.message),
      },
      async execute(args) {
        const status = await ops.collectStatus(args.accountId, {
          includeMongo: false,
          includeOplog: false,
          includeLatestVersions: false,
          includeWsWarnings: true,
        })
        const warnings = status.warnings
        const text =
          warnings.length === 0
            ? '未收到管理员 WebSocket 警告（可能没有配置 Hydro 管理员账号，或检查没有发现问题）。'
            : ['管理员 WebSocket 检查结果：', ...warnings.map((warning) => `${warningPrefix(warning.severity)} ${warning.message}${warning.hint === null ? '' : `（${warning.hint}）`}`)].join('\n')
        return { ok: true, message: text, warnings: jsonSafe(warnings) }
      },
    }),
  )
}
