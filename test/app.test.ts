/**
 * Drives the built app server (the browser build of the UI, as used by `npm run app`) in real Chrome via Playwright: start screen, in-UI folder browser, recents on disk,
 * safe-edit warnings, missing-deps prompt, dev-server failure UI, switch/close, and the editor itself
 * (select inside the iframe, edits, resize drag, structure, variants, live reload).
 * Skipped when no Chrome is found (set CHROME_PATH). Set APP_TEST_INSTALL=1 to also run a real `npm install`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'

const pkg = path.resolve(import.meta.dirname, '..')
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p))
const run = path.join(pkg, 'fixtures/.demo-run')
const disk = (rel: string) => readFileSync(path.join(run, rel), 'utf8')
/** the DRAFT text of an example file (what the canvas previews); the disk only changes on Save */
const read = async (rel: string) => ((await api('/api/file?file=' + encodeURIComponent(rel))).json.text as string)
const PORT = 4351
const url = `http://localhost:${PORT}/`

const home = mkdtempSync(path.join(os.tmpdir(), 'fs-app-home-'))
mkdirSync(path.join(pkg, 'fixtures/.app-test'), { recursive: true })
const nodepsBase = mkdtempSync(path.join(os.tmpdir(), 'fs-app-nodeps-'))
const work = mkdtempSync(path.join(pkg, 'fixtures/.app-test/w-'))
let server: ChildProcess | null = null
let browser: Browser
let page: Page

function startServer(): Promise<void> {
  server = spawn('node', ['app-dist/server.mjs', '--port', String(PORT), '--no-open'], { cwd: pkg, env: { ...process.env, SURFACE_APP_HOME: home, GIT_CEILING_DIRECTORIES: path.join(pkg, 'fixtures/.app-test') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('app server did not start:\n' + out)), 60000)
    server!.stdout!.on('data', (d) => { out += d; if (out.includes('Ctrl-C')) { clearTimeout(t); resolve() } })
    server!.stderr!.on('data', (d) => (out += d))
  })
}
const stopServer = () =>
  new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.once('exit', () => resolve())
    server.kill('SIGINT')
    server = null
  })

/** a project copy; under `work` (inside this package) vite/svelte resolve from the package's node_modules, under tmp they do not */
function makeProject(name: string, opts: { base?: string; git?: 'none' | 'clean' | 'dirty'; viteConfig?: string } = {}): string {
  const dir = path.join(opts.base ?? work, name)
  mkdirSync(dir, { recursive: true })
  const src = path.join(pkg, 'fixtures/sveltekit-app')
  for (const n of ['package.json', 'vite.config.js', 'src', 'static']) if (existsSync(path.join(src, n))) cpSync(path.join(src, n), path.join(dir, n), { recursive: true })
  if (opts.viteConfig) writeFileSync(path.join(dir, 'vite.config.js'), opts.viteConfig)
  if (opts.git && opts.git !== 'none') {
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' })
    writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.svelte-kit\n')
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init')
    if (opts.git === 'dirty') writeFileSync(path.join(dir, 'src/routes/+page.svelte'), readFileSync(path.join(dir, 'src/routes/+page.svelte'), 'utf8') + '\n<!-- wip -->\n')
  }
  return dir
}
const api = async (p: string, body?: unknown) => {
  const r = await fetch(url.slice(0, -1) + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: (await r.json()) as any }
}
async function openViaBrowser(dir: string) {
  await page.click('#openFolder')
  await page.fill('#brPath', dir)
  await page.press('#brPath', 'Enter')
  await expect.poll(() => page.inputValue('#brPath')).toBe(dir)
  // the listing for `dir` has painted (the typed path alone proves nothing)
  await expect.poll(() => page.locator('#brCrumbs a').last().textContent()).toBe(path.basename(dir))
}

beforeAll(async () => {
  if (!CHROME) return
  await startServer()
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await stopServer()
  for (const d of [home, work, nodepsBase]) rmSync(d, { recursive: true, force: true })
})

describe.skipIf(!CHROME)('standalone app in a real browser', () => {
  it('start screen: no project, no recents, nothing editable yet', async () => {
    await page.goto(url)
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
    expect(await page.locator('#editor').isHidden()).toBe(true)
    expect(await page.textContent('#recents')).toContain('No recent projects')
    expect((await api('/api/pages')).status).toBe(409) // editor API refuses without a project
  })

  it('folder browser: breadcrumbs, shortcuts, project highlighting, errors', async () => {
    const plain = path.join(work, 'plain'); mkdirSync(plain); writeFileSync(path.join(plain, 'package.json'), '{"name":"plain"}')
    const nogit = makeProject('nogit')
    const dirty = makeProject('dirty', { git: 'dirty' })
    await page.goto(url)
    await openViaBrowser(work)
    expect(await page.locator('#brShortcuts button').allTextContents()).toEqual(expect.arrayContaining(['Home']))
    expect(await page.locator('#brCrumbs a').count()).toBeGreaterThan(1)
    const names = await page.locator('#brList .brrow:not(.proj)').allTextContents()
    expect(names.join('|')).toContain('plain')
    await expect.poll(() => page.locator('#brList .brrow.proj').count()).toBe(2)
    expect((await page.locator('#brList .brrow.proj').allTextContents()).join('|')).toMatch(/dirty.*SvelteKit/)
    await page.fill('#brPath', path.join(work, 'does-not-exist'))
    await page.press('#brPath', 'Enter')
    await expect.poll(() => page.textContent('#brError')).toContain('does not exist')
    // going up via breadcrumb works
    await page.fill('#brPath', nogit); await page.press('#brPath', 'Enter')
    await expect.poll(() => page.inputValue('#brPath')).toBe(nogit)
    await expect.poll(() => page.locator('#brCrumbs a').last().textContent()).toBe('nogit')
    await page.locator('#brCrumbs a').nth(-2).click()
    await expect.poll(() => page.inputValue('#brPath')).toBe(work)
    void dirty
    await page.click('#brClose')
  })

  it('unsupported folder shows a clear error', async () => {
    await page.goto(url)
    await openViaBrowser(work)
    await page.click('#brList .brrow:has-text("plain")')
    await page.click('#brOpen')
    await expect.poll(() => page.textContent('#flowError')).toContain('not a supported project')
    expect(await page.textContent('#flowError')).toContain('not a SvelteKit')
    await page.click('#flowBack')
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
  })

  it('missing node_modules prompts to install; the server refuses to open without it', async () => {
    const dir = makeProject('nodeps', { base: nodepsBase })
    await page.goto(url)
    await openViaBrowser(nodepsBase)
    await page.dblclick('#brList .brrow:has-text("nodeps")')
    await expect.poll(() => page.textContent('#flowCard')).toContain('node_modules is missing')
    expect(await page.textContent('#flowInstall')).toContain('npm install')
    expect(await page.locator('#flowOpen').isDisabled()).toBe(true)
    const r = await api('/api/project/open', { path: dir, acknowledged: true })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('no-deps')
    await page.click('#flowBack')
  })

  it.skipIf(!process.env.APP_TEST_INSTALL)('install runs a real npm install and then opens', async () => {
    const dir = makeProject('toinstall', { base: nodepsBase })
    await page.goto(url)
    await page.click('#openFolder')
    await page.fill('#brPath', dir); await page.press('#brPath', 'Enter')
    await page.click('#brOpen')
    await page.click('#flowInstall')
    // install finished: the card is re-checked and now only asks about git
    await expect.poll(async () => !(await page.textContent('#flowCard'))!.includes('node_modules is missing'), { timeout: 280000 }).toBe(true)
    expect(existsSync(path.join(dir, 'node_modules/vite/package.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'node_modules/svelte/package.json'))).toBe(true)
    expect(await page.textContent('#flowCard')).not.toContain('node_modules is missing')
    await page.check('#flowAck')
    await page.click('#flowOpen')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 120000 })
    await page.click('#closeBtn')
  }, 300000)

  it('non-git project: warning must be acknowledged (also enforced by the server)', async () => {
    const dir = path.join(work, 'nogit')
    await page.goto(url)
    await openViaBrowser(work)
    await page.dblclick('#brList .brrow:has-text("nogit")')
    await expect.poll(() => page.textContent('#flowWarn')).toContain('not in a git repository')
    expect(await page.locator('#flowOpen').isDisabled()).toBe(true)
    const refused = await api('/api/project/open', { path: dir })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('needs-ack')
    await page.check('#flowAck')
    await page.click('#flowOpen')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    expect(await page.textContent('#banner')).toContain('nothing is written to disk until you Save')
    expect(await page.textContent('#banner')).toContain('not under git')
    expect(await page.textContent('#projName')).toContain('sveltekit-fixture')
    // an edit lands in THIS project's file, not the example
    await expect.poll(() => page.locator('#layers div').count(), { timeout: 30000 }).toBeGreaterThan(0)
    await page.frameLocator('#frame').locator('h1').click()
    await expect.poll(() => page.inputValue('#p-text')).toBe('Selected work')
    await page.fill('#p-text', 'Edited in a user project')
    await page.click('#p-text-apply')
    const pageFile = path.join(dir, 'src/routes/+page.svelte')
    await expect.poll(async () => ((await api('/api/file?file=src/routes/%2Bpage.svelte')).json.text as string)).toContain('Edited in a user project')
    expect(readFileSync(pageFile, 'utf8')).not.toContain('Edited in a user project') // a draft: the disk is untouched
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('1 unsaved')
    await page.click('#saveAllBtn') // Save writes to this project's file
    await expect.poll(() => readFileSync(pageFile, 'utf8')).toContain('Edited in a user project')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved')
    expect(await page.locator('#resetBtn').isHidden()).toBe(true) // reset is example-only
    // switch project: start screen shows resume + the recent entry; the project keeps running
    await page.click('#switchBtn')
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
    expect(await page.textContent('#resume')).toContain('sveltekit-fixture')
    expect(await page.locator('.recent').count()).toBe(1)
    await page.click('#resumeBtn')
    await expect.poll(() => page.locator('#editor').isVisible()).toBe(true)
    // close project: dev server is stopped and the server forgets it
    const dev = (await api('/api/app')).json.current.devUrl as string
    await page.click('#closeBtn')
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
    expect((await api('/api/app')).json.current).toBeNull()
    await expect.poll(async () => fetch(dev).then(() => 'up', () => 'down'), { timeout: 15000 }).toBe('down')
  }, 180000)

  it('dirty git project warns with the uncommitted count; clean git opens straight away', async () => {
    await page.goto(url)
    await openViaBrowser(work)
    await page.dblclick('#brList .brrow:has-text("dirty")')
    await expect.poll(() => page.textContent('#flowWarn')).toMatch(/1 uncommitted change/)
    await page.click('#flowBack')
    makeProject('clean', { git: 'clean' })
    await openViaBrowser(work)
    await page.dblclick('#brList .brrow:has-text("clean")')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    expect(await page.textContent('#banner')).toContain('nothing is written to disk until you Save')
    expect(await page.textContent('#banner')).not.toContain('not under git') // a git repo: only the drafts note
    await page.click('#closeBtn')
  }, 180000)

  it('a dev server that fails to start shows the reason, not a blank screen', async () => {
    const dir = makeProject('broken', { git: 'clean', viteConfig: "throw new Error('boom from vite.config')\n" })
    await page.goto(url)
    await openViaBrowser(work)
    await page.dblclick('#brList .brrow:has-text("broken")')
    await expect.poll(() => page.textContent('#flowError'), { timeout: 90000 }).toContain('did not start')
    expect(await page.textContent('#flowError')).toContain('boom from vite.config')
    expect((await api('/api/app')).json.current).toBeNull()
    expect(await page.locator('#flowRetry').isVisible()).toBe(true)
    await page.click('#flowBack')
    void dir
  }, 180000)

  it('recents persist on disk and survive an app restart', async () => {
    const file = path.join(home, 'recents.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { path: string; name: string }[]
    expect(saved.map((r) => path.basename(r.path))).toEqual(expect.arrayContaining(['clean', 'nogit']))
    await stopServer()
    await startServer()
    await page.goto(url)
    await expect.poll(() => page.locator('.recent').count()).toBeGreaterThanOrEqual(2)
    expect(await page.locator('#recents').textContent()).toContain('clean')
    // click a recent: opens it
    await page.click('.recent[data-path$="/clean"]')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    await page.click('#closeBtn')
    // remove from recents
    await page.click('.recent[data-path$="/nogit"] .x')
    await expect.poll(() => page.locator('.recent[data-path$="/nogit"]').count()).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toContain('nogit')
  }, 180000)

  it('the bundled example opens directly and the full editor works end to end', async () => {
  // right after an HMR the canvas can briefly carry the previous marks: click again until the panel agrees
  const pickUntil = (loc: ReturnType<ReturnType<Page['frameLocator']>['locator']>, ref: string) =>
    expect
      .poll(async () => { await loc.click(); await new Promise((r) => setTimeout(r, 250)); return page.locator('#selRef').textContent() }, { timeout: 20000, interval: 300 })
      .toContain(ref)

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.click('#openExample')
    const canvas = page.frameLocator('#frame')
    await canvas.locator('h1').waitFor({ timeout: 60000 })

    // page picker comes from listPages
    const options = await page.locator('#pageSelect option').allTextContents()
    expect(options.join('|')).toMatch(/\/.*\/about.*\/legacy.*\/pricing/)

    // click inside the iframe -> panel shows the source ref
    await expect.poll(() => page.locator('#layers div').count(), { timeout: 30000 }).toBeGreaterThan(0) // bridge handshake done
    await canvas.locator('h1').click()
    await expect.poll(() => page.locator('#selRef').textContent()).toContain('src/routes/+page.svelte:7:3')
    await expect.poll(() => page.inputValue('#p-text')).toBe('Selected work')
    expect(await page.locator('#layers div').count()).toBeGreaterThan(3)

    // text -> file + live canvas (no manual reload)
    await page.fill('#p-text', 'Demo headline')
    await page.click('#p-text-apply')
    await expect.poll(() => read('src/routes/+page.svelte')).toContain('>Demo headline</h1>')
    await expect.poll(() => canvas.locator('h1').textContent(), { timeout: 20000 }).toBe('Demo headline')

    // classes, state classes, attribute
    await page.fill('#p-classes', 'text-6xl underline')
    await page.click('#p-classes-apply')
    await expect.poll(() => read('src/routes/+page.svelte')).toContain('class="text-6xl underline"')
    await page.fill('#p-state-classes', 'text-red')
    await page.click('#p-state-add')
    await expect.poll(() => read('src/routes/+page.svelte')).toContain('hover:text-red')
    await page.fill('#p-attr-name', 'data-demo')
    await page.fill('#p-attr-value', 'yes')
    await page.click('#p-attr-add')
    await expect.poll(() => read('src/routes/+page.svelte')).toContain('data-demo="yes"')
    await expect.poll(() => canvas.locator('h1[data-demo="yes"]').count(), { timeout: 20000 }).toBe(1)

    // style panel (no Tailwind in the fixture -> inline style)
    await page.fill('[data-style="opacity"]', '0.5')
    await page.click('#p-style-apply')
    await expect.poll(() => read('src/routes/+page.svelte')).toMatch(/style="[^"]*opacity:\s*0\.5/)

    // resize handle drag in the canvas -> commit -> file
    const before = await read('src/routes/+page.svelte')
    const handle = canvas.locator('[data-handle="e"]')
    await handle.waitFor({ state: 'attached' })
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => read('src/routes/+page.svelte')).toMatch(/width:\s*\d+(\.\d+)?px/)
    expect(await read('src/routes/+page.svelte')).not.toBe(before)
    await expect.poll(() => canvas.locator('h1').evaluate((e) => (e as HTMLElement).style.width), { timeout: 20000 }).toMatch(/px$/)

    // insert / move / duplicate / remove
    await page.fill('#p-markup', '<p id="ins">Inserted</p>')
    await page.selectOption('#p-pos', 'after')
    await page.click('#p-insert')
    await expect.poll(() => canvas.locator('#ins').textContent(), { timeout: 20000 }).toBe('Inserted')
    await expect.poll(() => page.locator('#sel').isHidden()).toBe(true)
    await canvas.locator('h1').click()
    await expect.poll(() => page.locator('#sel').isVisible()).toBe(true)
    await page.click('#p-down')
    await expect.poll(async () => { const s = await read('src/routes/+page.svelte'); return s.indexOf('id="ins"') < s.indexOf('<h1') && s.includes('id="ins"') }).toBe(true)
    await page.click('#undoBtn')
    await expect.poll(async () => { const s = await read('src/routes/+page.svelte'); return s.indexOf('<h1') < s.indexOf('id="ins"') }).toBe(true)
    // wait for the canvas to show the undone order, so the marks we click are fresh
    await expect.poll(() => canvas.locator('#ins').evaluate((e) => e.previousElementSibling?.tagName), { timeout: 20000 }).toBe('H1')
    await pickUntil(canvas.locator('#ins'), '+page.svelte:8:3')
    await page.click('#p-dup')
    await expect.poll(() => canvas.locator('#ins').count(), { timeout: 20000 }).toBe(2)
    await pickUntil(canvas.locator('#ins').first(), '+page.svelte:8:3')
    await page.click('#p-remove')
    await expect.poll(() => canvas.locator('#ins').count(), { timeout: 20000 }).toBe(1)
    await pickUntil(canvas.locator('#ins'), '+page.svelte:8:3')
    await page.click('#p-remove')
    await expect.poll(() => canvas.locator('#ins').count(), { timeout: 20000 }).toBe(0)

    // component source: a click inside <Card> edits src/lib/Card.svelte, and variants author there
    await canvas.locator('section').first().click()
    await expect.poll(() => page.locator('#selRef').textContent()).toContain('src/lib/Card.svelte')
    await page.click('#p-var-add')
    await expect.poll(() => read('src/lib/Card.svelte')).toMatch(/variant/)
    await expect.poll(() => page.locator('#p-variants').textContent()).toContain('variant (default primary')
    await page.fill('#p-var-value', 'primary')
    await page.fill('#p-var-classes', 'bg-blue-600')
    await page.click('#p-var-classes-add')
    await expect.poll(() => read('src/lib/Card.svelte')).toContain('data-[variant=primary]:bg-blue-600')

    // page picker drives the iframe
    await page.selectOption('#pageSelect', '/about')
    await expect.poll(() => page.frames().some((f) => f.url().endsWith('/about'))).toBe(true)
    await canvas.locator('h1, h2, p').first().waitFor()

    // reset restores the fixture
    await page.click('#resetBtn')
    await expect.poll(() => read('src/routes/+page.svelte')).toContain('>Selected work</h1>')
    expect(errors.join('\n')).toBe('')
  }, 240000)


  /* ------------------------------------------------------------------ drafts + code editor ------------------------------------------------------------------ */
  async function freshExample() {
    await api('/api/project/close', { discard: true })
    await page.goto(url)
    await page.click('#openExample')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    await expect.poll(() => page.locator('#layers div').count(), { timeout: 30000 }).toBeGreaterThan(0)
  }
  const PAGE = 'src/routes/+page.svelte'
  const h1text = () => page.frameLocator('#frame').locator('h1').first().textContent()
  const setHeadline = async (text: string) => {
    await page.frameLocator('#frame').locator('h1').first().click()
    await expect.poll(() => page.inputValue('#p-text')).not.toBe('')
    await page.fill('#p-text', text)
    await page.click('#p-text-apply')
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe(text)
  }

  it('drafts: canvas edits and typed code preview live without touching the disk; Cmd+S saves', async () => {
    await freshExample()
    const original = disk(PAGE)
    await setHeadline('Draft headline')
    expect(disk(PAGE)).toBe(original) // the preview shows the draft, the file is untouched
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('1 unsaved')
    expect(await page.locator('#saveAllBtn').isEnabled()).toBe(true)

    // Open code: file beside preview, cursor on the element's line, showing the draft text
    await page.click('#selOpenCode')
    await expect.poll(() => page.locator('#codepane').isVisible()).toBe(true)
    await expect.poll(() => page.textContent('#cpFile')).toBe(PAGE)
    await expect.poll(() => page.evaluate(() => { const v = (window as any).__code.view; return v.state.doc.lineAt(v.state.selection.main.head).number })).toBe(7)
    expect(await page.locator('#cpEditor').textContent()).toContain('Draft headline')
    expect(await page.textContent('#cpState')).toContain('unsaved')
    expect(await page.locator('#cpEditor .cm-lineNumbers').count()).toBe(1)
    expect(await page.locator('#cpEditor .cm-foldGutter').count()).toBe(1)
    expect(await page.locator('#cpEditor .cm-line span[class]').count()).toBeGreaterThan(0) // syntax colours

    // typed code → draft → canvas (HMR from the draft), disk still untouched
    await page.keyboard.type('<p id="typed">typed live</p>\n')
    await expect.poll(() => page.frameLocator('#frame').locator('#typed').textContent(), { timeout: 30000 }).toBe('typed live')
    expect(disk(PAGE)).toBe(original)
    // marks stay true on drafts: the h1 moved one line down, and a click resolves to its new position
    await page.frameLocator('#frame').locator('h1').click()
    await expect.poll(() => page.textContent('#selRef')).toMatch(/\+page\.svelte:8:\d+/)
    await page.fill('#p-classes', 'draft-class')
    await page.click('#p-classes-apply')
    await expect.poll(async () => (await read(PAGE))).toMatch(/<h1 class="draft-class">Draft headline<\/h1>/)
    expect(disk(PAGE)).toBe(original)

    // Cmd/Ctrl+S in the editor writes the file; the canvas keeps what it shows
    await page.click('#cpEditor .cm-content')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => disk(PAGE)).toContain('<p id="typed">typed live</p>')
    expect(disk(PAGE)).toContain('Draft headline')
    expect(disk(PAGE)).toContain('class="draft-class"')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved')
    expect(await page.textContent('#cpState')).toContain('saved')
    expect(await h1text()).toBe('Draft headline')
  }, 180000)

  it('drafts: revert (per file, from the drafts list) and undo/redo over the draft', async () => {
    await freshExample()
    const original = disk(PAGE)
    await setHeadline('One')
    await page.fill('#p-classes', 'underline')
    await page.click('#p-classes-apply')
    await expect.poll(async () => await read(PAGE)).toContain('class="underline"')
    // undo / redo
    await page.click('#undoBtn')
    await expect.poll(async () => await read(PAGE)).not.toContain('class="underline"')
    expect(await read(PAGE)).toContain('>One</h1>')
    await page.click('#undoBtn')
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe('Selected work')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved') // back to the disk's content: no draft left
    await page.click('#redoBtn')
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe('One')
    await page.press('body', 'ControlOrMeta+z') // outside the editor: Cmd+Z is the draft undo too
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe('Selected work')
    await page.click('#redoBtn')
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe('One')

    // revert one file from the drafts list
    await page.click('#draftsBtn')
    await expect.poll(() => page.locator(`.draftrow[data-file="${PAGE}"]`).count()).toBe(1)
    await page.click(`.draftrow[data-file="${PAGE}"] button:has-text("Revert")`)
    await page.click('#confirmBtns button:has-text("Revert")')
    await expect.poll(() => h1text(), { timeout: 20000 }).toBe('Selected work')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved')
    expect(disk(PAGE)).toBe(original)
    expect(await page.locator('#undoBtn').isDisabled()).toBe(true) // its history went with it
    await page.click('#draftsClose')
  }, 180000)

  it('drafts: diff view shows disk on the left and the draft on the right', async () => {
    await freshExample()
    await setHeadline('Diffed headline')
    await page.click('#draftsBtn')
    await page.click(`.draftrow[data-file="${PAGE}"] button:has-text("Diff")`)
    await expect.poll(() => page.locator('#diffHost .cm-mergeView').count()).toBe(1)
    const text = await page.textContent('#diffHost')
    expect(text).toContain('Selected work')
    expect(text).toContain('Diffed headline')
    expect(await page.locator('#diffHost .cm-changedLine, #diffHost .cm-deletedChunk, #diffHost .cm-changedText').count()).toBeGreaterThan(0)
    await page.click('#diffClose')
    await page.click('#draftsClose')
  }, 120000)

  it('drafts: save is refused when the disk file changed; reload / keep draft / overwrite resolve it', async () => {
    await freshExample()
    const original = disk(PAGE)
    // 1) overwrite
    await setHeadline('Mine')
    writeFileSync(path.join(run, PAGE), original.replace('Selected work', 'Theirs 1'))
    await expect.poll(() => page.textContent('#draftsBtn'), { timeout: 20000 }).toContain('conflict')
    expect(await h1text()).toBe('Mine') // the preview still shows my draft
    await page.click('#saveAllBtn')
    await expect.poll(() => page.textContent('#status')).toContain('changed on disk since you opened it')
    expect(disk(PAGE)).toContain('Theirs 1') // nothing was written over the outside change
    await expect.poll(() => page.locator('#draftsModal').isVisible()).toBe(true)
    await page.click(`.draftrow[data-file="${PAGE}"] button:has-text("Overwrite")`)
    await expect.poll(() => disk(PAGE)).toContain('>Mine</h1>')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved')
    await page.click('#draftsClose')

    // 2) reload from disk (drops my draft)
    await setHeadline('Mine 2')
    writeFileSync(path.join(run, PAGE), disk(PAGE).replace('>Mine</h1>', '>Theirs 2</h1>'))
    await expect.poll(() => page.textContent('#draftsBtn'), { timeout: 20000 }).toContain('conflict')
    await page.click('#draftsBtn')
    await page.click(`.draftrow[data-file="${PAGE}"] button:has-text("Reload")`)
    await expect.poll(() => h1text(), { timeout: 30000 }).toBe('Theirs 2')
    await expect.poll(() => page.textContent('#draftsBtn')).toContain('No unsaved')
    await page.click('#draftsClose')

    // 3) keep my draft (rebase on the new disk text), then save
    await setHeadline('Mine 3')
    writeFileSync(path.join(run, PAGE), disk(PAGE).replace('<main', '<main data-ext="1"'))
    await expect.poll(() => page.textContent('#draftsBtn'), { timeout: 20000 }).toContain('conflict')
    await page.click('#draftsBtn')
    await page.click(`.draftrow[data-file="${PAGE}"] button:has-text("Keep draft")`)
    await expect.poll(() => page.textContent('#draftsBtn')).not.toContain('conflict')
    await page.click('#draftsClose')
    await page.click('#saveAllBtn')
    await expect.poll(() => disk(PAGE)).toContain('>Mine 3</h1>')
    expect(disk(PAGE)).not.toContain('data-ext') // keeping my draft means it replaces the disk version (Diff shows the difference first)
  }, 240000)

  it('code mode: file tree, tabs, find, folding, preview beside the code jumps to the clicked element', async () => {
    await freshExample()
    await page.click('#modeSeg button[data-mode="code"]')
    await expect.poll(() => page.locator('#tree').isVisible()).toBe(true)
    expect(await page.locator('#left').isHidden()).toBe(true)
    await expect.poll(() => page.locator(`#treeBox .file[data-file="${PAGE}"]`).count()).toBe(1)
    expect(await page.locator('#treeBox').textContent()).not.toContain('node_modules')
    // the tree opens files into tabs
    await expect.poll(() => page.textContent('#cpFile')).toBe(PAGE)
    await page.click('#treeBox .file[data-file="src/lib/Card.svelte"]')
    await expect.poll(() => page.locator('#cpTabs .tab').count()).toBe(2)
    expect(await page.locator('#cpEditor').textContent()).toContain('<section')
    // find/replace panel
    await page.click('#cpEditor .cm-content')
    await page.keyboard.press('ControlOrMeta+f')
    await expect.poll(() => page.locator('#cpEditor .cm-search').count()).toBe(1)
    await page.keyboard.press('Escape')
    // typing marks the tab and the tree dirty, and only a draft
    await page.click('#cpEditor .cm-content')
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('<!-- note -->')
    await expect.poll(() => page.locator('#cpTabs .tab.on .dot:not([hidden])').count()).toBe(1)
    await expect.poll(() => page.locator('#treeBox .file[data-file="src/lib/Card.svelte"] .dot').count()).toBe(1)
    expect(readFileSync(path.join(run, 'src/lib/Card.svelte'), 'utf8')).not.toContain('<!-- note -->')
    // preview beside the code: clicking an element opens its file at its line
    await page.click('#cpPreview')
    await expect.poll(() => page.locator('#canvas').isVisible()).toBe(true)
    await page.click(`#cpTabs .tab[data-file="${PAGE}"]`)
    await page.frameLocator('#frame').locator('h1').click()
    await expect.poll(() => page.textContent('#cpFile')).toBe(PAGE)
    await expect.poll(() => page.evaluate(() => { const v = (window as any).__code.view; return v.state.doc.lineAt(v.state.selection.main.head).number })).toBe(7)
    // a component's element jumps to the component file
    await page.frameLocator('#frame').locator('section').first().click()
    await expect.poll(() => page.textContent('#cpFile')).toBe('src/lib/Card.svelte')
    // back to design mode
    await page.click('#modeSeg button[data-mode="design"]')
    await expect.poll(() => page.locator('#left').isVisible()).toBe(true)
  }, 180000)

  it('unsaved drafts: closing or switching the project asks first (cancel / discard / save)', async () => {
    await freshExample()
    const original = disk(PAGE)
    await setHeadline('Unsaved headline')
    // cancel keeps everything
    await page.click('#closeBtn')
    await expect.poll(() => page.locator('#confirmModal').isVisible()).toBe(true)
    expect(await page.textContent('#confirmText')).toContain('unsaved')
    expect(await page.textContent('#confirmList')).toContain(PAGE)
    await page.click('#confirmBtns button:has-text("Cancel")')
    expect(await page.locator('#editor').isVisible()).toBe(true)
    expect((await api('/api/app')).json.current).not.toBeNull()
    // switching to another project is refused by the server too, until discarded
    const refused = await api('/api/project/open', { path: run })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('unsaved-drafts')
    // discard: gone, disk untouched
    await page.click('#closeBtn')
    await page.click('#confirmBtns button:has-text("Discard drafts")')
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
    expect((await api('/api/app')).json.current).toBeNull()
    expect(disk(PAGE)).toBe(original)
    // save and continue
    await page.click('#openExample')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    await expect.poll(() => page.locator('#layers div').count(), { timeout: 30000 }).toBeGreaterThan(0)
    await setHeadline('Saved on close')
    await page.click('#closeBtn')
    await page.click('#confirmBtns button:has-text("Save all and continue")')
    await expect.poll(() => page.locator('#start').isVisible()).toBe(true)
    expect(disk(PAGE)).toContain('>Saved on close</h1>')
    // the resume row on the start screen shows unsaved counts while a project stays open
    await page.click('#openExample')
    await page.frameLocator('#frame').locator('h1').waitFor({ timeout: 90000 })
    await expect.poll(() => page.locator('#layers div').count(), { timeout: 30000 }).toBeGreaterThan(0)
    await setHeadline('Pending')
    await page.click('#switchBtn')
    await expect.poll(() => page.textContent('#resume')).toContain('1 unsaved')
    await page.click('#resumeClose')
    await page.click('#confirmBtns button:has-text("Discard drafts")')
    await expect.poll(() => page.locator('#resume').count()).toBe(0)
  }, 240000)
})
