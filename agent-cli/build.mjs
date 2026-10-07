// Bundle the BYOA daemon and its pure-JS helpers into a standalone Node
// executable. The output needs nothing installed beyond Node.
import { build } from 'esbuild'
import { existsSync, chmodSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Embed the package version so the running daemon knows what it is and can
// compare against npm's `latest` to self-update (see daemon.ts auto-update).
const pkgVersion = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')).version

// The repo's TS sources use NodeNext `.js` import specifiers that actually
// resolve to sibling `.ts` files. esbuild won't rewrite those, so remap a
// relative `.js` import to its `.ts` source when the `.ts` exists.
const tsExtFix = {
  name: 'ts-ext-fix',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      if (!args.path.endsWith('.js')) return undefined
      const ts = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts')
      return existsSync(ts) ? { path: ts } : undefined
    })
  },
}

const outfile = resolve(here, 'dist/cli.js')
await build({
  entryPoints: [resolve(here, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  define: { __CUMORA_VERSION__: JSON.stringify(pkgVersion) },
  plugins: [tsExtFix],
})
chmodSync(outfile, 0o755)
console.log('[agent-cli] built dist/cli.js')
