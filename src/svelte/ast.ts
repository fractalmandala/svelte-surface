/**
 * One normalized view over the Svelte 5 ("modern") and Svelte 4 ("legacy") ASTs,
 * parsed with the *project's own* `svelte/compiler`.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export interface SvelteCompiler {
  parse(source: string, options?: Record<string, unknown>): any
  VERSION: string
}

const cache = new Map<string, Promise<SvelteCompiler>>()

/** Load `svelte/compiler` from the project at `root` (falls back to this package's copy). */
export function loadSvelte(root: string): Promise<SvelteCompiler> {
  const key = path.resolve(root)
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      let url: string
      try {
        const req = createRequire(path.join(key, 'package.json'))
        url = pathToFileURL(req.resolve('svelte/compiler')).href
      } catch {
        url = import.meta.resolve('svelte/compiler')
      }
      const mod = (await import(url)) as SvelteCompiler & { default?: SvelteCompiler }
      return typeof mod.parse === 'function' ? mod : (mod.default as SvelteCompiler) // CJS build via require condition
    })()
    cache.set(key, p)
  }
  return p
}

export type NodeKind = 'element' | 'component' | 'special' | 'text' | 'expr' | 'block' | 'comment' | 'other'

export interface Part {
  type: 'text' | 'expr'
  start: number
  end: number
  /** decoded text for text parts */
  data?: string
}

export interface SAttr {
  /** static = only text, boolean = no value, dynamic = has an expression, spread, directive */
  kind: 'static' | 'boolean' | 'dynamic' | 'spread' | 'directive'
  name: string
  start: number
  end: number
  parts: Part[]
  /** the value, between the quotes (or the unquoted expression/text), when there is one */
  valueStart?: number
  valueEnd?: number
  quote?: '"' | "'" | ''
}

export interface SNode {
  kind: NodeKind
  type: string
  name: string
  start: number
  end: number
  /** offset just after the tag name in the open tag */
  nameEnd: number
  /** offset just after the `>` of the open tag */
  openEnd: number
  /** offset of `</` of the close tag, or -1 */
  closeStart: number
  selfClosing: boolean
  attrs: SAttr[]
  children: SNode[]
  parent: SNode | null
  data?: string
  raw: any
}

export interface Doc {
  source: string
  version: string
  modern: boolean
  root: SNode[]
  /** flat list of element/component/special nodes in document order */
  nodes: SNode[]
  instance: any | null
  module: any | null
  ast: any
  /** Svelte < 5 with `<script lang="ts">`: script bodies were blanked before parsing (offsets unchanged) */
  blanked: boolean
  /** `{start,end}` of every <script> element (instance and module), by offset in `source` */
  scripts: { start: number; end: number; contentStart: number; contentEnd: number; module: boolean; ts: boolean }[]
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g

export function scanScripts(source: string): Doc['scripts'] {
  const out: Doc['scripts'] = []
  for (const m of source.matchAll(SCRIPT_RE)) {
    const attrs = m[1] ?? ''
    const start = m.index!
    const contentStart = start + m[0].indexOf('>') + 1
    out.push({
      start,
      end: start + m[0].length,
      contentStart,
      contentEnd: contentStart + (m[2]?.length ?? 0),
      module: /\bcontext\s*=\s*["']module["']|\bmodule\b/.test(attrs),
      ts: /\blang\s*=\s*["'](?:ts|typescript)["']/.test(attrs)
    })
  }
  return out
}

/** Replace TS script bodies with spaces (newlines kept) so Svelte 4's acorn can parse the template. Same length. */
export function blankTsScripts(source: string, scripts = scanScripts(source)): string {
  let out = source
  for (const sc of scripts) {
    if (!sc.ts) continue
    out = out.slice(0, sc.contentStart) + out.slice(sc.contentStart, sc.contentEnd).replace(/[^\n]/g, ' ') + out.slice(sc.contentEnd)
  }
  return out
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const MODERN_ELEMENT = new Set(['RegularElement', 'SvelteElement'])
const LEGACY_ELEMENT = new Set(['Element'])
const COMPONENT = new Set(['Component', 'InlineComponent', 'SvelteComponent', 'SvelteSelf'])
const SPECIAL = new Set([
  'SvelteHead', 'SvelteWindow', 'SvelteBody', 'SvelteDocument', 'SvelteFragment', 'SvelteBoundary', 'SvelteOptions',
  'SlotElement', 'TitleElement', 'Head', 'Window', 'Body', 'Document', 'Options', 'Slot', 'SlotTemplate', 'Title'
])
const BLOCK = new Set(['IfBlock', 'EachBlock', 'AwaitBlock', 'KeyBlock', 'SnippetBlock', 'ElseBlock', 'PendingBlock', 'ThenBlock', 'CatchBlock'])
const EXPR = new Set(['ExpressionTag', 'MustacheTag', 'HtmlTag', 'RawMustacheTag', 'ConstTag', 'DebugTag', 'RenderTag', 'AttachTag'])
const CHILD_KEYS = ['fragment', 'consequent', 'alternate', 'body', 'fallback', 'pending', 'then', 'catch', 'else']

function listOf(v: any): any[] {
  if (!v || typeof v !== 'object') return []
  if (Array.isArray(v.nodes)) return v.nodes
  if (Array.isArray(v.children)) return v.children
  if (v.type && typeof v.start === 'number') return [v] // a bare node (else-if)
  return []
}

function rawChildren(n: any): any[] {
  const out: any[] = []
  if (Array.isArray(n.children)) out.push(...n.children)
  for (const k of CHILD_KEYS) {
    const v = n[k]
    if (v) out.push(...listOf(v))
  }
  const seen = new Set<any>()
  return out.filter((c) => (seen.has(c) ? false : (seen.add(c), true))).sort((a, b) => a.start - b.start)
}

function classify(type: string): NodeKind {
  if (MODERN_ELEMENT.has(type) || LEGACY_ELEMENT.has(type)) return 'element'
  if (COMPONENT.has(type)) return 'component'
  if (SPECIAL.has(type)) return 'special'
  if (type === 'Text') return 'text'
  if (type === 'Comment') return 'comment'
  if (EXPR.has(type)) return 'expr'
  if (BLOCK.has(type)) return 'block'
  return 'other'
}

function normAttr(source: string, a: any): SAttr {
  const base = { name: a.name ?? '', start: a.start, end: a.end, parts: [] as Part[] }
  if (a.type === 'SpreadAttribute' || a.type === 'Spread') return { ...base, kind: 'spread' }
  if (a.type !== 'Attribute') return { ...base, kind: 'directive' }
  if (a.value === true) return { ...base, kind: 'boolean' }
  const vals: any[] = Array.isArray(a.value) ? a.value : [a.value]
  const parts: Part[] = vals.map((v) =>
    v.type === 'Text'
      ? { type: 'text', start: v.start, end: v.end, data: v.data as string }
      : { type: 'expr', start: v.start, end: v.end }
  )
  const dynamic = parts.some((p) => p.type === 'expr')
  const eq = source.indexOf('=', a.start + base.name.length)
  let quote: SAttr['quote'] = ''
  let valueStart: number | undefined
  let valueEnd: number | undefined
  if (eq >= 0 && eq < a.end) {
    let i = eq + 1
    while (/\s/.test(source[i] ?? '')) i++
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      quote = ch
      valueStart = i + 1
      valueEnd = a.end - 1
    } else {
      valueStart = i
      valueEnd = a.end
    }
  }
  return { ...base, kind: dynamic ? 'dynamic' : 'static', parts, valueStart, valueEnd, quote }
}

function build(source: string, raw: any, parent: SNode | null, flat: SNode[]): SNode {
  const kind = classify(raw.type)
  const isTag = kind === 'element' || kind === 'component' || kind === 'special'
  const attrs: SAttr[] = isTag ? (raw.attributes ?? []).map((a: any) => normAttr(source, a)) : []
  const name: string = raw.name ?? ''
  const nameEnd = isTag ? raw.start + 1 + (name && source.startsWith(name, raw.start + 1) ? name.length : 0) : raw.start
  let openEnd = raw.start
  let closeStart = -1
  let selfClosing = false
  if (isTag) {
    const from = attrs.length ? Math.max(...attrs.map((a) => a.end)) : nameEnd
    const gt = source.indexOf('>', from)
    openEnd = gt >= 0 ? gt + 1 : raw.end
    selfClosing = source[openEnd - 2] === '/'
    if (!selfClosing && !VOID.has(name) && openEnd < raw.end) {
      const cand = source.lastIndexOf('</', raw.end)
      if (cand >= openEnd - 0 && source.startsWith('</' + name, cand)) closeStart = cand
    }
  }
  const node: SNode = {
    kind, type: raw.type, name, start: raw.start, end: raw.end, nameEnd, openEnd, closeStart, selfClosing,
    attrs, children: [], parent, data: raw.type === 'Text' ? (raw.data as string) : undefined, raw
  }
  if (isTag) flat.push(node)
  else if (kind === 'block') flat.push(node)
  for (const c of rawChildren(raw)) node.children.push(build(source, c, node, flat))
  return node
}

/** Parse a `.svelte` source. Throws when it does not parse. */
export function parseSvelte(source: string, svelte: SvelteCompiler, filename = 'file.svelte'): Doc {
  const major = Number(String(svelte.VERSION).split('.')[0])
  const modern = major >= 5
  const scripts = scanScripts(source)
  const blanked = !modern && scripts.some((x) => x.ts)
  const parseSource = blanked ? blankTsScripts(source, scripts) : source
  const ast = modern ? svelte.parse(source, { modern: true, filename }) : svelte.parse(parseSource, { filename })
  const rootNodes: any[] = modern ? ast.fragment.nodes : ast.html?.children ?? []
  const flat: SNode[] = []
  const root = rootNodes.map((r) => build(source, r, null, flat))
  flat.sort((a, b) => a.start - b.start)
  const placeholder = (module: boolean): any | null => {
    const sc = scripts.find((x) => x.module === module)
    return blanked && sc ? { start: sc.start, end: sc.end, content: { body: [] } } : null
  }
  return {
    source, version: svelte.VERSION, modern, root, nodes: flat,
    instance: ast.instance ?? placeholder(false), module: ast.module ?? placeholder(true), ast, blanked, scripts
  }
}

export function walk(nodes: SNode[], fn: (n: SNode) => void | false): void {
  for (const n of nodes) {
    if (fn(n) === false) continue
    walk(n.children, fn)
  }
}

/** Line/column ↔ offset. Lines and columns are 1-based. */
export class LineIndex {
  readonly starts: number[] = [0]
  constructor(readonly source: string) {
    for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) this.starts.push(i + 1)
  }
  locate(offset: number): { line: number; col: number } {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, col: offset - this.starts[lo]! + 1 }
  }
  offsetAt(line: number, col: number): number {
    const s = this.starts[Math.min(Math.max(line, 1), this.starts.length) - 1] ?? 0
    return Math.min(Math.max(s + col - 1, 0), this.source.length)
  }
}
