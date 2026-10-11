// Builds the app: UI (Vite + Svelte 5) → app-dist/public, server (esbuild) → app-dist/server.mjs.
// Run with `node scripts/build-app.ts` (Node >= 22.18 strips the types).
import path from 'node:path'
import { build as esbuild } from 'esbuild'
import { build as vite } from 'vite'

const pkg = path.resolve(import.meta.dirname, '..')

await vite({ configFile: path.join(pkg, 'app/vite.config.ts'), logLevel: 'warn' })
console.log('built app-dist/public (UI)')

await esbuild({
  entryPoints: [path.join(pkg, 'app/server/main.ts')],
  outfile: path.join(pkg, 'app-dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'warning',
  // the surface library stays a sibling file (dist/index.js, built by tsc) so the dev server can resolve the project's vite/svelte
  plugins: [{ name: 'surface-external', setup: (b) => b.onResolve({ filter: /dist\/index\.js$/ }, () => ({ path: '../dist/index.js', external: true })) }]
})
console.log('built app-dist/server.mjs')
