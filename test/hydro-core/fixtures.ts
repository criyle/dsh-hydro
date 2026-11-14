/**
 * Scripted stdout fixtures for the batched Hydro probe (`detect.ts`).
 *
 * The fixtures mirror the real section layout exactly; each test only tweaks
 * the fields it cares about.
 */

export const SECTION = '__DSH_HYDRO_SECTION__'

export interface Pm2Fixture {
  name: string
  status: string
  pid: number | null
  restarts: number | null
  uptimeMs: number | null
}

export interface AddonFixture {
  name: string
  version: string | null
}

export interface HealthFixture {
  url: string
  code: number
  seconds: number
}

export interface ProbeFixtureOptions {
  installed?: boolean
  uid?: string
  sudo?: 'yes' | 'no'
  user?: string
  home?: string
  coreVersion?: string | null
  installDir?: string
  configUri?: string | null
  configPath?: string
  addons?: AddonFixture[]
  addonNames?: string[]
  marker?: string | null
  pm2?: Pm2Fixture[]
  systemdHydroActive?: boolean
  docker?: string
  ports?: number[]
  health?: HealthFixture[]
  sandboxVersion?: string | null
  judgeYaml?: string | null
  pretty?: string
  arch?: string
  kernel?: string
  nodeVersion?: string | null
}

const YARN_GLOBAL_DIR = '/usr/local/share/.config/yarn/global'
const DEFAULT_INSTALL_DIR = `${YARN_GLOBAL_DIR}/node_modules/hydrooj`

function section(name: string, lines: string[]): string {
  return [`${SECTION} ${name}`, ...lines].join('\n')
}

function keyValues(values: Array<[string, string]>): string[] {
  return values.map(([key, value]) => `${key}=${value}`)
}

function metaLines(options: ProbeFixtureOptions, installed: boolean): string[] {
  const uid = options.uid ?? (installed ? '0' : '1000')
  const home = options.home ?? (uid === '0' ? '/root' : '/home/hydro')
  return keyValues([
    ['uid', uid],
    ['user', options.user ?? (uid === '0' ? 'root' : 'hydro')],
    ['home', home],
    ['roothome', '/root'],
    ['sudo', options.sudo ?? 'no'],
    ['uname', 'Linux'],
    ['kernel', options.kernel ?? '6.1.0-18-amd64'],
    ['arch', options.arch ?? 'x86_64'],
    ['hostname', 'oj'],
    ['pretty', options.pretty ?? 'Debian GNU/Linux 12 (bookworm)'],
    ['node', '/usr/local/bin/node'],
    ['nodever', options.nodeVersion ?? 'v22.14.0'],
    ['yarn', '/usr/local/bin/yarn'],
    ['yarnver', '1.22.22'],
    ['pm2', '/usr/local/bin/pm2'],
    ['hydrooj', options.installed === true ? '/usr/local/bin/hydrooj' : ''],
    ['mongosh', '/usr/local/bin/mongosh'],
    ['caddy', '/usr/local/bin/caddy'],
    ['systemctl', '/usr/bin/systemctl'],
    ['docker', ''],
    ['curl', '/usr/bin/curl'],
    ['installdir', ''],
    ['port', ''],
  ])
}

/**
 * Build probe stdout for an installed Hydro (defaults) or a bare host
 * (`installed: false`, or just override individual fields).
 */
export function probeOutput(options: ProbeFixtureOptions = {}): string {
  const installed = options.installed ?? false
  const coreVersion = options.coreVersion === undefined ? (installed ? '5.0.7' : null) : options.coreVersion
  const installDir = options.installDir ?? DEFAULT_INSTALL_DIR
  const configPath = options.configPath ?? '/root/.hydro/config.json'
  const configUri =
    options.configUri === undefined
      ? installed
        ? 'mongodb://hydro:secretpass@127.0.0.1:27017/hydro'
        : null
      : options.configUri
  const addons = options.addons ?? (installed ? [
    { name: '@hydrooj/ui-default', version: '4.58.5' },
    { name: '@hydrooj/hydrojudge', version: '4.0.6' },
    { name: '@hydrooj/a11y', version: '4.0.6' },
  ] : [])
  const addonNames = options.addonNames ?? addons.map((addon) => addon.name)
  const marker = options.marker === undefined ? (installed ? 'layout=2' : null) : options.marker
  const pm2 = options.pm2 ?? (installed ? [
    { name: 'hydrooj', status: 'online', pid: 1001, restarts: 3, uptimeMs: 60_000 },
    { name: 'mongodb', status: 'online', pid: 1002, restarts: 0, uptimeMs: 120_000 },
    { name: 'hydro-sandbox', status: 'online', pid: 1003, restarts: 1, uptimeMs: 120_000 },
    { name: 'caddy', status: 'online', pid: 1004, restarts: 0, uptimeMs: 120_000 },
  ] : [])
  const ports = options.ports ?? (installed ? [8888, 27017, 5050] : [])
  const health = options.health ?? (installed
    ? [{ url: 'http://127.0.0.1:8888/status', code: 200, seconds: 0.0123 }]
    : [{ url: 'http://127.0.0.1:8888/status', code: 0, seconds: 0.0001 }])
  const sandboxVersion = options.sandboxVersion === undefined
    ? (installed ? 'go-judge v1.9.4' : null)
    : options.sandboxVersion
  const judgeYaml = options.judgeYaml === undefined
    ? (installed ? '/root/.hydro/judge.yaml' : null)
    : options.judgeYaml

  const now = Date.now()
  const pm2Json = JSON.stringify(
    pm2.map((entry) => ({
      name: entry.name,
      pid: entry.pid ?? 0,
      pm2_env: {
        status: entry.status,
        restart_time: entry.restarts ?? 0,
        pm_uptime: entry.uptimeMs === null ? now : now - entry.uptimeMs,
        pm_exec_path: `/srv/${entry.name}.js`,
      },
    })),
  )

  const installDirSection: string[] = []
  if (coreVersion !== null) installDirSection.push(`DIR ${installDir}`)
  if (coreVersion !== null) installDirSection.push(JSON.stringify({ name: 'hydrooj', version: coreVersion }))

  const configSection: string[] = []
  if (configUri !== null) configSection.push(`FILE ${configPath}`, JSON.stringify({ uri: configUri }))

  const addonsSection: string[] = []
  if (addonNames.length > 0) addonsSection.push(`FILE ${configPath.replace(/config\.json$/, 'addon.json')}`, JSON.stringify(addonNames))

  const judgeSection: string[] = []
  if (judgeYaml !== null) judgeSection.push(`FILE ${judgeYaml}`)

  const addonVersions = JSON.stringify(
    addons.map((addon) => ({
      name: addon.name,
      version: addon.version,
      path: addon.name.startsWith('/') ? addon.name : `${YARN_GLOBAL_DIR}/node_modules/${addon.name}`,
    })),
  )

  const systemdSection = keyValues([
    ['hydrooj', options.systemdHydroActive === true ? 'active' : 'inactive'],
    ['pm2-root', 'active'],
  ])

  const sections = [
    section('meta', metaLines(options, installed)),
    section('hydrodirs', installed ? [`DIR ${homeOf(options, installed)}/.hydro`] : []),
    section('yarn', [installed ? YARN_GLOBAL_DIR : '']),
    section('corepkg', installDirSection),
    section('config', configSection),
    section('addons', addonsSection),
    section('judgectl', judgeSection),
    section('addonversions', [addonVersions]),
    section('pm2', [pm2Json]),
    section('systemd', systemdSection),
    section('docker', options.docker === undefined || options.docker === '' ? [] : [options.docker]),
    section('procs', installed ? ['node /usr/local/share/.config/yarn/global/node_modules/hydrooj/bin/hydrooj.js'] : []),
    section('ports', ports.map((port) => `LISTEN 0 511 127.0.0.1:${String(port)} 0.0.0.0:*`)),
    section('health', health.map((entry) => `${entry.url} ${String(entry.code)} ${String(entry.seconds)}`)),
    section('sandbox', sandboxVersion === null ? [] : [JSON.stringify({ buildVersion: sandboxVersion })]),
    section('marker', marker === null ? [] : [marker]),
    section('done', []),
  ]
  return `${sections.join('\n')}\n`
}

function homeOf(options: ProbeFixtureOptions, installed: boolean): string {
  const uid = options.uid ?? (installed ? '0' : '1000')
  return options.home ?? (uid === '0' ? '/root' : '/home/hydro')
}

/** Host-facts command output used by `collectHydroStatus`. */
export function hostFactsOutput(): string {
  return [
    'hostname=oj',
    'platform=Linux',
    'release=6.1.0-18-amd64',
    'arch=x86_64',
    'node=v22.14.0',
    'uptime=123456.78',
    'load=0.12 0.34 0.56',
    'memfree=1048576',
    'diskfree=20971520',
  ].join('\n')
}

/** Minimal-but-complete {@link HydroProbe} used where a probe is an input. */
export function probeStub(overrides: Partial<import('../../src/ops/types.js').HydroProbe> = {}): import('../../src/ops/types.js').HydroProbe {
  return {
    installed: true,
    installDir: '/usr/local/share/.config/yarn/global/node_modules/hydrooj',
    yarnGlobalDir: '/usr/local/share/.config/yarn/global',
    serviceManager: 'pm2',
    pm2: [
      { name: 'hydrooj', status: 'online', pid: 1001, restarts: 0, uptimeMs: 60_000, execPath: '/srv/hydrooj.js' },
    ],
    hydrooj: {
      name: 'hydrooj',
      version: '5.0.7',
      path: '/usr/local/share/.config/yarn/global/node_modules/hydrooj',
    },
    config: {
      path: '/root/.hydro/config.json',
      uri: 'mongodb://hydro:secretpass@127.0.0.1:27017/hydro',
      database: 'hydro',
      host: '127.0.0.1',
      port: 27017,
    },
    addons: [{ name: '@hydrooj/hydrojudge', version: '4.0.6', path: null }],
    addonNames: ['@hydrooj/hydrojudge'],
    ports: { hydro: 8888, mongo: 27017, sandbox: 5050 },
    health: { status: 200, ok: true, latencyMs: 12 },
    sandbox: { running: true, version: '1.9.4', address: 'http://127.0.0.1:5050' },
    judge: { installed: true, running: true, configPath: '/root/.hydro/judge.yaml' },
    os: { prettyName: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0-18-amd64', arch: 'x86_64' },
    node: { version: 'v22.14.0', path: '/usr/local/bin/node' },
    marker: 'layout=2',
    warnings: [],
    ...overrides,
  }
}
