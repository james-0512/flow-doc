import fs from 'node:fs'
import type { DiffResult } from './diff.js'
import type { TraceResult } from './types.js'
import { packageVersion, REPRESENTATION_VERSION, type TargetRevision } from './version.js'

/**
 * 閉環一圈的狀態機。
 *
 * 這個模組只做**決策**：早退、防呆、verdict 調度、待補佇列的收斂。
 * 所有會碰檔案系統、git、API 的動作都經由 `LoopSteps` 注入——狀態機因此可以
 * 用假步驟完整測試（HANDOFF 點名的早退／熔斷／降級路徑都在 loop.spec.ts）。
 */

export type PendingReason = 'narrate-skipped' | 'narrate-degraded' | 'verify-failed'

/**
 * 待人工佇列的一筆。
 *
 * 佇列必須是**進版控的檔案**（pending.json）：baseline 前進之後，下一輪 diff
 * 看不到「這章上輪沒寫完」——那個事實只剩佇列記得。不落地的話，降級的章節
 * 會永遠停在舊敘述，而且沒有任何地方看得出來。
 */
export interface PendingEntry {
  /** narrate 類是 entryId；verify-failed 是手冊檔名（verify 以檔案為單位） */
  id: string
  reason: PendingReason
  detail: string
  /** 首次進佇列的時間。重複略過不重設——「掛了多久」是人排優先序的依據 */
  since: string
}

export interface ReanchorSummary {
  manualsChanged: string[]
  refsRewritten: number
  unmapped: string[]
}

/**
 * narrate 的回報約定：**每個目標必須落在 written／degraded／skipped 其中一格**。
 * 少一格就等於靜默截斷——上層會以為那章處理過了，佇列也不會接住它。
 */
export interface NarrateSummary {
  written: { entryId: string; file: string }[]
  degraded: { entryId: string; detail: string }[]
  skipped: { entryId: string; detail: string }[]
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** API 層失敗（憑證、額度、網路）。已寫入的章節保留，其餘落在 skipped */
  aborted?: string
}

export interface VerifyFailure {
  file: string
  violations: number
}

export interface CommitSummary {
  branch: string
  sha: string
  /** PR 模式才有：PR 網址 */
  pr?: string
  autoMerge: boolean
}

export interface LoopSteps {
  acquireLock(): { ok: true } | { ok: false; detail: string }
  releaseLock(): void
  readBaseline(): TraceResult | null
  targetRevision(): TargetRevision
  /** 目標 repo 缺的 generated 檔。缺了分析結果與 baseline 不可比，第一輪 diff 會滿江紅 */
  missingGenerated(): string[]
  /** 手冊 repo 的目標目錄是否乾淨。髒的樹沒辦法做出「只含本圈變更」的 commit */
  manualsClean(): boolean
  trace(): Promise<TraceResult>
  diff(baseline: TraceResult, current: TraceResult): DiffResult
  pack(current: TraceResult): { packets: number }
  /** 歸檔下架。一份敘述可能同時涵蓋消失的與存活的觸發點，實作要拿 current 判斷檔案是否還被用到 */
  archive(entryIds: string[], current: TraceResult): { moved: string[] }
  reanchor(baseline: TraceResult, current: TraceResult, diff: DiffResult): ReanchorSummary
  narrate(targets: string[], current: TraceResult): Promise<NarrateSummary>
  verify(files: string[], current: TraceResult): VerifyFailure[]
  readPending(): PendingEntry[]
  writePending(entries: PendingEntry[]): void
  writeChanges(markdown: string): void
  writeBaseline(current: TraceResult): void
  commit(message: string, changesMarkdown: string, autoMergeEligible: boolean): CommitSummary
  log(line: string): void
}

export interface LoopOptions {
  /** 分析與 diff 照跑，之後只報告，不寫任何檔案 */
  dryRun: boolean
  /** false = 跳過 LLM，rewrite 目標全部進待補佇列（無憑證環境、或先跑不花錢的那半） */
  narrate: boolean
  commit: boolean
  /** 目標 repo dirty 仍分析。呼叫端須強制它只跟 dryRun 一起出現 */
  allowDirty: boolean
  /** 手冊目錄名，進報告與 commit 訊息 */
  targetName: string
}

export type LoopOutcome = 'early-exit' | 'completed' | 'dry-run' | 'needs-human' | 'not-run'

/**
 * exit code 是 CI 的 gate：
 * 0 完成（含早退）· 1 執行錯誤 · 2 需人工（升版圈、熔斷、沒有 baseline）·
 * 3 這輪沒跑（鎖被占、dirty、缺 generated 檔）——重複喚醒或環境不對都落在這裡，不算失敗。
 */
export interface LoopReport {
  outcome: LoopOutcome
  exitCode: 0 | 1 | 2 | 3
  reason: string
  verdict: DiffResult['verdict'] | null
  baseline: string | null
  current: string | null
  counts: DiffResult['counts'] | null
  work: { reanchor: number; rewrite: number; archive: number } | null
  reanchored: ReanchorSummary | null
  narrated: NarrateSummary | null
  archived: string[]
  verifyFailures: VerifyFailure[]
  pending: PendingEntry[]
  /** 本輪有沒有 LLM 產出。auto-merge 判定與 PR 模式都看它 */
  llmUsed: boolean
  autoMergeEligible: boolean
  committed: CommitSummary | null
}

const EMPTY_REPORT: LoopReport = {
  outcome: 'not-run',
  exitCode: 3,
  reason: '',
  verdict: null,
  baseline: null,
  current: null,
  counts: null,
  work: null,
  reanchored: null,
  narrated: null,
  archived: [],
  verifyFailures: [],
  pending: [],
  llmUsed: false,
  autoMergeEligible: false,
  committed: null
}

export async function runLoop(steps: LoopSteps, options: LoopOptions): Promise<LoopReport> {
  const lock = steps.acquireLock()
  if (!lock.ok) {
    return { ...EMPTY_REPORT, reason: `另一圈正在跑，這輪不做事：${lock.detail}` }
  }
  try {
    const baseline = steps.readBaseline()
    if (!baseline) {
      return {
        ...EMPTY_REPORT,
        outcome: 'needs-human',
        exitCode: 2,
        reason: '找不到 baseline flow-chains.json。閉環只維護既有敘述——初始化請先跑 trace＋pack 並 commit'
      }
    }
    const baselineCommit = baseline.target?.commit ?? null
    const pendingPrev = steps.readPending()
    const rev = steps.targetRevision()

    if (rev.dirty && !options.allowDirty) {
      return {
        ...EMPTY_REPORT,
        pending: pendingPrev,
        reason: '目標 repo 有未提交變動。dirty 的樹產出的結果不可重現，不能當下一輪的 baseline——commit 或 stash 後再跑'
      }
    }

    // 佇列裡還有可重試的章節時不早退：commit 沒動也要把欠的敘述補完
    const retryable = options.narrate ? pendingPrev.filter(p => p.reason !== 'verify-failed') : []
    // 分析器換了就不能早退——同一個 commit 用新規則會跑出不同的鏈。
    // 只看 commit 的話，分析器升級在佇列剛好清空的那一輪會完全隱形：不 trace、
    // 不 diff、不重生封包，而使用者只會看到「目標 repo 沒動，這輪直接退出」。
    // 身分取自 baseline 自己記的 analyzer 欄位，所以**改了分析器就要 bump
    // package.json 的版本**，否則這裡分不出來。
    const sameAnalyzer =
      baseline.analyzer?.representation === REPRESENTATION_VERSION &&
      baseline.analyzer?.version === packageVersion()
    if (
      rev.commit !== null &&
      rev.commit === baselineCommit &&
      !rev.dirty &&
      retryable.length === 0 &&
      sameAnalyzer
    ) {
      return {
        ...EMPTY_REPORT,
        outcome: 'early-exit',
        exitCode: 0,
        baseline: baselineCommit,
        current: rev.commit,
        pending: pendingPrev,
        reason: `目標 repo 沒動（HEAD ＝ baseline ${short(baselineCommit)}），這輪直接退出`
      }
    }

    const missing = steps.missingGenerated()
    if (missing.length > 0) {
      return {
        ...EMPTY_REPORT,
        pending: pendingPrev,
        reason:
          `目標 repo 缺 generated 檔：${missing.join('、')}。` +
          `少了它分析結果與 baseline 不可比，diff 會滿江紅——先跑目標的 codegen（mPHR 是 pnpm generate:components-dts）`
      }
    }

    if (!options.dryRun && !steps.manualsClean()) {
      return {
        ...EMPTY_REPORT,
        pending: pendingPrev,
        reason: '手冊 repo 的目標目錄有未提交變動，做不出只含本圈變更的 commit——先 commit 或 stash'
      }
    }

    steps.log(`目標 ${short(rev.commit)}（baseline ${short(baselineCommit)}）→ 全量重分析`)
    const current = await steps.trace()

    // 模組解析對環境敏感（實測：Windows 的 pnpm junction 掛進 Linux 容器會斷，
    // 941 條鏈的樹形改變）。跨平台 diff 的大量 changed 極可能是環境差異，先警告再進熔斷
    const basePlat = baseline.analyzer?.platform
    const curPlat = current.analyzer?.platform
    if (basePlat && curPlat && basePlat !== curPlat) {
      steps.log(
        `⚠ baseline 產自 ${basePlat}、本次分析在 ${curPlat}——跨環境的模組解析可能不同，` +
          `大量 changed 應先懷疑環境而非程式。baseline 要由同一種環境產生（見 LOOP.md〈容器化〉）`
      )
    }

    const d = steps.diff(baseline, current)
    const filled: LoopReport = {
      ...EMPTY_REPORT,
      verdict: d.verdict,
      baseline: d.baseline.commit,
      current: d.current.commit,
      counts: d.counts,
      work: { reanchor: d.work.reanchor.length, rewrite: d.work.rewrite.length, archive: d.work.archive.length },
      pending: pendingPrev
    }

    // 升版圈與熔斷都停在這裡：什麼都不寫，出報告等人工。半套的寫入比沒寫更難收拾
    if (d.verdict === 'upgrade' || d.verdict === 'breaker') {
      return { ...filled, outcome: 'needs-human', exitCode: 2, reason: d.reason }
    }

    // 佇列條目的存續看**封包**，不看流程是否還在：流程消失了固然做不了事，流程還在
    // 但沒有封包（非流程、或被併進代表）同樣做不了事——narrate 只會再回報一次
    // 「找不到封包」，然後原封不動退回佇列。這種條目不清掉就會變成永遠還不掉的假欠帳。
    // verify-failed 以檔案為單位，存續交給 verify 判斷，不走這條。
    const pendingAlive = pendingPrev.filter(p => p.reason === 'verify-failed' || d.coverage.has(p.id))
    const dropped = pendingPrev.length - pendingAlive.length
    // 清掉的要講出來。佇列筆數自己變少而沒有交代的話，看起來像敘述被偷偷寫完了
    if (dropped > 0) steps.log(`佇列清掉 ${dropped} 筆（流程已消失或沒有對應封包，narrate 做不了事）`)

    // 本輪要寫的章節 ＝ diff 說要重寫的 ∪ 佇列裡欠的。
    // 佇列的 ID 一樣要摺疊到代表，否則舊佇列裡的觸發點會繞過 diff 那層收斂
    const targets = [
      ...new Set([
        ...d.work.rewrite,
        ...pendingAlive.filter(p => p.reason !== 'verify-failed').map(p => d.coverage.get(p.id)!)
      ])
    ]

    if (options.dryRun) {
      return {
        ...filled,
        outcome: 'dry-run',
        exitCode: 0,
        pending: pendingAlive,
        reason: `${d.reason}（預演：會處理 ${targets.length} 章敘述，未寫入任何檔案）`
      }
    }

    // commit 沒前進的輪次（純補佇列）不重寫 baseline 與封包——內容不變，只會製造雜訊 diff。
    //
    // 但「commit 沒前進 ⇒ 內容不變」這個前提**只在分析器沒變時成立**。分析器擴充後，
    // 同一個 commit 也會跑出新的鏈——實測加上點號 handler 解析之後，同一個 commit
    // 多出 30 條流程，而封包沒重生就讓 narrate 全部卡在「找不到封包」，37 章一章都
    // 寫不出來，還把可修的原因寫成待人工的欠帳。所以判準改成看 diff 的實際內容：
    // 有任何一條 added／changed／removed／moved，就代表這一輪的產出與 baseline 不同。
    const contentChanged =
      d.counts.added + d.counts.changed + d.counts.removed + d.counts.moved > 0
    const advance = rev.commit === null || rev.commit !== baselineCommit || contentChanged
    if (advance) {
      const packed = steps.pack(current)
      steps.log(`封包重生 ${packed.packets} 份`)
    }

    const archived = d.work.archive.length > 0 ? steps.archive(d.work.archive, current) : { moved: [] }
    const re =
      d.work.reanchor.length > 0
        ? steps.reanchor(baseline, current, d)
        : { manualsChanged: [], refsRewritten: 0, unmapped: [] }

    let narrated: NarrateSummary | null = null
    if (targets.length > 0) {
      if (options.narrate) {
        narrated = await steps.narrate(targets, current)
      } else {
        // 不呼叫 LLM 的輪次也要交代每一章的下落——全部進佇列
        narrated = {
          written: [],
          degraded: [],
          skipped: targets.map(entryId => ({ entryId, detail: '本輪未啟用 LLM（--no-narrate）' })),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }
      }
    }

    // verify 改動過的檔案 ∪ 佇列中先前驗證不過的檔案（修好的才會自動清出佇列）
    const verifySet = [
      ...new Set([
        ...re.manualsChanged,
        ...(narrated?.written.map(w => w.file) ?? []),
        ...pendingAlive.filter(p => p.reason === 'verify-failed').map(p => p.id)
      ])
    ]
    const failures = verifySet.length > 0 ? steps.verify(verifySet, current) : []

    const now = new Date().toISOString()
    const pendingNext = nextPending(pendingAlive, narrated, failures, verifySet, now, d.coverage)

    const llmUsed = narrated != null && narrated.usage.output > 0
    // 自動合併只留給「與人審輪次無關的機械輪」：無 LLM 產出、沒有流程消失、
    // verify 全綠、也沒有新欠帳。條件寧嚴勿鬆——放行錯一次，人就不會再信任這個管線
    const grewPending = pendingNext.some(p => !pendingAlive.some(q => q.id === p.id && q.reason === p.reason))
    const autoMergeEligible = !llmUsed && archived.moved.length === 0 && failures.length === 0 && !grewPending

    if (advance) steps.writeBaseline(current)
    steps.writePending(pendingNext)
    const changesMd = renderChanges(options.targetName, d, {
      archived: archived.moved,
      reanchored: re,
      narrated,
      failures,
      pending: pendingNext
    })
    steps.writeChanges(changesMd)

    let committed: CommitSummary | null = null
    if (options.commit) {
      committed = steps.commit(commitMessage(options.targetName, d, re, narrated, archived.moved), changesMd, autoMergeEligible)
    }

    return {
      ...filled,
      outcome: 'completed',
      exitCode: 0,
      reason: d.reason,
      reanchored: re,
      narrated,
      archived: archived.moved,
      verifyFailures: failures,
      pending: pendingNext,
      llmUsed,
      autoMergeEligible,
      committed
    }
  } finally {
    steps.releaseLock()
  }
}

/**
 * 佇列收斂：本輪寫成的清出、驗過轉綠的清出，degraded／skipped／verify-failed 進來。
 * 既有條目重複發生時保留原 since——「掛了多久」不該被每晚重設。
 */
function nextPending(
  prev: PendingEntry[],
  narrated: NarrateSummary | null,
  failures: VerifyFailure[],
  verified: string[],
  now: string,
  /** entryId → 代表。佇列的觸發點是靠代表那一章結清的，比對前要先摺疊 */
  coverage: Map<string, string>
): PendingEntry[] {
  const writtenIds = new Set(narrated?.written.map(w => w.entryId) ?? [])
  const failedFiles = new Set(failures.map(f => f.file))
  const verifiedFiles = new Set(verified)
  const sinceOf = (id: string, reason: PendingReason) =>
    prev.find(p => p.id === id && p.reason === reason)?.since ?? now

  const out: PendingEntry[] = []
  const seen = new Set<string>()
  const push = (e: PendingEntry) => {
    const key = `${e.reason === 'verify-failed' ? 'file' : 'narrate'}:${e.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(e)
  }

  for (const dg of narrated?.degraded ?? []) {
    push({ id: dg.entryId, reason: 'narrate-degraded', detail: dg.detail, since: sinceOf(dg.entryId, 'narrate-degraded') })
  }
  for (const sk of narrated?.skipped ?? []) {
    push({ id: sk.entryId, reason: 'narrate-skipped', detail: sk.detail, since: sinceOf(sk.entryId, 'narrate-skipped') })
  }
  for (const f of failures) {
    push({ id: f.file, reason: 'verify-failed', detail: `${f.violations} 處引用問題`, since: sinceOf(f.file, 'verify-failed') })
  }
  for (const p of prev) {
    if (p.reason === 'verify-failed') {
      // 這輪驗了而且綠了 → 清出；沒驗到（檔案沒被動）→ 留著等人修
      if (verifiedFiles.has(p.id) && !failedFiles.has(p.id)) continue
      push(p)
    } else {
      // 寫成的是代表那一章，欠帳掛在觸發點上——不摺疊的話那筆會永遠結不掉
      if (writtenIds.has(coverage.get(p.id) ?? p.id)) continue
      push(p)
    }
  }
  return out
}

/** 手冊 repo 的 commit 訊息。照該 repo 的慣例寫中文敘述句，一眼看出這圈做了什麼 */
export function commitMessage(
  targetName: string,
  d: DiffResult,
  re: ReanchorSummary,
  narrated: NarrateSummary | null,
  archived: string[]
): string {
  const range = `${short(d.baseline.commit)}→${short(d.current.commit)}`
  const parts: string[] = []
  if (re.manualsChanged.length > 0) parts.push(`機械改寫 ${re.manualsChanged.length} 章`)
  if (narrated && narrated.written.length > 0) parts.push(`LLM 重寫 ${narrated.written.length} 章`)
  if (narrated && narrated.degraded.length + narrated.skipped.length > 0) {
    parts.push(`待補 ${narrated.degraded.length + narrated.skipped.length} 章`)
  }
  if (archived.length > 0) parts.push(`歸檔 ${archived.length} 章`)
  if (parts.length === 0) return `閉環：${targetName} baseline 前進 ${range}（無手冊變更）`
  return `閉環：${targetName} ${range}——${parts.join('、')}`
}

/**
 * 「本次變更頁」：從程式碼自動生成的業務層 release notes。
 * 同一份內容三用：站上變更頁、PR 描述、QA 對版本驗收的依據。
 */
export function renderChanges(
  targetName: string,
  d: DiffResult,
  round: {
    archived: string[]
    reanchored: ReanchorSummary
    narrated: NarrateSummary | null
    failures: VerifyFailure[]
    pending: PendingEntry[]
  }
): string {
  const lines: string[] = []
  lines.push(`# 本次變更 — ${targetName}`)
  lines.push('')
  lines.push(
    `> ${new Date().toISOString().slice(0, 10)} · 目標 ${short(d.baseline.commit)} → ${short(d.current.commit)} · 表示法 v${d.current.representation}`
  )
  lines.push('')
  lines.push('| 沒變 | 行號漂移 | 結構或主體變了 | 新增 | 消失 |')
  lines.push('|---:|---:|---:|---:|---:|')
  lines.push(
    `| ${d.counts.unchanged} | ${d.counts.moved} | ${d.counts.changed} | ${d.counts.added} | ${d.counts.removed} |`
  )

  const notable = d.changes.filter(c => c.kind !== 'unchanged' && c.hasManual)
  if (notable.length > 0) {
    const label: Record<string, string> = {
      moved: '行號漂移',
      changed: '結構或主體變了',
      added: '新增',
      removed: '消失'
    }
    lines.push('')
    lines.push('## 動到的業務流程（有敘述的）')
    lines.push('')
    for (const c of notable.slice(0, 50)) lines.push(`- **[${label[c.kind]}]** \`${c.entryId}\`——${c.detail}`)
    if (notable.length > 50) lines.push(`- …另有 ${notable.length - 50} 條`)
  }

  lines.push('')
  lines.push('## 本輪做了什麼')
  lines.push('')
  lines.push(`- 機械改寫 ${round.reanchored.manualsChanged.length} 份敘述（${round.reanchored.refsRewritten} 處位置引用，0 token）`)
  if (round.narrated) {
    lines.push(
      `- LLM 重寫：寫入 ${round.narrated.written.length} 章 · 降級 ${round.narrated.degraded.length} 章 · 略過 ${round.narrated.skipped.length} 章`
    )
    if (round.narrated.aborted) lines.push(`  - API 中斷：${round.narrated.aborted}`)
  }
  if (round.archived.length > 0) {
    lines.push(`- 歸檔下架 ${round.archived.length} 份（流程已從程式碼消失）：`)
    for (const f of round.archived) lines.push(`  - \`${f}\``)
  }
  if (round.reanchored.unmapped.length > 0) {
    lines.push(`- 對照不到、原樣保留的引用 ${round.reanchored.unmapped.length} 處（verify 會標出，刻意不猜）`)
  }

  if (round.failures.length > 0) {
    lines.push('')
    lines.push('## 驗證未過（不部署原則：這些內容維持舊版或標為待補）')
    lines.push('')
    for (const f of round.failures) lines.push(`- \`${f.file}\`——${f.violations} 處引用問題`)
  }

  if (round.pending.length > 0) {
    lines.push('')
    lines.push('## 待人工佇列')
    lines.push('')
    const label: Record<PendingReason, string> = {
      'narrate-skipped': '敘述待補',
      'narrate-degraded': '重試用盡未過驗證',
      'verify-failed': '引用待修'
    }
    for (const p of round.pending) {
      lines.push(`- **[${label[p.reason]}]** \`${p.id}\`——${p.detail}（自 ${p.since.slice(0, 10)}）`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function short(commit: string | null): string {
  return commit ? commit.slice(0, 8) : '(非 git)'
}

// ---------------------------------------------------------------------------
// lockfile：防重入。nightly 排程重複喚醒、上一輪還沒跑完、或跑掛留下殭屍鎖，
// 都不該讓兩圈同時寫同一個手冊目錄。
// ---------------------------------------------------------------------------

export interface LockInfo {
  pid: number
  startedAt: string
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM ＝ 活著但無權限碰；其他（ESRCH）＝ 不在了
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 原子建檔（wx）取鎖。已存在時判斷持有者是否殭屍：行程不在了、或超過 staleMs
 * （narrate 重試再久也不該跑超過幾小時）——是殭屍就清掉重取，否則放棄這輪。
 */
export function acquireLock(
  file: string,
  staleMs: number,
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = pidAlive
): { ok: true } | { ok: false; detail: string } {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() } satisfies LockInfo)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, payload, { flag: 'wx' })
      return { ok: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let holder: LockInfo | null = null
      try {
        holder = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo
      } catch {
        holder = null
      }
      const stale =
        holder == null || !isAlive(holder.pid) || now - Date.parse(holder.startedAt) > staleMs
      if (!stale) {
        return {
          ok: false,
          detail: `pid ${holder!.pid} 自 ${holder!.startedAt} 持有 ${file}`
        }
      }
      fs.rmSync(file, { force: true })
    }
  }
  return { ok: false, detail: `清掉殭屍鎖後仍搶不到 ${file}` }
}

export function releaseLock(file: string): void {
  fs.rmSync(file, { force: true })
}
