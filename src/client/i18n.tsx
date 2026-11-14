/**
 * Locale runtime for the browser half.
 *
 * Registers the plugin's namespace with the DSH locale service (when present),
 * binds a live translator, and exposes a React hook that re-renders on locale
 * switches. Without a locale service (older shell, SSR test) everything falls
 * back to English, so the panel is never keyed by an unknown service.
 */
import { useSyncExternalStore } from 'react'
import type { ClientContext, Disposer } from './context.js'
import {
  LOCALE_NAMESPACE,
  en,
  translateEnglish,
  zh,
  type MessageKey,
  type TranslateFn,
} from './locales.js'

/** Structural view of the DSH locale service used by this plugin. */
export interface LocaleService {
  register(ns: string, locale: string, dict: Record<string, string>): Disposer
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  getLocale(): { active: string }
  subscribe?(listener: () => void): Disposer
}

/** Installed runtime shared by the slot components. */
interface ClientI18n {
  /** Live translator (reads the active locale at call time). */
  t: TranslateFn
  /** Active locale id (`zh`, `en`, …). */
  locale(): string
  /** Subscribe to locale changes. */
  subscribe(listener: () => void): Disposer
  /** Release subscriptions taken by {@link installClientI18n}. */
  dispose(): void
}

let runtime: ClientI18n | null = null

/** The active runtime, or an English fallback before installation. */
function i18n(): ClientI18n {
  if (runtime !== null) return runtime
  return {
    t: translateEnglish,
    locale: () => 'en',
    subscribe: () => () => {},
    dispose: () => {},
  }
}

/**
 * Register dictionaries and bind the live translator.
 *
 * @param ctx - browser Context (locale service looked up structurally).
 * @returns the installed runtime.
 */
export function installClientI18n(ctx: ClientContext): ClientI18n {
  const service = ctx.get?.('locale') as LocaleService | undefined
  const cleanups: Disposer[] = []
  let bound: TranslateFn = translateEnglish

  if (service !== undefined) {
    cleanups.push(service.register(LOCALE_NAMESPACE, 'zh', zh))
    cleanups.push(service.register(LOCALE_NAMESPACE, 'en', en))
    const translate = service.bind(LOCALE_NAMESPACE)
    bound = (key, params) => translate(key, params) as string
    cleanups.push(() => {})
  }

  const listeners = new Set<() => void>()
  let unsubscribeService: Disposer | undefined
  if (service?.subscribe !== undefined) {
    unsubscribeService = service.subscribe(() => {
      for (const listener of listeners) listener()
    })
  } else if (ctx.on !== undefined) {
    unsubscribeService = ctx.on('locale/change', () => {
      for (const listener of listeners) listener()
    })
  }

  const localeOf = (): string => {
    if (service === undefined) return 'en'
    try {
      return service.getLocale().active
    } catch {
      return 'en'
    }
  }

  const installed: ClientI18n = {
    t: bound,
    locale: localeOf,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      listeners.clear()
      unsubscribeService?.()
      for (const cleanup of cleanups) cleanup()
    },
  }
  runtime = installed
  return installed
}

/** Remove the active runtime (used by the plugin effect disposer). */
export function disposeClientI18n(): void {
  runtime?.dispose()
  runtime = null
}

/**
 * React hook: live translator + active locale, re-rendering on switches.
 * @returns the translator and locale id.
 */
export function useI18n(): { t: TranslateFn; locale: string } {
  const installed = i18n()
  const locale = useSyncExternalStore(
    (listener) => installed.subscribe(listener),
    () => installed.locale(),
    () => installed.locale(),
  )
  return { t: installed.t, locale }
}

/** Translate outside React (slot labels, confirmation strings). */
export function t(key: MessageKey, params?: Record<string, unknown>): string {
  return i18n().t(key, params)
}

/** Current locale id outside React. */
