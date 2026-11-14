/**
 * Optional bridge to the shell's chat workspace service (`uiWorkspace`).
 *
 * Slot components never receive `ctx` themselves; the plugin body captures it
 * once and this module resolves the optional service lazily from it at click
 * time. Absence (older shell / no chat UI) or a throwing `startSession` is not
 * an error: the caller falls back to a copyable prompt.
 */
import type {
  ClientContext,
  Disposer,
  SidebarRightService,
  SidebarRightTabsService,
  UiWorkspaceService,
} from './context.js'

let context: ClientContext | null = null

/**
 * Remember the plugin Context so the panel can resolve `uiWorkspace` later.
 * @param ctx - browser Context.
 * @returns disposer clearing the captured Context.
 */
export function installWorkspaceBridge(ctx: ClientContext): Disposer {
  context = ctx
  return () => {
    if (context === ctx) context = null
  }
}

/** Resolve the optional service; undefined when the shell does not provide it. */
function workspace(): UiWorkspaceService | undefined {
  const service = context?.get?.<UiWorkspaceService>('uiWorkspace')
  return service !== undefined && typeof service.startSession === 'function' ? service : undefined
}

/**
 * Open a new chat with `prompt` pre-filled.
 * @param prompt - generated authoring prompt.
 * @returns true when a chat was opened, false when the service is missing/threw.
 */
export async function openAuthoringSession(prompt: string): Promise<boolean> {
  const service = workspace()
  if (service === undefined) return false
  try {
    await service.startSession(undefined, { prompt, whenDraftExists: 'keep' })
    return true
  } catch {
    return false
  }
}

/**
 * Whether the shell's official Browser tab type is available.
 *
 * Desktop profiles enable `@deepseek-ai/dsh-client-ui-sidebar-browser` (Electron
 * `<webview>`); Web profiles keep it disabled by default (iframe carrier). The
 * plugin only offers the button when the tab type is actually registered.
 * @returns true when `sidebarRightTabs.get('browser')` resolves.
 */
export function sidebarBrowserAvailable(): boolean {
  const tabs = context?.get?.<SidebarRightTabsService>('sidebarRightTabs')
  if (tabs === undefined || typeof tabs.get !== 'function') return false
  try {
    return tabs.get('browser') !== undefined
  } catch {
    return false
  }
}

/**
 * Open a URL in the shell's right-sidebar Browser tab.
 *
 * On Desktop this is the native Electron webview (real top-level navigation,
 * first-party cookies, history); on Web it is the official iframe browser.
 * @param url - HTTP(S) URL to open.
 * @returns true when a tab was requested, false when the service/tab is missing.
 */
export function openSidebarBrowser(url: string): boolean {
  if (!sidebarBrowserAvailable()) return false
  const sidebar = context?.get?.<SidebarRightService>('sidebarRight')
  if (sidebar === undefined || typeof sidebar.openTab !== 'function') return false
  try {
    sidebar.openTab('browser', { params: { url }, revealIfOpened: true })
    return true
  } catch {
    return false
  }
}
