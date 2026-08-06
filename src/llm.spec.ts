import { describe, expect, it } from 'vitest'
import { resolveProvider } from './llm.js'

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
