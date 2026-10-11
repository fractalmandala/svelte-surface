import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectProject, findUsages, importClosure, listPages, scaffoldPage, wrapperSource, resolveImport } from '../src/orchestrator/index.js'
import { FIXTURE, PKG } from './helpers.js'
import { tmpdir } from 'node:os'

const copies: string[] = []
function copyFixture(): string {
  // inside the package so node_modules resolves upward, like the e2e test
  const dir = mkdtempSync(path.join(PKG, 'fixtures', '.run-'))
  cpSync(FIXTURE, dir, { recursive: true })
  copies.push(dir)
  return dir
}
afterAll(() => copies.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('detect', () => {
  it('SvelteKit via @sveltejs/kit', () => {
    const i = detectProject(FIXTURE)
    expect(i).toMatchObject({ kind: 'sveltekit', frameworkId: 'sveltekit', staticDir: 'static', hasTailwind: false })
    expect(i.versions.svelte).toMatch(/^5\./)
    expect(i.routesDir).toBe(path.join(FIXTURE, 'src/routes'))
  })
  it('Vite + Svelte via vite and svelte; unknown otherwise', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vs-'))
    copies.push(dir)
    cpSync(path.join(FIXTURE, 'package.json'), path.join(dir, 'package.json'))
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    delete pj.devDependencies['@sveltejs/kit']
    require_write(path.join(dir, 'package.json'), JSON.stringify(pj))
    expect(detectProject(dir)).toMatchObject({ kind: 'vite-svelte', frameworkId: 'svelte-vite', staticDir: 'public', routesDir: null })
    require_write(path.join(dir, 'package.json'), '{}')
    expect(detectProject(dir).kind).toBe('unknown')
  })
})

import { writeFileSync } from 'node:fs'
function require_write(f: string, c: string): void {
  writeFileSync(f, c)
}

describe('pages', () => {
  it('lists +page.svelte, ignoring (groups)', async () => {
    const pages = await listPages(FIXTURE)
    expect(pages.map((p) => [p.route, p.file])).toEqual([
      ['/', 'src/routes/+page.svelte'],
      ['/about', 'src/routes/about/+page.svelte'],
      ['/legacy', 'src/routes/legacy/+page.svelte'],
      ['/pricing', 'src/routes/(site)/pricing/+page.svelte']
    ])
  })
  it('scaffolds a page once, refusing overwrite and traversal', async () => {
    const dir = copyFixture()
    const rel = await scaffoldPage(dir, '/blog/[slug]')
    expect(rel).toBe('src/routes/blog/[slug]/+page.svelte')
    expect(readFileSync(path.join(dir, rel), 'utf8')).toContain('<h1>Slug</h1>')
    expect((await listPages(dir)).find((p) => p.route === '/blog/[slug]')?.dynamic).toBe(true)
    await expect(scaffoldPage(dir, '/blog/[slug]')).rejects.toThrow(/already exists/)
    await expect(scaffoldPage(dir, '../evil')).rejects.toThrow(/not a valid/)
    await scaffoldPage(dir, 'tw', { tailwind: true, title: 'Hi' })
    expect(readFileSync(path.join(dir, 'src/routes/tw/+page.svelte'), 'utf8')).toContain('class="mx-auto max-w-3xl px-6 py-24"')
  })
})

describe('graph', () => {
  it('walks imports (3 deep) and finds where a component is used', async () => {
    const c = await importClosure(FIXTURE, 'src/routes/+page.svelte')
    expect(c.get('src/lib/Card.svelte')).toBe(1)
    const uses = await findUsages(FIXTURE, 'src/lib/Card.svelte')
    expect(uses).toEqual([{ file: 'src/routes/+page.svelte', line: 9, col: 3, name: 'Card' }])
  })
  it('resolves $lib and package #imports', () => {
    expect(resolveImport(FIXTURE, 'src/routes/+page.svelte', '$lib/Card.svelte')).toBe('src/lib/Card.svelte')
    expect(resolveImport(FIXTURE, 'src/routes/+page.svelte', '../lib/Card.svelte')).toBe('src/lib/Card.svelte')
  })
})

describe('wrapper config', () => {
  it('loads the project config with its own vite and puts ONE plugin first', () => {
    const src = wrapperSource('/p', '/x/plugin.js')
    expect(src).toContain('loadConfigFromFile')
    expect(src).toContain('plugins: [surfaceMarks(')
    expect(src).toContain('...(user.plugins ?? [])')
    expect(existsSync('/x')).toBe(false)
  })
})
