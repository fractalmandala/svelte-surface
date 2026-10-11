<script lang="ts">
  import { code, loadTree, openFile } from '../lib/code.svelte.ts'

  interface Node { dirs: Map<string, Node>; files: string[] }
  interface Row { kind: 'dir' | 'file'; path: string; name: string; depth: number; open?: boolean; dirty: boolean; dim: boolean; on?: boolean }

  const rows = $derived.by(() => {
    const root: Node = { dirs: new Map(), files: [] }
    for (const f of code.files) {
      let node = root
      for (const p of f.split('/').slice(0, -1)) {
        if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] })
        node = node.dirs.get(p)!
      }
      node.files.push(f)
    }
    const dirty = new Set(code.drafts.map((d) => d.file))
    const open = code.active?.file
    const out: Row[] = []
    const walk = (node: Node, prefix: string, depth: number): void => {
      for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const p = prefix ? `${prefix}/${name}` : name
        const isOpen = code.expanded.has(p)
        out.push({ kind: 'dir', path: p, name, depth, open: isOpen, dirty: [...dirty].some((d) => d.startsWith(p + '/')), dim: name.startsWith('.') })
        if (isOpen) walk(child, p, depth + 1)
      }
      for (const f of [...node.files].sort()) {
        const name = f.split('/').pop()!
        out.push({ kind: 'file', path: f, name, depth, dirty: dirty.has(f), dim: name.startsWith('.') && !name.startsWith('.env'), on: f === open })
      }
    }
    walk(root, '', 0)
    return out
  })
  const toggle = (p: string): void => { if (code.expanded.has(p)) code.expanded.delete(p); else code.expanded.add(p) }
</script>

<div class="row"><b>Files</b><span class="grow"></span><button id="treeReload" title="Read the tree again" onclick={loadTree}>⟳</button></div>
<div id="treeBox" class="tree">
  {#if code.treeError}{code.treeError}{/if}
  {#each rows as r (r.kind + r.path)}
    {#if r.kind === 'dir'}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="trow dir" class:dimmed={r.dim} data-dir={r.path} style:padding-left="{6 + r.depth * 12}px" onclick={() => toggle(r.path)}>
        {r.open ? '▾' : '▸'} {r.name}{#if r.dirty} <i class="dot">●</i>{/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="trow file" class:on={r.on} class:dimmed={r.dim} data-file={r.path} style:padding-left="{6 + r.depth * 12 + 10}px" onclick={() => openFile(r.path, { focus: true })}>
        {r.name}{#if r.dirty} <i class="dot">●</i>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .tree { font-size: var(--font-size-small); margin-top: 6px }
  .trow { padding: 2px 6px; cursor: pointer; white-space: nowrap; border-radius: var(--radius-sm); user-select: none }
  .trow:hover { background: var(--color-accent-soft) }
  .trow.on { background: var(--color-accent-soft-strong) }
  .trow.dimmed { color: var(--color-text-dim) }
</style>
