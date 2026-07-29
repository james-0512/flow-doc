<template>
  <button @click="emit('submit')">送出</button>
</template>

<script setup lang="ts">
const emit = defineEmits<{ (e: 'submit'): void }>()
</script>
