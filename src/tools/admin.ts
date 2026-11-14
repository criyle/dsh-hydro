/**
 * Admin tools: domain config, system settings and the opt-in arbitrary command
 * escape hatch.
 *
 * Domain/system configuration is the "let the AI tune Hydro" surface. Reads are
 * always allowed; writes go through the read-only guard and are echoed back so
 * the operator can audit what changed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { AccountContext } from '../ops/types.js'
import { runChecked, shellPath, withRemotePath } from '../ops/exec.js'
import { openHydroSession, getDomainConfig, setDomainConfig } from '../hydro/api.js'
import { jsonSafe, parseJsonObject, textResult } from './format.js'
import type { ToolDeps } from './types.js'

/** Run a command as root using sudo/su when the SSH user is not root. */
async function runAsRoot(context: AccountContext, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const id = await context.connection.exec('id -u')
  if (id.stdout.trim() === '0') {
    const result = await runChecked(context, withRemotePath(command))
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }
  const elevated = await context.connection.elevate(withRemotePath(command), {
    ...(context.elevationPassword() === undefined ? {} : { password: context.elevationPassword() }),
    timeoutMs: context.config.commandTimeoutMs,
  })
  if (elevated.code !== 0) {
    throw new Error(`提权执行失败（exit ${String(elevated.code)}）：${(elevated.stderr || elevated.stdout).trim().slice(0, 2000)}`)
  }
  return { code: elevated.code, stdout: elevated.stdout, stderr: elevated.stderr }
}

/** Open an authenticated Hydro web session for one account. */
async function withHydroSession<T>(
  deps: ToolDeps,
  accountId: string | undefined,
  fn: (session: Awaited<ReturnType<typeof openHydroSession>>, context: AccountContext) => Promise<T>,
): Promise<T> {
  const id = deps.ops.resolveAccountId(accountId)
  return deps.ops.withContext(id, async (context) => {
    const credentials = await deps.ops.getSiteSession(id)
    if (credentials.sid === null) {
      throw new Error(`账号 ${context.account.label} 还没有登录 Hydro：请在内嵌浏览器中登录后重试。`)
    }
    const port = await deps.ops.hydroPort(context)
    const session = await openHydroSession(context, { port, sid: credentials.sid })
    try {
      return await fn(session, context)
    } finally {
      await session.close().catch(() => undefined)
    }
  })
}

export function registerAdminTools(deps: ToolDeps): void {
  const { ctx, ops, config } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_domain_config',
      description: [
        '读取或修改 Hydro 域（domain）配置，例如站点名称、公告、语言、头像等。',
        'action=get 只读；action=set 需要确认并受只读模式保护，values 是 JSON 对象。',
        '需要先在内嵌浏览器登录一个 Hydro 站点账号。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['get', 'set'], required: true, description: '操作' },
        domain: { type: 'string', description: '域 id，默认 system' },
        values: { type: 'string', description: 'set 时的配置 JSON 对象，键为 DOMAIN_SETTINGS 的 key' },
        booleanKeys: { type: 'string', description: '布尔项 JSON 对象，例如 {"share":true}' },
        confirm: { type: 'boolean', description: 'set 时必须为 true' },
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
        const domain = args.domain ?? config.problem.defaultDomain
        if (args.action === 'get') {
          const result = await withHydroSession(deps, args.accountId, async (session) => getDomainConfig(session, domain))
          return {
            ok: true,
            message: `域 ${domain} 当前配置：\n\`\`\`json\n${JSON.stringify(result.current, null, 2).slice(0, 12_000)}\n\`\`\``,
            data: jsonSafe(result),
          }
        }
        if (args.confirm !== true) throw new Error('拒绝执行：修改域配置需要 confirm=true')
        const values = parseJsonObject(args.values, 'values') ?? {}
        const booleanKeys = parseJsonObject(args.booleanKeys, 'booleanKeys') as Record<string, boolean> | undefined
        await withHydroSession(deps, args.accountId, async (session, context) => {
          ops.assertWritable(context, '修改域配置')
          await setDomainConfig(
            session,
            domain,
            values as Record<string, string | number | boolean | undefined>,
            booleanKeys,
          )
        })
        return {
          ok: true,
          message: `已修改域 ${domain} 的配置：${Object.keys(values).join(', ') || '(仅布尔项)'}`,
          data: jsonSafe({ domain, values, booleanKeys: booleanKeys ?? {} }),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_domain_roles',
      description: [
        '管理 Hydro 域内角色与用户角色分配（通过管理端 API，需要域管理/超管权限）。',
        'action=list 查看当前角色位掩码；set-user 给用户分配角色；set-permissions 修改角色权限位；',
        'add-role/delete-role 增删自定义角色。权限位索引来自 Hydro 的域权限页面。',
        '写操作需要 confirm=true 且受只读模式保护；不要修改 root/default/guest 内置角色。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['list', 'set-user', 'set-permissions', 'add-role', 'delete-role'], required: true, description: '操作类型' },
        domain: { type: 'string', description: '域 id，默认 system' },
        uid: { type: 'array', items: { type: 'integer' }, description: 'set-user 的用户 id 列表' },
        role: { type: 'string', description: 'set-user/add-role 的角色名' },
        roles: { type: 'array', items: { type: 'string' }, description: 'delete-role 的角色列表' },
        rolePermissions: { type: 'string', description: 'set-permissions 的 JSON：{"role":[权限位索引,...]}' },
        confirm: { type: 'boolean', description: '写操作需要 true' },
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
        const domain = args.domain ?? config.problem.defaultDomain
        if (args.action === 'list') {
          const [domainDoc, userDocs] = await Promise.all([
            ops.queryDatabase(args.accountId, { collection: 'domain', filter: { _id: domain }, limit: 1 }),
            ops.queryDatabase(args.accountId, { collection: 'domain.user', filter: { domainId: domain }, limit: 100 }),
          ])
          return {
            ok: true,
            message: `域 ${domain} 角色与用户角色：\n\`\`\`json\n${JSON.stringify({ domain: domainDoc.documents[0] ?? null, users: userDocs.documents }, null, 2).slice(0, 14_000)}\n\`\`\``,
            data: jsonSafe({ domain: domainDoc.documents, users: userDocs.documents }),
          }
        }
        if (args.confirm !== true) throw new Error('拒绝执行：修改域权限需要 confirm=true')
        const result = await withHydroSession(deps, args.accountId, async (session, context) => {
          ops.assertWritable(context, '修改域权限')
          if (args.action === 'set-user') {
            const uids = args.uid ?? []
            const role = args.role ?? ''
            if (uids.length === 0 || role === '') throw new Error('set-user 需要 uid 和 role')
            const response = await session.request(`/d/${encodeURIComponent(domain)}/domain/user`, {
              method: 'POST',
              json: { uid: uids, role, join: true },
            })
            if (response.status >= 400) throw new Error(`设置用户角色失败（HTTP ${String(response.status)}）：${JSON.stringify(response.body).slice(0, 800)}`)
            return { message: `已把用户 ${uids.join(', ')} 设置为角色 ${role}（域 ${domain}）`, data: { domain, uid: uids, role } }
          }
          if (args.action === 'set-permissions') {
            const parsed = parseJsonObject(args.rolePermissions, 'rolePermissions')
            if (parsed === undefined) throw new Error('set-permissions 需要 rolePermissions JSON')
            const body: Record<string, number[]> = {}
            for (const [role, value] of Object.entries(parsed)) {
              if (!Array.isArray(value)) throw new Error(`角色 ${role} 的权限必须是数组`)
              body[role] = value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0)
            }
            const response = await session.request(`/d/${encodeURIComponent(domain)}/domain/permission`, {
              method: 'POST',
              json: body,
            })
            if (response.status >= 400) throw new Error(`修改角色权限失败（HTTP ${String(response.status)}）：${JSON.stringify(response.body).slice(0, 800)}`)
            return { message: `已更新域 ${domain} 的角色权限：${Object.keys(body).join(', ')}`, data: { domain, roles: body } }
          }
          if (args.action === 'add-role') {
            const role = args.role ?? ''
            if (role === '') throw new Error('add-role 需要 role')
            const response = await session.request(`/d/${encodeURIComponent(domain)}/domain/role`, {
              method: 'POST',
              json: { role },
            })
            if (response.status >= 400) throw new Error(`新增角色失败（HTTP ${String(response.status)}）`)
            return { message: `已新增角色 ${role}（域 ${domain}），默认继承 default 权限`, data: { domain, role } }
          }
          const roles = args.roles ?? []
          if (roles.length === 0) throw new Error('delete-role 需要 roles')
          const response = await session.request(`/d/${encodeURIComponent(domain)}/domain/role`, {
            method: 'POST',
            json: { roles },
          })
          if (response.status >= 400) throw new Error(`删除角色失败（HTTP ${String(response.status)}）`)
          return { message: `已删除角色 ${roles.join(', ')}（域 ${domain}）`, data: { domain, roles } }
        })
        return { ok: true, message: result.message, data: jsonSafe(result.data) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_system_config',
      description: [
        '读取或修改 Hydro 系统设置（system 集合 / hydrooj cli system set）。',
        'action=get 只读；action=set 通过 SSH 以 root 执行 hydrooj cli system set，受只读模式保护。',
        '修改后默认 pm2 重启 hydrooj 使配置生效（restart=false 可关闭）。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['get', 'set'], required: true, description: '操作' },
        key: { type: 'string', description: '设置键，例如 server.url；get 时留空表示列出全部' },
        value: { type: 'string', description: 'set 时的值（字符串/数字/布尔/YAML 文本均按原文写入）' },
        restart: { type: 'boolean', description: 'set 后是否重启 hydrooj，默认 true' },
        confirm: { type: 'boolean', description: 'set 时必须为 true' },
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
        if (args.action === 'get') {
          const result = await ops.withContext(args.accountId, async (context) => {
            if (args.key === undefined) {
              return ops.queryDatabase(context.account.id, { collection: 'system', limit: 200 })
            }
            return ops.queryDatabase(context.account.id, { collection: 'system', filter: { _id: args.key }, limit: 1 })
          })
          return {
            ok: true,
            message: `系统设置：\n\`\`\`json\n${JSON.stringify(result.documents, null, 2).slice(0, 12_000)}\n\`\`\``,
            data: jsonSafe(result),
          }
        }
        const key = args.key
        const value = args.value
        if (key === undefined || value === undefined) throw new Error('set 需要 key 和 value')
        if (args.confirm !== true) throw new Error('拒绝执行：修改系统设置需要 confirm=true')
        const details = await ops.withWritableContext(args.accountId, '修改系统设置', async (context) => {
          const command = `hydrooj cli system set ${key} ${shellPath(value)}`
          const result = await runAsRoot(context, command)
          const restart = args.restart ?? true
          let restartText = ''
          if (restart) {
            const restarted = await context.connection.exec('pm2 restart hydrooj 2>&1 || true')
            restartText = restarted.stdout.trim() || restarted.stderr.trim() || 'done'
          }
          return { output: result.stdout.trim(), restartText }
        })
        return {
          ok: true,
          message: `已设置 ${key} = ${value.slice(0, 500)}${args.restart === false ? '' : `，并重启 hydrooj（${details.restartText}）`}`,
          data: jsonSafe({ key, value, restart: args.restart ?? true, output: details.output }),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'hydro_exec',
      description: [
        '在远端执行任意 shell 命令（默认关闭，需要在插件配置 security.allowArbitraryCommands=true）。',
        '只读模式下拒绝执行；asRoot=true 时通过 sudo/su 提权。用于高级排障，输出会截断。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        command: { type: 'string', required: true, description: '要执行的命令' },
        asRoot: { type: 'boolean', description: '是否以 root 执行（默认跟随 SSH 用户）' },
        timeoutMs: { type: 'number', description: '超时毫秒数' },
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
        if (!config.security.allowArbitraryCommands) {
          throw new Error('hydro_exec 默认关闭：请先在插件配置中设置 security.allowArbitraryCommands=true')
        }
        const command = args.command.trim()
        if (command === '') throw new Error('command 不能为空')
        const id = ops.resolveAccountId(args.accountId)
        const context = await ops.withContext(id, async (ctx) => ctx)
        ops.assertWritable(context, '执行任意命令')
        const result =
          args.asRoot === true
            ? await context.connection.elevate(command, {
                ...(context.elevationPassword() === undefined ? {} : { password: context.elevationPassword() }),
                timeoutMs: args.timeoutMs ?? config.commandTimeoutMs,
              })
            : await context.connection.exec(command, {
                timeoutMs: args.timeoutMs ?? config.commandTimeoutMs,
                maxOutputBytes: config.security.maxCommandOutputBytes,
              })
        return {
          ok: result.code === 0,
          message: `$ ${command}\n(exit ${String(result.code)})\n${result.stdout}\n${result.stderr}`.trim(),
          data: jsonSafe(result),
        }
      },
    }),
  )
}
