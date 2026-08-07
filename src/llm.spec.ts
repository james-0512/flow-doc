import { describe, expect, it } from 'vitest'
import { ActionableError, describeApiError, resolveProvider } from './llm.js'

/**
 * provider 判定是「這輪要不要花錢、花誰的錢」的分岔點，而且只吃環境變數——
 * 判錯不會報錯，只會安靜地走到另一條計費路徑上，所以每個組合都釘住。
 */
describe('resolveProvider', () => {
  it('有 ANTHROPIC_API_KEY 就走 API', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'sk-ant-xxx' })).toBe('api')
  })

  it('有 ANTHROPIC_AUTH_TOKEN 也走 API（ant auth login 的短期 token）', () => {
    expect(resolveProvider({ ANTHROPIC_AUTH_TOKEN: 'oat-xxx' })).toBe('api')
  })

  it('什麼憑證都沒有就退回訂閱方案', () => {
    expect(resolveProvider({})).toBe('subscription')
  })

  it('空字串不算有設——export 了但沒填值是常見情形', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: '' })).toBe('subscription')
    expect(resolveProvider({ ANTHROPIC_API_KEY: '   ' })).toBe('subscription')
  })

  it('FLOW_DOC_LLM_PROVIDER 蓋掉自動判定，兩個方向都要能蓋', () => {
    expect(resolveProvider({ FLOW_DOC_LLM_PROVIDER: 'subscription', ANTHROPIC_API_KEY: 'sk-ant-xxx' })).toBe(
      'subscription'
    )
    // 用 ant auth login 的 profile 時環境變數是空的，但那條路已經是 API 計費，
    // 不該被退回訂閱——這就是要能強制指定 api 的原因
    expect(resolveProvider({ FLOW_DOC_LLM_PROVIDER: 'api' })).toBe('api')
  })

  it('拼錯的值直接報錯，不要靜靜地當成沒設', () => {
    expect(() => resolveProvider({ FLOW_DOC_LLM_PROVIDER: 'API' })).toThrow(/只能是 api 或 subscription/)
    expect(() => resolveProvider({ FLOW_DOC_LLM_PROVIDER: 'claude-code' })).toThrow(/收到：claude-code/)
  })
})

describe('describeApiError', () => {
  it('認證類錯誤換成三種設法的建議', () => {
    const out = describeApiError(Object.assign(new Error('401 unauthorized'), { status: 401 }))
    expect(out).toMatch(/找不到可用的憑證/)
    expect(out).toMatch(/ANTHROPIC_API_KEY/)
  })

  it('已經寫清楚該做什麼的錯誤原樣放行——即使內文含 ANTHROPIC_API_KEY', () => {
    // 這是實際踩過的坑：訂閱路徑的啟動失敗訊息裡就有這個關鍵字，
    // 沒有 ActionableError 標記的話會被上面那條規則整段蓋掉，容器的指引就消失了
    const actionable = new ActionableError('訂閱方案這條路啟動失敗。容器裡請在 .env 填 ANTHROPIC_API_KEY')
    expect(describeApiError(actionable)).toBe(actionable.message)
    expect(describeApiError(actionable)).not.toMatch(/三種設法/)
  })

  it('速率上限有自己的建議', () => {
    expect(describeApiError(Object.assign(new Error('too many'), { status: 429 }))).toMatch(/降低 --limit/)
  })
})
