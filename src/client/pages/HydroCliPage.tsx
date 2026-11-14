/**
 * Hydro CLI page: run `hydrooj <args>` in the remote /data directory over the
 * CLI SSE stream, with a terminal-style output panel and backup/restore
 * shortcuts (backup + restore disabled while the global readonly switch is on).
 */
import { useEffect, useRef, useState } from 'react'
import type { BackupFile, BackupsResponse } from '../../shared/api.js'
import { containsCjk } from '../format.js'
import { formatBytes, formatTime } from '../format.js'
import { restoreHydroBackup, runHydroCli } from '../api.js'
import { useConsole } from '../console-context.js'
import { hydroApi } from '../api.js'
import { useAsyncTask, useCliStream } from '../hooks.js'
import { useI18n } from '../i18n.js'
import {
  badge,
  button,
  colors,
  compactInput,
  dangerButton,
  errorBadge,
  inlineRow,
  metricLabel,
  monospaceFont,
  mutedText,
  okBadge,
  page,
  primaryButton,
  runningBadge,
  stack,
  table,
  tableCell,
  tableHeadCell,
  terminal,
  time,
} from '../styles.js'
import { Card, CopyButton, ErrorLine, PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'

/** Shell metacharacters the CLI route refuses. */
const SHELL_META = /[;&|`$<>\n]/

/** Quick commands shown as buttons (hydrooj arguments only). */
const QUICK_COMMANDS: ReadonlyArray<{ key: 'cli.quickBackup' | 'cli.quickBackupDb' | 'cli.quickServerUrl'; command: string; write: boolean }> = [
  { key: 'cli.quickBackup', command: 'backup', write: true },
  { key: 'cli.quickBackupDb', command: 'backup --dbOnly', write: true },
  { key: 'cli.quickServerUrl', command: 'cli system get server.url', write: false },
]

/**
 * Render the Hydro CLI page.
 * @returns the page element.
 */
export function HydroCliPage() {
  const { t, locale } = useI18n()
  const { activeHost, requestWrites, requestConfirm } = useConsole()
  const cli = useCliStream(t)
  const backups = useAsyncTask<BackupsResponse>(t)
  const [command, setCommand] = useState('')
  const [validation, setValidation] = useState<string | null>(null)
  const [lastAction, setLastAction] = useState<'run' | 'restore' | null>(null)
  const hostId = activeHost?.id ?? null
  const terminalRef = useRef<HTMLPreElement | null>(null)

  const loadBackups = (): void => {
    if (hostId === null) return
    void backups.run((signal) => hydroApi.listBackups(hostId, signal))
  }

  useEffect(() => {
    loadBackups()
    // Reload only when the active host changes.
  }, [hostId])

  useEffect(() => {
    if (lastAction !== 'restore') return
    if (cli.phase === 'success' || cli.phase === 'failed') loadBackups()
    // Refresh the backup list once a restore stream settles.
  }, [cli.phase, lastAction])

  useEffect(() => {
    const node = terminalRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [cli.lines])

  if (activeHost === undefined) return <NeedHost />

  const output = cli.lines.map((line) => line.text).join('')

  const execute = (raw: string): void => {
    void (async () => {
      const trimmed = raw.trim()
      if (trimmed === '') { setValidation(t('cli.errEmpty')); return }
      if (SHELL_META.test(trimmed)) { setValidation(t('cli.errShell')); return }
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('cli.confirmRun', { command: trimmed }) }))) return
      setValidation(null)
      setCommand(trimmed)
      setLastAction('run')
      cli.start((signal, onOutput) => runHydroCli(activeHost.id, trimmed, { onOutput }, signal).then((result) => ({ result, usedFallback: false })))
    })()
  }

  const restore = (backup: BackupFile): void => {
    void (async () => {
      if (!(await requestWrites())) return
      if (!(await requestConfirm({ title: t('cli.restoreConfirm', { name: backup.name }) }))) return
      setLastAction('restore')
      setValidation(null)
      cli.start((signal, onOutput) => restoreHydroBackup(activeHost.id, backup.name, { onOutput }, signal).then((result) => ({ result, usedFallback: false })))
    })()
  }

  const rows = backups.data?.backups ?? []

  return (
    <div style={page}>
      <PageHeading title={t('menu.cli')} hint={t('cli.hint')} />

      <Card>
        <div style={stack}>
          <div style={inlineRow}>
            <span style={{ fontFamily: monospaceFont, fontSize: 12, color: colors.muted }}>{t('cli.prefix')}</span>
            <input
              style={{ ...compactInput, flex: '1 1 220px', maxWidth: 'none' }}
              value={command}
              placeholder={t('cli.commandPlaceholder')}
              spellCheck={false}
              onChange={(event) => { setCommand(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') execute(command) }}
            />
            <button type="button" style={primaryButton} disabled={cli.running} onClick={() => { execute(command) }}>
              {cli.running ? t('cli.running') : t('cli.run')}
            </button>
          </div>
          <div style={inlineRow}>
            <span style={{ ...time, marginRight: 4 }}>{t('cli.quick')}</span>
            {QUICK_COMMANDS.map((quick) => (
              <button
                key={quick.command}
                type="button"
                style={button}
                disabled={cli.running}
                onClick={() => { execute(quick.command) }}
              >
                {t(quick.key)}
              </button>
            ))}
          </div>
          <ErrorLine text={validation} />
          <div style={inlineRow}>
            {cli.running ? <span style={runningBadge}>{t('terminal.running')}</span> : null}
            {cli.phase === 'success' ? <span style={okBadge}>{t('cli.succeeded')}</span> : null}
            {cli.phase === 'failed' ? <span style={errorBadge}>{t('cli.failed')}</span> : null}
            {cli.phase === 'cancelled' ? <span style={badge}>{t('cli.cancelled')}</span> : null}
            {cli.phase === 'success' && lastAction === 'restore' ? <span style={okBadge}>{t('cli.backupDone')}</span> : null}
            {cli.result === null || cli.result.exitCode === null ? null : (
              <span style={time}>{t('cli.exitCode', { code: cli.result.exitCode })}</span>
            )}
            {output === '' ? null : <CopyButton text={output} label={t('cli.copy')} />}
            {cli.phase === 'idle' ? null : (
              <button type="button" style={button} onClick={cli.reset}>{t('cli.clear')}</button>
            )}
            {cli.running ? <button type="button" style={dangerButton} onClick={cli.cancel}>{t('cli.cancel')}</button> : null}
          </div>
          <span style={metricLabel}>{t('cli.output')}</span>
          <pre ref={terminalRef} style={terminal}>
            {cli.lines.length === 0 ? (
              cli.result !== null && cli.result.output !== ''
                ? <span>{cli.result.output}</span>
                : <span style={mutedText}>{t('cli.waiting')}</span>
            ) : null}
            {cli.lines.map((line, index) => (
              <span key={String(index)} style={line.stream === 'stderr' ? { color: colors.warning } : undefined}>{line.text}</span>
            ))}
          </pre>
          {cli.running ? <p style={{ ...mutedText, margin: 0 }}>{t('cli.cancelHint')}</p> : null}
          <ErrorLine text={cli.error !== null && cli.phase === 'failed' && !containsCjk(cli.error) ? cli.error : null} />
        </div>
      </Card>

      <Card
        title={t('cli.backups')}
        hint={t('cli.backupsHint')}
        actions={(
          <button type="button" style={button} disabled={backups.busy} onClick={loadBackups}>
            {backups.busy ? t('panel.refreshing') : t('cli.refreshBackups')}
          </button>
        )}
      >
        {backups.error === null ? null : (
          <ErrorLine text={t('cli.loadBackupsFailed')} />
        )}
        {rows.length === 0 ? (
          <p style={{ ...mutedText, margin: 0 }}>{t('cli.noBackups')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={tableHeadCell}>{t('cli.backupName')}</th>
                  <th style={tableHeadCell}>{t('cli.backupSize')}</th>
                  <th style={tableHeadCell}>{t('cli.backupTime')}</th>
                  <th style={tableHeadCell}>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((backup) => (
                  <tr key={backup.path}>
                    <td style={tableCell}><span style={{ fontFamily: monospaceFont, fontSize: 11 }}>{backup.name}</span></td>
                    <td style={tableCell}>{formatBytes(backup.sizeBytes) ?? t('common.none')}</td>
                    <td style={tableCell}>{formatTime(backup.modifiedAt, locale, t)}</td>
                    <td style={tableCell}>
                      <button type="button" style={button} disabled={cli.running} onClick={() => { restore(backup) }}>
                        {t('cli.restore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
