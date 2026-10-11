<script>
  import Card from '../lib/Card.svelte'
  let name = 'world'
</script>

<main class="mx-auto max-w-3xl px-6 py-24">
  <h1 class="text-5xl font-semibold">Selected work</h1>
  <p class="lead">Hello</p>
  <Card title="Questions" />
  <button class="btn {name ? 'on' : ''}">Go {name}</button>
</main>
