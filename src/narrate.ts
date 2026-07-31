import fs from 'node:fs'
import path from 'node:path'
import { describeApiError, type Complete } from './llm.js'
import { manualFileFor, stripFrontmatter, type ManualIndex } from './manuals.js'
import { slugify } from './paths.js'
import type { TraceResult } from './types.js'
import { verifyManual, type Violation } from './verify.js'

/**
 * 找到 flow-manual skill 的規則檔。
 *
 * **規則只有一份。** 互動式（Claude Code session 讀 SKILL.md）與無人值守
 * （這裡把它當 system prompt）必須共用同一個檔案——兩邊各寫一份硬規則的話，
 * 手冊會依「誰寫的」而有不同的可信度標準，而且沒人會發現。
 */
export function findSkillRules(explicit?: string, cwd = process.cwd()): string {
  const candidates = explicit
    ? [explicit]
    : [
        path.join(cwd, '.claude/skills/flow-manual/SKILL.md'),
        path.join(cwd, '../.claude/skills/flow-manual/SKILL.md'),
        // 工具自帶的那份，供還沒複製 skill 的手冊 repo 使用
        path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '.claude/skills/flow-manual/SKILL.md')
      ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  throw new Error(
    `找不到 flow-manual 的 SKILL.md。用 --skill 指定，或把它放在 .claude/skills/flow-manual/ 下。\n` +
      `找過：\n${candidates.map(c => `  ${c}`).join('\n')}`
  )
}

/**
 * 把 SKILL.md 轉成 system prompt。
 *
 * 附加段落只講「無人值守模式的輸出約定」——硬規則本身一個字都不改寫，
 * 否則兩條路徑的判準就開始漂移了。
 */
export function buildSystemPrompt(skillMarkdown: string): string {
  return `${stripFrontmatter(skillMarkdown)}

---

## 無人值守模式

你現在不是在對話裡工作，輸出會被直接寫進 \`manuals/<slug>.md\` 並送去驗證。

- **只輸出章節本身的 Markdown**，從 \`## 流程：\` 開始。不要加開場白、結語、
  「以下是…」之類的話，也不要把整份內容包在 \`\`\` 圍欄裡（章節內部的序列圖與
  程式碼片段當然還是要用圍欄）。
- **不要寫 frontmatter**（\`---\` 區塊）。\`covers:\` 由呼叫端保留與管理。
- 你無法提問。封包資訊不足時，照硬規則第 3 條標為「未追蹤」，不要猜。`
}

/** 首次生成的 user prompt。 */
export function buildUserPrompt(packet: string): string {
  return `以下是流程封包。依系統提示的規則，把它改寫成一份手冊章節。\n\n${packet}`
}

/**
 * 驗證失敗後的重試 prompt。
 *
 * 把 verify 的違規原文餵回去，而不是泛泛地說「再寫一次」——違規訊息已經指名
 * 哪個引用有問題，模型據此修比重寫整章準確得多，也省 token。
 */
/** 每種違規的修法不同——漏寫副作用要**補**，引用造假要**刪或改**，講反了會越修越糟。 */
const FIX_BY_KIND: Record<Violation['kind'], string> = {
  MISSING_FILE: '引用的檔案不存在。改成封包裡確實出現過的位置。',
  LINE_OUT_OF_RANGE: '行號超出該檔案的範圍。改用封包裡標示的行號，不要自己推算。',
  NOT_IN_PACKET:
    '這個位置不在封包提供的範圍內。改成封包裡確實存在的位置，或把該處敘述改寫成不需要引用的說法（例如標為「未追蹤」）。',
  UNCITED_EFFECT:
    '**這是漏寫，不是多寫。** 封包標為寫入的副作用，敘述必須提到——少寫一支寫入 API，讀者會以為那個副作用不存在。把它補進步驟與「資料變化」表。',
  STALE_SOURCE: '引用的位置與封包附的原始碼對不上。以封包的原始碼為準。'
}

export function buildRetryPrompt(previous: string, violations: Violation[]): string {
  const list = violations.map(v => `- \`${v.reference}\` — ${v.detail}`).join('\n')
  const kinds = [...new Set(violations.map(v => v.kind))]
  const fixes = kinds.map(k => `- **${k}**：${FIX_BY_KIND[k]}`).join('\n')
  return `你剛才產出的章節沒有通過驗證：

${list}

怎麼修：

${fixes}

其餘內容保持不變，重新輸出**完整**章節。

你剛才的產出：

${previous}`
}

export interface NarrateOutcome {
  /** 通過驗證的章節內容；沒通過時是最後一次的產出 */
  text: string
  ok: boolean
  attempts: number
  /** 最後一次驗證的違規；ok 時為空 */
  violations: Violation[]
  /** 非正常結束的原因：被截斷、被安全分類器擋下 */
  stopReason: string | null
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface NarrateOptions {
  /** 驗證失敗後最多重試幾次。預設 2 */
  retries: number
}

export const defaultNarrateOptions: NarrateOptions = { retries: 2 }

/**
 * 產出一章敘述，並以 verify 當驗收關。
 *
 * 迴圈是「生成 → 驗證 → 把違規餵回去重生」，最多重試 `retries` 次。
 * 仍不過就**回報失敗、不寫入**——由呼叫端降級成「分析已更新、敘述待補」。
 * 寧可少一章，也不要讓引用造假的敘述進到手冊裡：整個專案的可信度就靠這一關。
 *
 * `max_tokens` 截斷與安全分類器擋下都不重試——同樣的 prompt 再送一次結果一樣，
 * 只是白花錢。這兩種情形直接把 stopReason 往外拋，讓人看得到真正的原因。
 */
export async function narrateChapter(
  input: { packet: string; repoRoot: string; system: string },
  complete: Complete,
  options: NarrateOptions = defaultNarrateOptions
): Promise<NarrateOutcome> {
  let user = buildUserPrompt(input.packet)
  let last = ''
  let violations: Violation[] = []
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  for (let attempt = 1; attempt <= options.retries + 1; attempt++) {
    const result = await complete({ system: input.system, user })
    total.input += result.usage.input
    total.output += result.usage.output
    total.cacheRead += result.usage.cacheRead
    total.cacheWrite += result.usage.cacheWrite
    last = result.text.trim()

    if (result.stopReason === 'max_tokens' || result.stopReason === 'refusal') {
      return { text: last, ok: false, attempts: attempt, violations: [], stopReason: result.stopReason, usage: total }
    }

    const check = verifyManual(last, input.repoRoot, input.packet)
    violations = check.violations
    if (violations.length === 0) {
      return { text: last, ok: true, attempts: attempt, violations: [], stopReason: result.stopReason, usage: total }
    }
    user = buildRetryPrompt(last, violations)
  }

  return { text: last, ok: false, attempts: options.retries + 1, violations, stopReason: null, usage: total }
}

/**
 * 保留既有 frontmatter，只換內文。
 *
 * `covers:` 是作者對「這份敘述涵蓋哪些流程」的宣告，可稽核且刻意不靠猜——
 * 重寫內文時不該由模型重新產生它。
 */
export function withExistingFrontmatter(existing: string | null, body: string): string {
  if (!existing) return `${body}\n`
  const frontmatter = /^---\n[\s\S]*?\n---\n*/.exec(existing)
  return frontmatter ? `${frontmatter[0]}${body}\n` : `${body}\n`
}

/**
 * 一批章節的生成結果。**每個目標必須落在 written／degraded／skipped 其中一格**——
 * 少一格就是靜默截斷，上層會以為那章處理過了，待補佇列也不會接住它。
 */
export interface NarrateRunSummary {
  written: { entryId: string; file: string }[]
  degraded: { entryId: string; detail: string; violations: Violation[] }[]
  skipped: { entryId: string; detail: string }[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** API 層失敗（憑證、額度、網路）。已寫入的保留，未處理的落在 skipped */
  aborted?: string
}

export interface NarrateRunProgress {
  start(slug: string): void
  done(line: string, violations?: Violation[]): void
  skip?(slug: string, detail: string): void
}

/**
 * 逐章生成敘述並寫入手冊目錄。`narrate` 指令與閉環的 `loop` 共用。
 *
 * 驗證不過就不寫入——降級成「分析已更新、敘述待補」，site 本來就容忍此狀態。
 * API 層錯誤不重試也不吞掉：已寫入的章節保留（中途失敗不該讓前面成功的白做），
 * 其餘目標標為 skipped 並帶上原因，由呼叫端決定進佇列或直接報錯。
 */
export async function narrateTargets(
  targets: string[],
  ctx: { current: TraceResult; index: ManualIndex; manualsDir: string; packetsDir: string; system: string },
  complete: Complete,
  options: { retries: number; limit?: number; progress?: NarrateRunProgress }
): Promise<NarrateRunSummary> {
  const summary: NarrateRunSummary = {
    written: [],
    degraded: [],
    skipped: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
  const byId = new Map([...ctx.current.chains, ...ctx.current.crosscut].map(c => [c.entryId, c]))

  // 上限必須看得見。靜默截斷會讓人以為「全部寫完了」
  const todo = options.limit != null ? targets.slice(0, options.limit) : targets
  for (const entryId of targets.slice(todo.length)) {
    summary.skipped.push({ entryId, detail: `--limit ${options.limit} 略過，下輪再跑` })
  }

  for (let i = 0; i < todo.length; i++) {
    const entryId = todo[i]!
    const chain = byId.get(entryId)
    const slug = slugify(entryId)
    if (!chain) {
      summary.skipped.push({ entryId, detail: '不在本次分析結果中' })
      options.progress?.skip?.(slug, '不在本次分析結果中')
      continue
    }
    const packetFile = path.join(ctx.packetsDir, `${slug}.md`)
    if (!fs.existsSync(packetFile)) {
      summary.skipped.push({ entryId, detail: '找不到封包' })
      options.progress?.skip?.(slug, '找不到封包')
      continue
    }
    const packet = fs.readFileSync(packetFile, 'utf8')

    const target = manualFileFor(ctx.index, entryId) ?? `${slug}.md`
    const abs = path.join(ctx.manualsDir, target)
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null

    options.progress?.start(slug)
    let outcome: NarrateOutcome
    try {
      outcome = await narrateChapter(
        { packet, repoRoot: ctx.current.repoRoot, system: ctx.system },
        complete,
        { retries: options.retries }
      )
    } catch (err) {
      // API 層失敗：同一輪剩下的章節不再嘗試（多半是同一個原因），全部交代下落
      summary.aborted = describeApiError(err)
      options.progress?.done(`中斷 — ${summary.aborted.split('\n')[0]}`)
      for (const rest of todo.slice(i)) {
        summary.skipped.push({ entryId: rest, detail: `API 失敗：${summary.aborted}` })
      }
      break
    }
    summary.usage.input += outcome.usage.input
    summary.usage.output += outcome.usage.output
    summary.usage.cacheRead += outcome.usage.cacheRead
    summary.usage.cacheWrite += outcome.usage.cacheWrite

    if (outcome.ok) {
      fs.writeFileSync(abs, withExistingFrontmatter(existing, outcome.text), 'utf8')
      summary.written.push({ entryId, file: target })
      options.progress?.done(`通過（第 ${outcome.attempts} 次）`)
      continue
    }
    // 驗證不過就不寫入——寧可少一章，也不要讓引用造假的敘述進手冊
    const why =
      outcome.stopReason === 'max_tokens'
        ? '輸出被 max_tokens 截斷（調高 --max-tokens）'
        : outcome.stopReason === 'refusal'
          ? '被安全分類器擋下'
          : `${outcome.attempts} 次都沒通過驗證（${outcome.violations.length} 處問題）`
    summary.degraded.push({ entryId, detail: why, violations: outcome.violations })
    options.progress?.done(`未寫入 — ${why}`, outcome.violations)
  }
  return summary
}
