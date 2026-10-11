<script lang="ts">
  import { ed, selectRef, createPage } from '../lib/surface.svelte.ts'
  import type { Layer } from '../lib/types.ts'

  let route = $state('')
  interface Flat { layer: Layer }
  const flat = $derived.by(() => {
    const out: Flat[] = []
    const walk = (ls: Layer[]): void => { for (const l of ls) { out.push({ layer: l }); if (l.children) walk(l.children) } }
    walk(ed.layers)
    return out
  })
</script>

<h3>Layers</h3>
<div id="layers" class="layers">
  {#each flat as { layer: l }, i (i)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div style:padding-left="{4 + l.depth * 10}px" class:sel={ed.sel && l.ref.fs === ed.sel.fs} title={l.ref.fs} onclick={() => selectRef(l.ref, true)}>
      {l.name + (l.ref.text && !l.children?.length ? ' · ' + l.ref.text.slice(0, 18) : '')}
    </div>
  {/each}
</div>
<h3>New page</h3>
<div class="row">
  <input id="newPageRoute" placeholder="/pricing/team" bind:value={route} />
  <button id="newPageBtn" onclick={() => createPage(route.trim())}>Create</button>
</div>
<h3>Changes</h3>
<ol id="history" class="history">
  {#each ed.history.undo as e, i (i)}
    <li>{`${e.label} (${e.file.split('/').pop()})`}</li>
  {/each}
</ol>

<style>
  .layers { font-size: var(--font-size-small); max-height: 40vh; overflow: auto }
  .layers div { padding: 1px var(--space-2); cursor: pointer; white-space: nowrap; border-radius: var(--radius-sm) }
  .layers div:hover { background: var(--color-accent-soft) }
  .layers div.sel { background: var(--color-accent-soft-strong) }
  .history { padding-left: 18px; font-size: var(--font-size-tiny); color: var(--color-text-soft); max-height: 25vh; overflow: auto }
</style>
