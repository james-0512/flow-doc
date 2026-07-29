#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { loadConfig } from './config.js'
import { loadWorkspace, scanEntries } from './workspace.js'
import type { EntryScanResult } from './types.js'

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

await program.parseAsync()
