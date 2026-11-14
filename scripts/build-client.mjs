/**
 * Build the dsh-hydro browser half.
 *
 * DSH's client module system serves each plugin's `exports["./client"]` file as
 * a classic script that only registers a factory:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-hydro", factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports;
 *     <bundle body>
 *     return module.exports;
 *   } });
 *
 * The repository's own tsdown preset that emits this form is not published, so
 * this script reproduces it with esbuild. Everything in DSH's shared module
 * table stays external (resolved by the injected `require`); everything else is
 * inlined, and the build fails loudly when that contract drifts.
 *
 * Usage:
 *   node scripts/build-client.mjs             # one-shot, lib/client.js + map
 *   node scripts/build-client.mjs --watch     # rebuild on change (HMR friendly)
 *   node scripts/build-client.mjs --no-map    # skip the source map
 */
import { context, build } from 'esbuild'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Project root (this file lives in `<root>/scripts`). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * DSH 0.2.2-rc.1 shared module table, verified against
 * `packages/client/web/src/platform.ts` `PLATFORM_MODULES` and against the seed
 * table in the installed shell bundle. Only these specifiers may be required at
 * runtime; importing anything else from `node_modules` must fail the build.
 */
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

/** Whether the build should emit `lib/client.js.map`. */
const WANT_MAP = !process.argv.includes('--no-map')
const WATCH = process.argv.includes('--watch')

/** Read the package manifest that owns the id and the served export. */
async function readManifest() {
  const path = resolve(ROOT, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error('build-client: package.json declares no name')
  }
  const client = manifest.dsh?.client
  if (client === undefined || client.platform !== 'web') {
    throw new Error('build-client: package.json must declare dsh.client.platform = "web"')
  }
  const exported = manifest.exports?.['./client']
  const target = typeof exported === 'string' ? exported : exported?.default
  if (typeof target !== 'string' || !target.endsWith('client.js')) {
    throw new Error('build-client: package.json exports["./client"] must resolve to a client.js bundle')
  }
  return { id: manifest.name, target }
}

/**
 * Fail the build (not the page) when the artifact contract drifts.
 * @param id - plugin/package id stamped into the registration.
 * @param metafile - esbuild metafile of the completed build.
 */
async function assertArtifact(id, metafile) {
  const outfile = 'lib/client.js'
  const artifact = await readFile(resolve(ROOT, outfile), 'utf8')
  const expectedBanner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
  const firstLine = artifact.slice(0, artifact.indexOf('\n'))
  if (!firstLine.startsWith(expectedBanner)) {
    throw new Error(`client bundle: unexpected banner: ${firstLine}`)
  }
  if (!artifact.trimEnd().endsWith('return module.exports;\n} });')) {
    throw new Error('client bundle: unexpected footer; the factory must `return module.exports`')
  }
  if (WANT_MAP && artifact.includes('//# sourceMappingURL=')) {
    // The Host appends the combo source-map trailer itself; an authored
    // trailer would land mid-script inside a multi-package combo.
    throw new Error('client bundle: authored sourceMappingURL comment would land mid-combo')
  }

  const output = metafile.outputs[outfile]
  if (output === undefined) throw new Error(`client bundle: metafile has no ${outfile}`)
  for (const specifier of output.imports) {
    if (!specifier.external) {
      throw new Error(`client bundle: "${specifier.path}" was inlined but must stay external`)
    }
    if (!PLATFORM_MODULES.includes(specifier.path)) {
      throw new Error(`client bundle: external "${specifier.path}" is not in the shared module table`)
    }
  }
  // Inlining a shared module would hand the page a second React instance.
  for (const input of Object.keys(metafile.inputs)) {
    if (/node_modules\/(?:react|react-dom|@deepseek-ai\/)/.test(input.split('\\').join('/'))) {
      throw new Error(`client bundle: shared module "${input}" was inlined; add it to externals`)
    }
  }
  const required = [...new Set(artifact.match(/require\("([^"]+)"\)/g) ?? [])]
    .map((call) => /require\("([^"]+)"\)/.exec(call)?.[1])
    .filter((specifier) => specifier !== undefined)
  for (const specifier of required) {
    if (!PLATFORM_MODULES.includes(specifier)) {
      throw new Error(`client bundle: require("${specifier}") is outside the shared module table`)
    }
  }
  const bytes = Buffer.byteLength(artifact)
  console.log(`\nBuilt lib/client.js — ${(bytes / 1024).toFixed(1)} KiB (${String(bytes)} bytes)`)
  console.log(`External modules required at runtime: ${required.length === 0 ? '(none)' : required.join(', ')}`)
  if (WANT_MAP) console.log('Source map: lib/client.js.map')
}

const manifest = await readManifest()
await mkdir(resolve(ROOT, 'lib'), { recursive: true })
if (!WANT_MAP) {
  // Do not leave an older map beside a bundle that no longer references one.
  await rm(resolve(ROOT, 'lib/client.js.map'), { force: true })
}

/** esbuild options shared by one-shot and watch builds. */
const options = {
  absWorkingDir: ROOT,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome109', 'firefox115', 'safari16'],
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  minify: true,
  sourcemap: WANT_MAP ? 'external' : false,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.id)}, factory: (require) => {\n`
      + 'var module = { exports: {} };\nvar exports = module.exports;',
  },
  footer: { js: 'return module.exports;\n} });' },
  metafile: true,
  logLevel: 'info',
  plugins: [{
    name: 'dsh-hydro-client-contract',
    setup(pluginBuild) {
      pluginBuild.onEnd(async (result) => {
        if (result.errors.length > 0 || result.metafile === undefined) return
        await assertArtifact(manifest.id, result.metafile)
      })
    },
  }],
}

if (WATCH) {
  const watchContext = await context(options)
  await watchContext.watch()
  console.log('watching src/client/** ; press Ctrl-C to stop')
} else {
  await build(options)
}
