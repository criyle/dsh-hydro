/**
 * Minimal structural view of the DSH browser plugin Context this panel uses.
 *
 * The real object is a Cordis `Context` supplied by the shell (`apply(ctx)` is
 * called with it), but the browser half deliberately depends only on the
 * members listed here:
 *
 * - `effect` — Cordis effect registration; its disposer runs on plugin unload.
 * - `slots` — the renderer-owned slot registry (`ctx.slots`).
 *
 * Keeping the surface structural means the client bundle needs no DSH type
 * package beyond the shared wire contract, and cannot accidentally touch Host
 * or Session internals. The concrete contracts are documented in
 * `docs/research/client-api.md`.
 */
import type { ComponentType } from 'react'

/** Idempotent cleanup callback. */
export type Disposer = () => void

/** Options accepted by `ctx.slots.register` for the slot kinds this plugin uses. */
export interface SlotRegisterOptions {
  /** Target slot key; it must already be declared by a parent entry. */
  name: string
  /** Dispatch key for a keyed slot (`main`). */
  key?: string
  /** Entry id for a list slot (`sidebar.panellist`, `settings.section`). */
  id?: string
  /** List order, ascending. */
  order?: number
  /** List display label; a thunk is re-read when the locale changes. */
  label?: string | (() => string)
}

/** The part of the slot registry this plugin uses. */
export interface ClientSlots {
  /**
   * Contribute a component into an already-declared slot.
   * @throws when the slot is not declared; callers must catch.
   */
  register(options: SlotRegisterOptions, component: ComponentType<never>): Disposer
  /**
   * Wait for a slot declaration, then run `callback`; the contribution is
   * removed when the declaration collapses or the plugin unloads.
   */
  inject(key: string, callback: () => Disposer | Iterable<Disposer>): Disposer
}

/** The Cordis browser Context as this plugin sees it. */
export interface ClientContext {
  slots: ClientSlots
  effect(body: () => Disposer | Iterable<Disposer>, label?: string): Disposer
  /** Read an optional service (`locale`, `theme`, `uiWorkspace`, ...). */
  get?<T = unknown>(name: string): T | undefined
  /** Subscribe to a Cordis event (used for `locale/change`, `theme/change`). */
  on?(event: string, listener: (payload?: unknown) => void): Disposer
}

/** Structural view of the shell's right-sidebar service (Desktop/Web). */
export interface SidebarRightService {
  openTab(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
}

/** Right-sidebar tab-type registry (used to detect the official Browser tab). */
export interface SidebarRightTabsService {
  get?(kind: string): unknown
}

/** Options accepted by the optional chat workspace service's `startSession`. */
export interface StartSessionOptions {
  /** Prompt pre-filled into the new chat draft. */
  prompt?: string
  /** What to do when a draft already exists. */
  whenDraftExists?: 'replace' | 'append' | 'keep'
}

/**
 * Structural view of the optional `uiWorkspace` service.
 *
 * The service is not guaranteed to exist (older shells, alternative UIs), so
 * the panel only reads it through `ctx.get('uiWorkspace')` at click time and
 * degrades to a copyable prompt when it is absent or throws.
 */
export interface UiWorkspaceService {
  startSession(workspaceId?: unknown, options?: StartSessionOptions): Promise<unknown>
}

/** One slot contribution plus its liveness probe. */
export interface SlotContribution {
  /** Whether the registration actually made it into the registry. */
  live(): boolean
  /** Remove the contribution and stop waiting for the declaration. */
  dispose(): void
}

/**
 * Contribute a component into `slot` without ever letting a missing/unstable
 * slot kill the plugin: waits through `slots.inject`, catches a failing
 * `slots.register`, and reports whether the registration is live.
 * @param ctx - browser Context.
 * @param slot - target slot key.
 * @param options - registration options; `name` must equal `slot`.
 * @param component - component to render in the slot.
 * @param onInstall - called after a successful registration (sync or later).
 * @returns the contribution handle.
 */
export function contribute(
  ctx: ClientContext,
  slot: string,
  options: SlotRegisterOptions,
  component: ComponentType<never>,
  onInstall?: () => void,
): SlotContribution {
  let live = false
  let waiting: Disposer | undefined
  const install = (): Disposer => {
    try {
      const remove = ctx.slots.register(options, component)
      live = true
      onInstall?.()
      return remove
    } catch (error) {
      // Graceful degradation: a shell without this slot must not break the
      // plugin; the caller's fallback (settings.section) handles the surface.
      console.warn(`[dsh-hydro] cannot register into slot "${slot}"`, error)
      return () => {}
    }
  }
  try {
    waiting = ctx.slots.inject(slot, install)
  } catch (error) {
    // A throwing inject (for example a slot service that never declares the
    // key) is treated like a failed registration, not a plugin failure.
    console.warn(`[dsh-hydro] cannot wait for slot "${slot}"`, error)
  }
  return {
    live: () => live,
    dispose: () => { waiting?.() },
  }
}
