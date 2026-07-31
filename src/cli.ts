#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { loadWorkspace, scanEntries } from './workspace.js'
import { defaultTraceOptions, traceEntries } from './analyze/trace.js'
import { defaultPackOptions, writePackets } from './pack.js'
import { buildSite, defaultSiteOptions, slugify } from './site.js'
import { defaultDiffOptions, diffFlows, type ChangeKind } from './diff.js'
import { countInputTokens, createComplete, defaultLlmOptions, describeApiError } from './llm.js'
import { manualFileFor, readManualIndex } from './manuals.js'
import { acquireLock, releaseLock, runLoop, type LoopReport, type LoopSteps, type PendingEntry } from './loop.js'
import {
  buildSystemPrompt,
  buildUserPrompt,
  defaultNarrateOptions,
  findSkillRules,
  narrateTargets
} from './narrate.js'
import { reanchorAll } from './reanchor.js'
import { detectRenames, readTargetRevision } from './version.js'
import { verifyManual } from './verify.js'
import type { EntryScanResult, TraceResult } from './types.js'

function printSummary(result: EntryScanResult, topDomains: number): void {
  const { stats, entries, listeners } = result
  const byKind = new Map<string, number>()
  const byDomain = new Map<string, number>()
  for (const e of entries) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
    byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1)
  }

  console.log(`\n掃描完成（${stats.elapsedMs} ms）`)
  console.log(`  SFC ${stats.sfcFiles}（含 script ${stats.sfcWithScript}）· TS ${stats.tsFiles} · 路由檔 ${stats.routeFiles}`)
  console.log(`  全域自動註冊元件 ${stats.globalComponents}`)

  console.log(`\nentry 候選 ${entries.length} 筆`)
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(10)} ${n}`)
  }

  console.log(`\nemit listener 連結 ${listeners.length} 筆（階段三接合用）`)

  console.log(`\n業務域 top ${topDomains}：`)
  for (const [domain, n] of [...byDomain].sort((a, b) => b[1] - a[1]).slice(0, topDomains)) {
    console.log(`  ${domain.padEnd(28)} ${n}`)
  }
  console.log(`  （共 ${byDomain.size} 個域）`)

  console.log(`\n已知缺口：`)
  console.log(`  動態事件名（@[evt] / v-on="obj"）  ${stats.dynamicEventBindings}  ← 無法靜態判定，需人工確認`)
  console.log(`  標籤解析不到檔案的元件            ${stats.unresolvedComponentTags}  ← 第三方或動態元件`)
}

function printTraceSummary(result: TraceResult): void {
  const { stats, chains } = result
  const flows = chains.filter(c => c.isFlow)

  console.log(`\n追蹤完成（建 Program ${stats.programMs} ms · 追鏈 ${stats.traceMs} ms）`)
  console.log(`  swagger 端點索引 ${stats.swaggerEndpoints}`)
  console.log(`  可追蹤 entry ${stats.entriesTraced} · 成功起鏈 ${chains.length} · handler 無法解析 ${stats.entriesUnresolvedHandler}`)
  console.log(
    `\n流程 ${flows.length} 條：寫入型 ${stats.flows} · 查詢型 ${stats.readFlows}` +
      `（其餘 ${chains.length - flows.length} 條完全沒碰後端，為純 UI 操作）`
  )
  if (result.crosscut.length > 0) {
    console.log(`橫切邏輯 ${result.crosscut.length} 條（每條流程都會經過，獨立成章）：`)
    for (const c of result.crosscut) console.log(`  ${c.label.padEnd(26)} 節點 ${c.nodeCount} · 副作用 ${c.effects.length}`)
  }

  const byKind = new Map<string, number>()
  for (const c of chains) for (const e of c.effects) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  console.log(`\n副作用分布：`)
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${kind.padEnd(12)} ${n}`)

  const byDomain = new Map<string, number>()
  for (const c of flows) byDomain.set(c.domain, (byDomain.get(c.domain) ?? 0) + 1)
  console.log(`\n流程數 top 10 業務域：`)
  for (const [domain, n] of [...byDomain].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${domain.padEnd(24)} ${n}`)
  }

  const deepest = [...chains].sort((a, b) => b.nodeCount - a.nodeCount)[0]
  if (deepest) {
    console.log(`\n最大的一條鏈：${deepest.label}`)
    console.log(`  節點 ${deepest.nodeCount} · 深度 ${deepest.maxDepth} · 副作用 ${deepest.effects.length}`)
  }
  console.log(`\n非同步接合（階段三）：`)
  console.log(`  emit → parent handler 接起 ${stats.asyncLinksJoined} 條`)
  console.log(`  因為接上 parent 才成為流程的 entry ${stats.flowsGainedByJoin} 條`)
  console.log(`  v-model writeback（無 handler 可接，非缺口） ${stats.emitsModelBinding} 處`)
  console.log(`  找不到 parent listener 的 emit ${stats.emitsUnjoined} 處，出處：`)
  for (const { name, count } of stats.unjoinedEmitTop.slice(0, 8)) console.log(`    ${String(count).padStart(4)}  ${name}`)

  console.log(`\n上限與去重（都不靜默）：`)
  console.log(`  多實作候選未展開 ${stats.candidatesTruncated} 個（maxCandidates）`)
  console.log(`  parent listener 未展開 ${stats.listenersTruncated} 個（maxListeners）`)
  console.log(`  以參照取代的重複節點 ${stats.duplicateNodes} 個`)

  const unresolvedTotal = chains.reduce((s, c) => s + c.unresolvedCalls, 0)
  console.log(`\n已知缺口：鏈中解析不到定義的呼叫 ${unresolvedTotal} 次，最常見的：`)
  for (const { name, count } of stats.unresolvedTop.slice(0, 12)) console.log(`  ${String(count).padStart(5)}  ${name}`)
  if (stats.unresolvedHandlerTop.length > 0) {
    console.log(`\n無法起鏈的 handler：`)
    for (const { name, count } of stats.unresolvedHandlerTop.slice(0, 10)) console.log(`  ${String(count).padStart(5)}  ${name}`)
  }
}

/**
 * 解析設定與目標 repo；失敗時印出可行動的訊息並設 exit code，回傳 null。
 *
 * 每次都回報「分析誰、設定從哪來」——手冊與工具分家後，同一台機器上可能有
 * 多個目標，靜默地分析錯 repo 是最貴的失敗。
 */
function resolveTarget(repoArg: string | undefined, configPath?: string): ResolvedConfig | null {
  try {
    const resolved = resolveConfig({ repoArg, configPath })
    const from = resolved.configFile ?? '內建預設值'
    console.log(`目標 ${resolved.config.repoRoot}（來源：${resolved.targetSource}）\n設定 ${from}`)
    return resolved
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
    return null
  }
}

const program = new Command()
program.name('flow-doc').description('從 TS/Vue 程式碼庫追蹤業務流程，產出流程手冊').version('0.1.0')

program
  .command('entries')
  .description('階段一：掃描業務流程的 entry point 候選')
  .argument('[repo]', '目標 repo 路徑（省略時取設定檔 target 或 FLOW_DOC_TARGET）')
  .option('-o, --out <file>', '輸出 JSON 檔', 'flow-entries.json')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('--top <n>', '摘要列出的業務域數量', '15')
  .action(async (repo: string | undefined, opts: { out: string; config?: string; top: string }) => {
    const resolved = resolveTarget(repo, opts.config)
    if (!resolved) return
    const config = resolved.config
    const ws = await loadWorkspace(config)
    const result = scanEntries(ws)
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8')
    printSummary(result, Number(opts.top))
    console.log(`\n已寫入 ${path.resolve(opts.out)}`)
  })

program
  .command('trace')
  .description('階段二：從 entry 出發追同步 call chain')
  .argument('[repo]', '目標 repo 路徑（省略時取設定檔 target 或 FLOW_DOC_TARGET）')
  .option('-o, --out <file>', '輸出 JSON 檔', 'flow-chains.json')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('--domain <name>', '只追單一業務域，用於逐條檢查')
  .option('--max-depth <n>', 'DFS 深度上限', String(defaultTraceOptions.maxDepth))
  .action(
    async (
      repo: string | undefined,
      opts: { out: string; config?: string; domain?: string; maxDepth: string }
    ) => {
      const resolved = resolveTarget(repo, opts.config)
      if (!resolved) return
      const config = resolved.config
      const ws = await loadWorkspace(config)
      const scan = scanEntries(ws)
      if (opts.domain) {
        scan.entries = scan.entries.filter(e => e.domain === opts.domain)
        console.log(`只追 ${opts.domain} 域，entry 候選 ${scan.entries.length} 筆`)
      }
      console.log(`建立 Type Checker …`)
      const result = traceEntries(ws, scan, { ...defaultTraceOptions, maxDepth: Number(opts.maxDepth) })
      fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8')
      printTraceSummary(result)
      console.log(`\n已寫入 ${path.resolve(opts.out)}`)
    }
  )

program
  .command('pack')
  .description('階段四前置：把 chain 序列化成 LLM 可直接讀的生成封包')
  .argument('[chains]', 'trace 產出的 JSON', 'flow-chains.json')
  .option('-d, --out-dir <dir>', '輸出目錄', 'packets')
  .option('--domain <name>', '只打包單一業務域')
  .option('--flow <substr>', '只打包 entryId 含此字串的流程')
  .option('--all', '連非流程（純查詢／UI 操作）也打包', false)
  .option('--max-chars <n>', '單一封包的原始碼字元上限', String(defaultPackOptions.maxSourceChars))
  .option('--limitations <file>', '已知限制清單，會附在總覽末尾', 'LIMITATIONS.md')
  .option('--per-trigger', '每個觸發點各出一份封包，不依 handler 合併', false)
  .action(
    (
      chainsFile: string,
      opts: {
        outDir: string
        domain?: string
        flow?: string
        all: boolean
        maxChars: string
        limitations: string
        perTrigger: boolean
      }
    ) => {
      if (!fs.existsSync(chainsFile)) {
        console.error(`找不到 ${chainsFile}，請先執行 flow-doc trace`)
        process.exitCode = 1
        return
      }
      const result = JSON.parse(fs.readFileSync(chainsFile, 'utf8')) as TraceResult
      const summary = writePackets(result, {
        outDir: opts.outDir,
        domain: opts.domain,
        flow: opts.flow,
        all: opts.all,
        maxSourceChars: Number(opts.maxChars),
        limitationsFile: opts.limitations,
        perTrigger: opts.perTrigger
      })
      if (!summary.limitationsFound) console.warn(`（找不到 ${opts.limitations}，總覽將不含已知限制章節）`)

      console.log(`\n已打包 ${summary.packets} 份封包到 ${path.resolve(opts.outDir)}（先清掉舊的 ${summary.removedOld} 份）`)
      console.log(`  涵蓋 ${summary.chainsCovered} 條流程 + ${summary.crosscut} 條全域前置`)
      if (summary.mergedTriggers > 0)
        console.log(
          `  ${summary.mergedTriggers} 個觸發點與其他流程共用 handler，已合併（省下 ${summary.mergedTriggers} 份敘述）`
        )
      console.log(
        `  總字元 ${summary.totalChars.toLocaleString()} · 平均 ${summary.packets ? Math.round(summary.totalChars / summary.packets).toLocaleString() : 0} 字元/封包`
      )
      console.log(`  目錄：00-overview.md + ${summary.overviews - 1} 份業務域清單`)
    }
  )

program
  .command('site')
  .description('產生 VitePress 靜態站（由分析結果驅動，有手冊敘述的流程一併帶入）')
  .argument('[chains]', 'trace 產出的 JSON', 'flow-chains.json')
  .option('-d, --out-dir <dir>', '輸出目錄', 'site')
  .option('-m, --manuals <dir>', '手冊敘述目錄，檔名為 <entryId 的 slug>.md')
  .option('--title <text>', '站台標題', defaultSiteOptions.title)
  .option('--source-base <url>', '原始碼連結前綴，例如 https://github.com/org/repo/blob/main/', '')
  .option('--limitations <file>', '已知限制清單', 'LIMITATIONS.md')
  .action(
    (
      chainsFile: string,
      opts: { outDir: string; manuals?: string; title: string; sourceBase: string; limitations: string }
    ) => {
      if (!fs.existsSync(chainsFile)) {
        console.error(`找不到 ${chainsFile}，請先執行 flow-doc trace`)
        process.exitCode = 1
        return
      }
      const result = JSON.parse(fs.readFileSync(chainsFile, 'utf8')) as TraceResult

      // 手冊敘述以 entryId 的 slug 命名，有幾條放幾條
      const manuals = new Map<string, string>()
      const primaries = new Set<string>()
      const overviews = new Map<string, string>()
      if (opts.manuals && fs.existsSync(opts.manuals)) {
        // 篇章總覽：overviews/<域 slug>.md，注入該域 index 頁的流程清單之前
        const index = readManualIndex(opts.manuals)
        for (const [k, v] of index.overviews) overviews.set(k, v)
        const all = [...result.crosscut, ...result.chains]
        for (const c of all) {
          const direct = index.bySlug.get(slugify(c.entryId))
          const hit = direct ?? index.byCovers.get(c.entryId)
          if (!hit) continue
          manuals.set(c.entryId, hit)
          // 檔名直接對應的流程是這份敘述的代表，索引與側邊欄會連到它
          if (direct) primaries.add(c.entryId)
        }
        // 一份敘述涵蓋整組共用 handler 的觸發點（pack 也是依此合併的），
        // 否則同一條程式碼路徑的其他觸發鈕會顯示成「尚未撰寫」
        const byHandler = new Map<string, string>()
        for (const c of all) {
          const md = manuals.get(c.entryId)
          if (md && c.root) byHandler.set(`${c.root.loc.file}:${c.root.loc.line}`, md)
        }
        for (const c of all) {
          if (manuals.has(c.entryId) || !c.root) continue
          const md = byHandler.get(`${c.root.loc.file}:${c.root.loc.line}`)
          if (md) manuals.set(c.entryId, md)
        }
      }

      const limitations = fs.existsSync(opts.limitations) ? fs.readFileSync(opts.limitations, 'utf8') : undefined
      const pages = buildSite(
        result,
        manuals,
        limitations,
        { title: opts.title, sourceBaseUrl: opts.sourceBase },
        primaries,
        overviews
      )

      fs.rmSync(path.join(opts.outDir, 'flows'), { recursive: true, force: true })
      for (const page of pages) {
        const dest = path.join(opts.outDir, page.file)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.writeFileSync(dest, page.content, 'utf8')
      }

      const bytes = pages.reduce((s, p) => s + p.content.length, 0)
      console.log(`\n已產生 ${pages.length} 個頁面到 ${path.resolve(opts.outDir)}`)
      console.log(`  流程 ${result.chains.filter(c => c.isFlow).length} 條 · 全域前置 ${result.crosscut.length} 條 · 已撰寫敘述 ${manuals.size} 條`)
      console.log(`  總計 ${(bytes / 1024).toFixed(0)} KB`)
      console.log(`\n預覽：pnpm site:dev`)
    }
  )

/**
 * 兩份分析之間的檔案改名對照。取不到就回空表——退回「改名視為 removed＋added」
 * 的保守行為，比猜錯安全。
 */
function renamesBetween(baseline: TraceResult, current: TraceResult): Map<string, string> {
  const from = baseline.target?.commit
  const to = current.target?.commit
  if (!from || !to || from === to) return new Map()
  return detectRenames(current.repoRoot, from, to)
}

program
  .command('diff')
  .description('閉環核心：比對 baseline 與本次分析，把每條流程分成五類並算出要做的事')
  .argument('<baseline>', '上一輪的 flow-chains.json')
  .argument('[current]', '本次分析結果', 'flow-chains.json')
  .option('-m, --manuals <dir>', '手冊敘述目錄——沒有既有敘述的流程只報告，不產生工作', 'manuals')
  .option('-o, --out <file>', '把完整結果寫成 JSON 供閉環腳本判讀')
  .option('--threshold <n>', '需重寫章數超過此值就熔斷', String(defaultDiffOptions.breakerThreshold))
  .action(
    (baselineFile: string, currentFile: string, opts: { manuals: string; out?: string; threshold: string }) => {
      for (const f of [baselineFile, currentFile]) {
        if (!fs.existsSync(f)) {
          console.error(`找不到 ${f}`)
          process.exitCode = 1
          return
        }
      }
      const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as TraceResult
      const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as TraceResult
      const renames = renamesBetween(baseline, current)
      if (renames.size > 0) console.log(`\n偵測到 ${renames.size} 個檔案改名，已對照後再比對`)
      const result = diffFlows(baseline, current, readManualIndex(opts.manuals), {
        breakerThreshold: Number(opts.threshold),
        renames
      })

      console.log(`\nbaseline  ${result.baseline.commit?.slice(0, 8) ?? '(非 git)'} · 表示法 v${result.baseline.representation}`)
      console.log(`本次      ${result.current.commit?.slice(0, 8) ?? '(非 git)'} · 表示法 v${result.current.representation}${result.current.dirty ? ' · **工作目錄有未提交變動**' : ''}`)

      if (result.current.dirty) {
        console.log(`\n注意：dirty 的樹產出的結果不可重現，不該當成下一輪的 baseline。`)
      }

      const LABEL: Record<ChangeKind, string> = {
        unchanged: '沒變',
        moved: '只有行號漂移',
        changed: '結構或主體變了',
        added: '新增',
        removed: '消失'
      }
      console.log(`\n流程分類：`)
      for (const kind of ['unchanged', 'moved', 'changed', 'added', 'removed'] as ChangeKind[]) {
        console.log(`  ${LABEL[kind].padEnd(14)} ${result.counts[kind]}`)
      }

      console.log(`\n要做的事（只算有既有敘述的）：`)
      console.log(`  機械改寫行號（0 token） ${result.work.reanchor.length}`)
      console.log(`  LLM 重寫                ${result.work.rewrite.length}`)
      console.log(`  歸檔下架                ${result.work.archive.length}`)

      const notable = result.changes.filter(c => c.kind !== 'unchanged' && c.hasManual)
      if (notable.length > 0) {
        console.log(`\n有敘述且有變動的流程（前 15 筆）：`)
        for (const c of notable.slice(0, 15)) console.log(`  [${LABEL[c.kind]}] ${c.entryId}\n      ${c.detail}`)
        if (notable.length > 15) console.log(`  …另有 ${notable.length - 15} 筆`)
      }

      console.log(`\n判定：${result.verdict}——${result.reason}`)

      if (opts.out) {
        fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8')
        console.log(`已寫入 ${path.resolve(opts.out)}`)
      }
    }
  )

program
  .command('reanchor')
  .description('把 moved 分類的敘述機械改寫到新位置——0 token，不動任何文字內容')
  .argument('<baseline>', '上一輪的 flow-chains.json')
  .argument('[current]', '本次分析結果', 'flow-chains.json')
  .option('-m, --manuals <dir>', '手冊敘述目錄', 'manuals')
  .option('--dry-run', '只列出會怎麼改，不寫檔', false)
  .action((baselineFile: string, currentFile: string, opts: { manuals: string; dryRun: boolean }) => {
    for (const f of [baselineFile, currentFile]) {
      if (!fs.existsSync(f)) {
        console.error(`找不到 ${f}`)
        process.exitCode = 1
        return
      }
    }
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as TraceResult
    const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as TraceResult
    const index = readManualIndex(opts.manuals)
    const renames = renamesBetween(baseline, current)
    const diff = diffFlows(baseline, current, index, {
      breakerThreshold: Number.MAX_SAFE_INTEGER,
      renames
    })
    if (diff.verdict === 'upgrade') {
      console.error(diff.reason)
      process.exitCode = 1
      return
    }

    const out = reanchorAll(baseline, current, diff, index, opts.manuals, renames, { dryRun: opts.dryRun })

    console.log(`\n${opts.dryRun ? '（預演）' : ''}改寫 ${out.manualsChanged.length} 份敘述、共 ${out.refsRewritten} 處位置引用`)
    console.log(`  moved 且有敘述的流程 ${out.movedWithManual} 條`)
    if (out.unmapped.length > 0) {
      console.log(`\n對照不到、原樣保留的引用 ${out.unmapped.length} 處（verify 會抓出來，不猜）：`)
      for (const u of out.unmapped.slice(0, 10)) console.log(`  ${u}`)
      if (out.unmapped.length > 10) console.log(`  …另有 ${out.unmapped.length - 10} 處`)
    }
    console.log(`\n下一步：對改動過的章節跑 verify，確認引用都落在新封包內。`)
  })

program
  .command('narrate')
  .description('用 API 產出 changed／added 章節的敘述，verify 當驗收關（唯一花 token 的一步）')
  .argument('<baseline>', '上一輪的 flow-chains.json')
  .argument('[current]', '本次分析結果', 'flow-chains.json')
  .option('-m, --manuals <dir>', '手冊敘述目錄', 'manuals')
  .option('-p, --packets <dir>', '封包目錄', 'packets')
  .option('-s, --skill <file>', 'flow-manual 的 SKILL.md（規則來源）')
  .option('--model <id>', '模型', defaultLlmOptions.model)
  .option('--effort <level>', 'low | medium | high | xhigh | max', defaultLlmOptions.effort)
  .option('--max-tokens <n>', '單次生成上限（思考與輸出共用）', String(defaultLlmOptions.maxTokens))
  .option('--retries <n>', '驗證失敗後的重試次數', String(defaultNarrateOptions.retries))
  .option('--limit <n>', '最多寫幾章，避免一次燒掉預算')
  .option('--only <substr>', '只處理 entryId 含此字串的章節')
  .option('--dry-run', '只列出要寫哪幾章與預估輸入 token，不呼叫生成', false)
  .action(
    async (
      baselineFile: string,
      currentFile: string,
      opts: {
        manuals: string
        packets: string
        skill?: string
        model: string
        effort: string
        maxTokens: string
        retries: string
        limit?: string
        only?: string
        dryRun: boolean
      }
    ) => {
      for (const f of [baselineFile, currentFile]) {
        if (!fs.existsSync(f)) {
          console.error(`找不到 ${f}`)
          process.exitCode = 1
          return
        }
      }
      const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as TraceResult
      const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as TraceResult
      const index = readManualIndex(opts.manuals)
      const diff = diffFlows(baseline, current, index, {
        breakerThreshold: Number.MAX_SAFE_INTEGER,
        renames: renamesBetween(baseline, current)
      })
      if (diff.verdict === 'upgrade') {
        console.error(diff.reason)
        process.exitCode = 1
        return
      }

      const system = buildSystemPrompt(fs.readFileSync(findSkillRules(opts.skill), 'utf8'))
      const byId = new Map([...current.chains, ...current.crosscut].map(c => [c.entryId, c]))
      let targets = diff.work.rewrite
      if (opts.only) targets = targets.filter(id => id.includes(opts.only!))
      const dropped = opts.limit ? Math.max(0, targets.length - Number(opts.limit)) : 0
      if (opts.limit) targets = targets.slice(0, Number(opts.limit))

      console.log(`\n需重寫 ${diff.work.rewrite.length} 章，本次處理 ${targets.length} 章`)
      // 上限必須看得見。靜默截斷會讓人以為「全部寫完了」
      if (dropped > 0) console.log(`  （--limit 略過 ${dropped} 章，下次再跑）`)
      if (targets.length === 0) return

      if (opts.dryRun) {
        let inputTotal = 0
        for (const entryId of targets) {
          if (!byId.has(entryId)) continue
          const slug = slugify(entryId)
          const packetFile = path.join(opts.packets, `${slug}.md`)
          if (!fs.existsSync(packetFile)) {
            console.log(`  ⚠ 找不到封包，略過：${slug}`)
            continue
          }
          const packet = fs.readFileSync(packetFile, 'utf8')
          const tokens = await countInputTokens(system, buildUserPrompt(packet), opts.model)
          inputTotal += tokens
          console.log(`  ${slug}\n      封包 ${packet.length.toLocaleString()} 字元 · 輸入約 ${tokens.toLocaleString()} tokens`)
        }
        console.log(`\n（預演）輸入合計約 ${inputTotal.toLocaleString()} tokens`)
        return
      }

      const summary = await narrateTargets(
        targets,
        { current, index, manualsDir: opts.manuals, packetsDir: opts.packets, system },
        createComplete({ model: opts.model, effort: opts.effort, maxTokens: Number(opts.maxTokens) }),
        {
          retries: Number(opts.retries),
          progress: {
            start: slug => process.stdout.write(`  ${slug} … `),
            done: (line, violations) => {
              console.log(line)
              for (const v of (violations ?? []).slice(0, 3)) console.log(`      ✗ ${v.reference} — ${v.detail}`)
            },
            skip: (slug, detail) => console.log(`  ⚠ ${detail}，略過：${slug}`)
          }
        }
      )

      if (summary.aborted) {
        // 已寫入的章節保留——中途失敗不該讓前面成功的白做，下次跑會跳過它們
        console.error(`\n${summary.aborted}`)
        if (summary.written.length > 0) console.error(`（本次已寫入 ${summary.written.length} 章，那些保留不動）`)
        process.exitCode = 1
        return
      }

      console.log(`\n寫入 ${summary.written.length} 章 · 降級待人工 ${summary.degraded.length} 章`)
      console.log(
        `token：輸入 ${summary.usage.input.toLocaleString()}（快取讀 ${summary.usage.cacheRead.toLocaleString()}／寫 ${summary.usage.cacheWrite.toLocaleString()}）· 輸出 ${summary.usage.output.toLocaleString()}`
      )
      console.log(`\n下一步：flow-doc site 重產站台。降級的章節維持舊敘述，站上標為待補。`)
    }
  )

program
  .command('verify')
  .description('階段四後置：檢查生成的手冊沒有幻覺（引用的 file:line 必須真實且在封包範圍內）')
  .argument('<manual>', '生成的手冊 Markdown')
  .option('-r, --repo <path>', '目標 repo 路徑（省略時取設定檔 target 或 FLOW_DOC_TARGET）')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('-p, --packet <file>', '對應的流程封包，用來檢查引用是否超出提供範圍')
  .action((manual: string, opts: { repo?: string; config?: string; packet?: string }) => {
    const resolved = resolveTarget(opts.repo, opts.config)
    if (!resolved) return
    const markdown = fs.readFileSync(manual, 'utf8')
    const packet = opts.packet ? fs.readFileSync(opts.packet, 'utf8') : undefined
    const result = verifyManual(markdown, resolved.config.repoRoot, packet)

    console.log(`\n檢查 ${manual}`)
    console.log(`  位置引用 ${result.references} 處 · 問題 ${result.violations.length} 處`)
    for (const v of result.violations) console.log(`  ✗ [${v.kind}] ${v.reference} — ${v.detail}`)
    if (result.violations.length === 0) console.log(`  全部通過`)
    else process.exitCode = 1
  })

program
  .command('loop')
  .description(
    '閉環一圈：早退比對 → trace → diff 分流 →（reanchor／narrate／歸檔）→ verify → commit。' +
      'exit code：0 完成或早退 · 1 錯誤 · 2 需人工（升版圈／熔斷／無 baseline） · 3 這輪沒跑（鎖／dirty／缺 generated 檔）'
  )
  .argument('[repo]', '目標 repo 路徑（省略時取設定檔 target 或 FLOW_DOC_TARGET）')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('-b, --baseline <file>', '上一輪分析結果，也是本輪寫回的新 baseline', 'flow-chains.json')
  .option('-m, --manuals <dir>', '手冊敘述目錄', 'manuals')
  .option('-p, --packets <dir>', '封包目錄', 'packets')
  .option('--threshold <n>', '需重寫章數超過此值就熔斷', String(defaultDiffOptions.breakerThreshold))
  .option('--dry-run', '分析與 diff 照跑，之後只報告，不寫任何檔案', false)
  .option('--no-narrate', '跳過 LLM 生成，該寫的章節進待補佇列（無憑證環境，或先驗證 0-token 那半圈）')
  .option('--limit <n>', '單輪最多寫幾章，其餘進待補佇列')
  .option('-s, --skill <file>', 'flow-manual 的 SKILL.md（規則來源）')
  .option('--model <id>', '模型', defaultLlmOptions.model)
  .option('--effort <level>', 'low | medium | high | xhigh | max', defaultLlmOptions.effort)
  .option('--max-tokens <n>', '單次生成上限（思考與輸出共用）', String(defaultLlmOptions.maxTokens))
  .option('--retries <n>', '驗證失敗後的重試次數', String(defaultNarrateOptions.retries))
  .option('--no-commit', '改完不 commit（除錯用；殘留的變更會讓下一輪拒跑）')
  .option('--pr', 'commit 到新分支、push 並開 PR（需 gh）；純機械輪嘗試自動合併', false)
  .option('--allow-dirty', '目標 repo dirty 仍分析（只能搭配 --dry-run）', false)
  .option('--lock-stale-minutes <n>', '鎖超過此分鐘數視為殭屍', '360')
  .option('--out <file>', '機器可讀的輪次報告（dry-run 不寫）', 'loop-result.json')
  .action(
    async (
      repo: string | undefined,
      opts: {
        config?: string
        baseline: string
        manuals: string
        packets: string
        threshold: string
        dryRun: boolean
        narrate: boolean
        limit?: string
        skill?: string
        model: string
        effort: string
        maxTokens: string
        retries: string
        commit: boolean
        pr: boolean
        allowDirty: boolean
        lockStaleMinutes: string
        out: string
      }
    ) => {
      if (opts.allowDirty && !opts.dryRun) {
        console.error('--allow-dirty 只能搭配 --dry-run：dirty 的樹產出的結果不可重現，不能寫回 baseline')
        process.exitCode = 1
        return
      }
      const resolved = resolveTarget(repo, opts.config)
      if (!resolved) return
      const config = resolved.config
      const cwd = process.cwd()
      const targetName = path.basename(cwd)
      const lockFile = path.join(cwd, '.flow-doc-loop.lock')
      const pendingFile = path.join(cwd, 'pending.json')
      const changesFile = path.join(cwd, 'CHANGES.md')

      const gitHere = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
      if (!opts.dryRun && opts.commit) {
        try {
          gitHere(['rev-parse', '--is-inside-work-tree'])
        } catch {
          console.error('手冊目錄不在 git repo 裡。閉環的狀態存在 git（回滾＝revert）——先 git init，或改用 --no-commit')
          process.exitCode = 1
          return
        }
      }

      // loop 自己的工作檔不算「目錄不乾淨」（進不了版控的東西不該擋住自己）
      const OWN_FILES = new Set(['.flow-doc-loop.lock', path.basename(opts.out)])

      let renamesCache: Map<string, string> | null = null
      const renamesOf = (baseline: TraceResult, current: TraceResult) => {
        renamesCache ??= renamesBetween(baseline, current)
        return renamesCache
      }
      const freshIndex = () => readManualIndex(opts.manuals)

      const steps: LoopSteps = {
        acquireLock: () => acquireLock(lockFile, Number(opts.lockStaleMinutes) * 60_000),
        releaseLock: () => releaseLock(lockFile),
        readBaseline: () =>
          fs.existsSync(opts.baseline) ? (JSON.parse(fs.readFileSync(opts.baseline, 'utf8')) as TraceResult) : null,
        targetRevision: () => readTargetRevision(config.repoRoot),
        missingGenerated: () => {
          if (!config.globalComponentsDts) return []
          return fs.existsSync(path.join(config.repoRoot, config.globalComponentsDts))
            ? []
            : [config.globalComponentsDts]
        },
        manualsClean: () => {
          try {
            return (
              gitHere(['status', '--porcelain', '--', '.'])
                .split('\n')
                .filter(l => l.trim() !== '')
                .filter(l => !OWN_FILES.has(path.basename(l.slice(3).trim()))).length === 0
            )
          } catch {
            return true // 不是 git repo（--no-commit 除錯模式）就不擋
          }
        },
        trace: async () => {
          const ws = await loadWorkspace(config)
          const scan = scanEntries(ws)
          return traceEntries(ws, scan, defaultTraceOptions)
        },
        diff: (baseline, current) =>
          diffFlows(baseline, current, freshIndex(), {
            breakerThreshold: Number(opts.threshold),
            renames: renamesOf(baseline, current)
          }),
        pack: current => ({
          packets: writePackets(current, { outDir: opts.packets, limitationsFile: 'LIMITATIONS.md' }).packets
        }),
        archive: (ids, current) => {
          const index = freshIndex()
          // 一份敘述可能同時涵蓋消失的與存活的觸發點（covers: 或共用 handler）。
          // 檔案還被任何存活流程用到就不動——寧可留著也不能把活流程的敘述搬走
          const all = [...current.chains, ...current.crosscut]
          const stillUsed = new Set<string>()
          const handlerFile = new Map<string, string>()
          for (const c of all) {
            const f = manualFileFor(index, c.entryId)
            if (!f) continue
            stillUsed.add(f)
            if (c.root) handlerFile.set(`${c.root.loc.file}:${c.root.loc.line}`, f)
          }
          for (const c of all) {
            if (!c.root) continue
            const f = handlerFile.get(`${c.root.loc.file}:${c.root.loc.line}`)
            if (f) stillUsed.add(f)
          }
          const moved: string[] = []
          for (const id of ids) {
            const f = manualFileFor(index, id)
            if (!f || stillUsed.has(f) || moved.includes(f)) continue
            const from = path.join(opts.manuals, f)
            if (!fs.existsSync(from)) continue
            fs.mkdirSync(path.join(opts.manuals, 'archive'), { recursive: true })
            fs.renameSync(from, path.join(opts.manuals, 'archive', f))
            moved.push(f)
          }
          return { moved }
        },
        reanchor: (baseline, current, d) =>
          reanchorAll(baseline, current, d, freshIndex(), opts.manuals, renamesOf(baseline, current)),
        narrate: async (targets, current) => {
          try {
            const system = buildSystemPrompt(fs.readFileSync(findSkillRules(opts.skill), 'utf8'))
            return await narrateTargets(
              targets,
              { current, index: freshIndex(), manualsDir: opts.manuals, packetsDir: opts.packets, system },
              createComplete({ model: opts.model, effort: opts.effort, maxTokens: Number(opts.maxTokens) }),
              {
                retries: Number(opts.retries),
                limit: opts.limit ? Number(opts.limit) : undefined,
                progress: {
                  start: slug => process.stdout.write(`  ${slug} … `),
                  done: line => console.log(line),
                  skip: (slug, detail) => console.log(`  ⚠ ${detail}，略過：${slug}`)
                }
              }
            )
          } catch (err) {
            // 開工前就掛（無憑證、找不到 SKILL.md）也走降級：章節進佇列、輪次照樣收尾。
            // 中斷整輪的話 reanchor 與歸檔的成果也會一起沒 commit
            const why = describeApiError(err)
            console.error(`  narrate 無法啟動：${why}`)
            return {
              written: [],
              degraded: [],
              skipped: targets.map(entryId => ({ entryId, detail: `narrate 無法啟動：${why}` })),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              aborted: why
            }
          }
        },
        verify: files => {
          const failures: { file: string; violations: number }[] = []
          for (const file of files) {
            const abs = path.join(opts.manuals, file)
            if (!fs.existsSync(abs)) continue
            // 封包與手冊同 slug 命名，直接以檔名對應；封包不在就退回「只驗 repo 位置」
            const packetFile = path.join(opts.packets, file)
            const packet = fs.existsSync(packetFile) ? fs.readFileSync(packetFile, 'utf8') : undefined
            const result = verifyManual(fs.readFileSync(abs, 'utf8'), config.repoRoot, packet)
            if (result.violations.length > 0) failures.push({ file, violations: result.violations.length })
          }
          return failures
        },
        readPending: () =>
          fs.existsSync(pendingFile) ? (JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as PendingEntry[]) : [],
        writePending: entries => fs.writeFileSync(pendingFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8'),
        writeChanges: md => fs.writeFileSync(changesFile, md, 'utf8'),
        writeBaseline: current => fs.writeFileSync(opts.baseline, JSON.stringify(current, null, 2), 'utf8'),
        commit: (message, changesMd, autoMergeEligible) => {
          const trackPaths = [opts.manuals, opts.packets, opts.baseline, 'CHANGES.md', 'pending.json']
          const branchBefore = gitHere(['rev-parse', '--abbrev-ref', 'HEAD'])
          let branch = branchBefore
          if (opts.pr) {
            branch = `loop/${targetName}/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
            gitHere(['checkout', '-b', branch])
          }
          try {
            gitHere(['add', '-A', '--', ...trackPaths])
            try {
              gitHere(['diff', '--cached', '--quiet'])
              // 與上一輪完全相同，沒東西可 commit
              if (opts.pr) {
                gitHere(['checkout', branchBefore])
                gitHere(['branch', '-D', branch])
              }
              console.log('（內容與上一輪完全相同，略過 commit）')
              return { branch: branchBefore, sha: gitHere(['rev-parse', 'HEAD']), autoMerge: false }
            } catch {
              /* 有變更，繼續 commit */
            }
            gitHere(['commit', '-m', message])
            const sha = gitHere(['rev-parse', 'HEAD'])
            let pr: string | undefined
            if (opts.pr) {
              gitHere(['push', '-u', 'origin', branch])
              const bodyFile = path.join(os.tmpdir(), `flow-doc-pr-${process.pid}.md`)
              fs.writeFileSync(bodyFile, changesMd, 'utf8')
              try {
                pr = execFileSync('gh', ['pr', 'create', '--title', message, '--body-file', bodyFile], {
                  cwd,
                  encoding: 'utf8'
                }).trim()
                if (autoMergeEligible) {
                  try {
                    execFileSync('gh', ['pr', 'merge', '--auto', '--squash'], { cwd, encoding: 'utf8' })
                  } catch {
                    console.warn('（自動合併沒成功——PR 留著等人審，不影響本輪結果）')
                  }
                }
              } finally {
                fs.rmSync(bodyFile, { force: true })
              }
            }
            return { branch, sha, pr, autoMerge: opts.pr && autoMergeEligible }
          } finally {
            // PR 模式跑完回到原分支，別把使用者（或 CI workspace）留在 loop 分支上
            if (opts.pr && branchBefore !== 'HEAD') {
              try {
                gitHere(['checkout', branchBefore])
              } catch {
                /* 留在分支上也只是不便，不是錯誤 */
              }
            }
          }
        },
        log: line => console.log(line)
      }

      let report: LoopReport
      try {
        report = await runLoop(steps, {
          dryRun: opts.dryRun,
          narrate: opts.narrate,
          commit: opts.commit,
          allowDirty: opts.allowDirty,
          targetName
        })
      } catch (err) {
        // 到這裡的都是 git／gh／檔案系統層的錯（API 錯誤在 narrate 步驟內就降級了）。
        // PR 模式在 gh 失敗時分支已推上去——工作不會丟，下一輪重跑即可
        console.error((err as Error).message ?? String(err))
        process.exitCode = 1
        return
      }

      const OUTCOME_LABEL: Record<LoopReport['outcome'], string> = {
        'early-exit': '早退',
        completed: '完成',
        'dry-run': '預演',
        'needs-human': '需人工',
        'not-run': '這輪沒跑'
      }
      console.log(`\n【${OUTCOME_LABEL[report.outcome]}】${report.reason}`)
      if (report.counts) {
        console.log(
          `  分類：沒變 ${report.counts.unchanged} · 行號漂移 ${report.counts.moved} · 結構或主體變了 ${report.counts.changed} · 新增 ${report.counts.added} · 消失 ${report.counts.removed}`
        )
      }
      if (report.reanchored) {
        console.log(`  機械改寫 ${report.reanchored.manualsChanged.length} 份敘述（${report.reanchored.refsRewritten} 處引用）`)
      }
      if (report.narrated) {
        console.log(
          `  LLM：寫入 ${report.narrated.written.length} · 降級 ${report.narrated.degraded.length} · 略過 ${report.narrated.skipped.length}` +
            `（token 輸入 ${report.narrated.usage.input.toLocaleString()} · 輸出 ${report.narrated.usage.output.toLocaleString()}）`
        )
        if (report.narrated.aborted) console.log(`  narrate 中斷：${report.narrated.aborted.split('\n')[0]}`)
      }
      if (report.archived.length > 0) console.log(`  歸檔 ${report.archived.length} 份`)
      if (report.verifyFailures.length > 0) {
        console.log(`  驗證未過 ${report.verifyFailures.length} 份：`)
        for (const f of report.verifyFailures.slice(0, 10)) console.log(`    ✗ ${f.file}（${f.violations} 處）`)
      }
      if (report.pending.length > 0) {
        console.log(`  待人工佇列 ${report.pending.length} 筆（詳見 pending.json 與 CHANGES.md）`)
      }
      if (report.committed) {
        console.log(
          `  已 commit ${report.committed.sha.slice(0, 8)} 於 ${report.committed.branch}` +
            (report.committed.pr ? ` · PR ${report.committed.pr}${report.committed.autoMerge ? '（已排自動合併）' : ''}` : '')
        )
      }

      if (!opts.dryRun) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      process.exitCode = report.exitCode
    }
  )

await program.parseAsync()
