/**
 * Nix maintenance page: Node/go-judge versions and mirror control.
 */
import { useEffect, useState } from 'react'
import type { PackageListResponse } from '../../shared/api.js'
import type { OperationResult } from '../../shared/types.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { formatTime } from '../format.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  button,
  card,
  colors,
  compactInput,
  details,
  errorBadge,
  field,
  fieldLabel,
  grid,
  inlineRow,
  metricGrid,
  metricLabel,
  metricValue,
  mutedText,
  okBadge,
  page,
  primaryButton,
  stack,
  time,
} from '../styles.js'
import { Card, ErrorLine, PageHeading, LogBlock } from '../ui.js'
import { NeedHost } from './OpsPages.js'

/** Mirror presets accepted by the Host's `set-mirror` action. */
const MIRROR_OFFICIAL = 'https://cache.nixos.org/'
const MIRROR_CN = 'https://cache.nixos.org/ https://nix.hydro.ac/cache'
const MIRROR_USTC = 'https://mirrors.ustc.edu.cn/nix-channels/store'
const MIRROR_TUNA = 'https://mirrors.tuna.tsinghua.edu.cn/nix-channels/store'

/** Selected mirror mode. */
type MirrorMode = 'official' | 'cn' | 'ustc' | 'tuna' | 'custom'

/**
 * Render the Nix maintenance page.
 * @returns the page element.
 */
export function NixPage() {
  const { t, locale } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const packages = useAsyncTask<PackageListResponse>(t)
  const nix = useAsyncTask<OperationResult>(t)
  const [mirror, setMirror] = useState('')
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>('official')
  const [validation, setValidation] = useState<string | null>(null)
  const [pending, setPending] = useState<'mirror' | 'nodejs' | 'go-judge' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  const load = (): void => {
    if (hostId === null) return
    void packages.run((signal) => hydroApi.hostPackages(hostId, signal))
  }

  useEffect(() => {
    load()
    // Reload only when the active host changes.
  }, [hostId])

  useEffect(() => {
    if (packages.data === null) return
    const current = packages.data.nix?.substituters ?? ''
    setMirror(current)
    if (current === MIRROR_OFFICIAL) setMirrorMode('official')
    else if (current === MIRROR_CN) setMirrorMode('cn')
    else if (current === MIRROR_USTC) setMirrorMode('ustc')
    else if (current === MIRROR_TUNA) setMirrorMode('tuna')
    else setMirrorMode('custom')
  }, [packages.data])

  if (activeHost === undefined) return <NeedHost />

  const runNix = (label: string, payload: { action: 'set-mirror'; mirror: string } | { action: 'upgrade-package'; package: 'nodejs' | 'go-judge' }): void => {
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('nix.confirm') }))) return
      setNotice(null)
      setPending(payload.action === 'set-mirror' ? 'mirror' : payload.package)
      const result = await nix.run((signal) => hydroApi.hostNix(hostId as string, { ...payload, confirm: true }, signal))
      if (result !== null) setNotice(result.ok ? label : t('packages.nixPackageFailed'))
      setPending(null)
    })()
  }

  const applyMirror = (): void => {
    const value = mirrorMode === 'official' ? MIRROR_OFFICIAL
      : mirrorMode === 'cn' ? MIRROR_CN
        : mirrorMode === 'ustc' ? MIRROR_USTC
          : mirrorMode === 'tuna' ? MIRROR_TUNA
            : mirror.trim()
    if (value === '') { setValidation(t('packages.mirrorRequired')); return }
    setValidation(null)
    runNix(t('packages.mirrorApplied'), { action: 'set-mirror', mirror: value })
  }

  const pickMirrorMode = (next: MirrorMode): void => {
    setMirrorMode(next)
    if (next === 'official') setMirror(MIRROR_OFFICIAL)
    else if (next === 'cn') setMirror(MIRROR_CN)
    else if (next === 'ustc') setMirror(MIRROR_USTC)
    else if (next === 'tuna') setMirror(MIRROR_TUNA)
  }

  const data = packages.data
  return (
    <div style={page}>
      <PageHeading
        title={t('menu.nix')}
        hint={t('nix.hint')}
        actions={(
          <button type="button" style={button} disabled={packages.busy} onClick={load}>
            {packages.busy ? t('panel.refreshing') : t('nix.refresh')}
          </button>
        )}
      />
      <ErrorLine text={packages.error === null ? null : t('packages.loadFailed', { message: packages.error })} />
      {data === null ? (
        <Card><p style={{ ...mutedText, margin: 0 }}>{packages.busy ? t('metrics.collecting') : t('nix.unavailable')}</p></Card>
      ) : (
        <>
          <div style={metricGrid}>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={metricLabel}>{t('nix.nodeTitle')}</span>
              <span style={{ ...metricValue, fontSize: 14, fontWeight: 600 }}>{data.node?.version ?? t('common.none')}</span>
              <span style={time}>{data.node?.latest === null || data.node?.latest === undefined ? '' : t('nix.latest', { version: data.node.latest })}</span>
              {data.node?.managedByNix === true ? <span style={okBadge}>{t('packages.managedByNix')}</span> : <span style={errorBadge}>{t('packages.notManagedByNix')}</span>}
            </div>
            <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={metricLabel}>{t('nix.goJudgeTitle')}</span>
              <span style={{ ...metricValue, fontSize: 14, fontWeight: 600 }}>{data.goJudge?.version ?? t('common.none')}</span>
              {data.goJudge?.managedByNix === true ? <span style={okBadge}>{t('packages.managedByNix')}</span> : <span style={errorBadge}>{t('packages.notManagedByNix')}</span>}
            </div>
          </div>

          <Card title={t('nix.mirrorTitle')} hint={t('nix.mirrorHint')}>
            <p style={{ ...mutedText, margin: 0 }}>{t('nix.hydroSourceFixed')}</p>
            <div style={stack}>
              <label style={field}>
                <span style={fieldLabel}>{t('packages.nixMirror')}</span>
                <select
                  style={compactInput}
                  value={mirrorMode}
                  onChange={(event) => { pickMirrorMode(event.currentTarget.value as MirrorMode) }}
                >
                  <option value="official">{t('nix.mirrorOfficial')}</option>
                  <option value="cn">{t('nix.mirrorCn')}</option>
                  <option value="ustc">{t('nix.mirrorUstc')}</option>
                  <option value="tuna">{t('nix.mirrorTuna')}</option>
                  <option value="custom">{t('nix.mirrorCustom')}</option>
                </select>
              </label>
              {mirrorMode === 'custom' ? (
                <label style={field}>
                  <span style={fieldLabel}>{t('nix.mirrorCustom')}</span>
                  <input
                    style={compactInput}
                    value={mirror}
                    placeholder={t('packages.mirrorPlaceholder')}
                    onChange={(event) => { setMirror(event.currentTarget.value) }}
                  />
                </label>
              ) : null}
              <ErrorLine text={validation} />
              <div style={inlineRow}>
                <button type="button" style={primaryButton} disabled={nix.busy} onClick={applyMirror}>
                  {pending === 'mirror' ? t('packages.applyingMirror') : t('packages.applyMirror')}
                </button>
                <button
                  type="button"
                  style={button}
                  disabled={nix.busy}
                  onClick={() => { runNix(t('packages.nixPackageDone'), { action: 'upgrade-package', package: 'nodejs' }) }}
                >
                  {pending === 'nodejs' ? t('packages.applyingMirror') : t('packages.nixNode')}
                </button>
                <button
                  type="button"
                  style={button}
                  disabled={nix.busy}
                  onClick={() => { runNix(t('packages.nixPackageDone'), { action: 'upgrade-package', package: 'go-judge' }) }}
                >
                  {pending === 'go-judge' ? t('packages.applyingMirror') : t('packages.nixGoJudge')}
                </button>
              </div>
              <ErrorLine text={nix.error} />
              {notice === null ? null : (
                <p style={{ margin: 0, color: nix.data?.ok === true ? colors.success : colors.danger }}>{notice}</p>
              )}
              {nix.data === null ? null : (
                <details style={details}>
                  <summary style={{ ...time, cursor: 'pointer' }}>{t('packages.mirrorOutput')}</summary>
                  {nix.data.message === '' ? null : <p style={{ margin: 0 }}>{nix.data.message}</p>}
                  {nix.data.log === undefined || nix.data.log === '' ? null : <LogBlock text={nix.data.log} />}
                </details>
              )}
            </div>
          </Card>
          <div style={grid}>
            <span style={time}>{data.nix?.substituters === undefined ? '' : `${t('packages.nix')}: ${data.nix.substituters}`}</span>
            <span style={time}>{t('metrics.updatedAt', { time: formatTime(data.collectedAt, locale, t) })}</span>
          </div>
        </>
      )}
    </div>
  )
}
