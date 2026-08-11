import fs from 'node:fs'
import path from 'node:path'
import { slugify } from './paths.js'
import { readLines } from './source.js'
import type { AsyncLink, ChainNode, FlowChain, SideEffect, TraceResult } from './types.js'

export interface PackOptions {
  /** 單一封包的原始碼字元上限。超過就從最深處開始捨棄，並在封包裡明說 */
  maxSourceChars: number
}

export const defaultPackOptions: PackOptions = { maxSourceChars: 36_000 }

interface SourceExcerpt {
  key: string
  name: string
  file: string
  startLine: number
  endLine: number
  depth: number
  code: string
}

const SINK_LABEL: Record<SideEffect['kind'], string> = {
  HTTP_API: 'API',
  STORAGE: '儲存',
  ROUTER_NAV: '導頁',
  EMIT: '發事件',
  SIGNALR: 'SignalR',
  BROADCAST: '跨分頁',
  STORE: 'Store',
  OPAQUE: '共用層'
}

/** 讀寫標記只對 API 與 storage 有意義；store action 呼叫或導頁標成「讀取」會誤導。 */
const HAS_RW_SEMANTICS = new Set<SideEffect['kind']>(['HTTP_API', 'STORAGE'])

function effectLine(e: SideEffect): string {
  const parts: string[] = []
  if (HAS_RW_SEMANTICS.has(e.kind)) parts.push(e.mutating ? '**寫入**' : '讀取')
  if (e.guarded) parts.push('try 保護內')
  const meta = parts.length > 0 ? `（${parts.join('，')}）` : ''
  const note = e.note ? ` — ${e.note}` : ''
  return `[${SINK_LABEL[e.kind]}] ${e.detail}${meta}${note}  \`${e.loc.file}:${e.loc.line}\``
}

const STOP_LABEL: Record<string, string> = {
  MAX_DEPTH: '達深度上限，未再往下',
  CYCLE: '遞迴回到上游，未重複展開',
  BUDGET: '達節點預算，未再往下',
  BOUNDARY: '停在邊界',
  UNRESOLVED: '解析不到定義',
  DUPLICATE: '同前，已於本鏈他處展開'
}

/**
 * 縮排大綱。這是 LLM 理解時序的主要依據，故副作用與子呼叫依原始順序交錯呈現。
 *
 * `withSource` 是實際附上原始碼的節點集合——沒附到的必須就地標記，否則 LLM 看到
 * 一個有名字卻沒有程式碼的節點，最可能的行為就是臆測它做了什麼。
 */
function renderOutline(node: ChainNode, depth: number, out: string[], withSource: ReadonlySet<string>): void {
  const pad = '  '.repeat(depth)
  const range = node.endLine && node.endLine !== node.loc.line ? `-${node.endLine}` : ''
  const stop = node.stoppedBy ? `  ⟨${STOP_LABEL[node.stoppedBy] ?? node.stoppedBy}⟩` : ''
  const cand = node.candidates ? `  ⟨${node.candidates.length} 個實作候選，依注入決定⟩` : ''
  const key = `${node.loc.file}:${node.loc.line}`
  const noSrc = !node.stoppedBy && !withSource.has(key) ? '  ⟨**原始碼未附，不要臆測其內容**⟩' : ''
  out.push(`${pad}- **${node.name}**  \`${node.loc.file}:${node.loc.line}${range}\`${stop}${cand}${noSrc}`)

  for (const e of node.effects) out.push(`${pad}  - ${effectLine(e)}`)
  for (const link of node.asyncLinks ?? []) {
    out.push(`${pad}  - ⇣ **跨元件**：\`emit('${link.event}')\` → \`${link.to.file}:${link.to.line}\` 的 \`${link.handlerExpr}\``)
    if (link.chain) renderOutline(link.chain, depth + 2, out, withSource)
    else out.push(`${pad}    - ⟨父層 handler 解析不到，未展開⟩`)
  }
  if (node.omittedListeners) {
    out.push(`${pad}  - ⟨另有 ${node.omittedListeners} 個父層也監聽此事件，超出上限未展開⟩`)
  }
  for (const child of node.children) renderOutline(child, depth + 1, out, withSource)
}

function collectSources(node: ChainNode, depth: number, out: Map<string, SourceExcerpt>): void {
  const key = `${node.loc.file}:${node.loc.line}`
  if (!out.has(key) && node.endLine && !node.stoppedBy) {
    out.set(key, {
      key,
      name: node.name,
      file: node.loc.file,
      startLine: node.loc.line,
      endLine: node.endLine,
      depth,
      code: ''
    })
  }
  for (const child of node.children) collectSources(child, depth + 1, out)
  for (const link of node.asyncLinks ?? []) {
    if (link.chain) collectSources(link.chain, depth + 2, out)
  }
}

function collectLinks(node: ChainNode, out: AsyncLink[]): void {
  for (const link of node.asyncLinks ?? []) {
    out.push(link)
    if (link.chain) collectLinks(link.chain, out)
  }
  for (const child of node.children) collectLinks(child, out)
}

/**
 * 把一條 chain 打包成自足的生成脈絡。
 *
 * 這是 analyzer 與 generator 之間的交付物：generator（LLM）只讀這份 Markdown，
 * 不再回頭查程式碼，因此裡面的每個 `file:line` 都必須是可驗證的真實位置——
 * 這正是 plan.md §3 階段四要求「每步對應 file:line」的防幻覺機制的前半段。
 */
export function packFlow(
  repoRoot: string,
  chain: FlowChain,
  opts: PackOptions = defaultPackOptions,
  /** 共用同一個 handler 的其他觸發點。同一條程式碼路徑只寫一次敘述 */
  siblings: FlowChain[] = [],
  /**
   * 同檔案、副作用組合完全相同，但 handler 不同的其他流程。
   *
   * 刻意**不自動合併**：核准與駁回可能打同一支 API、副作用簽章一模一樣，
   * 自動合併會把兩個相反的動作寫成一件事。改成提示作者自行判斷。
   */
  peers: FlowChain[] = []
): string {
  if (!chain.root) return ''

  const excerpts = new Map<string, SourceExcerpt>()
  collectSources(chain.root, 0, excerpts)

  const links: AsyncLink[] = []
  collectLinks(chain.root, links)

  // 依深度排序，超出預算時從最深處開始捨棄——最深的節點通常是共用工具，
  // 對業務敘事貢獻最小
  const ordered = [...excerpts.values()].sort((a, b) => a.depth - b.depth)
  const kept: SourceExcerpt[] = []
  let budget = opts.maxSourceChars
  let dropped = 0
  for (const ex of ordered) {
    const code = readLines(repoRoot, ex.file, ex.startLine, ex.endLine)
    if (code == null) {
      dropped++
      continue
    }
    if (code.length > budget) {
      dropped++
      continue
    }
    budget -= code.length
    kept.push({ ...ex, code })
  }

  // 大綱要等 kept 算完才能畫，才知道哪些節點沒附到原始碼
  const withSource = new Set(kept.map(k => k.key))
  const outline: string[] = []
  renderOutline(chain.root, 0, outline, withSource)

  const md: string[] = []
  md.push(`# 流程封包：${chain.label}`)
  md.push('')
  md.push(`- 分類：${chain.flowKind === 'write' ? '**寫入型流程**（會改變資料）' : chain.flowKind === 'read' ? '查詢型流程（只讀後端）' : '純 UI 操作（未碰後端）'}`)
  md.push(`- 業務域：\`${chain.domain}\``)
  md.push(`- 觸發點：\`${chain.entryLoc.file}:${chain.entryLoc.line}\``)
  if (siblings.length > 0) {
    md.push(
      `- **另有 ${siblings.length} 個觸發點走同一條程式碼路徑**，敘述只需寫一次，` +
        `但要在「觸發」一節列出全部：`
    )
    for (const s of siblings) {
      md.push(`  - ${s.tag ? `\`${s.tag}\` ` : ''}\`@${s.trigger}\`  \`${s.entryLoc.file}:${s.entryLoc.line}\``)
    }
  }
  if (peers.length > 0) {
    md.push('')
    md.push(
      `> **同檔案內另有 ${peers.length} 個觸發點的副作用組合與本流程完全相同**，` +
        `很可能是同一個業務動作的不同控件（例如篩選條件、分頁、查詢鈕都呼叫同一支查詢）。`
    )
    md.push('>')
    // 位置要明列。語意 ID 不含行號，敘述的「觸發」一節若要列出這些控件，
    // 沒有這幾行就只能自己編——而編出來的行號會被 verify 判為臆測
    for (const p of peers) {
      md.push(`> - \`${p.tag ?? ''}\` \`@${p.trigger}\`  \`${p.entryLoc.file}:${p.entryLoc.line}\``)
    }
    md.push('>')
    md.push('> 判斷是同一件事的話，只寫一份敘述，並在 frontmatter 用 `covers:` 宣告涵蓋範圍：')
    md.push('>')
    md.push('> ```yaml')
    md.push('> ---')
    md.push('> covers:')
    for (const p of peers) md.push(`>   - ${p.entryId}`)
    md.push('> ---')
    md.push('> ```')
    md.push('>')
    md.push('> 若其實是不同動作（例如核准與駁回打同一支 API），就各寫一份，不要用 `covers`。')
  }
  md.push(`- 節點數 ${chain.nodeCount} · 最大深度 ${chain.maxDepth}`)
  if (chain.unresolvedCalls > 0) {
    md.push(`- 鏈中有 ${chain.unresolvedCalls} 個呼叫解析不到定義（多為內建方法），**未包含在下方原始碼中**`)
  }
  md.push('')

  md.push('## 呼叫鏈（依執行順序）')
  md.push('')
  md.push(...outline)
  md.push('')

  md.push('## 副作用彙總')
  md.push('')
  if (chain.effects.length === 0) md.push('（無）')
  for (const e of chain.effects) md.push(`- ${effectLine(e)}`)
  md.push('')

  if (links.length > 0) {
    md.push('## 跨元件連結')
    md.push('')
    for (const l of links) {
      md.push(
        `- \`emit('${l.event}')\` @ \`${l.from.file}:${l.from.line}\` → \`${l.to.file}:${l.to.line}\` 的 \`${l.handlerExpr}\``
      )
    }
    md.push('')
  }

  md.push('## 原始碼')
  md.push('')
  for (const ex of kept) {
    // file:line 一律包反引號，verify 才能一致地解析出範圍
    md.push(`### \`${ex.name}\` — \`${ex.file}:${ex.startLine}-${ex.endLine}\``)
    md.push('')
    md.push('```ts')
    md.push(ex.code)
    md.push('```')
    md.push('')
  }
  if (dropped > 0) {
    md.push(`> **已省略 ${dropped} 個節點的原始碼**（超出 ${opts.maxSourceChars} 字元預算，或檔案讀不到）。`)
    md.push('> 撰寫手冊時不要臆測這些節點的內容，直接標註「未展開」。')
    md.push('')
  }

  return md.join('\n')
}

const domainSlug = slugify

/**
 * 產生手冊目錄。
 *
 * 拆成一份總索引 + 每個業務域一份清單：902 條流程擠在單一檔案會到 20 萬字元，
 * 光為了查某一域的清單就得整份讀進來。這個切分同時就是靜態站的導覽結構。
 *
 * 總索引末尾附上 LIMITATIONS.md——讀者必須看得到「這份文件沒說什麼」，
 * 否則靜態分析的缺口會被誤讀成「系統沒有這些行為」。
 */
export function packOverviews(result: TraceResult, limitations?: string): Map<string, string> {
  const flows = result.chains.filter(c => c.isFlow)
  const byDomain = new Map<string, FlowChain[]>()
  for (const c of flows) {
    const bucket = byDomain.get(c.domain)
    if (bucket) bucket.push(c)
    else byDomain.set(c.domain, [c])
  }
  const domains = [...byDomain].sort((a, b) => b[1].length - a[1].length)
  const out = new Map<string, string>()

  const writes = flows.filter(c => c.flowKind === 'write').length
  const index: string[] = [
    '# 系統流程總覽',
    '',
    `共 ${flows.length} 條業務流程（寫入型 ${writes} · 查詢型 ${flows.length - writes}），分布於 ${domains.length} 個業務域。`,
    '完全沒有後端互動的純 UI 操作不列入。',
    ''
  ]

  if (result.crosscut.length > 0) {
    index.push('## 全域前置（每條流程都會經過）')
    index.push('')
    for (const c of result.crosscut) index.push(`- **${c.label}** \`${c.entryLoc.file}:${c.entryLoc.line}\``)
    index.push('')
    index.push('各流程的敘述不重複展開這一段，需要時連結至本章。')
    index.push('')
  }

  index.push('## 業務域')
  index.push('')
  for (const [domain, list] of domains) {
    const w = list.filter(c => c.flowKind === 'write').length
    index.push(`- [${domain}](overview-${domainSlug(domain)}.md)　寫入 ${w} · 查詢 ${list.length - w}`)
  }
  index.push('')

  if (limitations) {
    index.push('---')
    index.push('')
    index.push(limitations)
  }
  out.set('00-overview.md', index.join('\n'))

  for (const [domain, list] of domains) {
    const w = list.filter(c => c.flowKind === 'write')
    const r = list.filter(c => c.flowKind === 'read')
    const md: string[] = [`# ${domain}`, '', `寫入型 ${w.length} 條 · 查詢型 ${r.length} 條`, '']
    for (const [title, group] of [['寫入型流程', w], ['查詢型流程', r]] as const) {
      if (group.length === 0) continue
      md.push(`## ${title}`)
      md.push('')
      for (const c of group) {
        const apis = c.effects.filter(e => e.kind === 'HTTP_API').map(e => e.detail)
        md.push(`- **${c.label}** \`${c.entryLoc.file}:${c.entryLoc.line}\``)
        if (apis.length > 0) md.push(`  - API：${apis.map(a => `\`${a}\``).join('、')}`)
      }
      md.push('')
    }
    out.set(`overview-${domainSlug(domain)}.md`, md.join('\n'))
  }

  return out
}

/**
 * 依「根函式位置」分組。
 *
 * 搜尋框、下拉、日期選擇器往往綁在同一個查詢 handler 上——那是**一條**業務流程的
 * 三個觸發鈕，不是三條流程。實測 902 條流程只有 665 條相異程式碼路徑；不分組會
 * 產出 237 節幾乎一樣的敘述，既浪費也讓手冊變難讀。
 *
 * @returns 代表流程 → 其餘共用同一 handler 的流程
 */
export function groupByHandler(chains: FlowChain[]): Map<FlowChain, FlowChain[]> {
  const buckets = new Map<string, FlowChain[]>()
  for (const c of chains) {
    if (!c.root) continue
    // 推播不與使用者觸發併章，即使 handler 是同一個。「使用者按刷新」與
    // 「後端推播 Refresh」走同一條程式碼路徑，但業務事實不同——併進去的話，
    // 「不需使用者動作也會更新」這件事在手冊裡就查不到了
    const scope = c.entryKind === 'SYSTEM_PUSH' ? 'push:' : ''
    const key = `${scope}${c.root.loc.file}:${c.root.loc.line}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(c)
    else buckets.set(key, [c])
  }

  const out = new Map<FlowChain, FlowChain[]>()
  for (const group of buckets.values()) {
    // 代表的挑選順序：副作用最多（鏈最完整）→ 主要觸發動作（按鈕點擊而非按 Enter）
    // → entryId 字典序。最後一項是為了穩定：同樣的輸入必須產生同樣的封包檔名，
    // 否則重跑一次就會讓已寫好的手冊對不上。
    const sorted = [...group].sort(
      (a, b) =>
        b.effects.length - a.effects.length ||
        triggerRank(a.trigger) - triggerRank(b.trigger) ||
        a.entryId.localeCompare(b.entryId)
    )
    out.set(sorted[0]!, sorted.slice(1))
  }
  return out
}

/** 副作用組合的指紋，用來找出「很可能是同一件事」的流程。 */
export function effectSignature(chain: FlowChain): string {
  return chain.effects
    .map(e => `${e.kind}:${e.detail}`)
    .sort()
    .join('|')
}

/**
 * 找出同檔案、副作用組合完全相同的其他代表流程。
 * 只提示、不合併——理由見 packFlow 的 peers 參數說明。
 */
export function findPeers(representatives: FlowChain[]): Map<FlowChain, FlowChain[]> {
  const buckets = new Map<string, FlowChain[]>()
  for (const c of representatives) {
    const sig = effectSignature(c)
    if (!sig) continue
    const key = `${c.entryLoc.file}|${sig}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(c)
    else buckets.set(key, [c])
  }
  const out = new Map<FlowChain, FlowChain[]>()
  for (const group of buckets.values()) {
    if (group.length < 2) continue
    for (const c of group) out.set(c, group.filter(o => o !== c))
  }
  return out
}

/** 主要動作優先。同一個 handler 掛在按鈕與 Enter 鍵上時，按鈕才是那條流程的代表。 */
const PRIMARY_TRIGGERS = ['click', 'ok', 'submit', 'confirm']
function triggerRank(trigger: string): number {
  const i = PRIMARY_TRIGGERS.indexOf(trigger)
  return i === -1 ? PRIMARY_TRIGGERS.length : i
}

/**
 * 封包檔名。與 `site` 查找手冊用的 slug 完全相同——寫好的敘述直接同名放進
 * `manuals/` 就會被接上，不必再做一次名稱換算。
 */
export function packFileName(chain: FlowChain): string {
  return `${slugify(chain.entryId)}.md`
}

export interface PackRunOptions {
  outDir: string
  domain?: string
  flow?: string
  /** 連非流程（純查詢／UI 操作）也打包 */
  all?: boolean
  maxSourceChars?: number
  /** 已知限制清單，附在總覽末尾 */
  limitationsFile?: string
  /** 每個觸發點各出一份封包，不依 handler 合併 */
  perTrigger?: boolean
}

export interface PackRunSummary {
  packets: number
  removedOld: number
  totalChars: number
  mergedTriggers: number
  chainsCovered: number
  crosscut: number
  overviews: number
  limitationsFound: boolean
}

/**
 * 把整份分析結果寫成封包目錄。`pack` 指令與閉環的 `loop` 共用這一份——
 * 兩邊各寫一次輸出邏輯的話，「先清舊檔」這類防孤兒規則遲早只剩一邊有。
 */
export function writePackets(result: TraceResult, options: PackRunOptions): PackRunSummary {
  let chains = result.chains.filter(c => c.root != null)
  if (!options.all) chains = chains.filter(c => c.isFlow)
  if (options.domain) chains = chains.filter(c => c.domain === options.domain)
  if (options.flow) chains = chains.filter(c => c.entryId.includes(options.flow!))

  fs.mkdirSync(options.outDir, { recursive: true })
  // 先清掉舊封包。不清的話流程消失或改名後會留下孤兒檔案，
  // 閉環的 diff 與 PR 審查都會被這些永遠不再更新的殘骸混淆
  let removedOld = 0
  for (const f of fs.readdirSync(options.outDir)) {
    if (!f.endsWith('.md')) continue
    fs.rmSync(path.join(options.outDir, f))
    removedOld++
  }

  const packOpts = { maxSourceChars: options.maxSourceChars ?? defaultPackOptions.maxSourceChars }
  let totalChars = 0
  let mergedTriggers = 0
  // 同一個 handler 只出一份封包，其餘觸發點列在封包內
  const groups = options.perTrigger ? new Map(chains.map(c => [c, [] as FlowChain[]])) : groupByHandler(chains)
  for (const chain of result.crosscut) {
    const md = packFlow(result.repoRoot, chain, packOpts)
    if (md) {
      fs.writeFileSync(path.join(options.outDir, packFileName(chain)), md, 'utf8')
      totalChars += md.length
    }
  }
  const peers = findPeers([...groups.keys()])
  for (const [chain, siblings] of groups) {
    const md = packFlow(result.repoRoot, chain, packOpts, siblings, peers.get(chain) ?? [])
    if (!md) continue
    fs.writeFileSync(path.join(options.outDir, packFileName(chain)), md, 'utf8')
    totalChars += md.length
    mergedTriggers += siblings.length
  }

  // 限制清單要跟著目錄走，讀手冊的人才知道「哪些東西手冊不會說」
  const limitations =
    options.limitationsFile && fs.existsSync(options.limitationsFile)
      ? fs.readFileSync(options.limitationsFile, 'utf8')
      : undefined
  const overviews = packOverviews(result, limitations)
  for (const [name, md] of overviews) fs.writeFileSync(path.join(options.outDir, name), md, 'utf8')

  return {
    packets: groups.size + result.crosscut.length,
    removedOld,
    totalChars,
    mergedTriggers,
    chainsCovered: chains.length,
    crosscut: result.crosscut.length,
    overviews: overviews.size,
    limitationsFound: limitations !== undefined
  }
}
