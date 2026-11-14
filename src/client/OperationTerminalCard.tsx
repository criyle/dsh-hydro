/**
 * Shared card for a streamed install/upgrade operation.
 *
 * Renders the start/confirm flow, the live terminal (monospace, scrolls to the
 * bottom unless the operator scrolled up), status/elapsed badges, copy and
 * cancel controls, the fallback note when streaming was unavailable, and the
 * "ask AI to troubleshoot" launcher once the operation settles.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { OperationResult } from '../shared/types.js'
import { StreamUnavailableError, isAbortError } from './api.js'
import { containsCjk } from './format.js'
import { HostDiagnoseButton } from './HostDiagnoseButton.js'
import { useConsole } from './console-context.js'
import { useI18n } from './i18n.js'
import type { HostStreamView } from './hooks.js'
import {
  badge,
  colors,
  dangerButton,
  detailText,
  details,
  errorBadge,
  inlineRow,
  mutedText,
  okBadge,
  primaryButton,
  runningBadge,
  stack,
  terminal,
  time,
  warningText,
} from './styles.js'
import { Card, CopyButton, ErrorLine } from './ui.js'

/**
 * Wrap a streamed attempt with the stream-unavailable fallback policy.
 * @param streamRun - streaming attempt.
 * @param fallbackRun - plain JSON fallback, only used when streaming is unavailable.
 * @param signal - caller lifetime (abort must propagate, not fall back).
 * @returns the operation result plus whether the fallback was used.
 */
export async function withStreamFallback(
  streamRun: () => Promise<OperationResult>,
  fallbackRun: () => Promise<OperationResult>,
  signal: AbortSignal,
): Promise<{ result: OperationResult; usedFallback: boolean }> {
  try {
    return { result: await streamRun(), usedFallback: false }
  } catch (cause) {
    if (signal.aborted || isAbortError(cause) || !(cause instanceof StreamUnavailableError)) throw cause
    return { result: await fallbackRun(), usedFallback: true }
  }
}

/** Render the live terminal body (stderr tinted), auto-scrolling when stuck. */
function TerminalBody({ task }: { task: HostStreamView }) {
  const { t } = useI18n()
  const node = useRef<HTMLPreElement | null>(null)
  const stuck = useRef(true)

  useEffect(() => {
    if (task.phase === 'running') stuck.current = true
  }, [task.phase])

  useEffect(() => {
    const element = node.current
    if (element !== null && stuck.current) element.scrollTop = element.scrollHeight
  }, [task.lines])

  return (
    <pre
      ref={node}
      style={terminal}
      onScroll={(event) => {
        const element = event.currentTarget
        stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}
    >
      {task.lines.length === 0 ? <span style={mutedText}>{t('terminal.waiting')}</span> : null}
      {task.lines.map((line, index) => (
        <span
          // Output chunks are append-only, so their position is a stable key.
          key={String(index)}
          style={line.stream === 'stderr' ? { color: colors.warning } : undefined}
        >
          {line.text}
        </span>
      ))}
    </pre>
  )
}

/** Props of {@link OperationTerminalCard}. */
export interface OperationTerminalCardProps {
  /** Card title (install/upgrade). */
  title: string
  /** One-line explanation under the title. */
  hint: string
  /** Start button label. */
  startLabel: string
  /** Locale string shown in the confirm dialog before starting. */
  confirmMessage: string
  /** Disable starting (readonly account). */
  disabled: boolean
  /** Stream state owned by the parent. */
  task: HostStreamView
  /** SSH host record id (diagnose). */
  hostId: string
  /** Operation kind (diagnose). */
  kind: 'install' | 'upgrade'
  /** Start the streamed operation; the parent supplies the fallback policy. */
  onStart(): void
  /** Called once per successful run (refresh status/accounts). */
  onSuccess(): void
  /** Extra controls rendered above the terminal (e.g. upgrade dry-run plan). */
  children?: ReactNode
  /** Advanced options collapsible (judge/noCaddy/includeJudge). */
  advanced?: ReactNode
}

/**
 * Render the terminal card.
 * @param props - labels, stream state and callbacks.
 * @returns the card element.
 */
export function OperationTerminalCard({
  title,
  hint,
  startLabel,
  confirmMessage,
  disabled,
  task,
  hostId,
  kind,
  onStart,
  onSuccess,
  children,
  advanced,
}: OperationTerminalCardProps) {
  const { t } = useI18n()
  const { requestWrites, requestConfirm } = useConsole()
  const refreshed = useRef(false)
  const running = task.phase === 'running'
  const output = task.lines.map((line) => line.text).join('')
  const seconds = Math.round(task.elapsedMs / 1000)

  useEffect(() => {
    if (running) {
      refreshed.current = false
      return
    }
    if (task.phase === 'success' && task.result?.ok === true && !refreshed.current) {
      refreshed.current = true
      onSuccess()
    }
  }, [task.phase, task.result])

  const start = (): void => {
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: confirmMessage }))) return
      onStart()
    })()
  }

  return (
    <Card
      title={title}
      hint={hint}
      tone={running ? 'accent' : task.phase === 'success' ? 'ok' : task.phase === 'failed' ? 'error' : 'default'}
    >
      {children}
      {advanced === undefined ? null : (
        <div style={{ ...stack, pointerEvents: running ? 'none' : undefined, opacity: running ? 0.6 : 1 }}>{advanced}</div>
      )}

      {task.phase === 'idle' ? null : (
        <div style={stack}>
          <div style={inlineRow}>
            {running ? <span style={runningBadge}>{t('terminal.running')}</span> : null}
            {task.phase === 'success' ? <span style={okBadge}>{t('terminal.success')}</span> : null}
            {task.phase === 'failed' ? <span style={errorBadge}>{t('terminal.failed')}</span> : null}
            {task.phase === 'cancelled' ? <span style={badge}>{t('terminal.cancelled')}</span> : null}
            <span style={time}>{t('terminal.elapsed', { seconds })}</span>
            {output === '' ? null : <CopyButton text={output} />}
            {running ? (
              <button type="button" style={dangerButton} onClick={task.cancel}>{t('terminal.cancel')}</button>
            ) : null}
          </div>
          <TerminalBody task={task} />
          {running || task.phase === 'cancelled'
            ? <p style={{ ...mutedText, margin: 0 }}>{t('terminal.cancelHint')}</p>
            : null}
        </div>
      )}

      {task.usedFallback ? <p style={{ ...warningText, margin: 0 }}>{t('terminal.fallback')}</p> : null}
      {task.result === null ? (
        <ErrorLine text={task.error} />
      ) : containsCjk(task.result.message) ? (
        <div>
          <p style={{ margin: 0, color: task.result.ok ? undefined : colors.danger }}>
            {task.result.ok ? t('terminal.success') : t('terminal.failed')}
          </p>
          <details style={details}>
            <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
            <p style={detailText}>{task.result.message}</p>
          </details>
        </div>
      ) : (
        <p style={{ margin: 0, color: task.result.ok ? undefined : colors.danger }}>{task.result.message}</p>
      )}
      {task.phase === 'success' || task.phase === 'failed' || task.phase === 'cancelled' ? (
        <HostDiagnoseButton
          hostId={hostId}
          kind={kind}
          output={output}
          {...(task.result === null ? (task.error === null ? {} : { message: task.error }) : { message: task.result.message })}
        />
      ) : null}

      {running ? null : (
        <div style={inlineRow}>
          <button type="button" style={primaryButton} disabled={disabled} onClick={start}>
            {startLabel}
          </button>
        </div>
      )}
    </Card>
  )
}
