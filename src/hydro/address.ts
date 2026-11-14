/**
 * Resolve a browser-reachable Hydro URL for embedded problem/contest/domain
 * pages. Hydro's own `server.url` system setting is authoritative; when it is
 * missing we only guess `http://<host>/` if Caddy is running.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { HostAddressResponse } from '../shared/api.js'
import { getSystemSetting } from './db.js'
import { probeHydro } from './detect.js'

/** Return the configured/detected URL, or null when the browser cannot open it. */
export async function collectHydroAddress(context: AccountContext, probe?: HydroProbe): Promise<HostAddressResponse> {
  const resolved = probe ?? (await probeHydro(context))
  if (!resolved.installed) return { url: null, source: null }
  try {
    const configured = await getSystemSetting(context, 'server.url', resolved)
    if (typeof configured === 'string' && /^https?:\/\//i.test(configured.trim())) {
      return { url: configured.trim().replace(/\/+$/, ''), source: 'server.url' }
    }
  } catch {
    // Mongo unavailable; fall through to the Caddy guess.
  }
  const caddy = resolved.pm2.find((process) => process.name.toLowerCase().includes('caddy') && process.status === 'online')
  if (caddy !== undefined) {
    return { url: `http://${context.account.host}`.replace(/\/+$/, ''), source: 'detected' }
  }
  return { url: null, source: null }
}
