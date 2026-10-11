// CodeMirror 6 wrapper for the app, bundled by Vite with the UI. Exposes a tiny API; no history()
// extension on purpose: undo/redo is the app's draft history (Mod-z / Mod-Shift-z call back into it).
import { Annotation, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, rectangularSelection, dropCursor } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, indentUnit } from '@codemirror/language'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { MergeView } from '@codemirror/merge'

const remote = Annotation.define<boolean>()

export interface EditorHooks { onChange(): void; onSave(): void; onUndo(): void; onRedo(): void }

export function languageFor(file: string): Extension {
  const ext = (file.split('.').pop() || '').toLowerCase()
  if (['svelte', 'html', 'htm', 'vue', 'astro'].includes(ext)) return html({ autoCloseTags: false })
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true })
  if (ext === 'tsx') return javascript({ typescript: true, jsx: true })
  if (ext === 'jsx') return javascript({ jsx: true })
  if (['js', 'mjs', 'cjs'].includes(ext)) return javascript()
  if (['css', 'scss', 'less', 'pcss'].includes(ext)) return css()
  if (ext === 'json' || ext === 'jsonc') return json()
  if (['md', 'markdown', 'mdx'].includes(ext)) return markdown()
  return []
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: '#fff' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5' },
  '.cm-gutters': { backgroundColor: '#f9fafb', color: '#9ca3af', borderRight: '1px solid #e5e7eb' },
  '.cm-activeLine': { backgroundColor: '#fef9c3aa' },
  '.cm-activeLineGutter': { backgroundColor: '#fef3c7' },
  '&.cm-focused': { outline: 'none' }
})

/** Build the extensions for one file. hooks: { onChange(), onSave(), onUndo(), onRedo() } */
export function extensionsFor(file: string, hooks: EditorHooks): Extension[] {
  return [
    lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(), dropCursor(),
    indentOnInput(), bracketMatching(), highlightActiveLine(), highlightSelectionMatches(), rectangularSelection(),
    indentUnit.of('  '), EditorState.tabSize.of(2),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    languageFor(file),
    theme,
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => (hooks.onSave(), true) },
      { key: 'Mod-z', preventDefault: true, run: () => (hooks.onUndo(), true) },
      { key: 'Mod-Shift-z', preventDefault: true, run: () => (hooks.onRedo(), true) },
      { key: 'Mod-y', preventDefault: true, run: () => (hooks.onRedo(), true) },
      indentWithTab,
      ...searchKeymap, ...foldKeymap, ...defaultKeymap
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && !u.transactions.some((t) => t.annotation(remote))) hooks.onChange()
    })
  ]
}

export function createView(parent: HTMLElement): EditorView {
  return new EditorView({ parent, state: EditorState.create({ doc: '' }) })
}

export function makeState(file: string, text: string, hooks: EditorHooks): EditorState {
  return EditorState.create({ doc: text, extensions: extensionsFor(file, hooks) })
}

/** replace `state`'s document by `text` with the smallest change (keeps cursor and folds), flagged as remote */
export function withText(state: EditorState, text: string): EditorState {
  const old = state.doc.toString()
  if (old === text) return state
  let a = 0
  const max = Math.min(old.length, text.length)
  while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++
  let b = 0
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++
  return state.update({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: remote.of(true) }).state
}

/** 1-based line/col → cursor + scroll + select the line's start */
export function reveal(view: EditorView, line: number, col?: number): void {
  const doc = view.state.doc
  const ln = doc.line(Math.max(1, Math.min(line, doc.lines)))
  const pos = Math.min(ln.from + Math.max(0, (col || 1) - 1), ln.to)
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}

export function createMerge(parent: HTMLElement, file: string, a: string, b: string): MergeView {
  const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false), languageFor(file), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), theme, lineNumbers()]
  return new MergeView({ parent, a: { doc: a, extensions: ro }, b: { doc: b, extensions: ro }, highlightChanges: true, gutter: true })
}

/** apply the server's text to a live view with the smallest change, flagged remote (does not echo back) */
export function applyRemote(view: EditorView, text: string): boolean {
  const old = view.state.doc.toString()
  if (old === text) return false
  let a = 0
  const max = Math.min(old.length, text.length)
  while (a < max && old.charCodeAt(a) === text.charCodeAt(a)) a++
  let b = 0
  while (b < max - a && old.charCodeAt(old.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++
  view.dispatch({ changes: { from: a, to: old.length - b, insert: text.slice(a, text.length - b) }, annotations: remote.of(true) })
  return true
}
