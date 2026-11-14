/**
 * Small presentational primitives shared by the host and site consoles.
 *
 * Everything here is local UI only (no data fetching): a card shell, labeled
 * fields, severity-colored warning lists, pretty-JSON blocks, a collapsible
 * details section and a copy button. Copy is localized; colors are tokens.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useI18n } from './i18n.js'
import {
  badge,
  button,
  card,
  cardHeader,
  cardTitle,
  colors,
  details,
  detailsBody,
  errorText,
  field,
  fieldLabel,
  fieldValue,
  hintText,
  pre,
  summary,
  warningText,
} from './styles.js'

/** Pretty-print one JSON value; safe for values that fail to serialize. */
export function prettyJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** Props of {@link Card}. */
export interface CardProps {
  /** Optional card heading. */
  title?: string
  /** Right-aligned actions of the heading row. */
  actions?: ReactNode
  /** One-line hint under the heading. */
  hint?: string
  /** Force an accent border for a stateful card. */
  tone?: 'default' | 'ok' | 'error' | 'accent'
  children?: ReactNode
}

/**
 * A bordered card with an optional heading row, hint and action slot.
 * @param props - heading/actions/hint and body.
 * @returns the card element.
 */
export function Card({ title, actions, hint, tone = 'default', children }: CardProps) {
  const borderColor =
    tone === 'ok' ? colors.success : tone === 'error' ? colors.danger : tone === 'accent' ? colors.accent : undefined
  const style: CSSProperties = borderColor === undefined
    ? { ...card, display: 'flex', flexDirection: 'column', gap: 8 }
    : { ...card, display: 'flex', flexDirection: 'column', gap: 8, borderColor }
  return (
    <section style={style}>
      {title === undefined && actions === undefined ? null : (
        <div style={cardHeader}>
          {title === undefined ? <span /> : <h3 style={cardTitle}>{title}</h3>}
          {actions ?? null}
        </div>
      )}
      {hint === undefined ? null : <p style={hintText}>{hint}</p>}
      {children}
    </section>
  )
}

/**
 * One labeled value cell.
 * @param props - label and value (null renders an em dash).
 * @returns the field element.
 */
export function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={field}>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

/**
 * Scrollable pretty-printed JSON block.
 * @param props - any JSON-serializable value.
 * @returns the `<pre>` element.
 */
export function JsonBlock({ value }: { value: unknown }) {
  return <pre style={pre}>{prettyJson(value)}</pre>
}

/**
 * Transient action feedback banner.
 * @param props - the flash message or null.
 * @returns the banner element or null.
 */
export function Flash({ flash }: { flash: { tone: 'ok' | 'error'; text: string } | null }) {
  if (flash === null) return null
  return (
    <div style={{
      ...card,
      borderColor: flash.tone === 'ok' ? colors.success : colors.danger,
      color: flash.tone === 'ok' ? colors.success : colors.danger,
    }}>
      {flash.text}
    </div>
  )
}

/**
 * Copy-to-clipboard button with transient feedback and a graceful failure note.
 * @param props - text to copy and an optional custom label.
 * @returns the button (plus failure text) element.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])

  const copy = (): void => {
    const finish = (next: 'copied' | 'failed'): void => {
      setState(next)
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { setState('idle') }, 2000)
    }
    try {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) {
        finish('failed')
        return
      }
      void clipboard.writeText(text).then(() => { finish('copied') }, () => { finish('failed') })
    } catch {
      finish('failed')
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" style={button} onClick={copy}>
        {state === 'copied' ? t('common.copied') : label ?? t('common.copy')}
      </button>
      {state === 'failed' ? <span style={warningText}>{t('common.copyFailed')}</span> : null}
    </span>
  )
}

/**
 * Native collapsible section styled with theme tokens.
 * @param props - summary label, body and optional default-open state.
 * @returns the `<details>` element.
 */
export function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details style={details}>
      <summary style={summary}>{label}</summary>
      <div style={detailsBody}>{children}</div>
    </details>
  )
}

/** Small neutral status badge. */
export function Badge({ children }: { children: ReactNode }) {
  return <span style={badge}>{children}</span>
}





/** Monospace output/log block shared by operation results and diagnostics. */
export function LogBlock({ text, maxHeight = 240 }: { text: string | undefined; maxHeight?: number }) {
  if (text === undefined || text === '') return null
  return (
    <pre style={{ ...pre, margin: 0, maxHeight, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{text}</pre>
  )
}


/** Host-aligned modal: mask, panel surface, focus trap, Escape and focus restore. */
export function Dialog({ open, title, description, children, footer, onClose, width = 400 }: {
  open: boolean
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  onClose(): void
  width?: number
}) {
  const { t } = useI18n()
  const panel = useRef<HTMLDivElement | null>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = panel.current
    const focusables = (): HTMLElement[] => node === null
      ? []
      : Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    const target = node?.querySelector<HTMLElement>('[data-modal-autofocus]') ?? focusables()[0]
    target?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]!
      const last = list[list.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      restoreTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-mask-1)', backdropFilter: 'var(--dsw-mask-blur)' }} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'relative',
          zIndex: 1,
          width: `min(${String(width)}px, 100%)`,
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 'var(--dsw-radius-panel, 14px)',
          background: 'var(--dsw-alias-bg-layer-2)',
          boxShadow: 'var(--dsw-elevation-prominent)',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, padding: '22px 24px 12px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500 }}>{title}</h2>
            {description === undefined ? null : <p style={{ margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }}>{description}</p>}
          </div>
          <button type="button" style={{ ...button, padding: '2px 8px', minWidth: 28 }} aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        {children === undefined ? null : <div style={{ padding: '0 24px', overflow: 'auto', minHeight: 0 }}>{children}</div>}
        {footer === undefined ? null : <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '20px 24px 24px' }}>{footer}</div>}
      </div>
    </div>
  )
}
/** Inline error paragraph. */
export function ErrorLine({ text }: { text: string | null }) {
  return text === null ? null : <p style={errorText}>{text}</p>
}

/** Props of {@link PageHeading}. */
export interface PageHeadingProps {
  /** Page title (already localized). */
  title: string
  /** One-line hint under the title. */
  hint?: string
  /** Right-aligned page actions. */
  actions?: ReactNode
  /** Small metadata badges shown next to the title (e.g. embedded context). */
  meta?: ReactNode
}

/**
 * Standard page heading row (title + hint + actions).
 * @param props - title/hint/actions.
 * @returns the heading element.
 */
export function PageHeading({ title, hint, actions, meta }: PageHeadingProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
          {meta ?? null}
        </div>
        {hint === undefined ? null : <p style={{ margin: 0, color: colors.muted, fontSize: 12 }}>{hint}</p>}
      </div>
      {actions === undefined ? null : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  )
}

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  /** Localized explanation. */
  message: string
  /** Optional call-to-action label. */
  actionLabel?: string
  /** Optional CTA callback. */
  onAction?: () => void
}

/**
 * Empty/no-selection placeholder with an optional navigation CTA.
 * @param props - message and optional CTA.
 * @returns the placeholder element.
 */
export function EmptyState({ message, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, color: colors.muted }}>{message}</p>
      {actionLabel === undefined || onAction === undefined
        ? null
        : <div><button type="button" style={button} onClick={onAction}>{actionLabel}</button></div>}
    </div>
  )
}
