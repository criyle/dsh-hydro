/**
 * `hydro_contest` — create / edit a contest with its problem list.
 *
 * Hydro creates and edits contests through the same `operation=update` form;
 * `add_problems` re-sends the full edit payload (Hydro replaces the pid list).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { announceContest, createContest, deleteContest, domainPath, editContestProblems, toHydroDate } from '../hydro/api.js'
import { withHydroSession } from '../agent/session.js'
import type { ToolDeps } from './types.js'

/** Resolve the domain for one call. */
function resolveDomain(domain: string | undefined, deps: ToolDeps): string {
  if (domain !== undefined && domain.trim() !== '') return domain.trim()
  return deps.config.problem.defaultDomain
}

function requireString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`缺少 ${name}`)
  return value.trim()
}

/** Require and validate `YYYY-MM-DD`. */
function requireDate(value: string | undefined): string {
  const date = requireString(value, 'beginAtDate')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`beginAtDate 需要 YYYY-MM-DD，收到 ${date}`)
  return date
}

/** Require and validate `HH:MM`. */
function requireTime(value: string | undefined): string {
  const time = requireString(value, 'beginAtTime')
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`beginAtTime 需要 HH:MM，收到 ${time}`)
  return time
}

function requirePids(pids: Array<string | number> | undefined): Array<string | number> {
  if (pids === undefined || pids.length === 0) throw new Error('缺少 pids：至少需要一个题号')
  return pids
}

const contestOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', required: true, description: '执行的动作' },
    ok: { type: 'boolean', required: true, description: '动作是否成功' },
    message: { type: 'string', required: true, description: '中文摘要' },
    accountId: { type: 'string', description: '账号 id' },
    domain: { type: 'string', description: '域 id' },
    tid: { type: 'string', description: '比赛编号' },
    pids: { type: 'array', items: { type: 'string' }, description: '题目编号列表' },
    data: { type: 'json', description: '读取到的榜单/气球/比赛详情等原始数据' },
  },
} as const

/** Register the grouped `hydro_contest` tool. */
export function registerContestTools(deps: ToolDeps): void {
  const { ctx } = deps

  ctx.tools.register(
    defineTool({
      name: 'hydro_contest',
      description: [
        'HydroOJ 比赛工具（动作由 action 决定）：',
        'create=创建比赛（title/site/rule/beginAtDate/beginAtTime/durationHours/pids）；',
        'add_problems=用完整信息重发编辑请求（会替换题目列表，需要 tid 和全部比赛信息）；',
        'scoreboard=读取比赛榜单；balloons=读取气球队列；info=读取比赛信息；',
        'delete=删除比赛（会同时删除比赛讨论与提交记录，危险操作）。',
        '开始时间也可用 startAt（ISO 时间）自动换算；写操作受只读模式保护。',
      ].join(''),
      parameters: {
        accountId: { type: 'string', description: '账号 id，默认当前账号' },
        action: { type: 'string', enum: ['create', 'edit', 'info', 'add_problems', 'delete', 'announce', 'scoreboard', 'balloons'], required: true, description: '操作类型' },
        domain: { type: 'string', description: '域 id，默认账号默认域' },
        tid: { type: 'string', description: '比赛编号（add_problems/delete 必需）' },
        title: { type: 'string', description: '比赛标题' },
        statement: { type: 'string', description: '比赛说明 markdown（比赛描述）' },
        rule: { type: 'string', description: '赛制，如 acm / oi / ioi' },
        beginAtDate: { type: 'string', description: '开始日期 YYYY-MM-DD' },
        beginAtTime: { type: 'string', description: '开始时间 HH:MM' },
        startAt: { type: 'string', description: '开始时间 ISO 字符串（提供时忽略 beginAtDate/beginAtTime）' },
        durationHours: { type: 'number', description: '比赛时长（小时）' },
        pids: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          description: '题目编号列表（按顺序）',
        },
        rated: { type: 'boolean', description: '是否 rated' },
        autoHide: { type: 'boolean', description: '是否结束后自动隐藏' },
        lockMinutes: { type: 'integer', description: '封榜时间（分钟）' },
        timezone: { type: 'string', description: 'startAt 换算使用的 IANA 时区，默认本地时区' },
        confirm: { type: 'boolean', description: 'edit/add_problems/delete/announce 写操作需要 true' },
      },
      output: {
        schema: contestOutputSchema,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const action = args.action
        const signal = exec.signal
        const domainArg = args.domain

        if (action === 'info') {
          const tid = requireString(args.tid, 'tid')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_contest.info',
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              const body = await session.getJson(`/d/${encodeURIComponent(domain)}/contest/${encodeURIComponent(tid)}`)
              const tdoc = (body as { tdoc?: Record<string, unknown> }).tdoc ?? body
              return {
                action: 'info',
                ok: true,
                message: `比赛 ${tid}（域 ${domain}）信息：\n\`\`\`json\n${JSON.stringify(tdoc, null, 2).slice(0, 12_000)}\n\`\`\``,
                accountId: context.account.id,
                domain,
                tid,
                data: tdoc,
              }
            },
            { writable: false, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'scoreboard' || action === 'balloons') {
          const tid = requireString(args.tid, 'tid')
          return withHydroSession(
            deps,
            args.accountId,
            `hydro_contest.${action}`,
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              const path = domainPath(domain, `/contest/${encodeURIComponent(tid)}/${action === 'scoreboard' ? 'scoreboard' : 'balloon'}`)
              const body = await session.getJson(path)
              return {
                action,
                ok: true,
                message: `${action === 'scoreboard' ? '比赛榜单' : '气球队列'}（${tid}）：\n\`\`\`json\n${JSON.stringify(body, null, 2).slice(0, 12_000)}\n\`\`\``,
                accountId: context.account.id,
                domain,
                tid,
                data: body,
              }
            },
            { writable: false, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'announce') {
          const tid = requireString(args.tid, 'tid')
          const statement = requireString(args.statement, 'statement')
          if (args.confirm !== true) throw new Error('拒绝执行：发送比赛公告需要 confirm=true')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_contest.announce',
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              await announceContest(session, {
                domain,
                tid,
                content: statement,
                ...(args.pids === undefined || args.pids.length === 0 ? {} : { subject: Number(args.pids[0]) }),
              })
              return {
                action: 'announce',
                ok: true,
                message: `已向比赛 ${tid}（域 ${domain}）发送公告。`,
                accountId: context.account.id,
                domain,
                tid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'delete') {
          if (args.confirm !== true) throw new Error('拒绝执行：删除比赛需要 confirm=true')
          const tid = requireString(args.tid, 'tid')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_contest.delete',
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              await deleteContest(session, { domain, tid })
              return {
                action,
                ok: true,
                message: `已删除比赛 ${tid}（域 ${domain}）；其讨论、提交记录与比赛附件已被 Hydro 清理。`,
                accountId: context.account.id,
                domain,
                tid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        const title = requireString(args.title, 'title')
        const statement = requireString(args.statement, 'statement')
        const rule = requireString(args.rule, 'rule')
        const pids = requirePids(args.pids)
        if (typeof args.durationHours !== 'number' || !Number.isFinite(args.durationHours) || args.durationHours <= 0) {
          throw new Error('durationHours 必须是大于 0 的小时数')
        }
        const durationHours = args.durationHours
        const begin = args.startAt !== undefined
          ? (() => {
              const date = new Date(args.startAt)
              if (Number.isNaN(date.getTime())) throw new Error(`startAt 不是合法时间：${args.startAt}`)
              return toHydroDate(date, args.timezone)
            })()
          : { date: requireDate(args.beginAtDate), time: requireTime(args.beginAtTime) }

        if (action === 'edit') {
          const tid = requireString(args.tid, 'tid')
          if (args.confirm !== true) throw new Error('拒绝执行：修改比赛需要 confirm=true')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_contest.edit',
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              const body = await session.getJson(`/d/${encodeURIComponent(domain)}/contest/${encodeURIComponent(tid)}`)
              const tdoc = ((body as { tdoc?: Record<string, unknown> }).tdoc ?? body) as Record<string, unknown>
              const beginRaw = typeof tdoc.beginAt === 'string' ? new Date(tdoc.beginAt) : new Date()
              const begin = Number.isNaN(beginRaw.getTime()) ? toHydroDate(new Date(), args.timezone) : toHydroDate(beginRaw, args.timezone)
              const endRaw = typeof tdoc.endAt === 'string' ? new Date(tdoc.endAt) : null
              const existingDuration = endRaw !== null && !Number.isNaN(endRaw.getTime())
                ? Math.max(0.1, Math.round((endRaw.getTime() - beginRaw.getTime()) / 360_000) / 10)
                : 2
              const content = args.statement ?? (typeof tdoc.content === 'string' ? tdoc.content : '')
              await editContestProblems(session, {
                domain,
                tid,
                title: args.title ?? (typeof tdoc.title === 'string' ? tdoc.title : ''),
                content,
                rule: args.rule ?? (typeof tdoc.rule === 'string' ? tdoc.rule : 'acm'),
                beginAtDate: begin.date,
                beginAtTime: begin.time,
                durationHours: args.durationHours ?? existingDuration,
                pids: args.pids ?? (Array.isArray(tdoc.pids) ? tdoc.pids.map(String) : []),
                ...(typeof tdoc.rated === 'boolean' ? { rated: tdoc.rated } : {}),
                ...(typeof tdoc.autoHide === 'boolean' ? { autoHide: tdoc.autoHide } : {}),
              })
              return {
                action: 'edit',
                ok: true,
                message: `已修改比赛 ${tid}（域 ${domain}）。请用 hydro_contest action=info 复核。`,
                accountId: context.account.id,
                domain,
                tid,
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        if (action === 'add_problems') {
          const tid = requireString(args.tid, 'tid')
          if (args.confirm !== true) throw new Error('拒绝执行：修改比赛题目需要 confirm=true')
          return withHydroSession(
            deps,
            args.accountId,
            'hydro_contest.add_problems',
            async ({ session, context }) => {
              const domain = resolveDomain(domainArg, deps)
              await editContestProblems(session, {
                domain,
                tid,
                title,
                content: statement,
                rule,
                beginAtDate: begin.date,
                beginAtTime: begin.time,
                durationHours,
                pids,
                ...(args.rated === undefined ? {} : { rated: args.rated }),
              })
              return {
                action,
                ok: true,
                message:
                  `已更新比赛 ${tid}（域 ${domain}）：${pids.length} 道题（${pids.map(String).join(', ')}），` +
                  `开始 ${begin.date} ${begin.time}，时长 ${String(durationHours)} 小时。`,
                accountId: context.account.id,
                domain,
                tid,
                pids: pids.map(String),
              }
            },
            { writable: true, ...(signal === undefined ? {} : { signal }) },
          )
        }

        return withHydroSession(
          deps,
          args.accountId,
          'hydro_contest.create',
          async ({ session, context }) => {
            const domain = resolveDomain(domainArg, deps)
            const created = await createContest(session, {
              domain,
              title,
              content: statement,
              rule,
              beginAtDate: begin.date,
              beginAtTime: begin.time,
              durationHours,
              pids,
              ...(args.rated === undefined ? {} : { rated: args.rated }),
              ...(args.autoHide === undefined ? {} : { autoHide: args.autoHide }),
              ...(args.lockMinutes === undefined ? {} : { lockMinutes: args.lockMinutes }),
            })
            return {
              action,
              ok: true,
              message:
                `已创建比赛 ${created.tid}（域 ${domain}，赛制 ${rule}）：` +
                `开始 ${begin.date} ${begin.time}，时长 ${String(durationHours)} 小时，` +
                `${pids.length} 道题（${pids.map(String).join(', ')}）。`,
              accountId: context.account.id,
              domain,
              tid: created.tid,
              pids: pids.map(String),
            }
          },
          { writable: true, ...(signal === undefined ? {} : { signal }) },
        )
      },
    }),
  )
}
