/**
 * Session bootstrap shared by the Hydro problem and contest tools.
 *
 * The tools never create SSH connections or read secrets themselves: the
 * caller-owned `HydroOpsApi` resolves the account, enforces the read-only
 * guard, opens (or reuses) the connection, and hands back the Hydro admin
 * credentials. This module only turns that into a short-lived HTTP session.
 */
import { openHydroSession } from '../hydro/api.js'
import type { HydroSession } from '../hydro/api.js'
import type { AccountContext } from '../ops/types.js'
import type { HydroOpsApi } from '../ops/hydro-ops.js'

/** The slice of {@link ToolDeps} this helper needs (keeps it test-friendly). */
export interface HydroSessionDeps {
  ops: HydroOpsApi
}

/** Session plus the account context it was opened for. */
export interface HydroSessionScope {
  session: HydroSession
  context: AccountContext
}

export interface WithHydroSessionOptions {
  /** Run inside the read-only guard (required for remote mutations). */
  writable: boolean
  /** Cancels login and in-flight requests. Defaults to the context signal. */
  signal?: AbortSignal
}

/**
 * Open an authenticated Hydro session for one account, run `fn`, always close.
 *
 * Throws a model-facing error when the account has no Hydro admin credentials,
 * because every problem/contest operation needs an authenticated session.
 */
export async function withHydroSession<T>(
  deps: HydroSessionDeps,
  accountId: string | undefined,
  action: string,
  fn: (scope: HydroSessionScope) => Promise<T>,
  options: WithHydroSessionOptions,
): Promise<T> {
  const id = deps.ops.resolveAccountId(accountId)
  const run = async (context: AccountContext): Promise<T> => {
    const credentials = await deps.ops.getSiteSession(id)
    if (credentials.sid === null) {
      throw new Error(
        `账号 ${context.account.label} 还没有登录 Hydro：请在内嵌浏览器中登录该账号后重试。`,
      )
    }
    const port = await deps.ops.hydroPort(context)
    const signal = options.signal ?? context.signal
    const session = await openHydroSession(context, {
      port,
      sid: credentials.sid,
      ...(signal === undefined ? {} : { signal }),
    })
    try {
      return await fn({ session, context })
    } finally {
      await session.close().catch(() => undefined)
    }
  }
  if (options.writable) return deps.ops.withWritableContext(id, action, run)
  return deps.ops.withContext(id, run)
}
