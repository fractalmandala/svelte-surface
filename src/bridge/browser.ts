/**
 * The in-iframe bridge. SELF-CONTAINED: no runtime imports, because this file is
 * served raw (as compiled JS) into the user's dev server page. Wire format is
 * `reference/bridge-protocol.ts`: frame→host messages are `{__surface:true,
 * frame, t, …}` via `window.parent.postMessage`; host→frame commands are only
 * accepted when `event.source === window.parent`.
 */
import type { HostCommand, Layer, PinSpec, Ref, StylePatch, Tool } from '../contract.js'

export interface BridgeOptions {
  frame?: string
  /** run even when not inside an iframe (tests, standalone preview) */
  always?: boolean
  /** project root, to relativize absolute paths when retro-stamping */
  root?: string
}

export interface BridgeHandle {
  frame: string
  dispose(): void
  /** current tool */
  tool(): Tool
  /** resolve a DOM element to the Ref the host receives */
  refOf(el: Element | null): Ref | null
  /** the layer tree of marked elements */
  layers(): Layer[]
}

const A_FS = 'data-fs'
const A_FSI = 'data-fsi'
const A_FSU = 'data-fsu'

function parseLocLocal(loc: string | null): { file: string; line: number; col: number } | null {
  if (!loc) return null
  const bare = loc.includes('|') ? loc.slice(loc.indexOf('|') + 1) : loc
  const m = /^(.*):(\d+):(\d+)$/.exec(bare)
  return m ? { file: m[1]!, line: Number(m[2]), col: Number(m[3]) } : null
}

export function refOfElement(el: Element | null): Ref | null {
  const host = el?.closest?.(`[${A_FS}]`) ?? null
  if (!host) return null
  const fs = host.getAttribute(A_FS)!
  const loc = parseLocLocal(fs)
  if (!loc) return null
  const fsu = host.closest(`[${A_FSU}]`)?.getAttribute(A_FSU) ?? undefined
  const chain = fsu ? fsu.split(/\s+/).filter(Boolean) : []
  const last = chain.length ? chain[chain.length - 1]! : undefined
  const component = last && last.includes('|') ? last.slice(0, last.indexOf('|')) : undefined
  // copy index: how many elements share this mark and come before this one
  const same = Array.from(document.querySelectorAll(`[${A_FS}="${fs.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`))
  const i = same.length > 1 ? same.indexOf(host) : undefined
  const ref: Ref = {
    file: loc.file,
    line: loc.line,
    col: loc.col,
    tag: host.localName,
    text: (host.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
    fs
  }
  if (component) ref.component = component
  if (last) ref.fsi = last
  if (fsu) ref.fsu = fsu
  if (i !== undefined && i >= 0) ref.i = i
  return ref
}

function elementOfRef(ref: Ref | null): Element | null {
  if (!ref) return null
  const fs = ref.fs ?? `${ref.file}:${ref.line}:${ref.col}`
  const all = Array.from(document.querySelectorAll(`[${A_FS}]`)).filter((e) => e.getAttribute(A_FS) === fs)
  return all[ref.i ?? 0] ?? all[0] ?? null
}

export function buildLayers(): Layer[] {
  const roots: Layer[] = []
  const walk = (el: Element, depth: number, into: Layer[]): void => {
    for (const child of Array.from(el.children)) {
      if (child.hasAttribute(A_FS)) {
        const ref = refOfElement(child)
        if (!ref) continue
        const layer: Layer = { ref, name: (child.hasAttribute(A_FSU) ? ref.component : undefined) ?? ref.tag, depth, children: [] }
        into.push(layer)
        walk(child, depth + 1, layer.children!)
      } else walk(child, depth, into)
    }
  }
  walk(document.body, 0, roots)
  return roots
}

export function installBridge(options: BridgeOptions = {}): BridgeHandle | null {
  const win = window
  const framed = win.parent !== win
  if (!framed && !options.always) return null
  const q = new URLSearchParams(win.location.search)
  const frame = options.frame ?? q.get('fsframe') ?? (win.name || 'main')
  let tool: Tool = 'select'
  let zoom = 1
  let wantTree = false
  let selected: Ref[] = []
  let hovered: Ref | null = null

  const emit = (message: Record<string, unknown>): void => {
    try {
      win.parent.postMessage({ ...message, __surface: true, frame }, '*')
    } catch (e) {
      /* host went away */
    }
  }
  const log = (level: 'info' | 'warn' | 'error', message: string): void => emit({ t: 'log', level, message })

  /* ---------- overlay ---------- */
  const host = document.createElement('surface-overlay')
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;')
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML =
    '<style>.b{position:fixed;pointer-events:none;box-sizing:border-box;display:none}' +
    '.h{border:calc(1px/var(--z,1)) solid #3b82f6;background:rgba(59,130,246,.08)}' +
    '.s{border:calc(2px/var(--z,1)) solid #3b82f6}' +
    '.hd{position:fixed;width:calc(8px/var(--z,1));height:calc(8px/var(--z,1));margin:calc(-4px/var(--z,1)) 0 0 calc(-4px/var(--z,1));' +
    'background:#fff;border:calc(1px/var(--z,1)) solid #3b82f6;box-sizing:border-box;pointer-events:auto;display:none}' +
    '.hd.rot{border-radius:50%;background:#3b82f6;cursor:grab}' +
    '.pin{position:fixed;display:none;box-sizing:border-box;border-radius:50% 50% 50% 0;transform:translate(-50%,-100%) rotate(-45deg);' +
    'background:#f59e0b;color:#fff;font:600 10px/1 system-ui;align-items:center;justify-content:center;pointer-events:none}' +
    '.pin>i{transform:rotate(45deg);font-style:normal}.pin.res{background:#9ca3af}.pin.act{background:#3b82f6}</style>'
  const hoverBox = document.createElement('div')
  hoverBox.className = 'b h'
  shadow.appendChild(hoverBox)
  const selBoxes: HTMLDivElement[] = []
  document.documentElement.appendChild(host)

  /* ---------- handles (resize / rotate), pins, style previews ---------- */
  let handles = { w: true, h: true, style: true }
  let pins: PinSpec[] = []
  const previews = new Map<Element, string | null>()
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
  const CURSOR: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
  const handleEls: Record<string, HTMLDivElement> = {}
  for (const d of [...DIRS, 'rot']) {
    const h = document.createElement('div')
    h.className = d === 'rot' ? 'hd rot' : 'hd'
    h.dataset.handle = d
    h.style.cursor = d === 'rot' ? 'grab' : CURSOR[d]!
    shadow.appendChild(h)
    handleEls[d] = h
  }
  const pinEls: HTMLDivElement[] = []

  const cssNum = (v: string): number => parseFloat(v) || 0
  const rotationOf = (el: Element): number => {
    const r = win.getComputedStyle(el).getPropertyValue('rotate')
    return r && r !== 'none' ? parseFloat(r) || 0 : 0
  }

  const paintHandles = (): void => {
    const el = selected.length === 1 && handles.style && tool !== 'preview' ? elementOfRef(selected[0]!) : null
    for (const d of Object.keys(handleEls)) handleEls[d]!.style.display = 'none'
    if (!el) return
    const r = el.getBoundingClientRect()
    const pos: Record<string, [number, number]> = {
      nw: [r.left, r.top], n: [r.left + r.width / 2, r.top], ne: [r.right, r.top], e: [r.right, r.top + r.height / 2],
      se: [r.right, r.bottom], s: [r.left + r.width / 2, r.bottom], sw: [r.left, r.bottom], w: [r.left, r.top + r.height / 2],
      rot: [r.left + r.width / 2, r.top - 22 / zoom]
    }
    for (const d of Object.keys(pos)) {
      const horizontal = d.includes('e') || d.includes('w')
      const vertical = d.includes('n') || d.includes('s')
      const show = d === 'rot' ? true : horizontal && vertical ? handles.w && handles.h : horizontal ? handles.w : handles.h
      const h = handleEls[d]!
      if (!show) continue
      h.style.display = 'block'
      h.style.left = `${pos[d]![0]}px`
      h.style.top = `${pos[d]![1]}px`
    }
  }

  const paintPins = (): void => {
    const docW = Math.max(document.documentElement.scrollWidth, 1)
    const docH = Math.max(document.documentElement.scrollHeight, 1)
    while (pinEls.length < pins.length) {
      const p = document.createElement('div')
      p.className = 'pin'
      shadow.appendChild(p)
      pinEls.push(p)
    }
    pinEls.forEach((el, i) => {
      const spec = pins[i]
      if (!spec) {
        el.style.display = 'none'
        return
      }
      const size = (spec.active ? 26 : 20) / zoom
      el.className = 'pin' + (spec.resolved ? ' res' : '') + (spec.active ? ' act' : '')
      el.dataset.pin = spec.id
      el.style.display = 'flex'
      el.style.width = el.style.height = `${size}px`
      el.style.left = `${spec.fx * docW - win.scrollX}px`
      el.style.top = `${spec.fy * docH - win.scrollY}px`
      el.innerHTML = `<i>${spec.draft ? '+' : spec.n ?? ''}</i>`
    })
  }

  const send = (t: 'live' | 'commit', patch: StylePatch): void => emit({ t, patch })

  const restoreInline = (el: Element, orig: string | null): void => {
    if (orig === null) el.removeAttribute('style')
    else el.setAttribute('style', orig)
  }

  /** drag a resize or rotate handle: live while moving, commit on release */
  const startDrag = (dir: string, e: MouseEvent): void => {
    const ref = selected[0]
    const el = ref ? elementOfRef(ref) : null
    if (!ref || !el || !(el instanceof HTMLElement)) return
    e.preventDefault()
    e.stopPropagation()
    const r0 = el.getBoundingClientRect()
    const cs = win.getComputedStyle(el)
    const pad = cs.boxSizing === 'border-box' ? { w: 0, h: 0 } : {
      w: cssNum(cs.paddingLeft) + cssNum(cs.paddingRight) + cssNum(cs.borderLeftWidth) + cssNum(cs.borderRightWidth),
      h: cssNum(cs.paddingTop) + cssNum(cs.paddingBottom) + cssNum(cs.borderTopWidth) + cssNum(cs.borderBottomWidth)
    }
    const orig = el.getAttribute('style')
    const x0 = e.clientX
    const y0 = e.clientY
    const cx = r0.left + r0.width / 2
    const cy = r0.top + r0.height / 2
    const a0 = rotationOf(el)
    const aStart = (Math.atan2(y0 - cy, x0 - cx) * 180) / Math.PI
    let last: StylePatch | null = null

    const onDrag = (ev: MouseEvent): void => {
      const props: Record<string, string> = {}
      let label: string
      if (dir === 'rot') {
        const a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI
        let deg = a0 + (a - aStart)
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        deg = Math.round(deg * 10) / 10
        props['rotate'] = `${deg}deg`
        el.style.setProperty('rotate', props['rotate'])
        label = 'Rotate'
      } else {
        const dx = ev.clientX - x0
        const dy = ev.clientY - y0
        let w = r0.width
        let h = r0.height
        if (dir.includes('e')) w = r0.width + dx
        if (dir.includes('w')) w = r0.width - dx
        if (dir.includes('s')) h = r0.height + dy
        if (dir.includes('n')) h = r0.height - dy
        if (ev.shiftKey && dir.length === 2) {
          const k = Math.max(w / r0.width, h / r0.height)
          w = r0.width * k
          h = r0.height * k
        }
        if (dir.includes('e') || dir.includes('w')) props['width'] = `${Math.max(1, Math.round(w - pad.w))}px`
        if (dir.includes('n') || dir.includes('s')) props['height'] = `${Math.max(1, Math.round(h - pad.h))}px`
        if (dir.length === 2 && ev.shiftKey) {
          props['width'] = `${Math.max(1, Math.round(w - pad.w))}px`
          props['height'] = `${Math.max(1, Math.round(h - pad.h))}px`
        }
        for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v)
        label = `Resize ${Object.keys(props).join(' and ')}`
      }
      last = { ref, props, label }
      send('live', last)
      repaint()
    }
    const onUp = (): void => {
      win.removeEventListener('mousemove', onDrag, true)
      win.removeEventListener('mouseup', onUp, true)
      if (last) send('commit', last)
      restoreInline(el, orig)
      repaint()
    }
    win.addEventListener('mousemove', onDrag, true)
    win.addEventListener('mouseup', onUp, true)
  }
  for (const d of Object.keys(handleEls)) {
    handleEls[d]!.addEventListener('mousedown', (e) => startDrag(d, e as MouseEvent))
  }

  const previewStyle = (ref: Ref, style: Record<string, string> | null): void => {
    const el = elementOfRef(ref)
    if (!(el instanceof HTMLElement)) return
    if (style === null) {
      if (previews.has(el)) restoreInline(el, previews.get(el)!)
      previews.delete(el)
      return
    }
    if (!previews.has(el)) previews.set(el, el.getAttribute('style'))
    for (const [k, v] of Object.entries(style)) el.style.setProperty(k, v)
  }

  const place = (box: HTMLElement, el: Element | null): void => {
    if (!el) {
      box.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${r.left}px`
    box.style.top = `${r.top}px`
    box.style.width = `${r.width}px`
    box.style.height = `${r.height}px`
  }
  const repaint = (): void => {
    host.style.setProperty('--z', String(zoom))
    place(hoverBox, elementOfRef(hovered))
    while (selBoxes.length < selected.length) {
      const b = document.createElement('div')
      b.className = 'b s'
      shadow.appendChild(b)
      selBoxes.push(b)
    }
    selBoxes.forEach((b, i) => place(b, selected[i] ? elementOfRef(selected[i]!) : null))
    paintHandles()
    paintPins()
  }

  /* ---------- page events ---------- */
  const targetRef = (e: Event): Ref | null => refOfElement(e.target instanceof Element ? e.target : null)
  const sameRef = (a: Ref | null, b: Ref | null): boolean => (a?.fs ?? '') === (b?.fs ?? '') && a?.i === b?.i

  const onMove = (e: MouseEvent): void => {
    if (tool === 'preview') return
    const r = targetRef(e)
    if (sameRef(r, hovered)) return
    hovered = r
    emit({ t: 'hover', ref: r })
    repaint()
  }
  const onClick = (e: MouseEvent): void => {
    if (tool === 'preview') return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    const r = targetRef(e)
    if (tool === 'comment') {
      // where on the page: fractions of the document, so the pin survives scrolling and zoom
      const docW = Math.max(document.documentElement.scrollWidth, 1)
      const docH = Math.max(document.documentElement.scrollHeight, 1)
      const fx = (e.clientX + win.scrollX) / docW
      const fy = (e.clientY + win.scrollY) / docH
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      if (r) emit({ t: 'select', ref: r, add: false, parent: false })
      emit({ t: 'pin', comment: { id, fx, fy } })
      pins = [...pins.filter((p) => !p.draft), { id, fx, fy, draft: true, active: true }]
      repaint()
      return
    }
    if (!r) return
    selected = e.shiftKey ? [...selected, r] : [r]
    emit({ t: 'select', ref: r, add: e.shiftKey, parent: e.metaKey || e.ctrlKey })
    repaint()
  }
  const onDbl = (e: MouseEvent): void => {
    if (tool === 'preview') return
    e.preventDefault()
    const r = targetRef(e)
    if (r) emit({ t: 'dblclick', ref: r })
  }
  const swallow = (e: Event): void => {
    if (tool !== 'preview') e.preventDefault()
  }
  const onLeave = (): void => {
    if (hovered) {
      hovered = null
      emit({ t: 'hover', ref: null })
      repaint()
    }
  }
  win.addEventListener('mousemove', onMove, true)
  win.addEventListener('click', onClick, true)
  win.addEventListener('dblclick', onDbl, true)
  win.addEventListener('submit', swallow, true)
  document.addEventListener('mouseleave', onLeave)
  win.addEventListener('scroll', repaint, true)
  win.addEventListener('resize', repaint)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && pins.some((p) => p.draft)) {
      pins = pins.filter((p) => !p.draft)
      emit({ t: 'pin', comment: null })
      repaint()
    }
  }
  win.addEventListener('keydown', onKey, true)

  /* ---------- host → frame ---------- */
  const sendTree = (): void => {
    if (wantTree) emit({ t: 'layers', layers: buildLayers() })
  }
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win.parent) return
    const c = event.data as HostCommand
    if (!c || c.__surface !== true) return
    if (c.frame !== undefined && c.frame !== frame) return
    try {
      if (c.init) {
        if (c.init.tool) tool = c.init.tool
        if (c.init.zoom) zoom = c.init.zoom
        if (c.init.wantTree) wantTree = true
        sendTree()
      }
      if (c.setTool) tool = c.setTool
      if (c.setHandles) handles = c.setHandles
      if (c.pin !== undefined) pins = c.pin ?? []
      if (c.previewStyle) previewStyle(c.previewStyle.ref, c.previewStyle.style)
      if (c.setZoom) zoom = c.setZoom
      if (c.setHover !== undefined) hovered = c.setHover
      if (c.select) selected = c.select.ref ? (c.select.add ? [...selected, c.select.ref] : [c.select.ref]) : []
      if (c.reveal) elementOfRef(c.reveal.ref)?.scrollIntoView({ block: 'center', inline: 'nearest' })
      if (typeof c.scrollTo === 'number') win.scrollTo(0, c.scrollTo)
      if (c.navigate) win.location.assign(c.navigate)
      repaint()
    } catch (err) {
      log('error', err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    }
  }
  win.addEventListener('message', onMessage)

  /* ---------- route + tree tracking ---------- */
  const route = (): string => win.location.pathname + win.location.search
  const emitRoute = (): void => emit({ t: 'route', route: route() })
  // Never wrap history.pushState/replaceState: SvelteKit (dev) warns about foreign wrappers and its own
  // router calls would go through ours. Watch the location instead.
  let lastRoute = route()
  const checkRoute = (): void => {
    const r = route()
    if (r !== lastRoute) {
      lastRoute = r
      emitRoute()
    }
  }
  win.addEventListener('popstate', checkRoute)
  const routePoll = setInterval(checkRoute, 250)
  let timer: ReturnType<typeof setTimeout> | undefined
  const mo = new MutationObserver(() => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      sendTree()
      repaint()
    }, 120)
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })

  emit({
    t: 'ready',
    url: win.location.href,
    title: document.title,
    route: route(),
    height: document.documentElement.scrollHeight
  })

  return {
    frame,
    tool: () => tool,
    refOf: refOfElement,
    layers: buildLayers,
    dispose() {
      win.removeEventListener('mousemove', onMove, true)
      win.removeEventListener('click', onClick, true)
      win.removeEventListener('dblclick', onDbl, true)
      win.removeEventListener('submit', swallow, true)
      document.removeEventListener('mouseleave', onLeave)
      win.removeEventListener('scroll', repaint, true)
      win.removeEventListener('resize', repaint)
      win.removeEventListener('message', onMessage)
      win.removeEventListener('keydown', onKey, true)
      for (const [el, orig] of previews) restoreInline(el, orig)
      previews.clear()
      win.removeEventListener('popstate', checkRoute)
      clearInterval(routePoll)
      mo.disconnect()
      clearTimeout(timer)
      host.remove()
    }
  }
}

/* ------------------------------------------------------------------ *
 * Page scripts for the main process (executeJavaScript / page.evaluate).
 * Each function is fully self-contained so `fn.toString()` is a valid script.
 * ------------------------------------------------------------------ */

/** DOM walk (≤8000 els) → rows `[parent, tag, class, id, text, attrs, childCount]`. */
export function snapshotDom(): Array<[number, string, string, string, string, Record<string, string>, number]> {
  const rows: Array<[number, string, string, string, string, Record<string, string>, number]> = []
  const keep = ['data-fs', 'data-fsi', 'data-fsu', 'href', 'src', 'alt', 'type', 'name']
  const walk = (el: Element, parent: number): void => {
    if (rows.length >= 8000) return
    const idx = rows.length
    let own = ''
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent ?? ''
    const attrs: Record<string, string> = {}
    for (const k of keep) {
      const v = el.getAttribute(k)
      if (v !== null) attrs[k] = v
    }
    rows.push([parent, el.localName, el.getAttribute('class') ?? '', el.id, own.trim().replace(/\s+/g, ' ').slice(0, 80), attrs, el.children.length])
    for (const c of Array.from(el.children)) walk(c, idx)
  }
  if (document.body) walk(document.body, -1)
  return rows
}

/**
 * Retro-stamp `data-fs` on late-rendered elements that lack one, from Svelte's
 * dev-mode `__svelte_meta.loc` ({file, line, column(0-based)}). Returns how many.
 */
export function stampLate(root: string): number {
  let n = 0
  const rel = (f: string): string => {
    const norm = f.replace(/\\/g, '/')
    const r = root.replace(/\\/g, '/').replace(/\/$/, '')
    return r && norm.startsWith(r + '/') ? norm.slice(r.length + 1) : norm.replace(/^\//, '')
  }
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.hasAttribute('data-fs')) continue
    const loc = (el as unknown as { __svelte_meta?: { loc?: { file: string; line: number; column: number } } }).__svelte_meta?.loc
    if (!loc) continue
    el.setAttribute('data-fs', `${rel(loc.file)}:${loc.line}:${loc.column + 1}`)
    n++
  }
  return n
}

/** Resolves with the number of marked elements once marks exist and the DOM has been quiet for 120 ms. */
export function watchMarks(timeoutMs = 5000): Promise<number> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    let hard: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      obs.disconnect()
      clearTimeout(quiet)
      clearTimeout(hard)
      resolve(document.querySelectorAll('[data-fs]').length)
    }
    const check = (): void => {
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        if (document.querySelector('[data-fs]')) finish()
      }, 120)
    }
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    hard = setTimeout(finish, timeoutMs)
    check()
  })
}

/** Install once per window; safe to call on the server (does nothing). */
export function installBridgeOnce(options: BridgeOptions = {}): BridgeHandle | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  const w = window as unknown as { __surfaceBridge?: BridgeHandle | null }
  if (w.__surfaceBridge === undefined) {
    const go = (): void => {
      w.__surfaceBridge = installBridge(options)
    }
    if (document.readyState === 'loading') {
      w.__surfaceBridge = null
      document.addEventListener('DOMContentLoaded', go)
    } else go()
  }
  return w.__surfaceBridge ?? null
}

/* ------------------------------------------------------------------ *
 * Auto-install when served as `/@surface/bridge.js`.
 * ------------------------------------------------------------------ */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const tag = document.querySelector('script[data-surface-bridge]')
  if (tag) {
    let cfg: BridgeOptions = {}
    try {
      cfg = JSON.parse(tag.getAttribute('data-surface-bridge') || '{}') as BridgeOptions
    } catch (e) {
      /* ignore */
    }
    installBridgeOnce(cfg)
  }
}
