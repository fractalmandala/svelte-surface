<script lang="ts">
  import { proj, KIND, openFolder, openExample, beginOpen, removeRecent, closeProject } from '../lib/project.svelte.ts'
  import { ago } from '../lib/format.ts'

  const cur = $derived(proj.app?.current ?? null)
</script>

<div id="start" class="screen" hidden={proj.screen !== 'start'}>
  <div class="card">
    <h1>surface <span class="dim">svelte-surface</span></h1>
    <p class="dim">Design-to-code for SvelteKit and Vite + Svelte. Open a project folder: you edit it visually, and every change is written into your <code>.svelte</code> files.</p>
    <div class="row big">
      <button id="openFolder" class="primary" onclick={openFolder}>Open folder…</button>
      <button id="openExample" onclick={openExample}>Open the bundled example</button>
    </div>
    {#if cur}
      <div id="resume" class="resume">
        <span>
          Currently open: <b>{cur.name}</b> <span class="dim">{cur.root}</span>
          {#if cur.dirty?.length} <span class="badge warnb">{cur.dirty.length} unsaved file(s)</span>{/if}
        </span>
        <span>
          <button id="resumeBtn" class="primary" onclick={() => (proj.screen = 'editor')}>Back to editor</button>
          <button id="resumeClose" onclick={() => closeProject(false)}>Close it</button>
        </span>
      </div>
    {/if}
    <h3>Recent projects</h3>
    <div id="recents" class="recents">
      {#each proj.app?.recents ?? [] as r (r.path)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="recent" class:missing={r.missing} data-path={r.path} onclick={(ev) => { if (!(ev.target as HTMLElement).closest('.x') && !r.missing) void beginOpen(r.path) }}>
          <div>
            <b>{r.name}</b> <span class="badge">{KIND[r.kind] ?? r.kind}</span>
            <div class="ref">{r.path}{r.missing ? ' — folder not found' : ''}</div>
          </div>
          <div class="dim">{ago(r.openedAt)} <button class="x" title="Remove from recents" onclick={() => removeRecent(r.path)}>×</button></div>
        </div>
      {:else}
        <div class="dim">No recent projects yet. Open a folder to begin.</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .screen { position: fixed; inset: 0; background: var(--color-bg); display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 48px var(--space-5); z-index: var(--z-screen) }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-xl); padding: var(--space-6) 28px; width: var(--card-width); max-width: 100%; box-shadow: var(--shadow-card) }
  h1 { margin: 0 0 6px; font-size: var(--font-size-title) }
  .big { gap: 10px; margin: var(--space-5) 0 }
  .big button { padding: 9px var(--space-5); font-size: 14px }
  .resume { display: flex; justify-content: space-between; align-items: center; background: var(--color-accent-soft); border: 1px solid var(--color-accent-soft-strong); border-radius: var(--radius-lg); padding: var(--space-3) 10px; margin-bottom: var(--space-3); gap: var(--space-3) }
  .recents { display: flex; flex-direction: column; gap: var(--space-2) }
  .recent { display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; padding: var(--space-3) 10px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); cursor: pointer }
  .recent:hover { background: var(--color-accent-soft) }
  .recent.missing { opacity: 0.5; cursor: default }
  .x { border: 0; background: none; color: var(--color-text-dim); font-size: var(--space-5) }
</style>
