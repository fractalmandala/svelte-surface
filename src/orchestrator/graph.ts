import { promises as fs, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { parseSvelte, loadSvelte, walk } from '../svelte/ast.js'

const EXTS = ['', '.svelte', '.ts', '.js', '/index.ts', '/index.js', '/index.svelte']
const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function importsMap(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).imports ?? {}
  } catch {
    return {}
  }
}

/** Resolve one specifier to a project-relative file (or null). Understands `./`, `$lib/`, `#lib/` (package imports). */
export function resolveImport(root: string, fromFile: string, spec: string): string | null {
  let base: string | null = null
  if (spec.startsWith('.')) base = path.resolve(root, path.dirname(fromFile), spec)
  else if (spec.startsWith('$lib')) base = path.join(root, 'src', 'lib', spec.slice(4))
  else if (spec.startsWith('#')) {
    for (const [k, v] of Object.entries(importsMap(root))) {
      if (typeof v !== 'string') continue
      if (k.endsWith('/*') && spec.startsWith(k.slice(0, -1))) base = path.resolve(root, v.replace('*', spec.slice(k.length - 1)))
      else if (k === spec) base = path.resolve(root, v)
    }
  }
  if (!base) return null
  for (const e of EXTS) {
    if (existsSync(base + e) && isFile(base + e)) return path.relative(root, base + e).split(path.sep).join('/')
  }
  return null
}

/** Files reachable by imports from `file`, up to `depth` hops (default 3). Map: file → hops. */
export async function importClosure(root: string, file: string, depth = 3): Promise<Map<string, number>> {
  const seen = new Map<string, number>([[file, 0]])
  let frontier = [file]
  for (let d = 1; d <= depth; d++) {
    const next: string[] = []
    for (const f of frontier) {
      let src = ''
      try {
        src = await fs.readFile(path.join(root, f), 'utf8')
      } catch {
        continue
      }
      for (const m of src.matchAll(IMPORT_RE)) {
        const r = resolveImport(root, f, m[1]!)
        if (r && !seen.has(r)) {
          seen.set(r, d)
          next.push(r)
        }
      }
    }
    frontier = next
  }
  return seen
}

export interface Usage {
  file: string
  line: number
  col: number
  name: string
}

/** Where a component file is used as `<Name …>` in other .svelte files under src/ ("edit it where it's used"). */
export async function findUsages(root: string, componentFile: string): Promise<Usage[]> {
  const svelte = await loadSvelte(root)
  const out: Usage[] = []
  const files: string[] = []
  const scan = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) await scan(p)
      else if (e.name.endsWith('.svelte')) files.push(path.relative(root, p).split(path.sep).join('/'))
    }
  }
  await scan(path.join(root, 'src'))
  for (const f of files) {
    if (f === componentFile) continue
    const src = await fs.readFile(path.join(root, f), 'utf8')
    const names = new Set<string>()
    for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g)) {
      if (resolveImport(root, f, m[2]!) === componentFile) names.add(m[1]!)
    }
    if (!names.size) continue
    let doc
    try {
      doc = parseSvelte(src, svelte, f)
    } catch {
      continue
    }
    walk(doc.root, (n) => {
      if (n.kind === 'component' && names.has(n.name)) {
        const before = src.slice(0, n.start).split('\n')
        out.push({ file: f, line: before.length, col: before[before.length - 1]!.length + 1, name: n.name })
      }
    })
  }
  return out
}
