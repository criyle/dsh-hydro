/**
 * dsh-hydro — HydroOJ assistant for DeepSeek Harness.
 *
 * The host half:
 *  - persists SSH accounts and plugin-managed keys;
 *  - connects to remote Hydro servers and runs install/status/upgrade/Mongo/WS
 *    operations through the SSH transport;
 *  - exposes `hydro_*` tools to the model and JSON routes to the browser half;
 *  - optionally registers the ops/problem-authoring skills.
 */
import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

import { AccountStore, defaultDataDir } from './accounts/store.js'
import { Config } from './config.js'
import type { Config as HydroPluginConfig } from './config.js'
import { createSiteService } from './site/service.js'
import { CommunityService } from './community/service.js'
import { HydroOps } from './ops/hydro-ops-impl.js'
import { registerHydroRoutes } from './routes.js'
import { hydroOpsSkill, problemAuthoringSkill } from './skills/index.js'
import { registerAllTools } from './tools/index.js'
import { HYDRO_API_PREFIX } from './shared/types.js'

export const name = 'dsh-hydro'
export { Config }

/** Services the plugin cannot work without. */
export const inject = ['tools']

/** Read the package version from the installed package (works from lib/). */
export function pluginVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function apply(ctx: Context, config: HydroPluginConfig): Promise<void> {
  const dataDir = config.dataDir.trim() === '' ? defaultDataDir() : config.dataDir
  const store = new AccountStore({ dataDir })
  const knownHostsPath = config.knownHostsPath.trim() === '' ? store.knownHostsPath : config.knownHostsPath
  const ops = new HydroOps({
    ctx,
    config,
    store,
    knownHostsPath,
    logger: {
      debug: (message) => ctx.logger.debug(message),
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    },
  })
  await ops.ready()
  ctx.effect(() => () => ops.dispose(), 'dsh-hydro: dispose connection pool')

  registerAllTools({ ctx, config, ops })

  const site = createSiteService({ ops })
  const community = new CommunityService({
    ops,
    dataDir: dataDir,
    log: (message) => ctx.logger.warn(message),
  })
  ctx.effect(() => () => {
    void site.dispose()
    void community.dispose()
  }, 'dsh-hydro: close Hydro web sessions')
  void community.load().then(() => {
    if (community.getConfig().enabled) community.start()
  }).catch((error: unknown) => {
    ctx.logger.warn(`dsh-hydro: community service load failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // The browser half needs the web server; a headless profile simply skips it.
  ctx.inject(['webServer'], (webCtx) => {
    const routeCtx = webCtx as unknown as Context & {
      webServer: {
        register(route: { kind: 'exact'; path: string; handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void> }): () => void
      }
    }
    registerHydroRoutes({ ctx: routeCtx, ops, version: pluginVersion(), site, community })
    webCtx.logger.debug(`dsh-hydro: client API mounted under ${HYDRO_API_PREFIX}`)
  })

  // Skills give the model task-specific guidance on demand (no request-prefix
  // cost until it loads one).
  ctx.inject(['skills'], (skillCtx) => {
    if (!config.ui.registerSkill) return
    for (const skill of [problemAuthoringSkill, hydroOpsSkill]) {
      skillCtx.effect(
        () =>
          skillCtx.skills.register({
            name: skill.name,
            description: skill.description,
            content: skill.body,
            source: 'runtime',
            invocation: {
              modelInvocable: skill.modelInvocable,
              userInvocable: skill.userInvocable,
            },
          }),
        `dsh-hydro: skill ${skill.name}`,
      )
    }
  })
}

export { HydroOps, AccountStore }
export type { HydroOpsApi } from './ops/hydro-ops.js'
