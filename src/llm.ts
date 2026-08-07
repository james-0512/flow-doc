import Anthropic from '@anthropic-ai/sdk'
import type { EffortLevel, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

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
 * 生成走哪條路。
 *
 * - `api`：`@anthropic-ai/sdk` 直接打 API，按 token 計費。功能最全。
 * - `subscription`：`@anthropic-ai/claude-agent-sdk` 的 `query()`，跑在本機
 *   Claude Code 的登入憑證上，額度算在訂閱方案裡。
 */
export type LlmProvider = 'api' | 'subscription'

/**
 * 訊息本身已經寫清楚該做什麼的錯誤。
 *
 * `describeApiError` 會用關鍵字猜錯誤類型再換成建議訊息，而這類錯誤的內文本來就
 * 含有 `ANTHROPIC_API_KEY` 這種關鍵字——不特別標記的話會被它整段蓋掉。
 */
export class ActionableError extends Error {
  override readonly name = 'ActionableError'
}

/**
 * 決定用哪個 provider：有 API 憑證就走 API，沒有就退回訂閱方案。
 *
 * 判斷只看**環境變數**，不看 `ant auth login` 的 profile——profile 是給 SDK 自己
 * 解析的，這裡看不到，而且那條路已經是 API 計費，退回訂閱反而是降級。用
 * `FLOW_DOC_LLM_PROVIDER` 明確指定可以蓋掉自動判斷（profile 使用者就設 `api`）。
 *
 * ⚠ 訂閱方案這條路是給**本機自己跑**用的。Anthropic 的條款不允許第三方開發者
 * 在自己的產品裡提供 claude.ai 登入或額度給別人用（見 Agent SDK 文件），
 * 所以不要把它接進共用 CI 或交給同事用同一組訂閱跑。
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const forced = env.FLOW_DOC_LLM_PROVIDER?.trim()
  if (forced === 'api' || forced === 'subscription') return forced
  if (forced) {
    throw new Error(`FLOW_DOC_LLM_PROVIDER 只能是 api 或 subscription，收到：${forced}`)
  }
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) return 'api'
  return 'subscription'
}

/** 依環境挑一條路。呼叫端不需要知道差別——兩邊都回同一個 `Complete`。 */
export function createComplete(options: LlmOptions = defaultLlmOptions): Complete {
  return resolveProvider() === 'subscription'
    ? createSubscriptionComplete(options)
    : createApiComplete(options)
}

/**
 * API 路徑：直接打 Messages API。
 *
 * 三個刻意的選擇：
 * - **串流**：單章可能要輸出數千 token 加上思考，非串流容易撞 HTTP timeout。
 * - **快取 system**：硬規則每章都一樣，用 `cache_control` 讓它只算一次全價。
 * - **`fallbacks: 'default'`**：安全分類器偶爾會誤擋（手冊裡有登入、權限、
 *   帳號鎖定這類字眼），沒有 fallback 的話那一章就直接失敗。
 */
export function createApiComplete(options: LlmOptions = defaultLlmOptions): Complete {
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
 * 訂閱路徑：借 Claude Code 的 agent harness 當單次生成器。
 *
 * `query()` 本來是拿來跑 agent 迴圈的（會讀檔、跑指令、開 subagent），這裡要的
 * 只是「system ＋ user → 一段文字」，所以四個設定缺一不可：
 *
 * - `allowedTools: []` ＋ `permissionMode: 'dontAsk'`：一個工具都不給，
 *   要用也直接拒絕（不會停在那裡等人按同意，批次跑會卡死）
 * - `maxTurns: 1`：不讓它自己多跑幾輪
 * - `settingSources: []`：**最容易漏掉的一個**。不設的話 harness 會照 CLI 的
 *   預設載入 cwd 的 `.claude/`——而 narrate 的 cwd 正好是手冊 repo，那裡有
 *   flow-manual skill 與 CLAUDE.md。載進來等於兩條路的 system prompt 不一樣，
 *   而且不會報錯，只會安靜地寫出不同風格的章節。
 *
 * 動態 import：這個套件的平台 binary 有 267 MB，只在真的用到時才載。
 *
 * ⚠ `options.maxTokens` 在這條路上**無效**——Agent SDK 的 Options 沒有輸出上限這個
 *   欄位（只有 maxThinkingTokens／maxTurns／maxBudgetUsd）。兩條路因此可能在
 *   「章節寫多長」上有差異，調 `--max-tokens` 只會影響 API 路徑。
 */
export function createSubscriptionComplete(options: LlmOptions = defaultLlmOptions): Complete {
  return async ({ system, user }) => {
    let assistantText = ''
    let result: SDKResultMessage | null = null

    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      for await (const message of query({
        prompt: user,
        options: {
          model: options.model,
          systemPrompt: system,
          effort: options.effort as EffortLevel,
          maxTurns: 1,
          allowedTools: [],
          permissionMode: 'dontAsk',
          settingSources: []
        }
      })) {
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') assistantText += block.text
          }
        } else if (message.type === 'result') {
          result = message
        }
      }
    } catch (err) {
      // 這條路要有平台 binary 才動得了，而 ANTHROPIC_API_KEY 空著就會被 resolveProvider
      // 選中並落到這裡。底層錯誤是「找不到執行檔」之類的訊息，看不出真正該做什麼。
      //
      // 容器裡最常見的成因是**改了 .env 卻沒重建 image**：WITH_SUBSCRIPTION 是 build arg，
      // 而 `docker compose run` 只要 image 在就直接用，不會因為 arg 變了而重建。
      throw new ActionableError(
        `訂閱方案這條路啟動失敗（找不到 Claude Code 的平台 binary 或無法啟動）。\n` +
          `  本機：要先登入 Claude Code，且 node_modules 裝了平台 binary（別用 --no-optional）。\n` +
          `  容器：.env 要有 WITH_SUBSCRIPTION=1 與 CLAUDE_CODE_OAUTH_TOKEN，\n` +
          `        而且**改完要重建 image**——WITH_SUBSCRIPTION 是 build arg，\n` +
          `        docker compose run 不會自己重建：pnpm docker:build（D16）。\n` +
          `  或者改走 API 計費：在 .env 填 ANTHROPIC_API_KEY。\n` +
          `  原始訊息：${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }

    if (!result) {
      throw new Error('claude-agent-sdk 沒有回傳 result 訊息——這一輪沒有產出可用的內容')
    }
    if (result.subtype !== 'success') {
      // 出錯也把已經寫出來的文字帶回去：narrate 的降級路徑會拿它跟 verify 比對，
      // 半章總比空白好判斷
      throw new Error(
        `claude-agent-sdk 未能完成（${result.subtype}）：${result.errors.join('；') || '沒有更多訊息'}`
      )
    }

    return {
      text: result.result || assistantText,
      // 兩種 result 都帶 stop_reason，所以 max_tokens／refusal 的判斷與 API 路徑一致
      stopReason: result.stop_reason,
      usage: {
        input: result.usage.input_tokens,
        output: result.usage.output_tokens,
        cacheRead: result.usage.cache_read_input_tokens ?? 0,
        cacheWrite: result.usage.cache_creation_input_tokens ?? 0
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
  // 已經寫清楚該做什麼的，原樣放行——底下的關鍵字比對會誤判它的內文
  if (err instanceof ActionableError) return message
  const status = (err as { status?: number } | null)?.status
  if (status === 401 || /api[_ ]?key|authentication|oauth|not logged in/i.test(message)) {
    return (
      `呼叫 API 失敗：找不到可用的憑證。\n` +
      `  三種設法（擇一）：\n` +
      `    1. 匯出 ANTHROPIC_API_KEY 環境變數\n` +
      `    2. 安裝 Anthropic CLI 後執行 ant auth login（SDK 會自動讀取登入後的 profile）\n` +
      `    3. 本機已登入 Claude Code 的話，不設任何憑證即可自動走訂閱方案\n` +
      `       （目前判定為 ${resolveProvider()}；用 FLOW_DOC_LLM_PROVIDER 可強制指定）\n` +
      `  原始訊息：${message}`
    )
  }
  if (status === 429) return `達到速率上限，稍後再試或降低 --limit。原始訊息：${message}`
  return `呼叫 API 失敗：${message}`
}

/**
 * 估算輸入 token 數，給 `--dry-run` 用——先看清楚要花多少再決定要不要跑。
 *
 * `count_tokens` 是 API 端點，訂閱路徑沒有 API 憑證可用，所以那條路退回字元數
 * 粗估並標記 `estimated`。呼叫端要把這個旗標顯示出來：一個沒標的估計值會被
 * 當成真實 token 數拿去算錢。
 */
export async function countInputTokens(
  system: string,
  user: string,
  model: string = defaultLlmOptions.model
): Promise<{ tokens: number; estimated: boolean }> {
  if (resolveProvider() === 'subscription') {
    // 中英混排的手冊內容，每 token 約 2.5 個字元。只用來看數量級
    return { tokens: Math.round((system.length + user.length) / 2.5), estimated: true }
  }
  const client = new Anthropic()
  const result = await client.messages.countTokens({
    model,
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: user }]
  })
  return { tokens: result.input_tokens, estimated: false }
}
