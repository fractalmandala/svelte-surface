/**
 * Component authoring: variants and states.
 *
 *  - A VARIANT is a `variant` prop with its default (`let { variant = 'primary' } = $props()` or
 *    `export let variant = 'primary'`), `data-variant={variant}` and a `group/variant` class on each
 *    top-level element. Classes for one value are written `data-[variant=primary]:…`.
 *  - A STATE is a `hover:` / `active:` / `focus-visible:` class on an element.
 */
import {
  parseSvelte, walk, LineIndex, type Doc, type SNode, type SvelteCompiler
} from '../svelte/ast.js'
import {
  Editor, attrNamed, finish, parseOrThrow, setAttr, setClasses
} from './engine.js'
import {
  EditError, type ComponentEdit, type EditResult, type StateInfo, type VariantInfo
} from './types.js'

const RUNES_HINT = /(?<!\$)\$(?:props|state|derived|effect|bindable|inspect|host)\b|\{@render\b|\{#snippet\b/
const STATES = ['hover', 'active', 'focus-visible', 'focus-within', 'focus', 'disabled']

/** Elements a component returns: not inside another element/component, not in {#snippet}, not in <svelte:head>. */
export function topElements(doc: Doc): SNode[] {
  const out: SNode[] = []
  const visit = (nodes: SNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'element') out.push(n)
      else if (n.kind === 'special') {
        if (n.type === 'SvelteHead' || n.type === 'Head') continue
        visit(n.children)
      } else if (n.kind === 'block' && n.type !== 'SnippetBlock') visit(n.children)
    }
  }
  visit(doc.root)
  return out
}

function propsDeclarator(doc: Doc): { id: any; decl: any } | null {
  for (const st of doc.instance?.content?.body ?? []) {
    if (st.type !== 'VariableDeclaration') continue
    for (const d of st.declarations) {
      if (d.init?.type === 'CallExpression' && d.init.callee?.name === '$props') return { id: d.id, decl: st }
    }
  }
  return null
}

function legacyExport(doc: Doc, name: string): { stmt: any; declarator: any } | null {
  for (const st of doc.instance?.content?.body ?? []) {
    if (st.type === 'ExportNamedDeclaration' && st.declaration?.type === 'VariableDeclaration') {
      for (const d of st.declaration.declarations) if (d.id?.name === name) return { stmt: st, declarator: d }
    }
  }
  return null
}

function quote(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function instanceScript(doc: Doc): Doc['scripts'][number] | undefined {
  return doc.scripts.find((s) => !s.module)
}

/** Add a member to the `Props` interface / type literal of a TS script, if there is one. */
function addToPropsType(doc: Doc, ed: Editor, name: string, type: string): void {
  for (const st of doc.instance?.content?.body ?? []) {
    const body =
      st.type === 'TSInterfaceDeclaration' && st.id?.name === 'Props'
        ? st.body
        : st.type === 'TSTypeAliasDeclaration' && st.id?.name === 'Props' && st.typeAnnotation?.type === 'TSTypeLiteral'
          ? st.typeAnnotation
          : null
    if (body && !(body.body ?? body.members ?? []).some((m: any) => m.key?.name === name)) {
      const closing = doc.source.lastIndexOf('}', body.end)
      const members: any[] = body.body ?? body.members ?? []
      const indent = members.length ? /^[ \t]*/.exec(doc.source.slice(doc.source.lastIndexOf('\n', members[0].start) + 1))![0] : '    '
      const before = doc.source.slice(0, closing)
      const trimmedEnd = before.replace(/\s+$/, '').length
      ed.insert(trimmedEnd, `\n${indent}${name}?: ${type}`)
      return
    }
  }
}

function addVariantProp(doc: Doc, ed: Editor, svelte: SvelteCompiler, e: Extract<ComponentEdit, { op: 'addVariantProp' }>): string {
  const name = e.name ?? 'variant'
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new EditError('invalid', `"${name}" is not a valid prop name.`)
  const src = doc.source
  const tops = topElements(doc)
  if (!tops.length) throw new EditError('unsupported', 'This component has no top-level element to carry the variant.')
  const inst = instanceScript(doc)
  const isTs = inst?.ts ?? false
  const type = e.options?.length ? e.options.map(quote).join(' | ') : 'string'

  // 1. the prop
  const decl = propsDeclarator(doc)
  const existingLegacy = legacyExport(doc, name)
  const hasLegacy = /\bexport\s+let\b|\$\$props\b|\$\$restProps\b/.test(src)
  const runes = e.runes ?? (decl ? true : hasLegacy ? false : doc.modern)
  let have = false
  if (decl) {
    if (decl.id.type !== 'ObjectPattern') throw new EditError('unsupported', 'Props are read as one object (`let props = $props()`); destructure them first.')
    have = decl.id.properties.some((p: any) => (p.key?.name ?? p.key?.value) === name)
    if (!have) {
      const props: any[] = decl.id.properties
      const last = [...props].reverse().find((p) => p.type !== 'RestElement')
      const text = `${name} = ${quote(e.default)}`
      if (!props.length) ed.insert(decl.id.start + 1, ` ${text} `)
      else if (last) ed.insert(last.end, `, ${text}`)
      else ed.insert(props[0].start, `${text}, `)
      if (isTs) addToPropsType(doc, ed, name, type)
    }
  } else if (existingLegacy) have = true
  else if (doc.blanked && new RegExp(`export\\s+let\\s+${name}\\b`).test(src)) have = true
  else if (runes) {
    const line = `let { ${name} = ${quote(e.default)} }${isTs ? `: { ${name}?: ${type} }` : ''} = $props()`
    if (inst) ed.insert(inst.contentStart, `\n  ${line}`)
    else ed.insert(0, `<script>\n  ${line}\n</script>\n\n`)
  } else {
    const line = `export let ${name}${isTs ? `: ${type}` : ''} = ${quote(e.default)}`
    if (inst) {
      const body: any[] = doc.instance?.content?.body ?? []
      const exports = body.filter((b: any) => b.type === 'ExportNamedDeclaration' && b.declaration?.type === 'VariableDeclaration')
      const imports = body.filter((b: any) => b.type === 'ImportDeclaration')
      let anchor: number | null = null
      if (exports.length) anchor = exports[exports.length - 1].end
      else if (doc.blanked) {
        const text = src.slice(inst.contentStart, inst.contentEnd)
        const ms = [...text.matchAll(/export\s+let\s+[^;\n]*(?:;|(?=\n)|$)/g)]
        const last = ms[ms.length - 1]
        if (last) anchor = inst.contentStart + last.index! + last[0].length
      }
      if (anchor === null && imports.length) anchor = imports[imports.length - 1].end
      ed.insert(anchor ?? inst.contentStart, `\n  ${line}`)
    } else ed.insert(0, `<script>\n  ${line}\n</script>\n\n`)
  }

  // 2. data-variant + group/<name> on each top-level element
  for (const n of tops) {
    if (!attrNamed(n, 'data-variant')) setAttr(doc, n, ed, 'data-variant', { expr: name })
    setClasses(doc, n, ed, { op: 'setClasses', add: [`group/${name}`] })
  }
  void svelte
  return have ? `Variant "${name}" already declared; marked top elements` : `Added variant prop "${name}" (default ${e.default})`
}

function setVariantDefault(doc: Doc, ed: Editor, e: Extract<ComponentEdit, { op: 'setVariantDefault' }>): string {
  const name = e.name ?? 'variant'
  const src = doc.source
  const decl = propsDeclarator(doc)
  if (decl?.id.type === 'ObjectPattern') {
    const p = decl.id.properties.find((x: any) => (x.key?.name ?? x.key?.value) === name)
    if (!p) throw new EditError('not-found', `No prop "${name}" in $props().`)
    if (p.value?.type === 'AssignmentPattern') ed.replace(p.value.right.start, p.value.right.end, quote(e.default))
    else ed.insert(p.end, ` = ${quote(e.default)}`)
    return `Set default of "${name}" to ${e.default}`
  }
  const leg = legacyExport(doc, name)
  if (leg) {
    const d = leg.declarator
    if (d.init) ed.replace(d.init.start, d.init.end, quote(e.default))
    else ed.insert(d.id.end + (d.id.typeAnnotation ? src.slice(d.id.end, d.end).length : 0), ` = ${quote(e.default)}`)
    return `Set default of "${name}" to ${e.default}`
  }
  const sc = instanceScript(doc)
  if (doc.blanked && sc) {
    const text = src.slice(sc.contentStart, sc.contentEnd)
    const m = new RegExp(`(export\\s+let\\s+${name}\\b[^=;\\n]*=\\s*)([^;\\n]+?)(\\s*(?:;|\\n|$))`).exec(text)
    if (m) {
      const at = sc.contentStart + m.index + m[1]!.length
      ed.replace(at, at + m[2]!.length, quote(e.default))
      return `Set default of "${name}" to ${e.default}`
    }
  }
  throw new EditError('not-found', `No prop "${name}" declared.`)
}

function removeVariantProp(doc: Doc, ed: Editor, e: Extract<ComponentEdit, { op: 'removeVariantProp' }>): string {
  const name = e.name ?? 'variant'
  const src = doc.source
  for (const n of topElements(doc)) {
    if (attrNamed(n, 'data-variant')) setAttr(doc, n, ed, 'data-variant', null, { force: true })
    setClasses(doc, n, ed, { op: 'setClasses', remove: [`group/${name}`] })
  }
  const decl = propsDeclarator(doc)
  if (decl?.id.type === 'ObjectPattern') {
    const props: any[] = decl.id.properties
    const i = props.findIndex((x) => (x.key?.name ?? x.key?.value) === name)
    if (i >= 0) {
      if (props.length === 1) ed.remove(props[0].start, props[0].end)
      else if (i < props.length - 1) ed.remove(props[i].start, props[i + 1].start)
      else ed.remove(props[i - 1].end, props[i].end)
    }
  } else {
    const leg = legacyExport(doc, name)
    if (leg) {
      let s0 = leg.stmt.start
      while (s0 > 0 && /[ \t]/.test(src[s0 - 1]!)) s0--
      const nl = src[leg.stmt.end] === '\n' ? leg.stmt.end + 1 : leg.stmt.end
      ed.remove(s0, nl)
    }
  }
  return `Removed variant prop "${name}"`
}

export function applyComponentEdit(source: string, svelte: SvelteCompiler, edit: ComponentEdit): EditResult {
  const doc = parseOrThrow(source, svelte)
  const ed = new Editor(source)
  let label: string
  switch (edit.op) {
    case 'addVariantProp':
      label = addVariantProp(doc, ed, svelte, edit)
      break
    case 'setVariantDefault':
      label = setVariantDefault(doc, ed, edit)
      break
    case 'removeVariantProp':
      label = removeVariantProp(doc, ed, edit)
      break
  }
  return finish(source, svelte, ed.s, ed.changes, label)
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

function staticClassTokens(n: SNode): string[] {
  const a = attrNamed(n, 'class')
  if (!a) return []
  return a.parts.filter((p) => p.type === 'text').flatMap((p) => (p.data ?? '').split(/\s+/).filter(Boolean))
}

export function listVariants(source: string, svelte: SvelteCompiler): VariantInfo[] {
  const doc = parseSvelte(source, svelte)
  const names = new Set<string>()
  for (const n of topElements(doc)) {
    const a = attrNamed(n, 'data-variant')
    if (!a) continue
    const m = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(source.slice(a.valueStart ?? a.start, a.valueEnd ?? a.end))
    if (m) names.add(m[1]!)
  }
  const defaults = new Map<string, string>()
  const decl = propsDeclarator(doc)
  if (decl?.id.type === 'ObjectPattern') {
    for (const p of decl.id.properties) {
      if (p.value?.type === 'AssignmentPattern') defaults.set(p.key?.name, source.slice(p.value.right.start, p.value.right.end))
    }
  }
  for (const nm of names) {
    const leg = legacyExport(doc, nm)
    if (leg?.declarator.init) defaults.set(nm, source.slice(leg.declarator.init.start, leg.declarator.init.end))
    const sc = instanceScript(doc)
    if (doc.blanked && sc && !defaults.has(nm)) {
      const m = new RegExp(`export\\s+let\\s+${nm}\\b[^=;\\n]*=\\s*([^;\\n]+)`).exec(source.slice(sc.contentStart, sc.contentEnd))
      if (m) defaults.set(nm, m[1]!.trim())
    }
  }
  const unquote = (v: string | undefined): string | undefined => v?.replace(/^['"`]|['"`]$/g, '')
  return [...names].map((name) => {
    const opts = new Set<string>()
    walk(doc.root, (n) => {
      for (const t of staticClassTokens(n)) {
        const m = new RegExp(`^data-\\[${name}=([^\\]]+)\\]:`).exec(t)
        if (m) opts.add(m[1]!)
      }
    })
    const d = unquote(defaults.get(name))
    if (d) opts.add(d)
    return { name, ...(d !== undefined ? { default: d } : {}), options: [...opts] }
  })
}

export function listStates(source: string, svelte: SvelteCompiler): StateInfo[] {
  const doc = parseSvelte(source, svelte)
  const lines = new LineIndex(source)
  const out: StateInfo[] = []
  walk(doc.root, (n) => {
    if (n.kind !== 'element' && n.kind !== 'component') return
    const states: Record<string, string[]> = {}
    for (const t of staticClassTokens(n)) {
      for (const s of STATES) {
        if (t.startsWith(`${s}:`)) (states[s] ??= []).push(t.slice(s.length + 1))
      }
    }
    if (Object.keys(states).length) {
      const { line, col } = lines.locate(n.start)
      out.push({ line, col, tag: n.name, states })
    }
  })
  return out
}
