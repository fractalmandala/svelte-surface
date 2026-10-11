import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export type ProjectKind = 'sveltekit' | 'vite-svelte' | 'unknown'

export interface ProjectInfo {
  root: string
  name: string
  kind: ProjectKind
  /** matches FrameworkId in `@shared/types` */
  frameworkId: 'sveltekit' | 'svelte-vite' | null
  staticDir: 'static' | 'public'
  routesDir: string | null
  hasTailwind: boolean
  versions: { svelte?: string; kit?: string; vite?: string }
  devScript?: string
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function installedVersion(root: string, pkg: string): string | undefined {
  try {
    const req = createRequire(path.join(root, 'package.json'))
    return readJson(req.resolve(`${pkg}/package.json`))?.version
  } catch {
    return undefined
  }
}

/** `@sveltejs/kit` → SvelteKit; else `vite` + `svelte` → Vite + Svelte. Both run through the same Vite path. */
export function detectProject(root: string): ProjectInfo {
  root = path.resolve(root)
  const pkg = readJson(path.join(root, 'package.json')) ?? {}
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
  const has = (n: string): boolean => n in deps
  const kind: ProjectKind = has('@sveltejs/kit') ? 'sveltekit' : has('vite') && has('svelte') ? 'vite-svelte' : 'unknown'
  const routes = path.join(root, 'src', 'routes')
  return {
    root,
    name: pkg.name ?? path.basename(root),
    kind,
    frameworkId: kind === 'sveltekit' ? 'sveltekit' : kind === 'vite-svelte' ? 'svelte-vite' : null,
    staticDir: kind === 'sveltekit' ? 'static' : 'public',
    routesDir: kind === 'sveltekit' && existsSync(routes) ? routes : null,
    hasTailwind: has('tailwindcss') || has('@tailwindcss/vite'),
    versions: { svelte: installedVersion(root, 'svelte'), kit: installedVersion(root, '@sveltejs/kit'), vite: installedVersion(root, 'vite') },
    devScript: pkg.scripts?.dev
  }
}

export interface PageEntry {
  /** address, e.g. `/about`, `/blog/[slug]` */
  route: string
  /** project-relative `+page.svelte` (null when the page is `+page.ts/.js/.md` only) */
  file: string | null
  dynamic: boolean
}

const PAGE_FILES = ['+page.svelte', '+page.ts', '+page.js', '+page.md']

/** Every `src/routes/**` folder holding a +page. `(group)` folders add nothing to the address. */
export async function listPages(root: string): Promise<PageEntry[]> {
  const routes = path.join(path.resolve(root), 'src', 'routes')
  const out: PageEntry[] = []
  const walk = async (dir: string, segs: string[]): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
    if (PAGE_FILES.some((f) => names.has(f))) {
      const rel = path.relative(routes, dir).split(path.sep).filter(Boolean)
      out.push({
        route: '/' + segs.join('/'),
        file: names.has('+page.svelte') ? path.posix.join('src/routes', ...rel, '+page.svelte') : null,
        dynamic: segs.some((s) => s.startsWith('['))
      })
    }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const grouped = /^\(.*\)$/.test(e.name)
      await walk(path.join(dir, e.name), grouped ? segs : [...segs, e.name])
    }
  }
  await walk(routes, [])
  return out.sort((a, b) => a.route.localeCompare(b.route))
}

export interface ScaffoldOptions {
  title?: string
  /** write Tailwind classes; default: detected */
  tailwind?: boolean
}

/** Make `src/routes/<route>/+page.svelte`. Refuses to overwrite. Returns the project-relative path. */
export async function scaffoldPage(root: string, route: string, options: ScaffoldOptions = {}): Promise<string> {
  const info = detectProject(root)
  if (info.kind !== 'sveltekit') throw new Error('New pages are only offered in SvelteKit projects.')
  const clean = route.replace(/^\/+|\/+$/g, '')
  if (clean.split('/').some((s) => s === '..' || s === '.' || (s !== '' && !/^[\w()[\].=~@-]+$/.test(s))))
    throw new Error(`"${route}" is not a valid page path.`)
  const rel = path.posix.join('src/routes', clean, '+page.svelte')
  const abs = path.join(info.root, rel)
  if (existsSync(abs)) throw new Error(`${rel} already exists.`)
  const last = clean.split('/').filter((s) => s && !/^\(.*\)$/.test(s)).pop() ?? 'Home'
  const title = options.title ?? (last.replace(/[-_[\]]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Home')
  const tw = options.tailwind ?? info.hasTailwind
  const body = tw
    ? `<main class="mx-auto max-w-3xl px-6 py-24">\n  <h1 class="text-4xl font-semibold">${title}</h1>\n  <p class="mt-4">A new page, made in Surface.</p>\n</main>\n`
    : `<main>\n  <h1>${title}</h1>\n  <p>A new page, made in Surface.</p>\n</main>\n`
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, { flag: 'wx' })
  return rel
}
