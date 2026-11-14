/**
 * Theme integration for the browser half.
 *
 * DSH publishes the resolved light/dark palette as `--dsw-alias-*` CSS custom
 * properties on `body`; the panel reads those tokens instead of hard-coded
 * colors, so dark mode is a pure token swap. We only subscribe to the theme
 * snapshot for the few places that need the *mode* itself (native form
 * controls: `color-scheme`).
 */
import { useSyncExternalStore } from 'react'
import type { ClientContext, Disposer } from './context.js'

/** Structural view of the DSH theme service used by this plugin. */
export interface ThemeService {
  getTheme(): { active: { colorScheme: 'light' | 'dark' | string } }
}

let themeService: ThemeService | null = null
let currentMode: 'light' | 'dark' = 'light'

const listeners = new Set<() => void>()
let unsubscribe: Disposer | undefined

function emit(): void {
  for (const listener of listeners) listener()
}

function resolveMode(service: ThemeService | null): 'light' | 'dark' {
  if (service === null) return 'light'
  try {
    return service.getTheme().active.colorScheme === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Bind the theme service (if present) and subscribe to palette changes.
 * @param ctx - browser Context.
 * @returns disposer restoring the previous state.
 */
export function installClientTheme(ctx: ClientContext): Disposer {
  themeService = (ctx.get?.('theme') as ThemeService | undefined) ?? null
  currentMode = resolveMode(themeService)
  if (ctx.on !== undefined) {
    unsubscribe = ctx.on('theme/change', () => {
      const next = resolveMode(themeService)
      if (next === currentMode) return
      currentMode = next
      emit()
    })
  }
  return () => {
    unsubscribe?.()
    unsubscribe = undefined
    themeService = null
    listeners.clear()
  }
}

/** Current resolved color scheme. */
export function currentThemeMode(): 'light' | 'dark' {
  return currentMode
}

/**
 * React hook: the resolved `light`/`dark` mode, re-rendering on switches.
 * @returns the current mode.
 */
export function useThemeMode(): 'light' | 'dark' {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => currentMode,
    () => currentMode,
  )
}

/** Re-resolve the mode (used by tests after faking a theme change). */
