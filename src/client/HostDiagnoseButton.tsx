/**
 * "Ask AI to troubleshoot" launcher for a finished (or failed) install/upgrade.
 *
 * Asks the Host for a diagnosis prompt built from the terminal tail, then opens
 * a new chat through the optional `uiWorkspace` bridge. When the chat cannot be
 * opened the prompt is shown with a copy button (and only then: the prompt text
 * stays hidden when a chat opened successfully).
 */
import { useState } from 'react'
import { describeError, hydroApi } from './api.js'
import { useI18n } from './i18n.js'
import { openAuthoringSession } from './workspace.js'
import {
  button,
  field,
  fieldLabel,
  inlineRow,
  mutedText,
  stack,
  textarea,
} from './styles.js'
import { CopyButton, ErrorLine } from './ui.js'

/** Props of {@link HostDiagnoseButton}. */
export interface HostDiagnoseButtonProps {
  /** SSH host record id. */
  hostId: string
  /** Which operation just ended (or the troubleshooting issues check). */
  kind: 'install' | 'upgrade' | 'issues'
  /** Terminal output tail (this component keeps the last 4000 chars). */
  output: string
  /** Final result/error message, when there is one. */
  message?: string
}

/** Local launcher phase. */
type DiagnosePhase = 'idle' | 'busy' | 'opened' | 'fallback' | 'error'

/**
 * Render the diagnose button plus its fallback prompt UI.
 * @param props - host, operation kind, output tail and message.
 * @returns the launcher element.
 */
export function HostDiagnoseButton({ hostId, kind, output, message }: HostDiagnoseButtonProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<DiagnosePhase>('idle')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = (): void => {
    setPhase('busy')
    setError(null)
    setPrompt('')
    void hydroApi.diagnoseHost({
      hostId,
      kind,
      output: output.slice(-4000),
      ...(message === undefined || message === '' ? {} : { message }),
    }).then(async (response) => {
      setPrompt(response.prompt)
      const opened = await openAuthoringSession(response.prompt)
      setPhase(opened ? 'opened' : 'fallback')
    }, (cause: unknown) => {
      setPhase('error')
      setError(t('diagnose.failed', { message: describeError(cause, t) }))
    })
  }

  return (
    <div style={stack}>
      <div style={inlineRow}>
        <button type="button" style={button} disabled={phase === 'busy'} onClick={run}>
          {phase === 'busy' ? t('diagnose.generating') : t('diagnose.button')}
        </button>
        {phase === 'opened' ? <span style={mutedText}>{t('diagnose.opened')}</span> : null}
      </div>
      <ErrorLine text={error} />
      {phase === 'fallback' ? (
        <>
          <p style={{ ...mutedText, margin: 0 }}>{t('diagnose.fallbackNote')}</p>
          <label style={field}>
            <span style={fieldLabel}>{t('diagnose.prompt')}</span>
            <textarea
              style={{ ...textarea, minHeight: 160 }}
              value={prompt}
              readOnly
              spellCheck={false}
              onChange={() => undefined}
            />
          </label>
          <div>
            <CopyButton text={prompt} label={t('diagnose.copy')} />
          </div>
        </>
      ) : null}
    </div>
  )
}
