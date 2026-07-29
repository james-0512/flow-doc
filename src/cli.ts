#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { loadConfig } from './config.js'
import { loadWorkspace, scanEntries } from './workspace.js'
import { defaultTraceOptions, traceEntries } from './analyze/trace.js'
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
  console.log(`\n穿越寫入邊界的流程 ${flows.length} 條（其餘 ${chains.length - flows.length} 條為純查詢／UI 操作）`)

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
  const unresolvedTotal = chains.reduce((s, c) => s + c.unresolvedCalls, 0)
  console.log(`\n已知缺口：鏈中解析不到定義的呼叫 ${unresolvedTotal} 次，最常見的：`)
  for (const { name, count } of stats.unresolvedTop.slice(0, 12)) console.log(`  ${String(count).padStart(5)}  ${name}`)
  if (stats.unresolvedHandlerTop.length > 0) {
    console.log(`\n無法起鏈的 handler：`)
    for (const { name, count } of stats.unresolvedHandlerTop.slice(0, 10)) console.log(`  ${String(count).padStart(5)}  ${name}`)
  }
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

await program.parseAsync()
