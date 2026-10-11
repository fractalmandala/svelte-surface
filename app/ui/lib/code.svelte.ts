// Code pane: file tree, tabs, CodeMirror editor, draft state (dirty/conflict), save/revert/diff, view modes.
// Everything typed or edited on the canvas is a DRAFT on the server; Save is the only thing that writes to disk.
import { SvelteSet } from 'svelte/reactivity'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { MergeView } from '@codemirror/merge'
import { api, messageOf } from './api.ts'
import * as CM from './editor.ts'
import { confirmBox } from './dialogs.svelte.ts'
import { ed, hooks, refreshHistory, status, undoRedo } from './surface.svelte.ts'
import type { DraftInfo, FileState, Mode } from './types.ts'

/** one open file; the flags the UI shows are reactive, the CodeMirror state is not */
export class Tab {
  dirty = $state(false)
  conflict = $state(false)
  error = $state<string | null>(null)
  state: EditorState | null = null
  pending = false
  disk: string | null = null
  constructor(readonly file: string) {}
}

export const code = $state({
  mode: 'design' as Mode,
  preview: false,
  tabs: [] as Tab[],
  active: null as Tab | null,
  view: null as EditorView | null,
  merge: null as MergeView | null,
  files: [] as string[],
  treeError: '',
  drafts: [] as DraftInfo[],
  expanded: new SvelteSet<string>(['src', 'src/routes', 'src/lib']),
  draftsOpen: false,
  diff: { open: false, title: '', sub: '' }
})
/** non-reactive DOM handles registered by components */
export const codeDom: { host: HTMLElement | null; diffHost: HTMLElement | null } = { host: null, diffHost: null }
let syncPromise: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
declare global { interface Window { __code: typeof code; __dirty: number } }
window.__code = code // tests / debugging

/* ---------- editor plumbing ---------- */
const cmHooks: CM.EditorHooks = {
  onChange: () => scheduleSync(),
  onSave: () => void saveFiles(code.active ? [code.active.file] : null),
  onUndo: () => void undoRedo('undo'),
  onRedo: () => void undoRedo('redo')
}
function ensureView(): EditorView {
  if (!code.view) {
    if (!codeDom.host) throw new Error('code editor host is not mounted')
    code.view = CM.createView(codeDom.host)
  }
  return code.view
}
const emptyState = (): EditorState => CM.makeState('x.txt', '', cmHooks)

function scheduleSync(): void {
  const tab = code.active
  if (!tab) return
  tab.pending = true
  clearTimeout(timer)
  timer = setTimeout(() => void flushTyped(), 250)
}
/** send typed text to the server as a draft (coalesced into one undo step). Resolves when it landed. */
export function flushTyped(): Promise<void> {
  clearTimeout(timer)
  const tab = code.active
  const run = async (): Promise<void> => {
    if (syncPromise) await syncPromise.catch(() => {})
    if (!tab?.pending || tab.error || !code.view) return
    tab.pending = false
    const text = code.view.state.doc.toString()
    try {
      const r = await api<{ dirty: boolean }>('/api/draft/set', { file: tab.file, text, typed: true })
      tab.dirty = r.dirty
    } catch (e) { status(messageOf(e), 'err') }
  }
  syncPromise = run()
  return syncPromise
}

export async function openFile(file: string, { line, col, focus = false }: { line?: number; col?: number; focus?: boolean } = {}): Promise<void> {
  if (code.active) await flushTyped()
  let tab = code.tabs.find((t) => t.file === file)
  const fresh = !tab
  if (!tab) tab = new Tab(file)
  await activate(tab)
  if (fresh) code.tabs.push(tab) // the tab appears once its content is in the editor
  if (line && code.view) CM.reveal(code.view, line, col)
  if (focus) code.view?.focus()
}

async function loadTab(tab: Tab): Promise<void> {
  try {
    const r = await api<FileState>('/api/file?' + new URLSearchParams({ file: tab.file }))
    tab.error = null
    tab.dirty = r.dirty
    tab.conflict = r.conflict
    tab.disk = r.disk
    if (!tab.state) tab.state = CM.makeState(tab.file, r.text, cmHooks)
    else if (!tab.pending && tab.state.doc.toString() !== r.text) {
      if (tab === code.active && code.view) CM.applyRemote(code.view, r.text)
      else tab.state = CM.withText(tab.state, r.text)
    }
  } catch (e) {
    tab.error = messageOf(e)
    tab.state = emptyState()
  }
}

async function activate(tab: Tab): Promise<void> {
  const view = ensureView()
  if (code.active && code.active !== tab && code.active.state) code.active.state = view.state
  code.active = tab
  await loadTab(tab)
  if (tab.state) view.setState(tab.state)
  view.dispatch({}) // refresh
  const ps = tab.file.split('/')
  for (let i = 1; i < ps.length; i++) code.expanded.add(ps.slice(0, i).join('/'))
}

export function closeTab(tab: Tab): void {
  const i = code.tabs.indexOf(tab)
  if (i < 0) return
  code.tabs.splice(i, 1)
  if (code.active === tab) {
    code.active = null
    const next = code.tabs[Math.min(i, code.tabs.length - 1)]
    if (next) void activate(next)
    else ensureView().setState(emptyState())
  }
}
export async function switchTo(t: Tab): Promise<void> {
  if (t === code.active) return
  await flushTyped()
  await activate(t)
}

export async function resolveConflict(file: string, action: 'reload' | 'keep' | 'overwrite' | 'diff'): Promise<void> {
  if (action === 'diff') return openDiff(file)
  try {
    await flushTyped()
    await api('/api/draft/resolve', { file, action })
    status(action === 'reload' ? `Reloaded ${file} from disk` : action === 'keep' ? `Kept your draft of ${file}` : `Overwrote ${file} on disk`, 'ok')
    await refreshDrafts()
    const t = code.tabs.find((x) => x.file === file)
    if (t) await loadTab(t)
  } catch (e) { status(messageOf(e), 'err') }
}

/* ---------- drafts ---------- */
export async function refreshDrafts(): Promise<void> {
  if (!ed.info) return
  let r: { drafts: DraftInfo[] }
  try { r = await api('/api/drafts') } catch { return }
  code.drafts = r.drafts
  const byFile = new Map(r.drafts.map((d) => [d.file, d]))
  for (const t of code.tabs) {
    const d = byFile.get(t.file)
    t.dirty = !!d
    t.conflict = !!d?.conflict
    if (t === code.active) t.pending && (t.dirty = true)
  }
  window.__dirty = r.drafts.length
}

export async function saveFiles(files: string[] | null): Promise<boolean> {
  try {
    await flushTyped()
    const r = await api<{ saved: string[] }>('/api/draft/save', { files: files ?? undefined })
    status(r.saved.length ? `Saved ${r.saved.join(', ')} to disk` : 'Nothing to save', r.saved.length ? 'ok' : '')
    await refreshDrafts()
    return true
  } catch (e) {
    const f = e as { code?: string; files?: string[] }
    if (f.code === 'conflict') {
      status(`${(f.files ?? []).join(', ')} changed on disk since you opened it. Nothing was saved: reload it or choose how to resolve.`, 'err')
      await refreshDrafts()
      if (!files || files.length !== 1 || code.active?.file !== files[0] || code.mode === 'design') code.draftsOpen = true
    } else status(messageOf(e), 'err')
    return false
  }
}

export async function revertFiles(files: string[] | null): Promise<void> {
  const all = !files
  const list = files ?? code.drafts.map((d) => d.file)
  if (!list.length) return
  const ok = await confirmBox<boolean>({
    title: all ? 'Discard all unsaved changes?' : 'Revert this file?',
    text: 'Your draft is dropped and the file shows what is on disk again. This cannot be undone.',
    list,
    buttons: [{ label: 'Cancel', value: false }, { label: all ? 'Discard all' : 'Revert', kind: 'danger', value: true }]
  })
  if (!ok) return
  try {
    await flushTyped()
    await api('/api/draft/revert', { files: files ?? undefined })
    status(`Reverted ${list.join(', ')}`, 'ok')
    for (const t of code.tabs) if (list.includes(t.file)) t.pending = false
    await refreshDrafts()
    for (const t of code.tabs) if (list.includes(t.file)) await loadTab(t)
    await refreshHistory()
  } catch (e) { status(messageOf(e), 'err') }
}

export async function openDiff(file: string): Promise<void> {
  try {
    await flushTyped()
    const r = await api<FileState>('/api/file?' + new URLSearchParams({ file }))
    code.diff.title = file
    code.diff.sub = r.disk === null ? 'file missing on disk' : 'left: on disk · right: draft'
    code.diff.open = true
    // the host exists once the dialog has rendered
    await Promise.resolve()
    const wait = async (): Promise<void> => { for (let i = 0; i < 20 && !codeDom.diffHost; i++) await new Promise((x) => setTimeout(x, 10)) }
    await wait()
    if (!codeDom.diffHost) return
    codeDom.diffHost.innerHTML = ''
    code.merge = CM.createMerge(codeDom.diffHost, file, r.disk ?? '', r.text)
  } catch (e) { status(messageOf(e), 'err') }
}
export function closeDiff(): void {
  code.diff.open = false
  code.merge?.destroy()
  code.merge = null
}

/* ---------- file tree ---------- */
export async function loadTree(): Promise<void> {
  try {
    const r = await api<{ files: string[] }>('/api/tree')
    code.files = r.files
    code.treeError = ''
  } catch (e) { code.treeError = messageOf(e) }
}

/* ---------- modes ---------- */
export function setMode(mode: Mode): void {
  code.mode = mode
  if (mode === 'code') {
    void (async () => {
      if (!code.files.length) await loadTree()
      if (!code.tabs.length) {
        const f = ed.sel?.file ?? (code.files.includes('src/routes/+page.svelte') ? 'src/routes/+page.svelte' : code.files.find((x) => x.endsWith('.svelte')))
        if (f) void openFile(f)
      }
    })()
  }
  window.dispatchEvent(new Event('resize'))
}
export function togglePreview(): void {
  code.preview = !code.preview
  setMode('code')
}
export async function openSelectionInCode(): Promise<void> {
  if (!ed.sel || !ed.insp) return
  if (code.mode === 'design') setMode('opencode')
  await openFile(ed.sel.file, { line: ed.insp.line, col: ed.insp.col, focus: true })
}
export async function reloadActive(): Promise<void> {
  const t = code.active
  if (!t) return
  if (t.dirty) return resolveConflict(t.file, 'reload')
  await loadTab(t)
}

/* ---------- keyboard ---------- */
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || !ed.info) return
  const target = e.target as HTMLElement
  const mod = e.metaKey || e.ctrlKey
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveFiles(code.mode !== 'design' && code.active?.dirty ? [code.active.file] : null)
  } else if (mod && e.key.toLowerCase() === 'z' && !inField && !target.closest?.('.cm-editor')) {
    e.preventDefault()
    void undoRedo(e.shiftKey ? 'redo' : 'undo')
  } else if (e.key === 'Escape' && code.mode === 'opencode' && !target.closest?.('.cm-search')) setMode('design')
}

let wired = false
export function wireCode(): void {
  if (wired) return
  wired = true
  addEventListener('keydown', onKey)
  addEventListener('beforeunload', (e) => { if (window.__dirty) { e.preventDefault(); e.returnValue = '' } })

  /* hooks into the canvas editor */
  hooks.beforeEdit = () => flushTyped()
  hooks.onSelect = (ref, insp, reveal) => {
    if (code.mode !== 'design' && reveal) void openFile(ref.file, { line: insp.line, col: insp.col })
  }
  hooks.onDraft = async (files, fromDisk) => {
    await refreshDrafts()
    for (const t of code.tabs) if (fromDisk || !files || files.includes(t.file)) await loadTab(t)
    if (fromDisk) void loadTree()
  }
  hooks.onStart = async () => {
    code.tabs = []
    code.active = null
    code.files = []
    code.preview = false
    code.drafts = []
    if (code.view) code.view.setState(emptyState())
    setMode('design')
    await refreshDrafts()
  }
  hooks.onStop = () => {
    code.tabs = []
    code.active = null
    window.__dirty = 0
  }
}
