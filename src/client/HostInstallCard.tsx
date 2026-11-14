/**
 * "Install Hydro" card, shown only when the last probe says Hydro is absent.
 *
 * Runs the streamed installer when the Host supports it and falls back to the
 * plain JSON route otherwise. The trigger is deliberately loud (accent card,
 * confirm dialog explaining root/nix/port 80) because the installer is
 * long-running and system-wide; judge-only / no-Caddy options stay collapsed.
 */
import { useRef, useState } from 'react'
import type { AccountSummary } from '../shared/types.js'
import { hydroApi, streamInstallHost } from './api.js'
import { useHostStream } from './hooks.js'
import { useI18n } from './i18n.js'
import { OperationTerminalCard, withStreamFallback } from './OperationTerminalCard.js'
import { checkboxRow } from './styles.js'

/** Props of {@link HostInstallCard}. */
export interface HostInstallCardProps {
  /** Host the installer runs against. */
  account: AccountSummary
  /** Global readonly mode: disables starting the installer. */
  disabled?: boolean
  /** Called after a successful install (refresh status/accounts). */
  onInstalled(): void
}

/**
 * Render the install card.
 * @param props - host account and success callback.
 * @returns the card element.
 */
export function HostInstallCard({ account, disabled = false, onInstalled }: HostInstallCardProps) {
  const { t } = useI18n()
  const stream = useHostStream(t)
  const startedHost = useRef(account.id)
  const [judge, setJudge] = useState(false)
  const [noCaddy, setNoCaddy] = useState(false)
  const [force, setForce] = useState(account.hydro?.installed === true)
  const options = {
    ...(judge ? { judge: true } : {}),
    ...(noCaddy ? { noCaddy: true } : {}),
    ...(force ? { force: true } : {}),
  }

  const start = (): void => {
    startedHost.current = account.id
    stream.start((signal, onOutput) => withStreamFallback(
      () => streamInstallHost(account.id, options, { onOutput }, signal),
      () => hydroApi.installHost(account.id, options, signal),
      signal,
    ))
  }

  return (
    <OperationTerminalCard
      title={t('hosts.install.title')}
      hint={t('hosts.install.hint')}
      startLabel={t('hosts.install.button')}
      confirmMessage={t('hosts.install.confirm', {
        label: account.label,
        username: account.username,
        host: account.host,
        port: account.port,
      })}
      disabled={disabled}
      task={stream}
      hostId={startedHost.current}
      kind="install"
      onStart={start}
      onSuccess={onInstalled}
      advanced={(
        <>
          <label style={checkboxRow}>
            <input type="checkbox" checked={judge} onChange={(event) => { setJudge(event.currentTarget.checked) }} />
            {t('hosts.install.optionJudge')}
          </label>
          <label style={checkboxRow}>
            <input type="checkbox" checked={noCaddy} onChange={(event) => { setNoCaddy(event.currentTarget.checked) }} />
            {t('hosts.install.optionNoCaddy')}
          </label>
          <label style={checkboxRow}>
            <input type="checkbox" checked={force} onChange={(event) => { setForce(event.currentTarget.checked) }} />
            {t('hosts.install.optionForce')}
          </label>
        </>
      )}
    />
  )
}
