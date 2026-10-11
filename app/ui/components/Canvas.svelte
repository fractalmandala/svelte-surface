<script lang="ts">
  import { dom, ed, layout } from '../lib/surface.svelte.ts'

  function canvas(node: HTMLElement) {
    dom.canvas = node
    const ro = new ResizeObserver(() => layout())
    ro.observe(node)
    return { destroy: () => ro.disconnect() }
  }
  function frame(node: HTMLIFrameElement): void { dom.frame = node }
</script>

<div id="canvas" use:canvas>
  <div id="stage" style:width="{ed.stageW}px" style:height="{ed.stageH}px">
    <iframe id="frame" name="main" title="canvas" use:frame style:width="{ed.width}px" style:height="{ed.frameH}px" style:transform="scale({ed.zoom})"></iframe>
  </div>
</div>

<style>
  #canvas { overflow: auto; padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); min-height: 0; height: 100% }
  #stage { position: relative; background: var(--color-surface); box-shadow: var(--shadow-stage); align-self: flex-start; overflow: hidden }
  #frame { border: 0; display: block; transform-origin: 0 0; background: var(--color-surface) }
</style>
