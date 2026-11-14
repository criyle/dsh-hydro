/**
 * Add/edit Hydro web admin account form.
 *
 * One host can own several site accounts, so this form always creates a new
 * account unless an `id` is supplied; editing keeps the host fixed and a blank
 * password means "keep the stored one". Host, username and password are the
 * primary fields; domain, role, note and the readonly switch stay collapsed.
 */
import { useState } from 'react'
import type { SiteAccountSummary, SiteRole } from '../shared/api.js'
import type { AccountSummary } from '../shared/types.js'
import type { SiteSavePayload } from './api.js'
import { formatSiteRole, SITE_ROLES } from './format.js'
import { ErrorLine } from './ui.js'
import { useI18n } from './i18n.js'
import {
  button,
  field,
  fieldLabel,
  form,
  formGrid,
  input,
  mutedText,
  primaryButton,
  textarea,
} from './styles.js'

/** Props of {@link SiteAccountForm}. */
export interface SiteAccountFormProps {
  /** All host records (the host select). */
  hosts: AccountSummary[]
  /** The account being edited, or null when adding. */
  initial: SiteAccountSummary | null
  /** Whether a save is running. */
  busy: boolean
  /**
   * Save through `POST site/save`.
   * @param payload - `id` present = edit, password empty = keep current.
   * @returns true when the Host accepted it (the form then closes).
   */
  onSave(payload: SiteSavePayload): Promise<boolean>
  /** Close the form without saving. */
  onCancel(): void
}

/**
 * Render the site account form.
 * @param props - hosts, existing account, busy/readonly flags and callbacks.
 * @returns the form element.
 */
export function SiteAccountForm({ hosts, initial, busy, onSave, onCancel }: SiteAccountFormProps) {
  const { t } = useI18n()
  const editing = initial !== null
  const [hostId, setHostId] = useState(initial?.hostId ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [uname, setUname] = useState(initial?.uname ?? '')
  const [domain, setDomain] = useState(initial?.domain ?? '')
  const [role, setRole] = useState<SiteRole>(initial?.role ?? 'superadmin')
  const [note, setNote] = useState(initial?.note ?? '')
  const [validation, setValidation] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (hostId === '') { setValidation(t('site.errHost')); return }
    if (uname.trim() === '') { setValidation(t('site.errUname')); return }
    setValidation(null)
    const trimmedLabel = label.trim()
    const trimmedDomain = domain.trim()
    const trimmedNote = note.trim()
    const payload: SiteSavePayload = {
      ...(editing ? { id: initial.id } : {}),
      hostId,
      ...(trimmedLabel === '' ? {} : { label: trimmedLabel }),
      uname: uname.trim(),
      ...(trimmedDomain === '' ? {} : { domain: trimmedDomain }),
      role,
      ...(trimmedNote === '' && !editing ? {} : { note: trimmedNote }),
    }
    if (await onSave(payload)) onCancel()
  }

  return (
    <div style={form}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {editing ? t('site.formTitleEdit') : t('site.formTitleCreate')}
      </h2>
      <div style={formGrid}>
        <label style={field}>
          <span style={fieldLabel}>{t('site.host')}</span>
          <select
            style={input}
            value={hostId}
            disabled={editing || busy}
            onChange={(event) => { setHostId(event.currentTarget.value) }}
          >
            <option value="">{t('site.hostPlaceholder')}</option>
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.label} · {host.username}@{host.host}
              </option>
            ))}
          </select>
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('site.label')}</span>
          <input
            style={input}
            value={label}
            autoComplete="off"
            onChange={(event) => { setLabel(event.currentTarget.value) }}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('site.uname')}</span>
          <input
            style={input}
            value={uname}
            autoComplete="off"
            onChange={(event) => { setUname(event.currentTarget.value) }}
          />
        </label>
      </div>

      <div style={formGrid}>
        <label style={field}>
          <span style={fieldLabel}>{t('site.domain')}</span>
          <input
            style={input}
            value={domain}
            placeholder={t('site.domainPlaceholder')}
            autoComplete="off"
            onChange={(event) => { setDomain(event.currentTarget.value) }}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('site.role')}</span>
          <select
            style={input}
            value={role}
            onChange={(event) => { setRole(event.currentTarget.value as SiteRole) }}
          >
            {SITE_ROLES.map((value) => (
              <option key={value} value={value}>{formatSiteRole(value, t)}</option>
            ))}
          </select>
        </label>
      </div>
      <label style={field}>
        <span style={fieldLabel}>{t('site.note')}</span>
        <textarea
          style={{ ...textarea, minHeight: 40 }}
          value={note}
          placeholder={t('site.notePlaceholder')}
          onChange={(event) => { setNote(event.currentTarget.value) }}
        />
      </label>

      <p style={{ ...mutedText, margin: 0 }}>{t('site.loginHint')}</p>
      <ErrorLine text={validation} />

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primaryButton} disabled={busy} onClick={() => { void submit() }}>
          {busy ? t('site.saving') : t('site.save')}
        </button>
        <button type="button" style={button} disabled={busy} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </div>
  )
}
