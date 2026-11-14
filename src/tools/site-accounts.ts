/**
 * Hydro site-account tools: manage the web-admin logins used for site
 * operations (domain config, problem authoring, judge checks), independently
 * from the SSH hosts they belong to.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { jsonSafe, textResult } from './format.js'
import type { ToolDeps } from './types.js'

const ROLES = ['superadmin', 'domain-admin', 'problem-setter', 'judge', 'custom'] as const

/** Render a compact site-account table. */
function formatSiteAccounts(accounts: ReturnType<ToolDeps['ops']['listSiteAccounts']>, activeId: string | null): string {
  if (accounts.length === 0) return '还没有站点账号。先用 hydro_site_accounts action=add 添加一个 Hydro Web 管理员账号。'
  const lines = ['站点账号（Hydro Web 管理员，用于域配置/出题/评测检查）：']
  for (const account of accounts) {
    const active = account.id === activeId ? ' ← 当前' : ''
    lines.push(
      `- ${account.id} ${account.label} | ${account.uname}@${account.hostLabel} | 域 ${account.domain} | ${account.role}${account.note === null ? '' : ` | ${account.note}`}${account.readonly ? ' | 只读' : ''}${account.hasSession ? ' | 已登录' : ' | 未登录（请在内嵌浏览器登录）'}${active}`,
    )
  }
  return lines.join('\n')
}

export function registerSiteAccountTools(deps: ToolDeps): void {
  const { ctx, ops } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_site_accounts',
      description: [
        '管理 站点账号（Web 管理员登录），与 SSH 主机分开保存：一台主机可以保存多个不同权限的账号。',
        'action=list 列出；add 在主机上添加；update 修改；remove 删除；use 设为当前站点账号。',
        '域配置、出题、比赛、评测检查等工具默认使用当前站点账号；也可以传 siteAccountId 指定。',
        '不保存密码：添加后用内嵌浏览器登录该账号，插件只保留浏览器带回的 session token。',
      ].join(''),
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove', 'use'], required: true, description: '操作类型' },
        siteAccountId: { type: 'string', description: '站点账号 id（update/remove/use 必填）' },
        hostId: { type: 'string', description: '所属主机 id（add 必填；默认当前主机）' },
        label: { type: 'string', description: '显示名称' },
        uname: { type: 'string', description: 'Hydro 管理员用户名' },
        domain: { type: 'string', description: '默认域，默认 system' },
        role: { type: 'string', enum: ROLES, description: '账号权限说明：superadmin/domain-admin/problem-setter/judge/custom' },
        note: { type: 'string', description: '备注，例如“只用于 class1”' },
        readonly: { type: 'boolean', description: '该站点账号只读：拒绝会修改 Hydro 站点的工具' },
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
            const accounts = ops.listSiteAccounts()
            const activeId = ops.activeSiteAccountId()
            return {
              ok: true,
              message: formatSiteAccounts(accounts, activeId),
              data: jsonSafe({ accounts, activeSiteAccountId: activeId }),
            }
          }
          case 'add': {
            const hostId = args.hostId ?? ops.activeAccountId() ?? undefined
            if (hostId === undefined) throw new Error('add 需要 hostId（或先添加主机）')
            if (args.uname === undefined) throw new Error('add 需要 uname')
            const account = await ops.addSiteAccount({
              hostId,
              uname: args.uname,
              ...(args.label === undefined ? {} : { label: args.label }),
              ...(args.domain === undefined ? {} : { domain: args.domain }),
              ...(args.role === undefined ? {} : { role: args.role }),
              ...(args.note === undefined ? {} : { note: args.note }),
              ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
            })
            return {
              ok: true,
              message: `已添加站点账号 ${account.id}（${account.uname}@${account.hostLabel}，${account.role}）`,
              data: jsonSafe({ account }),
            }
          }
          case 'update': {
            if (args.siteAccountId === undefined) throw new Error('update 需要 siteAccountId')
            const account = await ops.updateSiteAccount(args.siteAccountId, {
              ...(args.label === undefined ? {} : { label: args.label }),
              ...(args.uname === undefined ? {} : { uname: args.uname }),
              ...(args.domain === undefined ? {} : { domain: args.domain }),
              ...(args.role === undefined ? {} : { role: args.role }),
              ...(args.note === undefined ? {} : { note: args.note }),
              ...(args.readonly === undefined ? {} : { readonly: args.readonly }),
            })
            return {
              ok: true,
              message: `已更新站点账号 ${account.id}（${account.uname}@${account.hostLabel}）`,
              data: jsonSafe({ account }),
            }
          }
          case 'remove': {
            if (args.siteAccountId === undefined) throw new Error('remove 需要 siteAccountId')
            const removed = await ops.removeSiteAccount(args.siteAccountId)
            return {
              ok: removed,
              message: removed ? `已删除站点账号 ${args.siteAccountId}` : `未找到站点账号 ${args.siteAccountId}`,
              data: jsonSafe({ removed }),
            }
          }
          case 'use': {
            if (args.siteAccountId === undefined) throw new Error('use 需要 siteAccountId')
            await ops.setActiveSiteAccount(args.siteAccountId)
            const summary = ops.getSiteAccountSummary(args.siteAccountId)
            return {
              ok: true,
              message: `当前站点账号：${summary?.label ?? args.siteAccountId}（${summary?.uname ?? ''}@${summary?.hostLabel ?? ''}）`,
              data: jsonSafe({ activeSiteAccountId: ops.activeSiteAccountId(), account: summary }),
            }
          }
          default:
            throw new Error(`未知 action: ${String(args.action)}`)
        }
      },
    }),
  )
}
