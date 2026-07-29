import fs from 'node:fs'
import path from 'node:path'
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

function readLines(repoRoot: string, file: string, start: number, end: number): string | null {
  const abs = path.join(repoRoot, file)
  if (!fs.existsSync(abs)) return null
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  return lines.slice(start - 1, end).join('\n')
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

/** 縮排大綱。這是 LLM 理解時序的主要依據，故副作用與子呼叫依原始順序交錯呈現。 */
function renderOutline(node: ChainNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth)
  const range = node.endLine && node.endLine !== node.loc.line ? `-${node.endLine}` : ''
  const stop = node.stoppedBy ? `  ⟨停止：${node.stoppedBy}⟩` : ''
  const cand = node.candidates ? `  ⟨${node.candidates.length} 個實作候選，依注入決定⟩` : ''
  out.push(`${pad}- **${node.name}**  \`${node.loc.file}:${node.loc.line}${range}\`${stop}${cand}`)

  for (const e of node.effects) out.push(`${pad}  - ${effectLine(e)}`)
  for (const link of node.asyncLinks ?? []) {
    out.push(`${pad}  - ⇣ **跨元件**：\`emit('${link.event}')\` → \`${link.to.file}:${link.to.line}\` 的 \`${link.handlerExpr}\``)
    if (link.chain) renderOutline(link.chain, depth + 2, out)
    else out.push(`${pad}    - ⟨父層 handler 解析不到，未展開⟩`)
  }
  for (const child of node.children) renderOutline(child, depth + 1, out)
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
export function packFlow(repoRoot: string, chain: FlowChain, opts: PackOptions = defaultPackOptions): string {
  if (!chain.root) return ''

  const outline: string[] = []
  renderOutline(chain.root, 0, outline)

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

  const md: string[] = []
  md.push(`# 流程封包：${chain.label}`)
  md.push('')
  md.push(`- 業務域：\`${chain.domain}\``)
  md.push(`- 觸發點：\`${chain.entryLoc.file}:${chain.entryLoc.line}\``)
  md.push(`- 節點數 ${chain.nodeCount} · 最大深度 ${chain.maxDepth} · 是否穿越寫入邊界：${chain.isFlow ? '是' : '否'}`)
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
    md.push(`### \`${ex.name}\` — ${ex.file}:${ex.startLine}-${ex.endLine}`)
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

/**
 * 產生跨流程的總覽，作為手冊目錄。
 *
 * 會把 repo 根的 LIMITATIONS.md 原樣附在後面——手冊的讀者必須看得到
 * 「這份文件沒說什麼」，否則靜態分析的缺口會被誤讀成「系統沒有這些行為」。
 */
export function packOverview(result: TraceResult, limitations?: string): string {
  const flows = result.chains.filter(c => c.isFlow)
  const byDomain = new Map<string, FlowChain[]>()
  for (const c of flows) {
    const bucket = byDomain.get(c.domain)
    if (bucket) bucket.push(c)
    else byDomain.set(c.domain, [c])
  }

  const md: string[] = ['# 系統流程總覽', '', `共 ${flows.length} 條穿越寫入邊界的業務流程，分布於 ${byDomain.size} 個業務域。`, '']
  for (const [domain, list] of [...byDomain].sort((a, b) => b[1].length - a[1].length)) {
    md.push(`## ${domain}（${list.length} 條）`)
    md.push('')
    for (const c of list) {
      const apis = c.effects.filter(e => e.kind === 'HTTP_API' && e.mutating).map(e => e.detail)
      md.push(`- **${c.label}** \`${c.entryLoc.file}:${c.entryLoc.line}\``)
      if (apis.length > 0) md.push(`  - 寫入 API：${apis.map(a => `\`${a}\``).join('、')}`)
    }
    md.push('')
  }

  if (limitations) {
    md.push('---')
    md.push('')
    md.push(limitations)
  }
  return md.join('\n')
}

/** 檔名安全化，供 --out-dir 批次輸出。 */
export function packFileName(chain: FlowChain): string {
  return `${chain.domain}__${chain.entryId}`.replace(/[^\w.\-]+/g, '_').slice(0, 120) + '.md'
}
