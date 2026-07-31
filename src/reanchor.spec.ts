import { describe, expect, it } from 'vitest'
import { buildLineMap, mergeLineMaps, reanchorManual } from './reanchor.js'
import type { ChainNode, FlowChain, SideEffect } from './types.js'

const F = 'src/views/Demo/IndexView.vue'
const API = 'src/api/demo.ts'

function effect(file: string, line: number): SideEffect {
  return { kind: 'HTTP_API', detail: 'POST /api/v1/demo', mutating: true, loc: { file, line } }
}

function node(file: string, line: number, endLine: number, extra: Partial<ChainNode> = {}): ChainNode {
  return { name: 'save', loc: { file, line }, endLine, effects: [], children: [], ...extra }
}

function chain(root: ChainNode, entryLine: number, file = F): FlowChain {
  return {
    entryId: `${file}#button.click@save`,
    domain: 'Demo',
    label: 'demo',
    trigger: 'click',
    entryKind: 'UI_EVENT',
    entryLoc: { file, line: entryLine },
    root,
    effects: root.effects,
    nodeCount: 1,
    maxDepth: 1,
    flowKind: 'write',
    isFlow: true,
    unresolvedCalls: 0,
    sourceHash: 'same'
  }
}

describe('reanchorManual', () => {
  it('整段下移時，函式內的引用依位移換算而非只改起始行', () => {
    // 函式從 100-119 移到 140-159；敘述引用的 :110 在函式中間，要變成 :150
    const before = chain(node(F, 100, 119, { effects: [effect(F, 110)] }), 145)
    const after = chain(node(F, 140, 159, { effects: [effect(F, 150)] }), 185)
    const md = [
      '**觸發**：按下確定 `src/views/Demo/IndexView.vue:145`',
      '1. **送出** `src/views/Demo/IndexView.vue:110`',
      '   表單經 `src/views/Demo/IndexView.vue:100-119` 驗證'
    ].join('\n')

    const out = reanchorManual(md, buildLineMap(before, after))
    expect(out.text).toContain('IndexView.vue:185`')
    expect(out.text).toContain('IndexView.vue:150`')
    expect(out.text).toContain('IndexView.vue:140-159`')
    expect(out.rewritten).toBe(3)
    expect(out.unmapped).toEqual([])
  })

  it('檔案改名時連路徑一起改寫', () => {
    const before = chain(node('src/views/Old/View.vue', 10, 20), 10, 'src/views/Old/View.vue')
    const after = chain(node('src/views/New/View.vue', 10, 20), 10, 'src/views/New/View.vue')
    const out = reanchorManual('見 `src/views/Old/View.vue:15`', buildLineMap(before, after))
    expect(out.text).toBe('見 `src/views/New/View.vue:15`')
  })

  it('跨檔案的副作用各自對照，不會被主體的位移帶歪', () => {
    const before = chain(node(F, 100, 119, { effects: [effect(API, 19)] }), 100)
    const after = chain(node(F, 140, 159, { effects: [effect(API, 23)] }), 140)
    const out = reanchorManual('打 `src/api/demo.ts:19`', buildLineMap(before, after))
    expect(out.text).toBe('打 `src/api/demo.ts:23`')
  })

  it('對照不到就原樣保留並回報——寧可讓 verify 抓出來，也不要猜一個合理的錯位置', () => {
    const before = chain(node(F, 100, 119), 100)
    const after = chain(node(F, 140, 159), 140)
    const out = reanchorManual('見 `src/utils/other.ts:88`', buildLineMap(before, after))
    expect(out.text).toBe('見 `src/utils/other.ts:88`')
    expect(out.unmapped).toEqual(['src/utils/other.ts:88'])
    expect(out.rewritten).toBe(0)
  })

  it('巢狀節點取最小涵蓋區間——內層才是正確的參考框架', () => {
    const inner = node(F, 105, 110)
    const before = chain(node(F, 100, 119, { children: [inner] }), 100)
    const after = chain(node(F, 200, 219, { children: [node(F, 300, 305)] }), 200)
    // :107 同時落在外層 100-119 與內層 105-110，應以內層換算 → 300 + 2
    const out = reanchorManual('見 `src/views/Demo/IndexView.vue:107`', buildLineMap(before, after))
    expect(out.text).toContain('IndexView.vue:302`')
  })

  it('不動任何非位置的文字', () => {
    const before = chain(node(F, 10, 20), 10)
    const after = chain(node(F, 30, 40), 30)
    const md = '## 流程：使用者登入\n\n這一步會寫入資料。版本 1:2 不是位置引用。'
    expect(reanchorManual(md, buildLineMap(before, after)).text).toBe(md)
  })

  it('多條鏈的對照表可以合併給同一份敘述用', () => {
    const a = buildLineMap(chain(node(F, 10, 20), 10), chain(node(F, 50, 60), 50))
    const b = buildLineMap(chain(node(API, 5, 8), 5, API), chain(node(API, 90, 93), 90, API))
    const out = reanchorManual('`src/views/Demo/IndexView.vue:12` 與 `src/api/demo.ts:6`', mergeLineMaps([a, b]))
    expect(out.text).toContain('IndexView.vue:52`')
    expect(out.text).toContain('demo.ts:91`')
  })
})
