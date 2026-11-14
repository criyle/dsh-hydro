/**
 * The always-available Hydro operator console.
 *
 * Layout v2: a header with the top-right host/site-account switchers and the
 * global readonly toggle, a hierarchical left menu (Ops / Site / Settings)
 * and exactly one active page. `ConsoleProvider` owns the shared lists and
 * settings; `ConsoleShell` renders the switches, menu and pages.
 */
import { ConsoleProvider } from './console-context.js'
import { ConsoleShell } from './ConsoleShell.js'
import { useI18n } from './i18n.js'
import { useThemeMode } from './theme.js'
import { mutedText, panel } from './styles.js'

/**
 * Render the Hydro panel.
 * @returns the panel element.
 */
export function HydroPanel() {
  const { t } = useI18n()
  const mode = useThemeMode()
  return (
    <div style={{ ...panel, colorScheme: mode }}>
      <ConsoleProvider>
        <ConsoleShell />
      </ConsoleProvider>
      <p style={{ ...mutedText, marginTop: 'auto' }}>{t('panel.footer')}</p>
    </div>
  )
}
