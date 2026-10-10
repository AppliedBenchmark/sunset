<script lang="ts">
  export let model = 'gpt-fixture-3';
</script>

<Chat {model} fallback={'gpt-fixture-1-2099-01-10'} />
<p>{model} answers here.</p>
