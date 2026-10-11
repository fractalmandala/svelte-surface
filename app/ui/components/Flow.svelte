<script lang="ts">
  import { proj, KIND, backToStart, startProject, installDeps } from '../lib/project.svelte.ts'

  const flow = $derived(proj.flow)
  let ack = $state(false)
  let installLabel = $state('')
  let installBusy = $state(false)
  $effect(() => { if (flow?.kind === 'card') { ack = false; installBusy = false; installLabel = '' } })

  async function install(): Promise<void> {
    if (flow?.kind !== 'card') return
    installBusy = true
    installLabel = 'Installing…'
    const err = await installDeps(flow.insp)
    if (err) { installBusy = false; installLabel = 'Retry install' }
  }
</script>

<div id="flow" class="screen" hidden={proj.screen !== 'flow'}>
  <div class="card" id="flowCard">
    {#if flow?.kind === 'checking'}
      <h2>Checking project…</h2>
      <p class="dim ref">{flow.path}</p>
    {:else if flow?.kind === 'opening'}
      <h2>Opening project…</h2>
      <p class="ref">{flow.path}</p>
      <p id="flowPhase" class="dim">{flow.phase}</p>
      <div class="spinner"></div>
    {:else if flow?.kind === 'error'}
      <div id="flowError">
        <h2 class="err">{flow.title}</h2>
        <p>{flow.message}</p>
        {#if flow.details}<pre class="log">{flow.details}</pre>{/if}
        <div class="row">
          <button id="flowBack" class="primary" onclick={backToStart}>Back to projects</button>
          {#if flow.retry}<button id="flowRetry" onclick={flow.retry}>Try again</button>{/if}
        </div>
      </div>
    {:else if flow?.kind === 'card'}
      {@const insp = flow.insp}
      {@const g = insp.git}
      {@const needInstall = !insp.depsInstalled}
      {@const warn = insp.warnings ?? []}
      <h2>{insp.name} <span class="badge ok">{KIND[insp.kind]}</span></h2>
      <div class="ref">{insp.path}</div>
      <table class="facts">
        <tbody>
          <tr><td>Svelte</td><td>{insp.versions.svelte ?? '?'}{insp.versions.kit ? ' · Kit ' + insp.versions.kit : ''}{insp.versions.vite ? ' · Vite ' + insp.versions.vite : ''}</td></tr>
          <tr><td>Git</td><td>
            {#if g.repo}branch <b>{g.branch}</b> · {#if g.dirty}<span class="warn">{g.changes} uncommitted change(s)</span>{:else}clean{/if}{:else}<span class="warn">not a git repository</span>{/if}
          </td></tr>
          <tr><td>Dependencies</td><td>{#if needInstall}<span class="warn">not installed</span>{:else}installed{/if}</td></tr>
        </tbody>
      </table>
      {#if needInstall}
        <div class="callout"><b>node_modules is missing.</b> The dev server needs this project's dependencies.
          <div class="row"><button id="flowInstall" class="primary" disabled={installBusy} onclick={install}>{installLabel || `Run ${insp.packageManager} install`}</button></div>
          <pre class="log" id="installLog" hidden={!installBusy && !proj.installLog}>{proj.installLog}</pre>
        </div>
      {/if}
      {#if warn.length}
        <div class="callout" id="flowWarn"><b>Safe-edit warning</b>
          {#each warn as w}<p>{w.message}</p>{/each}
          {#if g.sample?.length}<pre class="log">{g.sample.join('\n')}</pre>{/if}
          <label><input type="checkbox" id="flowAck" bind:checked={ack} /> I understand, edit this project anyway</label>
        </div>
      {/if}
      <div class="row">
        <button id="flowBack" onclick={backToStart}>Cancel</button><span class="grow"></span>
        <button id="flowOpen" class="primary" disabled={needInstall || (warn.length > 0 && !ack)} onclick={() => startProject(insp.path, warn.length > 0)}>Open project</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .screen { position: fixed; inset: 0; background: var(--color-bg); display: flex; align-items: flex-start; justify-content: center; overflow: auto; padding: 48px var(--space-5); z-index: var(--z-screen) }
  .card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-xl); padding: var(--space-6) 28px; width: var(--card-width); max-width: 100%; box-shadow: var(--shadow-card) }
  .facts { border-collapse: collapse; margin: 10px 0 }
  .facts td { padding: 2px 14px 2px 0 }
  .facts td:first-child { color: var(--color-text-muted) }
  .callout { border: 1px solid #fde68a; background: var(--color-warn-soft-bg); border-radius: var(--radius-lg); padding: 10px var(--space-4); margin: 10px 0 }
  .callout p { margin: 6px 0 }
  .spinner { width: 22px; height: 22px; border: 3px solid var(--color-accent-soft-strong); border-top-color: var(--color-primary); border-radius: 50%; animation: sp 1s linear infinite; margin-top: 10px }
  @keyframes sp { to { transform: rotate(360deg) } }
</style>
