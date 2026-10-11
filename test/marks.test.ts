import { describe, expect, it } from 'vitest'
import { markSvelteSource } from '../src/marks/transform.js'
import { svelte4, svelte5 } from './helpers.js'

const PAGE = `<script>
  import Faq from '#lib/Faq.svelte'
</script>

<main class="mx-auto">
  <h1 class="text-5xl">Selected work</h1>
  <Faq title="Questions" />
</main>
`
const FAQ = `<script>
  let { title } = $props()
</script>

<section class="p-6">
  <h2>{title}</h2>
</section>
`

describe('mark plugin transform (Svelte 5)', () => {
  it('stamps data-fs on elements and data-fsi on component instances', async () => {
    const r = markSvelteSource(PAGE, 'src/routes/+page.svelte', await svelte5())!
    expect(r.code).toContain('<main data-fs="src/routes/+page.svelte:5:1" data-fsu=')
    expect(r.code).toContain('<h1 data-fs="src/routes/+page.svelte:6:3"')
    expect(r.code).toContain('<Faq data-fsi="Faq|src/routes/+page.svelte:7:3"')
    expect(r.marks).toMatchObject({ fs: 2, fsi: 1 })
  })

  it('keeps every original line in place (same-line insertions only)', async () => {
    const r = markSvelteSource(PAGE, 'a.svelte', await svelte5())!
    expect(r.code.split('\n').length).toBe(PAGE.split('\n').length)
  })

  it('declares the instance props on the receiving side ($props destructure)', async () => {
    const r = markSvelteSource(FAQ, 'src/lib/Faq.svelte', await svelte5())!
    expect(r.code).toContain(`let { 'data-fsi': __fsi, 'data-fsc': __fsc, title } = $props()`)
    expect(r.code).toContain('<section data-fs="src/lib/Faq.svelte:5:1" data-fsu={[__fsc, __fsi]')
    expect(r.code).toContain('<h2 data-fs="src/lib/Faq.svelte:6:3">') // nested: no data-fsu
  })

  it('works with a props identifier, with no script, and in legacy mode', async () => {
    const s = await svelte5()
    const a = markSvelteSource(`<script>let props = $props()</script>\n<p>x</p>`, 'a.svelte', s)!
    expect(a.code).toContain(`props['data-fsi']`)
    const b = markSvelteSource(`<p>{$$props.x}</p>`, 'b.svelte', s)!
    expect(b.code).toContain(`$$props['data-fsi']`)
    const c = markSvelteSource(`<p>hi</p>`, 'c.svelte', s, { runes: true })!
    expect(c.code).toMatch(/^<script> let \{ 'data-fsi': __fsi/)
    const d = markSvelteSource(`<script>let { a } = $props()</script>\n<p>hi</p>`, 'd.svelte', s)!
    expect(d.code).toContain(`let { 'data-fsi': __fsi, 'data-fsc': __fsc, a } = $props()`)
  })

  it('chains usage outermost-first through a component that is a top element', async () => {
    const r = markSvelteSource(`<script>let { x } = $props()</script>\n<Inner/>`, 'src/Outer.svelte', await svelte5())!
    expect(r.code).toContain('<Inner data-fsi="Inner|src/Outer.svelte:2:1" data-fsc={[__fsc, __fsi]')
  })

  it('leaves svelte:head/window/options and everything in head alone', async () => {
    const src = `<svelte:head><title>x</title><meta name="a"></svelte:head>\n<svelte:window onkeydown={() => 1} />\n<div>a</div>`
    const r = markSvelteSource(src, 'a.svelte', await svelte5())!
    expect(r.code).not.toContain('<title data-fs')
    expect(r.code).not.toContain('<meta data-fs')
    expect(r.code).not.toContain('svelte:window data-fs')
    expect(r.code).toContain('<div data-fs="a.svelte:3:1"')
  })

  it('marks elements inside blocks, and is idempotent', async () => {
    const s = await svelte5()
    const src = `{#if a}\n  <p>x</p>\n{:else}\n  <b>y</b>\n{/if}\n{#each xs as x}<i>{x}</i>{/each}`
    const r = markSvelteSource(src, 'a.svelte', s)!
    expect(r.marks.fs).toBe(3)
    expect(markSvelteSource(r.code, 'a.svelte', s)).toBeNull()
  })

  it('gives no marks to an unparsable file', async () => {
    expect(markSvelteSource('<div><span>', 'a.svelte', await svelte5())).toBeNull()
    expect(markSvelteSource('<div class="a" {', 'a.svelte', await svelte5())).toBeNull()
  })

  it('escapes braces in paths and produces a sourcemap', async () => {
    const r = markSvelteSource('<p>x</p>', 'src/routes/{x}/+page.svelte', await svelte5())!
    expect(r.code).toContain('&#123;x&#125;')
    expect(r.map.mappings.length).toBeGreaterThan(0)
  })

  it('compiles to valid Svelte 5 output', async () => {
    const compiler = (await import('svelte/compiler')) as any
    for (const [src, f] of [[PAGE, 'p.svelte'], [FAQ, 'f.svelte']] as const) {
      const r = markSvelteSource(src, f, await svelte5())!
      const out = compiler.compile(r.code, { filename: f, generate: 'client' })
      expect(out.js.code).toContain('data-fs')
      compiler.compile(r.code, { filename: f, generate: 'server' })
    }
  })
})

describe('mark plugin transform (Svelte 4)', () => {
  it('marks via the legacy AST and compiles with svelte 4', async () => {
    const s4 = await svelte4()
    const src = `<script>\n  import Faq from './Faq.svelte'\n  export let title\n</script>\n<main>\n  <h1>{title}</h1>\n  <Faq/>\n</main>`
    const r = markSvelteSource(src, 'src/App.svelte', s4)!
    expect(r.code).toContain('<main data-fs="src/App.svelte:5:1" data-fsu={[$$props')
    expect(r.code).toContain('<h1 data-fs="src/App.svelte:6:3">')
    expect(r.code).toContain('<Faq data-fsi="Faq|src/App.svelte:7:3"')
    ;(s4 as any).compile(r.code, { filename: 'App.svelte' })
  })
  it('no marks on unparsable', async () => {
    expect(markSvelteSource('<div>{', 'a.svelte', await svelte4())).toBeNull()
  })
})

describe('usage chain on passed content and snippets', () => {
  it('stamps data-fsu on roots of component children and snippet bodies', async () => {
    const src = `<script>\n  import Card from './Card.svelte'\n  let { x } = $props()\n</script>\n<Card>\n  <h2>in slot <b>deep</b></h2>\n</Card>\n{#snippet row(i)}\n  <li>{i}</li>\n{/snippet}\n`
    const r = markSvelteSource(src, 'src/A.svelte', await svelte5())!
    expect(r.code).toMatch(/<h2 data-fs="src\/A.svelte:6:3" data-fsu=\{/)
    expect(r.code).toMatch(/<li data-fs="src\/A.svelte:9:3" data-fsu=\{/)
    expect(r.code).toContain('<b data-fs="src/A.svelte:6:15">') // nested: no chain
    expect(r.code).toMatch(/<Card data-fsi="Card\|src\/A.svelte:5:1" data-fsc=\{/)
    const compiler = (await import('svelte/compiler')) as any
    compiler.compile(r.code, { filename: 'A.svelte' })
  })
})

describe('Svelte 4 with lang="ts"', () => {
  it('marks despite TypeScript in the script (blanked before parsing, offsets intact)', async () => {
    const s4 = await svelte4()
    const src = `<script lang="ts">\n  export let title: string = 'x'\n  const f = (a: number): string => String(a)\n</script>\n\n<section>\n  <h2>{title}</h2>\n</section>\n`
    const r = markSvelteSource(src, 'src/T.svelte', s4)!
    expect(r.code).toContain('<section data-fs="src/T.svelte:6:1" data-fsu={[$$props')
    expect(r.code).toContain('<h2 data-fs="src/T.svelte:7:3">')
    expect(r.code).toContain(`export let title: string = 'x'`) // script left byte-for-byte
  })
})
