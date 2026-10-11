// @vitest-environment node
/**
 * Live dev server on Svelte 4 + Vite 5 + vite-plugin-svelte 3 (own node_modules in the fixture:
 * `npm run fixtures:install`). Covers `export let`, `$$props` and `<script lang="ts">`.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Surface } from '../src/surface.js'
import { PKG } from './helpers.js'

const FIX = path.join(PKG, 'fixtures', 'svelte4-app')
const installed = existsSync(path.join(FIX, 'node_modules', 'svelte'))

describe.skipIf(!installed)('Svelte 4 (legacy $$props, lang="ts") on a live Vite 5 server', () => {
  let dir = ''
  let surface: Surface
  let url = ''
  beforeAll(async () => {
    // inside the fixture so its node_modules resolves upward
    dir = mkdtempSync(path.join(FIX, '.run-'))
    for (const name of readdirSync(FIX)) {
      if (name === 'node_modules' || name.startsWith('.run-')) continue
      cpSync(path.join(FIX, name), path.join(dir, name), { recursive: true })
    }
    surface = new Surface(dir)
    expect(surface.info.versions.svelte).toMatch(/^4\./)
    url = (await surface.startDev({ timeoutMs: 90000 })).url
  }, 120000)
  afterAll(async () => {
    await surface?.stopDev()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const get = async (p: string): Promise<string> => (await fetch(url + p)).text()

  it('marks a lang="ts" Svelte 4 component and wires $$props for the usage chain', async () => {
    expect(surface.info).toMatchObject({ kind: 'vite-svelte' })
    const app = await get('/src/App.svelte')
    expect(app).toContain('src/App.svelte:6:1')
    expect(app).toContain('src/App.svelte:7:3')
    expect(app).toContain('Badge|src/App.svelte:8:3')
    const badge = await get('/src/Badge.svelte')
    expect(badge).toContain('src/Badge.svelte:5:1')
    expect(badge).toContain('data-fsu')
    expect(badge).toContain('data-fsi') // read through $$props
    expect(await get('/')).toContain('src="/@surface/bridge.js"')
  })

  it('edits a lang="ts" Svelte 4 file and the dev server serves the change', async () => {
    const r = await surface.edit('src/App.svelte:6:1', { op: 'setClasses', add: ['page'] })
    expect(r.changed).toBe(true)
    expect(readFileSync(path.join(dir, 'src/App.svelte'), 'utf8')).toContain('<main class="page">')
    await expect.poll(() => get('/src/App.svelte'), { timeout: 15000 }).toContain('page')
    const v = await surface.componentEdit('src/Badge.svelte', { op: 'addVariantProp', default: 'soft', options: ['soft', 'solid'] })
    expect(v.code).toContain(`export let variant: 'soft' | 'solid' = 'soft'`)
    expect(await surface.variants('src/Badge.svelte')).toMatchObject([{ name: 'variant', default: 'soft' }])
    await expect.poll(() => get('/src/Badge.svelte'), { timeout: 15000 }).toContain('data-variant')
  })
})
