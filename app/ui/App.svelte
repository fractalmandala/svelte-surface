<script lang="ts">
  import { onMount } from 'svelte'
  import Start from './components/Start.svelte'
  import Flow from './components/Flow.svelte'
  import FolderBrowser from './components/FolderBrowser.svelte'
  import Editor from './components/Editor.svelte'
  import DraftsDialog from './components/DraftsDialog.svelte'
  import DiffDialog from './components/DiffDialog.svelte'
  import ConfirmDialog from './components/ConfirmDialog.svelte'
  import { boot, wireProject } from './lib/project.svelte.ts'
  import { wire } from './lib/surface.svelte.ts'
  import { wireCode } from './lib/code.svelte.ts'

  wire()
  wireCode()
  wireProject()
  onMount(() => void boot())
</script>

<Start />
<Flow />
<FolderBrowser />
<Editor />
<DraftsDialog />
<DiffDialog />
<ConfirmDialog />
