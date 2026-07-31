import { describe, expect, it } from 'vitest'
import { slugify } from './paths.js'

describe('slugify', () => {
  it('短識別碼原樣保留可讀性', () => {
    expect(slugify('src/views/Demo/IndexView.vue#button.click@save')).toBe(
      'src-views-Demo-IndexView.vue-button.click-save'
    )
  })

  it('不超過檔名長度上限', () => {
    expect(slugify(`src/views/${'x'.repeat(300)}.vue#button.click@save`).length).toBeLessThanOrEqual(100)
  })

  it('超長且前綴相同者不可撞名——純截斷會靜默覆蓋敘述', () => {
    const prefix = `src/views/${'Deep/'.repeat(20)}IndexView.vue#UtilButton.click@`
    const a = slugify(`${prefix}handleSubmitFormAndClose`)
    const b = slugify(`${prefix}handleSubmitFormAndStay`)
    expect(a).not.toBe(b)
  })

  it('同一個識別碼永遠得到同一個 slug', () => {
    const id = `src/views/${'Deep/'.repeat(20)}IndexView.vue#UtilButton.click@save`
    expect(slugify(id)).toBe(slugify(id))
  })
})
