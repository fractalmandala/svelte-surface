// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installBridge, refOfElement, snapshotDom, stampLate, watchMarks, buildLayers } from '../src/bridge/browser.js'
import { SNAPSHOT_SCRIPT, WATCH_SCRIPT, bridgeSource, stampScript } from '../src/bridge/source.js'

const HTML = `
<main data-fs="src/routes/+page.svelte:5:1">
  <h1 data-fs="src/routes/+page.svelte:6:3">Selected work</h1>
  <section data-fs="src/lib/Faq.svelte:5:1" data-fsu="Faq|src/routes/+page.svelte:7:3">
    <h2 data-fs="src/lib/Faq.svelte:6:3">Questions</h2>
  </section>
  <li data-fs="src/routes/+page.svelte:9:5">a</li><li data-fs="src/routes/+page.svelte:9:5">b</li>
</main>`

const sent: any[] = []
let handle: ReturnType<typeof installBridge> = null

function boot(): void {
  document.body.innerHTML = HTML
  sent.length = 0
  // jsdom: window.parent === window, so route the host-side postMessage into the capture list
  const orig = window.parent.postMessage.bind(window.parent)
  ;(window.parent as any).postMessage = (d: any) => void sent.push(d)
  ;(window as any).__restore = () => ((window.parent as any).postMessage = orig)
  handle = installBridge({ frame: 'f1', always: true })
}

afterEach(() => {
  handle?.dispose()
  ;(window as any).__restore?.()
})

describe('bridge', () => {
  it('resolves marks to a Ref (component, usage chain, copy index)', () => {
    boot()
    const h2 = refOfElement(document.querySelector('h2'))!
    expect(h2).toMatchObject({ file: 'src/lib/Faq.svelte', line: 6, col: 3, tag: 'h2', text: 'Questions', component: 'Faq', fsi: 'Faq|src/routes/+page.svelte:7:3' })
    const lis = document.querySelectorAll('li')
    expect(refOfElement(lis[1]!)!.i).toBe(1)
    expect(refOfElement(document.body)).toBeNull()
  })

  it('announces ready, then reports hover and click as protocol messages', () => {
    boot()
    expect(sent[0]).toMatchObject({ __surface: true, t: 'ready', frame: 'f1' })
    const h1 = document.querySelector('h1')!
    h1.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    expect(sent.at(-1)).toMatchObject({ t: 'hover', frame: 'f1', ref: { file: 'src/routes/+page.svelte', line: 6, col: 3 } })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })
    h1.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(sent.at(-1)).toMatchObject({ t: 'select', add: true, parent: false, ref: { fs: 'src/routes/+page.svelte:6:3', tag: 'h1' } })
  })

  it('draws a selection box in the overlay on a host select command', () => {
    boot()
    expect(document.querySelector('surface-overlay')).not.toBeNull()
    const tree = buildLayers()
    expect(tree[0]!.name).toBe('main')
    expect(tree[0]!.children!.map((l) => l.name)).toEqual(['h1', 'Faq', 'li', 'li'])
    expect(tree[0]!.children![1]!.children![0]!.name).toBe('h2')
    window.dispatchEvent(new MessageEvent('message', { data: { __surface: true, select: { ref: tree[0]!.ref } }, source: window }))
    const box = document.querySelector('surface-overlay')!.shadowRoot!.querySelector('.s') as HTMLElement
    expect(box).not.toBeNull()
    expect(box.style.display).toBe('block')
  })

  it('preview tool lets the page through', () => {
    boot()
    window.dispatchEvent(Object.assign(new MessageEvent('message', { data: { __surface: true, setTool: 'preview' }, source: window }), {}))
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    document.querySelector('h1')!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
  })

  it('ignores commands for another frame', () => {
    boot()
    window.dispatchEvent(new MessageEvent('message', { data: { __surface: true, frame: 'other', setTool: 'preview' }, source: window }))
    expect(handle!.tool()).toBe('select')
  })

  it('no-ops outside an iframe unless forced', () => {
    expect(installBridge({})).toBeNull()
  })
})

describe('page scripts', () => {
  it('SNAPSHOT_SCRIPT walks the DOM into rows', () => {
    document.body.innerHTML = HTML
    const rows = (0, eval)(SNAPSHOT_SCRIPT) as ReturnType<typeof snapshotDom>
    expect(rows[0]![1]).toBe('body')
    expect(rows[1]![1]).toBe('main')
    expect(rows[2]).toEqual([1, 'h1', '', '', 'Selected work', { 'data-fs': 'src/routes/+page.svelte:6:3' }, 0])
  })
  it('stampScript retro-stamps late elements from svelte dev meta', () => {
    document.body.innerHTML = '<div id="x"></div>'
    ;(document.getElementById('x') as any).__svelte_meta = { loc: { file: '/proj/src/lib/A.svelte', line: 4, column: 2 } }
    const n = (0, eval)(stampScript('/proj')) as number
    expect(n).toBe(1)
    expect(document.getElementById('x')!.getAttribute('data-fs')).toBe('src/lib/A.svelte:4:3')
    expect(stampLate('/proj')).toBe(0)
  })
  it('WATCH_SCRIPT resolves once marks appear and settle', async () => {
    document.body.innerHTML = ''
    const p = (0, eval)(WATCH_SCRIPT(3000)) as Promise<number>
    setTimeout(() => (document.body.innerHTML = '<p data-fs="a:1:1">x</p>'), 50)
    expect(await p).toBe(1)
    expect(await watchMarks(200)).toBe(1)
  })
  it('bridgeSource returns browser-ready JS with no imports', () => {
    const src = bridgeSource()
    expect(src).toContain('installBridge')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/:\s*(string|number|Ref)\b[,)]/)
  })
})

describe('handles, pins, style gestures', () => {
  const rect = (l: number, t: number, w: number, h: number): DOMRect =>
    ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() {} }) as DOMRect
  const handle = (d: string): HTMLElement => document.querySelector('surface-overlay')!.shadowRoot!.querySelector(`[data-handle="${d}"]`)!
  const cmd = (c: Record<string, unknown>): boolean => window.dispatchEvent(new MessageEvent('message', { data: { __surface: true, ...c }, source: window }))
  const mouse = (type: string, x: number, y: number, extra: MouseEventInit = {}): MouseEvent =>
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...extra })

  function selectH1(): HTMLElement {
    boot()
    const h1 = document.querySelector('h1') as HTMLElement
    h1.getBoundingClientRect = () => rect(10, 20, 100, 50)
    h1.setAttribute('style', 'color: red')
    cmd({ select: { ref: refOfElement(h1) } })
    return h1
  }

  it('shows eight resize handles + rotate for one selection, honouring setHandles', () => {
    selectH1()
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'rot']) expect(handle(d).style.display, d).toBe('block')
    expect(handle('e').style.left).toBe('110px')
    cmd({ setHandles: { w: false, h: true, style: true } })
    expect(handle('e').style.display).toBe('none')
    expect(handle('ne').style.display).toBe('none')
    expect(handle('s').style.display).toBe('block')
    cmd({ setHandles: { w: true, h: true, style: false } })
    expect(handle('rot').style.display).toBe('none')
  })

  it('resize drag: live patches while moving, one commit on release, preview undone', () => {
    const h1 = selectH1()
    sent.length = 0
    handle('e').dispatchEvent(mouse('mousedown', 110, 45))
    window.dispatchEvent(mouse('mousemove', 120, 45))
    expect(sent.at(-1)).toMatchObject({ t: 'live', patch: { props: { width: '110px' }, label: 'Resize width', ref: { file: 'src/routes/+page.svelte', line: 6 } } })
    expect(h1.style.width).toBe('110px')
    window.dispatchEvent(mouse('mousemove', 140, 45))
    window.dispatchEvent(mouse('mouseup', 140, 45))
    expect(sent.at(-1)).toMatchObject({ t: 'commit', patch: { props: { width: '130px' } } })
    expect(sent.filter((m) => m.t === 'commit')).toHaveLength(1)
    expect(h1.getAttribute('style')).toBe('color: red')
  })

  it('corner drag with Shift keeps the aspect ratio; north edge changes height only', () => {
    const h1 = selectH1()
    sent.length = 0
    handle('se').dispatchEvent(mouse('mousedown', 110, 70))
    window.dispatchEvent(mouse('mousemove', 210, 70, { shiftKey: true }))
    window.dispatchEvent(mouse('mouseup', 210, 70))
    expect(sent.at(-1)).toMatchObject({ t: 'commit', patch: { props: { width: '200px', height: '100px' } } })
    sent.length = 0
    handle('n').dispatchEvent(mouse('mousedown', 60, 20))
    window.dispatchEvent(mouse('mousemove', 60, 10))
    window.dispatchEvent(mouse('mouseup', 60, 10))
    expect(sent.at(-1)).toMatchObject({ t: 'commit', patch: { props: { height: '60px' } } })
    expect(h1.getAttribute('style')).toBe('color: red')
  })

  it('rotate drag snaps with Shift and commits a rotate patch', () => {
    selectH1()
    sent.length = 0
    // centre is (60,45); start straight above, move to the right of centre = +90deg
    handle('rot').dispatchEvent(mouse('mousedown', 60, -2))
    window.dispatchEvent(mouse('mousemove', 160, 45, { shiftKey: true }))
    window.dispatchEvent(mouse('mouseup', 160, 45))
    expect(sent.at(-1)).toMatchObject({ t: 'commit', patch: { props: { rotate: '90deg' }, label: 'Rotate' } })
  })

  it('a click without drag commits nothing', () => {
    selectH1()
    sent.length = 0
    handle('e').dispatchEvent(mouse('mousedown', 110, 45))
    window.dispatchEvent(mouse('mouseup', 110, 45))
    expect(sent.filter((m) => m.t === 'commit' || m.t === 'live')).toHaveLength(0)
  })

  it('previewStyle applies inline without writing, null restores', () => {
    const h1 = selectH1()
    const ref = refOfElement(h1)!
    cmd({ previewStyle: { ref, style: { 'background-color': 'gold', width: '5px' } } })
    expect(h1.style.backgroundColor).toBe('gold')
    cmd({ previewStyle: { ref, style: null } })
    expect(h1.getAttribute('style')).toBe('color: red')
    cmd({ previewStyle: { ref, style: { width: '7px' } } })
    expect(h1.style.width).toBe('7px')
    handleDispose()
    expect(h1.getAttribute('style')).toBe('color: red')
  })

  it('draws comment pins from the host and places a new one with the comment tool', () => {
    boot()
    Object.defineProperty(document.documentElement, 'scrollWidth', { value: 1000, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true })
    cmd({ pin: [{ id: 'a', fx: 0.1, fy: 0.5, n: 1 }, { id: 'b', fx: 0.2, fy: 0.25, n: 2, resolved: true }, { id: 'c', fx: 0.3, fy: 0.1, active: true }] })
    const pinEls = Array.from(document.querySelector('surface-overlay')!.shadowRoot!.querySelectorAll('.pin')) as HTMLElement[]
    expect(pinEls.map((p) => p.style.display)).toEqual(['flex', 'flex', 'flex'])
    expect(pinEls[0]!.style.left).toBe('100px')
    expect(pinEls[0]!.style.top).toBe('1000px')
    expect(pinEls[0]!.textContent).toBe('1')
    expect(pinEls[1]!.classList.contains('res')).toBe(true)
    expect(pinEls[2]!.classList.contains('act')).toBe(true)
    cmd({ pin: null })
    expect(pinEls.every((p) => p.style.display === 'none')).toBe(true)

    cmd({ setTool: 'comment' })
    sent.length = 0
    const click = mouse('click', 250, 300)
    document.querySelector('h1')!.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(sent.map((m) => m.t)).toEqual(['select', 'pin'])
    expect(sent[1].comment).toMatchObject({ fx: 0.25, fy: 0.15 })
    const draft = Array.from(document.querySelector('surface-overlay')!.shadowRoot!.querySelectorAll('.pin')) as HTMLElement[]
    expect(draft[0]!.textContent).toBe('+')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(sent.at(-1)).toMatchObject({ t: 'pin', comment: null })
  })
})

function handleDispose(): void {
  handle?.dispose()
}
