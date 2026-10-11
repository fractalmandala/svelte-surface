<script lang="ts">
  import { ed } from '../lib/surface.svelte.ts'
  import { code } from '../lib/code.svelte.ts'
  import { proj } from '../lib/project.svelte.ts'
  import TopBar from './TopBar.svelte'
  import LeftPanel from './LeftPanel.svelte'
  import FileTree from './FileTree.svelte'
  import CodePane from './CodePane.svelte'
  import Canvas from './Canvas.svelte'
  import Inspector from './Inspector.svelte'

  const previewOn = $derived(code.mode === 'opencode' || code.preview)
  const banner = $derived(
    ed.info
      ? 'Edits are drafts: the preview shows them, but nothing is written to disk until you Save (⌘S).' +
        (ed.info.warnings?.some((w) => w.code === 'no-git') ? ' This folder is not under git, so Save cannot be undone from git.' : '')
      : ''
  )
</script>

<div id="editor" class="mode-{code.mode}" class:preview-on={previewOn} hidden={proj.screen !== 'editor'}>
  <div id="banner" class="banner" hidden={!ed.info}>{banner}</div>
  <TopBar />
  <main>
    <aside id="tree"><FileTree /></aside>
    <aside id="left"><LeftPanel /></aside>
    <section id="codepane" hidden={code.mode === 'design'}><CodePane /></section>
    <section id="canvasWrap"><Canvas /></section>
    <aside id="panel"><Inspector /></aside>
  </main>
</div>

<style>
  #editor { display: flex; flex-direction: column; height: 100vh }
  .banner { background: var(--color-warn-soft-bg); color: var(--color-warn-text); border-bottom: 1px solid #fde68a; padding: var(--space-2) var(--space-4); font-size: var(--font-size-small) }
  main { flex: 1; display: grid; grid-template-columns: var(--panel-left) minmax(0, 1fr) var(--panel-right); min-height: 0 }
  aside { overflow: auto; background: var(--color-surface); padding: var(--space-3) 10px }
  #left { border-right: 1px solid var(--color-border) }
  #panel { border-left: 1px solid var(--color-border) }
  #tree { border-right: 1px solid var(--color-border); background: var(--color-surface-muted) }
  #canvasWrap { min-height: 0; min-width: 0 }
  #codepane { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--color-surface); border-right: 1px solid var(--color-border) }
  #codepane[hidden] { display: none }

  /* view modes: design = canvas + layers + inspector; opencode = code beside the preview; code = file tree + code */
  .mode-design #tree, .mode-design #codepane { display: none }
  .mode-opencode #tree, .mode-opencode #left { display: none }
  .mode-opencode main { grid-template-columns: minmax(360px, 1fr) minmax(300px, 1fr) var(--panel-right) }
  .mode-code #left, .mode-code #panel { display: none }
  .mode-code main { grid-template-columns: var(--panel-tree) minmax(0, 1fr) }
  .mode-code.preview-on main { grid-template-columns: var(--panel-tree) minmax(0, 1fr) minmax(320px, 0.9fr) }
  .mode-code:not(.preview-on) #canvasWrap { display: none }
</style>
