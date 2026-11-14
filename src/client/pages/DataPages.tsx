/**
 * 数据 and 日志 pages: read-only Mongo browsing plus a visual audit-log view.
 *
 * Collections are a table (name/count/size) that links into the query form;
 * documents render as a table when their shape is flat and fall back to JSON.
 * The audit log renders as a compact timeline table with category-colored type
 * badges, expandable args and client-side localization of the Host note.
 */
import { useEffect, useState } from 'react'
import type { HostDataResponse, HostDatabaseStatusResponse } from '../../shared/api.js'
import { hydroApi } from '../api.js'
import { useConsole } from '../console-context.js'
import { asRecord, cellText, formatBytes, formatTime, isFlatRecord } from '../format.js'
import { useAsyncTask } from '../hooks.js'
import { useI18n } from '../i18n.js'
import type { TranslateFn } from '../locales.js'
import {
  badge,
  button,
  card,
  clickableRow,
  colors,
  compactInput,
  detailText,
  details,
  field,
  fieldLabel,
  filterBar,
  inlineRow,
  mutedText,
  page,
  pre,
  primaryButton,
  select,
  stack,
  table,
  tableCell,
  tableHeadCell,
  textarea,
  time,
} from '../styles.js'
import { Badge, Card, EmptyState, ErrorLine, JsonBlock, PageHeading } from '../ui.js'
import { NeedHost } from './OpsPages.js'

/** CJK guard for raw backend notes (kept out of primary copy). */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** One collection row. */
interface CollectionRow {
  name: string
  count: number | null
  sizeBytes: number | null
}

/** Narrow collection documents from the Host payload. */
function collectionRows(documents: unknown[]): CollectionRow[] {
  const rows: CollectionRow[] = []
  for (const document of documents) {
    const record = asRecord(document)
    if (record === null || typeof record.name !== 'string') continue
    rows.push({
      name: record.name,
      count: typeof record.count === 'number' ? record.count : null,
      sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
    })
  }
  return rows
}

/** Render query documents as a table when flat, JSON otherwise. */
function DocumentsView({ documents }: { documents: unknown[] }) {
  const { t } = useI18n()
  if (documents.length === 0) return <p style={{ ...mutedText, margin: 0 }}>{t('data.noDocs')}</p>
  const records = documents.map((document) => asRecord(document))
  const flat = records.every((record) => record !== null && isFlatRecord(record))
  if (!flat) return <pre style={pre}>{JSON.stringify(documents, null, 2)}</pre>
  const keys: string[] = []
  for (const record of records) {
    for (const key of Object.keys(record as Record<string, unknown>)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            {keys.map((key) => <th key={key} style={tableHeadCell}>{key}</th>)}
          </tr>
        </thead>
        <tbody>
          {records.map((record, index) => (
            <tr key={String(index)}>
              {keys.map((key) => {
                const text = cellText((record as Record<string, unknown>)[key])
                return <td key={key} style={tableCell}>{text.length > 200 ? `${text.slice(0, 200)}…` : text}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Data page: collections table plus document query.
 */
export function DataPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useI18n()
  const { activeHost } = useConsole()
  const collections = useAsyncTask<HostDataResponse>(t)
  const find = useAsyncTask<HostDataResponse>(t)
  const [collection, setCollection] = useState('')
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState('20')
  const [validation, setValidation] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  const loadCollections = (): void => {
    if (hostId === null) return
    void collections.run((signal) => hydroApi.hostData(hostId, { action: 'collections' }, signal))
  }

  useEffect(() => {
    loadCollections()
    // Reload only when the active host changes.
  }, [hostId])

  if (activeHost === undefined) return <NeedHost />

  const runFind = (name?: string): void => {
    const target = (name ?? collection).trim()
    if (target === '') { setValidation(t('hosts.data.errCollection')); return }
    const parsedLimit = Number(limit)
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      setValidation(t('hosts.data.errLimit'))
      return
    }
    let parsedFilter: Record<string, unknown> | undefined
    const raw = filter.trim()
    if (raw !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setValidation(t('hosts.data.errFilter'))
          return
        }
        parsedFilter = parsed as Record<string, unknown>
      } catch {
        setValidation(t('hosts.data.errFilter'))
        return
      }
    }
    setValidation(null)
    void find.run((signal) => hydroApi.hostData(hostId as string, {
      action: 'find',
      collection: target,
      limit: parsedLimit,
      ...(parsedFilter === undefined ? {} : { filter: parsedFilter }),
    }, signal))
  }

  const rows = collectionRows(collections.data?.documents ?? [])
  const found = find.data

  return (
    <div style={page}>
      {embedded ? null : (
        <PageHeading
          title={t('menu.database')}
          hint={t('data.hint')}
          actions={(
            <button type="button" style={button} disabled={collections.busy} onClick={loadCollections}>
              {collections.busy ? t('panel.refreshing') : t('panel.refresh')}
            </button>
          )}
        />
      )}

      <Card
        title={t('hosts.data.collections')}
        hint={t('data.collectionsHint')}
        actions={(
          <button type="button" style={button} disabled={collections.busy} onClick={loadCollections}>
            {collections.busy ? t('panel.refreshing') : t('panel.refresh')}
          </button>
        )}
      >
        <ErrorLine text={collections.error} />
        {collections.data === null ? null : rows.length === 0 ? (
          <p style={{ ...mutedText, margin: 0 }}>{t('data.noDocs')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={tableHeadCell}>{t('data.name')}</th>
                  <th style={tableHeadCell}>{t('data.count')}</th>
                  <th style={tableHeadCell}>{t('data.size')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.name}
                    style={clickableRow}
                    onClick={() => {
                      setCollection(row.name)
                      runFind(row.name)
                    }}
                  >
                    <td style={tableCell}><span style={{ fontWeight: 600 }}>{row.name}</span></td>
                    <td style={tableCell}>{row.count === null ? t('common.none') : String(row.count)}</td>
                    <td style={tableCell}>{formatBytes(row.sizeBytes) ?? t('common.none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t('hosts.data.find')}>
        <div style={stack}>
          <div style={filterBar}>
            <label style={field}>
              <span style={fieldLabel}>{t('hosts.data.collection')}</span>
              <input
                style={compactInput}
                value={collection}
                placeholder={t('hosts.data.collectionPlaceholder')}
                onChange={(event) => { setCollection(event.currentTarget.value) }}
              />
            </label>
            <label style={field}>
              <span style={fieldLabel}>{t('hosts.data.limit')}</span>
              <input
                style={compactInput}
                value={limit}
                inputMode="numeric"
                onChange={(event) => { setLimit(event.currentTarget.value) }}
              />
            </label>
            <button type="button" style={primaryButton} disabled={find.busy} onClick={() => { runFind() }}>
              {find.busy ? t('hosts.data.running') : t('hosts.data.run')}
            </button>
          </div>
          <label style={field}>
            <span style={fieldLabel}>{t('hosts.data.filter')}</span>
            <textarea
              style={textarea}
              value={filter}
              placeholder={t('data.filterPlaceholder')}
              onChange={(event) => { setFilter(event.currentTarget.value) }}
            />
          </label>
          <ErrorLine text={validation} />
          <ErrorLine text={find.error} />
          {found === null ? null : (
            <div style={stack}>
              <div style={inlineRow}>
                <Badge>{t('data.docs', { count: found.documents.length })}</Badge>
                {found.collection === null ? null : <span style={time}>{found.collection}</span>}
                {found.truncated ? <span style={{ ...badge, borderColor: colors.warning, color: colors.warning }}>{t('hosts.data.truncated')}</span> : null}
              </div>
              <DocumentsView documents={found.documents} />
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

/** One audit-log entry shape rendered by the oplog table. */
interface OplogRow {
  id: string
  type: string
  time: string
  operator: number | null
  domainId: string | null
  path: string | null
  ip: string | null
  args: unknown
}

/** Narrow one oplog document. */
function oplogRow(value: unknown): OplogRow | null {
  const record = asRecord(value)
  if (record === null) return null
  return {
    id: typeof record.id === 'string' ? record.id : '',
    type: typeof record.type === 'string' ? record.type : '',
    time: typeof record.time === 'string' ? record.time : '',
    operator: typeof record.operator === 'number' ? record.operator : null,
    domainId: typeof record.domainId === 'string' ? record.domainId : null,
    path: typeof record.path === 'string' ? record.path : null,
    ip: typeof record.ip === 'string' ? record.ip : null,
    args: record.args,
  }
}

/** Location of an audit-log type in the operator-facing categories. */
type OplogCategory = 'problem' | 'contest' | 'user' | 'system' | 'other'

/** Classify an audit-log type like `problem.edit` / `user.login`. */
function oplogCategory(type: string): OplogCategory {
  const area = type.split('.')[0] ?? ''
  if (area === 'problem') return 'problem'
  if (area === 'contest') return 'contest'
  if (area === 'user') return 'user'
  if (area === 'system' || area === 'domain' || area === 'setting') return 'system'
  return 'other'
}

/** Category color for the type badge. */
function categoryColor(category: OplogCategory): string {
  if (category === 'problem') return colors.info
  if (category === 'contest') return colors.accent
  if (category === 'user') return colors.success
  if (category === 'system') return colors.warning
  return colors.muted
}

/** Localize a backend oplog note, keeping raw text only behind details. */
function localizeOplogNote(note: string | null, t: TranslateFn): { title: string | null; raw: string | null } {
  if (note === null || note.trim() === '') return { title: null, raw: null }
  // Patterns match the Host's Chinese note shapes without putting CJK copy in
  // this module (the guard forbids hard-coded CJK outside the dictionaries).
  if (/\u6ca1\u6709\u5339\u914d|no matching/i.test(note)) return { title: t('oplog.note.empty'), raw: null }
  if (/oplog|\u5355\u673a|standalone/i.test(note)) return { title: t('oplog.note.standalone'), raw: null }
  if (/\u65e0\u6cd5\u8fde\u63a5/.test(note)) return { title: t('oplog.note.connectFailed'), raw: CJK.test(note) ? null : note }
  if (/\u5931\u8d25|failed|error/i.test(note)) return { title: t('oplog.note.readFailed'), raw: CJK.test(note) ? null : note }
  return { title: t('oplog.note.generic'), raw: CJK.test(note) ? null : note }
}

/**
 * Oplog page: audit-log/oplog timeline with filters.
 */
export function OplogPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, locale } = useI18n()
  const { activeHost } = useConsole()
  const task = useAsyncTask<HostDataResponse>(t)
  const [source, setSource] = useState<'auto' | 'hydro' | 'mongo'>('auto')
  const [type, setType] = useState('')
  const [contains, setContains] = useState('')
  const [limit, setLimit] = useState('20')
  const [validation, setValidation] = useState<string | null>(null)
  const hostId = activeHost?.id ?? null

  const run = (): void => {
    if (hostId === null) return
    const parsedLimit = Number(limit)
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
      setValidation(t('hosts.data.errLimit'))
      return
    }
    setValidation(null)
    const trimmedType = type.trim()
    const trimmedContains = contains.trim()
    void task.run((signal) => hydroApi.hostData(hostId, {
      action: 'oplog',
      source,
      limit: parsedLimit,
      ...(trimmedType === '' ? {} : { type: trimmedType }),
      ...(trimmedContains === '' ? {} : { contains: trimmedContains }),
    }, signal))
  }

  useEffect(() => {
    run()
    // Load the first page when the active host changes.
  }, [hostId])

  if (activeHost === undefined) return <NeedHost />

  const data = task.data
  const rows = (data?.documents ?? []).map(oplogRow).filter((row): row is OplogRow => row !== null)
  const note = localizeOplogNote(data?.note ?? null, t)
  const mongo = asRecord(data?.mongoOplog)
  const mongoAvailable = mongo !== null && mongo.available === true

  return (
    <div style={page}>
      {embedded ? null : (
        <PageHeading
          title={t('menu.oplog')}
          hint={t('oplog.hint')}
          actions={(
            <button type="button" style={button} disabled={task.busy} onClick={run}>
              {task.busy ? t('panel.refreshing') : t('panel.refresh')}
            </button>
          )}
        />
      )}

      <Card
        actions={(
          <button type="button" style={button} disabled={task.busy} onClick={run}>
            {task.busy ? t('panel.refreshing') : t('panel.refresh')}
          </button>
        )}
      >
        <div style={filterBar}>
          <label style={field}>
            <span style={fieldLabel}>{t('hosts.data.source')}</span>
            <select style={select} value={source} onChange={(event) => { setSource(event.currentTarget.value === 'hydro' ? 'hydro' : event.currentTarget.value === 'mongo' ? 'mongo' : 'auto') }}>
              <option value="auto">{t('hosts.data.source.auto')}</option>
              <option value="hydro">{t('hosts.data.source.hydro')}</option>
              <option value="mongo">{t('hosts.data.source.mongo')}</option>
            </select>
          </label>
          <label style={field}>
            <span style={fieldLabel}>{t('oplog.type')}</span>
            <input
              style={compactInput}
              value={type}
              placeholder={t('oplog.typePlaceholder')}
              onChange={(event) => { setType(event.currentTarget.value) }}
            />
          </label>
          <label style={field}>
            <span style={fieldLabel}>{t('oplog.contains')}</span>
            <input
              style={compactInput}
              value={contains}
              placeholder={t('oplog.containsPlaceholder')}
              onChange={(event) => { setContains(event.currentTarget.value) }}
            />
          </label>
          <label style={field}>
            <span style={fieldLabel}>{t('hosts.data.limit')}</span>
            <input
              style={compactInput}
              value={limit}
              inputMode="numeric"
              onChange={(event) => { setLimit(event.currentTarget.value) }}
            />
          </label>
        </div>
        <ErrorLine text={validation} />
        <ErrorLine text={task.error} />
      </Card>

      {data === null ? null : (
        <Card>
          <div style={stack}>
            <div style={inlineRow}>
              <Badge>{t('oplog.docs', { count: rows.length })}</Badge>
              {data.truncated ? <span style={{ ...badge, borderColor: colors.warning, color: colors.warning }}>{t('hosts.data.truncated')}</span> : null}
              {mongo === null ? null : (
                <span style={time}>
                  {mongoAvailable
                    ? t('oplog.mongoAvailable', { size: formatBytes(typeof mongo.sizeBytes === 'number' ? mongo.sizeBytes : null) ?? t('common.none') })
                    : t('oplog.mongoUnavailable')}
                </span>
              )}
            </div>
            {note.title === null ? null : (
              <div style={{ ...card, borderColor: colors.info }}>
                <p style={{ margin: 0 }}>{note.title}</p>
                {note.raw === null ? null : (
                  <details style={details}>
                    <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
                    <p style={detailText}>{note.raw}</p>
                  </details>
                )}
              </div>
            )}
            {rows.length === 0 ? (
              <p style={{ ...mutedText, margin: 0 }}>{t('oplog.empty')}</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={tableHeadCell}>{t('oplog.time')}</th>
                      <th style={tableHeadCell}>{t('oplog.type')}</th>
                      <th style={tableHeadCell}>{t('oplog.operator')}</th>
                      <th style={tableHeadCell}>{t('oplog.domain')}</th>
                      <th style={tableHeadCell}>{t('oplog.path')}</th>
                      <th style={tableHeadCell}>{t('oplog.ip')}</th>
                      <th style={tableHeadCell}>{t('oplog.args')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const category = oplogCategory(row.type)
                      return (
                        <tr key={`${row.id}:${row.type}:${row.time}:${String(index)}`}>
                          <td style={tableCell}>{formatTime(row.time, locale, t)}</td>
                          <td style={tableCell}>
                            <span style={{ ...badge, borderColor: categoryColor(category), color: categoryColor(category) }}>
                              {row.type === '' ? t('oplog.typeOther') : row.type}
                            </span>
                          </td>
                          <td style={tableCell}>{row.operator === null ? t('common.none') : `#${String(row.operator)}`}</td>
                          <td style={tableCell}>{row.domainId ?? t('common.none')}</td>
                          <td style={tableCell}>{row.path ?? t('common.none')}</td>
                          <td style={tableCell}>{row.ip ?? t('common.none')}</td>
                          <td style={tableCell}>
                            {row.args === undefined || row.args === null ? t('common.none') : (
                              <details style={details}>
                                <summary style={{ ...time, cursor: 'pointer' }}>{t('common.details')}</summary>
                                <JsonBlock value={row.args} />
                              </details>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}


/** MongoDB workspace: data and oplog as two tabs in one page. */
export function MongoPage() {
  const { t } = useI18n()
  const { activeHost } = useConsole()
  const database = useAsyncTask<HostDatabaseStatusResponse>(t)
  const [tab, setTab] = useState<'data' | 'oplog'>('data')

  useEffect(() => {
    if (activeHost === undefined) return
    void database.run((signal) => hydroApi.hostDatabase(activeHost.id, signal))
    // Re-check when the selected host changes.
  }, [activeHost?.id])

  if (activeHost === undefined) {
    return <Card><EmptyState message={t('page.needHost')} /></Card>
  }

  if (database.data !== null && (!database.data.installed || !database.data.running)) {
    return (
      <div style={page}>
        <PageHeading title={t('menu.mongodb')} hint={t('data.installHint')} />
        <Card>
          <EmptyState message={database.data.installed ? t('data.notRunning') : t('data.notInstalled')} />
        </Card>
      </div>
    )
  }

  return (
    <div style={page}>
      <div style={stack}>
        <div role="tablist" style={{ display: 'flex', gap: 18, borderBottom: `1px solid ${colors.border}`, paddingBottom: 0 }}>
          {([
            ['data', t('menu.database')],
            ['oplog', t('menu.oplog')],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              style={{
                border: 'none',
                borderBottom: tab === key ? `2px solid ${colors.accent}` : '2px solid transparent',
                background: 'transparent',
                color: tab === key ? colors.accent : colors.muted,
                fontWeight: tab === key ? 600 : 400,
                font: 'inherit',
                fontSize: 13,
                padding: '4px 2px 8px',
                marginBottom: -1,
                cursor: 'pointer',
              }}
              onClick={() => { setTab(key) }}
            >
              {label}
            </button>
          ))}
        </div>
        <p style={{ ...mutedText, margin: 0 }}>{tab === 'data' ? t('data.hint') : t('oplog.hint')}</p>
      </div>
      <div style={tab === 'data' ? undefined : { display: 'none' }}>
        <DataPage embedded />
      </div>
      <div style={tab === 'oplog' ? undefined : { display: 'none' }}>
        <OplogPage embedded />
      </div>
    </div>
  )
}
