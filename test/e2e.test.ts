// @vitest-environment node
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Surface } from '../src/surface.js'
import { bridgeSource } from '../src/bridge/source.js'
import { FIXTURE, PKG } from './helpers.js'
import type { DevServer } from '../src/orchestrator/dev.js'
import { isBridgeMessage, parseLoc, type Ref } from '../src/contract.js'

let dir: string
let surface: Surface
let dev: DevServer

beforeAll(async () => {
  dir = mkdtempSync(path.join(PKG, 'fixtures', '.run-'))
  cpSync(FIXTURE, dir, { recursive: true })
  surface = new Surface(dir)
  dev = await surface.startDev({ timeoutMs: 90000 })
}, 120000)

afterAll(async () => {
  await surface.stopDev()
  rmSync(dir, { recursive: true, force: true })
})

const get = async (p: string): Promise<string> => (await fetch(dev.url + p)).text()

/** Load the real SSR HTML into jsdom, boot the bridge there, and click an element: returns the select Ref. */
async function clickIn(html: string, selector: string): Promise<Ref> {
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''), { runScripts: 'outside-only', url: dev.url + '/' })
  const w = dom.window as unknown as Window & { eval(s: string): unknown }
  const sent: unknown[] = []
  ;(w.parent as unknown as { postMessage: (d: unknown) => void }).postMessage = (d) => void sent.push(d)
  // the served bridge is an ES module; strip `export` so it evaluates as a script, then install it
  const code = bridgeSource().replace(/^export /gm, '') + '\n;window.__h = installBridge({ frame: "e2e", always: true })'
  w.eval(code)
  const el = w.document.querySelector(selector)!
  expect(el, selector).not.toBeNull()
  el.dispatchEvent(new (w as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('click', { bubbles: true, cancelable: true }))
  const msg = sent.filter(isBridgeMessage).find((m) => m.t === 'select')
  expect(msg).toBeDefined()
  return (msg as unknown as { ref: Ref }).ref
}

describe('end to end on a real SvelteKit dev server', () => {
  it('serves marked HTML (data-fs, data-fsi → data-fsu) and the bridge', async () => {
    const html = await get('/')
    expect(html).toContain('data-fs="src/routes/+page.svelte:7:3"')
    expect(html).not.toContain('data-fsi') // the instance prop is consumed by the component, never rendered
    expect(html).toMatch(/<section[^>]*data-fs="src\/lib\/Card.svelte:5:1"[^>]*data-fsu="Card\|src\/routes\/\+page.svelte:9:3"/)
    // SvelteKit has no transformIndexHtml: the bridge rides in as an import of the entry components
    expect(await get('/src/routes/+layout.svelte')).toContain('virtual:surface-bridge')
    expect(await get('/@surface/bridge.js')).toContain('installBridge')
    expect(await get('/@id/__x00__virtual:surface-bridge')).toContain('installBridgeOnce')
    // layout (root) top element is marked too, and its snippet child is not a usage
    expect(html).toContain('data-fs="src/routes/+layout.svelte:5:1"')
  })

  it('click mark → edit → the right bytes change on disk; page re-renders', async () => {
    const page = path.join(dir, 'src/routes/+page.svelte')
    const before = readFileSync(page, 'utf8')
    const ref = await clickIn(await get('/'), 'h1')
    expect(ref).toMatchObject({ file: 'src/routes/+page.svelte', line: 7, col: 3, tag: 'h1', text: 'Selected work' })

    const t = await surface.edit(ref, { op: 'setText', text: 'Our best work', expect: ref.text })
    expect(t.changed).toBe(true)
    const c = await surface.edit(ref, { op: 'setClasses', add: ['text-6xl'], remove: ['text-5xl'] })
    expect(c.label).toMatch(/classes/)

    const after = readFileSync(page, 'utf8')
    expect(after).toBe(before.replace('<h1 class="text-5xl font-semibold">Selected work</h1>', '<h1 class="font-semibold text-6xl">Our best work</h1>'))

    // loop closure: the dev server serves the edit, with marks still in place
    await expect.poll(() => get('/'), { timeout: 15000 }).toContain('Our best work')
    expect(await get('/')).toContain('data-fs="src/routes/+page.svelte:7:3"')
  })

  it('component instance: edit a prop where it is used, and the text inside the component source', async () => {
    const html = await get('/')
    const ref = await clickIn(html, 'section h2')
    expect(ref).toMatchObject({ file: 'src/lib/Card.svelte', component: 'Card', fsi: 'Card|src/routes/+page.svelte:9:3' })
    const use = parseLoc(ref.fsi)!
    expect(use).toEqual({ file: 'src/routes/+page.svelte', line: 9, col: 3 })
    // {title} is an expression: refused with a pointer to where it is defined
    await expect(surface.edit(ref, { op: 'setText', text: 'x' })).rejects.toThrow(/variable/)
    // so we edit it where it is used
    await surface.edit(use, { op: 'setProp', name: 'title', value: 'FAQ' })
    expect(readFileSync(path.join(dir, 'src/routes/+page.svelte'), 'utf8')).toContain('<Card title="FAQ" />')
    await expect.poll(() => get('/'), { timeout: 15000 }).toMatch(/<h2[^>]*>FAQ<\/h2>/)
  })

  it('a half-typed file gets no marks and does not crash the server; fixing it restores marks', async () => {
    const f = path.join(dir, 'src/routes/about/+page.svelte')
    const good = readFileSync(f, 'utf8')
    expect(await get('/about')).toContain('data-fs="src/routes/about/+page.svelte:2:3"')
    rmSync(f)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(f, '<main><h1>About')
    await expect.poll(async () => (await get('/about')).includes('data-fs="src/routes/about'), { timeout: 15000 }).toBe(false)
    writeFileSync(f, good)
    await expect.poll(() => get('/about'), { timeout: 15000 }).toContain('data-fs="src/routes/about/+page.svelte:2:3"')
  })

  it('legacy mode (export let / $$props) on a live server: the instance props reach the component', async () => {
    const html = await get('/legacy')
    expect(html).toContain('<div data-fs="src/routes/legacy/+page.svelte:6:1"')
    expect(html).toMatch(/<aside[^>]*data-fs="src\/lib\/Legacy.svelte:5:1"[^>]*data-fsu="Legacy\|src\/routes\/legacy\/\+page.svelte:7:3"/)
    expect(html).not.toContain('data-fsi')
    const ref = await clickIn(html, 'aside h3')
    expect(ref).toMatchObject({ file: 'src/lib/Legacy.svelte', line: 6, tag: 'h3', component: 'Legacy', fsi: 'Legacy|src/routes/legacy/+page.svelte:7:3' })
  })

  it('style gesture round trip: bridge commit patch → file (inline style, no Tailwind in this project)', async () => {
    const page = path.join(dir, 'src/routes/+page.svelte')
    const ref = await clickIn(await get('/'), 'p.lead')
    const r = await surface.onBridgeMessage({
      __surface: true, t: 'commit', frame: 'e2e', patch: { ref, props: { width: '240px', rotate: '3deg' }, label: 'Resize width' }
    } as never)
    expect(r?.changed).toBe(true)
    expect(readFileSync(page, 'utf8')).toContain('<p class="lead" style="width: 240px; rotate: 3deg">Hello</p>')
    await expect.poll(() => get('/'), { timeout: 15000 }).toContain('width: 240px')
  })

  it('component variant authored on a live project; page keeps rendering with marks', async () => {
    const r = await surface.componentEdit('src/lib/Card.svelte', { op: 'addVariantProp', default: 'plain' })
    expect(r.code).toContain(`let { title, count = 3, variant = 'plain' } = $props()`)
    await surface.edit('src/lib/Card.svelte:5:1', { op: 'setVariantClasses', value: 'plain', add: ['bg-white'] })
    expect(await surface.variants('src/lib/Card.svelte')).toEqual([{ name: 'variant', default: 'plain', options: ['plain'] }])
    await expect.poll(() => get('/'), { timeout: 15000 }).toMatch(/<section[^>]*data-variant="plain"/)
    const html = await get('/')
    expect(html).toContain('group/variant')
    expect(html).toMatch(/<section[^>]*data-fsu="Card\|src\/routes\/\+page.svelte:9:3"/)
  })

  it('new page scaffolded and immediately served with marks', async () => {
    const rel = await surface.newPage('/hello')
    expect(rel).toBe('src/routes/hello/+page.svelte')
    await expect.poll(() => get('/hello'), { timeout: 15000 }).toContain('data-fs="src/routes/hello/+page.svelte:2:3"')
    expect((await surface.pages()).map((p) => p.route)).toContain('/hello')
  })
})
