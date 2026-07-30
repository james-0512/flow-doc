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

  it('抓到「行號合法但內容已位移」的過期引用', () => {
    // 這是最危險的一種：目標 repo 改動後，引用仍然指向存在的行，
    // 只是那些行變成了無關的程式碼。前兩層檢查完全抓不到。
    const stale = [
      '### `createDemo` — `src/api/demo.ts:3-5`',
      '',
      '```ts',
      'export async function createDemo(data: unknown) {',
      "  return apiService.post('/api/v1/DIFFERENT/path', data)",
      '}',
      '```'
    ].join('\n')
    const result = verifyManual('見 `src/api/demo.ts:4`。', REPO, stale)
    expect(result.violations).toMatchObject([{ kind: 'STALE_SOURCE' }])
  })

  it('封包內容與現況一致時不報過期', () => {
    const fresh = [
      '### `createDemo` — `src/api/demo.ts:3-5`',
      '',
      '```ts',
      'export async function createDemo(data: unknown) {',
      "  return apiService.post('/api/v1/demo/create', data)",
      '}',
      '```'
    ].join('\n')
    expect(verifyManual('見 `src/api/demo.ts:4`。', REPO, fresh).violations).toEqual([])
  })

  it('手冊宣告 covers 的觸發位置算合法引用', () => {
    // 一份敘述涵蓋多個控件（篩選、分頁、查詢鈕）是正確寫法，引用那些控件的位置
    // 不該被當成臆測——covers: 就是作者的明確宣告
    const packet = '- **createDemo** `src/api/demo.ts:3-5`'
    const manual = [
      '---',
      'covers:',
      '  - src/api/demo.ts:8:UtilButton:click',
      '---',
      '',
      '另一個觸發點在 `src/api/demo.ts:8`。'
    ].join('\n')
    expect(verifyManual(manual, REPO, packet).violations).toEqual([])
  })

  it('沒宣告 covers 時仍會抓到封包外的引用', () => {
    const packet = '- **createDemo** `src/api/demo.ts:3-5`'
    expect(verifyManual('另一個位置 `src/api/demo.ts:8`。', REPO, packet).violations).toMatchObject([
      { kind: 'NOT_IN_PACKET' }
    ])
  })

  it('封包給的是區間時，區間內任一行都算合法引用', () => {
    const packet = '- **createDemo** `src/api/demo.ts:3-5`'
    expect(verifyManual('見 `src/api/demo.ts:4`。', REPO, packet).violations).toEqual([])
    expect(verifyManual('見 `src/api/demo.ts:8`。', REPO, packet).violations).toMatchObject([
      { kind: 'NOT_IN_PACKET' }
    ])
  })
})
