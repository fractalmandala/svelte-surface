<script lang="ts">
  import { code, codeDom, closeTab, switchTo, setMode, saveFiles, revertFiles, openDiff, reloadActive, resolveConflict, togglePreview } from '../lib/code.svelte.ts'

  const t = $derived(code.active)
  const stateLabel = $derived(!t ? '' : t.conflict ? 'changed on disk' : t.dirty ? 'unsaved draft' : 'saved')
  const stateKind = $derived(t?.conflict ? 'bad' : t?.dirty ? 'warnb' : 'ok')
  const blocked = $derived(!t || !!t.error)

  function host(node: HTMLElement): void { codeDom.host = node }
</script>

<div class="cp-head">
  <b id="cpFile" class="ref">{t ? t.file : 'No file open'}</b><span id="cpState" class="badge {stateKind}">{stateLabel}</span><span class="grow"></span>
  <button id="cpReload" title="Reload from disk" disabled={blocked} onclick={reloadActive}>Reload</button>
  <button id="cpDiff" title="Diff against disk" disabled={blocked} onclick={() => t && openDiff(t.file)}>Diff</button>
  <button id="cpRevert" disabled={blocked || !t?.dirty} onclick={() => t && revertFiles([t.file])}>Revert</button>
  <button id="cpSave" class="primary" title="Save (⌘S)" disabled={blocked || !t?.dirty} onclick={() => saveFiles(t ? [t.file] : null)}>Save</button>
  <button id="cpPreview" class:on={code.preview} title="Preview beside the code" hidden={code.mode !== 'code'} onclick={togglePreview}>▶ Preview</button>
  <button id="cpClose" title="Close code (Esc)" onclick={() => setMode('design')}>✕</button>
</div>
<div id="cpTabs" class="tabs">
  {#each code.tabs as tab (tab.file)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="tab" class:on={tab === code.active} data-file={tab.file} title={tab.file}
      onclick={(e) => { if (!(e.target as HTMLElement).closest('.x')) void switchTo(tab) }}
      onauxclick={(e) => { if (e.button === 1) closeTab(tab) }}>
      <span>{tab.file.split('/').pop()}</span><i class="dot" hidden={!tab.dirty}>●</i><button class="x" title="Close" onclick={() => closeTab(tab)}>×</button>
    </div>
  {/each}
</div>
<div id="cpConflict" class="conflict" hidden={!t?.conflict}>
  {#if t?.conflict}
    <b>{t.file} changed on disk since you started editing.</b> Saving is refused so nothing gets overwritten.
    <div class="row">
      <button onclick={() => resolveConflict(t.file, 'reload')}>Reload from disk (drop my draft)</button>
      <button onclick={() => resolveConflict(t.file, 'keep')}>Keep my draft (it replaces the disk version on save)</button>
      <button class="danger" onclick={() => resolveConflict(t.file, 'overwrite')}>Overwrite disk with my draft</button>
      <button onclick={() => resolveConflict(t.file, 'diff')}>Diff</button>
    </div>
  {/if}
</div>
<div id="cpEditor" class="cm-host" use:host></div>
<div id="cpNote" class="cp-note">{t?.error ?? ''}</div>

<style>
  .cp-head { display: flex; gap: 6px; align-items: center; padding: 6px var(--space-3); border-bottom: 1px solid var(--color-border); flex-wrap: wrap }
  .cp-head .ref { margin: 0 }
  .tabs { display: flex; gap: 2px; padding: var(--space-2) 6px 0; border-bottom: 1px solid var(--color-border); overflow-x: auto; background: #f9fafb; min-height: 28px }
  .tab { display: flex; gap: 6px; align-items: center; padding: var(--space-1) var(--space-3); border: 1px solid var(--color-border); border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; cursor: pointer; background: var(--color-surface-hover); font-size: var(--font-size-small); white-space: nowrap }
  .tab.on { background: var(--color-surface); font-weight: 600 }
  .x { border: 0; background: none; padding: 0 2px; color: var(--color-text-dim) }
  .cm-host { flex: 1; min-height: 0; overflow: hidden }
  .cm-host :global(.cm-editor) { height: 100% }
  .cp-note { font-size: var(--font-size-tiny); color: var(--color-danger); padding: 0 var(--space-3) }
  .cp-note:empty { display: none }
  .conflict { background: #fef2f2; border-bottom: 1px solid #fecaca; padding: 6px 10px; font-size: var(--font-size-small); color: #7f1d1d }
  .conflict .row { flex-wrap: wrap }
</style>
