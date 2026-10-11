// @vitest-environment node
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Surface } from '../src/surface.js'
import { PKG } from './helpers.js'

let dir: string
let surface: Surface
let url = ''

beforeAll(async () => {
  dir = mkdtempSync(path.join(PKG, 'fixtures', '.run-'))
  cpSync(path.join(PKG, 'fixtures', 'vite-svelte-app'), dir, { recursive: true })
  surface = new Surface(dir)
  url = (await surface.startDev({ timeoutMs: 90000 })).url
}, 120000)
afterAll(async () => {
  await surface.stopDev()
  rmSync(dir, { recursive: true, force: true })
})

it('Vite + Svelte: detected, marks in the module, bridge injected through index.html', async () => {
  expect(surface.info).toMatchObject({ kind: 'vite-svelte', frameworkId: 'svelte-vite', staticDir: 'public' })
  expect(await surface.pages()).toEqual([]) // no page list for plain Vite
  const html = await (await fetch(url + '/')).text()
  expect(html).toContain('src="/@surface/bridge.js"')
  const app = await (await fetch(url + '/src/App.svelte')).text()
  expect(app).toContain('data-fs')
  expect(app).toContain('src/App.svelte:5:1')
  const r = await surface.edit('src/App.svelte:6:3', { op: 'setText', text: 'Design to code' })
  expect(r.code).toContain('<h1>Design to code</h1>')
  await expect.poll(async () => (await fetch(url + '/src/App.svelte')).text(), { timeout: 15000 }).toContain('Design to code')
})
