/**
 * Add/edit host form.
 *
 * The SSH password is a one-time bootstrap secret used by the Host to install
 * the managed key and configure passwordless sudo; it is never stored or
 * accepted for rotation. Edit mode therefore offers no password/private-key
 * fields and shows the managed-key state instead.
 */
import { useState } from 'react'
import type { AccountSummary } from '../shared/types.js'
import { useI18n } from './i18n.js'
import {
  button,
  field,
  fieldLabel,
  form,
  formGrid,
  input,
  monospaceFont,
  mutedText,
  primaryButton,
} from './styles.js'
import { ErrorLine } from './ui.js'

/** Values collected by {@link HostForm} (host-record fields only). */
export interface HostFormPayload {
  label: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  /** One-time bootstrap password (create + password auth only). */
  password?: string
  /** Private key content (create + key auth only). */
  privateKey?: string
  /** Always true: install the managed key during the one-time bootstrap. */
  installManagedKey: true
}

/** Props of {@link HostForm}. */
export interface HostFormProps {
  /** Host being edited, or null when adding. */
  initial: AccountSummary | null
  /** Whether an action is running; disables submission. */
  busy: boolean
  /**
   * Persist the host record.
   * @param payload - validated form values.
   * @returns true when the Host accepted it (the form then closes).
   */
  onSave(payload: HostFormPayload): Promise<boolean>
  /** Collapse the form without submitting. */
  onCancel(): void
}

/** Form field values, all kept as strings for easy binding. */
interface FormState {
  host: string
  port: string
  username: string
  password: string
  privateKey: string
  label: string
  authMethod: 'password' | 'key'
}

/**
 * Render the host form.
 * @param props - initial record, flags and callbacks.
 * @returns the form element.
 */
export function HostForm({ initial, busy, onSave, onCancel }: HostFormProps) {
  const { t } = useI18n()
  const editing = initial !== null
  const [state, setState] = useState<FormState>({
    host: initial?.host ?? '',
    port: String(initial?.port ?? 22),
    username: initial?.username ?? 'root',
    password: '',
    privateKey: '',
    label: initial?.label ?? '',
    authMethod: initial?.authMethod ?? 'password',
  })
  const [validation, setValidation] = useState<string | null>(null)

  const patch = (part: Partial<FormState>): void => {
    setState((current) => ({ ...current, ...part }))
  }

  const submit = async (): Promise<void> => {
    const host = state.host.trim()
    const username = state.username.trim()
    const port = Number(state.port)
    if (host === '') { setValidation(t('form.errHost')); return }
    if (username === '') { setValidation(t('form.errUsername')); return }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setValidation(t('form.errPort')); return }
    if (!editing && state.authMethod === 'password' && state.password === '') { setValidation(t('form.errPassword')); return }
    if (!editing && state.authMethod === 'key' && state.privateKey.trim() === '') { setValidation(t('form.errPrivateKey')); return }
    setValidation(null)
    const trimmedLabel = state.label.trim()
    const payload: HostFormPayload = {
      host,
      port,
      username,
      authMethod: state.authMethod,
      installManagedKey: true,
      ...(state.password === '' ? {} : { password: state.password }),
      ...(!editing && state.authMethod === 'key' ? { privateKey: state.privateKey } : {}),
      label: trimmedLabel,
    }
    if (await onSave(payload)) onCancel()
  }

  return (
    <div style={form}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
        {editing ? t('form.editTitle') : t('form.title')}
      </h2>
      <div style={formGrid}>
        <label style={field}>
          <span style={fieldLabel}>{t('form.host')}</span>
          <input
            style={input}
            value={state.host}
            placeholder="judge.example.com"
            autoComplete="off"
            onChange={(event) => { patch({ host: event.currentTarget.value }) }}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('form.port')}</span>
          <input
            style={input}
            value={state.port}
            inputMode="numeric"
            onChange={(event) => { patch({ port: event.currentTarget.value }) }}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('form.username')}</span>
          <input
            style={input}
            value={state.username}
            autoComplete="off"
            onChange={(event) => { patch({ username: event.currentTarget.value }) }}
          />
        </label>
        <label style={field}>
          <span style={fieldLabel}>{t('form.authMethod')}</span>
          <select
            style={input}
            value={state.authMethod}
            disabled={editing}
            onChange={(event) => { patch({ authMethod: event.currentTarget.value === 'key' ? 'key' : 'password' }) }}
          >
            <option value="password">{t('form.optionPassword')}</option>
            <option value="key">{t('form.optionKey')}</option>
          </select>
          {editing ? <span style={{ ...mutedText, fontSize: 10 }}>{t('form.authFixed')}</span> : null}
        </label>
        {editing ? (
          <div style={field}>
            <span style={fieldLabel}>{t('form.managedKeyState')}</span>
            <span style={mutedText}>
              {initial?.hasManagedKey === true ? t('form.keyManaged') : t('form.keyNotManaged')}
            </span>
          </div>
        ) : state.authMethod === 'password' ? (
          <label style={field}>
            <span style={fieldLabel}>{t('form.passwordBootstrap')}</span>
            <input
              style={input}
              type="password"
              value={state.password}
              autoComplete="new-password"
              onChange={(event) => { patch({ password: event.currentTarget.value }) }}
            />
            <span style={{ ...mutedText, fontSize: 10 }}>{t('form.passwordBootstrapHelp')}</span>
          </label>
        ) : (
          <label style={{ ...field, gridColumn: '1 / -1' }}>
            <span style={fieldLabel}>{t('form.privateKey')}</span>
            <textarea
              style={{ ...input, minHeight: 72, fontFamily: monospaceFont }}
              value={state.privateKey}
              onChange={(event) => { patch({ privateKey: event.currentTarget.value }) }}
            />
          </label>
        )}
      </div>

      {editing ? null : (
        <>
          <label style={field}>
            <span style={fieldLabel}>{t('form.label')}</span>
            <input
              style={input}
              value={state.label}
              placeholder={t('form.labelPlaceholder')}
              autoComplete="off"
              onChange={(event) => { patch({ label: event.currentTarget.value }) }}
            />
          </label>
          <p style={{ ...mutedText, margin: 0 }}>{t('form.installManagedKeyLocked')}</p>
        </>
      )}
      {editing ? (
        <label style={field}>
          <span style={fieldLabel}>{t('form.label')}</span>
          <input
            style={input}
            value={state.label}
            placeholder={t('form.labelPlaceholder')}
            autoComplete="off"
            onChange={(event) => { patch({ label: event.currentTarget.value }) }}
          />
        </label>
      ) : null}

      <ErrorLine text={validation} />

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primaryButton} disabled={busy} onClick={() => { void submit() }}>
          {busy ? t('form.submitting') : editing ? t('form.save') : t('form.submit')}
        </button>
        <button type="button" style={button} disabled={busy} onClick={onCancel}>{t('form.cancel')}</button>
      </div>
    </div>
  )
}
