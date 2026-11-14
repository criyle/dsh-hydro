/**
 * Hydro discussion/community tool: list, read and reply to discussions.
 *
 * This is the public "community" surface used by an AI operator to read a
 * thread before answering. Writes require confirm=true and the read-only guard;
 * every reply is an ordinary Hydro discussion reply made through the active
 * site account's HTTP session.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { withHydroSession } from '../agent/session.js'
import type { HydroSession } from '../hydro/api.js'
import { jsonSafe, textResult } from './format.js'
import type { ToolDeps } from './types.js'

interface DiscussionSummary {
  did: string
  title: string
  content: string
  owner: number | null
  replyCount: number | null
  updatedAt: string | null
}

function domainOf(domain: string | undefined, deps: ToolDeps): string {
  return domain === undefined || domain.trim() === '' ? deps.config.problem.defaultDomain : domain.trim()
}

function pickList(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object') return []
  const record = body as Record<string, unknown>
  for (const key of ['ddocs', 'docs', 'data']) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return Array.isArray(body) ? body : []
}

function summarize(doc: unknown): DiscussionSummary {
  const record = doc !== null && typeof doc === 'object' ? doc as Record<string, unknown> : {}
  return {
    did: String(record.docId ?? record._id ?? ''),
    title: typeof record.title === 'string' ? record.title : '(无标题)',
    content: typeof record.content === 'string' ? record.content.slice(0, 500) : '',
    owner: typeof record.owner === 'number' ? record.owner : null,
    replyCount: typeof record.nReply === 'number' ? record.nReply : null,
    updatedAt: typeof record.updateAt === 'string' ? record.updateAt : typeof record._id === 'object' ? String(record._id) : null,
  }
}

async function listDiscussions(session: HydroSession, domain: string, limit: number): Promise<DiscussionSummary[]> {
  const body = await session.getJson(`/d/${encodeURIComponent(domain)}/discuss?page=1`)
  return pickList(body).slice(0, limit).map(summarize)
}

export function registerDiscussionTools(deps: ToolDeps): void {
  const { ctx } = deps
  ctx.tools.register(
    defineTool({
      name: 'hydro_discussion',
      description: [
        'Hydro 社区讨论工具：读取域内讨论列表/详情，或回复某个讨论。',
        'list=最近讨论；read=读取一个讨论及其回复；reply=在讨论下发回复（需要 confirm=true，受只读模式保护）。',
        '回复前应先 read，确认上下文和语气；默认不要批量刷回复。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['list', 'read', 'reply'], required: true, description: '操作类型' },
        domain: { type: 'string', description: '域 id，默认 system' },
        did: { type: 'string', description: '讨论 id（read/reply 必需）' },
        content: { type: 'string', description: 'reply 的 Markdown 内容' },
        limit: { type: 'integer', description: 'list 返回条数，默认 10，最多 30' },
        confirm: { type: 'boolean', description: 'reply 必须为 true' },
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
      async execute(args, exec) {
        const domain = domainOf(args.domain, deps)
        const signal = exec.signal
        if (args.action === 'list') {
          const limit = Math.min(Math.max(args.limit ?? 10, 1), 30)
          const result = await withHydroSession(deps, args.accountId, 'hydro_discussion.list', async ({ session }) => {
            return listDiscussions(session, domain, limit)
          }, { writable: false, ...(signal === undefined ? {} : { signal }) })
          return {
            ok: true,
            message: `域 ${domain} 最近 ${String(result.length)} 条讨论：\n${result.map((item) => `- ${item.did} ${item.title}（回复 ${item.replyCount ?? '?'}）`).join('\n')}`,
            data: jsonSafe({ domain, discussions: result }),
          }
        }
        if (args.action === 'read') {
          const did = args.did
          if (did === undefined || did.trim() === '') throw new Error('read 需要 did')
          const result = await withHydroSession(deps, args.accountId, 'hydro_discussion.read', async ({ session }) => {
            const body = await session.getJson(`/d/${encodeURIComponent(domain)}/discuss/${encodeURIComponent(did)}`)
            const record = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
            return { ddoc: record.ddoc ?? null, drdocs: record.drdocs ?? record.replies ?? [] }
          }, { writable: false, ...(signal === undefined ? {} : { signal }) })
          return {
            ok: true,
            message: `讨论 ${did} 内容：\n\`\`\`json\n${JSON.stringify(result, null, 2).slice(0, 14_000)}\n\`\`\``,
            data: jsonSafe(result),
          }
        }
        if (args.confirm !== true) throw new Error('拒绝执行：回复讨论需要 confirm=true')
        const did = args.did
        const content = args.content
        if (did === undefined || did.trim() === '') throw new Error('reply 需要 did')
        if (content === undefined || content.trim() === '') throw new Error('reply 需要 content')
        await withHydroSession(deps, args.accountId, 'hydro_discussion.reply', async ({ session, context }) => {
          await session.postForm(`/d/${encodeURIComponent(domain)}/discuss/${encodeURIComponent(did)}`, {
            operation: 'reply',
            content,
          })
          return context.account.id
        }, { writable: true, ...(signal === undefined ? {} : { signal }) })
        return {
          ok: true,
          message: `已回复讨论 ${did}（域 ${domain}）。请打开讨论页复核。`,
          data: jsonSafe({ domain, did }),
        }
      },
    }),
  )
}
