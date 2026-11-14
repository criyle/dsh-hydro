/**
 * Local TCP port forwarding through an SSH connection.
 *
 * A local `net` server is bound and each accepted socket is bridged to the
 * remote end with `client.forwardOut` (the `direct-tcpip` channel type). This
 * is how the plugin reaches services bound to the remote loopback interface,
 * e.g. MongoDB on `127.0.0.1:27017`.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net'
import type { Client } from 'ssh2'
import { SshError } from './errors.js'
import type { LocalForward } from './types.js'

export interface ForwardLocalToRemoteOptions {
  localHost?: string
  localPort?: number
  remoteHost: string
  remotePort: number
}

class LocalForwardImpl implements LocalForward {
  localHost: string
  localPort: number

  private readonly server: NetServer
  private readonly sockets: Set<Socket>
  private closing: Promise<void> | undefined

  constructor(server: NetServer, sockets: Set<Socket>, localHost: string, localPort: number) {
    this.server = server
    this.sockets = sockets
    this.localHost = localHost
    this.localPort = localPort
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = new Promise<void>((resolve) => {
      for (const socket of this.sockets) socket.destroy()
      this.sockets.clear()
      if (!this.server.listening) {
        resolve()
        return
      }
      this.server.close(() => resolve())
      // Safety net: a hanging close must not leak the listening socket forever.
      const timer = setTimeout(() => resolve(), 1_000)
      timer.unref?.()
    })
    return this.closing
  }
}

/**
 * Bind a local TCP listener whose connections are forwarded to
 * `remoteHost:remotePort` through `client`.
 *
 * Resolves once the listener is bound (so `localPort` is valid, including when
 * port `0` was requested) and rejects if binding fails.
 */
export function forwardLocalToRemote(
  client: Client,
  options: ForwardLocalToRemoteOptions,
): Promise<LocalForward> {
  const localHost = options.localHost ?? '127.0.0.1'
  const sockets = new Set<Socket>()

  return new Promise<LocalForward>((resolve, reject) => {
    let settled = false
    const server = createServer((socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())

      const sourceHost = socket.remoteAddress ?? '127.0.0.1'
      const sourcePort = socket.remotePort ?? 0
      client.forwardOut(sourceHost, sourcePort, options.remoteHost, options.remotePort, (error, channel) => {
        if (error || channel === undefined) {
          socket.destroy()
          return
        }
        socket.once('close', () => channel.destroy())
        channel.once('close', () => socket.destroy())
        channel.once('error', () => socket.destroy())
        channel.pipe(socket)
        socket.pipe(channel)
      })
    })

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      reject(
        new SshError(
          `Failed to bind local port ${localHost}:${options.localPort ?? 0} for forwarding to ${options.remoteHost}:${options.remotePort}: ${error.message}`,
          { cause: error, code: error.code ?? 'FORWARD_BIND_FAILED' },
        ),
      )
    })

    server.listen({ host: localHost, port: options.localPort ?? 0 }, () => {
      if (settled) return
      settled = true
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new SshError('Local forward listener did not produce a TCP address'))
        return
      }
      resolve(new LocalForwardImpl(server, sockets, localHost, address.port))
    })
  })
}
