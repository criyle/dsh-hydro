/**
 * Package inventory for the interactive upgrade page (yarn-global Hydro core /
 * plugins) plus node/go-judge/nix facts for the advanced maintenance section.
 */
import type { AccountContext, HydroProbe } from '../ops/types.js'
import type { PackageListResponse, PackageSummary } from '../shared/api.js'
import { probeHydro } from './detect.js'
import { run } from '../ops/exec.js'
import { fetchLatestVersions } from './registry.js'
import { isUpdateAvailable } from './versions.js'
import { isNpmPackageName } from './remote.js'

const INFO_COMMAND = [
  'echo "NODE=$(node -v 2>/dev/null)"',
  'echo "NODEPATH=$(readlink -f "$(command -v node)" 2>/dev/null)"',
  'echo "GOJUDGEPATH=$(readlink -f "$(command -v go-judge)" 2>/dev/null)"',
  'echo "NIXCONF=$(grep \'^substituters\' /etc/nix/nix.conf 2>/dev/null | head -1)"',
].join('; ')

function parseInfo(text: string): Record<string, string> {
  const info: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    info[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return info
}

/** Collect upgradeable yarn packages and node/go-judge/nix facts. */
export async function collectPackages(context: AccountContext, probe?: HydroProbe): Promise<PackageListResponse> {
  const resolved = probe ?? (await probeHydro(context))
  const infoResult = await run(context, INFO_COMMAND, { timeoutMs: 15_000 }).catch(() => null)
  const info = infoResult === null ? {} : parseInfo(`${infoResult.stdout}\n${infoResult.stderr}`)

  const names: string[] = []
  const current: Record<string, string | null> = {}
  if (resolved.hydrooj?.name !== undefined) {
    names.push(resolved.hydrooj.name)
    current[resolved.hydrooj.name] = resolved.hydrooj.version
  } else {
    names.push('hydrooj')
    current.hydrooj = null
  }
  for (const addon of resolved.addons) {
    current[addon.name] = addon.version
    if (isNpmPackageName(addon.name)) names.push(addon.name)
  }
  let latest: Record<string, string | null> = {}
  try {
    latest = await fetchLatestVersions([...new Set(names)], context.config.npmRegistry)
  } catch {
    latest = {}
  }
  const packages: PackageSummary[] = [...new Set(names)].map((name) => {
    const version = current[name] ?? null
    const latestVersion = latest[name] ?? null
    return {
      name,
      kind: name === 'hydrooj' || name.startsWith('@hydrooj/') ? 'core' : 'plugin',
      current: version,
      latest: latestVersion,
      updateAvailable: isUpdateAvailable(version, latestVersion),
    }
  })
  const nodeVersion = info.NODE?.replace(/^v/, '') ?? null
  const goJudgeVersion = resolved.sandbox.version
  return {
    packages,
    node: {
      version: nodeVersion,
      latest: null,
      managedByNix: (info.NODEPATH ?? '').startsWith('/nix/store/'),
    },
    goJudge: goJudgeVersion === null
      ? null
      : {
          version: goJudgeVersion,
          managedByNix: (info.GOJUDGEPATH ?? '').startsWith('/nix/store/'),
        },
    nix: { substituters: (info.NIXCONF ?? '').replace(/^substituters\s*=\s*/, '').trim() },
    collectedAt: new Date().toISOString(),
  }
}
