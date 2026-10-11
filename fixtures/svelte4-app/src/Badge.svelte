<script lang="ts">
  export let label: string = ''
</script>

<span class="badge">{label} {$$props.extra ?? ''}</span>
