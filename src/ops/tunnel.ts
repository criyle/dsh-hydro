/**
 * SSH local-port forwarding with per-account reuse.
 *
 * Hydro and MongoDB both listen on the remote loopback only in the default
 * install, so every HTTP/WebSocket/Mongo interaction goes through a tunnel
 * owned by this module. Forwards are reference-counted: the first caller opens
 * the local listener, later callers share it, and it closes when the last
 * release happens or the account context is disposed.
 */
import type { LocalForward } from '../ssh/index.js'
import type { AccountContext } from './types.js'

export interface OpenTunnelOptions {
  remotePort: number
  /** Defaults to 127.0.0.1 on the remote side. */
  remoteHost?: string
  /** Local bind address; defaults to 127.0.0.1. */
  localHost?: string
}

/** A shared forward plus its release function. */
export interface Tunnel {
  localHost: string
  localPort: number
  /** Local base URL, e.g. `http://127.0.0.1:53210`. */
  baseUrl: string
  release(): Promise<void>
}

interface TunnelEntry {
  forward: LocalForward
  refs: number
  closing: boolean
}

/**
 * Tunnels are keyed by account id, not by the context object: `withContext`
 * may hand out shallow copies of an `AccountContext` (for example to attach a
 * per-call abort signal), and those copies must still share one local listener.
 */
const tunnels = new Map<string, Map<string, TunnelEntry>>()
const tunnelOwners = new Map<string, Array<Promise<Tunnel>>>()

function accountKey(context: AccountContext): string {
  return context.account.id
}

function entriesOf(context: AccountContext): Map<string, TunnelEntry> {
  const key = accountKey(context)
  let map = tunnels.get(key)
  if (map === undefined) {
    map = new Map()
    tunnels.set(key, map)
  }
  return map
}

/**
 * Open (or reuse) a local forward to a remote port.
 *
 * The caller MUST call `release()` when done. Concurrent callers for the same
 * remote endpoint share one listener.
 */
export async function openTunnel(context: AccountContext, options: OpenTunnelOptions): Promise<Tunnel> {
  const remoteHost = options.remoteHost ?? '127.0.0.1'
  const key = `${remoteHost}:${String(options.remotePort)}`
  const map = entriesOf(context)
  const existing = map.get(key)
  if (existing !== undefined && !existing.closing) {
    existing.refs += 1
    return makeTunnel(existing, key, map)
  }
  const pending = context.connection
    .forwardLocalToRemote({
      remoteHost,
      remotePort: options.remotePort,
      ...(options.localHost === undefined ? {} : { localHost: options.localHost }),
    })
    .then((forward) => {
      const entry: TunnelEntry = { forward, refs: 1, closing: false }
      map.set(key, entry)
      return makeTunnel(entry, key, map)
    })
  const ownerKey = accountKey(context)
  const list = tunnelOwners.get(ownerKey) ?? []
  list.push(pending)
  tunnelOwners.set(ownerKey, list)
  return pending
}

function makeTunnel(entry: TunnelEntry, key: string, map: Map<string, TunnelEntry>): Tunnel {
  const localHost = entry.forward.localHost
  const localPort = entry.forward.localPort
  let released = false
  return {
    localHost,
    localPort,
    baseUrl: `http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${String(localPort)}`,
    async release() {
      if (released) return
      released = true
      entry.refs -= 1
      if (entry.refs > 0) return
      entry.closing = true
      if (map.get(key) === entry) map.delete(key)
      await entry.forward.close().catch(() => undefined)
    },
  }
}

/** Close every tunnel opened for one account context (call on disconnect). */
export async function closeTunnels(context: AccountContext): Promise<void> {
  const key = accountKey(context)
  const map = tunnels.get(key)
  tunnels.delete(key)
  if (map !== undefined) {
    await Promise.all([...map.values()].map((entry) => entry.forward.close().catch(() => undefined)))
  }
  const pending = tunnelOwners.get(key) ?? []
  tunnelOwners.delete(key)
  await Promise.all(pending.map((promise) => promise.catch(() => undefined)))
}
