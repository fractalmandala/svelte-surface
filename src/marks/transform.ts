/**
 * Compile-time mark injection for one `.svelte` file. In memory only; the file
 * on disk is never touched. Every insertion is same-line, so (line, col) in the
 * original source stay true.
 */
import MagicString from 'magic-string'
import { LineIndex, parseSvelte, type Doc, type SNode, type SvelteCompiler } from '../svelte/ast.js'
import { MARK_ATTR, formatLoc } from '../contract.js'

export interface MarkOptions {
  /** force runes (`$props()`) or legacy (`$$props`) receiving of the instance prop; default: detect */
  runes?: boolean
  /** add a side-effect `import '<spec>'` in a module script (used to load the bridge where there is no index.html hook, i.e. SvelteKit) */
  bridgeImport?: string
}

export interface MarkResult {
  code: string
  map: ReturnType<MagicString['generateMap']>
  marks: { fs: number; fsi: number; fsu: number }
}

const RUNES_RE = /(?<!\$)\$(?:props|state|derived|effect|bindable|inspect|host)\b|\{@render\b|\{#snippet\b/

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;').replace(/</g, '&lt;')
}

function findPropsDeclarator(instance: any): { id: any } | null {
  const body: any[] = instance?.content?.body ?? []
  for (const st of body) {
    if (st.type !== 'VariableDeclaration') continue
    for (const d of st.declarations) {
      const init = d.init
      if (init?.type === 'CallExpression' && init.callee?.type === 'Identifier' && init.callee.name === '$props') {
        return { id: d.id }
      }
    }
  }
  return null
}

/** Component name for the `Name|…` prefix: `Foo.Bar` → `Bar`, `svelte:self` → `self`. */
function componentName(n: SNode): string {
  const name = n.name.replace(/^svelte:/, '')
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
}

export function markSvelteSource(
  source: string,
  file: string,
  svelte: SvelteCompiler,
  options: MarkOptions = {}
): MarkResult | null {
  let doc: Doc
  try {
    doc = parseSvelte(source, svelte, file)
  } catch (e) {
    // a Svelte CompileError (has a code / position) = unparsable, mid-typing: no marks, Svelte shows its own error
    if (e && typeof e === 'object' && ('code' in e || 'start' in e || 'position' in e)) return null
    throw e
  }
  const lines = new LineIndex(source)
  const s = new MagicString(source)
  const count = { fs: 0, fsi: 0, fsu: 0 }

  const runes = options.runes ?? (doc.modern && RUNES_RE.test(source))
  const declarator = runes ? findPropsDeclarator(doc.instance) : null
  const propsIdent = declarator && declarator.id.type === 'Identifier' ? (declarator.id.name as string) : null

  // how the receiving side reads the instance props
  const fsiExpr = !runes ? `$$props['${MARK_ATTR.fsi}']` : propsIdent ? `${propsIdent}['${MARK_ATTR.fsi}']` : '__fsi'
  const fscExpr = !runes ? `$$props['${MARK_ATTR.fsc}']` : propsIdent ? `${propsIdent}['${MARK_ATTR.fsc}']` : '__fsc'
  const chainExpr = `[${fscExpr}, ${fsiExpr}].filter(Boolean).join(' ') || undefined`

  let needsReceiver = false

  const visit = (nodes: SNode[], top: boolean, inHead: boolean): void => {
    for (const n of nodes) {
      const here = lines.locate(n.start)
      const loc = formatLoc(file, here.line, here.col)
      if (n.kind === 'special') {
        const head = n.type === 'SvelteHead' || n.type === 'Head'
        const nested = n.name === 'svelte:fragment' || n.type === 'SlotTemplate' ? false : top
        visit(n.children, nested, inHead || head)
        continue
      }
      if (n.kind === 'element' && !inHead) {
        if (!n.attrs.some((a) => a.name === MARK_ATTR.fs)) {
          s.appendLeft(n.nameEnd, ` ${MARK_ATTR.fs}="${esc(loc)}"`)
          count.fs++
          if (top) {
            s.appendLeft(n.nameEnd, ` ${MARK_ATTR.fsu}={${chainExpr}}`)
            count.fsu++
            needsReceiver = true
          }
        }
      } else if (n.kind === 'component' && !inHead) {
        if (!n.attrs.some((a) => a.name === MARK_ATTR.fsi)) {
          s.appendLeft(n.nameEnd, ` ${MARK_ATTR.fsi}="${esc(`${componentName(n)}|${loc}`)}"`)
          count.fsi++
          if (top) {
            s.appendLeft(n.nameEnd, ` ${MARK_ATTR.fsc}={${chainExpr}}`)
            needsReceiver = true
          }
        }
      }
      const isComp = n.kind === 'component'
      const snippet = n.type === 'SnippetBlock'
      // Roots of passed content (component children, {#snippet} bodies) belong to THIS component's
      // usage chain too, so they count as top elements; anything inside a plain element does not.
      visit(n.children, isComp || snippet ? true : n.kind === 'element' ? false : top, inHead)
    }
  }
  visit(doc.root, true, false)

  if (count.fs + count.fsi === 0) return null

  // runes mode: the receiving side must declare the two props
  if (runes && needsReceiver && !propsIdent) {
    const decl = `'${MARK_ATTR.fsi}': __fsi, '${MARK_ATTR.fsc}': __fsc`
    if (declarator) {
      // `let { a, b } = $props()` → add ours at the front of the pattern
      const pat = declarator.id
      const hasMembers = (pat.properties?.length ?? 0) > 0
      s.appendLeft(pat.start + 1, ` ${decl}${hasMembers ? ',' : ''}`)
    } else if (doc.instance) {
      const gt = source.indexOf('>', doc.instance.start)
      s.appendLeft(gt + 1, ` let { ${decl} } = $props();`)
    } else {
      s.prepend(`<script> let { ${decl} } = $props(); </script>`)
    }
  }

  if (options.bridgeImport) {
    const imp = `import '${options.bridgeImport}';`
    if (doc.module) {
      const gt = source.indexOf('>', doc.module.start)
      s.appendLeft(gt + 1, ` ${imp}`)
    } else {
      s.prepend(`<script ${doc.modern ? 'module' : 'context="module"'}>${imp}</script>`)
    }
  }

  const code = s.toString()
  if (code === source) return null
  return { code, map: s.generateMap({ source: file, includeContent: true, hires: true }), marks: count }
}
