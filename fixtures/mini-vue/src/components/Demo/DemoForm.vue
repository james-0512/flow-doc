<template>
  <button @click="emit('submit')">送出</button>
  <input @input="emit('update:keyword', 'x')" />
</template>

<script setup lang="ts">
const emit = defineEmits<{ (e: 'submit'): void; (e: 'update:keyword', v: string): void }>()
</script>
