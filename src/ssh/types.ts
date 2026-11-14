/**
 * Public types for the SSH transport layer.
 *
 * These types are re-exported from `src/ssh/index.ts` and are the only SSH
 * surface the rest of the plugin should depend on.
 */

/** A remote SSH target. `port` defaults to 22. */
export interface SshTarget {
  host: string
  port?: number
  username: string
}

/** Authentication material accepted by {@link connectSsh}. */
export type SshAuth =
  | { kind: 'privateKey'; privateKey: string; passphrase?: string }
  | { kind: 'password'; password: string }

/** Options for {@link connectSsh}. */
export interface SshConnectOptions {
  target: SshTarget
  auth: SshAuth
  /**
   * Host key policy. Default `'accept-new'` (trust on first use).
   * - `'off'`: do not verify the host key (tests / explicit opt-out only).
   * - `'accept-new'`: verify against `knownHostsPath`; add the key on first use.
   * - `'strict'`: require an existing entry in `knownHostsPath`.
   */
  hostKeyPolicy?: 'off' | 'accept-new' | 'strict'
  /** Path to the OpenSSH `known_hosts` file. Defaults to `~/.ssh/known_hosts`. */
  knownHostsPath?: string
  /** Overall connect/handshake timeout in milliseconds. Default 20 000. */
  timeoutMs?: number
  /** SSH keepalive interval in milliseconds. `0`/omitted disables keepalives. */
  keepaliveMs?: number
  /** Aborts the connection attempt (and rejects with an `AbortError`). */
  signal?: AbortSignal
}

/** Options for {@link SshConnection.exec}. */
export interface ExecOptions {
  /** Data written to the remote command's stdin before EOF is sent. */
  stdin?: string
  /** Kill the remote command after this many milliseconds (resolves with `timedOut: true`). */
  timeoutMs?: number
  /** Aborts the command; the returned promise rejects with an `AbortError`. */
  signal?: AbortSignal
  /** Allocate a pty (needed for `su` / interactive prompts). */
  pty?: boolean
  /** Environment variables. They are exported in the remote shell before the command runs. */
  env?: Record<string, string>
  /**
   * Maximum number of bytes retained per output stream. Output beyond this is
   * dropped and a truncation marker is appended. Default 4 MiB.
   */
  maxOutputBytes?: number
  /** Observe stdout chunks as they arrive (used for live terminal output). */
  onStdout?: (chunk: string) => void
  /** Observe stderr chunks as they arrive (used for live terminal output). */
  onStderr?: (chunk: string) => void
}

/** Result of running a remote command. */
export interface ExecResult {
  /** Process exit code, or `null` when the command was killed / no status was reported. */
  code: number | null
  /** Termination signal name when the remote command was signalled. */
  signal?: string
  stdout: string
  stderr: string
  /** `true` when the local timeout elapsed and the channel was killed. */
  timedOut: boolean
}

/** A subset of POSIX stat information for a remote path. */
export interface RemoteStat {
  exists: boolean
  isDirectory: boolean
  size: number
  mode: number
}

/** A bound local TCP listener forwarding to a remote host:port. */
export interface LocalForward {
  localHost: string
  localPort: number
  close(): Promise<void>
}

/** A live SSH connection to a remote host. */
export interface SshConnection {
  readonly target: SshTarget
  readonly closed: boolean
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  readFile(remotePath: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<Buffer>
  writeFile(
    remotePath: string,
    data: string | Buffer,
    options?: { mode?: number; signal?: AbortSignal },
  ): Promise<void>
  mkdirp(remotePath: string, options?: { mode?: number; signal?: AbortSignal }): Promise<void>
  stat(remotePath: string, signal?: AbortSignal): Promise<RemoteStat>
  /** Run a command as root: `sudo -S` with a password when sudo exists, otherwise `su -` over a pty. */
  elevate(
    command: string,
    options?: { password?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecResult>
  /** Forward a local TCP port to a remote host:port (e.g. Mongo on remote 127.0.0.1:27017). */
  forwardLocalToRemote(options: {
    localHost?: string
    localPort?: number
    remoteHost: string
    remotePort: number
  }): Promise<LocalForward>
  close(): Promise<void>
}
