import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiffResult } from './diff.js'
import {
  acquireLock,
  commitMessage,
  releaseLock,
  renderChanges,
  runLoop,
  type LoopOptions,
  type LoopSteps,
  type NarrateSummary,
  type PendingEntry
} from './loop.js'
import type { FlowChain, TraceResult } from './types.js'

function chain(entryId: string): FlowChain {
  return { entryId } as FlowChain
}

function trace(commit: string | null, ids: string[] = ['a', 'b'], dirty = false): TraceResult {
  return {
    repoRoot: '/repo',
    generatedAt: '2026-07-31T00:00:00.000Z',
    analyzer: { representation: 4, version: '0.1.0' },
    target: { commit, dirty },
    chains: ids.map(chain),
    crosscut: [],
    stats: {} as TraceResult['stats']
  }
}

function diffResult(over: Partial<DiffResult> = {}): DiffResult {
  return {
    verdict: 'proceed',
    reason: '機械改寫 1 章 · LLM 重寫 0 章 · 歸檔 0 章',
    baseline: { commit: 'aaa', representation: 4, generatedAt: '' },
    current: { commit: 'bbb', representation: 4, generatedAt: '', dirty: false },
    counts: { unchanged: 1, moved: 1, changed: 0, added: 0, removed: 0 },
    changes: [],
    work: { reanchor: ['a'], rewrite: [], archive: [] },
    ...over
  }
}

interface Fake {
  steps: LoopSteps
  calls: string[]
}

/** 全部步驟都成功的假實作；個別測試覆寫要出狀況的那步 */
function fakeSteps(over: Partial<LoopSteps> = {}): Fake {
  const calls: string[] = []
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name)
      return fn(...args)
    }
  const steps: LoopSteps = {
    acquireLock: track('acquireLock', () => ({ ok: true }) as const),
    releaseLock: track('releaseLock', () => {}),
    readBaseline: track('readBaseline', () => trace('aaa')),
    targetRevision: track('targetRevision', () => ({ commit: 'bbb', dirty: false })),
    missingGenerated: track('missingGenerated', () => []),
    manualsClean: track('manualsClean', () => true),
    trace: track('trace', async () => trace('bbb')),
    diff: track('diff', () => diffResult()),
    pack: track('pack', () => ({ packets: 3 })),
    archive: track('archive', (ids: string[]) => ({ moved: ids.map(id => `${id}.md`) })),
    reanchor: track('reanchor', () => ({ manualsChanged: ['a.md'], refsRewritten: 5, unmapped: [] })),
    narrate: track('narrate', async (targets: string[]) => ({
      written: targets.map(entryId => ({ entryId, file: `${entryId}.md` })),
      degraded: [],
      skipped: [],
      usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }
    })),
    verify: track('verify', () => []),
    readPending: track('readPending', () => []),
    writePending: track('writePending', () => {}),
    writeChanges: track('writeChanges', () => {}),
    writeBaseline: track('writeBaseline', () => {}),
    commit: track('commit', () => ({ branch: 'main', sha: 'c0ffee', autoMerge: false })),
    log: () => {},
    ...over
  }
  // 覆寫的步驟也要記錄呼叫
  for (const key of Object.keys(over) as (keyof LoopSteps)[]) {
    const fn = steps[key] as (...args: unknown[]) => unknown
    ;(steps as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
      calls.push(key)
      return fn(...args)
    }
  }
  return { steps, calls }
}

const defaults: LoopOptions = { dryRun: false, narrate: true, commit: true, allowDirty: false, targetName: 'demo' }

describe('runLoop 防呆與早退', () => {
  it('鎖被占 → not-run(3)，一步都不做', async () => {
    const { steps, calls } = fakeSteps({ acquireLock: () => ({ ok: false, detail: 'pid 1 持有' }) })
    const r = await runLoop(steps, defaults)
    expect(r.outcome).toBe('not-run')
    expect(r.exitCode).toBe(3)
    expect(calls).not.toContain('trace')
    expect(calls).not.toContain('releaseLock')
  })

  it('沒有 baseline → needs-human(2)，指路初始化', async () => {
    const { steps, calls } = fakeSteps({ readBaseline: () => null })
    const r = await runLoop(steps, defaults)
    expect(r.exitCode).toBe(2)
    expect(r.reason).toContain('trace')
    expect(calls).toContain('releaseLock')
  })

  it('目標 repo dirty → not-run(3)，不分析', async () => {
    const { steps, calls } = fakeSteps({ targetRevision: () => ({ commit: 'bbb', dirty: true }) })
    const r = await runLoop(steps, defaults)
    expect(r.exitCode).toBe(3)
    expect(r.reason).toContain('未提交變動')
    expect(calls).not.toContain('trace')
  })

  it('HEAD ＝ baseline 且無欠帳 → early-exit(0)，連 trace 都不跑', async () => {
    const { steps, calls } = fakeSteps({ targetRevision: () => ({ commit: 'aaa', dirty: false }) })
    const r = await runLoop(steps, defaults)
    expect(r.outcome).toBe('early-exit')
    expect(r.exitCode).toBe(0)
    expect(calls).not.toContain('trace')
    expect(calls).toContain('releaseLock')
  })

  it('HEAD ＝ baseline 但佇列有欠的敘述 → 照跑（不 pack、不動 baseline）', async () => {
    const pending: PendingEntry[] = [{ id: 'a', reason: 'narrate-skipped', detail: '上輪沒憑證', since: '2026-07-30' }]
    const { steps, calls } = fakeSteps({
      targetRevision: () => ({ commit: 'aaa', dirty: false }),
      readPending: () => pending,
      trace: async () => trace('aaa'),
      diff: () =>
        diffResult({
          verdict: 'no-change',
          reason: '流程完全沒變',
          current: { commit: 'aaa', representation: 4, generatedAt: '', dirty: false },
          counts: { unchanged: 2, moved: 0, changed: 0, added: 0, removed: 0 },
          work: { reanchor: [], rewrite: [], archive: [] }
        })
    })
    const r = await runLoop(steps, defaults)
    expect(r.outcome).toBe('completed')
    expect(calls).toContain('narrate')
    expect(calls).not.toContain('pack')
    expect(calls).not.toContain('writeBaseline')
    // 補寫成功 → 佇列清空
    expect(r.pending).toEqual([])
    expect(r.llmUsed).toBe(true)
  })

  it('關掉 narrate 時，佇列的欠帳不構成「照跑」的理由', async () => {
    const pending: PendingEntry[] = [{ id: 'a', reason: 'narrate-skipped', detail: '', since: '2026-07-30' }]
    const { steps, calls } = fakeSteps({
      targetRevision: () => ({ commit: 'aaa', dirty: false }),
      readPending: () => pending
    })
    const r = await runLoop(steps, { ...defaults, narrate: false })
    expect(r.outcome).toBe('early-exit')
    expect(calls).not.toContain('trace')
  })

  it('缺 generated 檔 → not-run(3)，指名 codegen', async () => {
    const { steps, calls } = fakeSteps({ missingGenerated: () => ['src/components.d.ts'] })
    const r = await runLoop(steps, defaults)
    expect(r.exitCode).toBe(3)
    expect(r.reason).toContain('components.d.ts')
    expect(calls).not.toContain('trace')
  })

  it('手冊 repo 不乾淨 → not-run(3)；dry-run 不受此限', async () => {
    const { steps } = fakeSteps({ manualsClean: () => false })
    expect((await runLoop(steps, defaults)).exitCode).toBe(3)

    const again = fakeSteps({ manualsClean: () => false })
    const r = await runLoop(again.steps, { ...defaults, dryRun: true })
    expect(r.outcome).toBe('dry-run')
  })
})

describe('runLoop verdict 調度', () => {
  it('表示法升版 → needs-human(2)，什麼都不寫', async () => {
    const { steps, calls } = fakeSteps({
      diff: () => diffResult({ verdict: 'upgrade', reason: '表示法版本 3 → 4：要走升版圈' })
    })
    const r = await runLoop(steps, defaults)
    expect(r.exitCode).toBe(2)
    expect(r.reason).toContain('升版圈')
    for (const never of ['pack', 'archive', 'reanchor', 'narrate', 'writeBaseline', 'writePending', 'commit']) {
      expect(calls).not.toContain(never)
    }
  })

  it('熔斷 → needs-human(2)，什麼都不寫', async () => {
    const { steps, calls } = fakeSteps({
      diff: () => diffResult({ verdict: 'breaker', reason: '需重寫 45 章，超過門檻 30' })
    })
    const r = await runLoop(steps, defaults)
    expect(r.exitCode).toBe(2)
    expect(calls).not.toContain('writeBaseline')
  })

  it('baseline 與本次分析的 platform 不同 → 警告（環境差異偽裝成程式變更）', async () => {
    const lines: string[] = []
    const base = trace('aaa')
    base.analyzer.platform = 'win32'
    const cur = trace('bbb')
    cur.analyzer.platform = 'linux'
    const { steps } = fakeSteps({ readBaseline: () => base, trace: async () => cur })
    steps.log = line => lines.push(line)
    await runLoop(steps, defaults)
    expect(lines.some(l => l.includes('win32') && l.includes('linux'))).toBe(true)
  })

  it('dry-run → 分析與 diff 照跑，之後全停', async () => {
    const { steps, calls } = fakeSteps()
    const r = await runLoop(steps, { ...defaults, dryRun: true })
    expect(r.outcome).toBe('dry-run')
    expect(r.exitCode).toBe(0)
    expect(calls).toContain('diff')
    for (const never of ['pack', 'reanchor', 'narrate', 'writeBaseline', 'writePending', 'writeChanges', 'commit']) {
      expect(calls).not.toContain(never)
    }
  })

  it('no-change 但 commit 前進 → 只推 baseline＋封包並 commit（0 token 輪）', async () => {
    const { steps, calls } = fakeSteps({
      diff: () =>
        diffResult({
          verdict: 'no-change',
          reason: '有流程變動，但都沒有既有敘述需要維護',
          work: { reanchor: [], rewrite: [], archive: [] }
        })
    })
    const r = await runLoop(steps, defaults)
    expect(r.outcome).toBe('completed')
    expect(calls).toContain('pack')
    expect(calls).toContain('writeBaseline')
    expect(calls).toContain('commit')
    expect(calls).not.toContain('narrate')
    expect(r.llmUsed).toBe(false)
    expect(r.autoMergeEligible).toBe(true)
  })
})

describe('runLoop 分流與佇列', () => {
  it('純 moved 輪：reanchor 有跑、narrate 沒跑、可自動合併', async () => {
    const { steps, calls } = fakeSteps()
    const r = await runLoop(steps, defaults)
    expect(calls).toContain('reanchor')
    expect(calls).not.toContain('narrate')
    expect(r.llmUsed).toBe(false)
    expect(r.autoMergeEligible).toBe(true)
    expect(r.committed).not.toBeNull()
  })

  it('rewrite 全寫成 → llmUsed，不自動合併', async () => {
    const { steps } = fakeSteps({
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['a'], archive: [] } })
    })
    const r = await runLoop(steps, defaults)
    expect(r.llmUsed).toBe(true)
    expect(r.autoMergeEligible).toBe(false)
    expect(r.pending).toEqual([])
  })

  it('--no-narrate：rewrite 目標全進佇列，仍 commit，不可自動合併', async () => {
    const { steps, calls } = fakeSteps({
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['a', 'b'], archive: [] } })
    })
    const r = await runLoop(steps, { ...defaults, narrate: false })
    expect(calls).not.toContain('narrate')
    expect(calls).toContain('commit')
    expect(r.pending.map(p => p.id)).toEqual(['a', 'b'])
    expect(r.pending.every(p => p.reason === 'narrate-skipped')).toBe(true)
    expect(r.autoMergeEligible).toBe(false)
  })

  it('narrate 部分降級 → 降級的進佇列、寫成的不進', async () => {
    const nar: NarrateSummary = {
      written: [{ entryId: 'a', file: 'a.md' }],
      degraded: [{ entryId: 'b', detail: '3 次都沒過驗證' }],
      skipped: [],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }
    }
    const { steps } = fakeSteps({
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['a', 'b'], archive: [] } }),
      narrate: async () => nar
    })
    const r = await runLoop(steps, defaults)
    expect(r.pending).toHaveLength(1)
    expect(r.pending[0]).toMatchObject({ id: 'b', reason: 'narrate-degraded' })
    expect(r.llmUsed).toBe(true)
  })

  it('API 中斷：已寫的保留、剩下的進佇列，輪次仍完成', async () => {
    const nar: NarrateSummary = {
      written: [{ entryId: 'a', file: 'a.md' }],
      degraded: [],
      skipped: [{ entryId: 'b', detail: 'API 失敗：401 沒有憑證' }],
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
      aborted: '401 沒有憑證'
    }
    const { steps } = fakeSteps({
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['a', 'b'], archive: [] } }),
      narrate: async () => nar
    })
    const r = await runLoop(steps, defaults)
    expect(r.outcome).toBe('completed')
    expect(r.pending.map(p => p.id)).toEqual(['b'])
    expect(r.committed).not.toBeNull()
  })

  it('佇列條目的流程已消失 → 自動清掉；還在的與新 rewrite 合併去重', async () => {
    const pending: PendingEntry[] = [
      { id: 'gone', reason: 'narrate-skipped', detail: '', since: '2026-07-01' },
      { id: 'b', reason: 'narrate-skipped', detail: '', since: '2026-07-01' }
    ]
    let got: string[] = []
    const { steps } = fakeSteps({
      readPending: () => pending,
      trace: async () => trace('bbb', ['a', 'b']),
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['b'], archive: [] } }),
      narrate: async (targets: string[]) => {
        got = targets
        return {
          written: targets.map(entryId => ({ entryId, file: `${entryId}.md` })),
          degraded: [],
          skipped: [],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
        }
      }
    })
    const r = await runLoop(steps, defaults)
    expect(got).toEqual(['b'])
    expect(r.pending).toEqual([])
  })

  it('重複略過不重設 since', async () => {
    const pending: PendingEntry[] = [{ id: 'a', reason: 'narrate-skipped', detail: '舊', since: '2026-07-01' }]
    const { steps } = fakeSteps({
      readPending: () => pending,
      diff: () => diffResult({ work: { reanchor: [], rewrite: ['a'], archive: [] } })
    })
    const r = await runLoop(steps, { ...defaults, narrate: false })
    expect(r.pending[0]!.since).toBe('2026-07-01')
  })

  it('verify 紅了 → 進佇列、封鎖自動合併；下輪轉綠自動清出', async () => {
    const first = fakeSteps({ verify: () => [{ file: 'a.md', violations: 2 }] })
    const r1 = await runLoop(first.steps, defaults)
    expect(r1.verifyFailures).toHaveLength(1)
    expect(r1.autoMergeEligible).toBe(false)
    expect(r1.pending[0]).toMatchObject({ id: 'a.md', reason: 'verify-failed' })

    // 下一輪：檔案沒被本輪動到，但佇列裡的 verify-failed 會被重驗——綠了就清出
    const second = fakeSteps({
      readPending: () => r1.pending,
      diff: () => diffResult({ work: { reanchor: [], rewrite: [], archive: [] } }),
      verify: () => []
    })
    const r2 = await runLoop(second.steps, defaults)
    expect(r2.pending).toEqual([])
  })

  it('歸檔輪：archive 有跑、不可自動合併', async () => {
    const { steps, calls } = fakeSteps({
      diff: () => diffResult({ work: { reanchor: [], rewrite: [], archive: ['dead'] } })
    })
    const r = await runLoop(steps, defaults)
    expect(calls).toContain('archive')
    expect(r.archived).toEqual(['dead.md'])
    expect(r.autoMergeEligible).toBe(false)
  })

  it('--no-commit：改完不 commit', async () => {
    const { steps, calls } = fakeSteps()
    const r = await runLoop(steps, { ...defaults, commit: false })
    expect(r.outcome).toBe('completed')
    expect(calls).not.toContain('commit')
    expect(r.committed).toBeNull()
  })

  it('步驟丟例外 → 鎖仍會釋放', async () => {
    const { steps, calls } = fakeSteps({
      trace: async () => {
        throw new Error('boom')
      }
    })
    await expect(runLoop(steps, defaults)).rejects.toThrow('boom')
    expect(calls).toContain('releaseLock')
  })
})

describe('commitMessage 與 renderChanges', () => {
  it('訊息含 commit 區間與工作量', () => {
    const msg = commitMessage(
      'mPHR_Frontend',
      diffResult(),
      { manualsChanged: ['a.md', 'b.md'], refsRewritten: 9, unmapped: [] },
      null,
      []
    )
    expect(msg).toContain('mPHR_Frontend')
    expect(msg).toContain('aaa→bbb'.slice(0, 3))
    expect(msg).toContain('機械改寫 2 章')
  })

  it('無手冊變更的輪次寫明 baseline 前進', () => {
    const msg = commitMessage('demo', diffResult(), { manualsChanged: [], refsRewritten: 0, unmapped: [] }, null, [])
    expect(msg).toContain('baseline 前進')
  })

  it('變更頁含分類表與待人工佇列', () => {
    const md = renderChanges('demo', diffResult(), {
      archived: [],
      reanchored: { manualsChanged: ['a.md'], refsRewritten: 3, unmapped: [] },
      narrated: null,
      failures: [{ file: 'x.md', violations: 1 }],
      pending: [{ id: 'y', reason: 'narrate-skipped', detail: '無憑證', since: '2026-07-31T00:00:00Z' }]
    })
    expect(md).toContain('| 沒變 |')
    expect(md).toContain('待人工佇列')
    expect(md).toContain('驗證未過')
    expect(md).toContain('敘述待補')
  })
})

describe('acquireLock', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-doc-lock-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('沒鎖 → 取得並落檔', () => {
    const file = path.join(dir, '.lock')
    expect(acquireLock(file, 1000).ok).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    releaseLock(file)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('持有者還活著 → 拿不到', () => {
    const file = path.join(dir, '.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }))
    const r = acquireLock(file, 60_000, Date.now(), () => true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('12345')
  })

  it('持有者行程不在了 → 視為殭屍，清掉重取', () => {
    const file = path.join(dir, '.lock')
    fs.writeFileSync(file, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }))
    expect(acquireLock(file, 60_000, Date.now(), () => false).ok).toBe(true)
  })

  it('超過 staleMs → 即使行程還在也視為殭屍', () => {
    const file = path.join(dir, '.lock')
    const old = new Date(Date.now() - 10 * 60_000).toISOString()
    fs.writeFileSync(file, JSON.stringify({ pid: 12345, startedAt: old }))
    expect(acquireLock(file, 60_000, Date.now(), () => true).ok).toBe(true)
  })

  it('鎖檔壞掉（不是 JSON）→ 視為殭屍', () => {
    const file = path.join(dir, '.lock')
    fs.writeFileSync(file, 'not-json')
    expect(acquireLock(file, 60_000, Date.now(), () => true).ok).toBe(true)
  })
})
