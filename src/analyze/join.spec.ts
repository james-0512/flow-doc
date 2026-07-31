import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { loadWorkspace, scanEntries } from '../workspace.js'
import type { ChainNode, FlowChain, TraceResult } from '../types.js'
import { traceEntries } from './trace.js'

const FIXTURE = fileURLToPath(new URL('../../fixtures/mini-vue', import.meta.url))

let trace: TraceResult

beforeAll(async () => {
  const ws = await loadWorkspace(loadConfig(FIXTURE))
  trace = traceEntries(ws, scanEntries(ws))
}, 60_000)

function chainOf(needle: string): FlowChain {
  const chain = trace.chains.find(c => c.entryId.includes(needle))
  expect(chain, `找不到 entry：${needle}`).toBeTruthy()
  return chain!
}

function names(node: ChainNode): string[] {
  return [
    node.name,
    ...node.children.flatMap(names),
    ...(node.asyncLinks ?? []).flatMap(l => (l.chain ? names(l.chain) : []))
  ]
}

describe('emit → parent listener 接合（階段三）', () => {
  it('純轉發的 emit handler 會起鏈，不算解析失敗', () => {
    // DemoForm 的送出鈕寫的是 @click="emit('submit')"，沒有本地邏輯。
    // 這不是「追不到」，而是一個直接跨到 parent 的斷點。
    const chain = chainOf('DemoForm.vue')
    expect(chain.root?.name).toBe("emit('submit')")
    expect(chain.root?.asyncLinks).toHaveLength(1)
  })

  it('接到 parent 的 handler，並展開 parent 那一側的完整子鏈', () => {
    const chain = chainOf('DemoForm.vue')
    const link = chain.root!.asyncLinks![0]!
    expect(link).toMatchObject({ kind: 'EMIT', event: 'submit', handlerExpr: 'onFormSubmit' })
    expect(link.from.file).toBe('src/components/Demo/DemoForm.vue')
    expect(link.to.file).toBe('src/views/Demo/IndexView.vue')
    expect(names(chain.root!)).toEqual(expect.arrayContaining(['onFormSubmit', 'save', 'submitDemo', 'createDemo']))
  })

  it('子元件的按鈕因為接上 parent 才成為一條流程', () => {
    // 這是階段三的實際價值：不接的話，DemoForm 的送出鈕只是「發了個事件」，
    // 看不出它其實會打 POST
    const chain = chainOf('DemoForm.vue')
    expect(chain.isFlow).toBe(true)
    expect(chain.effects.map(e => e.detail)).toContain('POST /api/v1/demo/create')
    expect(trace.stats.flowsGainedByJoin).toBeGreaterThan(0)
  })

  it('接不到 parent 的 emit 要被計數，不能靜默', () => {
    // UtilButton 的 emit('click') 在 opaque 白名單內，掃不到它的 template，
    // 因此不會有 listener edge 指向它
    expect(trace.stats.emitsUnjoined).toBeGreaterThan(0)
    expect(trace.stats.asyncLinksJoined).toBeGreaterThan(0)
  })

  it('v-model writeback 另計，不能混進真缺口', () => {
    // `emit('update:keyword')` 的另一端只是父層的 ref 賦值，沒有 handler 可接。
    // 把它算成缺口會讓數字誤導——這個 repo 有 41% 的 emit 屬於這一類。
    expect(trace.stats.emitsModelBinding).toBeGreaterThan(0)
  })
})
