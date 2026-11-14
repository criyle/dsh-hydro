/**
 * Inline style objects for the panel.
 *
 * Every color comes from the DSH design-system tokens (`--dsw-alias-*`), which
 * the shell swaps for the light or dark palette (and any third-party theme) on
 * `body`. Hard-coded hues are deliberately absent so dark mode and themes need
 * no plugin-side branching. The fallbacks only matter on a non-DSH host; they
 * are the light-theme values.
 */
import type { CSSProperties } from 'react'

/** Semantic color tokens resolved by the shell theme. */
export const colors = {
  text: 'var(--dsw-alias-label-primary, #1f2328)',
  muted: 'var(--dsw-alias-label-secondary, #59636e)',
  dim: 'var(--dsw-alias-label-tertiary, #818b98)',
  border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.45))',
  surface: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
  surfaceRaised: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
  overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
  accent: 'var(--dsw-alias-brand-primary, #0969da)',
  accentText: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
  danger: 'var(--dsw-alias-state-error-primary, #cf222e)',
  success: 'var(--dsw-alias-state-success-primary, #1a7f37)',
  warning: 'var(--dsw-alias-state-warn-primary, #9a6700)',
  info: 'var(--dsw-alias-state-business-primary, #0969da)',
} as const

/** Monospace stack used for keys, JSON and the operation terminal. */
export const monospaceFont = 'var(--dsw-font-family-code, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace))'

const { text, muted, border, borderStrong, surface, accent, danger, success, warning } = colors

export const panel: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '20px 24px',
  height: '100%',
  overflow: 'auto',
  boxSizing: 'border-box',
  color: text,
  fontSize: 13,
  lineHeight: 1.5,
}

export const header: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

export const title: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 600,
  color: text,
}

export const subtitle: CSSProperties = {
  margin: '2px 0 0',
  color: muted,
  fontSize: 12,
}


export const button: CSSProperties = {
  border: `1px solid ${borderStrong}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  padding: '3px 10px',
  background: surface,
  color: text,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
}

export const primaryButton: CSSProperties = {
  ...button,
  borderColor: accent,
  color: accent,
  fontWeight: 600,
  background: 'transparent',
}

export const dangerButton: CSSProperties = {
  ...button,
  borderColor: danger,
  color: danger,
  background: 'transparent',
}

export const section: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

export const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: muted,
}

export const card: CSSProperties = {
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  padding: '10px 12px',
  background: surface,
}

export const list: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

export const accountRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 12px',
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  background: 'transparent',
  cursor: 'pointer',
}

export const accountRowActive: CSSProperties = {
  ...accountRow,
  borderColor: accent,
  background: surface,
}





export const badge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 999,
  padding: '0 8px',
  fontSize: 11,
  lineHeight: '18px',
  border: `1px solid ${borderStrong}`,
  color: muted,
  background: 'transparent',
  whiteSpace: 'nowrap',
}

export const activeBadge: CSSProperties = {
  ...badge,
  borderColor: accent,
  color: accent,
}


export const okBadge: CSSProperties = {
  ...badge,
  borderColor: success,
  color: success,
}

export const errorBadge: CSSProperties = {
  ...badge,
  borderColor: danger,
  color: danger,
}

export const mutedText: CSSProperties = {
  color: muted,
}

export const hintText: CSSProperties = {
  margin: 0,
  color: muted,
  fontSize: 11,
}

export const errorText: CSSProperties = {
  color: danger,
  whiteSpace: 'pre-wrap',
}

export const okText: CSSProperties = {
  color: success,
}

export const warningText: CSSProperties = {
  color: warning,
}


export const flashError: CSSProperties = {
  ...card,
  borderColor: danger,
  color: danger,
}

export const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: '6px 16px',
}

export const field: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

export const fieldLabel: CSSProperties = {
  color: muted,
  fontSize: 11,
}

export const fieldValue: CSSProperties = {
  overflowWrap: 'anywhere',
  color: text,
}

export const form: CSSProperties = {
  ...card,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

export const formGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 10,
}

export const input: CSSProperties = {
  border: `1px solid ${borderStrong}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  padding: '4px 8px',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  color: text,
  font: 'inherit',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
}

export const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  color: text,
}

/* ------------------------------------------------------------------ */
/* Console shell: tabs, two-column workflow layouts, collapsibles      */
/* ------------------------------------------------------------------ */


export const tab: CSSProperties = {
  border: 'none',
  borderBottom: '2px solid transparent',
  borderRadius: 0,
  padding: '6px 14px',
  background: 'transparent',
  color: muted,
  font: 'inherit',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
}


/** Responsive two-column workflow grid; callers set `gridTemplateColumns`. */

export const details: CSSProperties = {
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  background: 'transparent',
  overflow: 'hidden',
}

export const summary: CSSProperties = {
  cursor: 'pointer',
  padding: '7px 12px',
  color: muted,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.02em',
}

export const detailsBody: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '0 12px 12px',
}

export const cardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 8,
}

export const cardTitle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: text,
}

export const inlineRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
}

export const stack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}



export const linkButton: CSSProperties = {
  border: 'none',
  padding: 0,
  background: 'transparent',
  color: accent,
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
  wordBreak: 'break-word',
}

export const pre: CSSProperties = {
  margin: 0,
  padding: 8,
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
  color: text,
  fontFamily: monospaceFont,
  fontSize: 11,
  lineHeight: 1.45,
  maxHeight: 300,
  overflow: 'auto',
  whiteSpace: 'pre',
  boxSizing: 'border-box',
}

/** Scrollable live terminal body for streamed install/upgrade output. */
export const terminal: CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
  color: text,
  fontFamily: monospaceFont,
  fontSize: 11,
  lineHeight: 1.5,
  height: 260,
  maxHeight: 420,
  minHeight: 120,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  boxSizing: 'border-box',
}

/** Badge for an in-flight streamed operation. */
export const runningBadge: CSSProperties = {
  ...badge,
  borderColor: accent,
  color: accent,
}

export const compactInput: CSSProperties = {
  ...input,
  maxWidth: 220,
}

export const textarea: CSSProperties = {
  ...input,
  minHeight: 64,
  resize: 'vertical',
  fontFamily: monospaceFont,
}



export const time: CSSProperties = {
  color: muted,
  fontSize: 11,
}

export { accent, danger, success, warning }

/* ------------------------------------------------------------------ */
/* Console shell v2: top switches + hierarchical menu + data tables    */
/* ------------------------------------------------------------------ */

/** Root column of the whole console page. */
export const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  minHeight: '100%',
}

/** Header row: identity left, host/site/readonly controls right. */
export const topBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}

/** Right-hand control cluster in the header. */
export const headerControls: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 8,
}

/** Label + select stacked in the header. */
export const selectField: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  fontSize: 11,
  color: muted,
}

/** Compact select used by the header switches and filter bars. */
export const select: CSSProperties = {
  ...input,
  width: 'auto',
  minWidth: 150,
}

/** Two-pane workspace: menu + page (desktop). */
export const workspace: CSSProperties = {
  display: 'grid',
  gap: 18,
  alignItems: 'start',
}

/** Left menu column. */
export const menu: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
}

/** One menu section. */
export const menuSection: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  marginTop: 5,
}

/** One menu entry. */
export const menuItem: CSSProperties = {
  border: 'none',
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  padding: '5px 9px',
  background: 'transparent',
  color: text,
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.4,
  textAlign: 'left',
  cursor: 'pointer',
}

/** Group heading above one component menu section. */
export const menuSectionTitle: CSSProperties = {
  margin: '7px 0 3px 8px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: colors.muted,
}

/** Selected menu entry. */
export const menuItemActive: CSSProperties = {
  ...menuItem,
  background: surface,
  color: accent,
  fontWeight: 600,
}

/** Page root column. */
export const page: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
}


/** Page one-line hint. */
export const pageHint: CSSProperties = {
  margin: 0,
  color: muted,
  fontSize: 12,
}

/** Full-width data table. */
export const table: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
}

/** Table header cell. */
export const tableHeadCell: CSSProperties = {
  padding: '4px 8px',
  borderBottom: `1px solid ${borderStrong}`,
  color: muted,
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'left',
  whiteSpace: 'nowrap',
}

/** Table body cell. */
export const tableCell: CSSProperties = {
  padding: '5px 8px',
  borderBottom: `1px solid ${border}`,
  verticalAlign: 'top',
}

/** Table row that opens/acts on click. */
export const clickableRow: CSSProperties = {
  cursor: 'pointer',
}

/** Small colored status dot. */
export const statusDot: CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  marginRight: 6,
  background: muted,
  verticalAlign: 'middle',
}

/** Grid of small metric cards. */
export const metricGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 8,
}

/** Horizontally wrapping filter/action bar. */
export const filterBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: 8,
}

/** Localized warning row. */
export const warningItem: CSSProperties = {
  borderLeft: '3px solid',
  padding: '6px 9px',
  background: surface,
  borderRadius: '0 var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

/** Muted inline detail line (e.g. raw probe error inside "details"). */
export const detailText: CSSProperties = {
  color: muted,
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: monospaceFont,
}

/** `details`-based inline disclosure (warning details, oplog args). */
export const inlineDetails: CSSProperties = {
  display: 'inline-block',
}


/** Small "metric" label in process cards. */
export const metricLabel: CSSProperties = {
  color: muted,
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

/** Small "metric" value in process cards. */
export const metricValue: CSSProperties = {
  color: text,
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
}


/** Traditional readonly switch track (knob slides right when readonly is on). */
export const switchTrack: CSSProperties = {
  position: 'relative',
  width: 34,
  height: 20,
  borderRadius: 999,
  border: `1px solid ${borderStrong}`,
  background: surface,
  padding: 0,
  cursor: 'pointer',
  flex: '0 0 auto',
}

/** Knob inside the readonly switch. */
export const switchKnob: CSSProperties = {
  position: 'absolute',
  top: 2,
  width: 14,
  height: 14,
  borderRadius: '50%',
  background: muted,
  transition: 'left 120ms ease',
}


/** Embedded Hydro page iframe. */
export const frame: CSSProperties = {
  width: '100%',
  minHeight: 620,
  border: `1px solid ${border}`,
  borderRadius: 'var(--dsw-radius-lg, 8px)',
  background: 'var(--dsw-alias-bg-overlay, transparent)',
  colorScheme: 'normal',
}
