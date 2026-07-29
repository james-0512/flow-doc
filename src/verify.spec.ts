import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyManual } from './verify.js'

const REPO = fileURLToPath(new URL('../fixtures/mini-vue', import.meta.url))

describe('verifyManual', () => {
  it('引用真實存在的位置就通過', () => {
    const result = verifyManual('第一步見 `src/api/demo.ts:3`。', REPO)
    expect(result.references).toBe(1)
    expect(result.violations).toEqual([])
  })

  it('抓到憑空捏造的檔案路徑', () => {
    const result = verifyManual('見 `src/api/nonexistent.ts:3`。', REPO)
    expect(result.violations).toMatchObject([{ kind: 'MISSING_FILE' }])
  })

  it('抓到超出檔案長度的行號', () => {
    const result = verifyManual('見 `src/api/demo.ts:9999`。', REPO)
    expect(result.violations).toMatchObject([{ kind: 'LINE_OUT_OF_RANGE' }])
  })

  it('抓到「檔案存在、行號合法，但不在這條流程上」的幻覺', () => {
    // 這是純檔案檢查抓不到、卻最容易發生的一種：LLM 引用了一個真實但無關的位置
    const packet = '- **createDemo** `src/api/demo.ts:3-5`'
    const result = verifyManual('見 `src/stores/demo.ts:5`。', REPO, packet)
    expect(result.violations).toMatchObject([{ kind: 'NOT_IN_PACKET' }])
  })

  it('抓到手冊漏掉封包裡的寫入型副作用', () => {
    // 只驗「多寫」不驗「漏寫」的話，悄悄漏掉一支寫入 API 的手冊會全綠通過，
    // 而讀者會以為那個副作用不存在
    const packet = [
      '- **createDemo** `src/api/demo.ts:3-5`',
      '- [API] POST /api/v1/demo/create（**寫入**）  `src/api/demo.ts:4`'
    ].join('\n')
    const missing = verifyManual('這一步呼叫了 `src/api/demo.ts:3`。', REPO, packet)
    expect(missing.violations).toMatchObject([{ kind: 'UNCITED_EFFECT' }])

    const cited = verifyManual('建立資料 `src/api/demo.ts:4`。', REPO, packet)
    expect(cited.violations).toEqual([])
  })

  it('封包給的是區間時，區間內任一行都算合法引用', () => {
    const packet = '- **createDemo** `src/api/demo.ts:3-5`'
    expect(verifyManual('見 `src/api/demo.ts:4`。', REPO, packet).violations).toEqual([])
    expect(verifyManual('見 `src/api/demo.ts:8`。', REPO, packet).violations).toMatchObject([
      { kind: 'NOT_IN_PACKET' }
    ])
  })
})
