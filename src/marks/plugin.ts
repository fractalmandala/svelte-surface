/**
 * The Vite plugin. Placed FIRST (enforce: 'pre') so it reads each `.svelte`
 * file before Svelte's own plugin compiles it, using the project's own
 * `svelte/compiler`. Also loads the in-iframe bridge:
 *  - Vite + Svelte: a <script> injected through `transformIndexHtml`;
 *  - SvelteKit (which does not support `transformIndexHtml`): a side-effect import of
 *    a virtual module, written into the entry components (`+layout/+page/+error.svelte`, `App.svelte`).
 */
import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { Plugin } from 'vite'
import { loadSvelte, type SvelteCompiler } from '../svelte/ast.js'
import { markSvelteSource, type MarkOptions } from './transform.js'
import { bridgeSource } from '../bridge/source.js'

export interface SurfaceMarksOptions extends Omit<MarkOptions, 'bridgeImport'> {
  /** project root; defaults to Vite's resolved root */
  root?: string
  /** load the bridge into the page; default true */
  bridge?: boolean
  /** bridge options (frame id etc.) */
  bridgeOptions?: { frame?: string; always?: boolean; root?: string }
  /** include files under node_modules (libraries); default false */
  includeNodeModules?: boolean
  /**
   * Draft overlay: a host keeps unsaved file contents in memory and serves them at
   * `GET <url>/file?rel=<project-relative path>&t=<token>` (200 = draft text, 204 = none).
   * The plugin then loads drafts instead of disk, and `POST /__surface/overlay-changed` on the dev
   * server ({ files: [rel] }) makes Vite re-read them and fire HMR, without touching the disk.
   */
  overlay?: { url: string; token: string }
}

export const BRIDGE_URL = '/@surface/bridge.js'
export const BRIDGE_VIRTUAL = 'virtual:surface-bridge'
const RESOLVED_VIRTUAL = '\0' + BRIDGE_VIRTUAL
const ENTRY_RE = /(?:^|\/)(?:\+layout|\+page|\+error|App)\.svelte$/

function hasKit(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    return '@sveltejs/kit' in { ...pkg.dependencies, ...pkg.devDependencies }
  } catch {
    return false
  }
}

export function surfaceMarks(options: SurfaceMarksOptions = {}): Plugin {
  let root = options.root ?? process.cwd()
  let svelte: Promise<SvelteCompiler> | null = null
  const withBridge = options.bridge !== false
  const kit = hasKit(root)
  const cfg = JSON.stringify(options.bridgeOptions ?? {})
  const overlay = options.overlay

  /** project-relative path of a plain module id we may have a draft for (no queries, no node_modules) */
  function overlayRel(id: string): string | null {
    if (!overlay || id.includes('?') || id.startsWith('\0')) return null
    const abs = path.resolve(id)
    if (!abs.startsWith(root + path.sep)) return null
    const rel = path.relative(root, abs).split(path.sep).join('/')
    if (rel.startsWith('node_modules/') || rel.includes('/node_modules/') || rel.startsWith('.svelte-kit/')) return null
    return rel
  }
  async function fetchDraft(rel: string): Promise<string | null> {
    try {
      const r = await fetch(`${overlay!.url}/file?rel=${encodeURIComponent(rel)}&t=${overlay!.token}`)
      if (r.status !== 200) {
        void r.body?.cancel()
        return null
      }
      return await r.text()
    } catch {
      return null
    }
  }

  const plugin: Plugin = {
    name: 'surface-marks',
    enforce: 'pre',
    configResolved(config) {
      if (!options.root) root = config.root
    },
    resolveId(id) {
      if (id === BRIDGE_VIRTUAL || id === BRIDGE_URL) return RESOLVED_VIRTUAL
      return null
    },
    async load(id) {
      if (id === RESOLVED_VIRTUAL) {
        // the module guards on `window`/`document`, so importing it during SSR is a no-op
        return `${bridgeSource()}\ninstallBridgeOnce(${cfg})\n`
      }
      const rel = overlayRel(id)
      return rel ? fetchDraft(rel) : null
    },
    async handleHotUpdate(ctx) {
      // Svelte's HMR re-reads the changed file through `ctx.read()`, which reads the disk: point it at the draft
      const rel = overlayRel(ctx.file)
      const draft = rel ? await fetchDraft(rel) : null
      if (draft !== null) ctx.read = async () => draft
      return undefined
    },
    configureServer(server) {
      if (overlay) {
        server.middlewares.use((req, res, next) => {
          if (req.method !== 'POST' || req.url?.split('?')[0] !== '/__surface/overlay-changed') return next()
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            try {
              const { files } = JSON.parse(body) as { files: string[] }
              for (const rel of files) server.watcher.emit('change', path.join(root, rel))
              res.statusCode = 200
              res.end('ok')
            } catch {
              res.statusCode = 400
              res.end('bad request')
            }
          })
        })
      }
      if (!withBridge) return
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== BRIDGE_URL) return next()
        res.setHeader('content-type', 'text/javascript')
        res.setHeader('cache-control', 'no-store')
        res.end(bridgeSource())
      })
    },
    async transform(code, id) {
      const [file, query] = id.split('?')
      if (!file || !file.endsWith('.svelte')) return null
      if (query && /(^|&)type=(style|script)/.test(query)) return null
      if (!options.includeNodeModules && file.includes('/node_modules/')) return null
      svelte ??= loadSvelte(root)
      const compiler = await svelte
      const rel = path.relative(root, file).split(path.sep).join('/')
      try {
        const result = markSvelteSource(code, rel, compiler, {
          ...options,
          bridgeImport: withBridge && kit && ENTRY_RE.test(rel) ? BRIDGE_VIRTUAL : undefined
        })
        if (!result) return null
        return { code: result.code, map: result.map as any }
      } catch (e) {
        this.warn(`surface: could not mark ${rel}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    }
  }
  if (withBridge && !kit) {
    plugin.transformIndexHtml = () => [
      { tag: 'script', attrs: { type: 'module', src: BRIDGE_URL, 'data-surface-bridge': cfg }, injectTo: 'head-prepend' as const }
    ]
  }
  return plugin
}

/** Convenience for tests/CLI: read a file from disk and mark it. */
export async function markFile(root: string, rel: string, options: MarkOptions = {}): Promise<string | null> {
  const svelte = await loadSvelte(root)
  const src = readFileSync(path.join(root, rel), 'utf8')
  return markSvelteSource(src, rel, svelte, options)?.code ?? null
}

export default surfaceMarks
