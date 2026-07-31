import { hasManual, type ManualIndex } from './manuals.js'
import { lineSignature, structureSignature } from './signature.js'
import type { FlowChain, TraceResult } from './types.js'

export type ChangeKind = 'unchanged' | 'moved' | 'changed' | 'added' | 'removed'

export interface FlowChange {
  entryId: string
  kind: ChangeKind
  domain: string
  label: string
  /** 這條流程有沒有既有敘述。沒有的話 diff 只報告，不產生工作 */
  hasManual: boolean
  /** 人讀的變更說明 */
  detail: string
}

export type Verdict =
  /** 目標 repo 的 commit 與 baseline 相同，整輪可以直接跳過 */
  | 'no-change'
  /** 有變更，照分類執行 */
  | 'proceed'
  /** 表示法版本不同，舊 baseline 不能拿來 diff，要走升版圈 */
  | 'upgrade'
  /** 需重寫的章數超過門檻，停下等人工核可再燒 token */
  | 'breaker'

export interface DiffResult {
  verdict: Verdict
  reason: string
  baseline: { commit: string | null; representation: number; generatedAt: string }
  current: { commit: string | null; representation: number; generatedAt: string; dirty: boolean }
  counts: Record<ChangeKind, number>
  changes: FlowChange[]
  /** 實際要做的事。沒有既有敘述的流程不會出現在這裡 */
  work: {
    /** 只有行號漂移 → 機械改寫引用，0 token */
    reanchor: string[]
    /** 結構或主體變了 → LLM 重寫該章 */
    rewrite: string[]
    /** 流程消失 → 手冊歸檔下架 */
    archive: string[]
  }
}

export interface DiffOptions {
  /** 需重寫章數超過此值就熔斷。典型觸發情境是資料夾改名或大重構 */
  breakerThreshold: number
}

export const defaultDiffOptions: DiffOptions = { breakerThreshold: 30 }

function indexChains(result: TraceResult): Map<string, FlowChain> {
  return new Map([...result.chains, ...result.crosscut].map(c => [c.entryId, c]))
}

/**
 * 比對兩次分析，把每條流程分成五類，並算出實際要做的事。
 *
 * **比的是「新 chains vs 舊 baseline chains」，不是「chains vs manuals」。**
 * 這點錯了整個閉環就會失控：mPHR 有 901 條流程但只有 226 條寫了敘述，
 * 拿 manuals 當基準的話，675 條從沒寫過的會全被判成 added，第一輪就想寫 675 章。
 * 閉環的職責是**維護已經寫過的敘述**，不主動補寫沒寫過的——補寫是獨立的人為工作。
 *
 * 唯一的例外是 added：新流程若落在**已經有人在維護的業務域**（該域已有敘述），
 * 就該補上，否則那個域的手冊會缺一塊；落在完全沒寫過的域則只報告不動作。
 */
export function diffFlows(
  baseline: TraceResult,
  current: TraceResult,
  manuals: ManualIndex,
  options: DiffOptions = defaultDiffOptions
): DiffResult {
  const meta = {
    baseline: {
      commit: baseline.target?.commit ?? null,
      representation: baseline.analyzer?.representation ?? 0,
      generatedAt: baseline.generatedAt
    },
    current: {
      commit: current.target?.commit ?? null,
      representation: current.analyzer?.representation ?? 0,
      generatedAt: current.generatedAt,
      dirty: current.target?.dirty ?? false
    }
  }
  const empty: DiffResult = {
    verdict: 'proceed',
    reason: '',
    ...meta,
    counts: { unchanged: 0, moved: 0, changed: 0, added: 0, removed: 0 },
    changes: [],
    work: { reanchor: [], rewrite: [], archive: [] }
  }

  // 表示法變了就不比了——舊 baseline 是用不同規則產生的，逐條比對只會得到滿江紅
  if (meta.baseline.representation !== meta.current.representation) {
    return {
      ...empty,
      verdict: 'upgrade',
      reason:
        `表示法版本 ${meta.baseline.representation} → ${meta.current.representation}：` +
        `舊 baseline 不能拿來 diff，要走升版圈（全量重生或確認後只做 reanchor）`
    }
  }

  const before = indexChains(baseline)
  const after = indexChains(current)
  const changes: FlowChange[] = []

  for (const [entryId, chain] of after) {
    const old = before.get(entryId)
    const manual = hasManual(manuals, entryId)
    if (!old) {
      changes.push({ entryId, kind: 'added', domain: chain.domain, label: chain.label, hasManual: manual, detail: '新出現的流程' })
      continue
    }
    // 順序有意義：結構最重要，其次是主體，最後才是行號
    if (structureSignature(old) !== structureSignature(chain)) {
      changes.push({
        entryId,
        kind: 'changed',
        domain: chain.domain,
        label: chain.label,
        hasManual: manual,
        detail: '呼叫結構或副作用變了'
      })
    } else if (old.sourceHash !== chain.sourceHash) {
      changes.push({
        entryId,
        kind: 'changed',
        domain: chain.domain,
        label: chain.label,
        hasManual: manual,
        detail: '呼叫結構相同，但鏈上函式的主體改了'
      })
    } else if (lineSignature(old) !== lineSignature(chain)) {
      changes.push({ entryId, kind: 'moved', domain: chain.domain, label: chain.label, hasManual: manual, detail: '只有行號漂移' })
    } else {
      changes.push({ entryId, kind: 'unchanged', domain: chain.domain, label: chain.label, hasManual: manual, detail: '' })
    }
  }

  for (const [entryId, chain] of before) {
    if (after.has(entryId)) continue
    changes.push({
      entryId,
      kind: 'removed',
      domain: chain.domain,
      label: chain.label,
      hasManual: hasManual(manuals, entryId),
      detail: '流程已消失'
    })
  }

  const counts = { unchanged: 0, moved: 0, changed: 0, added: 0, removed: 0 }
  for (const c of changes) counts[c.kind]++

  // 「這個域有人在維護」＝該域至少有一條流程寫了敘述
  const maintainedDomains = new Set(changes.filter(c => c.hasManual).map(c => c.domain))

  const work = {
    reanchor: changes.filter(c => c.kind === 'moved' && c.hasManual).map(c => c.entryId),
    rewrite: changes
      .filter(c => (c.kind === 'changed' && c.hasManual) || (c.kind === 'added' && maintainedDomains.has(c.domain)))
      .map(c => c.entryId),
    archive: changes.filter(c => c.kind === 'removed' && c.hasManual).map(c => c.entryId)
  }

  if (work.rewrite.length > options.breakerThreshold) {
    return {
      ...empty,
      counts,
      changes,
      work,
      verdict: 'breaker',
      reason:
        `需重寫 ${work.rewrite.length} 章，超過門檻 ${options.breakerThreshold}——` +
        `典型情境是資料夾改名或大重構。停下等人工核可再燒 token`
    }
  }

  const total = work.reanchor.length + work.rewrite.length + work.archive.length
  if (total === 0) {
    return {
      ...empty,
      counts,
      changes,
      work,
      verdict: 'no-change',
      reason:
        counts.added + counts.changed + counts.moved + counts.removed === 0
          ? '流程完全沒變'
          : '有流程變動，但都沒有既有敘述需要維護'
    }
  }

  return {
    ...empty,
    counts,
    changes,
    work,
    verdict: 'proceed',
    reason: `機械改寫 ${work.reanchor.length} 章 · LLM 重寫 ${work.rewrite.length} 章 · 歸檔 ${work.archive.length} 章`
  }
}
