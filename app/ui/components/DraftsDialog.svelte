<script lang="ts">
  import { code, openFile, setMode, saveFiles, revertFiles, openDiff, resolveConflict } from '../lib/code.svelte.ts'

  async function open(file: string): Promise<void> {
    code.draftsOpen = false
    if (code.mode === 'design') setMode('opencode')
    await openFile(file)
  }
</script>

<div id="draftsModal" class="modal" hidden={!code.draftsOpen}>
  <div class="dialog small">
    <div class="row"><b>Unsaved changes</b><span class="grow"></span><button id="draftsClose" onclick={() => (code.draftsOpen = false)}>✕</button></div>
    <p class="dim">Edits live in memory and show in the preview. Nothing is written to your files until you Save.</p>
    <div id="draftsList" class="brlist">
      {#each code.drafts as d (d.file)}
        <div class="draftrow" data-file={d.file}>
          <div><b>{d.file}</b> {#if d.conflict}<span class="badge bad">changed on disk</span>{/if}</div>
          <div class="row">
            <button onclick={() => openDiff(d.file)}>Diff</button>
            <button onclick={() => open(d.file)}>Open</button>
            {#if d.conflict}
              <button onclick={() => resolveConflict(d.file, 'reload')}>Reload</button>
              <button onclick={() => resolveConflict(d.file, 'keep')}>Keep draft</button>
              <button class="danger" onclick={() => resolveConflict(d.file, 'overwrite')}>Overwrite</button>
            {:else}
              <button class="primary" onclick={() => saveFiles([d.file])}>Save</button>
              <button class="danger" onclick={() => revertFiles([d.file])}>Revert</button>
            {/if}
          </div>
        </div>
      {:else}
        <div class="dim pad">Nothing unsaved.</div>
      {/each}
    </div>
    <div class="row">
      <button id="draftsDiscardAll" class="danger" onclick={() => revertFiles(null)}>Discard all</button><span class="grow"></span>
      <button id="draftsSaveAll" class="primary" onclick={() => saveFiles(null)}>Save all</button>
    </div>
  </div>
</div>

<style>
  .draftrow { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: 6px 10px; border-bottom: 1px solid var(--color-surface-hover) }
  .draftrow .row { flex-wrap: wrap; justify-content: flex-end }
</style>
