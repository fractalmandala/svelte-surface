<script lang="ts">
  import { ed, setTool, setWidth, reloadFrame, gotoPage, undoRedo, resetExample } from '../lib/surface.svelte.ts'
  import { code, setMode, saveFiles, refreshDrafts } from '../lib/code.svelte.ts'
  import { backToStart, closeProject } from '../lib/project.svelte.ts'
  import type { Tool } from '../lib/types.ts'

  const TOOLS: [Tool, string][] = [['select', 'Select'], ['comment', 'Comment'], ['preview', 'Preview']]
  const n = $derived(code.drafts.length)
  const conflicts = $derived(code.drafts.filter((d) => d.conflict).length)
  const modeOn = (m: string): boolean => (code.mode === 'code' ? 'code' : 'design') === m
</script>

<header>
  <b>surface</b><span class="dim" id="projName">{ed.info ? `· ${ed.info.name}` : ''}</span>
  <button id="switchBtn" title="Back to the start screen" onclick={backToStart}>Projects</button>
  <button id="closeBtn" onclick={() => closeProject(false)}>Close project</button>
  <span class="seg" id="modeSeg">
    <button data-mode="design" class:on={modeOn('design')} onclick={() => setMode('design')}>Design</button>
    <button data-mode="code" class:on={modeOn('code')} onclick={() => setMode('code')}>Code</button>
  </span>
  <label>Page
    <select id="pageSelect" value={ed.pageValue} onchange={(e) => gotoPage(e.currentTarget.value)}>
      {#each ed.pages as p (p.route)}
        <option value={p.route} disabled={p.dynamic || !p.file}>{p.route + (p.dynamic ? '  (dynamic)' : '') + (p.file ? '' : '  (no +page.svelte)')}</option>
      {/each}
    </select>
  </label>
  <span class="seg" id="tools">
    {#each TOOLS as [t, label] (t)}
      <button data-tool={t} class:on={ed.tool === t} onclick={() => setTool(t)}>{label}</button>
    {/each}
  </span>
  <label>Width
    <select id="widthSelect" value={String(ed.width)} onchange={(e) => setWidth(Number(e.currentTarget.value))}>
      <option value="1280">Desktop 1280</option>
      <option value="768">Tablet 768</option>
      <option value="390">Mobile 390</option>
    </select>
  </label>
  <button id="reloadBtn" title="Reload the frame" onclick={reloadFrame}>⟳</button>
  <button id="undoBtn" title="Undo (draft)" disabled={!ed.history.canUndo} onclick={() => undoRedo('undo')}>Undo</button>
  <button id="redoBtn" title="Redo (draft)" disabled={!ed.history.canRedo} onclick={() => undoRedo('redo')}>Redo</button>
  <button id="draftsBtn" title="Unsaved drafts" class:warnb={n > 0} class:bad={conflicts > 0} onclick={async () => { await refreshDrafts(); code.draftsOpen = true }}>
    {n ? `${n} unsaved${conflicts ? ` · ${conflicts} conflict` : ''}` : 'No unsaved changes'}
  </button>
  <button id="saveAllBtn" class="primary" disabled={!n} onclick={() => saveFiles(null)}>Save all</button>
  <button id="resetBtn" hidden={!ed.info?.scratch} onclick={resetExample}>Reset example</button>
  <span id="status" class="status {ed.status.kind}" data-last-change={ed.lastChange || undefined}>{ed.status.text}</span>
</header>

<style>
  header { display: flex; gap: var(--space-4); align-items: center; padding: var(--space-3) var(--space-4); background: var(--color-surface); border-bottom: 1px solid var(--color-border); flex-wrap: wrap }
  header b { font-size: 15px }
  .seg button { border-radius: 0 }
  .seg button:first-child { border-radius: var(--radius) 0 0 var(--radius) }
  .seg button:last-child { border-radius: 0 var(--radius) var(--radius) 0 }
  #modeSeg button.on { background: var(--color-ink); border-color: var(--color-ink) }
  .status { margin-left: auto; padding: 2px var(--space-3); border-radius: var(--radius-pill); background: var(--color-border); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .status.ok { background: var(--color-ok-soft); color: var(--color-ok-text) }
  .status.err { background: var(--color-danger-soft); color: var(--color-danger-text) }
</style>
