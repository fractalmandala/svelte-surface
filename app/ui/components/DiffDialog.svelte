<script lang="ts">
  import { code, codeDom, closeDiff } from '../lib/code.svelte.ts'
  function host(node: HTMLElement) {
    codeDom.diffHost = node
    return { destroy: () => { codeDom.diffHost = null } }
  }
</script>

<div id="diffModal" class="modal" hidden={!code.diff.open}>
  <div class="dialog wide">
    <div class="row"><b id="diffTitle">{code.diff.title}</b><span class="dim" id="diffSub">{code.diff.sub}</span><span class="grow"></span><button id="diffClose" onclick={closeDiff}>✕</button></div>
    <div id="diffHost" class="diffhost" use:host></div>
  </div>
</div>

<style>
  .diffhost { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--color-border); border-radius: var(--radius) }
  .diffhost :global(.cm-mergeView) { height: 100% }
  .diffhost :global(.cm-editor) { height: auto }
</style>
