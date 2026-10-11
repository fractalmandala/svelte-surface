<script lang="ts">
  import Badge from './Badge.svelte'
  export let name: string = 'world'
</script>

<main>
  <h1>Hello {name}</h1>
  <Badge label="new" />
</main>
