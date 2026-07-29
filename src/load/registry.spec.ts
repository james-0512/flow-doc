import { describe, expect, it } from 'vitest'
import { camelize, normalizeTag, parseGlobalComponents } from './registry.js'

describe('parseGlobalComponents', () => {
  it('解析 unplugin-vue-components 的宣告，路徑相對 d.ts 所在目錄', () => {
    const map = parseGlobalComponents(
      `declare module 'vue' {
  export interface GlobalComponents {
    UtilTable: typeof import('./components/Utils/UtilTable.vue')['default']
    ActivityCard: typeof import('./components/Activity/ActivityClient/ActivityCard.vue')['default']
  }
}`,
      'src/components.d.ts'
    )
    expect(map.get('UtilTable')).toBe('src/components/Utils/UtilTable.vue')
    expect(map.get('ActivityCard')).toBe('src/components/Activity/ActivityClient/ActivityCard.vue')
  })
})

describe('camelize', () => {
  it.each([
    // template 寫 @update-params，子元件寫 emit('updateParams')——同一條連結
    ['update-params', 'updateParams'],
    ['updateParams', 'updateParams'],
    ['emit-verification-log-amount', 'emitVerificationLogAmount'],
    // v-model 的 arg 也可能是 kebab-case
    ['update:vital-sign-type', 'update:vitalSignType'],
    ['click', 'click']
  ])('%s → %s', (name, expected) => {
    expect(camelize(name)).toBe(expected)
  })
})

describe('normalizeTag', () => {
  it.each([
    ['util-table', 'UtilTable'],
    ['UtilTable', 'UtilTable'],
    ['utilTable', 'UtilTable'],
    ['el-button', 'ElButton']
  ])('%s → %s', (tag, expected) => {
    expect(normalizeTag(tag)).toBe(expected)
  })
})
