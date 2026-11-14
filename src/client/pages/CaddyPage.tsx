/**
 * Caddy configuration manager: status + editable Caddyfile with
 * validate / save / save+reload / reload actions (all confirmed, readonly-aware).
 */
import { useEffect, useState } from 'react'
import type { CaddyResponse } from '../../shared/api.js'
import type { OperationResult } from '../../shared/types.js'
import { hydroApi } from '../api.js'
import { containsCjk } from '../format.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  button,
  colors,
  detailText,
  errorBadge,
  field,
  fieldLabel,
  inlineRow,
  monospaceFont,
  input,
  okBadge,
  page,
  primaryButton,
  stack,
  time,
  textarea,
  warningText,
} from '../styles.js'
import { Card, Collapsible, EmptyState, ErrorLine, PageHeading, LogBlock } from '../ui.js'
import { NeedHost } from './OpsPages.js'

/** Active caddy action label for feedback. */
type CaddyActionKind = 'validate' | 'save' | 'saveReload' | 'reload'

/**
 * Render the Caddy manager.
 * @returns the page element.
 */
export function CaddyPage() {
  const { t } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const read = useAsyncTask<CaddyResponse>(t)
  const action = useAsyncTask<OperationResult>(t)
  const [path, setPath] = useState('')
  const [content, setContent] = useState('')
  const [pending, setPending] = useState<CaddyActionKind | null>(null)
  const [pathValidation, setPathValidation] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: CaddyActionKind; ok: boolean } | null>(null)
  const hostId = activeHost?.id ?? null

  const load = (): void => {
    if (hostId === null) return
    void read.run((signal) => hydroApi.getCaddy(hostId, 'read', signal))
  }

  useEffect(() => {
    load()
    // Reload only when the active host changes.
  }, [hostId])

  useEffect(() => {
    if (read.data === null) return
    setPath(read.data.path ?? '')
    setContent(read.data.content ?? '')
  }, [read.data])

  if (activeHost === undefined) return <NeedHost />

  const data = read.data

  const run = (kind: CaddyActionKind): void => {
    void (async () => {
      if (kind !== 'validate' && !(await requestWrites())) return
      const confirmText = kind === 'validate'
        ? t('caddy.validateConfirm')
        : kind === 'save'
          ? t('caddy.saveConfirm')
          : kind === 'saveReload'
            ? t('caddy.saveReloadConfirm')
            : t('caddy.reloadConfirm')
      if (!(await requestConfirm({ title: confirmText }))) return
      if (kind !== 'reload' && path.trim() === '') { setPathValidation(t('caddy.pathRequired')); return }
      setPathValidation(null)
      setPending(kind)
      setNotice(null)
      const task = kind === 'validate'
        ? () => hydroApi.applyCaddy(activeHost.id, 'validate')
        : kind === 'reload'
          ? () => hydroApi.applyCaddy(activeHost.id, 'reload')
          : () => hydroApi.writeCaddy(activeHost.id, { path: path.trim(), content, reload: kind === 'saveReload' })
      const result = await action.run((_signal) => task().then((value) => value))
      if (result === null) return
      setNotice({ kind, ok: result.ok })
      if (result.ok) load()
      setPending(null)
    })()
  }

  const successLabel = (kind: CaddyActionKind): string => {
    if (kind === 'validate') return t('caddy.validated')
    if (kind === 'save') return t('caddy.saved')
    return t('caddy.reloaded')
  }

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.caddy')}
        hint={t('caddy.hint')}
        actions={(
          <button type="button" style={button} disabled={read.busy} onClick={load}>
            {read.busy ? t('panel.refreshing') : t('caddy.refresh')}
          </button>
        )}
      />
      <ErrorLine text={read.error === null ? null : t('caddy.loadFailed', { message: read.error })} />
      {data !== null && !data.installed ? (
        <Card>
          <EmptyState message={t('caddy.notInstalledHint')} />
        </Card>
      ) : null}
      {data === null || !data.installed ? null : (
        <>
          <div style={inlineRow}>
            {data.installed ? <span style={okBadge}>{t('caddy.installed')}</span> : <span style={errorBadge}>{t('caddy.notInstalled')}</span>}
            {data.installed ? (data.running ? <span style={okBadge}>{t('caddy.running')}</span> : <span style={errorBadge}>{t('caddy.stopped')}</span>) : null}
            {data.version === null ? null : <span style={time}>{t('caddy.version', { version: data.version })}</span>}
            <span style={time}>{t('caddy.manager', { manager: data.manager })}</span>
          </div>
          <Card>
            <div style={stack}>
              <p style={{ ...warningText, margin: 0 }}>{t('caddy.warnProxy')}</p>
              <label style={field}>
                <span style={fieldLabel}>{t('caddy.path')}</span>
                <input
                  style={input}
                  value={path}
                  placeholder={t('caddy.pathPlaceholder')}
                  disabled={!data.installed}
                  onChange={(event) => { setPath(event.currentTarget.value) }}
                />
              </label>
              <label style={field}>
                <span style={fieldLabel}>{t('caddy.content')}</span>
                <textarea
                  style={{ ...textarea, minHeight: 320, fontFamily: monospaceFont }}
                  value={content}
                  spellCheck={false}
                  disabled={!data.installed}
                  onChange={(event) => { setContent(event.currentTarget.value) }}
                />
              </label>
              <ErrorLine text={pathValidation} />
              <div style={inlineRow}>
                <button type="button" style={button} disabled={action.busy || !data.installed} onClick={() => { run('validate') }}>
                  {pending === 'validate' ? t('panel.refreshing') : t('caddy.validate')}
                </button>
                <button type="button" style={button} disabled={action.busy || !data.installed} onClick={() => { run('save') }}>
                  {pending === 'save' ? t('common.saving') : t('caddy.save')}
                </button>
                <button type="button" style={primaryButton} disabled={action.busy || !data.installed} onClick={() => { run('saveReload') }}>
                  {pending === 'saveReload' ? t('common.saving') : t('caddy.saveReload')}
                </button>
                <button type="button" style={button} disabled={action.busy || !data.installed} onClick={() => { run('reload') }}>
                  {pending === 'reload' ? t('panel.refreshing') : t('caddy.reload')}
                </button>
              </div>
              <ErrorLine text={action.error === null ? null : t('caddy.failed')} />
              {action.error === null || containsCjk(action.error) ? null : (
                <details>
                  <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
                  <p style={detailText}>{action.error}</p>
                </details>
              )}
              {notice === null ? null : (
                <p style={{ margin: 0, color: notice.ok ? colors.success : colors.danger }}>
                  {notice.ok ? successLabel(notice.kind) : t('caddy.failed')}
                </p>
              )}
              {action.data === null ? null : (
                <Collapsible label={t('caddy.output')}>
                  {action.data.message === '' ? null : <p style={{ margin: 0 }}>{action.data.message}</p>}
                  {action.data.log === undefined || action.data.log === '' ? null : <LogBlock text={action.data.log} />}
                </Collapsible>
              )}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
