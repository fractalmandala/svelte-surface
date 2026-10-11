// Builds the app UI (Svelte 5 + TypeScript) into app-dist/public, which app-dist/server.mjs serves.
import path from 'node:path'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const pkg = path.resolve(import.meta.dirname, '..')
export default defineConfig({
  root: path.join(pkg, 'app/ui'),
  base: './',
  plugins: [svelte({ configFile: false })],
  build: { outDir: path.join(pkg, 'app-dist/public'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500 }
})
