/**
 * Offline verification of the built dsh-hydro client bundle, without DSH and
 * without a browser.
 *
 * What this checks:
 *
 * 1. `lib/client.js` executes as a classic script and calls
 *    `window.__ModuleLoader__.load({ id, factory })` with the package id.
 * 2. The artifact carries every route path from the shared contract (accounts,
 *    host operations incl. the stream/diagnose routes, content operations incl.
 *    remove/activate) into the bundle.
 * 3. `factory(require)` returns the plugin exports: `apply`, `inject`, `name`.
 * 4. Only shared-module-table specifiers are required (no externals drift).
 * 5. `apply(fakeCtx)` registers into the primary slots (`main` keyed by
 *    "hydro", `sidebar.panellist` id "hydro") when the shell declares them.
 * 6. The registered panel renders both console tabs (Hosts / Site) and the
 *    hosts loading state through `react-dom/server`; the Site tab renders
 *    its own initial (loading) state.
 * 7. With those slots absent (only `settings.section` declared) it registers
 *    the fallback card instead, and upgrades to the primary slots when they
 *    appear later; the plugin effect disposer removes every registration.
 * 8. The locale dictionaries carry the new tab/terminal/diagnose/content keys
 *    in both languages.
 * 9. The client api module speaks the shared routes/conventions for accounts,
 *    host operations (incl. diagnose), the multi-account content routes, and
 *    the POST+SSE install/upgrade streams, including the stream-unavailable
 *    fallback signal and Host `error` events.
 *
 * Run: `node test/client/verify-client.mjs`
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as jsxRuntime from 'react/jsx-runtime'
import { build as esbuild } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PACKAGE_ID = 'dsh-hydro'

/** Shared module table of DSH 0.2.2-rc.1 (must match scripts/build-client.mjs). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const results = []
function pass(name) {
  results.push(name)
  console.log(`PASS  ${name}`)
}

// ---------------------------------------------------------------------------
// 1. Execute the bundle exactly like a classic script in the page.
// ---------------------------------------------------------------------------
const artifact = await readFile(resolve(ROOT, 'lib/client.js'), 'utf8')
const firstLine = artifact.slice(0, artifact.indexOf('\n'))
assert.ok(
  firstLine.startsWith(`window.__ModuleLoader__.load({ id: "${PACKAGE_ID}", factory: (require) => {`),
  `unexpected bundle banner: ${firstLine}`,
)
assert.ok(artifact.trimEnd().endsWith('return module.exports;\n} });'), 'unexpected bundle footer')
pass('artifact: lazy-CJS banner/footer present')

// The shared ApiPaths table is compiled in (template literals around the
// prefix), so a route rename or a dropped route is visible here.
const ROUTE_MARKERS = [
  '/accounts/create',
  '/accounts/status',
  '/hosts/install',
  '/hosts/install/stream',
  '/hosts/upgrade',
  '/hosts/upgrade/stream',
  '/hosts/service',
  '/hosts/warnings',
  '/hosts/data',
  '/hosts/diagnose',
  '/site/accounts',
  '/site/save',
  '/site/remove',
  '/site/activate',
  '/site/inspect',
  '/site/domain/set',
  '/site/collection',
  '/site/authoring-prompt',
  '/hosts/services',
  '/hosts/address',
  '/hosts/plugins',
  '/community/status',
  '/community/config',
  '/community/feed',
  '/community/thread',
  '/community/reply',
  '/community/poll',
  '/hosts/logs',
  '/hosts/metrics',
  '/hosts/issues',
  '/hosts/issues/fix',
  '/hosts/packages',
  '/hosts/nix',
  '/hosts/caddy',
  '/hosts/backups',
  '/hosts/cli/stream',
  '/hosts/context',
  '/site/session',
  '/site/domains',
  '/site/questions/import-zip',
  '/settings/readonly',
  '/settings',
]
for (const marker of ROUTE_MARKERS) {
  assert.ok(artifact.includes(marker), `bundle is missing shared route marker ${marker}`)
}
assert.ok(!artifact.includes('form.sudoPassword'), 'sudo password UI must be gone')
pass('artifact: every shared route (incl. caddy/backups/cli/context + metrics/issues/packages/nix/address/domains/zip) is inlined')

let handoff
const pageWindow = { __ModuleLoader__: { load: (registration) => { handoff = registration } } }
new Function('window', 'document', artifact)(pageWindow, undefined)
assert.ok(handoff !== undefined, 'bundle did not call window.__ModuleLoader__.load')
assert.equal(handoff.id, PACKAGE_ID)
assert.equal(typeof handoff.factory, 'function')
pass('load: registers { id: "dsh-hydro", factory }')

// ---------------------------------------------------------------------------
// 2. Shared-module require stub; nothing outside the table may be requested.
// ---------------------------------------------------------------------------
const required = []
const requireFn = (specifier) => {
  required.push(specifier)
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === 'react-dom') return {}
  if (specifier === 'react-dom/client') return {}
  throw new Error(`require("${specifier}") is not answered by the stub shared module table`)
}
requireFn.asset = (reference) => reference
requireFn.async = async (specifier) => { throw new Error(`unexpected require.async(${specifier})`) }

const exports = handoff.factory(requireFn)
assert.equal(typeof exports.apply, 'function')
assert.ok(Array.isArray(exports.inject))
assert.ok(exports.inject.includes('slots'))
assert.equal(exports.name, PACKAGE_ID)
assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime'])
for (const specifier of required) assert.ok(PLATFORM_MODULES.includes(specifier))
pass('factory: returns { apply, inject: ["slots"], name }, requires only table externals')

// ---------------------------------------------------------------------------
// 3. Fake Context: a slot registry that records contributions and can delay a
//    declaration (the way `ctx.slots.inject` waits for its declaring entry).
// ---------------------------------------------------------------------------
function createFakeCtx(declaredSlots) {
  const registrations = []
  const waiters = new Map()
  let effectDispose
  const declared = new Set(declaredSlots)
  const declare = (name) => {
    declared.add(name)
    const pending = waiters.get(name) ?? []
    waiters.set(name, [])
    for (const wake of pending) wake()
  }
  const ctx = {
    effect(body, label) {
      const disposer = body()
      effectDispose = typeof disposer === 'function' ? disposer : () => {}
      return effectDispose
    },
    slots: {
      inject(key, callback) {
        if (!declared.has(key)) {
          // Real behaviour: wait for the declaration instead of throwing.
          let cleanup
          const wake = () => { cleanup = callback() }
          const pending = waiters.get(key) ?? []
          pending.push(wake)
          waiters.set(key, pending)
          return () => { cleanup?.() }
        }
        const cleanup = callback()
        return () => { cleanup?.() }
      },
      register(options, component) {
        if (!declared.has(options.name)) {
          throw new Error(`slot "${options.name}" is not declared`)
        }
        const registration = { options, component }
        registrations.push(registration)
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
  return {
    ctx,
    registrations,
    declare,
    disposeEffect: () => effectDispose?.(),
    names: () => registrations.map((registration) => registration.options.name),
  }
}

// --- 3a. Primary shell: main + sidebar.panellist declared before apply. ---
const primary = createFakeCtx(['main', 'sidebar.panellist', 'settings.section'])
exports.apply(primary.ctx)
assert.deepEqual(primary.names(), ['main', 'sidebar.panellist'])
const mainRegistration = primary.registrations.find((entry) => entry.options.name === 'main')
assert.equal(mainRegistration.options.key, 'hydro')
const sidebarRegistration = primary.registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.equal(sidebarRegistration.options.id, 'hydro')
assert.equal(sidebarRegistration.options.order, 50)
assert.equal(typeof sidebarRegistration.options.label, 'function')
pass('apply: primary surface registers main key "hydro" + sidebar.panellist id "hydro"')

// The panel component renders its initial state (hosts tab, loading) with SSR.
const markup = renderToStaticMarkup(React.createElement(mainRegistration.component))
assert.ok(markup.includes('Remote HydroOJ operator console'), 'panel markup missing localized subtitle')
for (const label of ['>Overview<', '>Server<', '>Install &amp; upgrade<', '>Plugins<', '>Hydro CLI<', '>Nix<', '>Caddy<', '>PM2<', '>MongoDB<', '>Troubleshoot<', '>Site<', '>Domains<', '>Question import<', '>Problems<', '>Contests<', '>Community<', '>Settings<', '>Hosts<', '>Site accounts<']) {
  assert.ok(markup.includes(label), `panel markup missing menu label ${label}`)
}
assert.ok(markup.includes('role="switch"'), 'panel markup missing the traditional readonly switch')
assert.ok(markup.includes('aria-checked="true"'), 'readonly must default ON before settings resolve')
assert.ok(markup.includes('>Read-only<'), 'panel markup missing the readonly switch label')
assert.ok(markup.includes('>On<'), 'panel markup missing the short readonly state text')
assert.ok(!markup.includes('>Checks<'), 'standalone system-checks page must be gone')
assert.ok(!markup.includes('>Database<') && !markup.includes('>Oplog<'), 'database/oplog must live under the MongoDB page')
assert.ok(!markup.includes('>AI authoring<'), 'standalone AI authoring page must be gone')
assert.ok(markup.includes('Manage hosts'), 'panel markup missing the manage-hosts shortcut')
assert.ok(markup.includes('No host selected yet'), 'overview page must render its no-host state')
assert.ok((markup.match(/<select/g) ?? []).length >= 2, 'panel markup must contain the host + Hydro-account switchers')
pass('render: header switches + readonly switch (default ON) + v6 component menu + overview no-host state')

// The Site tab must also render its initial (loading) state on its own.
const siteSsrDir = await mkdtemp(join(ROOT, '.tmp-verify-site-'))
try {
  const siteEntry = join(siteSsrDir, 'site-accounts-page.mjs')
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/pages/SiteAccountsPage.tsx')],
    outfile: siteEntry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    logLevel: 'silent',
  })
  const { SiteAccountsPage } = await import(siteEntry)
  const siteMarkup = renderToStaticMarkup(React.createElement(SiteAccountsPage))
  assert.ok(siteMarkup.includes('Site accounts'), 'Hydro accounts page missing its title')
  assert.ok(siteMarkup.includes('Add account'), 'Hydro accounts page missing the add action')
  assert.ok(siteMarkup.includes('Add a host under Hosts first.'), 'Hydro accounts page missing its no-host state')
  pass('render: Hydro accounts page (Settings page layout, no-host state)')
} finally {
  await rm(siteSsrDir, { recursive: true, force: true })
}

// Embedded Hydro pages render a friendly setup hint when no URL is available.
const embedDir = await mkdtemp(join(ROOT, '.tmp-verify-embed-'))
try {
  const embedEntry = join(embedDir, 'embedded.mjs')
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/EmbeddedHydro.tsx')],
    outfile: embedEntry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    logLevel: 'silent',
  })
  const { EmbeddedHydro } = await import(embedEntry)
  const embedMarkup = renderToStaticMarkup(React.createElement(EmbeddedHydro, { hostId: 'acc-1', path: '/d/system/p', title: 'Problems' }))
  assert.ok(embedMarkup.includes('Problems'), 'embedded page missing its title')
  assert.ok(embedMarkup.includes('No browser-reachable Hydro URL is configured'), 'embedded page missing the no-URL setup hint')
  pass('render: EmbeddedHydro no-URL setup hint')
} finally {
  await rm(embedDir, { recursive: true, force: true })
}

// Teardown removes everything (slot registration + waiting effects).
primary.disposeEffect()
assert.deepEqual(primary.names(), [])
pass('dispose: plugin effect removes the registrations')

// --- 3b. Minimal shell: only settings.section exists -> fallback card. ---
const fallback = createFakeCtx(['settings.section'])
exports.apply(fallback.ctx)
assert.deepEqual(fallback.names(), ['settings.section'])
pass('fallback: settings.section card when main/sidebar slots never appear')

// --- 3c. A shell that declares the primary slots later upgrades back. ---
fallback.declare('main')
assert.deepEqual(fallback.names(), ['settings.section', 'main'])
fallback.declare('sidebar.panellist')
assert.deepEqual(fallback.names(), ['main', 'sidebar.panellist'])
pass('fallback: primary slots arriving later replace the settings card')
fallback.disposeEffect()
assert.deepEqual(fallback.names(), [])
pass('fallback: teardown removes the upgraded primary surface')

// ---------------------------------------------------------------------------
// 4. Locale dictionaries carry the new keys in both languages.
// ---------------------------------------------------------------------------
const localeDir = await mkdtemp(join(tmpdir(), 'dsh-hydro-locales-'))
try {
  const localeEntry = join(localeDir, 'locales.mjs')
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/locales.ts')],
    outfile: localeEntry,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node20',
    logLevel: 'silent',
  })
  const { zh, en } = await import(localeEntry)
  const NEW_KEYS = [
    'menu.site',
    'menu.settings',
    'menu.overview',
    'menu.installUpgrade',
    'menu.server',
    'menu.plugins',
    'menu.pm2',
    'menu.mongodb',
    'menu.community',
    'menu.database',
    'menu.oplog',
    'menu.troubleshoot',
    'menu.domain',
    'menu.questions',
    'menu.problems',
    'menu.contests',
    'menu.hosts',
    'menu.siteAccounts',
    'menu.nix',
    'menu.caddy',
    'menu.cli',
    'header.host',
    'header.siteAccount',
    'readonly.label',
    'readonly.stateOn',
    'readonly.stateOff',
    'readonly.confirmTitle',
    'readonly.confirmBody',
    'readonly.turnOff',
    'metrics.title',
    'metrics.cpu',
    'warn.metricDisk',
    'warn.suggest.disk',
    'embed.noUrl',
    'embed.openFallback',
    'embed.source.proxy',
    'packages.upgradeSelected',
    'packages.nixMirror',
    'logs.title',
    'logs.open',
    'issues.title',
    'issues.fix',
    'issue.diskSpace',
    'qzip.title',
    'qzip.hidden',
    'caddy.hint',
    'caddy.saveReload',
    'cli.hint',
    'cli.quickBackup',
    'cli.restore',
    'nix.hint',
    'nix.mirrorOfficial',
    'nix.mirrorCustom',
    'context.badge',
    'context.problem',
    'context.problemList',
    'context.unknown',
    'ai.edit',
    'problem.aiCapabilities',
    'contest.aiCapabilities',
    'domain.aiBulletin',
    'domain.aiPermissions',
    'metrics.judgeSubmissions',
    'metrics.staleRecords',
    'warn.metricStale',
    'warn.suggest.stale',
    'plugins.hint',
    'plugins.install',
    'plugins.uninstallConfirm',
    'overview.aiPromptMessage',
    'community.hint',
    'community.enabled',
    'community.poll',
    'community.saveConfirm',
    'community.intervalInvalid',
    'community.feedTitle',
    'community.threadTitle',
    'community.replySend',
    'community.aiReply',
    'community.aiSuggest.summary',
    'form.passwordBootstrap',
    'form.passwordBootstrapHelp',
    'form.keyManaged',
    'form.installManagedKeyLocked',
    'site.loginHint',
    'session.missing',
    'session.active',
    'session.expired',
    'session.check',
    'session.refreshAll',
    'session.expiredHint',
    'login.title',
    'login.hint',
    'site.role.superadmin',
    'terminal.running',
    'diagnose.button',
    'hosts.upgrade.includeJudge',
  ]
  for (const key of NEW_KEYS) {
    assert.equal(typeof zh[key], 'string', `zh is missing ${key}`)
    assert.equal(typeof en[key], 'string', `en is missing ${key}`)
    assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} must not be empty`)
  }
  assert.notEqual(zh['menu.installUpgrade'], en['menu.installUpgrade'], 'Install & upgrade label must be translated')
  assert.notEqual(zh['menu.siteAccounts'], en['menu.siteAccounts'], 'Site accounts label must be translated')
  assert.notEqual(zh['readonly.label'], en['readonly.label'], 'Readonly label must be translated')
  assert.equal(zh['menu.siteAccounts'], '站点账号', 'Site accounts zh copy is fixed')
  assert.equal(zh['menu.database'], '数据库', 'Database zh copy is fixed')
  assert.equal(zh['menu.troubleshoot'], '智能排障', 'Troubleshoot zh copy is fixed')
  pass('locales: v3 menu + readonly/metrics/embed/packages/logs/issues/qzip keys exist in zh + en')
} finally {
  await rm(localeDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 4b. Warning localization: codes map to localized copy, backend hints never
//     leak, and dynamic Hydro admin messages survive as details.
// ---------------------------------------------------------------------------
const warnDir = await mkdtemp(join(ROOT, '.tmp-verify-warn-'))
try {
  const warnEntry = join(warnDir, 'warnings.mjs')
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/warnings.tsx')],
    outfile: warnEntry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    logLevel: 'silent',
  })
  const { localizeWarning } = await import(warnEntry)
  const translate = (key) => key
  const base = { severity: 'info', message: '原始中文提示', hint: '后端提示' }
  const credentials = localizeWarning({ ...base, code: 'hydro.ws.credentials' }, translate)
  assert.equal(credentials.title, 'warn.wsCredentials')
  assert.equal(credentials.action, 'site-accounts')
  assert.equal(credentials.detail, null)
  assert.equal(localizeWarning({ ...base, code: 'hydro.ws.permission' }, translate).title, 'warn.wsPermission')
  assert.equal(localizeWarning({ ...base, code: 'hydro.ws.connect.abcd1234' }, translate).title, 'warn.wsConnect')
  assert.equal(localizeWarning({ ...base, code: 'hydro.ws.login.abcd1234' }, translate).title, 'warn.wsLogin')
  const adminMessage = localizeWarning({ ...base, code: 'hydro.ws.warn.abcd1234', message: 'Hydro admin warning' }, translate)
  assert.equal(adminMessage.title, 'warn.wsMessage')
  assert.equal(adminMessage.detail, 'Hydro admin warning')
  assert.equal(localizeWarning({ ...base, code: 'hydro.oplog.abcd1234' }, translate).title, 'warn.oplogStandalone')
  assert.equal(localizeWarning({ ...base, code: 'hydro.not-installed.abcd1234' }, translate).title, 'warn.notInstalled')
  assert.equal(localizeWarning({ ...base, code: 'hydro.probe.failed.abcd1234' }, translate).title, 'warn.probeFailed')
  assert.equal(localizeWarning({ ...base, code: 'hydro.health.abcd1234' }, translate).detail, null)
  assert.equal(localizeWarning({ ...base, code: 'hydro.unknown.xyz' }, translate).detail, null)
  pass('warnings: localized by code, backend hints never surfaced, dynamic Hydro messages kept as details')
} finally {
  await rm(warnDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 4c. Issue localization: backend detail hidden when Chinese, fix support and
//     restart target mapped from `fixTarget`.
// ---------------------------------------------------------------------------
const issueDir = await mkdtemp(join(ROOT, '.tmp-verify-issue-'))
try {
  const issueEntry = join(issueDir, 'issues.mjs')
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/issues.ts')],
    outfile: issueEntry,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node20',
    logLevel: 'silent',
  })
  const { localizeIssue } = await import(issueEntry)
  const translate = (key) => key
  const cjk = localizeIssue({ severity: 'warning', code: 'issue.diskSpace', detail: '磁盘中文详情', fix: null, fixTarget: null }, translate)
  assert.equal(cjk.title, 'issue.diskSpace')
  assert.equal(cjk.detail, null)
  const restart = localizeIssue({ severity: 'error', code: 'issue.hydroStopped', detail: 'Hydro down', fix: 'restart-service', fixTarget: 'hydro' }, translate)
  assert.equal(restart.restartTarget, 'hydro')
  assert.equal(restart.fixDisabled, false)
  const plugin = localizeIssue({ severity: 'warning', code: 'issue.uiDefaultMissing', detail: null, fix: 'install-ui-plugin', fixTarget: null }, translate)
  assert.equal(plugin.fixDisabled, false)
  const langs = localizeIssue({ severity: 'warning', code: 'issue.langsMissing', detail: null, fix: 'enable-default-langs', fixTarget: null }, translate)
  assert.equal(langs.fixDisabled, true)
  const unknown = localizeIssue({ severity: 'info', code: 'issue.somethingNew', detail: '中文', fix: null, fixTarget: null }, translate)
  assert.equal(unknown.title, 'issue.unknown')
  assert.equal(unknown.detail, null)
  pass('issues: localized by code, fixTarget mapped, unsupported fixes disabled, CJK detail hidden')
} finally {
  await rm(issueDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 5. HTTP conventions of src/client/api.ts against the shared route table.
//    The module is bundled on the fly so this test needs no extra tooling.
// ---------------------------------------------------------------------------
const apiDir = await mkdtemp(join(tmpdir(), 'dsh-hydro-api-'))
const apiEntry = join(apiDir, 'api.mjs')
try {
  await esbuild({
    entryPoints: [resolve(ROOT, 'src/client/api.ts')],
    outfile: apiEntry,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node20',
    logLevel: 'silent',
  })
  const {
    hydroApi,
    ApiRequestError,
    StreamUnavailableError,
    streamInstallHost,
    streamUpgradeHost,
    runHydroCli,
    restoreHydroBackup,
  } = await import(apiEntry)

  const sampleAccount = {
    id: 'acc-1', label: 'judge', host: '10.0.0.5', port: 22, username: 'root',
    authMethod: 'password', hasManagedKey: false,
    publicKey: null, role: 'root', readonly: false,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    lastConnectedAt: null, lastStatusAt: null, hydro: null,
  }
  const sampleSiteAccount = {
    id: 'site-1', hostId: 'acc-1', hostLabel: 'judge', label: 'admin', uname: 'admin',
    domain: 'system', role: 'superadmin', note: null, readonly: false,
    hasSession: false, sessionCapturedAt: null, lastUsedAt: null,
  }
  const sampleStatus = {
    accountId: 'acc-1', collectedAt: '2026-01-01T00:00:00.000Z', reachable: true, error: null,
    host: null, hydro: { installed: true, installDir: '/root/hydro', version: '5.0.0', latestVersion: '5.0.0', updateAvailable: false, service: null, url: null, health: null },
    plugins: [], judge: null, mongo: null, warnings: [],
  }
  const calls = []
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  globalThis.document = { baseURI: 'http://127.0.0.1:50092/app/' }

  // --- 5a. Account routes (existing behaviour must not regress). ---
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (typeof url === 'string' && url.endsWith('/accounts')) return respond({ accounts: [sampleAccount], activeAccountId: 'acc-1' })
    if (typeof url === 'string' && url.endsWith('/accounts/status')) return respond({ status: sampleStatus })
    if (typeof url === 'string' && url.endsWith('/accounts/test')) return respond({ ok: true, latencyMs: 12, message: 'ok', role: 'root', hostname: 'judge', node: 'v22', hydro: null })
    return respond({ account: sampleAccount })
  }

  const list = await hydroApi.listAccounts()
  assert.equal(list.accounts.length, 1)
  assert.equal(calls[0].url, '/app/dsh-hydro/api/v1/accounts')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.headers.accept, 'application/json')
  assert.equal(calls[0].init.body, undefined)

  await hydroApi.createAccount({ host: '10.0.0.5', username: 'root', authMethod: 'password', password: 'secret', installManagedKey: true, readonly: true })
  assert.equal(calls[1].url, '/app/dsh-hydro/api/v1/accounts/create')
  assert.equal(calls[1].init.method, 'POST')
  assert.equal(calls[1].init.headers['content-type'], 'application/json')
  const createBody = JSON.parse(calls[1].init.body)
  assert.equal(createBody.host, '10.0.0.5')
  assert.equal(createBody.password, 'secret')
  assert.equal(createBody.installManagedKey, true)
  assert.equal(createBody.readonly, true)
  assert.equal(createBody.sudoPassword, undefined)

  await hydroApi.updateAccount({ id: 'acc-1', readonly: true })
  assert.deepEqual(JSON.parse(calls[2].init.body), { id: 'acc-1', readonly: true })

  await hydroApi.removeAccount('acc-1')
  assert.equal(calls[3].url, '/app/dsh-hydro/api/v1/accounts/remove')
  assert.deepEqual(JSON.parse(calls[3].init.body), { id: 'acc-1' })

  await hydroApi.activateAccount('acc-1')
  assert.equal(calls[4].url, '/app/dsh-hydro/api/v1/accounts/activate')
  assert.deepEqual(JSON.parse(calls[4].init.body), { id: 'acc-1' })

  const tested = await hydroApi.testAccount('acc-1')
  assert.equal(calls[5].url, '/app/dsh-hydro/api/v1/accounts/test')
  assert.equal(tested.ok, true)

  const collected = await hydroApi.collectStatus('acc-1')
  assert.equal(calls[6].url, '/app/dsh-hydro/api/v1/accounts/status')
  assert.equal(collected.accountId, 'acc-1')
  assert.equal(collected.hydro.version, '5.0.0')
  pass('api: shared account routes, same-origin conventions and { id } payloads')

  // --- 5b. Host management routes + diagnose. ---
  const plan = { targets: [{ name: 'hydrooj', version: '5.1.0' }], command: 'yarn global upgrade hydrooj', current: { hydrooj: '5.0.0' } }
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const path = typeof url === 'string' ? url : ''
    if (path.endsWith('/hosts/install')) return respond({ ok: true, message: 'installed', log: 'tail' })
    if (path.endsWith('/hosts/upgrade')) {
      const body = JSON.parse(init.body)
      return body.dryRun === true
        ? respond({ result: { ok: true, message: 'plan', details: plan }, plan })
        : respond({ result: { ok: true, message: 'upgraded' }, plan: null })
    }
    if (path.endsWith('/hosts/service')) return respond({ target: 'hydro', manager: 'pm2', action: 'status', ok: true, output: 'online' })
    if (path.endsWith('/hosts/warnings')) return respond({ hostId: 'acc-1', warnings: [], collectedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/hosts/data')) {
      const body = JSON.parse(init.body)
      if (body.action === 'oplog') return respond({ action: 'oplog', documents: [{ id: 'e1', type: 'problem.edit', time: '2026-01-01T00:00:00.000Z', operator: 1, domainId: 'system', path: '/p/1', args: { hidden: false }, ip: '127.0.0.1' }], collection: 'oplog', truncated: false, note: null, mongoOplog: { available: false } })
      return respond({ action: 'find', documents: [{ _id: 1 }], collection: 'problem', truncated: false, note: null, mongoOplog: null })
    }
    if (path.endsWith('/hosts/services')) return respond({ manager: 'pm2', collectedAt: '2026-01-01T00:00:00.000Z', processes: [{ name: 'hydrooj', status: 'online', pid: 10, restarts: 0, uptimeMs: 1000, cpuPercent: 1.5, memoryBytes: 1048576, execPath: '/usr/bin/node', target: 'hydro' }], hydro: { installed: true, version: '5.0.0', serviceName: 'hydrooj', health: { ok: true, status: 200, latencyMs: 3 } }, sandbox: { running: true, version: '1.0.0', address: '127.0.0.1:5050' }, judge: { installed: true, running: true, configPath: '/root/.hydro/judge.yaml' } })
    if (path.endsWith('/hosts/address')) return respond({ url: 'http://127.0.0.1:50123', source: 'proxy' })
    if (path.endsWith('/hosts/caddy')) {
      const body = JSON.parse(init.body)
      if (body.action === 'write' || body.action === 'validate' || body.action === 'reload') return respond({ ok: true, message: 'caddy ok', log: 'caddy output' })
      return respond({ installed: true, running: true, manager: 'systemd', path: '/etc/caddy/Caddyfile', content: 'judge.example.com {\n\treverse_proxy 127.0.0.1:8888\n}', version: '2.7.0' })
    }
    if (path.endsWith('/hosts/backups')) return respond({ backups: [{ name: 'backup-2026.zip', path: '/data/backup-2026.zip', sizeBytes: 1024, modifiedAt: '2026-01-01T00:00:00.000Z' }] })
    if (path.endsWith('/hosts/context')) return respond({ kind: 'problem', domain: 'system', id: 'P1000', path: '/d/system/p/P1000' })
    if (path.endsWith('/community/status')) return respond({ enabled: false, intervalMinutes: 10, domain: 'system', siteAccountId: 'site-1', lastCheckedAt: null, newActivity: 0, seenDids: [] })
    if (path.endsWith('/community/config')) return respond({ enabled: JSON.parse(init.body).enabled, intervalMinutes: JSON.parse(init.body).intervalMinutes, domain: JSON.parse(init.body).domain, siteAccountId: JSON.parse(init.body).siteAccountId, lastCheckedAt: null, newActivity: 0, seenDids: [] })
    if (path.endsWith('/community/feed')) return respond({ discussions: [{ did: 'D1000', title: 'Welcome', content: 'hi', owner: 1, replyCount: 2, updatedAt: '2026-01-01T00:00:00.000Z' }], newActivity: 1, lastCheckedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/community/thread')) return respond({ did: 'D1000', title: 'Welcome', content: 'hi', replies: [{ id: 'r1', content: 'hello', owner: 2, time: '2026-01-01T00:00:00.000Z' }] })
    if (path.endsWith('/community/reply')) return respond({ ok: true, message: 'replied' })
    if (path.endsWith('/community/poll')) return respond({ newActivity: 1, discussions: [], lastCheckedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/hosts/plugins')) {
      const body = JSON.parse(init.body)
      if (body.action === 'list') return respond({ plugins: [{ name: 'hydrooj-addon-a', version: '1.0.0', enabled: true }], enabled: ['hydrooj-addon-a'] })
      return respond({ ok: true, message: 'plugin ok', log: 'yarn output' })
    }
    if (path.endsWith('/hosts/logs')) return respond({ process: 'hydrooj', manager: 'pm2', stdout: 'ok', stderr: '', truncated: false })
    if (path.endsWith('/hosts/metrics')) return respond({ collectedAt: '2026-01-01T00:00:00.000Z', cpu: { usagePercent: 12.5, load1: 0.4, cores: 4 }, memory: { totalBytes: 1000, usedBytes: 500, usagePercent: 50 }, disk: { mount: '/', totalBytes: 1000, usedBytes: 900, usagePercent: 90 }, judge: { queueDepth: 0, submissionsLastHour: 42, acceptedLastHour: 30, staleRecords: 3 }, alerts: [{ severity: 'warning', code: 'disk', value: 90 }, { severity: 'warning', code: 'stale', value: 3 }] })
    if (path.endsWith('/hosts/issues')) return respond({ collectedAt: '2026-01-01T00:00:00.000Z', issues: [{ severity: 'warning', code: 'issue.hydroStopped', detail: 'down', fix: 'restart-service', fixTarget: 'hydro' }] })
    if (path.endsWith('/hosts/issues/fix')) return respond({ ok: true, message: 'fixed', log: 'restart ok' })
    if (path.endsWith('/hosts/packages')) return respond({ packages: [{ name: 'hydrooj', kind: 'core', current: '5.0.0', latest: '5.1.0', updateAvailable: true }], node: { version: '20.0.0', latest: '22.0.0', managedByNix: true }, goJudge: { version: '1.0.0', managedByNix: true }, nix: { substituters: 'https://cache.nixos.org' }, collectedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/hosts/nix')) return respond({ ok: true, message: 'nix done', log: 'substituters updated' })
    if (path.endsWith('/settings/readonly')) return respond({ readonlyMode: JSON.parse(init.body).readonly, updatedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/settings')) return respond({ readonlyMode: true, updatedAt: null })
    if (path.endsWith('/hosts/diagnose')) return respond({ prompt: 'diagnose this install' })
    return respond({ error: `unexpected ${path}` }, 404)
  }

  await hydroApi.installHost('acc-1', { judge: true })
  assert.equal(calls[0].url, '/app/dsh-hydro/api/v1/hosts/install')
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'acc-1', confirm: true, judge: true })

  const checked = await hydroApi.upgradeHost('acc-1', { dryRun: true })
  assert.equal(calls[1].url, '/app/dsh-hydro/api/v1/hosts/upgrade')
  assert.deepEqual(JSON.parse(calls[1].init.body), { id: 'acc-1', dryRun: true })
  assert.deepEqual(checked.plan, plan)

  const upgraded = await hydroApi.upgradeHost('acc-1', { dryRun: false })
  assert.deepEqual(JSON.parse(calls[2].init.body), { id: 'acc-1', dryRun: false, confirm: true })
  assert.equal(upgraded.result.ok, true)

  const serviceStatus = await hydroApi.serviceAction('acc-1', 'hydro', 'status')
  assert.equal(calls[3].url, '/app/dsh-hydro/api/v1/hosts/service')
  assert.deepEqual(JSON.parse(calls[3].init.body), { id: 'acc-1', target: 'hydro', action: 'status' })
  assert.equal(serviceStatus.output, 'online')
  await hydroApi.serviceAction('acc-1', 'mongodb', 'restart')
  assert.deepEqual(JSON.parse(calls[4].init.body), { id: 'acc-1', target: 'mongodb', action: 'restart', confirm: true })

  const warnings = await hydroApi.hostWarnings('acc-1')
  assert.equal(calls[5].url, '/app/dsh-hydro/api/v1/hosts/warnings')
  assert.deepEqual(JSON.parse(calls[5].init.body), { id: 'acc-1' })
  assert.equal(warnings.hostId, 'acc-1')

  const data = await hydroApi.hostData('acc-1', { action: 'find', collection: 'problem', limit: 10 })
  assert.equal(calls[6].url, '/app/dsh-hydro/api/v1/hosts/data')
  assert.deepEqual(JSON.parse(calls[6].init.body), { id: 'acc-1', action: 'find', collection: 'problem', limit: 10 })
  assert.equal(data.documents.length, 1)

  const oplog = await hydroApi.hostData('acc-1', { action: 'oplog', source: 'hydro', limit: 10, type: 'problem.edit', contains: 'hidden' })
  assert.equal(calls[7].url, '/app/dsh-hydro/api/v1/hosts/data')
  assert.deepEqual(JSON.parse(calls[7].init.body), { id: 'acc-1', action: 'oplog', source: 'hydro', limit: 10, type: 'problem.edit', contains: 'hidden' })
  assert.equal(oplog.documents.length, 1)

  const services = await hydroApi.hostServices('acc-1')
  assert.equal(calls[8].url, '/app/dsh-hydro/api/v1/hosts/services')
  assert.deepEqual(JSON.parse(calls[8].init.body), { id: 'acc-1' })
  assert.equal(services.processes[0].target, 'hydro')
  assert.equal(services.processes[0].cpuPercent, 1.5)

  const settings = await hydroApi.getUiSettings()
  assert.equal(calls[9].url, '/app/dsh-hydro/api/v1/settings')
  assert.equal(calls[9].init.method, 'GET')
  assert.equal(settings.readonlyMode, true)

  const persisted = await hydroApi.setGlobalReadonly(true)
  assert.equal(calls[10].url, '/app/dsh-hydro/api/v1/settings/readonly')
  assert.equal(calls[10].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[10].init.body), { readonly: true })
  assert.equal(persisted.readonlyMode, true)

  const diagnosis = await hydroApi.diagnoseHost({ hostId: 'acc-1', kind: 'install', output: 'tail', message: 'boom' })
  assert.equal(calls[11].url, '/app/dsh-hydro/api/v1/hosts/diagnose')
  assert.deepEqual(JSON.parse(calls[11].init.body), { id: 'acc-1', hostId: 'acc-1', kind: 'install', output: 'tail', message: 'boom' })
  assert.equal(diagnosis.prompt, 'diagnose this install')

  const address = await hydroApi.hostAddress('acc-1')
  assert.equal(calls[12].url, '/app/dsh-hydro/api/v1/hosts/address')
  assert.deepEqual(JSON.parse(calls[12].init.body), { id: 'acc-1' })
  assert.equal(address.url, 'http://127.0.0.1:50123')
  assert.equal(address.source, 'proxy')

  const logs = await hydroApi.hostLogs('acc-1', { process: 'hydrooj', lines: 100 })
  assert.equal(calls[13].url, '/app/dsh-hydro/api/v1/hosts/logs')
  assert.deepEqual(JSON.parse(calls[13].init.body), { id: 'acc-1', process: 'hydrooj', lines: 100 })
  assert.equal(logs.stdout, 'ok')

  const metrics = await hydroApi.hostMetrics('acc-1')
  assert.equal(calls[14].url, '/app/dsh-hydro/api/v1/hosts/metrics')
  assert.deepEqual(JSON.parse(calls[14].init.body), { id: 'acc-1' })
  assert.equal(metrics.cpu.usagePercent, 12.5)
  assert.equal(metrics.alerts[0].code, 'disk')
  assert.equal(metrics.judge.queueDepth, 0)
  assert.equal(metrics.judge.submissionsLastHour, 42)
  assert.equal(metrics.judge.acceptedLastHour, 30)
  assert.equal(metrics.judge.staleRecords, 3)
  assert.equal(metrics.alerts[1].code, 'stale')

  const issues = await hydroApi.hostIssues('acc-1')
  assert.equal(calls[15].url, '/app/dsh-hydro/api/v1/hosts/issues')
  assert.deepEqual(JSON.parse(calls[15].init.body), { id: 'acc-1' })
  assert.equal(issues.issues[0].fixTarget, 'hydro')

  const restarted = await hydroApi.fixHostIssue('acc-1', { fix: 'restart-service', target: 'hydro', confirm: true })
  assert.equal(calls[16].url, '/app/dsh-hydro/api/v1/hosts/issues/fix')
  assert.deepEqual(JSON.parse(calls[16].init.body), { id: 'acc-1', fix: 'restart-service', target: 'hydro', confirm: true })
  assert.equal(restarted.ok, true)
  await hydroApi.fixHostIssue('acc-1', { fix: 'install-ui-plugin', confirm: true })
  assert.deepEqual(JSON.parse(calls[17].init.body), { id: 'acc-1', fix: 'install-ui-plugin', confirm: true })

  const packages = await hydroApi.hostPackages('acc-1')
  assert.equal(calls[18].url, '/app/dsh-hydro/api/v1/hosts/packages')
  assert.deepEqual(JSON.parse(calls[18].init.body), { id: 'acc-1' })
  assert.equal(packages.packages[0].updateAvailable, true)
  assert.equal(packages.nix.substituters, 'https://cache.nixos.org')

  await hydroApi.hostNix('acc-1', { action: 'set-mirror', mirror: 'https://mirror.example.com', confirm: true })
  assert.equal(calls[19].url, '/app/dsh-hydro/api/v1/hosts/nix')
  assert.deepEqual(JSON.parse(calls[19].init.body), { id: 'acc-1', action: 'set-mirror', mirror: 'https://mirror.example.com', confirm: true })
  await hydroApi.hostNix('acc-1', { action: 'upgrade-package', package: 'nodejs', confirm: true })
  assert.deepEqual(JSON.parse(calls[20].init.body), { id: 'acc-1', action: 'upgrade-package', package: 'nodejs', confirm: true })

  const caddy = await hydroApi.getCaddy('acc-1')
  assert.equal(calls[21].url, '/app/dsh-hydro/api/v1/hosts/caddy')
  assert.deepEqual(JSON.parse(calls[21].init.body), { id: 'acc-1', action: 'read' })
  assert.equal(caddy.path, '/etc/caddy/Caddyfile')
  assert.equal(caddy.running, true)

  await hydroApi.writeCaddy('acc-1', { path: '/etc/caddy/Caddyfile', content: 'x', reload: true })
  assert.deepEqual(JSON.parse(calls[22].init.body), { id: 'acc-1', action: 'write', path: '/etc/caddy/Caddyfile', content: 'x', reload: true, confirm: true })
  await hydroApi.applyCaddy('acc-1', 'validate')
  assert.deepEqual(JSON.parse(calls[23].init.body), { id: 'acc-1', action: 'validate', confirm: true })
  await hydroApi.applyCaddy('acc-1', 'reload')
  assert.deepEqual(JSON.parse(calls[24].init.body), { id: 'acc-1', action: 'reload', confirm: true })

  const backups = await hydroApi.listBackups('acc-1')
  assert.equal(calls[25].url, '/app/dsh-hydro/api/v1/hosts/backups')
  assert.deepEqual(JSON.parse(calls[25].init.body), { id: 'acc-1' })
  assert.equal(backups.backups[0].name, 'backup-2026.zip')

  const embeddedContext = await hydroApi.getEmbeddedContext('acc-1')
  assert.equal(calls[26].url, '/app/dsh-hydro/api/v1/hosts/context')
  assert.deepEqual(JSON.parse(calls[26].init.body), { id: 'acc-1' })
  assert.equal(embeddedContext.kind, 'problem')
  assert.equal(embeddedContext.id, 'P1000')

  const plugins = await hydroApi.listPlugins('acc-1')
  assert.equal(calls[27].url, '/app/dsh-hydro/api/v1/hosts/plugins')
  assert.deepEqual(JSON.parse(calls[27].init.body), { id: 'acc-1', action: 'list' })
  assert.equal(plugins.plugins[0].name, 'hydrooj-addon-a')
  await hydroApi.managePlugin('acc-1', 'install', 'hydrooj-addon-b')
  assert.deepEqual(JSON.parse(calls[28].init.body), { id: 'acc-1', action: 'install', name: 'hydrooj-addon-b', confirm: true })
  await hydroApi.managePlugin('acc-1', 'disable', 'hydrooj-addon-a')
  assert.deepEqual(JSON.parse(calls[29].init.body), { id: 'acc-1', action: 'disable', name: 'hydrooj-addon-a', confirm: true })
  await hydroApi.managePlugin('acc-1', 'uninstall', 'hydrooj-addon-a')
  assert.deepEqual(JSON.parse(calls[30].init.body), { id: 'acc-1', action: 'uninstall', name: 'hydrooj-addon-a', confirm: true })

  const community = await hydroApi.communityStatus()
  assert.equal(calls[31].url, '/app/dsh-hydro/api/v1/community/status')
  assert.deepEqual(JSON.parse(calls[31].init.body), {})
  assert.equal(community.intervalMinutes, 10)

  const savedCommunity = await hydroApi.saveCommunityConfig({ enabled: true, intervalMinutes: 5, domain: 'system', siteAccountId: 'site-1' })
  assert.deepEqual(JSON.parse(calls[32].init.body), { enabled: true, intervalMinutes: 5, domain: 'system', siteAccountId: 'site-1' })
  assert.equal(savedCommunity.enabled, true)

  const communityFeed = await hydroApi.communityFeed({ siteAccountId: 'site-1', domain: 'system', limit: 20 })
  assert.deepEqual(JSON.parse(calls[33].init.body), { siteAccountId: 'site-1', domain: 'system', limit: 20 })
  assert.equal(communityFeed.discussions[0].did, 'D1000')

  const communityThread = await hydroApi.communityThread({ siteAccountId: 'site-1', did: 'D1000' })
  assert.deepEqual(JSON.parse(calls[34].init.body), { siteAccountId: 'site-1', did: 'D1000' })
  assert.equal(communityThread.replies[0].id, 'r1')

  const replyResult = await hydroApi.communityReply({ siteAccountId: 'site-1', did: 'D1000', content: 'hello' })
  assert.deepEqual(JSON.parse(calls[35].init.body), { siteAccountId: 'site-1', did: 'D1000', content: 'hello', confirm: true })
  assert.equal(replyResult.ok, true)

  const pollResult = await hydroApi.communityPoll('site-1')
  assert.deepEqual(JSON.parse(calls[36].init.body), { siteAccountId: 'site-1' })
  assert.equal(pollResult.newActivity, 1)
  pass('api: community status/config/feed/thread/reply/poll routes and payloads')

  // --- 5c. Multi-account content routes. ---
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const path = typeof url === 'string' ? url : ''
    if (path.endsWith('/site/accounts')) return respond({ accounts: [sampleSiteAccount], activeSiteAccountId: 'site-1' })
    if (path.endsWith('/site/session')) return respond({ siteAccountId: 'site-1', state: 'active', capturedAt: '2026-01-01T00:00:00.000Z', message: null })
    if (path.endsWith('/site/save')) return respond({ account: sampleSiteAccount })
    if (path.endsWith('/site/remove')) return respond({ removed: true })
    if (path.endsWith('/site/activate')) return respond({ activeSiteAccountId: 'site-1' })
    if (path.endsWith('/site/inspect')) return respond({ siteAccountId: 'site-1', hostId: 'acc-1', warnings: [], domain: { current: { name: 'Hydro' }, settings: null }, collectedAt: '2026-01-01T00:00:00.000Z' })
    if (path.endsWith('/site/domain/set')) return respond({ ok: true, message: 'updated' })
    if (path.endsWith('/site/collection')) return respond({ collection: 'problem', documents: [] })
    if (path.endsWith('/site/authoring-prompt')) return respond({ prompt: 'make a problem' })
    if (path.endsWith('/site/questions/import-zip')) return respond({ ok: true, message: 'submitted' })
    if (path.endsWith('/site/domains')) return respond({ domains: [{ id: 'system', name: 'System' }] })
    return respond({ error: `unexpected ${path}` }, 404)
  }

  const siteAccounts = await hydroApi.listSiteAccounts()
  assert.equal(calls[0].url, '/app/dsh-hydro/api/v1/site/accounts')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(siteAccounts.activeSiteAccountId, 'site-1')
  assert.equal(siteAccounts.accounts.length, 1)

  const createdSiteAccount = await hydroApi.saveSiteAccount({
    hostId: 'acc-1', label: 'admin', uname: 'admin', domain: 'system', role: 'superadmin', note: 'main', readonly: false,
  })
  assert.equal(calls[1].url, '/app/dsh-hydro/api/v1/site/save')
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    hostId: 'acc-1', label: 'admin', uname: 'admin', domain: 'system', role: 'superadmin', note: 'main', readonly: false,
  })
  assert.equal(createdSiteAccount.account.id, 'site-1')

  await hydroApi.saveSiteAccount({ id: 'site-1', hostId: 'acc-1', uname: 'admin2', role: 'judge', readonly: true })
  assert.deepEqual(JSON.parse(calls[2].init.body), { id: 'site-1', hostId: 'acc-1', uname: 'admin2', role: 'judge', readonly: true })

  await hydroApi.removeSiteAccount('site-1')
  assert.equal(calls[3].url, '/app/dsh-hydro/api/v1/site/remove')
  assert.deepEqual(JSON.parse(calls[3].init.body), { id: 'site-1' })

  const session = await hydroApi.siteSession('site-1')
  assert.equal(calls[4].url, '/app/dsh-hydro/api/v1/site/session')
  assert.deepEqual(JSON.parse(calls[4].init.body), { siteAccountId: 'site-1' })
  assert.equal(session.state, 'active')
  assert.equal(session.capturedAt, '2026-01-01T00:00:00.000Z')

  const activated = await hydroApi.activateSiteAccount('site-1')
  assert.equal(calls[5].url, '/app/dsh-hydro/api/v1/site/activate')
  assert.deepEqual(JSON.parse(calls[5].init.body), { id: 'site-1' })
  assert.equal(activated.activeSiteAccountId, 'site-1')

  const inspected = await hydroApi.inspectSite('site-1')
  assert.equal(calls[6].url, '/app/dsh-hydro/api/v1/site/inspect')
  assert.deepEqual(JSON.parse(calls[6].init.body), { siteAccountId: 'site-1' })
  assert.equal(inspected.domain.current.name, 'Hydro')

  const domainSet = await hydroApi.setSiteDomain({ siteAccountId: 'site-1', values: { name: 'Hydro', flag: true }, booleanKeys: { flag: true }, confirm: true })
  assert.equal(calls[7].url, '/app/dsh-hydro/api/v1/site/domain/set')
  assert.deepEqual(JSON.parse(calls[7].init.body), { siteAccountId: 'site-1', values: { name: 'Hydro', flag: true }, booleanKeys: { flag: true }, confirm: true })
  assert.equal(domainSet.ok, true)

  const problems = await hydroApi.listSiteCollection('site-1', 'problem', 20)
  assert.equal(calls[8].url, '/app/dsh-hydro/api/v1/site/collection')
  assert.deepEqual(JSON.parse(calls[8].init.body), { siteAccountId: 'site-1', collection: 'problem', limit: 20 })
  assert.equal(problems.collection, 'problem')

  const prompt = await hydroApi.authoringPrompt({ siteAccountId: 'site-1', kind: 'contest', title: 'Round 1' })
  assert.equal(calls[9].url, '/app/dsh-hydro/api/v1/site/authoring-prompt')
  assert.deepEqual(JSON.parse(calls[9].init.body), { siteAccountId: 'site-1', kind: 'contest', title: 'Round 1' })
  assert.equal(typeof prompt.prompt, 'string')

  const zip = await hydroApi.importQuestionsZip({ siteAccountId: 'site-1', filename: 'pkg.zip', data: 'UEsDBA==', hidden: true, preferredPrefix: 'T' })
  assert.equal(calls[10].url, '/app/dsh-hydro/api/v1/site/questions/import-zip')
  assert.deepEqual(JSON.parse(calls[10].init.body), { siteAccountId: 'site-1', filename: 'pkg.zip', data: 'UEsDBA==', hidden: true, preferredPrefix: 'T' })
  assert.equal(zip.ok, true)

  const domains = await hydroApi.listSiteDomains('site-1')
  assert.equal(calls[11].url, '/app/dsh-hydro/api/v1/site/domains')
  assert.deepEqual(JSON.parse(calls[11].init.body), { siteAccountId: 'site-1' })
  assert.equal(domains.domains[0].id, 'system')

  await hydroApi.authoringPrompt({
    siteAccountId: 'site-1', kind: 'problem', domain: 'system', problemId: 'P1000',
  })
  assert.equal(calls[12].url, '/app/dsh-hydro/api/v1/site/authoring-prompt')
  assert.deepEqual(JSON.parse(calls[12].init.body), {
    siteAccountId: 'site-1', kind: 'problem', domain: 'system', problemId: 'P1000',
  })
  await hydroApi.authoringPrompt({ siteAccountId: 'site-1', kind: 'contest', contestId: 'C1000' })
  assert.deepEqual(JSON.parse(calls[13].init.body), { siteAccountId: 'site-1', kind: 'contest', contestId: 'C1000' })
  await hydroApi.authoringPrompt({ siteAccountId: 'site-1', kind: 'domain-bulletin', domain: 'system' })
  assert.deepEqual(JSON.parse(calls[14].init.body), { siteAccountId: 'site-1', kind: 'domain-bulletin', domain: 'system' })
  await hydroApi.authoringPrompt({ siteAccountId: 'site-1', kind: 'discussion-reply', domain: 'system', discussionId: 'D1000', requirements: '总结并草拟回复' })
  assert.deepEqual(JSON.parse(calls[15].init.body), { siteAccountId: 'site-1', kind: 'discussion-reply', domain: 'system', discussionId: 'D1000', requirements: '总结并草拟回复' })
  pass('api: content ZIP import + domains + direct-chat authoring prompt payloads')

  // --- 5d. POST + SSE install/upgrade stream. ---
  const sseFrames = [
    'event: output\ndata: {"stream":"stdout","text":"line1\\n"}\n\n',
    'event: output\ndata: {"stream":"stderr","text":"warn\\n"}\n\n',
    'event: result\ndata: {"ok":true,"message":"done"}\n\n',
  ].join('')
  const openStream = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })

  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const path = typeof url === 'string' ? url : ''
    if (path.endsWith('/hosts/install/stream')) return openStream(sseFrames)
    if (path.endsWith('/hosts/upgrade/stream')) {
      return openStream('event: result\ndata: {"ok":true,"message":"upgraded"}\n\n')
    }
    return respond({ error: `unexpected ${path}` }, 404)
  }

  const chunks = []
  const streamed = await streamInstallHost('acc-1', { judge: true }, { onOutput: (chunk) => { chunks.push(chunk) } })
  assert.equal(calls[0].url, '/app/dsh-hydro/api/v1/hosts/install/stream')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.equal(calls[0].init.headers.accept, 'text/event-stream')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'acc-1', confirm: true, judge: true })
  assert.deepEqual(chunks, [{ stream: 'stdout', text: 'line1\n' }, { stream: 'stderr', text: 'warn\n' }])
  assert.equal(streamed.ok, true)
  assert.equal(streamed.message, 'done')
  assert.equal(calls[0].init.signal, undefined)

  const streamedUpgrade = await streamUpgradeHost('acc-1', { includeJudge: true, packages: ['hydrooj', 'hydrojudge'] })
  assert.equal(calls[1].url, '/app/dsh-hydro/api/v1/hosts/upgrade/stream')
  assert.deepEqual(JSON.parse(calls[1].init.body), { id: 'acc-1', confirm: true, includeJudge: true, packages: ['hydrooj', 'hydrojudge'] })
  assert.equal(streamedUpgrade.message, 'upgraded')

  // Non-2xx / non-SSE / no body -> StreamUnavailableError (caller falls back).
  globalThis.fetch = async () => respond({ error: 'not found' }, 404)
  await assert.rejects(streamInstallHost('acc-1'), (error) => {
    assert.ok(error instanceof StreamUnavailableError)
    assert.equal(error.status, 404)
    return true
  })
  globalThis.fetch = async () => respond({ ok: true, message: 'plain' })
  await assert.rejects(streamInstallHost('acc-1'), (error) => error instanceof StreamUnavailableError)

  // A Host `error` event is a real failure, not a fallback signal.
  globalThis.fetch = async () => openStream('event: error\ndata: {"message":"boom"}\n\n')
  await assert.rejects(streamUpgradeHost('acc-1'), (error) => {
    assert.ok(error instanceof ApiRequestError)
    assert.match(error.message, /boom/)
    return true
  })
  pass('api: SSE install/upgrade streams, output order, fallback signal and error events')

  // CLI run + restore SSE.
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return openStream('event: output\ndata: {"stream":"stdout","text":"backup ok\\n"}\n\nevent: result\ndata: {"ok":true,"exitCode":0,"output":"backup ok"}\n\n')
  }
  const cliLines = []
  const cliResult = await runHydroCli('acc-1', 'backup', { onOutput: (chunk) => { cliLines.push(chunk) } })
  assert.equal(calls[0].url, '/app/dsh-hydro/api/v1/hosts/cli/stream')
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 'acc-1', action: 'run', command: 'backup' })
  assert.deepEqual(cliLines, [{ stream: 'stdout', text: 'backup ok\n' }])
  assert.equal(cliResult.exitCode, 0)
  assert.equal(cliResult.output, 'backup ok')
  await restoreHydroBackup('acc-1', 'backup-2026.zip')
  assert.deepEqual(JSON.parse(calls[1].init.body), { id: 'acc-1', action: 'restore', filename: 'backup-2026.zip', confirm: true })
  pass('api: Hydro CLI SSE run/restore result frames')

  // --- 5e. Non-2xx: both error-body shapes map to ApiRequestError. ---
  globalThis.fetch = async () => respond({ error: { code: 'hydro/readonly', message: '账户为只读' } }, 409)
  await assert.rejects(hydroApi.activateAccount('acc-1'), (error) => {
    assert.ok(error instanceof ApiRequestError)
    assert.equal(error.status, 409)
    assert.equal(error.code, 'hydro/readonly')
    assert.match(error.message, /只读/)
    return true
  })
  globalThis.fetch = async () => respond({ error: '账户不存在', code: 'hydro/unknown-account' }, 404)
  await assert.rejects(hydroApi.removeAccount('missing'), (error) => {
    assert.equal(error.code, 'hydro/unknown-account')
    assert.equal(error.message, '账户不存在')
    return true
  })
  pass('api: both error-body shapes map to ApiRequestError')
} finally {
  await rm(apiDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log(`\n${String(results.length)} checks passed`)
assert.equal(results.length, 21)
