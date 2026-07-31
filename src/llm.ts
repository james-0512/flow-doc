import Anthropic from '@anthropic-ai/sdk'

/**
 * 一次生成請求的結果。
 *
 * `stopReason` 要往外傳：`max_tokens` 代表被截斷（章節會缺尾巴），
 * `refusal` 代表安全分類器擋下——兩者都不是「寫壞了」，重試同樣的 prompt 沒用。
 */
export interface Completion {
  text: string
  stopReason: string | null
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** 生成函式。抽成介面是為了讓 narrate 的重試／驗證迴圈能離線測試。 */
export type Complete = (req: { system: string; user: string }) => Promise<Completion>

export interface LlmOptions {
  model: string
  effort: string
  maxTokens: number
}

export const defaultLlmOptions: LlmOptions = {
  // 預設用最新的 Opus。手冊敘述要讀懂整條鏈的原始碼再改寫成業務語言，
  // 是這條管線裡唯一需要判斷力的一步，不該為了省成本降級
  model: 'claude-opus-5',
  effort: 'high',
  /**
   * 這個預算是**思考＋輸出共用**的（Opus 5 起思考預設開啟），所以要給足餘裕。
   * 給太少的症狀是章節寫到一半斷掉，而且 stop_reason 才看得出來。
   */
  maxTokens: 32_000
}

/**
 * 建立呼叫 Claude 的生成函式。
 *
 * 三個刻意的選擇：
 * - **串流**：單章可能要輸出數千 token 加上思考，非串流容易撞 HTTP timeout。
 * - **快取 system**：硬規則每章都一樣，用 `cache_control` 讓它只算一次全價。
 * - **`fallbacks: 'default'`**：安全分類器偶爾會誤擋（手冊裡有登入、權限、
 *   帳號鎖定這類字眼），沒有 fallback 的話那一章就直接失敗。
 */
export function createComplete(options: LlmOptions = defaultLlmOptions): Complete {
  const client = new Anthropic()
  return async ({ system, user }) => {
    const stream = client.beta.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: options.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }]
    })
    const message = await stream.finalMessage()
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    return {
      text,
      stopReason: message.stop_reason,
      usage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: message.usage.cache_creation_input_tokens ?? 0
      }
    }
  }
}

/**
 * 把 API 錯誤轉成可行動的訊息。
 *
 * 沒設憑證是最常見的第一次失敗，而 SDK 的預設錯誤只說 401——對著一堆 stack trace
 * 沒人知道要去設什麼。認證問題直接講清楚兩種設法。
 */
export function describeApiError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const status = (err as { status?: number } | null)?.status
  if (status === 401 || /api[_ ]?key|authentication/i.test(message)) {
    return (
      `呼叫 API 失敗：找不到可用的憑證。\n` +
      `  兩種設法（擇一）：\n` +
      `    1. 匯出 ANTHROPIC_API_KEY 環境變數\n` +
      `    2. 安裝 Anthropic CLI 後執行 ant auth login（SDK 會自動讀取登入後的 profile）\n` +
      `  原始訊息：${message}`
    )
  }
  if (status === 429) return `達到速率上限，稍後再試或降低 --limit。原始訊息：${message}`
  return `呼叫 API 失敗：${message}`
}

/** 估算輸入 token 數，給 `--dry-run` 用——先看清楚要花多少再決定要不要跑。 */
export async function countInputTokens(
  system: string,
  user: string,
  model: string = defaultLlmOptions.model
): Promise<number> {
  const client = new Anthropic()
  const result = await client.messages.countTokens({
    model,
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: user }]
  })
  return result.input_tokens
}
