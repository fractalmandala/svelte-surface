// Start screen, folder browser, open-project flow, switch/close. The editor itself lives in surface.svelte.ts.
import { api, messageOf } from './api.ts'
import { confirmBox } from './dialogs.svelte.ts'
import { saveFiles } from './code.svelte.ts'
import { startEditor, stopEditor } from './surface.svelte.ts'
import type { AppInfo, BrowseResult, InspectResult, Kind, ProjectInfo } from './types.ts'
import { ApiFailure } from './types.ts'

export const KIND: Record<string, string> = { sveltekit: 'SvelteKit', 'vite-svelte': 'Vite + Svelte' }
export type Screen = 'start' | 'flow' | 'editor'
export type Flow =
  | { kind: 'checking'; path: string }
  | { kind: 'card'; insp: InspectResult }
  | { kind: 'opening'; path: string; phase: string }
  | { kind: 'error'; title: string; message: string; details?: string; retry?: () => void }

export const proj = $state({
  screen: 'start' as Screen,
  app: null as AppInfo | null,
  flow: null as Flow | null,
  installing: false,
  installLog: ''
})

export const browser = $state({
  open: false,
  path: null as string | null,
  selected: null as string | null,
  hidden: false,
  data: null as BrowseResult | null,
  error: '',
  pathInput: '',
  pathDirty: false
})

/* ---------- live messages from the server (install output, phases) ---------- */
let wired = false
export function wireProject(): void {
  if (wired) return
  wired = true
  const events = new EventSource('/api/events')
  events.onmessage = (e) => {
    const m = JSON.parse(e.data as string) as { type: string; line?: string; text?: string }
    if (m.type === 'install' && proj.installing) proj.installLog += m.line + '\n'
    else if (m.type === 'phase' && proj.flow?.kind === 'opening') proj.flow.phase = m.text ?? ''
  }
  // dropping something on the page must never navigate away from the app
  for (const t of ['dragover', 'drop']) addEventListener(t, (e) => e.preventDefault())
  globalThis.__surfaceNative = {
    isNative: !!nativeBridge(),
    picked: (p) => { if (p) void beginOpen(p) },
    pick: () => openFolder()
  }
}
declare global {
  var __surfaceNative: { isNative: boolean; picked(p: string): void; pick(): void }
}

/* ---------- start screen ---------- */
export async function loadStart(): Promise<AppInfo> {
  const app = await api<AppInfo>('/api/app')
  proj.app = app
  return app
}
export function showScreen(s: Screen): void { proj.screen = s }

export async function openExample(): Promise<void> {
  try { void beginOpen((await api<{ path: string }>('/api/project/example', {})).path) } catch (e) { flowError('Could not prepare the example', messageOf(e)) }
}
export async function removeRecent(path: string): Promise<void> {
  await api('/api/recents/remove', { path })
  await loadStart()
}

/* ---------- folder picker: native NSOpenPanel in the macOS shell, else a server-backed browser ---------- */
const nativeBridge = (): { postMessage(m: unknown): void } | undefined =>
  (globalThis as unknown as { webkit?: { messageHandlers?: { surface?: { postMessage(m: unknown): void } } } }).webkit?.messageHandlers?.surface

export function openFolder(): void {
  const native = nativeBridge()
  if (native) {
    native.postMessage({ type: 'pickFolder', start: browser.path ?? proj.app?.recents.find((r) => !r.missing)?.path ?? null })
    return
  }
  browser.open = true
  if (browser.path) { void navigate(browser.path); return }
  void (async () => {
    if (!proj.app) await loadStart().catch(() => undefined)
    if (browser.path || navSeq > 0) return // a listing (typed path) already won
    const start = proj.app?.recents.find((r) => !r.missing)
    void navigate(start ? start.path.replace(/[/\\][^/\\]+$/, '') || '/' : (proj.app?.shortcuts[0]?.path ?? '/'))
  })()
}
export function closeBrowser(): void { browser.open = false }
export function setHidden(v: boolean): void { browser.hidden = v; if (browser.path) void navigate(browser.path) }
export function submitPath(): void { browser.pathDirty = false; void navigate(browser.pathInput.trim()) }
export function openBrowsed(): void {
  const target = browser.selected ?? browser.path
  browser.open = false
  if (target) void beginOpen(target)
}

let navSeq = 0
export async function navigate(p: string): Promise<void> {
  if (p !== browser.pathInput.trim()) browser.pathDirty = false // navigation by click/breadcrumb/shortcut
  const seq = ++navSeq // only the latest request may paint (typing a path must beat the initial listing)
  try {
    const d = await api<BrowseResult>('/api/fs?' + new URLSearchParams({ path: p, hidden: browser.hidden ? '1' : '0' }))
    if (seq !== navSeq) return
    browser.path = d.path
    browser.selected = null
    browser.error = ''
    if (!browser.pathDirty) browser.pathInput = d.path
    browser.data = d
  } catch (e) {
    if (seq !== navSeq) return
    browser.error = messageOf(e)
  }
}

/* ---------- open flow ---------- */
export function flowError(title: string, message: string, details?: string, retry?: () => void): void {
  proj.installing = false
  proj.flow = { kind: 'error', title, message, details, retry }
  proj.screen = 'flow'
}
export async function backToStart(): Promise<void> {
  await loadStart()
  proj.screen = 'start'
}
export async function beginOpen(path: string): Promise<void> {
  proj.flow = { kind: 'checking', path }
  proj.screen = 'flow'
  let insp: InspectResult
  try { insp = await api<InspectResult>('/api/project/inspect', { path }) } catch (e) { return flowError('Could not read the folder', messageOf(e), '', () => void beginOpen(path)) }
  if (!insp.supported) return flowError('This folder is not a supported project', insp.reason ?? '')
  renderCard(insp)
}
function renderCard(insp: InspectResult): void {
  proj.installing = false
  if (insp.depsInstalled && !(insp.warnings ?? []).length) { void startProject(insp.path, false); return }
  proj.flow = { kind: 'card', insp }
  proj.screen = 'flow'
}
export async function installDeps(insp: InspectResult): Promise<string | null> {
  proj.installing = true
  proj.installLog = ''
  try {
    await api('/api/project/install', { path: insp.path })
    proj.installing = false
    void beginOpen(insp.path) // re-check: now installed
    return null
  } catch (e) {
    proj.installLog += '\n✗ ' + messageOf(e)
    proj.installing = false
    return messageOf(e)
  }
}

/** the server refuses to leave a project with unsaved drafts: ask what to do, then retry */
async function askUnsaved(e: { files?: string[] }, action: () => Promise<void>): Promise<boolean> {
  const files = e.files ?? []
  const choice = await confirmBox<'cancel' | 'discard' | 'save'>({
    title: 'Unsaved changes',
    text: `${files.length} file${files.length === 1 ? ' has' : 's have'} unsaved draft edits that are only in memory. Leaving the project loses them.`,
    list: files,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Discard drafts', kind: 'danger', value: 'discard' },
      { label: 'Save all and continue', kind: 'primary', value: 'save' }
    ]
  })
  if (choice === 'cancel') return false
  if (choice === 'save' && !(await saveFiles(null))) return false
  await action()
  return true
}

export async function startProject(path: string, ack: boolean, discard = false): Promise<void> {
  proj.flow = { kind: 'opening', path, phase: 'Starting the project’s dev server…' }
  proj.screen = 'flow'
  try {
    const info = await api<ProjectInfo>('/api/project/open', { path, acknowledged: ack, discard })
    proj.screen = 'editor'
    await startEditor(info)
  } catch (err) {
    const e = err as ApiFailure
    if ((e.code === 'needs-ack' || e.code === 'no-deps') && e.inspect) return renderCard(e.inspect)
    if (e.code === 'unsaved-drafts') {
      const done = await askUnsaved(e, () => startProject(path, ack, true))
      if (!done) await backToStart()
      return
    }
    flowError(e.code === 'dev-failed' ? 'The dev server did not start' : 'Could not open the project', e.message, e.details, () => void startProject(path, ack))
  }
}

/* ---------- switch / close ---------- */
export async function closeProject(discard = false): Promise<void> {
  try {
    await api('/api/project/close', { discard })
  } catch (err) {
    const e = err as ApiFailure
    if (e.code === 'unsaved-drafts') {
      await askUnsaved(e, () => closeProject(true))
      return
    }
  }
  stopEditor()
  await backToStart()
}

/* ---------- boot ---------- */
export async function boot(): Promise<void> {
  try {
    const app = await loadStart()
    if (app.current) { proj.screen = 'editor'; await startEditor(app.current) } else proj.screen = 'start'
  } catch (e) {
    flowError('Cannot reach the app server', messageOf(e), '', () => location.reload())
  }
}
export type { Kind }
