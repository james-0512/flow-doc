<template>
  <!-- handler 綁在物件屬性上：新增與編輯共用同一顆確認鈕 -->
  <UtilButton @click="modalInfo.okFn" />
  <UtilButton @dblclick="modalInfo.cancelFn" />
  <UtilButton @focus="ternaryInfo.okFn" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { loadDemo, submitDemo } from '@/stores/demo'

const props = defineProps<{ editing?: boolean }>()

async function updateHandler() {
  await submitDemo('update')
}

async function createHandler() {
  await submitDemo('create')
}

/** 同一顆按鈕在新增／編輯兩種情境下做不同事——兩個候選都是真的，不能挑一個 */
const modalInfo = computed(() => {
  if (props.editing) {
    return { title: '編輯', okFn: updateHandler, cancelFn: () => loadDemo() }
  }
  return { title: '新增', okFn: createHandler, cancelFn: () => loadDemo() }
})

/** 同一件事的另一種寫法：三元回傳。目標專案兩種都有 */
const ternaryInfo = computed(() =>
  props.editing ? { okFn: updateHandler } : { okFn: createHandler }
)
</script>
