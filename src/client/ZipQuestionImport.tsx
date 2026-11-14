/**
 * Hydro problem-package ZIP import (primary question-import path).
 *
 * Reads the ZIP into base64 in the browser, previews name/size, then posts it
 * to `site/questions/import-zip`. Hidden/problem-prefix options are
 * collapsed under advanced; errors stay localized.
 */
import { useRef, useState } from 'react'
import type { QuestionZipImportResponse } from '../shared/api.js'
import { containsCjk } from './format.js'
import { useConsole } from './console-context.js'
import { useI18n } from './i18n.js'
import { hydroApi } from './api.js'
import { formatBytes } from './format.js'
import { useAsyncTask } from './hooks.js'
import {
  checkboxRow,
  colors,
  compactInput,
  detailText,
  details,
  field,
  fieldLabel,
  input,
  mutedText,
  primaryButton,
  stack,
  time,
} from './styles.js'
import { SessionNotice } from './SessionNotice.js'
import { ErrorLine } from './ui.js'

/** Read a File as base64 without the data-URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : '')
    }
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')) }
    reader.readAsDataURL(file)
  })
}

/** Props of {@link ZipQuestionImport}. */
export interface ZipQuestionImportProps {
  /** Hydro site-account id. */
  siteAccountId: string
}

/**
 * Render the ZIP import card body.
 * @param props - site account and readonly flag.
 * @returns the controls element.
 */
export function ZipQuestionImport({ siteAccountId }: ZipQuestionImportProps) {
  const { t } = useI18n()
  const { requestWrites, requestConfirm } = useConsole()
  const task = useAsyncTask<QuestionZipImportResponse>(t)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [hidden, setHidden] = useState(false)
  const [preferredPrefix, setPreferredPrefix] = useState('')
  const [validation, setValidation] = useState<string | null>(null)

  const choose = (next: File | undefined): void => {
    setFile(next ?? null)
    setValidation(null)
  }

  const submit = (): void => {
    if (file === null) { setValidation(t('qzip.noFile')); return }
    void (async () => {
    if (!(await requestWrites())) return
    const confirmed = await requestConfirm({ title: t('qzip.confirm', { name: file.name }) })
    if (!confirmed) return
    setValidation(null)
    void readBase64(file).then((data) => {
      const trimmedPrefix = preferredPrefix.trim()
      return task.run((signal) => hydroApi.importQuestionsZip({
        siteAccountId,
        filename: file.name,
        data,
        ...(hidden ? { hidden: true } : {}),
        ...(trimmedPrefix === '' ? {} : { preferredPrefix: trimmedPrefix }),
      }, signal))
    }, (cause: unknown) => {
      setValidation(t('qzip.readError', { message: cause instanceof Error ? cause.message : String(cause) }))
    })
    })()
  }

  const result = task.data
  return (
    <div style={stack}>
      <label style={field}>
        <span style={fieldLabel}>{t('qzip.file')}</span>
        <input
          ref={fileInput}
          style={input}
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => { choose(event.currentTarget.files?.[0]) }}
        />
      </label>
      {file === null ? <p style={{ ...mutedText, margin: 0 }}>{t('qzip.choose')}</p> : (
        <p style={{ margin: 0 }}>{t('qzip.filename', { name: file.name, size: formatBytes(file.size) ?? t('common.none') })}</p>
      )}
      <p style={{ ...mutedText, margin: 0 }}>{t('qzip.zipHint')}</p>

      <label style={checkboxRow}>
        <input type="checkbox" checked={hidden} onChange={(event) => { setHidden(event.currentTarget.checked) }} />
        {t('qzip.hidden')}
      </label>
      <label style={field}>
        <span style={fieldLabel}>{t('qzip.preferredPrefix')}</span>
        <input
          style={compactInput}
          value={preferredPrefix}
          placeholder={t('qzip.preferredPrefixPlaceholder')}
          onChange={(event) => { setPreferredPrefix(event.currentTarget.value) }}
        />
      </label>

      <ErrorLine text={validation} />
      <ErrorLine text={task.error} />
      <SessionNotice error={task.error} />
      {result === null ? null : result.ok ? (
        <p style={{ ...mutedText, margin: 0 }}>{t('qzip.success')}</p>
      ) : (
        <div>
          <p style={{ margin: 0, color: colors.danger }}>{t('qzip.failed')}</p>
          {result.message === '' || containsCjk(result.message) ? null : (
            <details style={details}>
              <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
              <p style={detailText}>{result.message}</p>
            </details>
          )}
        </div>
      )}

      <div>
        <button type="button" style={primaryButton} disabled={task.busy || file === null} onClick={submit}>
          {task.busy ? t('qzip.importing') : t('qzip.import')}
        </button>
      </div>
    </div>
  )
}
