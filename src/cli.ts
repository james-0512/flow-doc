#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { resolveConfig, type ResolvedConfig } from './config.js'
import { loadWorkspace, scanEntries } from './workspace.js'
import { defaultTraceOptions, traceEntries } from './analyze/trace.js'
import { defaultPackOptions, findPeers, groupByHandler, packFileName, packFlow, packOverviews } from './pack.js'
import { buildSite, defaultSiteOptions, slugify } from './site.js'
import { applyRenames, defaultDiffOptions, diffFlows, type ChangeKind } from './diff.js'
import { manualFileFor, readManualIndex } from './manuals.js'
import { buildLineMap, mergeLineMaps, reanchorManual, type LineMap } from './reanchor.js'
import { structureSignature } from './signature.js'
import { detectRenames } from './version.js'
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
      let chains = result.chains.filter(c => c.root != null)
      if (!opts.all) chains = chains.filter(c => c.isFlow)
      if (opts.domain) chains = chains.filter(c => c.domain === opts.domain)
      if (opts.flow) chains = chains.filter(c => c.entryId.includes(opts.flow!))

      fs.mkdirSync(opts.outDir, { recursive: true })
      // 先清掉舊封包。不清的話流程消失或改名後會留下孤兒檔案，
      // 閉環的 diff 與 PR 審查都會被這些永遠不再更新的殘骸混淆
      let removed = 0
      for (const f of fs.readdirSync(opts.outDir)) {
        if (!f.endsWith('.md')) continue
        fs.rmSync(path.join(opts.outDir, f))
        removed++
      }
      const packOpts = { maxSourceChars: Number(opts.maxChars) }
      let total = 0
      let merged = 0
      // 同一個 handler 只出一份封包，其餘觸發點列在封包內
      const groups = opts.perTrigger
        ? new Map(chains.map(c => [c, [] as typeof chains]))
        : groupByHandler(chains)
      for (const chain of result.crosscut) {
        const md = packFlow(result.repoRoot, chain, packOpts)
        if (md) {
          fs.writeFileSync(path.join(opts.outDir, packFileName(chain)), md, 'utf8')
          total += md.length
        }
      }
      const peers = findPeers([...groups.keys()])
      for (const [chain, siblings] of groups) {
        const md = packFlow(result.repoRoot, chain, packOpts, siblings, peers.get(chain) ?? [])
        if (!md) continue
        fs.writeFileSync(path.join(opts.outDir, packFileName(chain)), md, 'utf8')
        total += md.length
        merged += siblings.length
      }
      // 限制清單要跟著目錄走，讀手冊的人才知道「哪些東西手冊不會說」
      const limitations = fs.existsSync(opts.limitations)
        ? fs.readFileSync(opts.limitations, 'utf8')
        : undefined
      if (!limitations) console.warn(`（找不到 ${opts.limitations}，總覽將不含已知限制章節）`)
      const overviews = packOverviews(result, limitations)
      for (const [name, md] of overviews) fs.writeFileSync(path.join(opts.outDir, name), md, 'utf8')

      const packets = groups.size + result.crosscut.length
      console.log(`\n已打包 ${packets} 份封包到 ${path.resolve(opts.outDir)}（先清掉舊的 ${removed} 份）`)
      console.log(`  涵蓋 ${chains.length} 條流程 + ${result.crosscut.length} 條全域前置`)
      if (merged > 0) console.log(`  ${merged} 個觸發點與其他流程共用 handler，已合併（省下 ${merged} 份敘述）`)
      console.log(`  總字元 ${total.toLocaleString()} · 平均 ${packets ? Math.round(total / packets).toLocaleString() : 0} 字元/封包`)
      console.log(`  目錄：00-overview.md + ${overviews.size - 1} 份業務域清單`)
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
    const diff = diffFlows(baseline, current, index, {
      breakerThreshold: Number.MAX_SAFE_INTEGER,
      renames: renamesBetween(baseline, current)
    })
    if (diff.verdict === 'upgrade') {
      console.error(diff.reason)
      process.exitCode = 1
      return
    }

    const renames = renamesBetween(baseline, current)
    // baseline 側套用改名後才與現況同一個鍵空間，跟 diff 的配對方式一致
    const oldById = new Map(
      [...baseline.chains, ...baseline.crosscut].map(c => [applyRenames(c.entryId, renames), c])
    )
    const newById = new Map([...current.chains, ...current.crosscut].map(c => [c.entryId, c]))

    // 一份敘述涵蓋的不只一條鏈：`covers:` 宣告的、以及共用同一個 handler 的其他觸發點
    // （pack 就是依 handler 合併封包的，敘述的觸發表會列出各觸發點的位置）。
    // 只從 moved 的那幾條建表的話，其餘鏈的引用會查不到而被誤報成「對照不到」——
    // 它們其實只是不需要改。所以以檔案為單位收齊所有相關的鏈。
    const fileOfChain = new Map<string, string>()
    const handlerFile = new Map<string, string>()
    for (const c of newById.values()) {
      const file = manualFileFor(index, c.entryId)
      if (!file) continue
      fileOfChain.set(c.entryId, file)
      if (c.root) handlerFile.set(`${c.root.loc.file}:${c.root.loc.line}`, file)
    }
    for (const c of newById.values()) {
      if (fileOfChain.has(c.entryId) || !c.root) continue
      const file = handlerFile.get(`${c.root.loc.file}:${c.root.loc.line}`)
      if (file) fileOfChain.set(c.entryId, file)
    }

    const needsWork = new Set(diff.work.reanchor.map(id => fileOfChain.get(id)).filter(Boolean) as string[])
    const mapsByFile = new Map<string, LineMap[]>()
    for (const [entryId, file] of fileOfChain) {
      if (!needsWork.has(file)) continue
      const next = newById.get(entryId)
      const prev = oldById.get(entryId)
      // 結構不同的鏈不可以拿來建對照表：對錯位置比不改更糟
      if (!next || !prev || structureSignature(prev) !== structureSignature(next)) continue
      mapsByFile.set(file, [...(mapsByFile.get(file) ?? []), buildLineMap(prev, next)])
    }

    let changed = 0
    let refs = 0
    const stillUnmapped: string[] = []
    for (const [file, maps] of mapsByFile) {
      const abs = path.join(opts.manuals, file)
      if (!fs.existsSync(abs)) continue
      const before = fs.readFileSync(abs, 'utf8')
      const out = reanchorManual(before, mergeLineMaps(maps))
      refs += out.rewritten
      for (const u of out.unmapped) stillUnmapped.push(`${file} → ${u}`)
      if (out.text === before) continue
      changed++
      if (!opts.dryRun) fs.writeFileSync(abs, out.text, 'utf8')
    }

    console.log(`\n${opts.dryRun ? '（預演）' : ''}改寫 ${changed} 份敘述、共 ${refs} 處位置引用`)
    console.log(`  moved 且有敘述的流程 ${diff.work.reanchor.length} 條`)
    if (stillUnmapped.length > 0) {
      console.log(`\n對照不到、原樣保留的引用 ${stillUnmapped.length} 處（verify 會抓出來，不猜）：`)
      for (const u of stillUnmapped.slice(0, 10)) console.log(`  ${u}`)
      if (stillUnmapped.length > 10) console.log(`  …另有 ${stillUnmapped.length - 10} 處`)
    }
    console.log(`\n下一步：對改動過的章節跑 verify，確認引用都落在新封包內。`)
  })

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

await program.parseAsync()
