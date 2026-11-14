/**
 * Embedded real Hydro page (iframe) for the console site pages.
 *
 * Resolves a browser-reachable Hydro URL from the Host (`hosts/address`), then
 * renders `<iframe src={url + path}>` with a loading state, an "open in a new
 * tab" link, and a friendly setup hint when no URL is configured.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { HostAddressResponse } from '../shared/api.js'
import { hydroApi } from './api.js'
import { useAsyncTask } from './hooks.js'
import { useI18n } from './i18n.js'
import {
  button,
  colors,
  frame,
  inlineRow,
  mutedText,
  time,
} from './styles.js'
import { Card, EmptyState, ErrorLine } from './ui.js'
import { openSidebarBrowser, sidebarBrowserAvailable } from './workspace.js'

/** Join a base URL and an absolute path without doubling slashes. */
function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return path.startsWith('/') ? `${trimmed}${path}` : `${trimmed}/${path}`
}

/** Props of {@link EmbeddedHydro}. */
export interface EmbeddedHydroProps {
  /** Active SSH host id (null when none is selected). */
  hostId: string | null
  /** Hydro path, e.g. `/d/system/p`. */
  path: string
  /** Localized page title (iframe title + card heading). */
  title: string
  /** Optional header actions (AI buttons, domain pickers, ...). */
  actions?: ReactNode
  /** Extra links rendered next to "open in a new tab" (path is appended to the URL). */
  links?: Array<{ label: string; path: string }>
  /** Changes when the selected site account changes; remounts the iframe. */
  sessionKey?: string
  /** Initial path of this feature page; the reset button returns here. */
  initialPath?: string
  /** Called when the user asks to refresh; lets the page refresh proxy context too. */
  onRefresh?: () => void
}

/**
 * Render the embedded Hydro page.
 * @param props - host, path, title and optional actions.
 * @returns the card element.
 */
export function EmbeddedHydro({ hostId, path, title, actions, links = [], sessionKey, initialPath = '/', onRefresh }: EmbeddedHydroProps) {
  const { t } = useI18n()
  const address = useAsyncTask<HostAddressResponse>(t)
  const [manualUrl, setManualUrl] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    if (hostId === null) return
    void address.run((signal) => hydroApi.hostAddress(hostId, signal))
    // Re-resolve when the site account changes so the proxy seeds its SID.
  }, [hostId, sessionKey])

  const rawUrl = address.data?.url ?? null
  const base = rawUrl === null || rawUrl.trim() === '' ? null : rawUrl
  const url = base === null ? null : joinUrl(base, path)
  const initialUrl = base === null ? null : joinUrl(base, initialPath)
  const iframeUrl = manualUrl ?? url
  const sidebarBrowser = sidebarBrowserAvailable()

  useEffect(() => {
    setManualUrl(null)
  }, [url, sessionKey])

  const refresh = (): void => {
    setReloadNonce((current) => current + 1)
    onRefresh?.()
  }

  return (
    <Card title={title} actions={actions}>
      <ErrorLine text={address.error} />
      {address.busy && address.data === null ? <p style={{ ...mutedText, margin: 0 }}>{t('embed.loading')}</p> : null}
      {!address.busy && address.error === null && url === null ? (
        <div>
          <EmptyState
            message={t('embed.noUrl')}
            actionLabel={t('embed.retry')}
            onAction={() => { void address.run((signal) => hydroApi.hostAddress(hostId as string, signal)) }}
          />
        </div>
      ) : null}
      {url === null ? null : (
        <>
          <div style={inlineRow}>
            <button type="button" style={button} onClick={refresh}>{t('embed.refresh')}</button>
            {initialUrl === null ? null : (
              <button
                type="button"
                style={button}
                title={t('embed.initialPageTitle')}
                onClick={() => {
                  setManualUrl(initialUrl)
                  setReloadNonce((current) => current + 1)
                  onRefresh?.()
                }}
              >
                {t('embed.initialPage')}
              </button>
            )}
            {sidebarBrowser ? (
              <button
                type="button"
                style={button}
                onClick={() => { openSidebarBrowser(url) }}
                title={t('embed.sidebarHint')}
              >
                {t('embed.openSidebar')}
              </button>
            ) : null}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ ...button, fontSize: 11, color: colors.muted, textDecoration: 'none' }}
            >
              {t('embed.openFallback')}
            </a>
            {links.map((link) => (
              <a
                key={link.path}
                href={joinUrl(address.data?.url ?? '', link.path)}
                target="_blank"
                rel="noreferrer"
                style={{ ...button, textDecoration: 'none' }}
              >
                {link.label}
              </a>
            ))}
            <span style={time}>
              {address.data?.source === 'proxy'
                ? t('embed.source.proxy')
                : address.data?.source === 'server.url'
                  ? t('embed.source.serverUrl')
                  : address.data?.source === 'detected'
                    ? t('embed.source.detected')
                    : t('embed.source', { source: address.data?.source ?? 'detected' })}
            </span>
          </div>
          <iframe
            key={`${iframeUrl}:${String(reloadNonce)}:${sessionKey ?? ''}`}
            title={t('embed.frameTitle', { title })}
            src={iframeUrl ?? url}
            style={frame}
            loading="lazy"
            onLoad={() => { onRefresh?.() }}
          />
        </>
      )}
    </Card>
  )
}
