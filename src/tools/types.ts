/**
 * Shared types for the model-facing tool registrars.
 *
 * Each tool module exports a `register*Tools(deps)` function that registers its
 * tools on `deps.ctx.tools` and returns nothing: cordis tracks the
 * registrations as effects of the plugin fiber, so no manual disposer is needed.
 */
import type { Context } from '@deepseek-ai/cordis'

import type { Config } from '../config.js'
import type { HydroOpsApi } from '../ops/hydro-ops.js'

/** Dependencies every tool registrar receives. */
export interface ToolDeps {
  ctx: Context
  config: Config
  ops: HydroOpsApi
}
