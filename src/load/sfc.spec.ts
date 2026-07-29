import { describe, expect, it } from 'vitest'
import { NodeTypes } from '@vue/compiler-core'
import { parseSfc } from './sfc.js'

const SFC = `<template>
  <button @click="handleSubmit">送出</button>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Child from './Child.vue'

const count = ref(0)
function handleSubmit() {
  count.value++
}
</script>
`

describe('parseSfc', () => {
  const sfc = parseSfc('src/views/Demo/IndexView.vue', SFC)
  const lines = (sfc.virtualTs ?? '').split('\n')

  it('虛擬 TS 的行號與原始 .vue 完全對齊', () => {
    // 對齊是 file:line 防幻覺機制的地基：錯一行，手冊引用的位置就全錯
    expect(lines[5]).toBe(`import { ref } from 'vue'`)
    expect(lines[9]).toBe('function handleSubmit() {')
    expect(lines[11]).toBe('}')
  })

  it('template 區塊在虛擬 TS 裡是空行，不會污染語法解析', () => {
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('')
  })

  it('.vue import 改寫成 .vue.ts，才不會被 shims 的 declare module 攔截', () => {
    expect(lines[6]).toBe(`import Child from './Child.vue.ts'`)
  })

  it('template AST 的 loc 是相對整個檔案的絕對行號', () => {
    // 這是 @vue/compiler-sfc 的行為前提；若哪天改成相對 template 區塊，
    // 所有 UI_EVENT 的行號會整批位移，必須立刻被這個測試擋下來
    const ast = sfc.descriptor.template?.ast
    expect(ast).toBeTruthy()
    const button = ast!.children.find(c => c.type === NodeTypes.ELEMENT)
    expect(button).toBeTruthy()
    expect(button!.loc.start.line).toBe(2)
  })

  it('沒有 script 區塊時 virtualTs 為 null', () => {
    expect(parseSfc('x.vue', '<template><div/></template>').virtualTs).toBeNull()
  })
})
