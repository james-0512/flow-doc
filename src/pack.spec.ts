import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packetCoverage, writePackets } from './pack.js'
import { slugify } from './paths.js'
import { clearSourceCache } from './source.js'
import type { ChainNode, FlowChain, TraceResult } from './types.js'

const FILE = 'src/views/Demo/IndexView.vue'

function node(name: string, line: number): ChainNode {
  return { name, loc: { file: FILE, line }, endLine: line + 2, effects: [], children: [] }
}

function chain(entryId: string, root: ChainNode, extra: Partial<FlowChain> = {}): FlowChain {
  return {
    entryId,
    domain: 'Demo',
    label: entryId,
    trigger: 'click',
    entryKind: 'UI_EVENT',
    entryLoc: { file: FILE, line: root.loc.line },
    root,
    effects: [{ kind: 'HTTP_API', detail: 'POST /api/v1/demo', mutating: true, loc: { file: FILE, line: root.loc.line } }],
    nodeCount: 1,
    maxDepth: 1,
    flowKind: 'write',
    isFlow: true,
    unresolvedCalls: 0,
    sourceHash: 'src-a',
    ...extra
  }
}

let repoRoot: string
let outDir: string

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-doc-pack-'))
  outDir = path.join(repoRoot, 'packets')
  fs.mkdirSync(path.join(repoRoot, path.dirname(FILE)), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, FILE), Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join('\n'))
  clearSourceCache()
})

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true })
  clearSourceCache()
})

function trace(chains: FlowChain[], crosscut: FlowChain[] = []): TraceResult {
  return {
    repoRoot,
    generatedAt: '2026-08-13T00:00:00.000Z',
    analyzer: { representation: 4, version: '0.2.0' },
    target: { commit: 'aaa', dirty: false },
    chains,
    crosscut,
    stats: {} as TraceResult['stats']
  }
}

/**
 * `packetCoverage` 是 diff 唯一的封包依據，它說有就必須真的有、說沒有就必須真的沒有。
 *
 * 這兩者一旦分岔，症狀不會出現在 pack，而是出現在**下游的 narrate**：它拿著
 * 沒有對應檔案的 entryId 去讀封包，回報「找不到封包」，條目退回待人工佇列，
 * 下一輪再排一次——永遠不會成功也永遠不會消失。所以要用實際落地的檔案來比對，
 * 不是比對兩個函式的內部邏輯。
 */
describe('packetCoverage 與實際寫出的封包一致', () => {
  it('代表有檔案、被併掉的觸發點沒有、非流程沒有', () => {
    const search = node('search', 100)
    const chains = [
      chain('a.vue#UtilButton.click@search', search),
      // 同檔同行 ＝ 同一支 handler，敘述由代表那一章涵蓋
      chain('a.vue#UtilDatepicker.change@search', node('search', 100), { trigger: 'change' }),
      chain('a.vue#UtilTable.change-page@search', node('search', 100), { trigger: 'change-page' }),
      // 純 UI 操作，設計上就不進手冊
      chain('a.vue#UtilModal.cancel@close', node('close', 150), { isFlow: false, flowKind: 'none' })
    ]
    const result = trace(chains, [chain('crosscut:src/router/guards.ts#路由守衛', node('guard', 3))])

    writePackets(result, { outDir })
    const cover = packetCoverage(result)
    const exists = (id: string) => fs.existsSync(path.join(outDir, `${slugify(id)}.md`))

    for (const c of [...result.chains, ...result.crosscut]) {
      const isRepresentative = cover.get(c.entryId) === c.entryId
      expect({ id: c.entryId, file: exists(c.entryId) }).toEqual({ id: c.entryId, file: isRepresentative })
    }
  })

  it('覆蓋表指向的代表，其封包一定存在', () => {
    const result = trace([
      chain('a.vue#UtilButton.click@save', node('save', 40)),
      chain('a.vue#UtilFormInput.keyup@save', node('save', 40), { trigger: 'keyup' })
    ])
    writePackets(result, { outDir })
    const cover = packetCoverage(result)

    expect(cover.get('a.vue#UtilFormInput.keyup@save')).toBe('a.vue#UtilButton.click@save')
    for (const rep of new Set(cover.values())) {
      expect(fs.existsSync(path.join(outDir, `${slugify(rep)}.md`))).toBe(true)
    }
  })

  it('--all 把非流程也納入時，覆蓋表要跟著放寬', () => {
    const result = trace([chain('a.vue#UtilModal.cancel@close', node('close', 60), { isFlow: false, flowKind: 'none' })])
    expect(packetCoverage(result).size).toBe(0)

    writePackets(result, { outDir, all: true })
    const cover = packetCoverage(result, { all: true })
    expect(cover.get('a.vue#UtilModal.cancel@close')).toBe('a.vue#UtilModal.cancel@close')
    expect(fs.existsSync(path.join(outDir, `${slugify('a.vue#UtilModal.cancel@close')}.md`))).toBe(true)
  })
})
