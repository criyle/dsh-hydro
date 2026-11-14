/**
 * In-process fake HydroOJ admin HTTP server for unit tests.
 *
 * It implements the small endpoint surface the plugin uses (`/login`, problem
 * CRUD, multipart testdata upload, submit + record polling, contest create/edit,
 * domain config) and is reached through `FakeSshConnection.forwardTarget` so no
 * real network or real Hydro is involved.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted judge state for a submission, consumed in order by polls. */
export interface FakeRecordStep {
  status: number
  score?: number
  time?: number
  memory?: number
  testCases?: unknown[]
  compilerTexts?: string[]
  subtasks?: Record<string, unknown>
}

/** Planner deciding how a submission judges (default: AC, or WA for `// WA`). */
export type FakeRecordPlan = (submission: { lang: string; code: string; domain: string; pid: string }) => FakeRecordStep[]

export interface FakeProblem {
  pid: string
  domain: string
  title: string
  content: string
  hidden: boolean
  difficulty: number | null
  tags: string[]
}

export interface FakeContest {
  tid: string
  domain: string
  form: Record<string, string>
}

export interface FakeUpload {
  domain: string
  pid: string
  name: string
  type: string
  data: Buffer
}

export interface FakeSubmission {
  rid: string
  domain: string
  pid: string
  lang: string
  code: string
  plan: FakeRecordStep[]
  polls: number
}

export interface FakeHydroOptions {
  uname?: string
  password?: string
  sid?: string
  recordPlan?: FakeRecordPlan
  /** Initial domain settings returned by GET /domain/edit. */
  domainConfig?: Record<string, Record<string, string>>
}

/** Mutable server state tests can inspect and adjust. */
export interface FakeHydroState {
  uname: string
  password: string
  sid: string
  problems: Map<string, FakeProblem>
  uploads: FakeUpload[]
  submissions: Map<string, FakeSubmission>
  contests: Map<string, FakeContest>
  deletedContests: string[]
  domainConfig: Record<string, Record<string, string>>
  recordPlan: FakeRecordPlan
  loginCount: number
  /** Raw request log: `METHOD /path`. */
  requests: string[]
  nextProblemId: number
  nextRecordId: number
  nextContestId: number
}

export interface FakeHydro {
  server: Server
  port: number
  url: string
  state: FakeHydroState
  close(): Promise<void>
}

const DEFAULT_PLAN: FakeRecordPlan = (submission) => {
  const judging: FakeRecordStep = { status: 20, score: 0, time: 0, memory: 0 }
  if (submission.code.includes('// WA')) {
    return [
      judging,
      {
        status: 2,
        score: 50,
        time: 12,
        memory: 2048,
        testCases: [
          { id: 1, status: 1, score: 50, time: 6, memory: 2048, message: 'Correct' },
          { id: 2, status: 2, score: 0, time: 6, memory: 2048, message: 'Wrong Answer' },
        ],
        subtasks: { '1': { score: 30, status: 2 }, '2': { score: 20, status: 1 } },
      },
    ]
  }
  return [
    judging,
    {
      status: 1,
      score: 100,
      time: 10,
      memory: 1024,
      testCases: [{ id: 1, status: 1, score: 100, time: 10, memory: 1024, message: 'Correct' }],
      compilerTexts: [],
    },
  ]
}

/** Read the whole request body as a Buffer. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    chunks.push(buffer)
    size += buffer.byteLength
    if (size > 32 * 1024 * 1024) throw new Error('fake hydro: request body too large')
  }
  return Buffer.concat(chunks)
}

function parseUrlEncoded(body: Buffer): Record<string, string> {
  const text = body.toString('utf8')
  return Object.fromEntries(new URLSearchParams(text))
}

interface ParsedPart {
  name: string | null
  filename: string | null
  data: Buffer
}

/** Minimal multipart/form-data parser (fields + files). */
export function parseMultipart(body: Buffer, contentType: string): Record<string, ParsedPart[]> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (boundary === undefined) throw new Error('fake hydro: missing multipart boundary')
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: Record<string, ParsedPart[]> = {}
  let cursor = body.indexOf(delimiter)
  while (cursor !== -1) {
    const afterDelimiter = cursor + delimiter.byteLength
    // Final delimiter is `--boundary--`.
    if (body[afterDelimiter] === 0x2d && body[afterDelimiter + 1] === 0x2d) break
    let start = afterDelimiter
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2
    const next = body.indexOf(delimiter, start)
    if (next === -1) break
    let end = next
    // Strip the CRLF before the next delimiter.
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2
    const segment = body.subarray(start, end)
    const headerEnd = segment.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd !== -1) {
      const headerText = segment.subarray(0, headerEnd).toString('utf8')
      const data = segment.subarray(headerEnd + 4)
      const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] ?? ''
      const name = /(?:^|;\s*)name="([^"]*)"/i.exec(disposition)?.[1] ?? null
      const filename = /(?:^|;\s*)filename="([^"]*)"/i.exec(disposition)?.[1] ?? null
      const key = name ?? ''
      const list = parts[key] ?? []
      list.push({ name, filename, data })
      parts[key] = list
    }
    cursor = next
  }
  return parts
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    // No keep-alive: the fake SSH forward's close() would otherwise wait for
    // undici's idle socket timeout, adding seconds to every test.
    connection: 'close',
    ...headers,
  })
  response.end(text)
}

/** Start the fake Hydro server on a random loopback port. */
export async function startFakeHydro(options: FakeHydroOptions = {}): Promise<FakeHydro> {
  const state: FakeHydroState = {
    uname: options.uname ?? 'admin',
    password: options.password ?? 'secret',
    sid: options.sid ?? 'fake-sid-123',
    problems: new Map(),
    uploads: [],
    submissions: new Map(),
    contests: new Map(),
    deletedContests: [],
    domainConfig: options.domainConfig ?? {},
    recordPlan: options.recordPlan ?? DEFAULT_PLAN,
    loginCount: 0,
    requests: [],
    nextProblemId: 1000,
    nextRecordId: 1,
    nextContestId: 1,
  }

  const configYamlFor = (pid: string): string => {
    const configs = state.uploads.filter((upload) => upload.pid === pid && upload.name.toLowerCase() === 'config.yaml')
    const latest = configs[configs.length - 1]
    return latest === undefined ? '' : latest.data.toString('utf8')
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: { message: (error as Error).message } })
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push(`${method} ${url.pathname}${url.search}`)
    let pathname = url.pathname
    let domain = 'system'
    const domainMatch = /^\/d\/([^/]+)(\/.*)$/.exec(pathname)
    if (domainMatch !== null) {
      domain = decodeURIComponent(domainMatch[1] ?? 'system')
      pathname = domainMatch[2] ?? '/'
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request)
    const contentType = request.headers['content-type'] ?? ''
    const form = contentType.includes('multipart/form-data') ? {} : parseUrlEncoded(body)

    const authed = (request.headers.cookie ?? '').split(';').some((part) => part.trim() === `sid=${state.sid}`)
    if (pathname === '/login' && method === 'POST') {
      state.loginCount += 1
      if (form.uname === state.uname && form.password === state.password) {
        sendJson(response, 200, { url: '/' }, {
          'set-cookie': `sid=${state.sid}; Path=/; HttpOnly`,
        })
        return
      }
      sendJson(response, 403, {
        error: { name: 'InvalidPasswordError', message: 'Invalid password', code: 403 },
      })
      return
    }
    if (pathname === '/') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (!authed) {
      sendJson(response, 403, { error: { name: 'LoginRequiredError', message: 'Login required' } })
      return
    }

    const createMatch = /^\/problem\/create$/.exec(pathname)
    if (createMatch !== null && method === 'POST') {
      const pid = form.pid !== undefined && form.pid !== '' ? form.pid : `P${String(state.nextProblemId++)}`
      if (state.problems.has(pid)) {
        sendJson(response, 400, { error: { message: `problem ${pid} exists` } })
        return
      }
      state.problems.set(pid, {
        pid,
        domain,
        title: form.title ?? '',
        content: form.content ?? '',
        hidden: form.hidden === 'on',
        difficulty: form.difficulty === undefined ? null : Number(form.difficulty),
        tags: form.tag === undefined || form.tag === '' ? [] : form.tag.split(','),
      })
      sendJson(response, 200, { pid, url: `/p/${pid}` })
      return
    }

    const editMatch = /^\/p\/([^/]+)\/edit$/.exec(pathname)
    if (editMatch !== null && method === 'POST') {
      const pid = decodeURIComponent(editMatch[1] ?? '')
      const problem = state.problems.get(pid)
      if (problem === undefined) {
        sendJson(response, 404, { error: { message: `problem ${pid} not found` } })
        return
      }
      if (form.title !== undefined) problem.title = form.title
      if (form.content !== undefined) problem.content = form.content
      // Checkbox semantics: presence means checked.
      problem.hidden = form.hidden === 'on'
      if (form.difficulty !== undefined) problem.difficulty = Number(form.difficulty)
      sendJson(response, 200, { pid, url: `/p/${pid}` })
      return
    }

    const filesMatch = /^\/p\/([^/]+)\/files$/.exec(pathname)
    if (filesMatch !== null && method === 'POST') {
      const pid = decodeURIComponent(filesMatch[1] ?? '')
      if (!contentType.includes('multipart/form-data')) {
        sendJson(response, 400, { error: { message: 'expected multipart/form-data' } })
        return
      }
      const parts = parseMultipart(body, contentType)
      const filePart = parts.file?.[0]
      if (filePart === undefined) {
        sendJson(response, 400, { error: { message: 'missing file field' } })
        return
      }
      const name = filePart.filename ?? parts.filename?.[0]?.data.toString('utf8') ?? 'upload.bin'
      state.uploads.push({
        domain,
        pid,
        name,
        type: parts.type?.[0]?.data.toString('utf8') ?? 'testdata',
        data: Buffer.from(filePart.data),
      })
      sendJson(response, 200, { ok: true })
      return
    }

    const submitMatch = /^\/p\/([^/]+)\/submit$/.exec(pathname)
    if (submitMatch !== null && method === 'POST') {
      const pid = decodeURIComponent(submitMatch[1] ?? '')
      const rid = `r${String(state.nextRecordId++)}`
      const lang = form.lang ?? 'cc'
      const code = form.code ?? ''
      state.submissions.set(rid, {
        rid,
        domain,
        pid,
        lang,
        code,
        plan: state.recordPlan({ lang, code, domain, pid }),
        polls: 0,
      })
      sendJson(response, 200, { rid, url: `/record/${rid}` })
      return
    }

    const recordMatch = /^\/record\/([^/]+)$/.exec(pathname)
    if (recordMatch !== null && method === 'GET') {
      const rid = decodeURIComponent(recordMatch[1] ?? '')
      const submission = state.submissions.get(rid)
      if (submission === undefined) {
        sendJson(response, 404, { error: { message: `record ${rid} not found` } })
        return
      }
      const step = submission.plan[Math.min(submission.polls, submission.plan.length - 1)] ?? { status: 0 }
      submission.polls += 1
      sendJson(response, 200, {
        rdoc: {
          _id: rid,
          status: step.status,
          score: step.score ?? 0,
          time: step.time ?? 0,
          memory: step.memory ?? 0,
          testCases: step.testCases ?? [],
          compilerTexts: step.compilerTexts ?? [],
          subtasks: step.subtasks ?? {},
          progress: step.status === 20 ? 50 : 100,
        },
        pdoc: { docId: submission.pid, title: `problem ${submission.pid}` },
      })
      return
    }

    if ((pathname === '/contest/create' || /^\/contest\/([^/]+)\/edit$/.test(pathname)) && method === 'POST') {
      const editMatch2 = /^\/contest\/([^/]+)\/edit$/.exec(pathname)
      if (editMatch2 !== null) {
        const tid = decodeURIComponent(editMatch2[1] ?? '')
        const contest = state.contests.get(tid)
        if (form.operation === 'delete') {
          state.contests.delete(tid)
          state.deletedContests.push(tid)
          sendJson(response, 200, { url: '/contest' })
          return
        }
        if (contest === undefined) {
          sendJson(response, 404, { error: { message: `contest ${tid} not found` } })
          return
        }
        contest.form = { ...contest.form, ...form }
        sendJson(response, 200, { url: `/contest/${tid}` })
        return
      }
      const tid = `c${String(state.nextContestId++)}`
      state.contests.set(tid, { tid, domain, form })
      sendJson(response, 200, { tid, url: `/contest/${tid}` })
      return
    }

    if (pathname === '/domain/edit') {
      if (method === 'GET') {
        sendJson(response, 200, { current: state.domainConfig[domain] ?? {}, settings: { name: { type: 'string' } } })
        return
      }
      const current = state.domainConfig[domain] ?? {}
      for (const [key, value] of Object.entries(form)) {
        const booleanMatch = /^booleanKeys\[(.+)\]$/.exec(key)
        if (booleanMatch !== null) {
          current[booleanMatch[1] ?? key] = value === 'on' ? 'true' : value
          continue
        }
        current[key] = value
      }
      state.domainConfig[domain] = current
      sendJson(response, 200, { url: '/domain/dashboard' })
      return
    }

    const configMatch = /^\/p\/([^/]+)\/config$/.exec(pathname)
    if (configMatch !== null && method === 'GET') {
      const pid = decodeURIComponent(configMatch[1] ?? '')
      sendJson(response, 200, {
        testdata: state.uploads.filter((upload) => upload.pid === pid && upload.type === 'testdata').map((upload) => upload.name),
        config: configYamlFor(pid),
      })
      return
    }

    const problemMatch = /^\/p\/([^/]+)$/.exec(pathname)
    if (problemMatch !== null && method === 'GET') {
      const pid = decodeURIComponent(problemMatch[1] ?? '')
      const problem = state.problems.get(pid)
      if (problem === undefined) {
        sendJson(response, 404, { error: { message: `problem ${pid} not found` } })
        return
      }
      sendJson(response, 200, { pdoc: { ...problem, docId: problem.pid } })
      return
    }

    sendJson(response, 404, { error: { message: `fake hydro has no route for ${method} ${pathname}` } })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    server,
    port,
    url: `http://127.0.0.1:${String(port)}`,
    state,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
