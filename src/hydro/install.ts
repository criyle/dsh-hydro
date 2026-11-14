/**
 * Non-interactive Hydro installation through the official installer script.
 *
 * The installer (`https://hydro.ac/setup.sh`（旧 `install.sh` 已废弃）) is root-only and
 * still asks two questions (AVX "press Enter", HUSTOJ/UOJ migration "y/n").
 * We download it to a fixed temp file, feed it a slow trickle of `n` lines so
 * both prompts resolve without a TTY, and force `IGNORE_BT=1` + a Chinese
 * locale so the success markers are deterministic.
 *
 * The installer takes several minutes and prints the generated MongoDB
 * password, so the captured log is always redacted and tail-truncated.
 */
import { shellQuote } from '../ssh/shell.js'
import { run } from '../ops/exec.js'
import type { ExecResult } from '../ssh/index.js'
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { OperationResult } from '../shared/types.js'
import { locateHydro, probeHydro } from './detect.js'
import { parsePm2Jlist, redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'

const INSTALL_SCRIPT_PATH = '/tmp/dsh-hydro-install.sh'

/** A full install (nix + mongodb + yarn + pm2) routinely takes 5–20 minutes. */
const INSTALL_TIMEOUT_MS = 30 * 60_000

/** Markers printed by the installer on success (zh + en). */
const SUCCESS_MARKERS = [
  '安装成功',
  '安装已全部完成',
  'Hydro installation completed',
  'Hydro installation succeeded',
]

export interface InstallOptions {
  /** Install only the judge daemon (`--judge`). */
  judge?: boolean
  /** Do not install/start Caddy (`--no-caddy`). */
  noCaddy?: boolean
  /** Run the installer even when Hydro is already installed (e.g. add Caddy/judge). */
  force?: boolean
  /** Bind mongod to 0.0.0.0 (`--expose-db`, dangerous). */
  exposeDb?: boolean
  /** Progress sink; receives human-readable Chinese lines. */
  log?: (line: string) => void
  /** sudo/su password resolved by the caller (never logged). */
  password?: string
  /** Receive installer output live (streaming terminal in the UI). */
  onOutput?: import('./remote.js').OutputSink
}

function installerFlags(options: InstallOptions): string[] {
  const flags: string[] = []
  if (options.judge === true) flags.push('--judge')
  if (options.noCaddy === true) flags.push('--no-caddy')
  if (options.exposeDb === true) flags.push('--expose-db')
  return flags
}

/**
 * Build the remote shell command that downloads and runs the installer.
 *
 * Pure string construction (unit-tested); `installHydro` executes it.
 */
export function buildInstallCommand(installerUrl: string, options: InstallOptions = {}): string {
  const url = shellQuote(installerUrl)
  const flags = installerFlags(options)
  const download = [
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsSL ${url} -o ${INSTALL_SCRIPT_PATH}`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget -qO ${INSTALL_SCRIPT_PATH} ${url}`,
    'else',
    "  echo '缺少 curl/wget，无法下载 Hydro 安装脚本' >&2",
    '  exit 1',
    'fi',
  ].join('\n')
  // Keep stdin open with a trickle of `n` answers: the AVX prompt accepts any
  // line and the migration prompts only migrate on an explicit `y`. The feeder
  // dies with SIGPIPE as soon as the installer exits.
  const feeder = "( while :; do printf 'n\\n'; sleep 1; done ) | "
  // The installer moved from `/install.sh` to `/setup.sh`; the old URL now
  // serves a deprecation stub. Fail with an actionable message instead of
  // reporting a mysterious "no success marker" when a profile still points at
  // the old URL.
  const deprecationCheck = [
    `if grep -q "out of date" ${INSTALL_SCRIPT_PATH} 2>/dev/null || grep -q "不再使用" ${INSTALL_SCRIPT_PATH} 2>/dev/null; then`,
    "  echo 'Hydro 安装脚本地址已废弃（官方已改用 https://hydro.ac/setup.sh），请在插件配置中更新 hydro.installerUrl' >&2",
    '  exit 2',
    'fi',
  ].join('\n')
  const runLine = `${feeder}IGNORE_BT=1 LANG=zh bash ${INSTALL_SCRIPT_PATH}${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`
  return `set -e\n${download}\nchmod +x ${INSTALL_SCRIPT_PATH}\nset +e\n${deprecationCheck}\n${runLine}`
}

/** Command used to verify the install from a root shell (works via elevate). */
export function buildInstallVerifyCommand(port: number): string {
  return `# dsh-hydro-install-verify
PM2J="$(pm2 jlist 2>/dev/null)"
printf 'PM2=%s\\n' "$PM2J"
printf 'HTTP=%s\\n' "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${String(port)}/status 2>/dev/null)"
printf 'MARKER=%s\\n' "$(cat /etc/HYDRO_INSTALLER 2>/dev/null | tr '\\n' ' ')"
printf 'CONFIG=%s\\n' "$(test -f "$HOME/.hydro/config.json" && echo yes || echo no)"
`
}

export interface InstallVerification {
  pm2: ReturnType<typeof parsePm2Jlist>
  httpStatus: number | null
  marker: string | null
  configExists: boolean
}

/** Parse {@link buildInstallVerifyCommand} output (exported for tests). */
export function parseInstallVerification(stdout: string): InstallVerification {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    values.set(line.slice(0, eq).trim(), line.slice(eq + 1))
  }
  const httpRaw = (values.get('HTTP') ?? '').trim()
  const httpStatus = /^\d{3}$/.test(httpRaw) && Number(httpRaw) > 0 ? Number(httpRaw) : null
  const markerRaw = (values.get('MARKER') ?? '').trim()
  return {
    pm2: parsePm2Jlist(values.get('PM2') ?? ''),
    httpStatus,
    marker: markerRaw === '' ? null : markerRaw,
    configExists: (values.get('CONFIG') ?? '').trim() === 'yes',
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function successMarkerIn(text: string): string | null {
  return SUCCESS_MARKERS.find((marker) => text.includes(marker)) ?? null
}

/**
 * Install Hydro on the remote host.
 *
 * Refuses (never throws) when: the account is read-only, Hydro is already
 * installed, the platform is unsupported, or root privileges cannot be
 * obtained without an interactive prompt.
 */
export async function installHydro(
  context: AccountContext,
  options: InstallOptions = {},
): Promise<OperationResult> {
  const report = (line: string): void => {
    try {
      options.log?.(line)
    } catch {
      // A broken progress sink must not abort the install.
    }
    context.log(line)
  }

  if (context.readonly) {
    return { ok: false, message: '只读模式下不允许安装 Hydro。请先关闭只读模式后再试。' }
  }

  let probe: HydroProbe
  try {
    probe = await probeHydro(context)
  } catch (error) {
    return { ok: false, message: `安装前探测远端失败：${errorMessage(error)}` }
  }

  if (probe.installed && options.force !== true) {
    const location = locateHydro(probe)
    return {
      ok: false,
      message: `远端已安装 Hydro${location.version === null ? '' : `（版本 ${location.version}）`}，已拒绝重复安装。如需升级请使用升级功能。`,
      details: { location },
    }
  }

  const arch = probe.os.arch ?? ''
  if (arch !== '' && !/^(?:x86_64|amd64|aarch64|arm64)$/i.test(arch)) {
    return {
      ok: false,
      message: `官方安装脚本不支持当前架构（${arch}），请参考 Hydro 文档手动安装。`,
      details: { arch },
    }
  }
  const pretty = probe.os.prettyName ?? ''
  if (/centos|almalinux|rocky|red hat/i.test(pretty)) {
    return {
      ok: false,
      message: `官方安装脚本不支持 ${pretty}（内核版本过低），请使用 Debian 12 等系统手动安装。`,
      details: { os: pretty },
    }
  }

  const elevationPassword = resolveElevationPassword(context, options.password)
  if (context.account.role !== 'root' && elevationPassword === undefined) {
    let passwordlessSudo = false
    try {
      const sudoProbe = await run(
        context,
        'command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1 && echo yes || echo no',
        { timeoutMs: 10_000 },
      )
      passwordlessSudo = sudoProbe.stdout.trim() === 'yes'
    } catch {
      passwordlessSudo = false
    }
    if (!passwordlessSudo) {
      return {
        ok: false,
        message:
          '安装需要 root 权限：当前 SSH 用户不是 root 且没有免密 sudo。请改用 root 账号连接，或在安装时提供 sudo 密码。',
      }
    }
  }

  const installerUrl = context.config.hydro.installerUrl
  const command = buildInstallCommand(installerUrl, options)
  report(`开始安装 Hydro${options.judge === true ? '（仅评测机）' : ''}，安装过程可能需要 5–20 分钟…`)

  const startedAt = Date.now()
  let result: ExecResult
  try {
    result = await runAsRoot(context, command, {
      ...(elevationPassword === undefined ? {} : { password: elevationPassword }),
      timeoutMs: INSTALL_TIMEOUT_MS,
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    })
  } catch (error) {
    return {
      ok: false,
      message: `安装命令执行失败：${errorMessage(error)}`,
      log: command,
    }
  }

  const rawOutput = `${result.stdout}\n${result.stderr}`
  const marker = successMarkerIn(rawOutput)
  const exitOk = result.code === 0

  // Root-side verification (also works for non-root accounts elevated with a
  // password, where a plain probe cannot read /root files).
  // The installer's very last step (`sysctl -p`) fails inside LXC/containers
  // where /proc/sys is read-only, after pm2 already started Hydro. Verify the
  // actual service state with a few retries so "script exit 1" does not mask a
  // perfectly working install.
  let verification: InstallVerification | null = null
  let after: HydroProbe | null = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const verifyResult = await runAsRoot(context, buildInstallVerifyCommand(context.config.hydro.port), {
        ...(elevationPassword === undefined ? {} : { password: elevationPassword }),
        timeoutMs: 60_000,
      })
      verification = parseInstallVerification(verifyResult.stdout)
    } catch {
      verification = null
    }
    try {
      after = await probeHydro(context)
    } catch {
      after = null
    }
    const ready =
      verification?.pm2.some((entry) => entry.name === 'hydrooj' && entry.status === 'online') === true &&
      (verification?.httpStatus ?? 0) >= 200 &&
      (verification?.httpStatus ?? 0) < 400 &&
      verification?.configExists === true
    const evidence =
      verification !== null &&
      ((verification.pm2?.length ?? 0) > 0 || (verification.httpStatus ?? 0) > 0 || verification.configExists)
    if (ready || (exitOk && marker !== null)) break
    // A failed installer with no evidence of a running service will not improve;
    // do not burn 40 seconds on it.
    if (!evidence && attempt >= 1) break
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }

  const pm2Online =
    verification?.pm2.some((entry) => entry.name === 'hydrooj' && entry.status === 'online') ??
    false
  const verifyStatus = verification?.httpStatus ?? null
  const healthOk =
    verifyStatus !== null ? verifyStatus >= 200 && verifyStatus < 400 : (after?.health.ok ?? false)
  const verified = pm2Online || healthOk
  const verificationAvailable = verification !== null || after !== null
  const configExists = verification?.configExists ?? after?.installed ?? false
  // Strong evidence wins over the script's exit code: the official installer
  // runs a trailing `sysctl -p` that containers refuse, yet Hydro is installed
  // and serving requests. `marker` alone is not required then.
  const serviceVerified = pm2Online && healthOk && configExists
  const ok = (exitOk && marker !== null && (!verificationAvailable || verified)) || serviceVerified
  const lateFailure = ok && !exitOk

  const output = tailText(redactSensitive(rawOutput), 8000)
  const containerSysctl = /sysctl/i.test(rawOutput) && /permission denied|read-only/i.test(rawOutput)
  const details = {
    exitCode: result.code,
    durationMs: Date.now() - startedAt,
    successMarker: marker,
    installed: after?.installed ?? verification?.configExists ?? false,
    pm2Online,
    health: after?.health ?? {
      status: verification?.httpStatus ?? null,
      ok: healthOk,
      latencyMs: null,
    },
    configExists,
    lateFailure,
    containerSysctl,
    location: after === null ? null : locateHydro(after),
    command,
  }

  if (ok) {
    const version = after?.hydrooj?.version ?? null
    if (lateFailure) {
      const hint = containerSysctl
        ? '安装脚本最后一步 `sysctl -p` 在容器内因 /proc/sys 只读而失败（LXC/容器常见），但 Hydro 已安装并正常响应，可以忽略。'
        : `安装脚本退出码 ${String(result.code)}，但 Hydro 已安装并正常响应。`
      report(`Hydro 安装成功（安装脚本尾部报错，已忽略）。`)
      return {
        ok: true,
        message: `Hydro 安装成功${version === null ? '' : `（版本 ${version}）`}${healthOk ? '，健康检查通过' : ''}。注意：${hint}`,
        details,
        log: output,
      }
    }
    report('Hydro 安装成功。')
    return {
      ok: true,
      message: `Hydro 安装成功${version === null ? '' : `（版本 ${version}）`}${
        healthOk ? '，健康检查通过' : ''
      }。`,
      details,
      log: output,
    }
  }

  const reasons: string[] = []
  if (!exitOk) reasons.push(`安装脚本退出码 ${String(result.code)}`)
  if (marker === null) reasons.push('未看到安装成功标记')
  if (verificationAvailable && !verified) reasons.push('pm2 进程或 HTTP 健康检查未通过')
  return {
    ok: false,
    message: `Hydro 安装未成功：${reasons.length === 0 ? '未知原因' : reasons.join('；')}。请检查下方日志。`,
    details,
    log: output,
  }
}
