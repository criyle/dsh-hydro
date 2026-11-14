/**
 * Standalone Hydro judge manager: show install state and edit judge.yaml.
 *
 * The editor only appears when an independent hydrojudge is detected; a
 * web-only host shows an install hint instead of a misleading config form.
 */
import { useEffect, useState } from 'react'
import type { JudgeConfigResponse } from '../../shared/api.js'
import type { OperationResult } from '../../shared/types.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  button,
  colors,
  field,
  fieldLabel,
  inlineRow,
  monospaceFont,
  mutedText,
  page,
  primaryButton,
  stack,
  textarea,
  time,
} from '../styles.js'
import { Card, Collapsible, EmptyState, ErrorLine, LogBlock, PageHeading } from '../ui.js'

/** Render the standalone judge page. */
export function JudgePage() {
  const { t } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const config = useAsyncTask<JudgeConfigResponse>(t)
  const action = useAsyncTask<OperationResult>(t)
  const [content, setContent] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (activeHost === undefined) return
    void config.run((signal) => hydroApi.hostJudge(activeHost.id, signal))
    // Reload when the selected host changes.
  }, [activeHost?.id])

  useEffect(() => {
    setContent(config.data?.content ?? '')
  }, [config.data])

  if (activeHost === undefined) return <Card><EmptyState message={t('page.needHost')} /></Card>

  const data = config.data
  const save = (): void => {
    if (data === null || data.path === null) return
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('judge.saveConfirm') }))) return
      const result = await action.run((signal) => hydroApi.saveJudgeConfig(activeHost.id, data.path as string, content, signal))
      if (result === null) return
      setNotice(result.ok ? t('judge.saved') : t('judge.saveFailed'))
      void config.run((signal) => hydroApi.hostJudge(activeHost.id, signal))
    })()
  }

  const restart = (): void => {
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('judge.restartConfirm') }))) return
      const result = await action.run((signal) => hydroApi.restartJudge(activeHost.id, signal))
      if (result !== null) {
        setNotice(result.ok ? t('judge.restarted') : t('judge.restartFailed'))
        void config.run((signal) => hydroApi.hostJudge(activeHost.id, signal))
      }
    })()
  }

  return (
    <div style={page}>
      <PageHeading
        title={t('menu.judge')}
        hint={t('judge.hint')}
        actions={(
          <button type="button" style={button} disabled={config.busy} onClick={() => { void config.run((signal) => hydroApi.hostJudge(activeHost.id, signal)) }}>
            {config.busy ? t('panel.refreshing') : t('judge.refresh')}
          </button>
        )}
      />
      <ErrorLine text={config.error === null ? null : t('judge.loadFailed')} />
      {data === null ? null : !data.installed ? (
        <Card>
          <EmptyState message={t('judge.notInstalled')} />
        </Card>
      ) : (
        <>
          <div style={inlineRow}>
            <span style={{ fontSize: 12, color: data.running ? colors.success : colors.danger }}>
              {data.running ? t('judge.running') : t('judge.stopped')}
            </span>
            <span style={time}>{t('judge.manager', { manager: data.manager })}</span>
            {data.path === null ? null : <span style={time}>{data.path}</span>}
          </div>
          <Card title={t('judge.configTitle')} hint={t('judge.configHint')}>
            <div style={stack}>
              <label style={field}>
                <span style={fieldLabel}>{t('judge.config')}</span>
                <textarea
                  style={{ ...textarea, minHeight: 360, fontFamily: monospaceFont }}
                  value={content}
                  spellCheck={false}
                  onChange={(event) => { setContent(event.currentTarget.value) }}
                />
              </label>
              <div style={inlineRow}>
                <button type="button" style={primaryButton} disabled={action.busy} onClick={save}>
                  {action.busy ? t('common.saving') : t('judge.save')}
                </button>
                <button type="button" style={button} disabled={action.busy} onClick={restart}>
                  {t('judge.restart')}
                </button>
                <span style={mutedText}>{t('judge.advancedHint')}</span>
              </div>
              <ErrorLine text={action.error === null ? null : t('judge.actionFailed')} />
              {notice === null ? null : <p style={{ margin: 0, color: colors.success }}>{notice}</p>}
              {action.data === null ? null : (
                <Collapsible label={t('judge.output')}>
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
