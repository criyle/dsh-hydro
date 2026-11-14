/**
 * Direct-chat AI launchers for the embedded Hydro pages.
 *
 * Buttons never show forms: one click builds the prompt from the current
 * embedded context (problemId/contestId when the proxy reports a concrete
 * page, otherwise a create-new prompt) and opens the chat immediately; the
 * agent asks what to change. Domain pages get dedicated bulletin/permissions
 * launchers. A copyable fallback appears only if the workspace bridge fails.
 */
import { useState } from 'react'
import type { AuthoringPromptResponse, EmbeddedContextResponse } from '../shared/api.js'
import type { AuthoringPromptPayload } from './api.js'
import { describeError, hydroApi } from './api.js'
import { useI18n } from './i18n.js'
import type { MessageKey } from './locales.js'
import { openAuthoringSession } from './workspace.js'
import { SessionNotice } from './SessionNotice.js'
import {
  badge,
  button,
  colors,
  field,
  fieldLabel,
  mutedText,
  primaryButton,
  stack,
  textarea,
} from './styles.js'
import { CopyButton, ErrorLine } from './ui.js'

/** Shared launch state for the authoring prompt flow. */
interface AuthoringRun {
  busy: boolean
  error: string | null
  phase: 'idle' | 'opened' | 'fallback'
  prompt: string
  launch(payload: AuthoringPromptPayload): void
}

/** Build the shared prompt-launch state. */
function useAuthoringRun(): AuthoringRun {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'opened' | 'fallback'>('idle')
  const [prompt, setPrompt] = useState('')

  const launch = (payload: AuthoringPromptPayload): void => {
    setBusy(true)
    setError(null)
    setPhase('idle')
    void hydroApi.authoringPrompt(payload).then(async (response: AuthoringPromptResponse) => {
      setPrompt(response.prompt)
      const opened = await openAuthoringSession(response.prompt)
      setPhase(opened ? 'opened' : 'fallback')
    }, (cause: unknown) => {
      setError(describeError(cause, t))
    }).finally(() => { setBusy(false) })
  }

  return { busy, error, phase, prompt, launch }
}

/** Render the opened/fallback/error feedback shared by all launchers. */
function AuthoringFeedback({ run }: { run: AuthoringRun }) {
  const { t } = useI18n()
  return (
    <>
      <ErrorLine text={run.error} />
      <SessionNotice error={run.error} />
      {run.phase === 'opened' ? <span style={mutedText}>{t('ai.opened')}</span> : null}
      {run.phase === 'fallback' ? (
        <div style={stack}>
          <p style={{ ...mutedText, margin: 0 }}>{t('ai.fallbackNote')}</p>
          <textarea style={{ ...textarea, minHeight: 120 }} value={run.prompt} readOnly onChange={() => undefined} />
          <CopyButton text={run.prompt} label={t('ai.copy')} />
        </div>
      ) : null}
    </>
  )
}

/** Props of {@link EmbeddedContextBadge}. */
export interface EmbeddedContextBadgeProps {
  /** Latest proxy context (null before the first poll). */
  context: EmbeddedContextResponse | null
  /** Which embedded page is open. */
  pageKind: 'problem' | 'contest' | 'domain'
}

/**
 * Localized sub-page suffix for the context badge (edit/files/management/...).
 * @param context - proxy context.
 * @param t - active translator.
 * @returns suffix such as ` · 编辑`, or an empty string for a plain page.
 */
function contextPageSuffix(context: EmbeddedContextResponse, t: (key: MessageKey) => string): string {
  const page = context.page
  if (page === null || page === '' || page === 'view') return ''
  const labels: Record<string, MessageKey> = {
    edit: 'context.page.edit',
    files: 'context.page.files',
    submit: 'context.page.submit',
    management: 'context.page.management',
    clarification: 'context.page.clarification',
    problems: 'context.page.problems',
    print: 'context.page.print',
    code: 'context.page.code',
  }
  const key = labels[page]
  return key === undefined ? '' : t(key)
}

/**
 * Small badge describing what page the AI actions will target.
 * @param props - context and page kind.
 * @returns the badge element.
 */
export function EmbeddedContextBadge({ context, pageKind }: EmbeddedContextBadgeProps) {
  const { t } = useI18n()
  let label = t('context.detecting')
  if (context !== null) {
    const suffix = contextPageSuffix(context, t)
    if (pageKind === 'problem') {
      if (context.kind === 'problem') label = `${t('context.problem', { id: context.id ?? '?' })}${suffix}`
      else if (context.kind === 'problem-list') label = t('context.problemList')
      else if (context.kind === 'contest') label = `${t('context.contest', { id: context.id ?? '?' })}${suffix}`
      else if (context.kind === 'contest-list') label = t('context.contestList')
      else label = t('context.unknown')
    } else if (pageKind === 'contest') {
      if (context.kind === 'contest') label = `${t('context.contest', { id: context.id ?? '?' })}${suffix}`
      else if (context.kind === 'contest-list') label = t('context.contestList')
      else if (context.kind === 'problem') label = `${t('context.problem', { id: context.id ?? '?' })}${suffix}`
      else if (context.kind === 'problem-list') label = t('context.problemList')
      else label = t('context.unknown')
    } else {
      if (context.kind === 'domain') label = `${t('context.domain', { id: context.id ?? context.domain ?? '?' })}${suffix}`
      else label = t('context.domainUnknown')
    }
  }
  return <span style={badge}>{t('context.badge', { target: label })}</span>
}

/** Props of the small in-panel AI composer shown before opening chat. */
interface AiComposerProps {
  /** Composer title. */
  title: string
  /** What page/object the prompt targets. */
  target: string
  /** Suggestions appended to the instruction. */
  suggestions: readonly string[]
  /** Placeholder for the instruction textarea. */
  placeholder: string
  /** Whether a prompt request is running. */
  busy: boolean
  /** Close without sending. */
  onCancel(): void
  /** Send with the edited instruction. */
  onSubmit(instruction: string): void
}

/**
 * Editable instruction box shown when an AI button is pressed. The operator can
 * type what the agent should do (or pick a suggestion) before jumping to chat.
 */
function AiComposer({ title, target, suggestions, placeholder, busy, onCancel, onSubmit }: AiComposerProps) {
  const { t } = useI18n()
  const [instruction, setInstruction] = useState('')
  return (
    <div style={{ ...stack, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 10, marginTop: 6 }}>
      <strong style={{ fontSize: 12 }}>{title}</strong>
      <span style={mutedText}>{target}</span>
      <label style={field}>
        <span style={fieldLabel}>{t('ai.instructionLabel')}</span>
        <textarea
          style={{ ...textarea, minHeight: 84 }}
          value={instruction}
          placeholder={placeholder}
          onChange={(event) => { setInstruction(event.currentTarget.value) }}
        />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            style={{ ...button, fontSize: 11 }}
            disabled={busy}
            onClick={() => { setInstruction((current) => current.trim() === '' ? suggestion : `${current}\n${suggestion}`) }}
          >
            {suggestion}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" style={primaryButton} disabled={busy} onClick={() => { onSubmit(instruction.trim()) }}>
          {busy ? t('ai.generating') : t('ai.openChat')}
        </button>
        <button type="button" style={button} disabled={busy} onClick={onCancel}>{t('ai.cancel')}</button>
      </div>
    </div>
  )
}

/** Props of {@link SiteAiButton}. */
export interface SiteAiButtonProps {
  /** Active Hydro site-account id. */
  siteAccountId: string
  /** Embedded page kind. */
  pageKind: 'problem' | 'contest'
  /** Default domain from the Hydro account. */
  domain: string
  /** Latest embedded context from the proxy. */
  context: EmbeddedContextResponse | null
}

/**
 * Render the one-click context-aware AI edit button.
 * @param props - account, page kind, domain and context.
 * @returns the launcher element.
 */
export function SiteAiButton({ siteAccountId, pageKind, domain, context }: SiteAiButtonProps) {
  const { t } = useI18n()
  const run = useAuthoringRun()
  const [composing, setComposing] = useState(false)
  const targeted = context !== null && context.kind === pageKind && context.id !== null

  const launch = (instruction: string): void => {
    setComposing(false)
    run.launch({
      siteAccountId,
      kind: pageKind,
      domain: context?.domain ?? domain,
      ...(instruction === '' ? {} : { requirements: instruction }),
      ...(targeted
        ? pageKind === 'problem'
          ? { problemId: context.id as string, ...(context.page === null ? {} : { action: context.page }) }
          : { contestId: context.id as string, ...(context.page === null ? {} : { action: context.page }) }
        : {}),
    })
  }

  const contextSuffix = context === null ? '' : contextPageSuffix(context, t)
  const targetLabel = targeted
    ? `${pageKind === 'problem' ? t('context.problem', { id: context.id ?? '?' }) : t('context.contest', { id: context.id ?? '?' })}${contextSuffix}`
    : pageKind === 'problem' ? t('problem.aiNew') : t('contest.aiNew')
  const pageSuggestions: Record<string, MessageKey> = {
    edit: pageKind === 'problem' ? 'ai.suggest.problemEdit' : 'ai.suggest.contestEdit',
    files: 'ai.suggest.problemFiles',
    management: 'ai.suggest.contestManagement',
    clarification: 'ai.suggest.contestClarification',
    problems: 'ai.suggest.contestProblems',
    submit: 'ai.suggest.problemVerify',
  }
  const suggestionKey = context?.page === null || context?.page === undefined ? undefined : pageSuggestions[context.page]
  const suggestions = (suggestionKey === undefined
    ? pageKind === 'problem' ? t('ai.suggest.problem') : t('ai.suggest.contest')
    : t(suggestionKey)
  ).split('|')

  return (
    <div style={stack}>
      {composing ? (
        <AiComposer
          title={t('ai.composerTitle')}
          target={targetLabel}
          suggestions={suggestions}
          placeholder={pageKind === 'problem' ? t('ai.placeholderProblem') : t('ai.placeholderContest')}
          busy={run.busy}
          onCancel={() => { setComposing(false) }}
          onSubmit={launch}
        />
      ) : (
        <button type="button" style={button} disabled={run.busy} onClick={() => { setComposing(true) }}>
          {run.busy ? t('ai.generating') : t('ai.edit')}
        </button>
      )}
      <AuthoringFeedback run={run} />
    </div>
  )
}

/** Props of {@link DomainAiAction}. */
export interface DomainAiActionProps {
  /** Active Hydro site-account id. */
  siteAccountId: string
  /** Current domain. */
  domain: string
  /** Bulletin or permissions mode. */
  mode: 'bulletin' | 'permissions'
}

/**
 * Render one immediate domain AI action (bulletin / permissions).
 * @param props - account, domain and mode.
 * @returns the launcher element.
 */
export function DomainAiAction({ siteAccountId, domain, mode }: DomainAiActionProps) {
  const { t } = useI18n()
  const run = useAuthoringRun()
  const [composing, setComposing] = useState(false)
  const suggestions = (mode === 'bulletin' ? t('ai.suggest.bulletin') : t('ai.suggest.permissions')).split('|')

  const launch = (instruction: string): void => {
    setComposing(false)
    run.launch({
      siteAccountId,
      kind: mode === 'bulletin' ? 'domain-bulletin' : 'domain-permissions',
      domain,
      ...(instruction === '' ? {} : { requirements: instruction }),
    })
  }

  return (
    <div style={stack}>
      {composing ? (
        <AiComposer
          title={mode === 'bulletin' ? t('domain.aiBulletin') : t('domain.aiPermissions')}
          target={t('context.domain', { id: domain })}
          suggestions={suggestions}
          placeholder={mode === 'bulletin' ? t('ai.placeholderBulletin') : t('ai.placeholderPermissions')}
          busy={run.busy}
          onCancel={() => { setComposing(false) }}
          onSubmit={launch}
        />
      ) : (
        <button type="button" style={button} disabled={run.busy} onClick={() => { setComposing(true) }}>
          {run.busy ? t('ai.generating') : mode === 'bulletin' ? t('domain.aiBulletin') : t('domain.aiPermissions')}
        </button>
      )}
      <AuthoringFeedback run={run} />
    </div>
  )
}
