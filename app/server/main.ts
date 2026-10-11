/**
 * svelte-surface app server: the backend of the Svelte 5 + TypeScript app UI (app/ui). It serves the built UI
 * (app-dist/public), the JSON/SSE API under /api (projects, drafts, edits, history) and the draft overlay under
 * /overlay, and starts the chosen project's own `vite dev` through the Surface API. Everything is picked in the UI.
 *
 * Built by `npm run build:app` (esbuild: app/server/main.ts → app-dist/server.mjs; the `../dist/index.js`
 * library stays a sibling file). Two ways to run it:
 *  - Native macOS app (`npm run app:native`): the Swift/WKWebView shell in native-shell/ spawns this file with
 *    `--no-open --port <free port>` and SURFACE_PARENT_PID set, shows the page in its window and provides the native
 *    folder picker (NSOpenPanel). The server stops with the shell (parent-PID watch, SIGTERM on quit).
 *  - Browser fallback (`npm run app`): `node app-dist/server.mjs --quit-on-close` serves on localhost and opens a
 *    Chrome/Edge/Brave `--app` window (CHROME_PATH overrides), else your default browser; the in-UI folder browser
 *    replaces the native picker. Closing that window quits the server (8 s after the last event stream drops).
 *
 * Flags:  --port <n>      preferred UI port (default 4320; the next free one is used)
 *         --no-open       do not open a window (native shell, `npm run app:headless`, tests)
 *         --quit-on-close quit when the last window's event stream closes
 * Env:    SURFACE_APP_HOME (recents folder), SURFACE_EXAMPLE_DIR (where the bundled example is copied),
 *         SURFACE_PARENT_PID (exit when that process dies), SURFACE_APP_NO_WINDOW (same as --no-open).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, promises as fs } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Surface, EditError, listProps, watchSources, type DevServer, type SvelteEdit, type ComponentEdit, type StylePatch, type Locator } from '../../dist/index.js'
import { Drafts } from './drafts.ts'
import { ApiError, addRecent, appHome, browse, inspectProject, installDeps, readRecents, removeRecent, shortcuts, type Warning } from './projects.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const flag = (n: string, d: string): string => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? d) : d)
const has = (n: string): boolean => argv.includes(n)

const portFree = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.createServer()
  s.once('error', () => resolve(false))
  s.listen(port, 'localhost', () => s.close(() => resolve(true)))
})
async function pick(pref: number): Promise<number> {
  for (let p = pref; p < pref + 60; p++) if (await portFree(p)) return p
  throw new Error('no free port near ' + pref)
}

/* ---------- the open project ---------- */
const EXAMPLE_SRC = path.join(PKG, 'fixtures', 'sveltekit-app')
const EXAMPLE = process.env.SURFACE_EXAMPLE_DIR || path.join(PKG, 'fixtures', '.demo-run')
interface Session { root: string; surface: Surface; dev: DevServer; unwatch?: () => void; drafts: Drafts; token: string; scratch: boolean; warnings: Warning[] }
let current: Session | null = null
let uiPort = 0
const TREE_SKIP = new Set(['node_modules', '.git', '.svelte-kit', 'dist', 'build', '.vercel', '.next', '.turbo', '.DS_Store', '.output'])
let opening = false
const clients = new Set<ServerResponse>()
const push = (obj: Record<string, unknown>): void => { for (const c of clients) c.write(`data: ${JSON.stringify(obj)}\n\n`) }

function seedExample(): void {
  rmSync(path.join(EXAMPLE, 'src'), { recursive: true, force: true })
  rmSync(path.join(EXAMPLE, 'static'), { recursive: true, force: true })
  mkdirSync(EXAMPLE, { recursive: true })
  for (const n of ['package.json', 'vite.config.js', 'src', 'static']) {
    if (existsSync(path.join(EXAMPLE_SRC, n))) cpSync(path.join(EXAMPLE_SRC, n), path.join(EXAMPLE, n), { recursive: true })
  }
}
const cur = (): Session => {
  if (!current) throw new ApiError(409, 'no-project', 'No project is open.')
  return current
}
const summary = () => current && {
  ...current.surface.info, root: current.root, devUrl: current.dev.url, scratch: current.scratch,
  warnings: current.warnings, dirty: current.drafts.dirtyFiles()
}

/** tell the project's dev server (Vite plugin overlay) that these draft files changed, so it re-reads them and fires HMR */
function notifyDev(c: Session, files: string[]): void {
  fetch(`${c.dev.url}/__surface/overlay-changed`, { method: 'POST', body: JSON.stringify({ files }) }).catch(() => {})
}

function guardUnsaved(discard: boolean): void {
  const dirty = current?.drafts.dirtyFiles() ?? []
  if (dirty.length && !discard) throw new ApiError(409, 'unsaved-drafts', `${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} unsaved changes.`, { files: dirty })
}

async function tree(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (files.length > 4000 || depth > 12) return
    let ents: import('node:fs').Dirent[]
    try { ents = await fs.readdir(path.join(root, dir), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (TREE_SKIP.has(e.name)) continue
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) await walk(rel, depth + 1)
      else if (e.isFile()) files.push(rel)
    }
  }
  await walk('', 0)
  return { files: files.sort(), truncated: files.length > 4000 }
}

async function closeProject(): Promise<void> {
  const c = current
  current = null
  if (!c) return
  c.unwatch?.()
  try { await c.surface.stopDev() } catch { /* already gone */ }
}

async function openProject(p: string, ack: boolean, discard: boolean) {
  if (opening) throw new ApiError(409, 'busy', 'Another project is already opening.')
  opening = true
  try {
    guardUnsaved(discard)
    const scratch = path.resolve(p) === EXAMPLE
    if (scratch) { await closeProject(); seedExample() }
    const insp = await inspectProject(p, (r) => new Surface(r), scratch)
    if (!insp.supported) throw new ApiError(422, 'unsupported', insp.reason)
    if (!insp.depsInstalled) throw new ApiError(409, 'no-deps', 'Dependencies are not installed (vite and svelte cannot be resolved).', { inspect: insp })
    if (insp.warnings.length && !ack) throw new ApiError(409, 'needs-ack', 'Confirm before editing this project.', { inspect: insp })
    await closeProject()
    push({ type: 'phase', text: 'Starting the project’s dev server…' })
    const token = randomBytes(12).toString('hex')
    const ref: { c: Session | null } = { c: null }
    const drafts = new Drafts(insp.path, (files) => {
      push({ type: 'draft', files })
      if (ref.c) notifyDev(ref.c, files)
    })
    const io = {
      read: (file: string) => drafts.read(file),
      write: async (file: string, text: string, meta: { label: string }) => void (await drafts.write(file, text, { label: meta.label }))
    }
    const surface = new Surface(insp.path, { io })
    let dev: DevServer
    try {
      dev = await surface.startDev({ port: await pick(4310), timeoutMs: 120000, marks: { overlay: { url: `http://localhost:${uiPort}/overlay`, token } } })
    } catch (e) {
      await surface.stopDev().catch(() => {})
      throw new ApiError(500, 'dev-failed', 'The dev server did not start.', { details: String((e as Error).message ?? e) })
    }
    const unwatch = watchSources(insp.path, (files: string[]) => push({ type: 'changed', files }))
    current = { root: insp.path, surface, dev, unwatch, drafts, token, scratch, warnings: insp.warnings }
    ref.c = current
    await addRecent({ path: insp.path, name: insp.name, kind: insp.kind })
    return summary()
  } finally {
    opening = false
  }
}

/* ---------- http ---------- */
const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
const record = (r: { changed: boolean; label: string; file: string; changes: unknown }) => ({ ok: true, changed: r.changed, label: r.label, file: r.file, changes: r.changes, draft: true })
async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams
  const at = (): Locator => ({ file: q.get('file') ?? '', line: Number(q.get('line')), col: Number(q.get('col')) })
  const file = (): string => q.get('file') ?? ''
  const key = `${req.method} ${url.pathname}`
  switch (key) {
    /* --- app level --- */
    case 'GET /api/app':
      return json(res, 200, { current: summary(), recents: readRecents(), shortcuts: shortcuts(), home: appHome(), example: EXAMPLE })
    case 'GET /api/fs':
      return json(res, 200, await browse(q.get('path'), q.get('hidden') === '1'))
    case 'POST /api/project/inspect': {
      const b = await body(req)
      return json(res, 200, await inspectProject(b.path, (r) => new Surface(r), path.resolve(b.path) === EXAMPLE))
    }
    case 'POST /api/project/install': {
      const b = await body(req)
      const insp = await inspectProject(b.path, (r) => new Surface(r))
      if (!insp.supported) throw new ApiError(422, 'unsupported', insp.reason)
      push({ type: 'install', line: `$ ${insp.packageManager} install  (in ${insp.path})` })
      const r = await installDeps(insp.path, insp.packageManager, (line: string) => push({ type: 'install', line }))
      if (!r.ok) throw new ApiError(500, 'install-failed', r.error ?? `${insp.packageManager} install exited with code ${r.code}.`)
      return json(res, 200, { ok: true })
    }
    case 'POST /api/project/open': {
      const b = await body(req)
      return json(res, 200, await openProject(b.path, !!b.acknowledged, !!b.discard))
    }
    case 'POST /api/project/example':
      return json(res, 200, { path: EXAMPLE })
    case 'POST /api/project/close':
      guardUnsaved(!!(await body(req)).discard)
      await closeProject()
      return json(res, 200, { ok: true })
    case 'POST /api/recents/remove':
      await removeRecent((await body(req)).path)
      return json(res, 200, { ok: true })
    case 'GET /api/events':
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write('retry: 1000\n\n')
      clients.add(res)
      everConnected = true
      clearTimeout(quitTimer)
      res.on('close', () => {
        clients.delete(res)
        if (!clients.size && has('--quit-on-close')) quitTimer = setTimeout(() => shutdown('window closed'), 8000)
      })
      return
  }
  /* --- editor level (needs an open project) --- */
  const c = cur()
  const s = c.surface
  switch (key) {
    case 'GET /api/info':
      return json(res, 200, { ...summary() })
    case 'GET /api/pages':
      return json(res, 200, await s.pages())
    case 'GET /api/inspect':
      return json(res, 200, await s.inspect(at()))
    case 'GET /api/variants':
      return json(res, 200, { variants: await s.variants(file()), states: await s.states(file()), props: listProps(await c.drafts.read(file()), await s.compiler()) })
    case 'GET /api/history':
      return json(res, 200, c.drafts.history())
    case 'GET /api/tree':
      return json(res, 200, await tree(c.root))
    case 'GET /api/file':
      return json(res, 200, await c.drafts.file(file()))
    case 'GET /api/drafts':
      return json(res, 200, { drafts: await c.drafts.list(), history: c.drafts.history() })
    case 'POST /api/draft/set': {
      const b = await body(req)
      const changed = await c.drafts.write(b.file, b.text, { typed: !!b.typed, label: b.typed ? `Typed in ${b.file.split('/').pop()}` : 'Edit' })
      return json(res, 200, { ok: true, changed, dirty: c.drafts.isDirty(b.file) })
    }
    case 'POST /api/draft/save': {
      const b = await body(req)
      const saved = await c.drafts.save(b.files, { force: !!b.force })
      return json(res, 200, { ok: true, saved })
    }
    case 'POST /api/draft/revert': {
      const b = await body(req)
      return json(res, 200, { ok: true, reverted: c.drafts.revert(b.files) })
    }
    case 'POST /api/draft/resolve': {
      const b = await body(req)
      if (b.action === 'reload') c.drafts.revert([b.file])
      else if (b.action === 'overwrite') await c.drafts.save([b.file], { force: true })
      else if (b.action === 'keep') await c.drafts.rebase(b.file)
      else throw new ApiError(400, 'invalid', 'unknown action')
      return json(res, 200, { ok: true })
    }
    case 'POST /api/edit': {
      const b = await body(req)
      return json(res, 200, record(await s.edit(b.at, b.edit as SvelteEdit)))
    }
    case 'POST /api/component': {
      const b = await body(req)
      return json(res, 200, record(await s.componentEdit(b.file, b.edit as ComponentEdit)))
    }
    case 'POST /api/patch': {
      const b = await body(req)
      return json(res, 200, record(await s.applyPatch(b.patch as StylePatch, { mode: b.mode })))
    }
    case 'POST /api/new-page': {
      const file = await s.newPage((await body(req)).route)
      push({ type: 'changed', files: [file] })
      return json(res, 200, { ok: true, file })
    }
    case 'POST /api/undo': {
      const h = await c.drafts.undo()
      return json(res, 200, h ? { ok: true, changed: true, label: `Undid: ${h.label}`, file: h.file } : { ok: false, label: 'nothing to undo' })
    }
    case 'POST /api/redo': {
      const h = await c.drafts.redo()
      return json(res, 200, h ? { ok: true, changed: true, label: `Redid: ${h.label}`, file: h.file } : { ok: false, label: 'nothing to redo' })
    }
    case 'POST /api/reset': {
      if (!c.scratch) throw new ApiError(400, 'invalid', 'Reset is only available for the bundled example.')
      c.drafts.revert()
      seedExample()
      push({ type: 'changed', files: ['*'] })
      return json(res, 200, { ok: true, label: 'Example restored' })
    }
  }
  json(res, 404, { error: 'not found' })
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2' }
function serveStatic(res: ServerResponse, pathname: string): void {
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  const abs = path.resolve(HERE, 'public', pathname === '/' ? 'index.html' : pathname.slice(1))
  if (!abs.startsWith(path.join(HERE, 'public')) || !existsSync(abs)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': (TYPES[path.extname(abs)] ?? 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' })
  res.end(readFileSync(abs))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  try {
    if (url.pathname === '/overlay/file') {
      const text = current && url.searchParams.get('t') === current.token ? current.drafts.overlay(url.searchParams.get('rel') ?? '') : null
      if (text === null) { res.writeHead(204); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(text)
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    serveStatic(res, url.pathname)
  } catch (e) {
    if (e instanceof ApiError) return json(res, e.status, { error: e.message, code: e.code, ...e.extra })
    if (e instanceof EditError) return json(res, 400, { error: e.message, code: e.code })
    json(res, 500, { error: e instanceof Error ? e.message : String(e), code: 'error' })
  }
})

/* ---------- window + lifecycle ---------- */
/** browser fallback only (`npm run app`): the native shell never calls this */
function findBrowser(): string | undefined {
  const c = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
  return [process.env.CHROME_PATH, ...c].find((p) => !!p && existsSync(p))
}
function openWindow(url: string): void {
  const exe = findBrowser()
  if (exe) {
    const profile = path.join(appHome(), 'window-profile')
    mkdirSync(profile, { recursive: true })
    spawn(exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1560,980', '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore', detached: true }).unref()
    return
  }
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
}

let everConnected = false
let quitTimer: ReturnType<typeof setTimeout> | undefined
let stopping = false
async function shutdown(why: string): Promise<void> {
  if (stopping) return
  stopping = true
  const lost = current?.drafts.dirtyFiles().length
  console.log(`\nstopping (${why})…${lost ? ` ${lost} unsaved draft file(s) discarded` : ''}`)
  await closeProject()
  server.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('Ctrl-C'))
process.on('SIGTERM', () => shutdown('terminated'))

// when a native shell spawned us, die with it (also if the shell crashes and cannot clean up)
if (process.env.SURFACE_PARENT_PID) {
  const parent = Number(process.env.SURFACE_PARENT_PID)
  setInterval(() => { try { process.kill(parent, 0) } catch { shutdown('parent exited') } }, 2000).unref()
}
uiPort = await pick(Number(flag('--port', '4320')))
server.listen(uiPort, 'localhost', () => {
  const url = `http://localhost:${uiPort}/`
  console.log(`\n  svelte-surface:  ${url}\n  data folder:             ${appHome()}\n\n  Ctrl-C to stop.`)
  if (!has('--no-open') && !process.env.SURFACE_APP_NO_WINDOW) openWindow(url)
})
