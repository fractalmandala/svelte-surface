<script lang="ts">
  import { confirmState, answerConfirm } from '../lib/dialogs.svelte.ts'
  const spec = $derived(confirmState.spec)
</script>

<div id="confirmModal" class="modal" hidden={!confirmState.open}>
  <div class="dialog small auto">
    <h3 id="confirmTitle">{spec?.title ?? ''}</h3>
    <p id="confirmText">{spec?.text ?? ''}</p>
    <div id="confirmList" class="log" hidden={!spec?.list?.length}>{(spec?.list ?? []).join('\n')}</div>
    <div class="row" id="confirmBtns">
      {#each spec?.buttons ?? [] as b (b.label)}
        <button class={b.kind} onclick={() => answerConfirm(b.value)}>{b.label}</button>
      {/each}
    </div>
  </div>
</div>
