/**
 * Build the Host half into a self-contained ESM entry.
 *
 * tsc first emits declarations, then esbuild bundles the runtime entry. Bundling
 * matters for profile installs: DSH's profile resolver cannot follow a static
 * `mongodb` import from an installed plugin (its CJS dependency graph hits the
 * resolver's createRequire path). Keeping mongodb inside the bundle avoids that
 * installation-only failure while still leaving host-provided packages external.
 *
 * tsc never removes outputs for deleted sources, so always start from empty lib/.
 */
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await rm(resolve(root, 'lib'), { recursive: true, force: true })

const tsc = resolve(root, 'node_modules/typescript/bin/tsc')
const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['ssh2', 'ws', 'semver', '@deepseek-ai/*'],
  banner: {
    js: 'import { createRequire as __dshCreateRequire } from "node:module"; const require = __dshCreateRequire(import.meta.url);',
  },
  logLevel: 'warning',
})
