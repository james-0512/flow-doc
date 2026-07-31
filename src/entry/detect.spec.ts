import { describe, expect, it } from 'vitest'
import { defaultVueConfig } from '../config.js'
import { parseSfc } from '../load/sfc.js'
import { extractScriptFacts } from '../load/script.js'
import { domainOf, extractHandlerName, scanSfc, type DetectContext } from './detect.js'

describe('extractHandlerName', () => {
  it.each([
    ['handleSubmit', 'handleSubmit'],
    ['onSave(row)', 'onSave'],
    ['() => doThing()', 'doThing'],
    ['async () => await save()', 'save'],
    ['store.load()', 'store.load'],
    ['e => onInput(e)', 'onInput']
  ])('%s → %s', (expr, expected) => {
    expect(extractHandlerName(expr)).toBe(expected)
  })
})

describe('domainOf', () => {
  it.each([
    ['src/views/Appointment/IndexView.vue', 'Appointment'],
    ['src/views/Home/Main/components/SearchBar.vue', 'Home'],
    ['src/components/Utils/UtilTable.vue', 'Utils'],
    ['src/stores/auth.ts', 'stores'],
    ['src/utils/composables/useCase.ts', 'shared']
  ])('%s → %s', (rel, expected) => {
    expect(domainOf(rel)).toBe(expected)
  })
})

function scan(rel: string, source: string, ctx?: Partial<DetectContext>) {
  // opaque 由各專案的設定檔宣告，不在通用預設值裡——這裡測的是「不可分析元件
  // 回退成 entry」的行為，所以要自己把 Utils 標成 opaque
  const config = { ...defaultVueConfig('/repo'), opaque: ['src/components/Utils/'] }
  const sfc = parseSfc(rel, source)
  const facts = sfc.virtualTs
    ? extractScriptFacts(`${rel}.ts`, sfc.virtualTs)
    : { componentImports: new Map(), declaredNames: new Set<string>(), lifecycle: [] }
  return scanSfc({ config, globalComponents: new Map(), files: new Set(), ...ctx }, sfc, facts)
}

describe('scanSfc', () => {
  it('原生元素的事件是 entry，可分析元件的事件只是 emit 連結', () => {
    const result = scan(
      'src/views/Demo/IndexView.vue',
      `<template>
  <button @click="save">存</button>
  <DemoForm @submit="onSubmit" />
</template>
<script setup lang="ts">
import DemoForm from '@/components/Demo/DemoForm.vue'
function save() {}
function onSubmit() {}
</script>`,
      { files: new Set(['src/components/Demo/DemoForm.vue']) }
    )
    expect(result.entries.map(e => [e.trigger, e.origin])).toEqual([['click', 'native']])
    expect(result.listeners.map(l => [l.tag, l.event, l.toComponent])).toEqual([
      ['DemoForm', 'submit', 'src/components/Demo/DemoForm.vue']
    ])
  })

  it('不可分析元件（components/Utils）上的事件回退成 entry', () => {
    // UtilButton 內部永遠不會被掃到，這個 listener 就是最上游的觸發點
    const result = scan(
      'src/views/Demo/IndexView.vue',
      `<template><UtilButton @click="save" /></template>
<script setup lang="ts">
function save() {}
</script>`,
      { globalComponents: new Map([['UtilButton', 'src/components/Utils/UtilButton.vue']]) }
    )
    expect(result.entries.map(e => [e.tag, e.origin])).toEqual([['UtilButton', 'opaque-component']])
    expect(result.listeners).toHaveLength(0)
  })

  it('kebab-case 標籤要能對到全域註冊表', () => {
    const result = scan(
      'src/views/Demo/IndexView.vue',
      `<template><demo-form @submit="onSubmit" /></template>`,
      { globalComponents: new Map([['DemoForm', 'src/components/Demo/DemoForm.vue']]) }
    )
    expect(result.listeners[0]?.toComponent).toBe('src/components/Demo/DemoForm.vue')
  })

  it('動態事件名要被計數而非靜默吞掉', () => {
    const result = scan('src/views/Demo/IndexView.vue', `<template><button @[evt]="save" /></template>`)
    expect(result.dynamicEventBindings).toBe(1)
    expect(result.entries).toHaveLength(0)
  })

  it('lifecycle 鉤子是不需使用者點擊的 entry，行號指回 .vue', () => {
    const result = scan(
      'src/views/Demo/IndexView.vue',
      `<template><div/></template>
<script setup lang="ts">
import { onMounted } from 'vue'
onMounted(() => {
  load()
})
</script>`
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.kind).toBe('LIFECYCLE')
    expect(result.entries[0]!.loc.line).toBe(4)
  })
})
