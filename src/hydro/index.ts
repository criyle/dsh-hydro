/**
 * Public surface of the Hydro remote-operation modules.
 *
 * Other plugin modules (`src/ops`, `src/tools`, `src/routes`) import from this
 * barrel only; the individual modules stay implementation details.
 */

/* ops/types.ts (domain types used across the Hydro modules) ---------- */
export type {
  AccountContext,
  HydroProbe,
  MongoQuerySpec,
  OplogEntry,
  OplogQuerySpec,
  OplogResult,
  ServiceActionResult,
  StatusOptions,
} from '../ops/types.js'

/* remote.ts --------------------------------------------------------- */
export {
  parsePm2Jlist,
  parseHydroConfig,
  parseMongoUri,
  buildTunnelUri,
  parseYarnGlobalDir,
  detectRole,
} from './remote.js'
export type { ParsedMongoUri } from './remote.js'

/* detect.ts --------------------------------------------------------- */
export { probeHydro, locateHydro, isHydroInstalled } from './detect.js'

/* install.ts -------------------------------------------------------- */
export { installHydro, buildInstallCommand } from './install.js'
export type { InstallOptions } from './install.js'

/* status.ts --------------------------------------------------------- */
export { collectHydroStatus, quickStatus } from './status.js'

/* upgrade.ts -------------------------------------------------------- */
export { planUpgrade, upgradeHydro } from './upgrade.js'
export type { UpgradeOptions, UpgradePlan } from './upgrade.js'

/* ws.ts ------------------------------------------------------------- */
export { parseCheckMessage, collectWsWarnings } from './ws.js'

/* db.ts ------------------------------------------------------------- */
export { inspectMongo, listCollections, queryDatabase } from './db.js'

/* oplog.ts ---------------------------------------------------------- */
export { queryOplog } from './oplog.js'

/* service.ts -------------------------------------------------------- */
export { serviceAction } from './service.js'

/* registry.ts ------------------------------------------------------- */
export { fetchLatestVersions, registryUrl } from './registry.js'

/* versions.ts ------------------------------------------------------- */
export * from './versions.js'
