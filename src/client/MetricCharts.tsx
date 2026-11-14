/**
 * Lightweight visualizations for the overview metrics page (no chart deps).
 *
 * SVG sparklines/gauge + CSS meter bars use theme tokens only. Thresholds map
 * to the semantic state colors, and metric alerts are localized by code.
 */
import type { MetricAlert } from '../shared/api.js'
import { useI18n } from './i18n.js'
import {
  card,
  colors,
  metricLabel,
  metricValue,
  mutedText,
  stack,
  statusDot,
  time,
  warningItem,
} from './styles.js'

/** Pick a semantic color for a 0–100 percentage. */
export function metricColor(percent: number | null, warn = 80, error = 90): string {
  if (percent === null) return colors.muted
  if (percent >= error) return colors.danger
  if (percent >= warn) return colors.warning
  return colors.success
}

/** A tiny inline sparkline. */
export function Sparkline({ values, color, height = 34 }: { values: number[]; color: string; height?: number }) {
  const { t } = useI18n()
  if (values.length === 0) return <span style={{ ...mutedText, fontSize: 11 }}>{t('metrics.collecting')}</span>
  const width = 140
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min === 0 ? 1 : max - min
  const step = values.length === 1 ? 0 : width / (values.length - 1)
  const points = values.map((value, index) => {
    const x = index * step
    const y = height - 2 - ((value - min) / range) * (height - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${String(width)} ${String(height)}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** A circular percentage gauge. */
export function Gauge({ percent, color, size = 84 }: { percent: number | null; color: string; size?: number }) {
  const { t } = useI18n()
  const radius = 30
  const circumference = 2 * Math.PI * radius
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const filled = (value / 100) * circumference
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" role="img" aria-label={percent === null ? t('metrics.unavailable') : `${String(Math.round(value))}%`}>
      <circle cx="36" cy="36" r={radius} fill="none" stroke={colors.border} strokeWidth="6" />
      <circle
        cx="36"
        cy="36"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 36 36)"
      />
      <text x="36" y="40" textAnchor="middle" fontSize="13" fill={colors.text}>
        {percent === null ? '—' : `${String(Math.round(value))}%`}
      </text>
    </svg>
  )
}

/** One metric card with a label, main value and optional chart children. */
export function MetricCard({
  label,
  value,
  tone,
  children,
}: {
  label: string
  value: string
  tone?: string
  children?: import('react').ReactNode
}) {
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6, borderColor: tone }}>
      <span style={metricLabel}>{label}</span>
      <span style={{ ...metricValue, fontSize: 15, fontWeight: 600 }}>{value}</span>
      {children}
    </div>
  )
}

/** Horizontal meter bar for memory/disk percentages. */
export function MeterBar({ percent, color }: { percent: number | null; color: string }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  return (
    <div style={{ height: 8, borderRadius: 999, background: colors.border, overflow: 'hidden' }}>
      <div style={{ width: `${value.toFixed(1)}%`, height: '100%', background: color }} />
    </div>
  )
}

/** Localize one metric alert code. */
export function metricAlertText(alert: MetricAlert, t: ReturnType<typeof useI18n>['t']): { title: string; suggestion: string } {
  if (alert.code === 'cpu') return { title: t('warn.metricCpu'), suggestion: t('warn.suggest.cpu') }
  if (alert.code === 'memory') return { title: t('warn.metricMemory'), suggestion: t('warn.suggest.memory') }
  if (alert.code === 'disk') return { title: t('warn.metricDisk'), suggestion: t('warn.suggest.disk') }
  if (alert.code === 'queue') return { title: t('warn.metricQueue'), suggestion: t('warn.suggest.queue') }
  if (alert.code === 'stale') return { title: t('warn.metricStale'), suggestion: t('warn.suggest.stale') }
  return { title: t('warn.metricLoad'), suggestion: t('warn.suggest.load') }
}

/** Render localized metric alerts. */
export function MetricAlerts({ alerts }: { alerts: MetricAlert[] }) {
  const { t } = useI18n()
  if (alerts.length === 0) return null
  return (
    <div style={stack}>
      {alerts.map((alert, index) => {
        const text = metricAlertText(alert, t)
        const color = alert.severity === 'error' ? colors.danger : colors.warning
        return (
          <div key={`${alert.code}-${String(index)}`} style={{ ...warningItem, borderColor: color }}>
            <span style={{ fontWeight: 600 }}><span style={{ ...statusDot, background: color }} />{text.title}</span>
            <span style={time}>{text.suggestion}</span>
            <span style={{ ...time, color }}>{alert.value.toFixed(1)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** Format a percentage compactly. */
export function percentText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

/** Re-export the sample type for page props. */
