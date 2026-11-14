/**
 * Local reverse proxy for embedded Hydro pages.
 *
 * The browser cannot reach a remote `127.0.0.1:80` Caddy directly, so the host
 * process opens an SSH tunnel to the remote Caddy port and serves a loopback
 * HTTP proxy. The proxy lives at the root of its own origin, which keeps
 * Hydro's absolute paths/cookies working without HTML rewriting. Cookies are
 * host-only on the loopback origin and forwarded back through the tunnel.
 *
 * Security: listeners bind 127.0.0.1 only and are closed with the plugin/host;
 * Hydro still enforces its own authentication.
 */
import http from 'node:http'
import type { Socket } from 'node:net'

import type { AccountContext } from './types.js'
import { openTunnel, type Tunnel } from './tunnel.js'

export interface EmbeddedContext {
  kind: 'problem' | 'contest' | 'domain' | 'problem-list' | 'contest-list'
  domain: string | null
  id: string | null
  /** Sub-page such as edit/files/management/clarification, `view` for the main page. */
  page: string | null
  path: string
}

/**
 * Recognise Hydro problem/contest/domain pages from a proxied request path.
 *
 * System-domain pages can appear with or without the `/d/system` prefix
 * (`/p/P1000/edit` vs `/d/system/p/P1000/edit`), so the parser has separate
 * patterns for both. The sub-page is preserved for the AI context badge.
 */
export function embeddedContextFromPath(rawPath: string): EmbeddedContext | null {
  const path = rawPath.split(/[?#]/)[0] ?? ''
  const itemPatterns: Array<{
    pattern: RegExp
    kind: 'problem' | 'contest'
    domainIndex: number
    idIndex: number
    pageIndex: number
  }> = [
    { pattern: /^\/d\/([^/]+)\/p\/([^/]+)(?:\/([^/?#]+))?/, kind: 'problem', domainIndex: 1, idIndex: 2, pageIndex: 3 },
    { pattern: /^\/p\/([^/]+)(?:\/([^/?#]+))?/, kind: 'problem', domainIndex: 0, idIndex: 1, pageIndex: 2 },
    { pattern: /^\/d\/([^/]+)\/contest\/([^/]+)(?:\/([^/?#]+))?/, kind: 'contest', domainIndex: 1, idIndex: 2, pageIndex: 3 },
    { pattern: /^\/contest\/([^/]+)(?:\/([^/?#]+))?/, kind: 'contest', domainIndex: 0, idIndex: 1, pageIndex: 2 },
  ]
  for (const item of itemPatterns) {
    const match = item.pattern.exec(path)
    if (match === null) continue
    return {
      kind: item.kind,
      domain: item.domainIndex === 0 ? 'system' : match[item.domainIndex] ?? 'system',
      id: match[item.idIndex] ?? null,
      page: match[item.pageIndex] ?? 'view',
      path,
    }
  }
  const domainEdit = /^\/d\/([^/]+)\/domain\/edit(?:\/|$)/.exec(path)
  if (domainEdit !== null) return { kind: 'domain', domain: domainEdit[1] ?? 'system', id: null, page: 'edit', path }
  const problemList = /^\/d\/([^/]+)\/p(?:\/|$)/.exec(path)
  if (problemList !== null) return { kind: 'problem-list', domain: problemList[1] ?? 'system', id: null, page: null, path }
  const contestList = /^\/d\/([^/]+)\/contest(?:\/|$)/.exec(path)
  if (contestList !== null) return { kind: 'contest-list', domain: contestList[1] ?? 'system', id: null, page: null, path }
  const systemProblemList = /^\/p(?:\/|$)/.exec(path)
  if (systemProblemList !== null) return { kind: 'problem-list', domain: 'system', id: null, page: null, path }
  const systemContestList = /^\/contest(?:\/|$)/.exec(path)
  if (systemContestList !== null) return { kind: 'contest-list', domain: 'system', id: null, page: null, path }
  return null
}

interface ProxyEntry {
  server: http.Server
  tunnel: Tunnel
  url: string
  upstreamOrigin: URL | null
  captureSession: ((sid: string) => void) | null
  /** SID injected upstream when the embedded browser has no fresh login. */
  seedSid: string | null
  lastContext: EmbeddedContext | null
}

/** Drop one cookie from a Cookie header. */
function withoutSid(cookie: string | undefined): string | undefined {
  if (cookie === undefined || cookie.trim() === '') return undefined
  const kept = cookie.split(';').map((part) => part.trim()).filter((part) => part !== '' && !/^sid=/i.test(part))
  return kept.length === 0 ? undefined : kept.join('; ')
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function copyHeaders(source: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  return headers
}

/** Keep in-iframe navigation for links Hydro marks as new-tab targets. */
const EMBED_NAV_SCRIPT = `<script>(function(){document.addEventListener('click',function(event){var node=event.target;while(node&&node!==document){if(node.tagName==='A'&&node.getAttribute('target')==='_blank'){event.preventDefault();window.location.href=node.href;return;}node=node.parentNode;}},true);})();</script>`

function injectEmbedScript(html: string): string {
  if (html.includes('dsh-hydro-embed-nav')) return html
  const tagged = EMBED_NAV_SCRIPT.replace('<script>', '<script data-dsh-hydro-embed-nav="1">')
  const index = html.toLowerCase().lastIndexOf('</body>')
  if (index === -1) return `${html}${tagged}`
  return `${html.slice(0, index)}${tagged}${html.slice(index)}`
}

function isDocumentRequest(request: http.IncomingMessage): boolean {
  if (request.method !== 'GET') return false
  const dest = request.headers['sec-fetch-dest']
  if (dest === 'document') return true
  const accept = request.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

function rewriteSetCookie(cookie: string): string {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, '')
    .replace(/;\s*secure/gi, '')
}

/**
 * Keep one loopback proxy per host, forwarding to the remote Caddy port.
 */
export class HydroProxyManager {
  private readonly entries = new Map<string, ProxyEntry>()
  private disposed = false

  /** Resolve (or create) the loopback proxy URL for one host. */
  async ensure(
    hostId: string,
    context: AccountContext,
    options: {
      remotePort?: number
      upstreamUrl?: string | null
      /** Called when the embedded browser receives a Hydro `sid` cookie. */
      captureSession?: ((sid: string) => void) | null
      /** Saved site-account SID seeded into upstream requests. */
      seedSid?: string | null
    } = {},
  ): Promise<{ url: string; upstreamOrigin: URL | null }> {
    if (this.disposed) throw new Error('proxy manager disposed')
    const existing = this.entries.get(hostId)
    if (existing !== undefined) {
      existing.captureSession = options.captureSession ?? null
      existing.seedSid = options.seedSid ?? null
      return { url: existing.url, upstreamOrigin: existing.upstreamOrigin }
    }
    const remotePort = options.remotePort ?? 80
    const tunnel = await openTunnel(context, { remotePort, remoteHost: '127.0.0.1' })
    let upstreamOrigin: URL | null = null
    if (options.upstreamUrl !== null && options.upstreamUrl !== undefined) {
      try { upstreamOrigin = new URL(options.upstreamUrl) } catch { upstreamOrigin = null }
    }
    const captureSession = options.captureSession ?? null
    const seedSid = options.seedSid ?? null
    const entry = await new Promise<ProxyEntry>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        this.forward(entryRef, request, response)
      })
      const entryRef: ProxyEntry = { server, tunnel, url: '', upstreamOrigin, captureSession, seedSid, lastContext: null }
      server.on('upgrade', (request, socket, head) => {
        this.upgrade(entryRef, request, socket as Socket, head)
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('proxy listen failed'))
          return
        }
        entryRef.url = `http://127.0.0.1:${String(address.port)}`
        resolve(entryRef)
      })
    })
    this.entries.set(hostId, entry)
    return { url: entry.url, upstreamOrigin }
  }

  /** What page the embedded browser last requested from this host's proxy. */
  context(hostId: string): EmbeddedContext | null {
    return this.entries.get(hostId)?.lastContext ?? null
  }

  /** Close one host's proxy (used after install/upgrade/service actions). */
  async close(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId)
    if (entry === undefined) return
    this.entries.delete(hostId)
    await new Promise<void>((resolve) => { entry.server.close(() => { resolve() }) })
    await entry.tunnel.release().catch(() => undefined)
  }

  /** Close every proxy. */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.entries.keys()].map(async (hostId) => this.close(hostId)))
  }

  private forward(entry: ProxyEntry, request: http.IncomingMessage, response: http.ServerResponse): void {
    const path = request.url ?? '/'
    const context = embeddedContextFromPath(path)
    if (context !== null) entry.lastContext = context
    const tunnelUrl = new URL(entry.tunnel.baseUrl)
    const headers = copyHeaders(request.headers)
    headers.host = entry.upstreamOrigin?.host ?? (request.headers.host ?? tunnelUrl.host)
    // Hydro validates CSRF by comparing the Referer host with the Host header.
    // The browser sees the loopback origin, so rewrite Origin/Referer to the
    // public Caddy origin while keeping the path.
    if (entry.upstreamOrigin !== null) {
      const origin = entry.upstreamOrigin.origin
      const originalReferer = headers.referer
      if (typeof originalReferer === 'string') {
        try {
          const parsed = new URL(originalReferer)
          headers.referer = `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`
        } catch {
          headers.referer = `${origin}/`
        }
      }
      if (typeof headers.origin === 'string') headers.origin = origin
    }
    const documentRequest = isDocumentRequest(request)
    // Ask Caddy for uncompressed HTML so we can inject the in-iframe navigation
    // shim; ordinary assets stay streamed/compressed.
    if (documentRequest) headers['accept-encoding'] = 'identity'
    // Make the embedded browser use the selected site-account login. The
    // browser's own cookie jar may still hold another account's sid, so always
    // replace/remove sid here; a login inside the frame updates seedSid below.
    const cookie = withoutSid(typeof headers.cookie === 'string' ? headers.cookie : undefined)
    const seeded = entry.seedSid === null
      ? cookie
      : `${cookie === undefined ? '' : `${cookie}; `}sid=${encodeURIComponent(entry.seedSid)}`
    if (seeded === undefined || seeded === '') delete headers.cookie
    else headers.cookie = seeded
    const upstream = http.request({
      host: tunnelUrl.hostname,
      port: tunnelUrl.port === '' ? 80 : Number(tunnelUrl.port),
      path,
      method: request.method,
      headers,
    }, (upstreamResponse) => {
      const responseHeaders = copyHeaders(upstreamResponse.headers)
      const location = upstreamResponse.headers.location
      if (typeof location === 'string' && entry.upstreamOrigin !== null) {
        try {
          const absolute = new URL(location, entry.upstreamOrigin)
          if (absolute.origin === entry.upstreamOrigin.origin) {
            responseHeaders.location = `${entry.url}${absolute.pathname}${absolute.search}`
          }
        } catch {
          // Keep the original Location.
        }
      }
      const cookies = upstreamResponse.headers['set-cookie']
      if (cookies !== undefined) {
        responseHeaders['set-cookie'] = cookies.map(rewriteSetCookie)
        for (const cookie of cookies) {
          const sid = /(?:^|[;,\s])sid=([^;]+)/.exec(cookie)
          if (sid?.[1] !== undefined && sid[1] !== '') {
            entry.seedSid = decodeURIComponent(sid[1])
            entry.captureSession?.(entry.seedSid)
          }
        }
      }
      delete responseHeaders['x-frame-options']
      const contentType = String(upstreamResponse.headers['content-type'] ?? '')
      const shouldInject = documentRequest
        && (upstreamResponse.statusCode ?? 0) === 200
        && contentType.toLowerCase().includes('text/html')
      if (!shouldInject) {
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      upstreamResponse.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= 5 * 1024 * 1024) chunks.push(chunk)
      })
      upstreamResponse.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
        const body = Buffer.from(injectEmbedScript(html), 'utf8')
        delete responseHeaders['content-encoding']
        responseHeaders['content-length'] = String(body.length)
        response.writeHead(upstreamResponse.statusCode ?? 200, responseHeaders)
        response.end(body)
      })
    })
    upstream.on('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(`Hydro proxy error: ${error.message}`)
      } else {
        response.destroy()
      }
    })
    request.pipe(upstream)
  }

  private upgrade(entry: ProxyEntry, request: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const tunnelUrl = new URL(entry.tunnel.baseUrl)
    const headers = copyHeaders(request.headers)
    headers.host = entry.upstreamOrigin?.host ?? (request.headers.host ?? tunnelUrl.host)
    headers.connection = 'Upgrade'
    headers.upgrade = request.headers.upgrade ?? 'websocket'
    const upstream = http.request({
      host: tunnelUrl.hostname,
      port: tunnelUrl.port === '' ? 80 : Number(tunnelUrl.port),
      path: request.url ?? '/',
      method: request.method,
      headers,
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket: Socket, upstreamHead: Buffer) => {
      const lines = [`HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      upstreamSocket.on('error', () => socket.destroy())
      socket.on('error', () => upstreamSocket.destroy())
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  }
}
