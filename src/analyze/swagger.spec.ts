import { describe, expect, it } from 'vitest'
import { indexSwaggerApi } from './swagger.js'

const GENERATED = `
export class Api<SecurityDataType> extends HttpClient<SecurityDataType> {
  api = {
    /**
     * No description
     *
     * @tags Case
     * @name CaseCreateCase
     * @summary 建立個案
     * @request POST:/api/v1/case/create
     * @secure
     */
    caseCreateCase: (data: X, params: RequestParams = {}) =>
      this.request({ path: \`/api/v1/case/create\`, method: "POST" }),

    /**
     * No description
     *
     * @tags Case
     * @name CaseGetCaseList
     * @request GET:/api/v1/case/list
     * @secure
     */
    caseGetCaseList: (params: RequestParams = {}) =>
      this.request({ path: \`/api/v1/case/list\`, method: "GET" }),
  }
}
`

describe('indexSwaggerApi', () => {
  const index = indexSwaggerApi(GENERATED)

  it('把 PascalCase 的 @name 轉成實際的 camelCase 屬性名', () => {
    expect([...index.keys()]).toEqual(['caseCreateCase', 'caseGetCaseList'])
  })

  it('抓出 method、URL 與中文 summary', () => {
    expect(index.get('caseCreateCase')).toEqual({
      method: 'POST',
      url: '/api/v1/case/create',
      summary: '建立個案',
      tag: 'Case'
    })
  })

  it('summary 不會從前一個區塊洩漏過來', () => {
    // 第二支端點沒有 @summary；若沒有在 /** 重置狀態，會錯掛成「建立個案」
    expect(index.get('caseGetCaseList')?.summary).toBeUndefined()
    expect(index.get('caseGetCaseList')?.method).toBe('GET')
  })
})
