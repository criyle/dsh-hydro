/**
 * Site-management operations for the browser half.
 *
 * "Host" operations (SSH, install, daemon) live on {@link HydroOpsApi}; this
 * service owns the Hydro *web admin* side: site accounts (one host can have
 * several logins with different privileges), domain configuration, objective
 * ZIP question-package import, problem/contest listings and the prompt used to launch
 * an AI authoring conversation.
 *
 * Site accounts are stored independently from hosts so an operator can keep,
 * for example, a super-admin login and a domain-admin login side by side.
 */
import type { HydroOpsApi } from '../ops/hydro-ops.js'
import type { AccountContext } from '../ops/types.js'
import type {
  SiteAccountSummary,
  SiteCollectionResponse,
  SiteInspectResponse,
  SiteRole,
  HostDataResponse,
} from '../shared/api.js'
import { getDomainConfig, openHydroSession, setDomainConfig, type HydroSession } from '../hydro/api.js'
import { PROBLEM_AUTHORING_GUIDE, OPS_GUIDE } from '../agent/prompts.js'
import type { StatusWarning } from '../shared/types.js'

/** Session opener injected for tests. */
export type SessionOpener = (context: AccountContext, options: { port: number; sid: string }) => Promise<HydroSession>

export interface SiteServiceDeps {
  ops: HydroOpsApi
  /** Defaults to the real SSH-tunnel HTTP session. */
  openSession?: SessionOpener
}

export interface SaveSiteAccountInput {
  id?: string
  hostId: string
  label?: string
  uname?: string
  domain?: string
  role?: SiteRole
  note?: string
  readonly?: boolean
}

/** Operations exposed to the site routes. */
export interface SiteService {
  listAccounts(hostId?: string): SiteAccountSummary[]
  getAccount(id: string): SiteAccountSummary | undefined
  saveAccount(input: SaveSiteAccountInput): Promise<SiteAccountSummary>
  removeAccount(id: string): Promise<boolean>
  setActive(id: string | null): Promise<void>
  activeSiteAccountId(): string | null
  inspect(siteAccountId: string): Promise<SiteInspectResponse>
  sessionStatus(siteAccountId: string): Promise<import('../shared/api.js').SiteSessionStatus>
  setDomain(siteAccountId: string, values: Record<string, string | number | boolean>, booleanKeys?: Record<string, boolean>): Promise<void>
  /** Import a Hydro ZIP problem package (the native `/problem/import/hydro` route). */
  importHydroZip(siteAccountId: string, input: { filename: string; data: Buffer; hidden?: boolean; preferredPrefix?: string }): Promise<{ ok: boolean; message: string }>
  /** Domains visible to this Hydro account, for the domain switcher. */
  listDomains(siteAccountId: string): Promise<{ domains: Array<{ id: string; name: string }> }>
  listCollection(siteAccountId: string, collection: 'problem' | 'contest', limit?: number): Promise<SiteCollectionResponse>
  authoringPrompt(siteAccountId: string, input: {
    kind: 'problem' | 'contest' | 'domain-bulletin' | 'domain-permissions' | 'discussion-reply'
    title?: string
    requirements?: string
    domain?: string
    problemId?: string
    contestId?: string
    discussionId?: string
    action?: string
  }): Promise<string>
  /** Close cached Hydro web sessions (plugin unload / account removal). */
  dispose(): Promise<void>
}

/** Read-only data payload used by the host data panel. */
export async function hostData(
  ops: HydroOpsApi,
  input: {
    hostId: string
    action: 'collections' | 'find' | 'oplog'
    collection?: string
    filter?: Record<string, unknown>
    limit?: number
    source?: 'auto' | 'hydro' | 'mongo'
    type?: string
    contains?: string
  },
): Promise<HostDataResponse> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  if (input.action === 'collections') {
    const collections = await ops.listCollections(input.hostId)
    return { action: 'collections', documents: collections, collection: null, truncated: false, note: null, mongoOplog: null }
  }
  if (input.action === 'oplog') {
    const result = await ops.queryOplog(input.hostId, {
      source: input.source ?? 'auto',
      limit,
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.contains === undefined ? {} : { contains: input.contains }),
    })
    return {
      action: 'oplog',
      documents: result.entries,
      collection: 'oplog',
      truncated: result.entries.length >= limit,
      note: result.note,
      mongoOplog: result.mongo,
    }
  }
  const collection = input.collection ?? 'oplog'
  const result = await ops.queryDatabase(input.hostId, {
    collection,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    limit,
    sort: { _id: -1 },
  })
  return {
    action: 'find',
    documents: result.documents,
    collection: result.collection,
    truncated: result.truncated,
    note: null,
    mongoOplog: null,
  }
}

/** Warning-only status collection for the site panel. */
export async function hostWarnings(ops: HydroOpsApi, hostId: string): Promise<{ warnings: StatusWarning[]; collectedAt: string }> {
  const status = await ops.collectStatus(hostId, {
    includeMongo: false,
    includeOplog: false,
    includeLatestVersions: false,
    includeWsWarnings: true,
  })
  const warnings = status.warnings.filter((warning) => warning.code.startsWith('hydro.ws') || warning.code.startsWith('hydro.oplog'))
  return { warnings, collectedAt: status.collectedAt }
}

/** Build the service; tests override `openSession`. */
export function createSiteService(deps: SiteServiceDeps): SiteService {
  const { ops } = deps
  const openSession: SessionOpener =
    deps.openSession ?? ((context, options) => openHydroSession(context, options))

  /**
   * Reuse one authenticated Hydro web session per site account.
   *
   * Hydro rate-limits `POST /login` (30/min per IP, 5/min per user); a panel
   * that logged in for every inspect/domain/import action would trip it.
   * Sessions are cached for a short idle window and closed on dispose.
   */
  const SESSION_TTL_MS = 15 * 60_000
  const sessions = new Map<string, { session: HydroSession; openedAt: number }>()

  const dropSession = async (siteAccountId: string): Promise<void> => {
    const cached = sessions.get(siteAccountId)
    sessions.delete(siteAccountId)
    await cached?.session.close().catch(() => undefined)
  }

  const sessionFor = async (siteAccountId: string): Promise<HydroSession> => {
    const cached = sessions.get(siteAccountId)
    if (cached !== undefined && Date.now() - cached.openedAt < SESSION_TTL_MS) return cached.session
    if (cached !== undefined) await dropSession(siteAccountId)
    const credentials = await ops.getSiteCredentials(siteAccountId)
    const session = await ops.withContext(credentials.hostId, async (context) => {
      const port = await ops.hydroPort(context)
      return openSession(context, { port, sid: credentials.sid })
    })
    sessions.set(siteAccountId, { session, openedAt: Date.now() })
    return session
  }

  const withSession = async <T>(siteAccountId: string, fn: (session: HydroSession) => Promise<T>): Promise<T> => {
    const hadCached = sessions.has(siteAccountId)
    const run = async (): Promise<T> => fn(await sessionFor(siteAccountId))
    try {
      return await run()
    } catch (error) {
      // Host operations (install/upgrade/service restart) invalidate every SSH
      // tunnel of the account, which also kills the local listener behind a
      // cached Hydro web session. Re-authenticate once instead of surfacing a
      // confusing "fetch failed" in the site panel.
      if (hadCached) {
        await dropSession(siteAccountId)
        return run()
      }
      if ((error as { status?: number }).status === 401) await dropSession(siteAccountId)
      throw error
    }
  }

  return {
    listAccounts(hostId) {
      return ops.listSiteAccounts(hostId)
    },

    getAccount(id) {
      return ops.getSiteAccountSummary(id)
    },

    async saveAccount(input) {
      const summary = input.id === undefined
        ? ops.getAccountSummary(input.hostId)
        : undefined
      if (input.id === undefined) {
        if (summary === undefined) throw new Error(`未知主机 ${input.hostId}`)
        if (input.uname === undefined || input.uname.trim() === '') throw new Error('请填写 Hydro 管理员用户名')
        return ops.addSiteAccount({
          hostId: input.hostId,
          ...(input.label === undefined ? {} : { label: input.label }),
          uname: input.uname,
          ...(input.domain === undefined ? {} : { domain: input.domain }),
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.readonly === undefined ? {} : { readonly: input.readonly }),
        })
      }
      const existing = ops.getSiteAccountSummary(input.id)
      if (existing === undefined) throw new Error(`未知站点账号 ${input.id}`)
      // Username changes invalidate the cached browser session.
      if (input.uname !== undefined) await dropSession(input.id)
      return ops.updateSiteAccount(input.id, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.uname === undefined ? {} : { uname: input.uname }),
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.readonly === undefined ? {} : { readonly: input.readonly }),
      })
    },

    async removeAccount(id) {
      const removed = await ops.removeSiteAccount(id)
      if (removed) await dropSession(id)
      return removed
    },

    async setActive(id) {
      await ops.setActiveSiteAccount(id)
    },

    activeSiteAccountId() {
      return ops.activeSiteAccountId()
    },

    async sessionStatus(siteAccountId) {
      const summary = ops.getSiteAccountSummary(siteAccountId)
      if (summary === undefined) throw new Error(`未知站点账号 ${siteAccountId}`)
      const capturedAt = summary.sessionCapturedAt
      if (!summary.hasSession) {
        await ops.setSiteSessionState(siteAccountId, 'missing')
        return {
          siteAccountId,
          state: 'missing',
          capturedAt: null,
          checkedAt: new Date().toISOString(),
          message: '还没有登录：请在内嵌浏览器中打开该主机并登录这个站点账号。',
        }
      }
      try {
        const credentials = await ops.getSiteCredentials(siteAccountId)
        await withSession(siteAccountId, async (session) => {
          const path = `/d/${encodeURIComponent(credentials.domain)}/domain/edit`
          const response = await session.request(path, { method: 'GET' })
          const location = response.headers.get('location') ?? ''
          const body = typeof response.body === 'string' ? response.body : ''
          if (response.status === 401
            || (response.status === 302 && /\/login(?:[/?#]|$)/.test(location))
            || (response.status === 200 && /(?:name=["']?uname|id=["']?login|登录 Hydro)/i.test(body))) {
            throw new Error('Hydro 登录已过期：请在内嵌浏览器中重新登录该账号。')
          }
        })
        await ops.setSiteSessionState(siteAccountId, 'active')
        return { siteAccountId, state: 'active', capturedAt, checkedAt: new Date().toISOString(), message: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/登录已过期|HTTP 401|\/login/.test(message)) {
          await ops.setSiteSessionState(siteAccountId, 'expired')
          return { siteAccountId, state: 'expired', capturedAt, checkedAt: new Date().toISOString(), message }
        }
        // A permissions error still means the session itself is valid.
        await ops.setSiteSessionState(siteAccountId, 'active')
        return { siteAccountId, state: 'active', capturedAt, checkedAt: new Date().toISOString(), message: null }
      }
    },

    async inspect(siteAccountId) {
      const credentials = await ops.getSiteCredentials(siteAccountId)
      const warnings = await hostWarnings(ops, credentials.hostId)
      const domain = await withSession(siteAccountId, async (session) =>
        getDomainConfig(session, credentials.domain),
      )
      return {
        siteAccountId,
        hostId: credentials.hostId,
        warnings: warnings.warnings,
        domain: { current: domain.current, settings: domain.settings },
        collectedAt: warnings.collectedAt,
      }
    },

    async setDomain(siteAccountId, values, booleanKeys) {
      const credentials = await ops.getSiteCredentials(siteAccountId)
      await withSession(siteAccountId, async (session) =>
        setDomainConfig(session, credentials.domain, values, booleanKeys),
      )
    },

    async importHydroZip(siteAccountId, input) {
      const credentials = await ops.getSiteCredentials(siteAccountId)
      if (!/^[A-Za-z0-9._-]+$/.test(input.filename)) throw new Error('文件名不合法')
      const fields: Record<string, string> = {
        keepUser: 'false',
        hidden: input.hidden === true ? 'true' : 'false',
      }
      if (input.preferredPrefix !== undefined && input.preferredPrefix.trim() !== '') {
        if (!/^[A-Za-z]+$/.test(input.preferredPrefix.trim())) throw new Error('题目前缀只能包含字母')
        fields.preferredPrefix = input.preferredPrefix.trim()
      }
      await withSession(siteAccountId, async (session) => {
        await session.postMultipart(
          `/d/${encodeURIComponent(credentials.domain)}/problem/import/hydro`,
          { name: input.filename, data: input.data, type: 'application/zip' },
          fields,
        )
      })
      return { ok: true, message: `已提交 Hydro 题包导入：${input.filename}` }
    },

    async listDomains(siteAccountId) {
      const credentials = await ops.getSiteCredentials(siteAccountId)
      const result = await ops.queryDatabase(credentials.hostId, {
        collection: 'domain',
        projection: { name: 1 },
        limit: 100,
        sort: { _id: 1 },
      })
      const domains = result.documents.map((document) => {
        const record = document as { _id?: unknown; name?: unknown }
        const id = typeof record._id === 'string' ? record._id : String(record._id ?? '')
        const name = typeof record.name === 'string' && record.name !== '' ? record.name : id
        return { id, name }
      }).filter((domain) => domain.id !== '')
      if (!domains.some((domain) => domain.id === credentials.domain)) {
        domains.unshift({ id: credentials.domain, name: credentials.domain })
      }
      return { domains }
    },

    async listCollection(siteAccountId, collection, limit = 20) {
      const credentials = await ops.getSiteCredentials(siteAccountId)
      // Hydro 5 stores problems and contests in the unified `document`
      // collection, discriminated by `docType` (10 = problem, 30 = contest).
      const docType = collection === 'problem' ? 10 : 30
      const result = await ops.queryDatabase(credentials.hostId, {
        collection: 'document',
        filter: { docType },
        limit: Math.min(Math.max(limit, 1), 50),
        sort: { _id: -1 },
        projection: collection === 'problem'
          ? { docId: 1, pid: 1, title: 1, hidden: 1, nSubmit: 1, nAccept: 1 }
          : { docId: 1, title: 1, rule: 1, beginAt: 1, endAt: 1, pids: 1 },
      })
      return { collection, documents: result.documents }
    },

    async authoringPrompt(siteAccountId, input) {
      const account = ops.getSiteAccountSummary(siteAccountId)
      if (account === undefined) throw new Error(`未知站点账号 ${siteAccountId}`)
      const host = ops.getAccountSummary(account.hostId)
      if (host === undefined) throw new Error(`未知主机 ${account.hostId}`)
      const domain = input.domain ?? account.domain ?? 'system'
      const requirements = input.requirements?.trim() ?? ''
      const title = input.title?.trim() ?? ''
      const header = [
        `你正在操作 Hydro 服务器「${host.label}」（${host.username}@${host.host}:${String(host.port)}）。`,
        `当前 站点账号：${account.label}（${account.uname}，权限：${account.role}），域：${domain}。`,
        '请直接使用 hydro_* 工具通过该账号的管理 API 完成修改；不要执行安装/升级/系统配置等主机级危险操作。',
        '',
      ]
      if (input.kind === 'discussion-reply') {
        const did = input.discussionId?.trim() ?? ''
        return [
          ...header,
          `任务：阅读并回复 Hydro 讨论${did === '' ? '' : ` ${did}`}。`,
          `用户要求：${requirements === '' ? '先读取讨论上下文，总结问题；不要未经确认直接发回复。' : requirements}`,
          '',
          '原则：',
          '- 先用 hydro_discussion action=read 读取讨论和回复；向用户概述上下文、指出可回复的点。',
          '- 只有用户明确同意后才用 hydro_discussion action=reply（confirm=true）发送；一次只回一条，禁止批量刷回复。',
          '- 回复要针对讨论内容，语气自然；不要发广告、引战或重复内容。',
        ].join('\n')
      }
      if (input.kind === 'domain-bulletin') {
        return [
          ...header,
          '任务：修改当前域的公告（bulletin）。',
          `用户需求：${requirements === '' ? '先询问用户希望公告写什么，再修改。' : requirements}`,
          '',
          '步骤：',
          `1. 用 hydro_domain_config action=get domain=${domain} 读取当前配置，保留其他字段。`,
          `2. 用 hydro_domain_config action=set domain=${domain} values={"bulletin":"..."} confirm=true 写入新公告。`,
          '3. 再 get 一次确认写入成功，并向用户展示最终公告。',
        ].join('\n')
      }
      if (input.kind === 'domain-permissions') {
        return [
          ...header,
          '任务：修改当前域的权限/角色分配。',
          `用户需求：${requirements === '' ? '先询问用户要调整哪个用户/角色、需要哪些权限，再进行修改。' : requirements}`,
          '',
          '原则：',
          '- 先只读列出当前角色和用户角色，向用户复述将要变更的内容，得到确认后再写。',
          '- 使用 hydro_domain_roles：action=list 查看角色；action=set-user 分配用户角色；action=set-permissions 修改角色权限（权限用 Hydro 的 permission bit 索引数组）；action=add-role/delete-role 增删角色。',
          '- 权限变更风险高，遵循最小权限；不要修改 root/default/guest 等内置角色，除非用户明确要求。',
        ].join('\n')
      }
      if (input.kind === 'contest') {
        if (input.contestId !== undefined && input.contestId !== '') {
          const page = input.action?.trim() ?? ''
          const pageHints: Record<string, string> = {
            edit: '当前在「比赛编辑」页面：优先修改比赛信息/时间/赛制。',
            management: '当前在「比赛管理」页面：可以修改比赛信息、题目列表，或发布公告。',
            clarification: '当前在「比赛公告（clarification）」页面：优先用 announce 发布/回复公告。',
            problems: '当前在「比赛题目列表」页面：优先调整题目列表或时间。',
          }
          const pageHint = pageHints[page] ?? ''
          return [
            ...header,
            `任务：修改比赛 ${input.contestId}。`,
            ...(pageHint === '' ? [] : [pageHint]),
            `用户需求：${requirements === '' ? '先询问用户要修改什么（标题/说明/时间/题目列表/赛制/公告）。' : requirements}`,
            '',
            '可用工具：hydro_contest action=info 读取比赛；action=edit 修改信息/时间；action=add_problems 调整题目列表（需完整字段）；action=announce 向参赛者发公告（广播 clarification）；action=scoreboard/balloons 读取比赛榜单/气球队列。',
            '注意：add_problems 会替换题目列表并需要完整比赛字段；先读取/向用户确认现有字段再重发。',
            '比赛进行中的公告、时间调整、题目变更都可以代劳，但每次写操作前要向用户确认，写后汇报差异。',
          ].join('\n')
        }
        return [
          ...header,
          '任务：创建一场比赛。',
          `比赛标题：${title === '' ? '（请根据需求生成）' : title}`,
          `需求：${requirements === '' ? '常规 ACM 赛制，2 小时，包含 3 道题（可用已有题目）。' : requirements}`,
          '',
          OPS_GUIDE,
          '',
          '步骤建议：',
          '1. 用 hydro_contest action=create 创建比赛（domain、标题、规则、开始时间、时长、pids）。',
          '2. 如果题目不存在，先用 hydro_problem 生成并验证题目，再加入比赛。',
          '3. 用 hydro_status 检查服务与评测机状态，最后向用户汇报比赛 id 和链接。',
        ].join('\n')
      }
      if (input.problemId !== undefined && input.problemId !== '') {
        const actionKeys: Record<string, string> = {
          'edit-statement': '修改题面',
          'generate-std': '生成标程',
          'generate-data': '生成/强化数据',
          'add-partial': '添加部分分',
          verify: '验证题目',
          'edit-info': '修改比赛信息',
          'edit-problems': '调整题目列表',
          'edit-schedule': '调整比赛时间',
        }
        const rawAction = input.action?.trim() ?? ''
        const pageHints: Record<string, string> = {
          edit: '当前在「题目编辑」页面',
          files: '当前在「题目数据文件」页面',
          submit: '当前在「题目提交」页面',
          view: '当前在「题目详情」页面',
        }
        const pageHint = pageHints[rawAction] ?? ''
        const action = rawAction === '' ? '' : (actionKeys[rawAction] ?? rawAction)
        return [
          ...header,
          `任务：修改题目 ${input.problemId}。`,
          ...(pageHint === '' ? [] : [`上下文：${pageHint}。`]),
          `用户需求：${requirements === '' ? '先询问用户要修改什么（题面/数据/标程/部分分/评测配置）。' : requirements}`,
          ...(action === '' ? [] : [`优先动作：${action}`]),
          '',
          '可用工具：',
          '- hydro_problem action=info 读取现有题面/配置/数据列表；',
          '- hydro_problem action=edit 修改标题/题面/难度/隐藏状态；',
          '- hydro_problem action=upload 上传修改后的 testdata/（含 config.yaml）；',
          '- hydro_problem action=submit 提交代码验证；action=verify 验证 std/部分分；action=publish 发布。',
          '先读取现状并复述修改方案，得到用户确认后再写入；不要删除已有数据文件。',
        ].join('\n')
      }
      return [
        ...header,
        '任务：创建一道可评测的编程题（包含题面、数据、std、部分分程序并完成验证）。',
        `题目名称：${title === '' ? '（请根据需求生成）' : title}`,
        `需求：${requirements === '' ? '常规算法题，1 秒 / 256MB，包含 2 个部分分档位。' : requirements}`,
        '',
        PROBLEM_AUTHORING_GUIDE,
        '',
        '执行要求：',
        '1. 用 hydro_problem action=scaffold 建立本地题包（放在当前工作目录的 hydro-problems/ 下）。',
        '2. 写题面、std、暴力/部分分、生成器与 config.yaml；用 hydro_problem action=create/upload。',
        '3. 用 hydro_problem action=verify 提交 std 与部分分并检查得分，通过后再 publish。',
        '4. 汇报最终题号、题目标题、各程序得分与访问链接。',
      ].join('\n')
    },

    async dispose() {
      const ids = [...sessions.keys()]
      await Promise.all(ids.map(async (siteAccountId) => dropSession(siteAccountId)))
    },
  }
}
