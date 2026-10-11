/** What an editor panel needs to know about the element a mark points at. */
import { LineIndex, type SNode, type SvelteCompiler } from '../svelte/ast.js'
import { attrNamed, findAt, parseOrThrow } from './engine.js'
import { EditError, type Target } from './types.js'

export interface InspectAttr {
  name: string
  /** written value (static text), or the source of an `{expr}` / null for a bare attribute */
  value: string | null
  dynamic: boolean
}

export interface Inspection {
  kind: 'element' | 'component' | 'special'
  name: string
  line: number
  col: number
  /** static class tokens joined by a space; null when there is no class attribute */
  classes: string | null
  /** the class attribute has an {expression} part (only the written part is editable) */
  classesDynamic: boolean
  /** the class attribute is nothing but an expression: refused */
  classesLocked: boolean
  attrs: InspectAttr[]
  /** the element's text when it holds only text; null otherwise */
  text: string | null
  /** its content is an {expression} / markup: text edits are refused */
  textLocked: boolean
  canHaveChildren: boolean
  prev: Target | null
  next: Target | null
  parent: Target | null
}

export function inspectAt(source: string, svelte: SvelteCompiler, at: Target): Inspection {
  const doc = parseOrThrow(source, svelte)
  const n = findAt(doc, at.line, at.col)
  if (!n) throw new EditError('not-found', 'No element at that position; the file changed since the preview.')
  const lines = new LineIndex(source)
  const pos = (x: SNode | null | undefined): Target | null => (x ? lines.locate(x.start) : null)
  const isTag = (x: SNode): boolean => x.kind === 'element' || x.kind === 'component' || x.kind === 'special'
  const sibs = (n.parent ? n.parent.children : doc.root).filter(isTag)
  const i = sibs.indexOf(n)
  const cls = attrNamed(n, 'class')
  const textParts = cls?.parts.filter((p) => p.type === 'text') ?? []
  const attrs: InspectAttr[] = n.attrs
    .filter((a) => a.kind !== 'directive' && a.kind !== 'spread')
    .map((a) => ({
      name: a.name,
      dynamic: a.kind === 'dynamic',
      value: a.kind === 'boolean' ? null : a.kind === 'static' ? a.parts.map((p) => p.data ?? '').join('') : source.slice(a.valueStart ?? a.start, a.valueEnd ?? a.end)
    }))
  const hasBody = n.kind === 'element' && !n.selfClosing && n.closeStart >= 0
  const onlyText = hasBody && n.children.every((c) => c.kind === 'text')
  return {
    kind: n.kind as Inspection['kind'],
    name: n.name,
    ...lines.locate(n.start),
    classes: cls ? (cls.kind === 'boolean' ? '' : textParts.map((p) => p.data ?? '').join(' ').split(/\s+/).filter(Boolean).join(' ')) : null,
    classesDynamic: !!cls && cls.kind === 'dynamic',
    classesLocked: !!cls && cls.kind === 'dynamic' && !textParts.length,
    attrs,
    text: onlyText ? n.children.map((c) => c.data ?? '').join('').trim().replace(/\s+/g, ' ') : null,
    textLocked: hasBody && !onlyText,
    canHaveChildren: hasBody || (n.kind !== 'element' && !n.selfClosing),
    prev: pos(sibs[i - 1]),
    next: pos(sibs[i + 1]),
    parent: pos(n.parent && isTag(n.parent) ? n.parent : null)
  }
}
