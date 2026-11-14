/**
 * Traditional readonly switch for the console header.
 *
 * A visible track/knob + explicit label and state subtext; ON is the safe
 * default (the Host persists the setting). Turning it OFF is confirmed by the
 * caller because it enables remote writes.
 */
import { useI18n } from './i18n.js'
import {
  colors,
  switchKnob,
  switchTrack,
} from './styles.js'

/** Props of {@link ReadonlyToggle}. */
export interface ReadonlyToggleProps {
  /** Current global readonly state. */
  readonly: boolean
  /** Whether a settings mutation is in flight. */
  busy: boolean
  /** Requested next state. */
  onChange(next: boolean): void
}

/**
 * Render the readonly switch with a short state label.
 * @param props - state and change callback.
 * @returns the switch element.
 */
export function ReadonlyToggle({ readonly, busy, onChange }: ReadonlyToggleProps) {
  const { t } = useI18n()
  const tone = readonly ? colors.success : colors.danger
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={readonly}
        aria-label={t('readonly.label')}
        disabled={busy}
        style={{ ...switchTrack, borderColor: tone }}
        onClick={() => { onChange(!readonly) }}
      >
        <span style={{ ...switchKnob, left: readonly ? 16 : 2, background: tone }} />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{t('readonly.label')}</span>
        <span style={{ fontSize: 11, color: tone }}>{readonly ? t('readonly.stateOn') : t('readonly.stateOff')}</span>
      </div>
    </div>
  )
}
