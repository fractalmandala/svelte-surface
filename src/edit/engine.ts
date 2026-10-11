/**
 * Surgical, byte-range edits of `.svelte` source, located through the Svelte AST.
 * Whitespace outside the touched range is never reprinted. Everything is applied
 * through magic-string on the original offsets, then the result is re-parsed:
 * if it would not parse, nothing is returned.
 */
import MagicString from 'magic-string'
import { LineIndex, parseSvelte, type Doc, type SAttr, type SNode, type SvelteCompiler } from '../svelte/ast.js'
import {
  EditError,
  type AttrValue,
  type Change,
  type EditResult,
  type Position,
  type StateName,
  type PropInfo,
  type SvelteEdit,
  type Target
} from './types.js'

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const FROM_VARIABLE = 'This comes from a variable or expression, not written text; edit it where it is defined.'

/* ------------------------------------------------------------------ *
 * locating
 * ------------------------------------------------------------------ */

export function parseOrThrow(source: string, svelte: SvelteCompiler): Doc {
  try {
    return parseSvelte(source, svelte)
  } catch (e) {
    throw new EditError('no-parse', `The file does not parse: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}

/** The element/component whose `<` sits at `offset`. */
export function findAtOffset(doc: Doc, offset: number): SNode | null {
  return doc.nodes.find((n) => n.start === offset && (n.kind === 'element' || n.kind === 'component' || n.kind === 'special')) ?? null
}

/** The element/component whose `<` sits at (line, col), both 1-based. This is the mark → AST join. */
export function findAt(doc: Doc, line: number, col: number): SNode | null {
  return findAtOffset(doc, new LineIndex(doc.source).offsetAt(line, col))
}

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

export function encodeText(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/</g, '&lt;')
}

export function encodeAttr(v: string, quote = '"'): string {
  let o = v.replace(/&/g, '&amp;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;')
  o = quote === '"' ? o.replace(/"/g, '&quot;') : o.replace(/'/g, '&#39;')
  return o
}

function lineStartOf(src: string, off: number): number {
  return src.lastIndexOf('\n', off - 1) + 1
}
function lineEndOf(src: string, off: number): number {
  const i = src.indexOf('\n', off)
  return i < 0 ? src.length : i
}
function indentOf(src: string, off: number): string {
  const ls = lineStartOf(src, off)
  return /^[ \t]*/.exec(src.slice(ls, off))![0]
}
function unitFor(indent: string): string {
  return indent.includes('\t') ? '\t' : '  '
}
function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean)
}
function wsParts(s: string): [string, string] {
  return [/^\s*/.exec(s)![0], /\s*$/.exec(s)![0]]
}

function requireTag(n: SNode | null): SNode {
  if (!n) throw new EditError('not-found', 'No element at that position; the file changed since the preview. Wait for the reload and try again.')
  return n
}

export function attrNamed(n: SNode, name: string): SAttr | undefined {
  return n.attrs.find((a) => a.name === name && a.kind !== 'directive' && a.kind !== 'spread')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Decoded text of a run of static parts. */
function decode(parts: { data?: string }[]): string {
  return parts.map((p) => p.data ?? '').join('')
}

/** Start/end of the node including a directly-attached comment above it and, when it owns its lines, those lines. */
function blockRange(doc: Doc, n: SNode, withComment = true): { start: number; end: number } {
  const src = doc.source
  let start = n.start
  const siblings = n.parent ? n.parent.children : doc.root
  const idx = siblings.indexOf(n)
  if (withComment) {
    let j = idx - 1
    const prev = siblings[j]
    if (prev && prev.kind === 'text' && !prev.data?.trim() && (prev.data?.split('\n').length ?? 0) <= 2) j--
    const c = siblings[j]
    if (c && c.kind === 'comment') start = c.start
  }
  let end = n.end
  const ls = lineStartOf(src, start)
  const le = lineEndOf(src, end)
  if (!src.slice(ls, start).trim() && !src.slice(end, le).trim()) {
    start = ls
    end = Math.min(le + 1, src.length)
  }
  return { start, end }
}

export function finish(source: string, svelte: SvelteCompiler, s: MagicString, changes: Change[], label: string): EditResult {
  const code = s.toString()
  if (code !== source) {
    try {
      parseSvelte(code, svelte)
    } catch (e) {
      throw new EditError('no-parse', `The edit would not parse, so nothing was written: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }
  return { code, changed: code !== source, changes, label }
}

export class Editor {
  readonly s: MagicString
  readonly changes: Change[] = []
  constructor(readonly source: string) {
    this.s = new MagicString(source)
  }
  replace(start: number, end: number, text: string): void {
    if (start === end) this.s.appendRight(start, text)
    else this.s.overwrite(start, end, text)
    this.changes.push({ start, end, text })
  }
  insert(at: number, text: string): void {
    // appendRight: stays attached to the chunk after `at`, so a later remove() ending at `at` cannot swallow it
    this.s.appendRight(at, text)
    this.changes.push({ start: at, end: at, text })
  }
  remove(start: number, end: number): void {
    if (start === end) return
    this.s.remove(start, end)
    this.changes.push({ start, end, text: '' })
  }
}

/* ------------------------------------------------------------------ *
 * text
 * ------------------------------------------------------------------ */

function setText(doc: Doc, n: SNode, ed: Editor, text: string, expect?: string): string {
  if (n.kind !== 'element') throw new EditError('unsupported', 'Text can only be set on an element.')
  if (n.selfClosing || VOID.has(n.name) || n.closeStart < 0 && n.openEnd >= n.end)
    throw new EditError('unsupported', `<${n.name}> cannot hold text.`)
  for (const c of n.children) {
    if (c.kind === 'text') continue
    if (c.kind === 'expr' && c.type !== 'ConstTag') throw new EditError('dynamic', FROM_VARIABLE)
    throw new EditError('unsupported', 'This element holds markup, not only text; select the text inside it.')
  }
  const start = n.openEnd
  const end = n.closeStart >= 0 ? n.closeStart : n.end
  const old = doc.source.slice(start, end)
  if (expect !== undefined && collapse(decode(n.children)) !== collapse(expect))
    throw new EditError('mismatch', "The text in the code doesn't match the preview.")
  const [lead, trail] = old.trim() ? wsParts(old) : ['', '']
  const next = lead + encodeText(text) + trail
  if (next !== old) ed.replace(start, end, next)
  return `Changed text of <${n.name}>`
}

/* ------------------------------------------------------------------ *
 * classes
 * ------------------------------------------------------------------ */

function validToken(t: string): void {
  if (/[\s"'{}<>]/.test(t)) throw new EditError('invalid', `"${t}" is not a valid class name.`)
}

export function setClasses(doc: Doc, n: SNode, ed: Editor, e: Extract<SvelteEdit, { op: 'setClasses' }>): string {
  if (n.kind === 'special') throw new EditError('unsupported', `<${n.name}> is left alone.`)
  const src = doc.source
  const attr = attrNamed(n, 'class')
  const set = e.set !== undefined ? tokens(e.set) : null
  const add = (e.add ?? []).flatMap(tokens)
  const remove = new Set((e.remove ?? []).flatMap(tokens))
  for (const t of [...(set ?? []), ...add]) validToken(t)
  const label = `Changed classes of <${n.name}>`

  const apply = (current: string[]): string[] => {
    let next = set ? [...set] : current.filter((t) => !remove.has(t))
    for (const t of add) if (!next.includes(t)) next.push(t)
    if (set) for (const t of remove) next = next.filter((x) => x !== t)
    return next
  }

  if (!attr) {
    const next = apply([])
    if (!next.length) return label
    const at = n.attrs.length ? Math.max(...n.attrs.map((a) => a.end)) : n.nameEnd
    ed.insert(at, ` class="${next.join(' ')}"`)
    return label
  }
  if (attr.kind === 'boolean') {
    const next = apply([])
    ed.replace(attr.start, attr.end, next.length ? `class="${next.join(' ')}"` : '')
    return label
  }
  const textParts = attr.parts.filter((p) => p.type === 'text')
  if (!textParts.length) throw new EditError('dynamic', FROM_VARIABLE)
  const current = tokens(decode(textParts))
  if (e.expect !== undefined && tokens(e.expect).join(' ') !== current.join(' ') && attr.kind === 'static')
    throw new EditError('mismatch', "The classes in the code don't match the preview.")
  const next = apply(current)
  if (next.join(' ') === current.join(' ')) return label

  if (attr.kind === 'static') {
    if (!next.length) {
      let s0 = attr.start
      while (s0 > 0 && /[ \t]/.test(src[s0 - 1]!)) s0--
      ed.remove(s0, attr.end)
    } else ed.replace(attr.valueStart!, attr.valueEnd!, next.join(' '))
    return label
  }
  // dynamic: only the written Text parts are touched, never an expression
  const keep = new Set(next)
  const firstText = textParts[0]!
  const added = next.filter((t) => !current.includes(t))
  for (const p of textParts) {
    const raw = src.slice(p.start, p.end)
    const [lead, trail] = wsParts(raw)
    const mine = tokens(raw)
    let out = mine.filter((t) => keep.has(t))
    if (p === firstText) out = [...out, ...added]
    const rebuilt = out.length ? lead + out.join(' ') + trail : lead && trail ? ' ' : lead + trail
    if (rebuilt !== raw) ed.replace(p.start, p.end, rebuilt)
  }
  return label
}

/* ------------------------------------------------------------------ *
 * attributes / props
 * ------------------------------------------------------------------ */

function renderAttr(name: string, value: AttrValue, quote = '"'): string | null {
  if (value === null || value === false) return null
  if (value === true) return name
  if (typeof value === 'object') return `${name}={${value.expr}}`
  return `${name}=${quote}${encodeAttr(value, quote)}${quote}`
}

export function setAttr(doc: Doc, n: SNode, ed: Editor, name: string, value: AttrValue, e: { force?: boolean } = {}): string {
  if (n.kind === 'special') throw new EditError('unsupported', `<${n.name}> is left alone.`)
  if (!/^[A-Za-z_:][-\w:.]*$/.test(name)) throw new EditError('invalid', `"${name}" is not a valid attribute name.`)
  const src = doc.source
  const attr = attrNamed(n, name)
  const label = value === null || value === false ? `Removed ${name} from <${n.name}>` : `Set ${name} on <${n.name}>`
  if (!attr) {
    const text = renderAttr(name, value)
    if (text === null) return label
    const at = n.attrs.length ? Math.max(...n.attrs.map((a) => a.end)) : n.nameEnd
    ed.insert(at, ' ' + text)
    return label
  }
  const explicitExpr = typeof value === 'object' && value !== null
  if (attr.kind === 'dynamic' && !explicitExpr && !e.force) throw new EditError('dynamic', FROM_VARIABLE)
  const quote = attr.quote === "'" ? "'" : '"'
  const text = renderAttr(name, value, quote)
  if (text === null) {
    let s0 = attr.start
    while (s0 > 0 && /[ \t]/.test(src[s0 - 1]!)) s0--
    ed.remove(s0, attr.end)
  } else if (text !== src.slice(attr.start, attr.end)) ed.replace(attr.start, attr.end, text)
  return label
}

function setTag(doc: Doc, n: SNode, ed: Editor, tag: string): string {
  if (n.kind === 'special') throw new EditError('unsupported', `<${n.name}> is left alone.`)
  if (n.type === 'SvelteElement') throw new EditError('unsupported', '<svelte:element> takes its tag from `this`.')
  if (!/^[A-Za-z][\w.-]*$/.test(tag)) throw new EditError('invalid', `"${tag}" is not a valid tag name.`)
  if (VOID.has(n.name) !== VOID.has(tag) && (n.selfClosing || VOID.has(n.name) || VOID.has(tag)))
    throw new EditError('unsupported', `Cannot change between void and non-void tags (<${n.name}> → <${tag}>).`)
  if (tag === n.name) return `Kept <${n.name}>`
  ed.replace(n.start + 1, n.nameEnd, tag)
  if (n.closeStart >= 0) ed.replace(n.closeStart + 2, n.closeStart + 2 + n.name.length, tag)
  return `Changed <${n.name}> to <${tag}>`
}

/* ------------------------------------------------------------------ *
 * structure: placement, insert, move, duplicate, remove
 * ------------------------------------------------------------------ */

function reindent(block: string, fromIndent: string, toIndent: string): string {
  const lines = block.replace(/\n$/, '').split('\n')
  return lines
    .map((l, i) => {
      const body = l.startsWith(fromIndent) ? l.slice(fromIndent.length) : l.trimStart()
      return i === 0 ? body : body ? toIndent + body : body
    })
    .join('\n')
}

/** Where `text` (a single block, first line unindented) goes for `position` relative to `target`. */
function place(doc: Doc, target: SNode, position: Position, text: string, ed: Editor): void {
  const src = doc.source
  const baseIndent = indentOf(src, target.start)
  const range = blockRange(doc, target, false)
  const owns = range.start !== target.start // target alone on its lines
  if (position === 'before') {
    const at = owns ? range.start : target.start
    if (owns) ed.insert(at, baseIndent + reindent(text, '', baseIndent) + '\n')
    else ed.insert(at, text + ' ')
    return
  }
  if (position === 'after') {
    if (owns) {
      const at = lineEndOf(src, target.end)
      ed.insert(at, '\n' + baseIndent + reindent(text, '', baseIndent))
    } else ed.insert(target.end, ' ' + text)
    return
  }
  if (target.kind === 'element' && (target.selfClosing || VOID.has(target.name) || (target.closeStart < 0 && target.openEnd >= target.end)))
    throw new EditError('unsupported', `<${target.name}> cannot contain elements.`)
  const inner = baseIndent + unitFor(baseIndent)
  const closeAt = target.closeStart >= 0 ? target.closeStart : target.end
  if (position === 'prepend') {
    const firstNl = src.slice(target.openEnd, closeAt).startsWith('\n') || /^[ \t]*\n/.test(src.slice(target.openEnd, closeAt))
    if (firstNl || !src.slice(target.openEnd, closeAt).trim()) ed.insert(target.openEnd, '\n' + inner + reindent(text, '', inner))
    else ed.insert(target.openEnd, text)
    return
  }
  // append
  const body = src.slice(target.openEnd, closeAt)
  const trail = /\s*$/.exec(body)![0]
  if (trail.includes('\n')) ed.insert(closeAt - trail.length, '\n' + inner + reindent(text, '', inner))
  else if (!body.trim()) ed.insert(target.openEnd, '\n' + inner + reindent(text, '', inner) + '\n' + baseIndent)
  else ed.insert(closeAt, text)
}

function addImports(doc: Doc, ed: Editor, imports: string[]): void {
  const src = doc.source
  const wanted = imports.map((i) => i.trim().replace(/;$/, '').replace(/^import\s+/, '')).filter((i) => i && !src.includes(i))
  if (!wanted.length) return
  const inst = doc.instance
  if (!inst) {
    ed.insert(src.length, `${src.endsWith('\n') ? '' : '\n'}\n<script>\n${wanted.map((w) => `  import ${w}`).join('\n')}\n</script>\n`)
    return
  }
  const body: any[] = inst.content?.body ?? []
  const lastImport = [...body].reverse().find((b) => b.type === 'ImportDeclaration')
  const text = wanted.map((w) => `import ${w}`)
  if (lastImport) ed.insert(lastImport.end, '\n' + indentOf(src, lastImport.start) + text.join('\n' + indentOf(src, lastImport.start)))
  else {
    const gt = src.indexOf('>', inst.start) + 1
    ed.insert(gt, '\n  ' + text.join('\n  '))
  }
}

function inside(a: SNode, b: SNode): boolean {
  return a.start >= b.start && a.end <= b.end
}

/* ------------------------------------------------------------------ *
 * style patches
 * ------------------------------------------------------------------ */

const NAMED_COLORS = '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d+|white|black|transparent|current'
const TW: Record<string, { token: (v: string) => string; owns: RegExp }> = {
  width: { token: (v) => `w-[${v}]`, owns: /^w-/ },
  height: { token: (v) => `h-[${v}]`, owns: /^h-/ },
  'min-width': { token: (v) => `min-w-[${v}]`, owns: /^min-w-/ },
  'max-width': { token: (v) => `max-w-[${v}]`, owns: /^max-w-/ },
  'min-height': { token: (v) => `min-h-[${v}]`, owns: /^min-h-/ },
  'max-height': { token: (v) => `max-h-[${v}]`, owns: /^max-h-/ },
  opacity: { token: (v) => `opacity-[${v}]`, owns: /^opacity-/ },
  rotate: { token: (v) => `rotate-[${v}]`, owns: /^-?rotate-/ },
  gap: { token: (v) => `gap-[${v}]`, owns: /^gap-/ },
  padding: { token: (v) => `p-[${v}]`, owns: /^p-/ },
  margin: { token: (v) => `m-[${v}]`, owns: /^-?m-/ },
  'border-radius': { token: (v) => `rounded-[${v}]`, owns: /^rounded(-|$)/ },
  'background-color': { token: (v) => `bg-[color:${v}]`, owns: new RegExp(`^bg-(?:\\[color:|${NAMED_COLORS})`) },
  color: { token: (v) => `text-[color:${v}]`, owns: new RegExp(`^text-(?:\\[color:|${NAMED_COLORS})`) },
  'font-size': { token: (v) => `text-[length:${v}]`, owns: /^text-(?:xs|sm|base|lg|[2-9]xl|\[length:)/ }
}

const kebab = (p: string): string => p.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** Split a style attribute's text into `[prop, value]` declarations (`;` inside parens/quotes is kept). */
export function parseDeclarations(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let depth = 0
  let quote = ''
  let cur = ''
  const push = (): void => {
    const i = cur.indexOf(':')
    if (i > 0) out.push([cur.slice(0, i).trim(), cur.slice(i + 1).trim()])
    cur = ''
  }
  for (const ch of css) {
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      push()
      continue
    }
    cur += ch
  }
  push()
  return out
}

function patchStyle(doc: Doc, n: SNode, ed: Editor, props: Record<string, string | null>, mode: 'auto' | 'inline' | 'tailwind'): string {
  if (n.kind === 'special') throw new EditError('unsupported', `<${n.name}> is left alone.`)
  const label = `Changed ${Object.keys(props).map(kebab).join(', ')} of <${n.name}>`
  const cls: { add: string[]; remove: string[] } = { add: [], remove: [] }
  const inline: Record<string, string | null> = {}
  const classAttr = attrNamed(n, 'class')
  const current = classAttr ? tokens(decode(classAttr.parts.filter((p) => p.type === 'text'))) : []
  for (const [raw, value] of Object.entries(props)) {
    const prop = kebab(raw)
    const map = TW[prop]
    if (mode === 'inline' || !map) {
      if (mode === 'tailwind') throw new EditError('unsupported', `No Tailwind class for "${prop}"; use inline mode.`)
      inline[prop] = value
      continue
    }
    for (const t of current) if (map.owns.test(t)) cls.remove.push(t)
    if (value !== null) cls.add.push(map.token(value.trim().replace(/\s+/g, '_')))
  }
  if (cls.add.length || cls.remove.length) setClasses(doc, n, ed, { op: 'setClasses', add: cls.add, remove: cls.remove })
  if (Object.keys(inline).length) setStyleAttr(doc, n, ed, inline)
  return label
}

/** Merge declarations into the static `style` attribute, leaving the other declarations as written. */
function setStyleAttr(doc: Doc, n: SNode, ed: Editor, props: Record<string, string | null>): void {
  const src = doc.source
  const attr = attrNamed(n, 'style')
  const decls = attr && attr.kind === 'static' ? parseDeclarations(decode(attr.parts)) : []
  if (attr && attr.kind === 'dynamic') throw new EditError('dynamic', FROM_VARIABLE)
  const merged = new Map(decls)
  for (const [k, v] of Object.entries(props)) {
    if (v === null) merged.delete(k)
    else merged.set(k, v)
  }
  const text = [...merged].map(([k, v]) => `${k}: ${v}`).join('; ')
  if (!attr) {
    if (!text) return
    const at = n.attrs.length ? Math.max(...n.attrs.map((a) => a.end)) : n.nameEnd
    ed.insert(at, ` style="${encodeAttr(text)}"`)
  } else if (!text) {
    let s0 = attr.start
    while (s0 > 0 && /[ \t]/.test(src[s0 - 1]!)) s0--
    ed.remove(s0, attr.end)
  } else if (attr.kind === 'boolean') ed.replace(attr.start, attr.end, `style="${encodeAttr(text)}"`)
  else {
    const q = attr.quote === "'" ? "'" : '"'
    ed.replace(attr.valueStart!, attr.valueEnd!, encodeAttr(text, q))
  }
}

function prefixed(prefix: string, ts: string[] | undefined): string[] {
  return (ts ?? []).flatMap(tokens).map((t) => prefix + t)
}

/* ------------------------------------------------------------------ *
 * public
 * ------------------------------------------------------------------ */

export function applyEdit(source: string, svelte: SvelteCompiler, at: Target, edit: SvelteEdit): EditResult {
  const doc = parseOrThrow(source, svelte)
  const node = requireTag(findAt(doc, at.line, at.col))
  const ed = new Editor(source)
  let label: string
  switch (edit.op) {
    case 'setText':
      label = setText(doc, node, ed, edit.text, edit.expect)
      break
    case 'setClasses':
      label = setClasses(doc, node, ed, edit)
      break
    case 'setAttr':
      if (edit.name === 'class' && typeof edit.value === 'string') label = setClasses(doc, node, ed, { op: 'setClasses', set: edit.value })
      else label = setAttr(doc, node, ed, edit.name, edit.value)
      break
    case 'setProp':
      if (node.kind !== 'component') throw new EditError('unsupported', 'setProp needs a component instance.')
      label = setAttr(doc, node, ed, edit.name, edit.value).replace(' on <', ' prop on <')
      break
    case 'setTag':
      label = setTag(doc, node, ed, edit.tag)
      break
    case 'insert': {
      if (node.kind === 'special') throw new EditError('unsupported', `<${node.name}> is left alone.`)
      const markup = edit.markup.trim()
      if (!markup) throw new EditError('invalid', 'Nothing to insert.')
      try {
        parseSvelte(markup, svelte)
      } catch (e) {
        throw new EditError('no-parse', `Couldn't insert it: the code wouldn't parse (${e instanceof Error ? e.message.split('\n')[0] : e}).`)
      }
      place(doc, node, edit.position, markup, ed)
      if (edit.imports?.length) addImports(doc, ed, edit.imports)
      label = `Inserted markup ${edit.position} <${node.name}>`
      break
    }
    case 'patchStyle':
      label = patchStyle(doc, node, ed, edit.props, edit.mode ?? 'auto')
      break
    case 'setPrefixedClasses':
      label = setClasses(doc, node, ed, { op: 'setClasses', add: prefixed(edit.prefix, edit.add), remove: prefixed(edit.prefix, edit.remove) })
      break
    case 'setStateClasses':
      label = setClasses(doc, node, ed, { op: 'setClasses', add: prefixed(`${edit.state}:`, edit.add), remove: prefixed(`${edit.state}:`, edit.remove) }).replace('classes', `${edit.state} classes`)
      break
    case 'setVariantClasses': {
      const pfx = `data-[${edit.prop ?? 'variant'}=${edit.value}]:`
      label = setClasses(doc, node, ed, { op: 'setClasses', add: prefixed(pfx, edit.add), remove: prefixed(pfx, edit.remove) }).replace('classes', `${edit.value} variant classes`)
      break
    }
    case 'duplicate': {
      const text = source.slice(node.start, node.end)
      place(doc, node, 'after', text, ed)
      label = `Duplicated <${node.name}>`
      break
    }
    case 'remove': {
      const r = blockRange(doc, node)
      ed.remove(r.start, r.end)
      label = `Removed <${node.name}>`
      break
    }
    case 'move': {
      const dest = requireTag(findAt(doc, edit.to.line, edit.to.col))
      if (dest === node || inside(dest, node)) throw new EditError('invalid', 'An element cannot move into itself.')
      if (edit.position === 'before' && dest.start === node.end) return finish(source, svelte, ed.s, [], `Kept <${node.name}>`)
      const r = blockRange(doc, node)
      const text = source.slice(r.start, r.end)
      const ind = indentOf(source, node.start)
      const block = reindent(text, ind, '')
      place(doc, dest, edit.position, block.replace(/\s+$/, ''), ed)
      ed.remove(r.start, r.end)
      label = `Moved <${node.name}> ${edit.position} <${dest.name}>`
      break
    }
  }
  return finish(source, svelte, ed.s, ed.changes, label)
}

/** Props a component declares: `let { a, b = 3 } = $props()` or `export let a = 1`. */
export function listProps(source: string, svelte: SvelteCompiler): PropInfo[] {
  const doc = parseOrThrow(source, svelte)
  const body: any[] = doc.instance?.content?.body ?? []
  const out: PropInfo[] = []
  if (doc.blanked) {
    // Svelte < 5 with lang="ts": the script AST was blanked, so read `export let` by text
    for (const sc of doc.scripts.filter((x) => !x.module)) {
      const text = source.slice(sc.contentStart, sc.contentEnd)
      for (const m of text.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+?)?\s*(?:=\s*([^;\n]+?))?\s*(?:;|\n|$)/g)) {
        out.push({ name: m[1]!, required: m[2] === undefined, ...(m[2] !== undefined ? { default: m[2] } : {}) })
      }
    }
    return out
  }
  for (const st of body) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        const init = d.init
        if (init?.type === 'CallExpression' && init.callee?.name === '$props' && d.id.type === 'ObjectPattern') {
          for (const p of d.id.properties) {
            if (p.type === 'RestElement') out.push({ name: p.argument.name, required: false, rest: true })
            else {
              const key = p.key?.name ?? p.key?.value
              const val = p.value
              const hasDefault = val?.type === 'AssignmentPattern'
              const dflt = hasDefault ? source.slice(val.right.start, val.right.end) : undefined
              out.push({ name: String(key), required: !hasDefault, ...(dflt !== undefined ? { default: dflt } : {}) })
            }
          }
        }
      }
    } else if (st.type === 'ExportNamedDeclaration' && st.declaration?.type === 'VariableDeclaration' && st.declaration.kind === 'let') {
      for (const d of st.declaration.declarations) {
        if (d.id.type !== 'Identifier') continue
        const dflt = d.init ? source.slice(d.init.start, d.init.end) : undefined
        out.push({ name: d.id.name, required: !d.init, ...(dflt !== undefined ? { default: dflt } : {}) })
      }
    }
  }
  return out
}
