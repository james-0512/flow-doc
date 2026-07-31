import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { loadWorkspace, scanEntries } from '../workspace.js'
import type { ChainNode, EntryScanResult, FlowChain, TraceResult } from '../types.js'
import { traceEntries } from './trace.js'

/**
 * 端到端跑一次小 fixture 專案。真實 repo 驗「有沒有用」，fixture 驗「有沒有壞」——
 * 這裡釘住的是後者：整條 SFC → store → api → HTTP 的鏈與副作用標記。
 */
const FIXTURE = fileURLToPath(new URL('../../fixtures/mini-vue', import.meta.url))

let scan: EntryScanResult
let trace: TraceResult

beforeAll(async () => {
  const ws = await loadWorkspace(loadConfig(FIXTURE))
  scan = scanEntries(ws)
  trace = traceEntries(ws, scan)
}, 60_000)

function chainOf(needle: string): FlowChain {
  const chain = trace.chains.find(c => c.entryId.includes(needle))
  expect(chain, `找不到 entry：${needle}`).toBeTruthy()
  return chain!
}

function names(node: ChainNode): string[] {
  return [node.name, ...node.children.flatMap(names)]
}

describe('entry 偵測（fixture）', () => {
  it('原生 button 是 entry，Utils 元件事件回退成 entry，可分析元件是 listener', () => {
    const view = scan.entries.filter(e => e.file === 'src/views/Demo/IndexView.vue')
    expect(view.map(e => [e.kind, e.tag, e.origin])).toEqual(
      expect.arrayContaining([
        ['UI_EVENT', 'button', 'native'],
        ['UI_EVENT', 'UtilButton', 'opaque-component'],
        ['LIFECYCLE', undefined, undefined]
      ])
    )
    expect(scan.listeners.map(l => [l.tag, l.event, l.toComponent])).toEqual([
      ['DemoForm', 'submit', 'src/components/Demo/DemoForm.vue']
    ])
  })

  it('路由的懶載入常數解析得到元件', () => {
    const route = scan.entries.find(e => e.kind === 'ROUTE')
    expect(route?.routeComponent).toBe('src/views/Demo/IndexView.vue')
    expect(route?.domain).toBe('Demo')
  })
})

describe('call chain 追蹤（fixture）', () => {
  it('save 追穿 SFC → store → api → HTTP，且標記為一條流程', () => {
    const chain = chainOf('IndexView.vue:2:button:click')
    expect(chain.isFlow).toBe(true)
    expect(names(chain.root!)).toEqual(expect.arrayContaining(['save', 'submitDemo', 'createDemo']))

    const http = chain.effects.find(e => e.kind === 'HTTP_API')
    expect(http).toMatchObject({ detail: 'POST /api/v1/demo/create', mutating: true, guarded: true })
    expect(http?.loc.file).toBe('src/api/demo.ts')
  })

  it('router 導航與 store 呼叫都記成副作用', () => {
    const chain = chainOf('IndexView.vue:2:button:click')
    expect(chain.effects.map(e => [e.kind, e.detail])).toEqual(
      expect.arrayContaining([
        ['ROUTER_NAV', 'DemoDone'],
        ['STORE', 'demo.submitDemo']
      ])
    )
  })

  it('opaque 層記錄但不展開', () => {
    const chain = chainOf('IndexView.vue:2:button:click')
    expect(chain.effects.find(e => e.kind === 'OPAQUE')?.detail).toContain('formatName')
    expect(names(chain.root!)).not.toContain('formatName')
  })

  it('頁面載入只讀後端，算查詢型流程而非排除', () => {
    // 判準是「有沒有跨越 HTTP 邊界」而非「有沒有寫入」——只收寫入的話，
    // 「進入這頁會發生什麼」永遠不會進手冊
    const chain = chainOf('onMounted')
    expect(chain.flowKind).toBe('read')
    expect(chain.isFlow).toBe(true)
    expect(chain.effects.find(e => e.kind === 'HTTP_API')).toMatchObject({
      detail: 'GET /api/v1/demo/list',
      mutating: false
    })
  })

  it('完全沒碰後端的純 UI 操作仍被排除', () => {
    const none = trace.chains.filter(c => c.flowKind === 'none')
    expect(none.length).toBeGreaterThan(0)
    expect(none.every(c => !c.effects.some(e => e.kind === 'HTTP_API'))).toBe(true)
  })

  it('寫入型與查詢型要分得開', () => {
    expect(chainOf('IndexView.vue:2:button:click').flowKind).toBe('write')
  })

  it('handler 行號指回 .vue，不是虛擬檔', () => {
    const chain = chainOf('IndexView.vue:2:button:click')
    expect(chain.root!.loc.file).toBe('src/views/Demo/IndexView.vue')
    expect(chain.root!.loc.line).toBe(19)
  })
})
