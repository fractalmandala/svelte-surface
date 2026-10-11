import { describe, expect, it } from 'vitest'
import { applyComponentEdit, applyEdit, listProps, listStates, listVariants, parseDeclarations, parseOrThrow, type SvelteEdit } from '../src/edit/index.js'
import { at, svelte4, svelte5 } from './helpers.js'

const BTN = `<script>
  let { label = 'Go' } = $props()
</script>

<button class="rounded px-4 py-2">
  {label}
</button>
`

async function run(src: string, needle: string, edit: SvelteEdit) {
  return applyEdit(src, await svelte5(), at(src, needle), edit)
}

describe('style patches (resize / rotate gestures → source)', () => {
  it('parses declarations with parens and quotes', () => {
    expect(parseDeclarations(`a: 1px; background: url("x;y.png") no-repeat;color:red`)).toEqual([
      ['a', '1px'], ['background', 'url("x;y.png") no-repeat'], ['color', 'red']
    ])
  })
  it('writes Tailwind arbitrary classes when it can, replacing the family', async () => {
    const src = '<div class="w-4 hover:w-8 flex">x</div>\n'
    const r = await run(src, '<div', { op: 'patchStyle', props: { width: '120px', height: '3rem', rotate: '15deg' } })
    expect(r.code).toBe('<div class="hover:w-8 flex w-[120px] h-[3rem] rotate-[15deg]">x</div>\n')
    expect(r.label).toBe('Changed width, height, rotate of <div>')
  })
  it('falls back to the inline style attribute, merging declarations', async () => {
    const src = '<div style="color: red; width: 1px">x</div>\n'
    const r = await run(src, '<div', { op: 'patchStyle', props: { width: '9px', 'z-index': '3' }, mode: 'inline' })
    expect(r.code).toBe('<div style="color: red; width: 9px; z-index: 3">x</div>\n')
    const none = await run('<p>x</p>', '<p', { op: 'patchStyle', props: { transform: 'scale(2)' } })
    expect(none.code).toBe('<p style="transform: scale(2)">x</p>')
    const rm = await run(r.code, '<div', { op: 'patchStyle', props: { width: null, 'z-index': null, color: null }, mode: 'inline' })
    expect(rm.code).toBe('<div>x</div>\n')
  })
  it('refuses dynamic style, and tailwind mode refuses unmapped props', async () => {
    await expect(run('<p style={s}>x</p>', '<p', { op: 'patchStyle', props: { top: '1px' } })).rejects.toThrow(/variable/)
    await expect(run('<p>x</p>', '<p', { op: 'patchStyle', props: { top: '1px' }, mode: 'tailwind' })).rejects.toThrow(/No Tailwind/)
  })
  it('mixed dynamic class: static part edited, expression kept', async () => {
    const r = await run(`<p class="w-2 {x}">a</p>`, '<p', { op: 'patchStyle', props: { width: '50%' } })
    expect(r.code).toBe(`<p class="w-[50%] {x}">a</p>`)
  })
})

describe('state and variant classes', () => {
  it('writes hover:/active:/focus-visible: classes and removes only those', async () => {
    let r = await run(BTN, '<button', { op: 'setStateClasses', state: 'hover', add: ['bg-blue-600', 'shadow'] })
    expect(r.code).toContain('class="rounded px-4 py-2 hover:bg-blue-600 hover:shadow"')
    r = await run(r.code, '<button', { op: 'setStateClasses', state: 'hover', remove: ['shadow'] })
    expect(r.code).toContain('class="rounded px-4 py-2 hover:bg-blue-600"')
    r = await run(r.code, '<button', { op: 'setStateClasses', state: 'focus-visible', add: ['ring-2'] })
    expect(listStates(r.code, await svelte5())).toEqual([
      { line: 5, col: 1, tag: 'button', states: { hover: ['bg-blue-600'], 'focus-visible': ['ring-2'] } }
    ])
  })
  it('writes classes for one variant value', async () => {
    const r = await run(BTN, '<button', { op: 'setVariantClasses', value: 'primary', add: ['bg-blue-600', 'text-white'] })
    expect(r.code).toContain('data-[variant=primary]:bg-blue-600 data-[variant=primary]:text-white')
  })
})

describe('component variants (Svelte 5 runes)', () => {
  it('adds the prop, data-variant and group/variant, and compiles', async () => {
    const s = await svelte5()
    const r = applyComponentEdit(BTN, s, { op: 'addVariantProp', default: 'primary' })
    expect(r.code).toContain(`let { label = 'Go', variant = 'primary' } = $props()`)
    expect(r.code).toMatch(/<button class="rounded px-4 py-2 group\/variant" data-variant=\{variant\}>|<button data-variant=\{variant\} class="rounded px-4 py-2 group\/variant">/)
    expect(r.code).toContain(`variant = 'primary'`)
    expect(r.code).toContain('group/variant')
    expect(r.code).toContain('data-variant={variant}')
    ;((await import('svelte/compiler')) as any).compile(r.code, { filename: 'B.svelte' })
    expect(listProps(r.code, s).map((p) => p.name)).toEqual(['label', 'variant'])
    // author classes for each value, then read them back
    let code = r.code
    code = (await run(code, '<button', { op: 'setVariantClasses', value: 'primary', add: ['bg-blue-600'] })).code
    code = (await run(code, '<button', { op: 'setVariantClasses', value: 'ghost', add: ['bg-transparent'] })).code
    expect(listVariants(code, s)).toEqual([{ name: 'variant', default: 'primary', options: ['primary', 'ghost'] }])
    // idempotent
    expect(applyComponentEdit(code, s, { op: 'addVariantProp', default: 'primary' }).changed).toBe(false)
  })
  it('changes the default and removes the variant again', async () => {
    const s = await svelte5()
    const added = applyComponentEdit(BTN, s, { op: 'addVariantProp', default: 'primary' }).code
    const d = applyComponentEdit(added, s, { op: 'setVariantDefault', default: 'ghost' })
    expect(d.code).toContain(`variant = 'ghost'`)
    const gone = applyComponentEdit(added, s, { op: 'removeVariantProp' })
    expect(gone.code).toBe(BTN)
  })
  it('creates a $props() declaration (and a <script>) when there is none; types it in TS', async () => {
    const s = await svelte5()
    const r = applyComponentEdit('<p class="x">hi</p>\n', s, { op: 'addVariantProp', default: 'a', options: ['a', 'b'] })
    expect(r.code).toMatch(/^<script>\n  let \{ variant = 'a' \} = \$props\(\)\n<\/script>/)
    const ts = `<script lang="ts">\n  interface Props {\n    label?: string\n  }\n  let { label = 'x' }: Props = $props()\n</script>\n<b>{label}</b>\n`
    const t = applyComponentEdit(ts, s, { op: 'addVariantProp', default: 'a', options: ['a', 'b'] })
    expect(t.code).toContain(`label?: string\n    variant?: 'a' | 'b'`)
    expect(t.code).toContain(`let { label = 'x', variant = 'a' }: Props = $props()`)
  })
  it('refuses a component with no top-level element', async () => {
    const s = await svelte5()
    expect(() => applyComponentEdit('<script>let a = 1</script>\n<Foo />', s, { op: 'addVariantProp', default: 'a' })).toThrow(/no top-level element/)
  })
})

describe('component variants (legacy export let; Svelte 4; Svelte 4 + TS)', () => {
  it('Svelte 4 legacy', async () => {
    const s4 = await svelte4()
    const src = `<script>\n  import X from './X.svelte'\n  export let label = 'Go'\n</script>\n<button>{label}</button>\n`
    const r = applyComponentEdit(src, s4, { op: 'addVariantProp', default: 'primary' })
    expect(r.code).toContain(`export let label = 'Go'\n  export let variant = 'primary'`)
    expect(r.code).toContain('<button data-variant={variant} class="group/variant">')
    ;(s4 as any).compile(r.code, { filename: 'B.svelte' })
    expect(applyComponentEdit(r.code, s4, { op: 'setVariantDefault', default: 'ghost' }).code).toContain(`export let variant = 'ghost'`)
    expect(applyComponentEdit(r.code, s4, { op: 'removeVariantProp' }).code).toBe(src)
  })
  it('Svelte 4 with lang="ts"', async () => {
    const s4 = await svelte4()
    const src = `<script lang="ts">\n  export let label: string = 'Go'\n</script>\n<button>{label}</button>\n`
    const r = applyComponentEdit(src, s4, { op: 'addVariantProp', default: 'primary', options: ['primary', 'ghost'] })
    expect(r.code).toContain(`export let variant: 'primary' | 'ghost' = 'primary'`)
    expect(listProps(r.code, s4)).toEqual([
      { name: 'label', required: false, default: "'Go'" },
      { name: 'variant', required: false, default: "'primary'" }
    ])
    const d = applyComponentEdit(r.code, s4, { op: 'setVariantDefault', default: 'ghost' })
    expect(d.code).toContain(`= 'ghost'`)
    expect(listVariants(d.code, s4)).toMatchObject([{ name: 'variant', default: 'ghost' }])
    parseOrThrow(d.code, s4)
  })
})
