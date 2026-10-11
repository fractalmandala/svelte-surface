<script lang="ts">
  import { browser, KIND, closeBrowser, navigate, setHidden, submitPath, openBrowsed, beginOpen } from '../lib/project.svelte.ts'
  import type { BrowseEntry } from '../lib/types.ts'

  const d = $derived(browser.data)
  let hint = $state('')
  let openLabel = $state('Open this folder')
  // a fresh listing resets the hint/label; selecting a row overrides them
  $effect(() => {
    if (!d) return
    hint = d.kind ? `● this folder is a ${KIND[d.kind]} project` : 'Select a folder marked ● or open this one'
    openLabel = d.kind ? 'Open this project' : 'Open this folder'
  })

  function select(e: BrowseEntry): void {
    browser.selected = e.path
    hint = e.kind ? `● ${KIND[e.kind]} project selected` : 'Not a Svelte project: double-click to look inside'
    openLabel = 'Open ' + e.name
  }
  function dbl(e: BrowseEntry): void {
    if (e.kind) { browser.open = false; void beginOpen(e.path) } else void navigate(e.path)
  }
</script>

<div id="browser" class="modal" hidden={!browser.open}>
  <div class="dialog">
    <div class="row"><b>Choose a project folder</b><span class="dim grow"></span><button id="brClose" onclick={closeBrowser}>✕</button></div>
    <div id="brShortcuts" class="chips">
      {#each d?.shortcuts ?? [] as s (s.path)}
        <button data-path={s.path} onclick={() => navigate(s.path)}>{s.name}</button>
      {/each}
    </div>
    <div id="brCrumbs" class="crumbs">
      {#each d?.crumbs ?? [] as c, i (c.path)}
        <a href="#top" onclick={(ev) => { ev.preventDefault(); void navigate(c.path) }}>{c.name}</a>{i < (d?.crumbs.length ?? 0) - 1 ? ' › ' : ''}
      {/each}
    </div>
    <div class="row">
      <input id="brPath" placeholder="/path/to/project (paste and press Enter)" bind:value={browser.pathInput}
        oninput={() => (browser.pathDirty = true)} onkeydown={(e) => { if (e.key === 'Enter') submitPath() }} />
      <button id="brGo" onclick={submitPath}>Go</button>
    </div>
    <div id="brList" class="brlist">
      {#if browser.error}
        <div class="err pad" id="brError">{browser.error}</div>
      {:else if d}
        {#if d.parent}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="brrow" data-path={d.parent} onclick={() => navigate(d.parent!)}><span>↰ ..</span><span></span></div>
        {/if}
        {#each d.entries as e (e.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="brrow" class:proj={e.kind} class:sel={browser.selected === e.path} data-path={e.path} onclick={() => select(e)} ondblclick={() => dbl(e)}>
            <span>📁 {e.name}</span>
            <span>{#if e.kind}<span class="badge ok">● {KIND[e.kind]}</span>{/if}{#if e.git} <span class="badge">git</span>{/if}</span>
          </div>
        {/each}
        {#if !d.entries.length}<div class="dim pad">No sub-folders.</div>{/if}
      {/if}
    </div>
    <div class="row">
      <label class="dim"><input type="checkbox" id="brHidden" checked={browser.hidden} onchange={(e) => setHidden(e.currentTarget.checked)} /> show hidden folders</label>
      <span class="grow"></span><span id="brHint" class="dim">{hint}</span>
      <button id="brOpen" class="primary" onclick={openBrowsed}>{openLabel}</button>
    </div>
  </div>
</div>

<style>
  .chips { display: flex; gap: var(--space-2); flex-wrap: wrap }
  .crumbs { font-size: var(--font-size-small); color: var(--color-text-muted); word-break: break-all }
  .crumbs a { color: var(--color-primary); text-decoration: none }
  .brrow { display: flex; justify-content: space-between; padding: 5px 10px; cursor: pointer; border-bottom: 1px solid var(--color-surface-hover) }
  .brrow:hover { background: #f9fafb }
  .brrow.sel { background: var(--color-accent-soft-strong) }
  .brrow.proj span:first-child { font-weight: 600 }
</style>
