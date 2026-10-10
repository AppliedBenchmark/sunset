<template>
  <!-- gpt-fixture-retired is no longer offered. -->
  <select v-model="model">
    <option value="gpt-fixture-4o">GPT-4o</option>
    <!-- sunset-ignore-next-line reason="kept for old sessions" -->
    <option value="gpt-fixture-retired">Legacy (don't pick it)</option>
  </select>
  <p>Ask "gpt-fixture-3" anything.</p>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const model = ref('gpt-fixture-2-2099-02-15'); // the default
</script>

<style scoped>
select { font-family: "gpt-fixture-retired", sans-serif; }
</style>
