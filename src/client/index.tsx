/**
 * dsh-hydro browser half: the plugin bundle entry.
 *
 * The build (`scripts/build-client.mjs`) wraps this module in the lazy-CJS
 * factory the DSH client module system expects:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-hydro", factory: (require) => { ... } })
 *
 * So this file is a plain CommonJS-shaped module after bundling: it may only
 * `import` shared-module-table externals (`react`, `react/jsx-runtime`) and its
 * own sources; everything else must be inlined.
 *
 * `apply(ctx)` is an ordinary Cordis plugin body. It registers the panel twice
 * in a resilient order:
 *
 * 1. primary surface — the always-available layout panel: the keyed `main`
 *    slot (`key: "hydro"`) plus the left-sidebar `sidebar.panellist` entry with
 *    the same id, so the icon selects that panel.
 * 2. fallback surface — when either primary slot never materializes (an older
 *    or different shell), the same panel is contributed as a
 *    `settings.section` card instead, so the feature stays reachable. The
 *    fallback is removed again if the primary slots appear later.
 *
 * Slot declarations belong to shell packages (`ui-layout`, `ui-sidebar`,
 * `ui-settings`); `ctx.slots.inject` is the documented way for an external
 * plugin to wait for them, and every registration is wrapped in try/catch by
 * `contribute` so a missing slot degrades instead of failing the plugin.
 */
import type { ClientContext, SlotContribution } from './context.js'
import { contribute } from './context.js'
import { HydroIcon } from './HydroIcon.js'
import { HydroPanel } from './HydroPanel.js'
import { disposeClientI18n, installClientI18n, t } from './i18n.js'
import { installClientTheme } from './theme.js'
import { installWorkspaceBridge } from './workspace.js'

/** Bundle id; must equal the package name and the Host Loader row name. */
const PLUGIN_ID = 'dsh-hydro'
/** Main-panel key; the sidebar list id and the settings fallback share it. */
const PANEL_ID = 'hydro'

/** Cordis plugin name for diagnostics. */
export const name = PLUGIN_ID

/**
 * Cordis services this plugin waits for before `apply` runs. `slots` is the
 * renderer-owned slot registry; nothing else is required.
 */
export const inject = ['slots']

/**
 * Register the panel surfaces.
 * @param ctx - browser root Context.
 */
export function apply(ctx: ClientContext): void {
  // Locale + theme are shell services: register the plugin dictionaries and
  // wire change notifications before any surface reads a label or color.
  const i18n = installClientI18n(ctx)
  const disposeTheme = installClientTheme(ctx)
  // Optional chat service: resolved lazily by the AI authoring card so a shell
  // without `uiWorkspace` degrades to a copyable prompt instead of failing.
  const disposeWorkspace = installWorkspaceBridge(ctx)
  ctx.effect(() => () => {
    disposeWorkspace()
    disposeTheme()
    i18n.dispose()
    disposeClientI18n()
  }, 'dsh-hydro: locale + theme + workspace bindings')

  ctx.effect(() => {
    let disposed = false
    let fallback: SlotContribution | undefined
    let main: SlotContribution | undefined
    let sidebar: SlotContribution | undefined

    /**
     * Keep exactly one reachable surface: drop the settings card once both
     * primary slots are live, otherwise make sure the card exists.
     */
    const reconcile = (): void => {
      if (disposed) return
      if (main?.live() === true && sidebar?.live() === true) {
        fallback?.dispose()
        fallback = undefined
        return
      }
      if (fallback !== undefined) return
      fallback = contribute(ctx, 'settings.section', {
        name: 'settings.section',
        id: PANEL_ID,
        order: 60,
        label: () => t('panel.title'),
      }, HydroPanel)
    }

    main = contribute(ctx, 'main', { name: 'main', key: PANEL_ID }, HydroPanel, reconcile)
    sidebar = contribute(ctx, 'sidebar.panellist', {
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 50,
      label: () => t('panel.title'),
    }, HydroIcon, reconcile)
    reconcile()

    return () => {
      disposed = true
      fallback?.dispose()
      main?.dispose()
      sidebar?.dispose()
    }
  }, 'dsh-hydro: main panel + sidebar entry (settings fallback)')
}
