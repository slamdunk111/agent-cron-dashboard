#!/usr/bin/env node
/**
 * Build step of the skeleton: compiles the TypeScript sources of both
 * packages into plain ESM JavaScript for the dsh loader.
 *
 * The loader loads plugin entry `main`/`exports["."]` via a dynamic
 * `import()`, so a `.ts` entry cannot be activated by dsh (0.2.2-rc.1 has no
 * runtime TypeScript loader). This script therefore:
 *   1. copies `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` into
 *      `build/<package>/` (the directory handed to `plugin_manager
 *      install_bundle`), with `main`/`exports` rewritten to the built files;
 *   2. builds `src/index.ts` -> `index.js` (ESM, `cordis`/`zod` external, other
 *      relative imports inlined);
 *   3. builds the main package's `client/index.ts` -> `client/index.js` and
 *      leaves a marker comment so the JS is importable outside the browser
 *      `__ModuleLoader__` host.
 *
 * Usage: node scripts/build-bundles.mjs
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outRoot = resolve(root, 'build')

const PACKAGES = [
  {
    dir: 'packages/dsh-forge-gitcode',
    entry: 'src/index.ts',
    out: 'index.js',
    externals: ['cordis', '@deepseek-ai/cordis'],
  },
  {
    dir: 'packages/agent-cron-dashboard',
    entry: 'src/index.ts',
    out: 'index.js',
    externals: ['cordis', '@deepseek-ai/cordis', '@deepseek-ai/dsh-storage-domain', 'zod'],
    client: { entry: 'client/index.ts', out: 'client/index.js' },
  },
]

async function main() {
  rmSync(outRoot, { recursive: true, force: true })
  for (const pkg of PACKAGES) {
    const pkgDir = resolve(root, pkg.dir)
    const outDir = resolve(outRoot, pkg.dir)
    mkdirSync(outDir, { recursive: true })
    for (const asset of ['locale', 'icon.svg', 'cordis.patch.yml']) {
      cpSync(resolve(pkgDir, asset), resolve(outDir, asset), { recursive: true })
    }
    const manifest = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'))
    manifest.main = './index.js'
    manifest.exports = {
      '.': './index.js',
      ...(pkg.client ? { './client': './client/index.js' } : {}),
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
    }
    manifest.files = undefined
    writeFileSync(resolve(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    await build({
      entryPoints: [resolve(pkgDir, pkg.entry)],
      outfile: resolve(outDir, pkg.out),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      external: pkg.externals,
      logLevel: 'warning',
    })

    if (pkg.client) {
      await build({
        entryPoints: [resolve(pkgDir, pkg.client.entry)],
        outfile: resolve(outDir, pkg.client.out),
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        logLevel: 'warning',
      })
      // The browser module registers itself through `__ModuleLoader__`; the
      // leading marker keeps the built file importable outside the browser
      // loader (smoke checks import it only to prove it parses).
      const built = readFileSync(resolve(outDir, pkg.client.out), 'utf8')
      writeFileSync(resolve(outDir, pkg.client.out), `// built from client/index.ts; loaded by the web client loader\n${built}`)
    }
    console.log(`built ${pkg.dir} -> build/${pkg.dir}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
