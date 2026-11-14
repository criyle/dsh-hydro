/**
 * SSH transport layer for dsh-hydro.
 *
 * The rest of the plugin should import only from this module.
 */

export { connectSsh } from './client.js'
export { generateKeyPair, type GeneratedKeyPair } from './keys.js'
export {
  SshError,
  SshTimeoutError,
  SshAbortError,
  describeTarget,
  isAbortError,
} from './errors.js'
export { shellQuote, withEnvironment } from './shell.js'
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  type ExecContext,
  type ExecSession,
} from './exec.js'
export {
  DEFAULT_MAX_READ_BYTES,
  type SftpHost,
} from './sftp.js'
export {
  defaultKnownHostsPath,
  formatKnownHostsHost,
  resolveKnownHostsPath,
  type KnownHostCheckOptions,
  type KnownHostCheckResult,
} from './known-hosts.js'
export type {
  SshTarget,
  SshAuth,
  SshConnectOptions,
  ExecOptions,
  ExecResult,
  RemoteStat,
  LocalForward,
  SshConnection,
} from './types.js'
