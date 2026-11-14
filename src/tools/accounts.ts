/**
 * Account-management tools: list / add / update / remove / activate / test.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { jsonSafe, textResult, formatAccounts } from './format.js'
import type { ToolDeps } from './types.js'

export function registerAccountTools(deps: ToolDeps): void {
  const { ctx, ops } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_accounts',
      description: [
        '管理 dsh-hydro 保存的远端 SSH 账号（HydroOJ 服务器）。',
        'action=list 列出账号；add 添加（密码或私钥）；update 修改；remove 删除；use 切换；test 测试连接。',
        '密码只用于一次性安装托管密钥和配置免密 sudo，不会保存；之后只用密钥。',
        'Hydro Web 账号请用 hydro_site_accounts 单独添加，并用内嵌浏览器登录。',
      ].join(''),
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'use', 'test'], required: true, description: '操作类型' },
        accountId: { type: 'string', description: '目标账号 id（list/add 不需要；其余默认当前账号）' },
        label: { type: 'string', description: '显示名称，默认 user@host' },
        host: { type: 'string', description: 'SSH 主机名或 IP' },
        port: { type: 'number', description: 'SSH 端口，默认 22' },
        username: { type: 'string', description: 'SSH 用户名' },
        authMethod: { type: 'string', enum: ['password', 'key'], description: '认证方式' },
        password: { type: 'string', description: '一次性 SSH 密码：用于安装密钥/配置免密 sudo，不保存' },
        privateKey: { type: 'string', description: 'OpenSSH 格式私钥内容（authMethod=key 时）' },
        installManagedKey: { type: 'boolean', description: '密码方式固定为 true：生成并安装 ed25519 密钥' },
        role: { type: 'string', enum: ['root', 'sudo', 'user'], description: '远端权限（root / 有 sudo / 普通用户）' },
        readonly: { type: 'boolean', description: '账号级只读：拒绝所有会修改远端的工具' },
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
        switch (args.action) {
          case 'list': {
            const accounts = ops.listAccounts()
            const activeId = ops.activeAccountId()
            return {
              ok: true,
              message: formatAccounts(accounts, activeId),
              data: jsonSafe({ accounts, activeAccountId: activeId }),
            }
          }
          case 'add': {
            if (args.host === undefined || args.username === undefined) throw new Error('add 需要 host 和 username')
            const authMethod = args.authMethod ?? (args.privateKey !== undefined ? 'key' : 'password')
            if (authMethod === 'password' && (args.password === undefined || args.password === '')) {
              throw new Error('密码方式需要提供一次性 password')
            }
            if (authMethod === 'key' && args.privateKey === undefined) throw new Error('authMethod=key 需要提供 privateKey')
            const installManagedKey = authMethod === 'password'
            const account = await ops.addAccount({
              host: args.host,
              username: args.username,
              ...(args.label === undefined ? {} : { label: args.label }),
              ...(args.port === undefined ? {} : { port: args.port }),
              authMethod,
              ...(args.password === undefined ? {} : { password: args.password }),
              ...(args.privateKey === undefined ? {} : { privateKey: args.privateKey }),
              installManagedKey,
              ...(args.role === undefined ? {} : { role: args.role }),
              ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
            })
            const notes: string[] = []
            if (installManagedKey) notes.push('已安装托管密钥并配置免密 sudo；密码未保存')
            return {
              ok: true,
              message: `已添加账号 ${account.label}（${account.id}）${notes.length > 0 ? `。${notes.join('；')}` : ''}`,
              data: jsonSafe(account),
            }
          }
          case 'update': {
            const accountId = ops.resolveAccountId(args.accountId)
            const account = await ops.updateAccount(accountId, {
              ...(args.label === undefined ? {} : { label: args.label }),
              ...(args.host === undefined ? {} : { host: args.host }),
              ...(args.port === undefined ? {} : { port: args.port }),
              ...(args.username === undefined ? {} : { username: args.username }),
              ...(args.role === undefined ? {} : { role: args.role }),
              ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
            })
            return { ok: true, message: `已更新账号 ${account.label}（${account.id}）`, data: jsonSafe(account) }
          }
          case 'remove': {
            const accountId = ops.resolveAccountId(args.accountId)
            const removed = await ops.removeAccount(accountId)
            return {
              ok: removed,
              message: removed ? `已删除账号 ${accountId}` : `账号 ${accountId} 不存在`,
              data: jsonSafe({ accountId, removed }),
            }
          }
          case 'use': {
            if (args.accountId === undefined) throw new Error('use 需要 accountId')
            await ops.setActiveAccount(args.accountId)
            const account = ops.getAccountSummary(args.accountId)
            return {
              ok: true,
              message: `当前账号已切换为 ${account?.label ?? args.accountId}`,
              data: jsonSafe({ activeAccountId: args.accountId }),
            }
          }
          case 'test': {
            const accountId = ops.resolveAccountId(args.accountId)
            const result = await ops.testAccount(accountId)
            return {
              ok: result.ok,
              message: result.ok
                ? `连接成功（${String(result.latencyMs)}ms，${result.role ?? '未知权限'}）${
                    result.hydro?.installed === true ? `，Hydro ${result.hydro.version ?? '?'}（${result.hydro.installDir ?? '?'}）` : '，远端未安装 Hydro'
                  }`
                : `连接失败：${result.message}`,
              data: jsonSafe(result),
            }
          }
          default:
            throw new Error(`未知 action: ${String(args.action)}`)
        }
      },
    }),
  )
}
