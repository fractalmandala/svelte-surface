// Project discovery, git safety checks, recents and installs for the standalone app. No UI here.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

export type ProjectKind = 'sveltekit' | 'vite-svelte'
export interface Recent { path: string; name: string; kind: string; openedAt: number; missing?: boolean }
export interface BrowseEntry { name: string; path: string; kind: ProjectKind | null; git: boolean }
export interface Crumb { name: string; path: string }
export interface Shortcut { name: string; path: string }
export interface Browse { path: string; parent: string | null; crumbs: Crumb[]; entries: BrowseEntry[]; kind: ProjectKind | null; shortcuts: Shortcut[] }
export interface GitState { repo: boolean; root?: string; branch?: string; dirty?: boolean; changes?: number; sample?: string[] }
export interface Warning { code: 'no-git' | 'dirty'; message: string }
export type Inspect =
  | { path: string; supported: false; reason: string }
  | {
      path: string; supported: true; name: string; kind: string; versions: Record<string, string | undefined>; hasTailwind: boolean
      depsInstalled: boolean; packageManager: string; git: GitState; warnings: Warning[]; scratch: boolean
    }
type SurfaceLike = { info: { kind: string; name: string; versions: Record<string, string | undefined>; hasTailwind: boolean } }
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function appHome() {
  if (process.env.SURFACE_APP_HOME) return process.env.SURFACE_APP_HOME
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'surface')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'surface')
}

/* ---------- recents (persisted) ---------- */
const recentsFile = () => path.join(appHome(), 'recents.json')
export function readRecents(): Recent[] {
  try {
    const list = JSON.parse(readFileSync(recentsFile(), 'utf8'))
    return (list as Recent[]).filter((r) => r && typeof r.path === 'string').map((r) => ({ ...r, missing: !existsSync(r.path) }))
  } catch {
    return []
  }
}
async function writeRecents(list: Recent[]): Promise<void> {
  await fs.mkdir(appHome(), { recursive: true })
  await fs.writeFile(recentsFile(), JSON.stringify(list.map(({ missing: _missing, ...r }) => r), null, 2))
}
export async function addRecent(entry: Omit<Recent, 'openedAt' | 'missing'>): Promise<void> {
  const list = readRecents().filter((r) => r.path !== entry.path)
  list.unshift({ ...entry, openedAt: Date.now() })
  await writeRecents(list.slice(0, 12))
}
export async function removeRecent(p: string): Promise<void> {
  await writeRecents(readRecents().filter((r) => r.path !== p))
}

/* ---------- folder browsing ---------- */
export function quickKind(dir: string): ProjectKind | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps['@sveltejs/kit']) return 'sveltekit'
    if (deps.svelte && (deps.vite || deps['@sveltejs/vite-plugin-svelte'])) return 'vite-svelte'
  } catch {}
  return null
}

export function shortcuts(): Shortcut[] {
  const home = os.homedir()
  const out: Shortcut[] = [{ name: 'Home', path: home }]
  for (const n of ['Desktop', 'Documents', 'Downloads', 'Developer', 'Projects', 'projects', 'dev', 'code', 'src', 'work']) {
    const p = path.join(home, n)
    if (existsSync(p)) out.push({ name: n, path: p })
  }
  out.push({ name: process.platform === 'win32' ? 'C:\\' : 'Macintosh HD /', path: path.parse(home).root })
  return out
}

export async function browse(dirArg?: string | null, showHidden = false): Promise<Browse> {
  const dir = path.resolve(dirArg || os.homedir())
  let st: Awaited<ReturnType<typeof fs.stat>>
  try { st = await fs.stat(dir) } catch { throw new ApiError(404, 'not-found', `${dir} does not exist.`) }
  if (!st.isDirectory()) throw new ApiError(400, 'not-a-folder', `${dir} is a file, not a folder.`)
  let names: import('node:fs').Dirent[]
  try { names = await fs.readdir(dir, { withFileTypes: true }) } catch (e) {
    throw new ApiError(403, 'unreadable', `Cannot read ${dir}: ${errCode(e) === 'EPERM' || errCode(e) === 'EACCES' ? 'permission denied (macOS may need Files and Folders access)' : errMsg(e)}`)
  }
  const entries: BrowseEntry[] = []
  for (const d of names) {
    if (d.name === 'node_modules' || (!showHidden && d.name.startsWith('.'))) continue
    const full = path.join(dir, d.name)
    let isDir = d.isDirectory()
    if (!isDir && d.isSymbolicLink()) { try { isDir = (await fs.stat(full)).isDirectory() } catch {} }
    if (!isDir) continue
    entries.push({ name: d.name, path: full, kind: quickKind(full), git: existsSync(path.join(full, '.git')) })
    if (entries.length >= 800) break
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const parts = dir.split(path.sep).filter(Boolean)
  const crumbs = [{ name: path.parse(dir).root, path: path.parse(dir).root }]
  parts.forEach((p, i) => crumbs.push({ name: p, path: path.parse(dir).root + parts.slice(0, i + 1).join(path.sep) }))
  const parent = path.dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, crumbs, entries, kind: quickKind(dir), shortcuts: shortcuts() }
}

/* ---------- project inspection ---------- */
const run = (cmd: string, args: string[], cwd: string): Promise<string | null> =>
  new Promise((resolve) => execFile(cmd, args, { cwd, timeout: 15000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? null : String(stdout))))

export async function gitState(root: string): Promise<GitState> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], root)
  if (!top) return { repo: false }
  const porcelain = (await run('git', ['status', '--porcelain', '--', '.'], root)) ?? ''
  const changes = porcelain.split('\n').filter(Boolean)
  const branch = ((await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)) ?? '').trim()
  return { repo: true, root: top.trim(), branch, dirty: changes.length > 0, changes: changes.length, sample: changes.slice(0, 6) }
}

export function depsInstalled(root: string): boolean {
  const req = createRequire(path.join(root, 'package.json'))
  try { req.resolve('vite/package.json'); req.resolve('svelte/package.json'); return true } catch { return false }
}

export function packageManager(root: string): string {
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

export async function inspectProject(root: string, makeSurface: (root: string) => SurfaceLike, scratch = false): Promise<Inspect> {
  const abs = path.resolve(root)
  if (!existsSync(abs) || !(await fs.stat(abs)).isDirectory()) return { path: abs, supported: false, reason: `${abs} is not a folder.` }
  if (!existsSync(path.join(abs, 'package.json'))) {
    return { path: abs, supported: false, reason: 'No package.json here. Pick the folder that contains your SvelteKit or Vite + Svelte app (folders marked ● in the browser).' }
  }
  const info = makeSurface(abs).info
  if (info.kind === 'unknown') {
    return { path: abs, supported: false, reason: 'package.json found, but it is not a SvelteKit (@sveltejs/kit) or Vite + Svelte project.' }
  }
  const git = await gitState(abs)
  const warnings: Warning[] = []
  if (!scratch) {
    if (!git.repo) warnings.push({ code: 'no-git', message: 'This folder is not in a git repository. Edits are written straight into your files and only the in-app Undo can revert them.' })
    else if (git.dirty) warnings.push({ code: 'dirty', message: `The git working tree has ${git.changes} uncommitted change${git.changes === 1 ? '' : 's'} here. Edits will mix with them; consider committing or stashing first.` })
  }
  return {
    path: abs, supported: true, name: info.name, kind: info.kind, versions: info.versions, hasTailwind: info.hasTailwind,
    depsInstalled: depsInstalled(abs), packageManager: packageManager(abs), git, warnings, scratch
  }
}

/* ---------- installs ---------- */
export function installDeps(root: string, pm: string, onLine: (line: string) => void): Promise<{ ok: boolean; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` }
    const child = spawn(pm, ['install'], { cwd: root, env, shell: process.platform === 'win32' })
    let buf = ''
    const feed = (d: Buffer): void => {
      buf += d
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      lines.forEach((l) => l.trim() && onLine(l))
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.on('error', (e) => resolve({ ok: false, code: -1, error: errCode(e) === 'ENOENT' ? `\`${pm}\` was not found on PATH.` : e.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code }))
  })
}
