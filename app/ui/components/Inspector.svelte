<script lang="ts">
  import { ed, doEdit, componentEdit, selectNeighbour, selectUsage, status, tokens } from '../lib/surface.svelte.ts'
  import { openSelectionInCode } from '../lib/code.svelte.ts'
  import type { SvelteEdit } from '../lib/types.ts'

  const i = $derived(ed.insp)
  const s = $derived(ed.sel)

  /* a refresh (HMR, file watcher) must never clobber what the user is typing:
     a field that is dirty or focused keeps its value unless the selection changed */
  let text = $state('')
  let classes = $state('')
  let textDirty = false
  let classesDirty = false
  let textEl: HTMLInputElement | undefined = $state()
  let classesEl: HTMLInputElement | undefined = $state()
  let renderedFor = ''
  $effect(() => {
    if (!s || !i) return
    const key = s.fs ?? ''
    const force = renderedFor !== key
    renderedFor = key
    if (force || !(textDirty || document.activeElement === textEl)) { text = i.text ?? ''; textDirty = false }
    if (force || !(classesDirty || document.activeElement === classesEl)) { classes = i.classes ?? ''; classesDirty = false }
  })

  let stateName = $state('hover')
  let stateClasses = $state('')
  let attrName = $state('')
  let attrValue = $state('')
  let attrValues = $state<Record<string, string>>({})
  $effect(() => {
    // per-attribute inputs follow the inspection
    const next: Record<string, string> = {}
    for (const a of i?.attrs ?? []) next[a.name] = a.value ?? ''
    attrValues = next
  })
  const STYLE_FIELDS: [string, string, string][] = [
    ['width', 'width', '240px'], ['height', 'height', '3rem'], ['rotate', 'rotate', '5deg'], ['opacity', 'opacity', '0.8'],
    ['background-color', 'background', '#fde68a'], ['border-radius', 'radius', '12px'], ['padding', 'padding', '16px'], ['margin', 'margin', '8px']
  ]
  let styleVals = $state<Record<string, string>>({})
  let varName = $state('variant')
  let varDefault = $state('primary')
  let varValue = $state('')
  let varClasses = $state('')
  let markup = $state('<p class="mt-2">New paragraph</p>')
  let pos = $state<'after' | 'before' | 'append' | 'prepend'>('after')

  const propOp = (): 'setProp' | 'setAttr' => (i?.kind === 'component' ? 'setProp' : 'setAttr')
  const attrEdit = (name: string, value: string | boolean | null): SvelteEdit => ({ op: propOp(), name, value }) as SvelteEdit

  function applyStyle(): void {
    const props: Record<string, string> = {}
    for (const [k, v] of Object.entries(styleVals)) if (v.trim()) props[k] = v.trim()
    if (!Object.keys(props).length) return status('Fill at least one style field', 'err')
    void doEdit({ op: 'patchStyle', props, mode: (ed.styleMode || (ed.info?.hasTailwind ? 'auto' : 'inline')) as 'auto' } as SvelteEdit)
  }
  function addVariantProp(): void {
    void componentEdit({ op: 'addVariantProp', name: varName.trim() || 'variant', default: varDefault.trim() || 'primary' })
  }
  function addVariantClasses(): void {
    const value = varValue.trim()
    if (!value) return status('Give the variant value, e.g. primary', 'err')
    void doEdit({ op: 'setVariantClasses', prop: varName.trim() || 'variant', value, add: tokens(varClasses) } as SvelteEdit)
  }
  const stateEdit = (kind: 'add' | 'remove') => (): void => void doEdit({ op: 'setStateClasses', state: stateName, [kind]: tokens(stateClasses) } as SvelteEdit)
</script>

<div id="empty" class="dim" hidden={!!(s && i)}>Click an element in the canvas (or a layer) to edit it. Drag the handles to resize / rotate.</div>
<div id="sel" hidden={!(s && i)}>
  {#if s && i}
    <h2 id="selTitle">{(s.component && i.kind === 'element' ? `${s.component} › ` : '') + `<${i.name}>`}</h2>
    <div id="selRef" class="ref" style="white-space: pre">{`${s.file}:${i.line}:${i.col}` + (s.fsi ? `\nused at ${s.fsi.split('|')[1]}` : '')}</div>
    <div class="row">
      <button id="selParent" disabled={!i.parent} onclick={() => selectNeighbour('parent')}>↑ Parent</button>
      <button id="selPrev" disabled={!i.prev} onclick={() => selectNeighbour('prev')}>← Prev</button>
      <button id="selNext" disabled={!i.next} onclick={() => selectNeighbour('next')}>Next →</button>
      <button id="selUsage" hidden={!s.fsi} onclick={selectUsage}>Go to usage</button>
      <button id="selOpenCode" title="Open this element's file beside the preview" onclick={openSelectionInCode}>Open code</button>
    </div>

    <h3>Text</h3>
    <div class="row">
      <input id="p-text" bind:this={textEl} bind:value={text} oninput={() => (textDirty = true)} disabled={i.text === null} />
      <button id="p-text-apply" disabled={i.text === null} onclick={() => { textDirty = false; void doEdit({ op: 'setText', text, expect: i.text ?? undefined } as SvelteEdit) }}>Apply</button>
    </div>
    <div id="p-text-note" class="note">{i.textLocked ? 'Holds an {expression} or markup: refused. Select the text element inside, or edit it where it is defined.' : i.kind !== 'element' ? 'Component instance: edit its props below.' : ''}</div>

    <h3>Classes</h3>
    <div class="row">
      <input id="p-classes" placeholder="static classes" bind:this={classesEl} bind:value={classes} oninput={() => (classesDirty = true)} disabled={i.classesLocked} />
      <button id="p-classes-apply" disabled={i.classesLocked} onclick={() => { classesDirty = false; void doEdit({ op: 'setClasses', set: classes } as SvelteEdit) }}>Apply</button>
    </div>
    <div id="p-classes-note" class="note">{i.classesLocked ? 'class={expression}: comes from a variable, refused.' : i.classesDynamic ? 'Mixed class: only the written part is edited, {expressions} stay.' : ''}</div>
    <div class="row">
      <select id="p-state" bind:value={stateName}><option>hover</option><option>active</option><option>focus-visible</option><option>focus</option></select>
      <input id="p-state-classes" placeholder="bg-blue-600 shadow" bind:value={stateClasses} />
      <button id="p-state-add" onclick={stateEdit('add')}>+</button><button id="p-state-rm" onclick={stateEdit('remove')}>−</button>
    </div>

    <h3>Attributes</h3>
    <div id="p-attrs">
      {#each i.attrs.filter((x) => x.name !== 'class') as a (a.name)}
        <div class="row attr">
          <span>{a.name}</span>
          <input bind:value={attrValues[a.name]} disabled={a.dynamic} title={a.dynamic ? 'expression: read-only' : ''} />
          <button onclick={() => doEdit(attrEdit(a.name, (attrValues[a.name] ?? '') === '' && a.value === null ? true : (attrValues[a.name] ?? '')))}>Save</button>
          <button onclick={() => doEdit(attrEdit(a.name, null))}>×</button>
        </div>
      {/each}
    </div>
    <div class="row">
      <input id="p-attr-name" placeholder="name" size="8" bind:value={attrName} />
      <input id="p-attr-value" placeholder="value" bind:value={attrValue} />
      <button id="p-attr-add" onclick={() => { const n = attrName.trim(); if (n) void doEdit(attrEdit(n, attrValue === '' ? true : attrValue)) }}>Set</button>
    </div>

    <h3>Style <span class="dim">(resize handles write here too)</span></h3>
    <div class="grid" id="p-style">
      {#each STYLE_FIELDS as [prop, label, ph] (prop)}
        <label>{label}<input data-style={prop} placeholder={ph} bind:value={styleVals[prop]} /></label>
      {/each}
    </div>
    <div class="row">
      <select id="p-style-mode" bind:value={ed.styleMode}><option value="">auto (Tailwind if present)</option><option value="inline">inline style</option><option value="tailwind">Tailwind classes</option></select>
      <button id="p-style-apply" onclick={applyStyle}>Apply style</button>
    </div>

    <h3>Component variants <span class="dim" id="p-var-file">{ed.variants.file}</span></h3>
    <div id="p-variants" class="note variants">{ed.variants.text}</div>
    <div class="row">
      <input id="p-var-name" size="8" bind:value={varName} /><input id="p-var-default" size="8" bind:value={varDefault} />
      <button id="p-var-add" onclick={addVariantProp}>Add variant prop</button>
    </div>
    <div class="row">
      <input id="p-var-value" placeholder="value, e.g. primary" bind:value={varValue} />
      <input id="p-var-classes" placeholder="bg-blue-600 text-white" bind:value={varClasses} />
      <button id="p-var-classes-add" onclick={addVariantClasses}>+ classes</button>
    </div>

    <h3>Structure</h3>
    <textarea id="p-markup" rows="2" bind:value={markup}></textarea>
    <div class="row">
      <select id="p-pos" bind:value={pos}><option value="after">after</option><option value="before">before</option><option value="append">inside (end)</option><option value="prepend">inside (start)</option></select>
      <button id="p-insert" onclick={() => doEdit({ op: 'insert', markup, position: pos } as SvelteEdit, { clear: true })}>Insert</button>
      <button id="p-dup" onclick={() => doEdit({ op: 'duplicate' } as SvelteEdit, { clear: true })}>Duplicate</button>
      <button id="p-remove" class="danger" onclick={() => doEdit({ op: 'remove' } as SvelteEdit, { clear: true })}>Remove</button>
    </div>
    <div class="row">
      <button id="p-up" onclick={() => (i.prev ? doEdit({ op: 'move', to: i.prev, position: 'before' } as SvelteEdit, { clear: true }) : status('Already first', 'err'))}>Move up</button>
      <button id="p-down" onclick={() => (i.next ? doEdit({ op: 'move', to: i.next, position: 'after' } as SvelteEdit, { clear: true }) : status('Already last', 'err'))}>Move down</button>
    </div>
  {/if}
</div>

<style>
  .attr span { width: 70px; font: var(--font-size-tiny) var(--font-mono); line-height: 26px; overflow: hidden }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2) }
  .grid label { font-size: var(--font-size-tiny); color: var(--color-text-muted) }
  .grid input { width: 100%; display: block }
  .variants { color: #374151 }
</style>
