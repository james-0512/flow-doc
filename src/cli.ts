#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { loadConfig } from './config.js'
import { loadWorkspace, scanEntries } from './workspace.js'
import { defaultTraceOptions, traceEntries } from './analyze/trace.js'
import { defaultPackOptions, findPeers, groupByHandler, packFileName, packFlow, packOverviews } from './pack.js'
import { buildSite, defaultSiteOptions, slugify } from './site.js'
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
 * 取出手冊 frontmatter 裡的 `covers:` 清單。
 *
 * 用意是讓一份敘述明確涵蓋多個觸發點（篩選、分頁、查詢鈕往往是同一個業務動作），
 * 而不是靠副作用相同就自動合併——核准與駁回也可能打同一支 API。
 */
function parseCovers(markdown: string): string[] {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)
  if (!frontmatter) return []
  const block = /(?:^|\n)covers:\s*\n((?:\s*-\s*.+\n?)+)/.exec(frontmatter[1]!)
  if (!block) return []
  return [...block[1]!.matchAll(/^\s*-\s*(.+?)\s*$/gm)].map(m => m[1]!)
}

const program = new Command()
program.name('flow-doc').description('從 TS/Vue 程式碼庫追蹤業務流程，產出流程手冊').version('0.1.0')

program
  .command('entries')
  .description('階段一：掃描業務流程的 entry point 候選')
  .argument('<repo>', '目標 repo 路徑')
  .option('-o, --out <file>', '輸出 JSON 檔', 'flow-entries.json')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('--top <n>', '摘要列出的業務域數量', '15')
  .action(async (repo: string, opts: { out: string; config?: string; top: string }) => {
    const repoRoot = path.resolve(repo)
    if (!fs.existsSync(repoRoot)) {
      console.error(`找不到目標 repo：${repoRoot}`)
      process.exitCode = 1
      return
    }
    const config = loadConfig(repoRoot, opts.config)
    console.log(`載入 ${repoRoot} …`)
    const ws = await loadWorkspace(config)
    const result = scanEntries(ws)
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2), 'utf8')
    printSummary(result, Number(opts.top))
    console.log(`\n已寫入 ${path.resolve(opts.out)}`)
  })

program
  .command('trace')
  .description('階段二：從 entry 出發追同步 call chain')
  .argument('<repo>', '目標 repo 路徑')
  .option('-o, --out <file>', '輸出 JSON 檔', 'flow-chains.json')
  .option('-c, --config <file>', 'flow-doc.config.json 路徑')
  .option('--domain <name>', '只追單一業務域，用於逐條檢查')
  .option('--max-depth <n>', 'DFS 深度上限', String(defaultTraceOptions.maxDepth))
  .action(
    async (repo: string, opts: { out: string; config?: string; domain?: string; maxDepth: string }) => {
      const repoRoot = path.resolve(repo)
      if (!fs.existsSync(repoRoot)) {
        console.error(`找不到目標 repo：${repoRoot}`)
        process.exitCode = 1
        return
      }
      const config = loadConfig(repoRoot, opts.config)
      console.log(`載入 ${repoRoot} …`)
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
      console.log(`\n已打包 ${packets} 份封包到 ${path.resolve(opts.outDir)}`)
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
      if (opts.manuals && fs.existsSync(opts.manuals)) {
        const byslug = new Map<string, string>()
        const byCovers = new Map<string, string>()
        for (const f of fs.readdirSync(opts.manuals)) {
          if (!f.endsWith('.md')) continue
          const md = fs.readFileSync(path.join(opts.manuals, f), 'utf8')
          byslug.set(f.replace(/\.md$/, ''), md)
          // 一份敘述可用 frontmatter 的 covers: 明確宣告它涵蓋哪些流程。
          // 副作用相同的多個控件（篩選、分頁、查詢鈕）其實是同一件事，
          // 但不該靠猜——由作者宣告，可稽核。
          for (const id of parseCovers(md)) byCovers.set(id, md)
        }
        const all = [...result.crosscut, ...result.chains]
        for (const c of all) {
          const direct = byslug.get(slugify(c.entryId))
          const hit = direct ?? byCovers.get(c.entryId)
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
        primaries
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

program
  .command('verify')
  .description('階段四後置：檢查生成的手冊沒有幻覺（引用的 file:line 必須真實且在封包範圍內）')
  .argument('<manual>', '生成的手冊 Markdown')
  .requiredOption('-r, --repo <path>', '目標 repo 路徑')
  .option('-p, --packet <file>', '對應的流程封包，用來檢查引用是否超出提供範圍')
  .action((manual: string, opts: { repo: string; packet?: string }) => {
    const markdown = fs.readFileSync(manual, 'utf8')
    const packet = opts.packet ? fs.readFileSync(opts.packet, 'utf8') : undefined
    const result = verifyManual(markdown, path.resolve(opts.repo), packet)

    console.log(`\n檢查 ${manual}`)
    console.log(`  位置引用 ${result.references} 處 · 問題 ${result.violations.length} 處`)
    for (const v of result.violations) console.log(`  ✗ [${v.kind}] ${v.reference} — ${v.detail}`)
    if (result.violations.length === 0) console.log(`  全部通過`)
    else process.exitCode = 1
  })

await program.parseAsync()
