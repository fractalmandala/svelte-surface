import { describe, expect, it } from 'vitest'
import { applyEdit, findAt, listProps, parseOrThrow, EditError, type SvelteEdit } from '../src/edit/index.js'
import { at, svelte4, svelte5 } from './helpers.js'

const SRC = `<script>
  import Card from './Card.svelte'
  let name = 'x'
</script>

<main class="mx-auto max-w-3xl">
  <!-- the heading -->
  <h1 class="text-5xl font-semibold">Selected work</h1>
  <p>
    Hello
  </p>
  <img src="/a.png" alt="a">
  <a href="/x" class="link {name ? 'on' : ''}">go</a>
  <b class={name}>dyn</b>
  <i>{name}</i>
  <Card title="Questions" />
</main>
`

async function run(src: string, needle: string, edit: SvelteEdit, n = 0) {
  return applyEdit(src, await svelte5(), at(src, needle, n), edit)
}

describe('findAt', () => {
  it('maps (line,col) of a mark to the AST node starting there', async () => {
    const doc = parseOrThrow(SRC, await svelte5())
    const p = at(SRC, '<h1')
    expect(findAt(doc, p.line, p.col)?.name).toBe('h1')
    expect(findAt(doc, p.line, p.col + 1)).toBeNull()
    const c = at(SRC, '<Card')
    expect(findAt(doc, c.line, c.col)?.kind).toBe('component')
  })
})

describe('setText', () => {
  it('replaces only the text range', async () => {
    const r = await run(SRC, '<h1', { op: 'setText', text: 'New title' })
    expect(r.code).toBe(SRC.replace('Selected work', 'New title'))
  })
  it('preserves surrounding whitespace', async () => {
    const r = await run(SRC, '<p>', { op: 'setText', text: 'Bye' })
    expect(r.code).toContain('<p>\n    Bye\n  </p>')
  })
  it('re-encodes { } < &', async () => {
    const r = await run(SRC, '<h1', { op: 'setText', text: 'a {b} <c> & d' })
    expect(r.code).toContain('>a &#123;b&#125; &lt;c> &amp; d</h1>')
    // round trip: parses back to the same text
    const doc = parseOrThrow(r.code, await svelte5())
    const h1 = doc.nodes.find((n) => n.name === 'h1')!
    expect(h1.children[0]!.data).toBe('a {b} <c> & d')
  })
  it('refuses {expr} text with a "variable" error', async () => {
    const s = await svelte5()
    const p = at(SRC, '<i>')
    try {
      applyEdit(SRC, s, p, { op: 'setText', text: 'z' })
      throw new Error('should refuse')
    } catch (e) {
      expect(e).toBeInstanceOf(EditError)
      expect((e as EditError).code).toBe('dynamic')
      expect((e as EditError).message).toMatch(/variable/)
    }
  })
  it('detects a stale preview via expect', async () => {
    const s = await svelte5()
    expect(() => applyEdit(SRC, s, at(SRC, '<h1'), { op: 'setText', text: 'z', expect: 'Other' })).toThrow(/doesn't match the preview/)
  })
  it('is a no-op when unchanged', async () => {
    const r = await run(SRC, '<h1', { op: 'setText', text: 'Selected work' })
    expect(r.changed).toBe(false)
  })
})

describe('setClasses', () => {
  it('swaps one class and touches nothing else', async () => {
    const r = await run(SRC, '<h1', { op: 'setClasses', add: ['text-6xl'], remove: ['text-5xl'] })
    expect(r.code).toBe(SRC.replace('text-5xl font-semibold', 'font-semibold text-6xl'))
  })
  it('set replaces the whole static list', async () => {
    const r = await run(SRC, '<h1', { op: 'setClasses', set: 'a b' })
    expect(r.code).toContain('<h1 class="a b">')
  })
  it('edits only static parts of a mixed class, leaving {expr}', async () => {
    const r = await run(SRC, '<a ', { op: 'setClasses', add: ['hot'], remove: ['link'] })
    expect(r.code).toContain(`<a href="/x" class="hot {name ? 'on' : ''}">`)
  })
  it('refuses a fully dynamic class', async () => {
    const s = await svelte5()
    expect(() => applyEdit(SRC, s, at(SRC, '<b '), { op: 'setClasses', add: ['x'] })).toThrow(/variable/)
  })
  it('adds a class attribute when there is none; removes it when emptied', async () => {
    const r = await run(SRC, '<p>', { op: 'setClasses', add: ['mt-4'] })
    expect(r.code).toContain('<p class="mt-4">')
    const r2 = await run(r.code, '<p ', { op: 'setClasses', remove: ['mt-4'] })
    expect(r2.code).toBe(SRC)
  })
  it('rejects invalid tokens', async () => {
    await expect(run(SRC, '<h1', { op: 'setClasses', add: ['a"b'] })).rejects.toThrow(/not a valid class/)
  })
})

describe('attributes, tags, props', () => {
  it('sets, adds, removes attributes', async () => {
    let r = await run(SRC, '<img', { op: 'setAttr', name: 'alt', value: 'A "pic"' })
    expect(r.code).toContain('alt="A &quot;pic&quot;"')
    r = await run(SRC, '<img', { op: 'setAttr', name: 'loading', value: 'lazy' })
    expect(r.code).toContain('<img src="/a.png" alt="a" loading="lazy">')
    r = await run(SRC, '<img', { op: 'setAttr', name: 'alt', value: null })
    expect(r.code).toContain('<img src="/a.png">')
  })
  it('refuses to overwrite a dynamic attribute with text, allows an explicit expression', async () => {
    const s = await svelte5()
    expect(() => applyEdit(SRC, s, at(SRC, '<b '), { op: 'setAttr', name: 'title', value: 'z' })).not.toThrow() // new attr
    const dyn = '<p title={t}>x</p>'
    expect(() => applyEdit(dyn, s, { line: 1, col: 1 }, { op: 'setAttr', name: 'title', value: 'z' })).toThrow(/variable/)
    expect(applyEdit(dyn, s, { line: 1, col: 1 }, { op: 'setAttr', name: 'title', value: { expr: 'u' } }).code).toBe('<p title={u}>x</p>')
  })
  it('renames a tag, open and close', async () => {
    const r = await run(SRC, '<h1', { op: 'setTag', tag: 'h2' })
    expect(r.code).toContain('<h2 class="text-5xl font-semibold">Selected work</h2>')
  })
  it('sets component props (string, expression, boolean) and removes them', async () => {
    let r = await run(SRC, '<Card', { op: 'setProp', name: 'title', value: 'Hi' })
    expect(r.code).toContain('<Card title="Hi" />')
    r = await run(SRC, '<Card', { op: 'setProp', name: 'count', value: { expr: '5' } })
    expect(r.code).toContain('<Card title="Questions" count={5} />')
    r = await run(SRC, '<Card', { op: 'setProp', name: 'open', value: true })
    expect(r.code).toContain('<Card title="Questions" open />')
    r = await run(SRC, '<Card', { op: 'setProp', name: 'title', value: null })
    expect(r.code).toContain('<Card />')
  })
  it('lists declared props', async () => {
    const s = await svelte5()
    expect(listProps(`<script>let { title, count = 3, ...rest } = $props()</script>`, s)).toEqual([
      { name: 'title', required: true },
      { name: 'count', required: false, default: '3' },
      { name: 'rest', required: false, rest: true }
    ])
    expect(listProps(`<script>export let a; export let b = 'x'</script>`, s)).toEqual([
      { name: 'a', required: true },
      { name: 'b', required: false, default: "'x'" }
    ])
  })
})

describe('structure', () => {
  it('inserts before/after/prepend/append with indentation', async () => {
    const r1 = await run(SRC, '<h1', { op: 'insert', markup: '<hr>', position: 'before' })
    expect(r1.code).toContain('  <hr>\n  <h1')
    const r2 = await run(SRC, '<h1', { op: 'insert', markup: '<hr>', position: 'after' })
    expect(r2.code).toContain('</h1>\n  <hr>\n  <p>')
    const r3 = await run(SRC, '<main', { op: 'insert', markup: '<nav>x</nav>', position: 'prepend' })
    expect(r3.code).toContain('<main class="mx-auto max-w-3xl">\n  <nav>x</nav>\n  <!-- the heading -->')
    const r4 = await run(SRC, '<main', { op: 'insert', markup: '<footer>f</footer>', position: 'append' })
    expect(r4.code).toContain('<Card title="Questions" />\n  <footer>f</footer>\n</main>')
  })
  it('adds the import the markup needs', async () => {
    const r = await run(SRC, '<h1', { op: 'insert', markup: '<Btn />', position: 'after', imports: ["Btn from './Btn.svelte'"] })
    expect(r.code).toContain("import Card from './Card.svelte'\n  import Btn from './Btn.svelte'")
    const bare = await run('<p>x</p>\n', '<p', { op: 'insert', markup: '<Btn />', position: 'after', imports: ["Btn from './Btn.svelte'"] })
    expect(bare.code).toContain('<script>\n  import Btn from')
  })
  it('refuses markup that would not parse, writing nothing', async () => {
    await expect(run(SRC, '<h1', { op: 'insert', markup: '<div>', position: 'after' })).rejects.toThrow(/wouldn't parse|would not parse/)
  })
  it('duplicates', async () => {
    const r = await run(SRC, '<h1', { op: 'duplicate' })
    expect(r.code.match(/<h1/g)!.length).toBe(2)
  })
  it('removes an element, taking the comment above it', async () => {
    const r = await run(SRC, '<h1', { op: 'remove' })
    expect(r.code).not.toContain('<h1')
    expect(r.code).not.toContain('the heading')
    expect(r.code).toContain('<main class="mx-auto max-w-3xl">\n  <p>')
  })
  it('moves an element (comment travels) and refuses moving into itself', async () => {
    const s = await svelte5()
    const to = at(SRC, '<Card')
    const r = applyEdit(SRC, s, at(SRC, '<h1'), { op: 'move', to, position: 'after' })
    expect(r.code.indexOf('<Card')).toBeLessThan(r.code.indexOf('<h1'))
    expect(r.code.indexOf('the heading')).toBeGreaterThan(r.code.indexOf('<Card'))
    expect(r.code.indexOf('the heading')).toBeLessThan(r.code.indexOf('<h1'))
    parseOrThrow(r.code, s)
    const main = at(SRC, '<main')
    expect(() => applyEdit(SRC, s, main, { op: 'move', to: at(SRC, '<h1'), position: 'after' })).toThrow(/itself/)
  })
  it('moves up before a sibling', async () => {
    const s = await svelte5()
    const r = applyEdit(SRC, s, at(SRC, '<Card'), { op: 'move', to: at(SRC, '<h1'), position: 'before' })
    expect(r.code.indexOf('<Card')).toBeLessThan(r.code.indexOf('<h1'))
    parseOrThrow(r.code, s)
  })
  it('leaves svelte:* elements alone', async () => {
    const s = await svelte5()
    const src = '<svelte:head><title>x</title></svelte:head>\n<p>a</p>'
    expect(() => applyEdit(src, s, { line: 1, col: 1 }, { op: 'setAttr', name: 'a', value: 'b' })).toThrow(/left alone/)
  })
  it('says what happened when the file changed under it', async () => {
    const s = await svelte5()
    expect(() => applyEdit(SRC, s, { line: 99, col: 1 }, { op: 'remove' })).toThrow(/changed since the preview/)
    expect(() => applyEdit('<div', s, { line: 1, col: 1 }, { op: 'remove' })).toThrow(EditError)
  })
})

describe('Svelte 4 compiler', () => {
  it('edits text/classes through the legacy AST', async () => {
    const s4 = await svelte4()
    const src = '<script>\n  export let t\n</script>\n<div class="a b {t}">\n  <h1>Hello</h1>\n</div>\n'
    let r = applyEdit(src, s4, at(src, '<h1'), { op: 'setText', text: 'Bye' })
    expect(r.code).toContain('<h1>Bye</h1>')
    r = applyEdit(src, s4, at(src, '<div'), { op: 'setClasses', add: ['c'], remove: ['a'] })
    expect(r.code).toContain('<div class="b c {t}">')
    r = applyEdit(src, s4, at(src, '<h1'), { op: 'remove' })
    expect(r.code).not.toContain('<h1')
  })
})

describe('inspectAt (panel data)', () => {
  it('reports classes, attrs, text, siblings and locks', async () => {
    const { inspectAt } = await import('../src/edit/index.js')
    const s = await svelte5()
    const h1 = inspectAt(SRC, s, at(SRC, '<h1'))
    expect(h1).toMatchObject({ name: 'h1', classes: 'text-5xl font-semibold', text: 'Selected work', textLocked: false, kind: 'element' })
    expect(h1.prev).toBeNull()
    expect(h1.next).toEqual(at(SRC, '<p>'))
    expect(h1.parent).toEqual(at(SRC, '<main'))
    const a = inspectAt(SRC, s, at(SRC, '<a '))
    expect(a).toMatchObject({ classes: 'link', classesDynamic: true, classesLocked: false })
    expect(a.attrs).toEqual([{ name: 'href', value: '/x', dynamic: false }, { name: 'class', value: "link {name ? 'on' : ''}", dynamic: true }])
    expect(inspectAt(SRC, s, at(SRC, '<b ')).classesLocked).toBe(true)
    expect(inspectAt(SRC, s, at(SRC, '<i>'))).toMatchObject({ text: null, textLocked: true })
    expect(inspectAt(SRC, s, at(SRC, '<Card'))).toMatchObject({ kind: 'component', name: 'Card', canHaveChildren: false })
    expect(() => inspectAt(SRC, s, { line: 1, col: 1 })).toThrow(/No element/)
  })
})
