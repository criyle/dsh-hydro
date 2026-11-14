/**
 * Remote Hydro probe: one batched POSIX-shell script over SSH, parsed locally.
 *
 * The probe never runs `hydrooj --version` (that command is not registered and
 * may start the server) and never calls `hydrooj diag` (it uploads a report).
 * Versions come from the yarn global `package.json` and `~/.hydro/addon.json`.
 */
import { shellQuote } from '../ssh/shell.js'
import { run } from '../ops/exec.js'
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { HydroLocation } from '../shared/types.js'
import { parseVersion } from './versions.js'
import {
  parseHydroConfig,
  parsePm2Jlist,
  parseYarnGlobalDir,
  resolveElevationPassword,
  runAsRoot,
  tailText,
} from './remote.js'

/** Marker that starts a section in the probe output. */
const SECTION_MARKER = '__DSH_HYDRO_SECTION__'

/** Default Hydro HTTP port when nothing else was detected. */
const DEFAULT_HYDRO_PORT = 8888

interface ProbeDefaults {
  /** `config.hydro.port`; 0 means "detect". */
  hydroPort?: number | null
}

interface Section {
  name: string
  arg: string
  lines: string[]
}

/** Split the probe output into `###name [arg]` sections. */
function parseSections(stdout: string): Map<string, Section[]> {
  const sections = new Map<string, Section[]>()
  let current: Section | null = null
  // Payloads may not end with a newline (`printf '%s' "$PM2J"`, a config.json
  // written without a trailing newline), which would glue the next section
  // marker onto the payload's last line. Split on the marker itself so a
  // section is found regardless of where the previous payload ended.
  const normalized = stdout.split(SECTION_MARKER).join(`\n${SECTION_MARKER}`)
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith(`${SECTION_MARKER} `)) {
      const rest = line.slice(SECTION_MARKER.length + 1).trim()
      const space = rest.indexOf(' ')
      const name = space === -1 ? rest : rest.slice(0, space)
      const arg = space === -1 ? '' : rest.slice(space + 1).trim()
      current = { name, arg, lines: [] }
      const list = sections.get(name)
      if (list === undefined) sections.set(name, [current])
      else list.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return sections
}

function sectionOf(sections: Map<string, Section[]>, name: string): Section | undefined {
  return sections.get(name)?.[0]
}

function sectionText(sections: Map<string, Section[]>, name: string): string {
  const section = sectionOf(sections, name)
  return section === undefined ? '' : section.lines.join('\n').trim()
}

/** Split a section whose first line is `PREFIX value` from the rest. */
function prefixPayload(
  sections: Map<string, Section[]>,
  name: string,
  prefix: string,
): { value: string | null; body: string } {
  const section = sectionOf(sections, name)
  if (section === undefined) return { value: null, body: '' }
  let value: string | null = null
  const body: string[] = []
  for (const line of section.lines) {
    if (value === null && line.startsWith(`${prefix} `)) {
      value = line.slice(prefix.length + 1).trim()
      continue
    }
    body.push(line)
  }
  return { value, body: body.join('\n').trim() }
}

function parseJson<T>(text: string): T | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return null
  }
}

function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return values
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toPort(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return parsed > 0 && parsed <= 65535 ? parsed : null
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) ? parsed : null
}

interface CorePackage {
  name?: unknown
  version?: unknown
}

interface AddonVersionEntry {
  name: string
  version: string | null
  path: string | null
}

function parseAddonNames(text: string): string[] {
  const data = parseJson<unknown>(text)
  if (!Array.isArray(data)) return []
  return data.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

function parseAddonVersions(text: string): AddonVersionEntry[] {
  const data = parseJson<unknown>(text)
  if (!Array.isArray(data)) return []
  const result: AddonVersionEntry[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name === '') continue
    result.push({
      name: record.name,
      version: typeof record.version === 'string' ? record.version : null,
      path: typeof record.path === 'string' ? record.path : null,
    })
  }
  return result
}

function parseHealthSection(text: string): { health: HydroProbe['health']; port: number | null } {
  const lines: Array<{ url: string; port: number | null; code: number | null; latencyMs: number | null }> = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const url = parts[0] ?? ''
    if (!/^https?:\/\//.test(url)) continue
    const code = toNumber(parts[1])
    const seconds = toNumber(parts[2] ?? null)
    const portMatch = /:(\d+)\//.exec(url)
    lines.push({
      url,
      port: portMatch?.[1] === undefined ? null : toPort(portMatch[1]),
      code: code === null || code < 100 ? null : code,
      latencyMs: seconds === null || code === null || code < 100 ? null : Math.round(seconds * 1000),
    })
  }
  const ok = lines.find((entry) => entry.code !== null && entry.code >= 200 && entry.code < 400)
  const chosen = ok ?? lines.find((entry) => entry.code !== null) ?? null
  if (chosen === null) {
    return { health: { status: null, ok: false, latencyMs: null }, port: null }
  }
  return {
    health: {
      status: chosen.code,
      ok: chosen.code !== null && chosen.code >= 200 && chosen.code < 400,
      latencyMs: chosen.latencyMs,
    },
    port: chosen.port,
  }
}

/** Ports seen listening in the `ss`/`netstat` section. */
function parseListenPorts(text: string): Set<number> {
  const ports = new Set<number>()
  const pattern = /:(\d{2,5})\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const port = match[1] === undefined ? null : toPort(match[1])
    if (port !== null) ports.add(port)
  }
  return ports
}

/**
 * Parse the stdout of {@link buildProbeScript} into a {@link HydroProbe}.
 *
 * Exported for tests; production callers use {@link probeHydro}.
 */
export function parseProbeOutput(stdout: string, defaults: ProbeDefaults = {}): HydroProbe {
  const sections = parseSections(stdout)
  const meta = parseKeyValues(sectionText(sections, 'meta'))
  const warnings: string[] = []

  const yarnGlobalDir = parseYarnGlobalDir(sectionText(sections, 'yarn'))
  const core = prefixPayload(sections, 'corepkg', 'DIR')
  const corePackage = parseJson<CorePackage>(core.body)
  const coreVersion = corePackage !== null && typeof corePackage.version === 'string' ? corePackage.version : null
  const coreName = corePackage !== null && typeof corePackage.name === 'string' ? corePackage.name : null
  const coreDir = nonEmpty(core.value) ?? null

  const configSection = prefixPayload(sections, 'config', 'FILE')
  const configBody = configSection.body === '' ? null : configSection.body
  const parsedConfig = parseHydroConfig(configBody)
  const configPath = nonEmpty(configSection.value)
  const config =
    configPath !== null || (configBody !== null && parsedConfig.uri !== null)
      ? {
          path: configPath,
          uri: parsedConfig.uri,
          database: parsedConfig.database,
          host: parsedConfig.host,
          port: parsedConfig.port,
        }
      : null

  const addonSection = prefixPayload(sections, 'addons', 'FILE')
  const addonNames = parseAddonNames(addonSection.body)
  const addonVersionEntries = parseAddonVersions(sectionText(sections, 'addonversions'))
  const addonMap = new Map<string, { name: string; version: string | null; path: string | null }>()
  for (const name of addonNames) addonMap.set(name, { name, version: null, path: null })
  for (const entry of addonVersionEntries) {
    addonMap.set(entry.name, { name: entry.name, version: entry.version, path: entry.path })
  }
  const addons = [...addonMap.values()]

  const pm2 = parsePm2Jlist(sectionText(sections, 'pm2'))
  const marker = nonEmpty(sectionText(sections, 'marker'))
  const hydroojCli = nonEmpty(meta.get('hydrooj'))
  const pm2Binary = nonEmpty(meta.get('pm2'))

  const isHydroProcessName = (name: string): boolean =>
    name === 'hydrooj' || name.includes('hydrooj')
  const pm2Hydro = pm2.find((entry) => isHydroProcessName(entry.name)) ?? null
  const pm2Judge = pm2.find((entry) => entry.name.includes('hydrojudge')) ?? null
  const pm2Sandbox = pm2.find((entry) => entry.name.includes('sandbox')) ?? null

  const installed =
    marker !== null ||
    config !== null ||
    coreVersion !== null ||
    coreDir !== null ||
    hydroojCli !== null ||
    pm2.some((entry) => isHydroProcessName(entry.name))

  const systemd = parseKeyValues(sectionText(sections, 'systemd'))
  const systemdHydroActive = systemd.get('hydrooj') === 'active'
  const dockerText = sectionText(sections, 'docker')
  const dockerDetected = /oj-backend|hydro/i.test(dockerText)
  const procsText = sectionText(sections, 'procs')

  let serviceManager: HydroProbe['serviceManager'] = 'unknown'
  const pm2ReportsHydro = pm2.some(
    (entry) => isHydroProcessName(entry.name) || entry.name === 'mongodb' || entry.name === 'caddy',
  )
  if (pm2ReportsHydro) serviceManager = 'pm2'
  else if (systemdHydroActive) serviceManager = 'systemd'
  else if (dockerDetected) serviceManager = 'docker'
  else if (pm2Binary !== null && installed) serviceManager = 'pm2'
  else if (installed && /hydrooj|hydrojudge|hydro-sandbox|mongod|caddy/i.test(procsText)) serviceManager = 'manual'
  else if (installed) serviceManager = 'manual'

  const listenPorts = parseListenPorts(sectionText(sections, 'ports'))
  const parsedHealth = parseHealthSection(sectionText(sections, 'health'))
  const health = parsedHealth.health
  const healthPort = parsedHealth.port

  const overridePort = toPort(meta.get('port')) ?? defaults.hydroPort ?? null
  let hydroPort: number | null = null
  if (overridePort !== null && overridePort > 0) hydroPort = overridePort
  else if (listenPorts.has(DEFAULT_HYDRO_PORT)) hydroPort = DEFAULT_HYDRO_PORT
  else if (health.ok && healthPort !== null) hydroPort = healthPort
  else if (installed) hydroPort = DEFAULT_HYDRO_PORT

  const sandboxText = sectionText(sections, 'sandbox')
  const sandboxVersion = (() => {
    const data = parseJson<Record<string, unknown>>(sandboxText)
    if (data !== null && typeof data.buildVersion === 'string') {
      return parseVersion(data.buildVersion) ?? data.buildVersion
    }
    const direct = /go-judge[^\d]*(\d+\.\d+\.\d+\S*)/i.exec(sandboxText)
    return direct?.[1] === undefined ? null : parseVersion(direct[1]) ?? direct[1]
  })()
  const sandboxRunning = sandboxVersion !== null || pm2Sandbox?.status === 'online'

  const judgeConfig = prefixPayload(sections, 'judgectl', 'FILE').value
  const judgeAddonInstalled = addons.some((entry) => entry.name.includes('hydrojudge'))
  const judgeInstalled = judgeAddonInstalled || nonEmpty(judgeConfig) !== null || pm2Judge !== null
  const judgeRunning =
    pm2Judge?.status === 'online' || (pm2Hydro?.status === 'online' && judgeAddonInstalled)
  const caddyBinary = nonEmpty(meta.get('caddy'))
  const hasCaddy = pm2.some((entry) => entry.name.toLowerCase().includes('caddy')) || caddyBinary !== null
  const hasMongo = pm2.some((entry) => entry.name.toLowerCase().includes('mongodb') || entry.name.toLowerCase() === 'mongod')
    || config?.uri !== null && config?.uri !== undefined
  const hasWeb = config !== null || coreVersion !== null || coreDir !== null || hydroojCli !== null || pm2Hydro !== null
  const installMode: HydroProbe['installMode'] = hasWeb && judgeInstalled ? 'web+judge'
    : hasWeb ? 'web'
      : judgeInstalled ? 'judge' : 'none'

  const nodePath = nonEmpty(meta.get('node'))
  const nodeVersion = nonEmpty(meta.get('nodever'))
  const os = {
    prettyName: nonEmpty(meta.get('pretty')),
    kernel: nonEmpty(meta.get('kernel')),
    arch: nonEmpty(meta.get('arch')),
  }

  const uid = nonEmpty(meta.get('uid'))
  const sudoToken = nonEmpty(meta.get('sudo'))
  if (nodePath === null) warnings.push('未在远端 PATH 中找到 node（Hydro 需要 Node.js >= 22）')
  if (uid !== null && uid !== '0' && sudoToken !== 'yes') {
    warnings.push('当前 SSH 用户不是 root 且没有免密 sudo，pm2/配置文件探测可能不完整')
  }
  if (installed && coreVersion === null) {
    warnings.push('无法读取 hydrooj 的 package.json，核心版本未知')
  }
  if (installed && config === null) {
    warnings.push('未找到 ~/.hydro/config.json，MongoDB 连接串未知')
  }
  if (installed && yarnGlobalDir === null) {
    warnings.push('未找到 yarn global dir，插件版本探测可能不完整')
  }
  if (installed && !health.ok) {
    warnings.push('Hydro 健康检查未通过（/status 未返回 2xx/3xx）')
  }
  const pm2Raw = sectionText(sections, 'pm2')
  if (pm2Raw !== '') {
    if (pm2.length === 0) warnings.push('pm2 jlist 输出无法解析')
  }
  if (installed && coreDir === null && hydroojCli === null) {
    warnings.push('未定位到 Hydro 安装目录')
  }

  return {
    installed,
    installDir: coreDir,
    yarnGlobalDir,
    serviceManager,
    pm2,
    hydrooj:
      coreVersion !== null || coreDir !== null
        ? { name: coreName ?? 'hydrooj', version: coreVersion, path: coreDir }
        : coreName !== null
          ? { name: coreName, version: null, path: coreDir }
          : null,
    config,
    addons,
    addonNames,
    ports: {
      hydro: hydroPort,
      mongo: config !== null ? config.port : null,
      sandbox: sandboxRunning ? 5050 : null,
    },
    health,
    sandbox: {
      running: sandboxRunning,
      version: sandboxVersion,
      address: sandboxRunning ? 'http://127.0.0.1:5050' : null,
    },
    judge: {
      installed: judgeInstalled,
      running: judgeRunning,
      configPath: nonEmpty(judgeConfig),
    },
    installMode,
    components: {
      web: hasWeb,
      judge: judgeInstalled,
      caddy: hasCaddy,
      mongo: hasMongo,
      sandbox: sandboxRunning,
    },
    os,
    node: { version: nodeVersion, path: nodePath },
    marker,
    warnings,
  }
}

/**
 * Build the single batched shell script that feeds {@link parseProbeOutput}.
 *
 * POSIX sh only. Optional `sudo -n` is attempted for root-owned files so a
 * non-root account with passwordless sudo still gets a complete probe.
 */
export function buildProbeScript(context: AccountContext): string {
  const installDirOverride = shellQuote(context.config.hydro.installDir.trim())
  const portOverride = String(context.config.hydro.port > 0 ? context.config.hydro.port : '')
  const healthUrls = [
    `http://127.0.0.1:${String(context.config.hydro.port > 0 ? context.config.hydro.port : DEFAULT_HYDRO_PORT)}/status`,
    'http://127.0.0.1/status',
  ]
    .filter((url, index, all) => all.indexOf(url) === index)
    .map((url) => shellQuote(url))
    .join(' ')

  return `set +e
MARK='${SECTION_MARKER}'
sec() { printf '%s %s\\n' "$MARK" "$1"; }
kv() { printf '%s=%s\\n' "$1" "$2"; }
UID_="$(id -u 2>/dev/null)"
USER_="$(id -un 2>/dev/null)"
HOME_="\${HOME:-/root}"
SUDO_OK=no
if [ "$UID_" != "0" ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then SUDO_OK=yes; fi
read_file() {
  if [ -r "$1" ]; then cat "$1" 2>/dev/null; printf '\n'; return 0; fi
  if [ "$UID_" != "0" ] && [ "$SUDO_OK" = yes ]; then sudo -n cat "$1" 2>/dev/null; printf '\n'; return 0; fi
  return 1
}
file_exists() {
  if [ -f "$1" ]; then return 0; fi
  if [ "$UID_" != "0" ] && [ "$SUDO_OK" = yes ]; then sudo -n test -f "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}
dir_exists() {
  if [ -d "$1" ]; then return 0; fi
  if [ "$UID_" != "0" ] && [ "$SUDO_OK" = yes ]; then sudo -n test -d "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}
INSTALL_DIR_OVERRIDE=${installDirOverride}
PORT_OVERRIDE=${shellQuote(portOverride)}
ROOT_HOME=/root
if [ "$UID_" = "0" ]; then ROOT_HOME="$HOME_"; fi
sec meta
kv uid "$UID_"
kv user "$USER_"
kv home "$HOME_"
kv roothome "$ROOT_HOME"
kv sudo "$SUDO_OK"
kv uname "$(uname -s 2>/dev/null)"
kv kernel "$(uname -r 2>/dev/null)"
kv arch "$(uname -m 2>/dev/null)"
kv hostname "$(uname -n 2>/dev/null)"
kv pretty "$(. /etc/os-release 2>/dev/null; printf '%s' "\${PRETTY_NAME:-}")"
kv node "$(command -v node 2>/dev/null)"
kv nodever "$(node -v 2>/dev/null)"
kv yarn "$(command -v yarn 2>/dev/null)"
kv yarnver "$(yarn --version 2>/dev/null)"
kv pm2 "$(command -v pm2 2>/dev/null)"
kv hydrooj "$(command -v hydrooj 2>/dev/null)"
kv mongosh "$(command -v mongosh 2>/dev/null)"
kv caddy "$(command -v caddy 2>/dev/null)"
kv systemctl "$(command -v systemctl 2>/dev/null)"
kv docker "$(command -v docker 2>/dev/null)"
kv curl "$(command -v curl 2>/dev/null)"
kv installdir "$INSTALL_DIR_OVERRIDE"
kv port "$PORT_OVERRIDE"
sec hydrodirs
for d in "$HOME_/.hydro" "$ROOT_HOME/.hydro" "$INSTALL_DIR_OVERRIDE"; do
  if [ -n "$d" ] && dir_exists "$d"; then printf 'DIR %s\\n' "$d"; fi
done
sec yarn
YGD="$(yarn global dir 2>/dev/null | grep '^/' | tail -n 1)"
if [ -z "$YGD" ] && [ "$SUDO_OK" = yes ]; then YGD="$(sudo -n yarn global dir 2>/dev/null | grep '^/' | tail -n 1)"; fi
if [ -z "$YGD" ] && [ -d /usr/local/share/.config/yarn/global ]; then YGD=/usr/local/share/.config/yarn/global; fi
printf '%s\\n' "$YGD"
sec corepkg
CORE=""
if [ -n "$INSTALL_DIR_OVERRIDE" ] && file_exists "$INSTALL_DIR_OVERRIDE/package.json"; then CORE="$INSTALL_DIR_OVERRIDE"; fi
if [ -z "$CORE" ] && [ -n "$YGD" ] && file_exists "$YGD/node_modules/hydrooj/package.json"; then CORE="$YGD/node_modules/hydrooj"; fi
if [ -z "$CORE" ]; then
  CLI="$(command -v hydrooj 2>/dev/null)"
  if [ -n "$CLI" ]; then
    RP="$(readlink -f "$CLI" 2>/dev/null)"; [ -z "$RP" ] && RP="$CLI"
    C1="$(dirname "$(dirname "$RP")")"
    if file_exists "$C1/package.json"; then CORE="$C1"; fi
  fi
fi
if [ -z "$CORE" ] && file_exists /usr/local/share/.config/yarn/global/node_modules/hydrooj/package.json; then
  CORE=/usr/local/share/.config/yarn/global/node_modules/hydrooj
fi
if [ -n "$CORE" ]; then printf 'DIR %s\\n' "$CORE"; read_file "$CORE/package.json"; fi
sec config
for f in "$HOME_/.hydro/config.json" "$ROOT_HOME/.hydro/config.json" /root/.hydro/config.json; do
  if file_exists "$f"; then printf 'FILE %s\\n' "$f"; read_file "$f"; break; fi
done
sec addons
ADDON_PATH=""
for f in "$HOME_/.hydro/addon.json" "$ROOT_HOME/.hydro/addon.json" /root/.hydro/addon.json; do
  if file_exists "$f"; then printf 'FILE %s\\n' "$f"; ADDON_PATH="$f"; read_file "$f"; break; fi
done
sec judgectl
for f in "$HOME_/.hydro/judge.yaml" "$ROOT_HOME/.hydro/judge.yaml" /root/.hydro/judge.yaml; do
  if file_exists "$f"; then printf 'FILE %s\\n' "$f"; fi
done
sec addonversions
ADDONS_JSON=""
if [ -n "$ADDON_PATH" ]; then ADDONS_JSON="$(read_file "$ADDON_PATH")"; fi
export DSH_ADDONS_JSON="$ADDONS_JSON"
export DSH_YGD="$YGD"
export DSH_ADDON_DIR_1="$HOME_/.hydro/addons"
export DSH_ADDON_DIR_2="$ROOT_HOME/.hydro/addons"
export DSH_ADDON_DIR_3="$INSTALL_DIR_OVERRIDE"
if command -v node >/dev/null 2>&1; then
node <<'NODE'
const fs = require('fs');
const path = require('path');
let list = [];
try { list = JSON.parse(process.env.DSH_ADDONS_JSON || '[]'); } catch (e) { list = []; }
if (!Array.isArray(list)) list = [];
const yarnDir = process.env.DSH_YGD || '';
const addonDirs = [process.env.DSH_ADDON_DIR_1, process.env.DSH_ADDON_DIR_2, process.env.DSH_ADDON_DIR_3].filter(Boolean);
const out = [];
for (const entry of list) {
  if (typeof entry !== 'string' || entry === '') continue;
  const candidates = [];
  if (entry.startsWith('/')) {
    candidates.push(path.join(entry, 'package.json'), entry);
  } else if (yarnDir) {
    candidates.push(path.join(yarnDir, 'node_modules', entry, 'package.json'));
  }
  for (const dir of addonDirs) {
    candidates.push(path.join(dir, path.basename(entry), 'package.json'));
  }
  let found = null;
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { found = candidate; break; }
    } catch (e) { /* ignore */ }
  }
  let version = null;
  let realPath = entry.startsWith('/') ? entry : null;
  if (found) {
    try {
      const pkg = JSON.parse(fs.readFileSync(found, 'utf8'));
      version = typeof pkg.version === 'string' ? pkg.version : null;
      realPath = path.dirname(found);
    } catch (e) { /* ignore */ }
  }
  out.push({ name: entry, version, path: realPath });
}
process.stdout.write(JSON.stringify(out));
NODE
fi
sec pm2
PM2J_LOCAL="$(pm2 jlist 2>/dev/null)"
PM2J_ROOT=""
if [ "$UID_" != "0" ] && [ "$SUDO_OK" = yes ]; then PM2J_ROOT="$(sudo -n pm2 jlist 2>/dev/null)"; fi
if [ -n "$PM2J_ROOT" ] && [ "$PM2J_ROOT" != "[]" ]; then PM2J="$PM2J_ROOT"; else PM2J="$PM2J_LOCAL"; fi
printf '%s' "$PM2J" | head -c 60000
sec systemd
if command -v systemctl >/dev/null 2>&1; then
  kv hydrooj "$(systemctl is-active hydrooj 2>/dev/null)"
  kv pm2-root "$(systemctl is-active pm2-root 2>/dev/null)"
fi
sec docker
if command -v docker >/dev/null 2>&1; then docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | head -n 20; fi
sec procs
ps -eo args 2>/dev/null | grep -E 'hydrooj|hydrojudge|hydro-sandbox|mongod|caddy' | grep -v grep | head -n 25
sec ports
(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E ':(80|8888|5050|27017)\\b' | head -n 25
sec health
for u in ${healthUrls}; do
  if command -v curl >/dev/null 2>&1; then
    printf '%s %s\\n' "$u" "$(curl -sS -m 4 -o /dev/null -w '%{http_code} %{time_total}' "$u" 2>/dev/null)"
  fi
done
sec sandbox
if command -v curl >/dev/null 2>&1; then curl -sS -m 4 http://127.0.0.1:5050/version 2>/dev/null | head -c 800; fi
sec marker
read_file /etc/HYDRO_INSTALLER
sec done
`
}

/**
 * Run the batched probe over the account's SSH connection.
 *
 * Throws only when the transport/probe itself fails (callers such as
 * `collectHydroStatus` degrade gracefully).
 */
export async function probeHydro(context: AccountContext): Promise<HydroProbe> {
  const script = buildProbeScript(context)
  const timeoutMs = Math.min(context.config.commandTimeoutMs, 30_000)
  // Root-owned pm2/nix/yarn state is invisible to a non-root SSH user, so when
  // an elevation password is stored run the whole probe as root.
  const elevationPassword =
    context.account.role === 'root' ? undefined : resolveElevationPassword(context)
  const result =
    elevationPassword === undefined
      ? await run(context, script, { timeoutMs })
      : await runAsRoot(context, script, { password: elevationPassword, timeoutMs })
  if (!result.stdout.includes(SECTION_MARKER)) {
    throw new Error(`远端探测没有返回可解析结果：${tailText(result.stderr || result.stdout, 800) || '(无输出)'}`)
  }
  const probe = parseProbeOutput(result.stdout, {
    hydroPort: context.config.hydro.port > 0 ? context.config.hydro.port : null,
  })
  if (result.timedOut) probe.warnings.push('探测脚本执行超时，结果可能不完整')
  if (result.code !== null && result.code !== 0) {
    probe.warnings.push(`探测脚本退出码异常（${String(result.code)}）`)
  }
  return probe
}

/** Build the secret-free {@link HydroLocation} persisted on the account. */
export function locateHydro(probe: HydroProbe): HydroLocation {
  const hydroProc =
    probe.pm2.find((entry) => entry.name === 'hydrooj' || entry.name.includes('hydrooj')) ?? null
  const serviceName =
    hydroProc?.name ??
    (probe.installed ? (probe.hydrooj?.name ?? 'hydrooj') : null)
  return {
    installed: probe.installed,
    installMode: probe.installMode,
    installDir: probe.installDir,
    serviceManager: probe.serviceManager,
    serviceName,
    port: probe.ports.hydro,
    domain: null,
    version: probe.hydrooj?.version ?? null,
  }
}

/** True when the probe found a Hydro install. */
export function isHydroInstalled(probe: HydroProbe): boolean {
  return probe.installed
}
