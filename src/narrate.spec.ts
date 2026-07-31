import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Complete, Completion } from './llm.js'
import {
  buildRetryPrompt,
  buildSystemPrompt,
  findSkillRules,
  narrateChapter,
  withExistingFrontmatter
} from './narrate.js'
import type { Violation } from './verify.js'

const REPO = fileURLToPath(new URL('../fixtures/mini-vue', import.meta.url))

/** 沒有寫入型副作用的封包——章節不引用任何位置就能通過驗證 */
const PACKET = `# 流程封包：src/views/Demo/IndexView.vue <button @click>

- 分類：**寫入型流程**
- 觸發點：\`src/views/Demo/IndexView.vue:2\`

## 副作用彙總

- [Store] demo.loadDemo  \`src/views/Demo/IndexView.vue:19\`
`

const CLEAN = '## 流程：使用者存檔\n\n**觸發**：按下存檔鈕\n'
const BAD = '## 流程：使用者存檔\n\n**觸發**：見 `src/views/Nope.vue:9`\n'

function usage(): Completion['usage'] {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
}

/** 依序回傳預先排好的產出，並記錄每次收到的 prompt */
function fakeComplete(replies: Partial<Completion>[]): Complete & { prompts: string[] } {
  const prompts: string[] = []
  let i = 0
  const fn = async ({ user }: { system: string; user: string }): Promise<Completion> => {
    prompts.push(user)
    const reply = replies[Math.min(i++, replies.length - 1)]!
    return { text: reply.text ?? CLEAN, stopReason: reply.stopReason ?? 'end_turn', usage: usage() }
  }
  return Object.assign(fn, { prompts })
}

describe('narrateChapter', () => {
  it('一次就通過驗證', async () => {
    const complete = fakeComplete([{ text: CLEAN }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete)
    expect(out.ok).toBe(true)
    expect(out.attempts).toBe(1)
    expect(out.text).toBe(CLEAN.trim())
  })

  it('驗證失敗時把違規餵回去，修好就通過', async () => {
    const complete = fakeComplete([{ text: BAD }, { text: CLEAN }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete)
    expect(out.ok).toBe(true)
    expect(out.attempts).toBe(2)
    // 第二次的 prompt 要帶著具體的違規，而不是泛泛地叫它重寫
    expect(complete.prompts[1]).toContain('src/views/Nope.vue:9')
    expect(complete.prompts[1]).toContain('沒有通過驗證')
  })

  it('重試用完仍不過 → 回報失敗，由呼叫端降級（絕不寫入）', async () => {
    const complete = fakeComplete([{ text: BAD }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete, {
      retries: 2
    })
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(3)
    expect(out.violations.length).toBeGreaterThan(0)
  })

  it('被 max_tokens 截斷不重試——同樣的 prompt 再送一次結果一樣，只是白花錢', async () => {
    const complete = fakeComplete([{ text: BAD, stopReason: 'max_tokens' }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete)
    expect(out.ok).toBe(false)
    expect(out.attempts).toBe(1)
    expect(out.stopReason).toBe('max_tokens')
    expect(complete.prompts).toHaveLength(1)
  })

  it('被安全分類器擋下也不重試', async () => {
    const complete = fakeComplete([{ text: '', stopReason: 'refusal' }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete)
    expect(out.ok).toBe(false)
    expect(out.stopReason).toBe('refusal')
    expect(complete.prompts).toHaveLength(1)
  })

  it('token 用量跨重試累加，成本才看得準', async () => {
    const complete = fakeComplete([{ text: BAD }, { text: CLEAN }])
    const out = await narrateChapter({ packet: PACKET, repoRoot: REPO, system: 'rules' }, complete)
    expect(out.usage.input).toBe(20)
    expect(out.usage.output).toBe(10)
  })
})

describe('buildRetryPrompt', () => {
  const uncited: Violation = {
    kind: 'UNCITED_EFFECT',
    reference: 'POST /api/v1/demo',
    detail: '封包標為寫入但敘述沒提到'
  }
  const notInPacket: Violation = {
    kind: 'NOT_IN_PACKET',
    reference: '`src/a.ts:9`',
    detail: '此位置不在封包提供的範圍內'
  }

  it('漏寫副作用要說「補」，不能講成刪——講反了會越修越糟', () => {
    const prompt = buildRetryPrompt(CLEAN, [uncited])
    expect(prompt).toContain('漏寫')
    expect(prompt).toContain('補進步驟')
  })

  it('引用造假要說「改或刪」', () => {
    expect(buildRetryPrompt(CLEAN, [notInPacket])).toContain('未追蹤')
  })

  it('同時出現兩類時各給各的修法', () => {
    const prompt = buildRetryPrompt(CLEAN, [uncited, notInPacket])
    expect(prompt).toContain('UNCITED_EFFECT')
    expect(prompt).toContain('NOT_IN_PACKET')
  })
})

describe('buildSystemPrompt', () => {
  it('保留 SKILL.md 的硬規則原文，只加無人值守的輸出約定', () => {
    const skill = '---\nname: flow-manual\n---\n\n## 硬規則\n\n1. 只根據封包裡的原始碼。\n'
    const system = buildSystemPrompt(skill)
    expect(system).toContain('只根據封包裡的原始碼')
    expect(system).not.toContain('name: flow-manual')
    expect(system).toContain('無人值守模式')
  })
})

describe('findSkillRules', () => {
  it('CWD 沒有時退回工具自帶的那份，新手冊 repo 不必先複製 skill 就能跑', () => {
    expect(findSkillRules(undefined, '/nowhere-at-all')).toMatch(/flow-manual[/\\]SKILL\.md$/)
  })

  it('明確指定但檔案不存在時，錯誤要指出找過哪些位置', () => {
    expect(() => findSkillRules('/nope/SKILL.md')).toThrow(/找過/)
  })
})

describe('withExistingFrontmatter', () => {
  it('保留既有 covers:，模型不該重新產生作者的宣告', () => {
    const existing = '---\ncovers:\n  - a.vue#button.click@save\n---\n\n舊內文\n'
    const out = withExistingFrontmatter(existing, '新內文')
    expect(out).toContain('covers:')
    expect(out).toContain('a.vue#button.click@save')
    expect(out).toContain('新內文')
    expect(out).not.toContain('舊內文')
  })

  it('沒有既有檔案時就只有內文', () => {
    expect(withExistingFrontmatter(null, '內文')).toBe('內文\n')
  })
})
