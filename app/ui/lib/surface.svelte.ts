// Editor state + actions: the canvas (iframe + bridge messages), pages, layers, selection, inspector edits, history.
// Components read `ed` and call the exported functions; nothing here touches the DOM
// except the iframe handle registered by components/Canvas.svelte.
import { tick } from 'svelte'
import { api, messageOf, query } from './api.ts'
import type { EditResult, History, Inspection, Layer, Page, Pin, ProjectInfo, Ref, StatusKind, StylePatch, SvelteEdit, Tool, VariantsResult } from './types.ts'

const FRAME_ID = 'main'

export const ed = $state({
  info: null as ProjectInfo | null,
  pages: [] as Page[],
  pageValue: '/',
  sel: null as Ref | null,
  insp: null as Inspection | null,
  tool: 'select' as Tool,
  width: 1280,
  zoom: 1,
  stageW: 0,
  stageH: 0,
  frameH: 500,
  pins: [] as Pin[],
  awaitingReload: null as string | null,
  layers: [] as Layer[],
  history: { undo: [], canUndo: false, canRedo: false, redoLabel: null } as History,
  variants: { file: '', text: '' },
  styleMode: '',
  status: { text: 'starting…', kind: '' as StatusKind },
  lastChange: ''
})

/** non-reactive DOM handles registered by Canvas.svelte */
export const dom: { frame: HTMLIFrameElement | null; canvas: HTMLElement | null } = { frame: null, canvas: null }

/** extension points the code pane plugs into (flush typed code before an edit, react to drafts, …) */
export const hooks = {
  beforeEdit: async (): Promise<void> => {},
  onSelect: (_ref: Ref, _insp: Inspection, _reveal: boolean): void => {},
  onDraft: async (_files?: string[], _fromDisk?: boolean): Promise<void> => {},
  onStart: async (_info: ProjectInfo): Promise<void> => {},
  onStop: (): void => {}
}

/* ---------- helpers ---------- */
export function status(text: string, kind: StatusKind = ''): void {
  ed.status.text = text
  ed.status.kind = kind
}
const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean)
export { tokens }
const mkRef = (p: { file: string; line: number; col: number }, tag = ''): Ref => ({ file: p.file, line: p.line, col: p.col, tag, text: '', fs: `${p.file}:${p.line}:${p.col}` })
function send(cmd: Record<string, unknown>): void {
  try { dom.frame?.contentWindow?.postMessage({ __surface: true, frame: FRAME_ID, ...cmd }, '*') } catch { /* frame is gone */ }
}

/* ---------- canvas ---------- */
export function layout(): void {
  const canvas = dom.canvas
  if (!canvas) return
  const avail = canvas.clientWidth - 26
  if (avail < 80) return // hidden or too narrow
  ed.zoom = Math.min(1, avail / ed.width)
  ed.frameH = Math.max(500, Math.round((innerHeight - 330) / ed.zoom))
  ed.stageW = ed.width * ed.zoom
  ed.stageH = ed.frameH * ed.zoom
  send({ setZoom: ed.zoom })
}
export function setWidth(w: number): void { ed.width = w; layout() }
export function reloadFrame(): void { dom.frame?.contentWindow?.location.reload() }
export function setTool(t: Tool): void { ed.tool = t; send({ setTool: t }) }

/* ---------- messages from the bridge ---------- */
interface BridgeMsg { __surface: true; frame: string; t: string; [k: string]: any }
function onBridge(e: MessageEvent): void {
  if (e.source !== dom.frame?.contentWindow) return
  const m = e.data as BridgeMsg | null
  if (!m || m.__surface !== true || m.frame !== FRAME_ID) return
  switch (m.t) {
    case 'ready':
      send({ init: { frame: FRAME_ID, tool: ed.tool, zoom: ed.zoom, canvas: true, wantTree: true } })
      send({ pin: $state.snapshot(ed.pins) })
      if (ed.sel) send({ select: { ref: $state.snapshot(ed.sel) } })
      syncPicker(new URL(m.url).pathname)
      break
    case 'route':
      syncPicker(String(m.route).split('?')[0] ?? '/')
      break
    case 'select':
      void selectRef(m.ref, false)
      break
    case 'layers':
      ed.layers = m.layers
      if (ed.awaitingReload) { status(`✓ ${ed.awaitingReload} — canvas reloaded`, 'ok'); ed.awaitingReload = null }
      break
    case 'live':
      status('resizing: ' + Object.entries((m.patch as StylePatch).props).map(([k, v]) => `${k} ${v}`).join(', '))
      break
    case 'commit':
      void commitPatch(m.patch)
      break
    case 'pin': {
      if (!m.comment) break
      ed.pins = ed.pins.filter((p) => !p.draft)
      ed.pins.push({ id: m.comment.id, fx: m.comment.fx, fy: m.comment.fy, n: ed.pins.length + 1 })
      send({ pin: $state.snapshot(ed.pins) })
      status(`Comment pin #${ed.pins.length} placed (the app keeps pins in memory only)`)
      break
    }
    case 'log':
      if (m.level !== 'info') status(`frame ${m.level}: ${m.message}`, 'err')
      break
  }
}

async function commitPatch(patch: StylePatch): Promise<void> {
  try {
    await hooks.beforeEdit()
    const r = await api<EditResult>('/api/patch', { patch, mode: styleMode() })
    ed.awaitingReload = r.label
    status(`${r.label} → ${r.file} (draft, unsaved)`, 'ok')
    await afterWrite(true)
  } catch (err) { status(messageOf(err), 'err') }
}
const styleMode = (): string => ed.styleMode || (ed.info?.hasTailwind ? 'auto' : 'inline')

/* ---------- pages ---------- */
export async function loadPages(): Promise<void> {
  ed.pages = await api<Page[]>('/api/pages')
}
function syncPicker(pathname: string): void {
  if (ed.pages.some((p) => p.route === pathname && !p.dynamic && p.file)) ed.pageValue = pathname
}
export function gotoPage(route: string): void {
  clearSel()
  ed.pageValue = route
  if (dom.frame && ed.info) dom.frame.src = ed.info.devUrl + route
}
export async function createPage(route: string): Promise<void> {
  if (!route) return
  try {
    const r = await api<{ file: string }>('/api/new-page', { route })
    await loadPages()
    const p = '/' + route.replace(/^\/+|\/+$/g, '')
    ed.pageValue = p
    if (dom.frame && ed.info) dom.frame.src = ed.info.devUrl + p
    status(`Created ${r.file}`, 'ok')
  } catch (err) { status(messageOf(err), 'err') }
}

/* ---------- selection ---------- */
export function clearSel(): void {
  ed.sel = null
  ed.insp = null
  send({ select: { ref: null } })
}
let pendingReveal = false
export async function selectRef(ref: Ref, fromHost: boolean): Promise<void> {
  ed.sel = ref
  pendingReveal = true
  if (fromHost) send({ select: { ref: $state.snapshot(ref) }, reveal: { ref: $state.snapshot(ref) } })
  await refreshSel()
}
export async function refreshSel(): Promise<void> {
  if (!ed.sel) return
  const s = ed.sel
  let insp: Inspection
  try {
    insp = await api<Inspection>('/api/inspect?' + query({ file: s.file, line: s.line, col: s.col }))
  } catch (err) {
    if (ed.sel !== s) return
    status(messageOf(err), 'err')
    return clearSel()
  }
  if (ed.sel !== s) return // selection moved on while we were fetching
  ed.insp = insp
  hooks.onSelect(s, insp, pendingReveal)
  pendingReveal = false
  void loadVariants()
}
async function loadVariants(): Promise<void> {
  const s = ed.sel
  if (!s) return
  try {
    const v = await api<VariantsResult>('/api/variants?' + query({ file: s.file }))
    if (ed.sel !== s) return
    ed.variants.file = s.file
    ed.variants.text = v.variants.length
      ? v.variants.map((x) => `${x.name} (default ${x.default}; values: ${x.options.join(', ')})`).join(' · ')
      : 'no variant prop yet. Props: ' + (v.props.map((p) => p.name).join(', ') || 'none')
  } catch { /* variants are optional */ }
}

/* ---------- editing ---------- */
export async function doEdit(edit: SvelteEdit, { clear = false } = {}): Promise<EditResult | undefined> {
  if (!ed.sel) return
  try {
    await hooks.beforeEdit() // flush pending typed code first, so the engine edits the latest draft
    const r = await api<EditResult>('/api/edit', { at: { file: ed.sel.file, line: ed.sel.line, col: ed.sel.col }, edit })
    ed.awaitingReload = r.changed ? r.label : null
    status(r.changed ? `${r.label} → ${r.file} (draft, unsaved)` : 'No change', r.changed ? 'ok' : '')
    await afterWrite(!clear)
    if (clear) clearSel()
    return r
  } catch (err) { status(messageOf(err), 'err') }
}
export async function componentEdit(edit: Record<string, unknown>): Promise<void> {
  if (!ed.sel) return
  try {
    const r = await api<EditResult>('/api/component', { file: ed.sel.file, edit })
    ed.awaitingReload = r.label
    status(`${r.label} → ${r.file}`, 'ok')
    await afterWrite(true)
  } catch (err) { status(messageOf(err), 'err') }
}
async function afterWrite(keepSel: boolean): Promise<void> {
  await refreshHistory()
  if (keepSel && ed.sel) await refreshSel()
}
export async function refreshHistory(): Promise<void> {
  ed.history = await api<History>('/api/history')
}
export async function undoRedo(kind: 'undo' | 'redo'): Promise<void> {
  try {
    await hooks.beforeEdit()
    const r = await api<{ ok: boolean; label: string }>('/api/' + kind, {})
    status(r.label, r.ok ? 'ok' : '')
    ed.awaitingReload = r.ok ? r.label : null
    await refreshHistory()
    if (ed.sel) await refreshSel()
  } catch (err) { status(messageOf(err), 'err') }
}
export async function resetExample(): Promise<void> {
  try {
    const r = await api<{ label: string }>('/api/reset', {})
    clearSel()
    await loadPages()
    await refreshHistory()
    status(r.label, 'ok')
    setTimeout(reloadFrame, 400)
  } catch (err) { status(messageOf(err), 'err') }
}
export function selectNeighbour(kind: 'parent' | 'prev' | 'next'): void {
  const t = ed.insp?.[kind]
  if (t && ed.sel) void selectRef(mkRef({ file: ed.sel.file, ...t }), true)
}
export function selectUsage(): void {
  const loc = ed.sel?.fsi?.split('|')[1]
  const m = loc && /^(.*):(\d+):(\d+)$/.exec(loc)
  if (m) void selectRef(mkRef({ file: m[1]!, line: Number(m[2]), col: Number(m[3]) }), true)
}

/* ---------- live: draft + disk changes pushed by the server ---------- */
async function onServerEvent(e: MessageEvent): Promise<void> {
  const m = JSON.parse(e.data as string) as { type: string; files?: string[] }
  if (!ed.info) return
  if (m.type === 'draft') {
    void hooks.onDraft(m.files)
    await refreshHistory()
    if (ed.sel) await refreshSel()
    return
  }
  if (m.type !== 'changed') return
  void hooks.onDraft(m.files, true)
  await loadPages()
  if (ed.sel) await refreshSel()
  ed.lastChange = String(Date.now())
}

let wired = false
/** once, at boot: bridge listener, resize, server events */
export function wire(): void {
  if (wired) return
  wired = true
  addEventListener('message', onBridge)
  addEventListener('resize', layout)
  const events = new EventSource('/api/events')
  events.onmessage = (e) => void onServerEvent(e)
}

/* ---------- editor lifecycle (called by lib/project.svelte.ts) ---------- */
export async function startEditor(info: ProjectInfo): Promise<void> {
  Object.assign(ed, { info, sel: null, insp: null, pins: [], awaitingReload: null, tool: 'select', layers: [] })
  await tick() // the editor screen must be visible before the canvas is measured
  await loadPages()
  layout()
  if (dom.frame) dom.frame.src = info.devUrl + '/'
  await refreshHistory()
  await hooks.onStart(info)
  status(`${info.kind} · svelte ${info.versions.svelte} · dev ${info.devUrl}`)
}
export function stopEditor(): void {
  hooks.onStop()
  ed.info = null
  ed.sel = null
  ed.insp = null
  if (dom.frame) dom.frame.src = 'about:blank'
}
