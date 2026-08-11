<template>
  <!-- 同一個 handler 也接在按鈕上：推播不該被併進使用者觸發的那一章 -->
  <button @click="refreshHandler">重新整理</button>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { loadDemo } from '@/stores/demo'
import { useSignalR } from '@/utils/composables/useSignalR'

const signalR = useSignalR()

function refreshHandler() {
  void loadDemo()
}

onMounted(() => {
  // 事件名是字串常數、handler 就在同一個呼叫裡——不需要跨檔 join
  signalR.subscribe('DemoUpdated', refreshHandler)
})
</script>
