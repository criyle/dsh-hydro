/**
 * Wiring helpers: a fake Hydro HTTP server + fake SSH connection + account
 * context, plus a ready-to-use session factory.
 */
import { loginHydro, openHydroSession } from '../../src/hydro/api.js'
import type { HydroSession } from '../../src/hydro/api.js'
import type { AccountContext } from '../../src/ops/types.js'
import { FakeSshConnection, fakeContext } from '../helpers/fake-ssh.js'
import { startFakeHydro } from './fake-hydro.js'
import type { FakeHydro, FakeHydroOptions } from './fake-hydro.js'

export interface FakeHydroHarness {
  hydro: FakeHydro
  connection: FakeSshConnection
  context: AccountContext
  close(): Promise<void>
}

/** Start a fake Hydro server and an AccountContext whose SSH forwards to it. */
export async function startFakeHydroHarness(
  options: FakeHydroOptions & { context?: Partial<AccountContext> } = {},
): Promise<FakeHydroHarness> {
  const { context: contextOverrides, ...hydroOptions } = options
  const hydro = await startFakeHydro(hydroOptions)
  const connection = new FakeSshConnection({
    forwardTarget: { host: '127.0.0.1', port: hydro.port },
  })
  const context = fakeContext({
    ...contextOverrides,
    connection,
  })
  return {
    hydro,
    connection,
    context,
    async close(): Promise<void> {
      await connection.close()
      await hydro.close()
    },
  }
}

/** Open a logged-in session against the harness' fake Hydro. */
export async function openFakeSession(
  harness: FakeHydroHarness,
  options: { uname?: string; password?: string; signal?: AbortSignal } = {},
): Promise<HydroSession> {
  // Tests still exercise the login endpoint; production code receives the
  // browser-captured sid and never logs in with a password.
  const session = await openHydroSession(harness.context, {
    port: 8888,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  try {
    await loginHydro(
      harness.context,
      session,
      options.uname ?? harness.hydro.state.uname,
      options.password ?? harness.hydro.state.password,
    )
    return session
  } catch (error) {
    await session.close().catch(() => undefined)
    throw error
  }
}
