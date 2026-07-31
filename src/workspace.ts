import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'tinyglobby'
import type { AnalyzerConfig } from './config.js'
import { disambiguate, domainOf, scanSfc, type DetectContext } from './entry/detect.js'
import { extractRoutes } from './entry/routes.js'
import { parseGlobalComponents } from './load/registry.js'
import { resolveSpecifier, resolveToFile } from './load/resolve.js'
import { parseSfc, type ParsedSfc } from './load/sfc.js'
import { extractScriptFacts, type ScriptFacts } from './load/script.js'
import type { EntryCandidate, EntryScanResult, ListenerEdge } from './types.js'

export interface Workspace {
  config: AnalyzerConfig
  /** repo 內所有納入分析的檔案（相對路徑） */
  files: Set<string>
  sfcs: Map<string, ParsedSfc>
  /** 每個檔案的語法事實。SFC 用虛擬 TS，`.ts` 檔用原始內容 */
  facts: Map<string, ScriptFacts>
  globalComponents: Map<string, string>
  tsFiles: string[]
}

export async function loadWorkspace(config: AnalyzerConfig): Promise<Workspace> {
  const found = await glob([`${config.srcDir}/**/*.{ts,vue}`], {
    cwd: config.repoRoot,
    ignore: config.exclude,
    dot: false
  })
  // 排序是必要的，不是整潔癖：glob 不保證回傳順序，而檔案順序會一路影響
  // entry 的序數消歧、listener 的展開順序、以及超過上限時哪些被截斷。
  // 不排序的話，同一個 commit 連跑兩次會產出不同的 JSON，閉環每晚都會看到假變更。
  const files = new Set(found.map(f => f.split(path.sep).join('/')).sort())

  const sfcs = new Map<string, ParsedSfc>()
  const facts = new Map<string, ScriptFacts>()
  const tsFiles: string[] = []

  for (const rel of files) {
    const abs = path.join(config.repoRoot, rel)
    const source = fs.readFileSync(abs, 'utf8')
    if (rel.endsWith('.vue')) {
      const sfc = parseSfc(rel, source)
      sfcs.set(rel, sfc)
      if (sfc.virtualTs) facts.set(rel, extractScriptFacts(`${rel}.ts`, sfc.virtualTs))
    } else {
      tsFiles.push(rel)
      facts.set(rel, extractScriptFacts(rel, source))
    }
  }

  const globalComponents = new Map<string, string>()
  if (config.globalComponentsDts) {
    const abs = path.join(config.repoRoot, config.globalComponentsDts)
    if (fs.existsSync(abs)) {
      for (const [name, target] of parseGlobalComponents(fs.readFileSync(abs, 'utf8'), config.globalComponentsDts)) {
        globalComponents.set(name, target)
        files.add(target)
      }
    } else {
      // 這個檔案通常由 unplugin-vue-components 產生且不進版控，所以乾淨 checkout
      // （CI／容器／git worktree）不會有它。少了它，全域註冊的元件標籤全部解析不到檔案，
      // entry 判定與 emit 接合會大量改變——**而且完全無聲**。
      // 對閉環尤其致命：baseline 若在有它的環境產生，第一輪 diff 會滿江紅。
      console.warn(
        `\n⚠ 找不到全域元件宣告檔 ${config.globalComponentsDts}\n` +
          `  它通常是 generated 且不進版控。少了它，全域註冊元件的標籤會解析不到檔案，\n` +
          `  分析結果與「有它的環境」不可比。請先在目標 repo 跑一次產生它的指令\n` +
          `  （多為 dev/build 的前置），或把 globalComponentsDts 設為 null 明示本專案沒有。\n`
      )
    }
  }

  return { config, files, sfcs, facts, globalComponents, tsFiles }
}

const EMPTY_FACTS: ScriptFacts = {
  componentImports: new Map(),
  declaredNames: new Set(),
  lifecycle: []
}

export function scanEntries(ws: Workspace): EntryScanResult {
  const started = Date.now()
  const ctx: DetectContext = {
    config: ws.config,
    globalComponents: ws.globalComponents,
    files: ws.files
  }

  const entries: EntryCandidate[] = []
  const listeners: ListenerEdge[] = []
  let dynamicEventBindings = 0
  let unresolvedComponentTags = 0
  let sfcWithScript = 0

  for (const [rel, sfc] of ws.sfcs) {
    if (sfc.virtualTs) sfcWithScript++
    const scan = scanSfc(ctx, sfc, ws.facts.get(rel) ?? EMPTY_FACTS)
    entries.push(...scan.entries)
    listeners.push(...scan.listeners)
    dynamicEventBindings += scan.dynamicEventBindings
    unresolvedComponentTags += scan.unresolvedComponentTags
  }

  const routeFiles = ws.tsFiles.filter(f => f.startsWith(`${ws.config.routerDir}/`))
  for (const rel of routeFiles) {
    const source = fs.readFileSync(path.join(ws.config.repoRoot, rel), 'utf8')
    const routeEntries: EntryCandidate[] = []
    for (const route of extractRoutes(rel, source)) {
      const target = route.componentSpec ? resolveSpecifier(ws.config.aliases, rel, route.componentSpec) : null
      const component = target ? (resolveToFile(ws.files, target) ?? undefined) : undefined
      routeEntries.push({
        // 路由的語意身份就是它的 path，行號無關
        id: `${rel}#route:${route.path}`,
        legacyId: `${rel}:${route.line}:${route.path}`,
        kind: 'ROUTE',
        domain: component ? domainOf(component) : 'router',
        label: `route ${route.path}${route.name ? ` (${route.name})` : ''}`,
        loc: { file: rel, line: route.line },
        trigger: route.path,
        file: rel,
        routeComponent: component,
        routeName: route.name
      })
    }
    // 同檔內重複的 route path（巢狀重定義）以序數區分
    disambiguate(routeEntries)
    entries.push(...routeEntries)
  }

  return {
    repoRoot: ws.config.repoRoot,
    generatedAt: new Date().toISOString(),
    entries,
    listeners,
    stats: {
      sfcFiles: ws.sfcs.size,
      sfcWithScript,
      tsFiles: ws.tsFiles.length,
      routeFiles: routeFiles.length,
      globalComponents: ws.globalComponents.size,
      dynamicEventBindings,
      unresolvedComponentTags,
      elapsedMs: Date.now() - started
    }
  }
}
