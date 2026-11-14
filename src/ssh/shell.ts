/**
 * Shell quoting helpers.
 *
 * All remote commands are executed by the remote user's login shell through
 * SSH `exec`, so any value that ends up inside a command line must be quoted
 * for a POSIX shell.
 */

import { SshError } from './errors.js'

const SAFE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Quote `value` for a POSIX shell. The result is always a single argument:
 * the value is wrapped in single quotes and embedded single quotes are
 * escaped as `'\''`. Empty strings become `''`.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''"
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Prefix `command` with `export` assignments for `env` (if any).
 *
 * The SSH `env` request is widely disabled on servers (OpenSSH only accepts
 * variables listed in `AcceptEnv`), so variables are exported in the remote
 * shell instead for reliability. Values are shell quoted; names must be valid
 * POSIX identifiers so they cannot inject additional commands.
 */
export function withEnvironment(command: string, env?: Record<string, string>): string {
  if (!env) return command
  const names = Object.keys(env)
  if (names.length === 0) return command

  const assignments: string[] = []
  for (const name of names) {
    if (!SAFE_ENV_NAME.test(name)) {
      throw new SshError(`Invalid environment variable name for remote command: ${JSON.stringify(name)}`)
    }
    assignments.push(`${name}=${shellQuote(env[name] as string)}`)
  }
  return `export ${assignments.join(' ')}; ${command}`
}

/** Escape a string so it can be embedded in a `RegExp` as a literal. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
