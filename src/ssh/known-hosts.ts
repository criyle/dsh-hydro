/**
 * Minimal OpenSSH `known_hosts` handling for host key verification.
 *
 * Supported entry format is the plain (non-hashed) one produced by OpenSSH:
 *
 *   hostname keytype base64-key comment
 *   [hostname]:port keytype base64-key comment     (for non-22 ports)
 *
 * LIMITATIONS (deliberate, documented):
 * - Hashed host names (`HashKnownHosts yes`, entries starting with `|1|`) are
 *   NOT supported. They are ignored, so `strict` would fail and `accept-new`
 *   would add a second plain entry. Users with hashed known_hosts should point
 *   `knownHostsPath` at a separate file or use `hostKeyPolicy: 'off'`.
 * - Hostname wildcard patterns (`*.example.com`) and `@cert-authority` /
 *   `@revoked` markers are ignored.
 * - Only one key type per host is added per connection (the type actually
 *   negotiated); multiple entry types for the same host are fine.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Marker used when creating a new known_hosts file. */
const NEW_FILE_HEADER = [
  '# dsh-hydro known_hosts (trust on first use).',
  '# NOTE: hashed host names (HashKnownHosts / entries starting with |1|) are NOT supported;',
  '# entries below are stored as plain text. See src/ssh/known-hosts.ts for details.',
  '',
].join('\n')

export interface KnownHostCheckOptions {
  policy: 'accept-new' | 'strict'
  knownHostsPath: string
}

export interface KnownHostCheckResult {
  ok: boolean
  /** Human readable failure reason when `ok` is false. */
  reason?: string
  /** `true` when a new entry was appended to known_hosts. */
  added?: boolean
}

/** Parse an SSH public key blob and return its algorithm name and base64 form. */
export function parseHostKeyBlob(blob: Buffer): { algo: string; base64: string } {
  if (blob.length < 4) throw new Error('malformed host key blob')
  const algoLength = blob.readUInt32BE(0)
  if (algoLength === 0 || algoLength > blob.length - 4) throw new Error('malformed host key blob')
  const algo = blob.subarray(4, 4 + algoLength).toString('utf8')
  return { algo, base64: blob.toString('base64') }
}

/** Format the host field of a known_hosts entry (`[host]:port` unless port is 22). */
export function formatKnownHostsHost(host: string, port: number | undefined): string {
  const effectivePort = port ?? 22
  if (effectivePort === 22) return host
  // IPv6 literals are already bracketed by callers rarely; normalize.
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return `[${normalized}]:${effectivePort}`
}



interface KnownHostsEntry {
  hosts: string[]
  keyType: string
  base64: string
}

/** Parse the known_hosts file into entries, skipping comments/markers we do not support. */
function readKnownHosts(path: string): KnownHostsEntry[] {
  const entries: KnownHostsEntry[] = []
  if (!existsSync(path)) return entries
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return entries
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('@')) continue // @cert-authority / @revoked are unsupported
    if (line.startsWith('|')) continue // hashed host names are unsupported
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const hosts = (parts[0] as string).split(',')
    const keyType = parts[1] as string
    const base64 = parts[2] as string
    entries.push({ hosts, keyType, base64 })
  }
  return entries
}

function hostMatches(entryHosts: string[], hostField: string): boolean {
  return entryHosts.some((entryHost) => entryHost === hostField || entryHost === hostField.toLowerCase())
}

/** Ensure the known_hosts file (and its directory) exists with private permissions. */
function ensureKnownHostsFile(path: string): void {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // `wx`: create exclusively with 0600 so two concurrent first-use connections
  // cannot truncate each other's entries; an EEXIST race is harmless.
  try {
    writeFileSync(path, NEW_FILE_HEADER, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** Append a line to known_hosts, creating the file with 0600 if it does not exist. */
function appendKnownHostsLine(path: string, line: string): void {
  ensureKnownHostsFile(path)
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
  appendFileSync(path, `${prefix}${line}\n`, { mode: 0o600 })
}

/**
 * Check a server host key blob against the known_hosts file.
 *
 * Synchronous on purpose: it is called from ssh2's `hostVerifier`, which may
 * return its decision synchronously.
 */
export function checkHostKey(
  blob: Buffer,
  target: { host: string; port?: number },
  options: KnownHostCheckOptions,
): KnownHostCheckResult {
  const hostField = formatKnownHostsHost(target.host, target.port)
  let parsed: { algo: string; base64: string }
  try {
    parsed = parseHostKeyBlob(blob)
  } catch (error) {
    return { ok: false, reason: `unparseable server host key (${(error as Error).message})` }
  }

  const entries = readKnownHosts(options.knownHostsPath)
  const sameHost = entries.filter((entry) => hostMatches(entry.hosts, hostField))
  const sameType = sameHost.filter((entry) => entry.keyType === parsed.algo)

  if (sameType.length > 0) {
    if (sameType.some((entry) => entry.base64 === parsed.base64)) return { ok: true }
    return {
      ok: false,
      reason: `host key mismatch: the ${parsed.algo} key for ${hostField} differs from the entry in ${options.knownHostsPath}. If this host was reinstalled or its key rotated, remove the stale entry and reconnect.`,
    }
  }

  if (options.policy === 'strict') {
    const detail =
      sameHost.length > 0
        ? `no known_hosts entry for ${hostField} with key type ${parsed.algo} (existing entries use another key type)`
        : `no known_hosts entry for ${hostField}`
    return {
      ok: false,
      reason: `${detail} in ${options.knownHostsPath}; refusing to connect under hostKeyPolicy='strict'`,
    }
  }

  // accept-new: trust on first use, per (host, key type).
  try {
    appendKnownHostsLine(
      options.knownHostsPath,
      `${hostField} ${parsed.algo} ${parsed.base64}`,
    )
  } catch (error) {
    return { ok: false, reason: `could not add host key to ${options.knownHostsPath}: ${(error as Error).message}` }
  }
  return { ok: true, added: true }
}

/** Default known_hosts location (`~/.ssh/known_hosts`). */
export function defaultKnownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts')
}

/** Resolve the configured known_hosts path (`undefined` uses the default). */
export function resolveKnownHostsPath(configured: string | undefined): string {
  return configured === undefined || configured.length === 0 ? defaultKnownHostsPath() : configured
}
