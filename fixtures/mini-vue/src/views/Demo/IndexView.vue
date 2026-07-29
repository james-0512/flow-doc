<template>
  <button @click="save">存檔</button>
  <UtilButton @click="reset" />
  <DemoForm @submit="onFormSubmit" />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DemoForm from '@/components/Demo/DemoForm.vue'
import { loadDemo, submitDemo } from '@/stores/demo'
import { formatName } from '@/utils/functions/format'

const router = useRouter()

/** 模擬 vee-validate 的 handleSubmit：真正的邏輯在 callback 裡 */
const withGuard = (fn: () => Promise<void>) => fn

const save = withGuard(async () => {
  await submitDemo(formatName('demo'))
  router.push({ name: 'DemoDone' })
})

function reset() {
  loadDemo()
}

/** 子元件的送出鈕本身只 emit，真正的業務動作在這裡——階段三要接得起來 */
function onFormSubmit() {
  void save()
}

onMounted(() => {
  loadDemo()
})
</script>
