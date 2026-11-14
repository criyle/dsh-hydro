/**
 * Advanced Nix maintenance actions: configure the substituter mirror and
 * upgrade nix-profile managed node / go-judge.
 *
 * These are deliberately explicit (confirm=true) and keep a nix.conf backup.
 * Package upgrades remove and reinstall the profile entry; on failure the
 * previous store path is restored and the error is reported.
 */
import type { AccountContext } from '../ops/types.js'
import type { OperationResult } from '../shared/types.js'
import { redactSensitive, resolveElevationPassword, runAsRoot, tailText } from './remote.js'

const NIX_TIMEOUT_MS = 20 * 60_000

export type NixAction =
  | { action: 'set-mirror'; mirror: string }
  | { action: 'upgrade-package'; package: 'nodejs' | 'go-judge' }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validMirror(mirror: string): boolean {
  const parts = mirror.trim().split(/\s+/)
  if (parts.length === 0) return false
  return parts.every((part) => /^https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(part))
}

function mirrorCommand(mirror: string): string {
  return [
    'set -e',
    'cp -f /etc/nix/nix.conf /etc/nix/nix.conf.dsh-hydro.bak 2>/dev/null || true',
    `grep -v '^substituters' /etc/nix/nix.conf 2>/dev/null > /tmp/nix.conf.dsh-hydro || true`,
    `printf 'substituters = %s\\n' ${JSON.stringify(mirror)} >> /tmp/nix.conf.dsh-hydro`,
    'mv /tmp/nix.conf.dsh-hydro /etc/nix/nix.conf',
    'systemctl restart nix-daemon 2>/dev/null || true',
    'grep \'^substituters\' /etc/nix/nix.conf',
  ].join('; ')
}

function upgradeCommand(pkg: 'nodejs' | 'go-judge'): string {
  const binary = pkg === 'nodejs' ? 'node' : 'go-judge'
  const restart = pkg === 'nodejs'
    ? 'pm2 restart hydrooj 2>/dev/null || true'
    : 'pm2 restart hydro-sandbox hydrojudge 2>/dev/null || true'
  return [
    'set -e',
    `OLD=$(readlink -f "$(command -v ${binary})" 2>/dev/null || true)`,
    `nix profile remove ${pkg} || true`,
    `if ! nix profile install "nixpkgs#${pkg}"; then`,
    '  echo "install failed; rolling back" >&2',
    '  if [ -n "$OLD" ]; then nix profile install "$OLD" || true; fi',
    '  exit 1;',
    'fi',
    `hash -r; ${binary} --version 2>/dev/null || true`,
    restart,
  ].join('\n')
}

/** Execute one Nix maintenance action. */
export async function nixMaintenance(context: AccountContext, action: NixAction): Promise<OperationResult> {
  if (context.readonly) {
    return { ok: false, message: '全局只读已开启，拒绝执行 Nix 维护操作。' }
  }
  let command: string
  if (action.action === 'set-mirror') {
    if (!validMirror(action.mirror)) {
      return { ok: false, message: '镜像地址必须是 http(s) URL（多个用空格分隔）' }
    }
    command = mirrorCommand(action.mirror)
  } else {
    if (action.package !== 'nodejs' && action.package !== 'go-judge') {
      return { ok: false, message: '仅支持更新 nodejs 或 go-judge' }
    }
    command = upgradeCommand(action.package)
  }
  const password = resolveElevationPassword(context)
  context.log(`$ ${action.action === 'set-mirror' ? 'set nix mirror' : `upgrade nix ${action.package}`}`)
  try {
    const result = await runAsRoot(context, command, {
      ...(password === undefined ? {} : { password }),
      timeoutMs: NIX_TIMEOUT_MS,
    })
    const output = redactSensitive(`${result.stdout}\n${result.stderr}`)
    return {
      ok: result.code === 0,
      message: result.code === 0
        ? action.action === 'set-mirror' ? 'Nix 镜像已更新' : `${action.package} 已更新`
        : `Nix 操作失败（退出码 ${String(result.code)}）`,
      log: tailText(output, 8000),
    }
  } catch (error) {
    return { ok: false, message: `Nix 操作失败：${errorMessage(error)}` }
  }
}
