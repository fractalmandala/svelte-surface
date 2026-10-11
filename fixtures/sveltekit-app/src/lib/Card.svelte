<script>
  let { title, count = 3 } = $props()
</script>

<section class="rounded-2xl p-6">
  <h2>{title}</h2>
  <span>{count}</span>
</section>
