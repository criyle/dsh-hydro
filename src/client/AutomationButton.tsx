/**
 * Launch a DSH Automation task from a plugin page.
 *
 * The plugin does not run its own scheduler for AI work: it opens a chat with a
 * prompt that asks the agent to create a DSH scheduled task via the host's
 * automation tools. This keeps scheduling, permissions and delivery in DSH.
 */
import { useState } from 'react'
import { button, mutedText } from './styles.js'
import { CopyButton, ErrorLine } from './ui.js'
import { useI18n } from './i18n.js'
import { openAuthoringSession } from './workspace.js'

/** Props of {@link AutomationButton}. */
export interface AutomationButtonProps {
  /** Localized button label. */
  label: string
  /** Prompt sent into a new chat, instructing the agent to create a DSH task. */
  prompt: string
}

/** Render a button that opens the chat to create a DSH automation task. */
export function AutomationButton({ label, prompt }: AutomationButtonProps) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const launch = (): void => {
    setBusy(true)
    setError(null)
    void openAuthoringSession(prompt).then((opened) => {
      setFallback(!opened)
    }, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setBusy(false) })
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" style={button} disabled={busy} onClick={launch}>
        {busy ? t('automation.opening') : label}
      </button>
      <ErrorLine text={error} />
      {fallback ? (
        <>
          <span style={mutedText}>{t('automation.fallback')}</span>
          <CopyButton text={prompt} label={t('ai.copy')} />
        </>
      ) : null}
    </span>
  )
}
