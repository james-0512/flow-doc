import { describe, expect, it } from 'vitest'
import { diffFlows } from './diff.js'
import type { ManualIndex } from './manuals.js'
import { slugify } from './paths.js'
import type { ChainNode, FlowChain, TraceResult } from './types.js'

function node(name: string, line: number, extra: Partial<ChainNode> = {}): ChainNode {
  return { name, loc: { file: 'src/views/Demo/IndexView.vue', line }, endLine: line + 4, effects: [], children: [], ...extra }
}

function chain(entryId: string, root: ChainNode, extra: Partial<FlowChain> = {}): FlowChain {
  return {
    entryId,
    domain: 'Demo',
    label: entryId,
    trigger: 'click',
    entryKind: 'UI_EVENT',
    entryLoc: { file: 'src/views/Demo/IndexView.vue', line: root.loc.line },
    root,
    effects: root.effects,
    nodeCount: 1,
    maxDepth: 1,
    flowKind: 'write',
    isFlow: true,
    unresolvedCalls: 0,
    sourceHash: 'src-a',
    ...extra
  }
}

function result(chains: FlowChain[], commit = 'aaa', representation = 3): TraceResult {
  return {
    repoRoot: '/repo',
    generatedAt: '2026-07-31T00:00:00.000Z',
    analyzer: { representation, version: '0.1.0' },
    target: { commit, dirty: false },
    chains,
    crosscut: [],
    stats: {} as TraceResult['stats']
  }
}

/** 只有這些 entryId 寫過敘述 */
function manualsFor(...entryIds: string[]): ManualIndex {
  return {
    bySlug: new Map(entryIds.map(id => [slugify(id), '敘述'])),
    byCovers: new Map(),
    overviews: new Map()
  }
}

const HTTP = { kind: 'HTTP_API' as const, detail: 'POST /api/v1/demo', mutating: true, loc: { file: 'src/api/demo.ts', line: 3 } }

describe('diffFlows 五分類', () => {
  it('什麼都沒動 → unchanged', () => {
    const a = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }))
    const d = diffFlows(result([a]), result([structuredClone(a)]), manualsFor(a.entryId))
    expect(d.counts.unchanged).toBe(1)
    expect(d.verdict).toBe('no-change')
  })

  it('只有行號漂移 → moved，走 0-token 機械改寫', () => {
    const before = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }))
    const after = chain('a.vue#button.click@save', node('save', 42, { effects: [HTTP] }))
    const d = diffFlows(result([before]), result([after]), manualsFor(before.entryId))
    expect(d.counts.moved).toBe(1)
    expect(d.work.reanchor).toEqual([before.entryId])
    expect(d.work.rewrite).toEqual([])
  })

  it('呼叫結構變了 → changed', () => {
    const before = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }))
    const after = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP], children: [node('audit', 20)] }))
    const d = diffFlows(result([before]), result([after]), manualsFor(before.entryId))
    expect(d.counts.changed).toBe(1)
    expect(d.work.rewrite).toEqual([before.entryId])
  })

  it('結構相同但函式主體改了 → 仍是 changed（否則手冊會安靜地與程式碼脫節）', () => {
    const before = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }))
    const after = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }), { sourceHash: 'src-b' })
    const d = diffFlows(result([before]), result([after]), manualsFor(before.entryId))
    expect(d.counts.changed).toBe(1)
    expect(d.changes[0]?.detail).toContain('主體')
  })

  it('副作用從讀變成寫 → changed', () => {
    const before = chain('a.vue#button.click@save', node('save', 10, { effects: [{ ...HTTP, mutating: false }] }))
    const after = chain('a.vue#button.click@save', node('save', 10, { effects: [HTTP] }))
    const d = diffFlows(result([before]), result([after]), manualsFor(before.entryId))
    expect(d.counts.changed).toBe(1)
  })

  it('流程消失 → removed，有敘述才需歸檔', () => {
    const gone = chain('a.vue#button.click@save', node('save', 10))
    const kept = chain('b.vue#button.click@load', node('load', 5))
    const d = diffFlows(result([gone, kept]), result([kept]), manualsFor(gone.entryId))
    expect(d.counts.removed).toBe(1)
    expect(d.work.archive).toEqual([gone.entryId])
  })
})

describe('diffFlows 不主動補寫', () => {
  it('沒有既有敘述的流程改了也不產生工作', () => {
    const before = chain('a.vue#button.click@save', node('save', 10))
    const after = chain('a.vue#button.click@save', node('save', 10, { children: [node('x', 20)] }))
    const d = diffFlows(result([before]), result([after]), manualsFor())
    expect(d.counts.changed).toBe(1)
    expect(d.work.rewrite).toEqual([])
    expect(d.verdict).toBe('no-change')
  })

  it('新流程落在有人維護的域 → 補寫；落在沒寫過的域 → 只報告', () => {
    const existing = chain('a.vue#button.click@save', node('save', 10))
    const sameDomain = chain('a.vue#button.click@remove', node('remove', 30))
    const otherDomain = chain('z.vue#button.click@go', node('go', 3), { domain: 'Untouched' })
    const d = diffFlows(
      result([existing]),
      result([existing, sameDomain, otherDomain]),
      manualsFor(existing.entryId)
    )
    expect(d.counts.added).toBe(2)
    expect(d.work.rewrite).toEqual([sameDomain.entryId])
  })
})

describe('diffFlows 護欄', () => {
  it('表示法版本不同 → 走升版圈，不做逐條比對', () => {
    const a = chain('a.vue#button.click@save', node('save', 10))
    const d = diffFlows(result([a], 'aaa', 2), result([a], 'bbb', 3), manualsFor(a.entryId))
    expect(d.verdict).toBe('upgrade')
    expect(d.counts.changed).toBe(0)
  })

  it('重寫章數超過門檻 → 熔斷', () => {
    const before: FlowChain[] = []
    const after: FlowChain[] = []
    for (let i = 0; i < 5; i++) {
      before.push(chain(`a.vue#button.click@fn${i}`, node(`fn${i}`, 10)))
      after.push(chain(`a.vue#button.click@fn${i}`, node(`fn${i}`, 10), { sourceHash: 'moved' }))
    }
    const d = diffFlows(result(before), result(after), manualsFor(...before.map(c => c.entryId)), {
      breakerThreshold: 3
    })
    expect(d.verdict).toBe('breaker')
    expect(d.work.rewrite).toHaveLength(5)
  })

  it('dirty 的樹會被標示出來——它產出的 baseline 不可重現', () => {
    const a = chain('a.vue#button.click@save', node('save', 10))
    const current = result([a], 'bbb')
    current.target.dirty = true
    expect(diffFlows(result([a]), current, manualsFor(a.entryId)).current.dirty).toBe(true)
  })
})
