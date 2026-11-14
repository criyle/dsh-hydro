/**
 * Tool registry aggregation for the plugin entry point.
 */
import { registerAccountTools } from './accounts.js'
import { registerAdminTools } from './admin.js'
import { registerContestTools } from './contest.js'
import { registerSiteAccountTools } from './site-accounts.js'
import { registerDiscussionTools } from './discussion.js'
import { registerOpsTools } from './ops.js'
import { registerProblemTools } from './problem.js'
import type { ToolDeps } from './types.js'

/** Register every model-facing tool. */
export function registerAllTools(deps: ToolDeps): void {
  registerAccountTools(deps)
  registerSiteAccountTools(deps)
  registerOpsTools(deps)
  registerAdminTools(deps)
  registerProblemTools(deps)
  registerContestTools(deps)
  registerDiscussionTools(deps)
}

export type { ToolDeps }
