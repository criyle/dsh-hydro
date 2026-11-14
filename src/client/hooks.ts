/**
 * Small React hooks binding the panel to the Host routes.
 *
 * Every hook guards against unmount/stale responses by aborting the in-flight
 * request and by a generation counter, so switching accounts quickly or
 * closing the panel never renders an older answer over a newer one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SiteAccountSummary, SiteAccountsResponse, HostStreamOutput } from '../shared/api.js'
import type { AccountId, AccountSummary, HydroStatus, OperationResult } from '../shared/types.js'
import { describeError, hydroApi, isAbortError } from './api.js'
import type { TranslateFn } from './locales.js'

/** Load phase of one request-bound view. */
export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'

/** Whether a thrown value is the AbortController cancellation. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Account list view returned by {@link useAccounts}. */
export interface AccountsView {
  accounts: AccountSummary[]
  activeAccountId: AccountId | null
  phase: LoadPhase
  error: string | null
  /** Re-read `GET /accounts`. */
  reload(): void
}

/**
 * Load the account list and the active account.
 * @returns accounts, active id, load phase and a reload callback.
 */
export function useAccounts(t?: TranslateFn): AccountsView {
  const [accounts, setAccounts] = useState<AccountSummary[]>([])
  const [activeAccountId, setActiveAccountId] = useState<AccountId | null>(null)
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const generation = useRef(0)

  const reload = useCallback(() => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const token = ++generation.current
    setPhase('loading')
    setError(null)
    hydroApi.listAccounts(controller.signal).then(
      (response) => {
        if (token !== generation.current) return
        setAccounts(response.accounts)
        setActiveAccountId(response.activeAccountId)
        setPhase('ready')
      },
      (cause: unknown) => {
        if (token !== generation.current || isAbort(cause)) return
        setError(describeError(cause, t))
        setPhase('error')
      },
    )
  }, [t])

  useEffect(() => {
    reload()
    return () => {
      generation.current += 1
      inflight.current?.abort()
    }
  }, [reload])

  return { accounts, activeAccountId, phase, error, reload }
}

/** Status view returned by {@link useAccountStatus}. */
export interface StatusView {
  status: HydroStatus | null
  phase: LoadPhase
  error: string | null
  /** Re-probe the selected account. */
  refresh(): void
}

/**
 * Collect one account's Hydro status. The probe runs when the selection
 * changes and on {@link StatusView.refresh}; a null id clears the view.
 * @param accountId - selected account id, or null when none is selected.
 * @returns latest status snapshot, load phase and a refresh callback.
 */
export function useAccountStatus(accountId: AccountId | null, t?: TranslateFn): StatusView {
  const [status, setStatus] = useState<HydroStatus | null>(null)
  const [phase, setPhase] = useState<LoadPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const generation = useRef(0)

  const collect = useCallback((id: AccountId) => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const token = ++generation.current
    setPhase('loading')
    setError(null)
    hydroApi.collectStatus(id, controller.signal).then(
      (next) => {
        if (token !== generation.current) return
        setStatus(next)
        setPhase('ready')
      },
      (cause: unknown) => {
        if (token !== generation.current || isAbort(cause)) return
        setError(describeError(cause, t))
        setPhase('error')
      },
    )
  }, [t])

  useEffect(() => {
    generation.current += 1
    inflight.current?.abort()
    if (accountId === null) {
      setStatus(null)
      setPhase('idle')
      setError(null)
      return () => {}
    }
    collect(accountId)
    return () => {
      generation.current += 1
      inflight.current?.abort()
    }
  }, [accountId, collect])

  const refresh = useCallback(() => {
    if (accountId !== null) collect(accountId)
  }, [accountId, collect])

  return { status, phase, error, refresh }
}

/** One transient banner message. */
export interface FlashMessage {
  tone: 'ok' | 'error'
  text: string
}

/** Mutation/action state returned by {@link useActionRunner}. */
export interface ActionRunner {
  /** Message of the last settled action, or null. */
  flash: FlashMessage | null
  /** Whether an action is running right now. */
  busy: boolean
  /**
   * Run one Host mutation and map its outcome to a banner message.
   * @param label - success text, or a function deriving it from the result.
   * @param task - action body; receives the caller lifetime signal.
   * @param onSuccess - additional refresh work after a successful action.
   * @returns true when the action settled successfully.
   */
  run<T>(
    label: string | ((result: T) => string),
    task: (signal: AbortSignal) => Promise<T>,
    onSuccess?: (result: T) => void,
  ): Promise<boolean>
  /** Clear the banner. */
  clearFlash(): void
}

/**
 * Serialize panel actions: one in flight at a time, aborted on unmount.
 * @returns the action runner state.
 */
export function useActionRunner(t?: TranslateFn): ActionRunner {
  const [flash, setFlash] = useState<FlashMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const inflight = useRef<AbortController | null>(null)

  useEffect(() => () => { inflight.current?.abort() }, [])

  const run = useCallback(async <T,>(
    label: string | ((result: T) => string),
    task: (signal: AbortSignal) => Promise<T>,
    onSuccess?: (result: T) => void,
  ): Promise<boolean> => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    setFlash(null)
    try {
      const result = await task(controller.signal)
      if (controller.signal.aborted) return false
      onSuccess?.(result)
      setFlash({ tone: 'ok', text: typeof label === 'function' ? label(result) : label })
      return true
    } catch (cause) {
      if (controller.signal.aborted || isAbort(cause)) return false
      setFlash({ tone: 'error', text: describeError(cause, t) })
      return false
    } finally {
      setBusy(false)
    }
  }, [t])

  const clearFlash = useCallback(() => { setFlash(null) }, [])

  return { flash, busy, run, clearFlash }
}

/** Site account list view returned by {@link useSiteAccounts}. */
export interface SiteAccountsView {
  accounts: SiteAccountSummary[]
  activeSiteAccountId: string | null
  phase: LoadPhase
  error: string | null
  /** Re-read `GET site/accounts`. */
  reload(): void
}

/**
 * Load the Hydro web admin account list (Site tab).
 * @returns site accounts, active site-account id, load phase and a reload callback.
 */
export function useSiteAccounts(t?: TranslateFn): SiteAccountsView {
  const [accounts, setAccounts] = useState<SiteAccountSummary[]>([])
  const [activeSiteAccountId, setActiveSiteAccountId] = useState<string | null>(null)
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const generation = useRef(0)

  const reload = useCallback(() => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const token = ++generation.current
    setPhase('loading')
    setError(null)
    hydroApi.listSiteAccounts(controller.signal).then(
      (response: SiteAccountsResponse) => {
        if (token !== generation.current) return
        setAccounts(response.accounts)
        setActiveSiteAccountId(response.activeSiteAccountId)
        setPhase('ready')
      },
      (cause: unknown) => {
        if (token !== generation.current || isAbort(cause)) return
        setError(describeError(cause, t))
        setPhase('error')
      },
    )
  }, [t])

  useEffect(() => {
    reload()
    return () => {
      generation.current += 1
      inflight.current?.abort()
    }
  }, [reload])

  return { accounts, activeSiteAccountId, phase, error, reload }
}

/** Result/state of one imperative async task (a card-local request). */
export interface AsyncTask<T> {
  /** Whether the task is running right now. */
  busy: boolean
  /** Localized error of the last run, or null. */
  error: string | null
  /** Latest successful result, or null. */
  data: T | null
  /**
   * Run the task; the previous run is aborted.
   * @param load - task body; receives the caller lifetime signal.
   * @returns the result, or null when the run failed/was aborted.
   */
  run(load: (signal: AbortSignal) => Promise<T>): Promise<T | null>
  /** Abort and clear error/data. */
  reset(): void
}

/**
 * Run one card-local request with loading/error/data state and abort-on-unmount.
 * @returns the task state.
 */
export function useAsyncTask<T>(t?: TranslateFn): AsyncTask<T> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<T | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      inflight.current?.abort()
    }
  }, [])

  const run = useCallback(async (load: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const token = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const result = await load(controller.signal)
      if (!mounted.current || token !== generation.current) return null
      setData(result)
      return result
    } catch (cause) {
      if (!mounted.current || token !== generation.current || controller.signal.aborted || isAbort(cause)) return null
      setError(describeError(cause, t))
      return null
    } finally {
      if (mounted.current && token === generation.current) setBusy(false)
    }
  }, [t])

  const reset = useCallback(() => {
    inflight.current?.abort()
    generation.current += 1
    setBusy(false)
    setError(null)
    setData(null)
  }, [])

  return { busy, error, data, run, reset }
}

/**
 * Track a CSS media query without a dependency (used for the two-column →
 * one-column layout switch). Server-side rendering resolves to `false`.
 * @param query - media query, e.g. `(max-width: 760px)`.
 * @returns whether the query currently matches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = (): void => { setMatches(list.matches) }
    update()
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update)
      return () => { list.removeEventListener('change', update) }
    }
    list.addListener(update)
    return () => { list.removeListener(update) }
  }, [query])

  return matches
}

/** Lifecycle phase of one streamed terminal task. */
export type HostStreamPhase = 'idle' | 'running' | 'success' | 'failed' | 'cancelled'

/** One output chunk of a streamed operation. */
export interface HostStreamLine {
  stream: 'stdout' | 'stderr'
  text: string
}

/** Settled outcome reported by a streamed-task loader. */
export interface StreamTaskOutcome<T> {
  result: T
  /** True when the caller had to fall back to a plain JSON route. */
  usedFallback: boolean
}

/** Install/upgrade outcome (OperationResult + fallback flag). */

/** Generic streamed-task state. */
export interface StreamTaskView<T> {
  phase: HostStreamPhase
  lines: HostStreamLine[]
  result: T | null
  error: string | null
  elapsedMs: number
  usedFallback: boolean
  running: boolean
  start(load: (signal: AbortSignal, onOutput: (chunk: HostStreamOutput) => void) => Promise<StreamTaskOutcome<T>>): void
  cancel(): void
  reset(): void
}

/** Install/upgrade terminal state. */
export type HostStreamView = StreamTaskView<OperationResult>

/**
 * Drive one streamed terminal task: output lines, phase, elapsed time and
 * cancellation. The loader owns the transport; this hook owns UI state.
 * @param t - translator for error text.
 * @returns the stream view.
 */
export function useStreamTask<T>(t?: TranslateFn): StreamTaskView<T> {
  const [phase, setPhase] = useState<HostStreamPhase>('idle')
  const [lines, setLines] = useState<HostStreamLine[]>([])
  const [result, setResult] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [usedFallback, setUsedFallback] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<number | null>(null)
  const generation = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      abortRef.current?.abort()
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const start = useCallback((load: (signal: AbortSignal, onOutput: (chunk: HostStreamOutput) => void) => Promise<StreamTaskOutcome<T>>): void => {
    abortRef.current?.abort()
    stopTimer()
    const controller = new AbortController()
    abortRef.current = controller
    const token = ++generation.current
    const started = Date.now()
    setPhase('running')
    setLines([])
    setResult(null)
    setError(null)
    setUsedFallback(false)
    setElapsedMs(0)
    timerRef.current = window.setInterval(() => {
      if (token === generation.current) setElapsedMs(Date.now() - started)
    }, 1000)
    void load(controller.signal, (chunk) => {
      if (!mounted.current || token !== generation.current) return
      // Keep the DOM bounded on very chatty commands.
      setLines((current) => {
        const next = [...current, { stream: chunk.stream, text: chunk.text }]
        return next.length > 4000 ? next.slice(next.length - 4000) : next
      })
    }).then((outcome) => {
      if (!mounted.current || token !== generation.current) return
      setResult(outcome.result)
      setUsedFallback(outcome.usedFallback)
      setElapsedMs(Date.now() - started)
      const record = outcome.result as { ok?: unknown; message?: unknown }
      if (record.ok === true) setPhase('success')
      else {
        setPhase('failed')
        setError(typeof record.message === 'string' ? record.message : null)
      }
    }, (cause: unknown) => {
      if (!mounted.current || token !== generation.current) return
      setElapsedMs(Date.now() - started)
      if (controller.signal.aborted || isAbortError(cause)) {
        setPhase('cancelled')
        return
      }
      setPhase('failed')
      setError(describeError(cause, t))
    }).finally(() => {
      if (token === generation.current) stopTimer()
    })
  }, [stopTimer, t])

  const cancel = useCallback(() => { abortRef.current?.abort() }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    generation.current += 1
    stopTimer()
    setPhase('idle')
    setLines([])
    setResult(null)
    setError(null)
    setElapsedMs(0)
    setUsedFallback(false)
  }, [stopTimer])

  return {
    phase,
    lines,
    result,
    error,
    elapsedMs,
    usedFallback,
    running: phase === 'running',
    start,
    cancel,
    reset,
  }
}

/**
 * Install/upgrade terminal state.
 * @param t - translator for error text.
 * @returns the terminal view.
 */
export function useHostStream(t?: TranslateFn): HostStreamView {
  return useStreamTask<OperationResult>(t)
}

/**
 * Hydro CLI terminal state (run/restore streams).
 * @param t - translator for error text.
 * @returns the terminal view.
 */
export function useCliStream(t?: TranslateFn): StreamTaskView<import('./api.js').CliRunResult> {
  return useStreamTask<import('./api.js').CliRunResult>(t)
}

/** Global operator settings view returned by {@link useUiSettings}. */
export interface SettingsView {
  /** Global readonly switch (guards every write in the plugin). */
  readonlyMode: boolean
  /** ISO time the settings were last changed, or null. */
  updatedAt: string | null
  phase: LoadPhase
  error: string | null
  /** Whether a settings mutation is in flight. */
  saving: boolean
  /** Re-read `GET settings`. */
  reload(): void
  /**
   * Persist the readonly switch.
   * @param readonly - next state.
   * @returns true when the Host confirmed the new state.
   */
  setReadonly(readonly: boolean): Promise<boolean>
}

/**
 * Load and mutate the global operator settings (readonly switch).
 * @returns the settings view.
 */
export function useUiSettings(t?: TranslateFn): SettingsView {
  // The Host defaults to readonly ON; assume the safe state until GET settings
  // resolves so write buttons never flicker enabled first.
  const [readonlyMode, setReadonlyMode] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inflight = useRef<AbortController | null>(null)
  const generation = useRef(0)

  const reload = useCallback(() => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    const token = ++generation.current
    setPhase('loading')
    setError(null)
    hydroApi.getUiSettings(controller.signal).then(
      (settings) => {
        if (token !== generation.current) return
        setReadonlyMode(settings.readonlyMode)
        setUpdatedAt(settings.updatedAt)
        setPhase('ready')
      },
      (cause: unknown) => {
        if (token !== generation.current || isAbortError(cause)) return
        setError(describeError(cause, t))
        setPhase('error')
      },
    )
  }, [t])

  useEffect(() => {
    reload()
    return () => {
      generation.current += 1
      inflight.current?.abort()
    }
  }, [reload])

  const setReadonly = useCallback(async (readonly: boolean): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const settings = await hydroApi.setGlobalReadonly(readonly)
      setReadonlyMode(settings.readonlyMode)
      setUpdatedAt(settings.updatedAt)
      return settings.readonlyMode === readonly
    } catch (cause) {
      setError(describeError(cause, t))
      return false
    } finally {
      setSaving(false)
    }
  }, [t])

  return { readonlyMode, updatedAt, phase, error, saving, reload, setReadonly }
}

/** Metrics view returned by {@link useHostMetrics}. */
export interface MetricsView {
  /** Latest sample, or null before the first successful poll. */
  latest: import('../shared/api.js').HostMetricsResponse | null
  /** Recent samples (oldest → newest, at most ~30). */
  history: import('../shared/api.js').HostMetricsResponse[]
  /** Last polling error, if any. */
  error: string | null
  /** Force an immediate poll (also resets the interval). */
  refresh(): void
}

/**
 * Poll host metrics every ~5s while the overview page is visible.
 * @param hostId - active host id, or null.
 * @param enabled - false when the page/document is hidden (polling pauses).
 * @param t - translator for error text.
 * @returns the latest sample, short history and refresh callback.
 */
export function useHostMetrics(hostId: string | null, enabled: boolean, t?: TranslateFn): MetricsView {
  const [latest, setLatest] = useState<import('../shared/api.js').HostMetricsResponse | null>(null)
  const [history, setHistory] = useState<import('../shared/api.js').HostMetricsResponse[]>([])
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [documentVisible, setDocumentVisible] = useState(true)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = (): void => { setDocumentVisible(!document.hidden) }
    update()
    document.addEventListener('visibilitychange', update)
    return () => { document.removeEventListener('visibilitychange', update) }
  }, [])

  useEffect(() => {
    setLatest(null)
    setHistory([])
    setError(null)
  }, [hostId])

  useEffect(() => {
    if (hostId === null || !enabled || !documentVisible) return
    let cancelled = false
    const controller = new AbortController()
    const load = (): void => {
      hydroApi.hostMetrics(hostId, controller.signal).then(
        (sample) => {
          if (cancelled) return
          setLatest(sample)
          setError(null)
          setHistory((current) => [...current, sample].slice(-30))
        },
        (cause: unknown) => {
          if (cancelled || isAbortError(cause)) return
          setError(describeError(cause, t))
        },
      )
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [hostId, enabled, documentVisible, nonce, t])

  return { latest, history, error, refresh: () => { setNonce((current) => current + 1) } }
}

/** Embedded-page context view returned by {@link useEmbeddedContext}. */
export interface EmbeddedContextView {
  /** Latest proxy context, or null before the first successful poll. */
  context: import('../shared/api.js').EmbeddedContextResponse | null
  error: string | null
  refresh(): void
}

/**
 * Poll the embedded-browser context (`hosts/context`) every ~2s while an
 * embedded page is visible and the document is focused.
 * @param hostId - active host id, or null.
 * @param enabled - false when the page/document is not active.
 * @param t - translator for error text.
 * @returns the latest context and a refresh callback.
 */
export function useEmbeddedContext(hostId: string | null, enabled: boolean, t?: TranslateFn): EmbeddedContextView {
  const [context, setContext] = useState<import('../shared/api.js').EmbeddedContextResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const [documentVisible, setDocumentVisible] = useState(true)

  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = (): void => { setDocumentVisible(!document.hidden) }
    update()
    document.addEventListener('visibilitychange', update)
    return () => { document.removeEventListener('visibilitychange', update) }
  }, [])

  useEffect(() => {
    setContext(null)
    setError(null)
  }, [hostId])

  useEffect(() => {
    if (hostId === null || !enabled || !documentVisible) return
    let cancelled = false
    const controller = new AbortController()
    const load = (): void => {
      hydroApi.getEmbeddedContext(hostId, controller.signal).then(
        (next) => {
          if (cancelled) return
          setContext(next)
          setError(null)
        },
        (cause: unknown) => {
          if (cancelled || isAbortError(cause)) return
          setError(describeError(cause, t))
        },
      )
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [hostId, enabled, documentVisible, nonce, t])

  return { context, error, refresh: () => { setNonce((current) => current + 1) } }
}
