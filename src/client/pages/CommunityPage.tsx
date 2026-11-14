/**
 * 社区互动: Hydro discussions with manual approval.
 *
 * A read-only scheduled poll refreshes the discussion list and unread counters;
 * every reply is manual (confirmed) and disabled under global readonly. The AI
 * reply button builds a `discussion-reply` prompt and opens the chat where the
 * agent reads via the discussion tools and asks for approval before posting.
 */
import { useEffect, useState } from 'react'
import type {
  CommunityConfigResponse,
  CommunityDiscussion,
  CommunityFeedResponse,
  CommunityPollResponse,
  CommunityThreadResponse,
} from '../../shared/api.js'
import type { AuthoringPromptResponse } from '../../shared/api.js'
import { describeError, hydroApi } from '../api.js'
import { containsCjk, formatTime } from '../format.js'
import { useConsole } from '../console-context.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import type { MessageKey } from '../locales.js'
import { openAuthoringSession } from '../workspace.js'
import { EmbeddedHydro } from '../EmbeddedHydro.js'
import { DomainSelect, NeedSiteAccount, SiteSessionGate } from './SiteShared.js'
import { NeedHost } from './OpsPages.js'
import { AutomationButton } from '../AutomationButton.js'
import { SessionNotice } from '../SessionNotice.js'
import {
  button,
  colors,
  compactInput,
  dangerButton,
  errorBadge,
  field,
  fieldLabel,
  inlineRow,
  mutedText,
  page,
  primaryButton,
  stack,
  textarea,
  time,
  warningText,
} from '../styles.js'
import { Card, CopyButton, EmptyState, ErrorLine, PageHeading } from '../ui.js'

/** Local AI prompt state for the reply composer. */
interface AiReplyState {
  open: boolean
  requirements: string
  busy: boolean
  error: string | null
  phase: 'idle' | 'opened' | 'fallback'
  prompt: string
}

/** Build the default AI reply state. */
function initialAiState(): AiReplyState {
  return { open: false, requirements: '', busy: false, error: null, phase: 'idle', prompt: '' }
}

/**
 * Render the community interaction page.
 * @returns the page element.
 */
export function CommunityPage() {
  const { t, locale } = useI18n()
  const { activeSiteAccount, activeHost, navigate, requestWrites, requestConfirm } = useConsole()
  const status = useAsyncTask<CommunityConfigResponse>(t)
  const save = useAsyncTask<CommunityConfigResponse>(t)
  const feed = useAsyncTask<CommunityFeedResponse>(t)
  const thread = useAsyncTask<CommunityThreadResponse>(t)
  const poll = useAsyncTask<CommunityPollResponse>(t)
  const reply = useAsyncTask<{ ok: boolean; message: string }>(t)
  const [enabled, setEnabled] = useState(false)
  const [interval, setIntervalMinutes] = useState('10')
  const [domain, setDomain] = useState('')
  const [persona, setPersona] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const [embedPath, setEmbedPath] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedDid, setSelectedDid] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [ai, setAi] = useState<AiReplyState>(initialAiState)

  const accountId = activeSiteAccount?.id ?? status.data?.siteAccountId ?? null
  const feedDomain = activeSiteAccount?.domain ?? status.data?.domain ?? 'system'

  useEffect(() => {
    void status.run(() => hydroApi.communityStatus())
    // Load once; config is global.
  }, [])

  useEffect(() => {
    const data = status.data
    if (data === null) return
    setEnabled(data.enabled)
    setIntervalMinutes(String(data.intervalMinutes))
    setDomain(data.domain)
    setPersona(data.replyPersona ?? '')
  }, [status.data])

  useEffect(() => {
    if (accountId === null) return
    void feed.run((signal) => hydroApi.communityFeed({ siteAccountId: accountId, domain: feedDomain, limit: 20 }, signal))
    // Reload when the account/domain changes.
  }, [accountId, feedDomain])

  useEffect(() => {
    if (accountId === null || selectedDid === null) return
    void thread.run((signal) => hydroApi.communityThread({ siteAccountId: accountId, did: selectedDid }, signal))
    // Load the selected thread.
  }, [accountId, selectedDid])

  const loadFeed = (): void => {
    if (accountId === null) return
    void feed.run((signal) => hydroApi.communityFeed({ siteAccountId: accountId, domain: feedDomain, limit: 20 }, signal))
  }

  const reloadThread = (): void => {
    if (accountId === null || selectedDid === null) return
    void thread.run((signal) => hydroApi.communityThread({ siteAccountId: accountId, did: selectedDid }, signal))
  }

  const persist = (): void => {
    void (async () => {
    const minutes = Number(interval)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) { setValidation(t('community.intervalInvalid')); return }
    if (enabled && status.data?.enabled !== true) {
      if (!(await requestConfirm({ title: t('community.saveConfirm') }))) return
    }
    setValidation(null)
    void save.run((signal) => hydroApi.saveCommunityConfig({
      enabled,
      intervalMinutes: minutes,
      domain: domain.trim() === '' ? feedDomain : domain.trim(),
      siteAccountId: accountId,
      replyPersona: persona.trim(),
    }, signal)).then((result) => {
      if (result === null) return
      setNotice(t('community.saved'))
      // Reload status; changing the saved domain re-triggers the feed effect.
      void status.run(() => hydroApi.communityStatus())
    })
    })()
  }

  const runPoll = (): void => {
    void poll.run((signal) => hydroApi.communityPoll(accountId ?? undefined, signal)).then((result) => {
      if (result === null) return
      setNotice(t('community.pollDone'))
      loadFeed()
      void status.run(() => hydroApi.communityStatus())
    })
  }

  const sendReply = (): void => {
    if (accountId === null || selectedDid === null) return
    const content = replyText.trim()
    if (content === '') { setValidation(t('community.replyRequired')); return }
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('community.replyConfirm') }))) return
      setValidation(null)
      const result = await reply.run((signal) => hydroApi.communityReply({ siteAccountId: accountId, did: selectedDid, content }, signal))
      if (result === null) return
      setReplyText('')
      setNotice(t('community.replySent'))
      reloadThread()
      loadFeed()
    })()
  }

  const generateAiReply = (): void => {
    if (accountId === null || selectedDid === null) return
    setAi((current) => ({ ...current, busy: true, error: null, phase: 'idle' }))
    const requirements = [
      ai.requirements.trim(),
      persona.trim() === '' ? '' : `${t('community.personaPrefix')}${persona.trim()}`,
    ].filter((part) => part !== '').join('\n')
    void hydroApi.authoringPrompt({
      siteAccountId: accountId,
      kind: 'discussion-reply',
      domain: feedDomain,
      discussionId: selectedDid,
      ...(requirements === '' ? {} : { requirements }),
    }).then(async (response: AuthoringPromptResponse) => {
      const opened = await openAuthoringSession(response.prompt)
      setAi((current) => ({ ...current, prompt: response.prompt, phase: opened ? 'opened' : 'fallback' }))
    }, (cause: unknown) => {
      setAi((current) => ({ ...current, error: describeError(cause, t) }))
    }).finally(() => {
      setAi((current) => ({ ...current, busy: false }))
    })
  }

  const seen = new Map((status.data?.seenDids ?? []).map((entry) => [entry.did, entry.replyCount]))
  const isNew = (discussion: CommunityDiscussion): boolean => {
    const previous = seen.get(discussion.did)
    if (previous === undefined) return status.data?.lastCheckedAt !== null
    return discussion.replyCount !== null && previous !== null && discussion.replyCount > previous
  }
  const newActivity = status.data?.newActivity ?? feed.data?.newActivity ?? 0

  if (activeHost === undefined) return <NeedHost />
  if (activeSiteAccount === undefined) return <NeedSiteAccount />

  return (
    <SiteSessionGate account={activeSiteAccount}>
    <div style={page}>
      <PageHeading
        title={t('menu.community')}
        hint={t('community.hint')}
        actions={(
          <span style={inlineRow}>
            {activeSiteAccount === undefined ? null : <DomainSelect account={activeSiteAccount} />}
            <button type="button" style={button} disabled={poll.busy} onClick={runPoll}>
              {poll.busy ? t('community.polling') : t('community.poll')}
            </button>
            <button type="button" style={button} disabled={feed.busy} onClick={loadFeed}>
              {feed.busy ? t('panel.refreshing') : t('community.refresh')}
            </button>
            <AutomationButton label={t('automation.communityLabel')} prompt={t('automation.communityPrompt')} />
          </span>
        )}
      />
      <p style={{ ...mutedText, margin: 0 }}>{t('community.agentNote')}</p>

      <ErrorLine text={status.error === null ? null : t('community.loadFailed')} />
      <ErrorLine text={save.error === null ? null : t('community.configFailed')} />
      <ErrorLine text={poll.error === null ? null : t('community.loadFailed')} />
      <SessionNotice error={status.error ?? feed.error ?? thread.error ?? reply.error ?? ai.error} />

      <Card title={t('community.configTitle')}>
        <div style={stack}>
          <div style={inlineRow}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.currentTarget.checked) }} />
              <span style={{ fontSize: 12 }}>{t('community.enabled')}</span>
            </label>
            {newActivity === 0 ? null : <span style={warningText}>{t('community.newActivity', { count: newActivity })}</span>}
            {status.data?.lastCheckedAt === null || status.data?.lastCheckedAt === undefined ? null : (
              <span style={time}>{t('community.status', { time: formatTime(status.data.lastCheckedAt, locale, t) })}</span>
            )}
          </div>
          <div style={inlineRow}>
            <label style={field}>
              <span style={fieldLabel}>{t('community.interval')}</span>
              <input
                style={compactInput}
                value={interval}
                inputMode="numeric"
                onChange={(event) => { setIntervalMinutes(event.currentTarget.value) }}
              />
            </label>
            <label style={field}>
              <span style={fieldLabel}>{t('community.domain')}</span>
              <input
                style={compactInput}
                value={domain}
                placeholder={activeSiteAccount?.domain ?? 'system'}
                onChange={(event) => { setDomain(event.currentTarget.value) }}
              />
            </label>
            <button type="button" style={primaryButton} disabled={save.busy} onClick={persist}>
              {save.busy ? t('common.saving') : t('community.save')}
            </button>
          </div>
          <label style={field}>
            <span style={fieldLabel}>{t('community.persona')}</span>
            <textarea
              style={{ ...textarea, minHeight: 64 }}
              value={persona}
              placeholder={t('community.personaPlaceholder')}
              onChange={(event) => { setPersona(event.currentTarget.value) }}
            />
          </label>
          <div style={inlineRow}>
            {[
              { key: 'friendly', label: 'community.persona.friendly.label', value: 'community.persona.friendly' },
              { key: 'concise', label: 'community.persona.concise.label', value: 'community.persona.concise' },
              { key: 'casual', label: 'community.persona.casual.label', value: 'community.persona.casual' },
            ].map((preset) => (
              <button key={preset.key} type="button" style={button} onClick={() => { setPersona(t(preset.value as MessageKey)) }}>
                {t(preset.label as MessageKey)}
              </button>
            ))}
          </div>
          <ErrorLine text={validation} />
          {notice === null ? null : <p style={{ margin: 0, color: colors.success }}>{notice}</p>}
        </div>
      </Card>

      {accountId === null ? (
        <Card>
          <EmptyState
            message={activeHost?.hydro?.installMode === 'judge' ? t('page.judgeOnlySite') : t('page.needSite')}
            actionLabel={activeHost?.hydro?.installMode === 'judge' ? t('menu.judge') : t('page.goSiteAccounts')}
            onAction={() => { navigate(activeHost?.hydro?.installMode === 'judge' ? 'ops/judge' : 'settings/site-accounts') }}
          />
        </Card>
      ) : (
        <div style={inlineRow}>
          <div style={{ ...stack, flex: '1 1 320px', minWidth: 0 }}>
            <Card title={t('community.feedTitle')}>
              {feed.data === null ? (
                <p style={{ ...mutedText, margin: 0 }}>{feed.busy ? t('metrics.collecting') : t('community.feedEmpty')}</p>
              ) : feed.data.discussions.length === 0 ? (
                <p style={{ ...mutedText, margin: 0 }}>{t('community.feedEmpty')}</p>
              ) : (
                <div style={stack}>
                  {feed.data.discussions.map((discussion) => (
                    <button
                      key={discussion.did}
                      type="button"
                      style={selectedDid === discussion.did
                        ? { ...accountRowStyle, borderColor: colors.accent }
                        : accountRowStyle}
                      onClick={() => { setSelectedDid(discussion.did) }}
                    >
                      <span style={inlineRow}>
                        {isNew(discussion) ? <span style={errorBadge}>{t('community.newBadge')}</span> : null}
                        <strong style={{ fontSize: 12 }}>{discussion.title}</strong>
                      </span>
                      <span style={time}>
                        {t('community.from', { domain: discussion.domain, node: discussion.node ?? '?' })}
                        {' · '}
                        {t('community.author', { owner: discussion.ownerName ?? (discussion.owner === null ? '?' : `#${String(discussion.owner)}`) })}
                        {' · '}
                        {t('community.replyCount', { count: discussion.replyCount ?? 0 })}
                        {discussion.updatedAt === null ? '' : ` · ${t('community.updatedAt', { time: formatTime(discussion.updatedAt, locale, t) })}`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>
          <div style={{ ...stack, flex: '2 1 420px', minWidth: 0 }}>
            <Card title={t('community.threadTitle')}>
              {selectedDid === null ? (
                <p style={{ ...mutedText, margin: 0 }}>{t('community.selectThread')}</p>
              ) : thread.data === null ? (
                <p style={{ ...mutedText, margin: 0 }}>{thread.busy ? t('metrics.collecting') : t('community.selectThread')}</p>
              ) : (
                <div style={stack}>
                  <div style={inlineRow}>
                    <h3 style={{ margin: 0, fontSize: 14 }}>{thread.data.title}</h3>
                    {activeHost === undefined ? null : (
                      <button type="button" style={button} onClick={() => { setEmbedPath(thread.data?.url ?? null) }}>
                        {t('community.openEmbedded')}
                      </button>
                    )}
                  </div>
                  <span style={time}>
                    {t('community.from', { domain: thread.data.domain, node: thread.data.node ?? '?' })}
                    {' · '}
                    {t('community.author', { owner: thread.data.ownerName ?? (thread.data.owner === null ? '?' : `#${String(thread.data.owner)}`) })}
                  </span>
                  <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{thread.data.content}</p>
                  <span style={time}>{t('community.replies', { count: thread.data.replies.length })}</span>
                  {thread.data.replies.length === 0 ? (
                    <p style={{ ...mutedText, margin: 0 }}>{t('community.replyEmpty')}</p>
                  ) : thread.data.replies.map((entry) => (
                    <div key={entry.id} style={{ borderLeft: `2px solid ${colors.border}`, paddingLeft: 8 }}>
                      <span style={time}>
                        {t('community.author', { owner: entry.ownerName ?? (entry.owner === null ? '?' : `#${String(entry.owner)}`) })}
                        {entry.time === null ? '' : ` · ${formatTime(entry.time, locale, t)}`}
                      </span>
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{entry.content}</p>
                    </div>
                  ))}
                  <label style={field}>
                    <span style={fieldLabel}>{t('community.replySend')}</span>
                    <textarea
                      style={{ ...textarea, minHeight: 72 }}
                      value={replyText}
                      placeholder={t('community.replyPlaceholder')}
                      onChange={(event) => { setReplyText(event.currentTarget.value) }}
                    />
                  </label>
                  <ErrorLine text={validation} />
                  <ErrorLine text={reply.error === null ? null : t('community.replyFailed')} />
                  <div style={inlineRow}>
                    <button type="button" style={dangerButton} disabled={reply.busy} onClick={sendReply}>
                      {reply.busy ? t('common.saving') : t('community.replySend')}
                    </button>
                    <button
                      type="button"
                      style={button}
                      disabled={ai.busy}
                      onClick={() => { setAi((current) => ({ ...current, open: !current.open })) }}
                    >
                      {t('community.aiReply')}
                    </button>
                  </div>
                  {ai.open ? (
                    <div style={stack}>
                      <label style={field}>
                        <span style={fieldLabel}>{t('community.aiRequirements')}</span>
                        <textarea
                          style={{ ...textarea, minHeight: 56 }}
                          value={ai.requirements}
                          placeholder={t('community.aiRequirementsPlaceholder')}
                          onChange={(event) => { setAi((current) => ({ ...current, requirements: event.currentTarget.value })) }}
                        />
                      </label>
                      <div style={inlineRow}>
                        <button type="button" style={button} onClick={() => { setAi((current) => ({ ...current, requirements: t('community.aiSuggest.summary') })) }}>
                          {t('community.aiSuggest.summary')}
                        </button>
                        <button type="button" style={button} onClick={() => { setAi((current) => ({ ...current, requirements: t('community.aiSuggest.tech') })) }}>
                          {t('community.aiSuggest.tech')}
                        </button>
                        <button type="button" style={button} onClick={() => { setAi((current) => ({ ...current, requirements: t('community.aiSuggest.more') })) }}>
                          {t('community.aiSuggest.more')}
                        </button>
                      </div>
                      <div style={inlineRow}>
                        <button type="button" style={primaryButton} disabled={ai.busy} onClick={generateAiReply}>
                          {ai.busy ? t('community.aiGenerating') : t('community.aiGenerate')}
                        </button>
                      </div>
                      <ErrorLine text={ai.error === null ? null : (containsCjk(ai.error) ? t('community.loadFailed') : ai.error)} />
                      {ai.phase === 'opened' ? <p style={{ ...mutedText, margin: 0 }}>{t('community.aiOpened')}</p> : null}
                      {ai.phase === 'fallback' ? (
                        <div style={stack}>
                          <p style={{ ...mutedText, margin: 0 }}>{t('community.aiFallback')}</p>
                          <textarea style={{ ...textarea, minHeight: 120 }} value={ai.prompt} readOnly onChange={() => undefined} />
                          <CopyButton text={ai.prompt} label={t('community.aiCopy')} />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </Card>
            {embedPath === null || activeHost === undefined ? null : (
              <div>
                <div style={inlineRow}>
                  <span style={mutedText}>{t('community.embeddedTitle')}</span>
                  <button type="button" style={button} onClick={() => { setEmbedPath(null) }}>{t('common.close')}</button>
                </div>
                <EmbeddedHydro
                  hostId={activeHost.id}
                  path={embedPath}
                  title={t('community.embeddedTitle')}
                  sessionKey={activeSiteAccount.id}
                  initialPath={`/d/${encodeURIComponent(feedDomain)}/discuss`}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    </SiteSessionGate>
  )
}

/** Shared clickable discussion row style. */
const accountRowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 3,
  padding: '6px 10px',
  border: `1px solid ${colors.border}`,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left' as const,
  font: 'inherit',
  cursor: 'pointer',
}
