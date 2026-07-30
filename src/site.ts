import path from 'node:path'
import { slugify } from './paths.js'
import type { AsyncLink, ChainNode, FlowChain, SideEffect, TraceResult } from './types.js'

export interface SiteOptions {
  title: string
  /** 原始碼連結前綴，例如 `https://github.com/org/repo/blob/main/`。空字串則不產生連結 */
  sourceBaseUrl: string
}

export const defaultSiteOptions: SiteOptions = { title: '業務流程手冊', sourceBaseUrl: '' }

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

const STOP_LABEL: Record<string, string> = {
  MAX_DEPTH: '達深度上限',
  CYCLE: '遞迴回到上游',
  BUDGET: '達節點預算',
  BOUNDARY: '停在邊界',
  UNRESOLVED: '解析不到定義',
  DUPLICATE: '同前，已於本鏈他處展開'
}

export { slugify } from './paths.js'

/**
 * 頁面標題用業務語言的近似值：觸發方式 + 檔名，而非完整路徑。
 *
 * 刻意不用 `<UtilButton>` 這種尖括號記法——VitePress 會把 markdown 當 Vue
 * template 編譯，裸露的 `<` 會被當成未閉合的 HTML 標籤而讓整個 build 失敗。
 */
export function flowTitle(chain: FlowChain, manual?: string): string {
  // 有人寫的敘述時，用它的標題——「使用者以帳號密碼登入」遠比
  // 「IndexView.vue · UtilButton @click」適合當手冊的目錄項目
  const heading = manual ? /^#{1,3}\s+(?:流程[：:]\s*)?(.+)$/m.exec(manual) : null
  if (heading) return heading[1]!.trim()

  if (chain.entryKind === 'CROSSCUT') return chain.label
  const base = path.posix.basename(chain.entryLoc.file)
  if (chain.entryKind === 'LIFECYCLE') return `${base} 載入時（${chain.trigger}）`
  return chain.tag ? `${base} · ${chain.tag} @${chain.trigger}` : `${base} · @${chain.trigger}`
}

function flowPath(chain: FlowChain): string {
  return `flows/${slugify(chain.domain)}/${slugify(chain.entryId)}.md`
}

function srcLink(opts: SiteOptions, loc: { file: string; line: number }, endLine?: number): string {
  const text = `${loc.file}:${loc.line}${endLine && endLine !== loc.line ? `-${endLine}` : ''}`
  if (!opts.sourceBaseUrl) return `\`${text}\``
  return `[\`${text}\`](${opts.sourceBaseUrl}${loc.file}#L${loc.line})`
}

function effectLine(opts: SiteOptions, e: SideEffect): string {
  const rw = e.kind === 'HTTP_API' || e.kind === 'STORAGE' ? (e.mutating ? ' **寫入**' : ' 讀取') : ''
  const guard = e.guarded ? '，try 保護內' : ''
  const meta = rw || guard ? `（${rw.trim()}${guard}）` : ''
  const note = e.note ? ` — ${e.note}` : ''
  // detail 一律包行內程式碼：它可能含 `<`，裸露的話會被 Vue template 編譯器吃掉
  return `\`${SINK_LABEL[e.kind]}\` \`${e.detail}\`${meta}${note} ${srcLink(opts, e.loc)}`
}

function renderChain(opts: SiteOptions, node: ChainNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth)
  const stop = node.stoppedBy ? `　_${STOP_LABEL[node.stoppedBy] ?? node.stoppedBy}_` : ''
  const cand = node.candidates ? `　_${node.candidates.length} 個實作候選，依注入決定_` : ''
  out.push(`${pad}- **${node.name}** ${srcLink(opts, node.loc, node.endLine)}${stop}${cand}`)
  for (const e of node.effects) out.push(`${pad}  - ${effectLine(opts, e)}`)
  for (const link of node.asyncLinks ?? []) {
    out.push(`${pad}  - ⇣ 跨元件 \`${link.event}\` → ${srcLink(opts, link.to)} 的 \`${link.handlerExpr}\``)
    if (link.chain) renderChain(opts, link.chain, depth + 2, out)
  }
  if (node.omittedListeners) {
    out.push(`${pad}  - _另有 ${node.omittedListeners} 個父層監聽此事件，超出上限未展開_`)
  }
  for (const child of node.children) renderChain(opts, child, depth + 1, out)
}

function collectLinks(node: ChainNode, out: AsyncLink[]): void {
  for (const link of node.asyncLinks ?? []) {
    out.push(link)
    if (link.chain) collectLinks(link.chain, out)
  }
  for (const child of node.children) collectLinks(child, out)
}

/**
 * 單一流程頁。
 *
 * 分成兩塊、且刻意標示得很清楚：**分析結果**是靜態分析得出、可對回原始碼；
 * **流程敘述**是人／LLM 寫的。讀者必須分得出哪些內容有程式碼背書。
 */
function renderFlowPage(opts: SiteOptions, chain: FlowChain, manual?: string): string {
  const md: string[] = []
  const kindLabel =
    chain.entryKind === 'CROSSCUT'
      ? '全域前置'
      : chain.flowKind === 'write'
        ? '寫入型流程'
        : chain.flowKind === 'read'
          ? '查詢型流程'
          : '純 UI 操作'

  const title = flowTitle(chain, manual)
  md.push('---')
  md.push(`title: ${JSON.stringify(title)}`)
  md.push('---')
  md.push('')
  md.push(`# ${title}`)
  md.push('')
  md.push(`<Badge type="${chain.flowKind === 'write' ? 'danger' : 'tip'}" text="${kindLabel}" />`)
  md.push('')
  md.push(`**觸發點**　${srcLink(opts, chain.entryLoc)}`)
  md.push('')

  if (manual) {
    md.push('## 流程敘述')
    md.push('')
    // 敘述本身的標題已升格成頁面 H1，這裡去掉避免重複
    md.push(manual.trim().replace(/^#{1,3}\s+.+\n+/, ''))
    md.push('')
  } else {
    md.push('::: warning 尚未撰寫流程敘述')
    md.push('以下為靜態分析結果。人可讀的步驟說明、序列圖與異常補償尚未生成。')
    md.push(':::')
    md.push('')
  }

  const apis = chain.effects.filter(e => e.kind === 'HTTP_API')
  if (apis.length > 0) {
    md.push('## 後端互動')
    md.push('')
    md.push('| 端點 | 讀寫 | 說明 | 位置 |')
    md.push('|---|---|---|---|')
    for (const e of apis) {
      md.push(`| \`${e.detail}\` | ${e.mutating ? '**寫入**' : '讀取'} | ${e.note ?? ''} | ${srcLink(opts, e.loc)} |`)
    }
    md.push('')
  }

  const others = chain.effects.filter(e => e.kind !== 'HTTP_API')
  if (others.length > 0) {
    md.push('## 其他副作用')
    md.push('')
    for (const e of others) md.push(`- ${effectLine(opts, e)}`)
    md.push('')
  }

  const links: AsyncLink[] = []
  if (chain.root) collectLinks(chain.root, links)
  if (links.length > 0) {
    md.push('## 跨元件連結')
    md.push('')
    for (const l of links) {
      md.push(`- \`emit('${l.event}')\` ${srcLink(opts, l.from)} → \`${l.handlerExpr}\` ${srcLink(opts, l.to)}`)
    }
    md.push('')
  }

  md.push('## 呼叫鏈')
  md.push('')
  md.push(`::: details 展開（${chain.nodeCount} 個節點，最大深度 ${chain.maxDepth}）`)
  const chainOut: string[] = []
  if (chain.root) renderChain(opts, chain.root, 0, chainOut)
  md.push(...chainOut)
  md.push(':::')
  md.push('')

  if (chain.unresolvedCalls > 0) {
    md.push(`> 鏈中有 ${chain.unresolvedCalls} 個呼叫解析不到定義（多為語言內建方法），未列入上方。`)
    md.push('')
  }
  return md.join('\n')
}

export interface SitePage {
  file: string
  content: string
}

/**
 * 產生 VitePress 站台。
 *
 * 站台由 `flow-chains.json` 驅動而非由手冊驅動——分析結果本身即可瀏覽且每一項
 * 都能對回原始碼；人寫的敘述有幾條就顯示幾條，逐步補齊。這樣站台不必等 902 條
 * 手冊全部生成才有價值。
 */
/**
 * 把共用同一份敘述的流程收成一筆索引項目。
 *
 * 一份用 `covers:` 涵蓋 9 個控件的敘述，在頁面層級是對的（每個控件都看得到敘述），
 * 但索引若逐條列出，會變成連續 9 個一模一樣的標題。索引要的是「一個業務動作一筆」。
 *
 * @param primaries 檔名直接對應的流程，優先當代表；其餘是被 `covers:` 帶進來的
 */
function collapseByManual(
  flows: FlowChain[],
  manuals: ReadonlyMap<string, string>,
  primaries: ReadonlySet<string>
): { chain: FlowChain; triggerCount: number }[] {
  const groups = new Map<string, FlowChain[]>()
  const order: string[] = []
  for (const c of flows) {
    const manual = manuals.get(c.entryId)
    // 沒有敘述的流程各自成組，不能靠標題合併——它們的標題本來就不同
    const key = manual ? `manual:${manual.length}:${manual.slice(0, 200)}` : `flow:${c.entryId}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(c)
    else {
      groups.set(key, [c])
      order.push(key)
    }
  }
  return order.map(key => {
    const group = groups.get(key)!
    const chain = group.find(c => primaries.has(c.entryId)) ?? group[0]!
    return { chain, triggerCount: group.length }
  })
}

export function buildSite(
  result: TraceResult,
  manuals: ReadonlyMap<string, string>,
  limitations: string | undefined,
  opts: SiteOptions = defaultSiteOptions,
  /** 檔名直接對應的流程（其餘是被 `covers:` 帶進來的） */
  manualPrimaries: ReadonlySet<string> = new Set(),
  /** 全域前置總覽（`crosscut-overview.md`）——跨封包的綜合敘述，注入全域前置 index 頁 */
  crosscutOverview?: string
): SitePage[] {
  const pages: SitePage[] = []
  const flows = result.chains.filter(c => c.isFlow)
  const byDomain = new Map<string, FlowChain[]>()
  for (const c of flows) {
    const bucket = byDomain.get(c.domain)
    if (bucket) bucket.push(c)
    else byDomain.set(c.domain, [c])
  }
  const domains = [...byDomain].sort((a, b) => b[1].length - a[1].length)

  for (const chain of [...result.crosscut, ...flows]) {
    pages.push({ file: flowPath(chain), content: renderFlowPage(opts, chain, manuals.get(chain.entryId)) })
  }

  // 業務域索引
  for (const [domain, list] of domains) {
    const w = list.filter(c => c.flowKind === 'write')
    const r = list.filter(c => c.flowKind === 'read')
    const md: string[] = [`# ${domain}`, '', `寫入型 ${w.length} 條 · 查詢型 ${r.length} 條`, '']
    for (const [title, group] of [['寫入型流程', w], ['查詢型流程', r]] as const) {
      if (group.length === 0) continue
      md.push(`## ${title}`, '')
      for (const { chain: c, triggerCount } of collapseByManual(group, manuals, manualPrimaries)) {
        const apis = c.effects.filter(e => e.kind === 'HTTP_API').map(e => `\`${e.detail}\``)
        const triggers = triggerCount > 1 ? `　<small>${triggerCount} 個觸發點</small>` : ''
        md.push(`- [${flowTitle(c, manuals.get(c.entryId))}](./${slugify(c.entryId)}.md)${triggers}`)
        if (apis.length > 0) md.push(`  <br><small>${apis.join('、')}</small>`)
      }
      md.push('')
    }
    pages.push({ file: `flows/${slugify(domain)}/index.md`, content: md.join('\n') })
  }

  // 全域前置索引
  if (result.crosscut.length > 0) {
    const md = ['# 全域前置', '', '每一條業務流程都會經過以下處理。各流程頁面不重複展開這一段。', '']
    if (crosscutOverview) {
      // 總覽與單頁的「流程敘述」同屬人／LLM 寫的信任層級；檔內若有 H1 去掉，頁面已有 H1
      md.push(crosscutOverview.trim().replace(/^#\s+.+\n+/, ''), '', '## 各流程', '')
    }
    for (const c of result.crosscut) {
      // 有敘述時用敘述的標題，並保留原始 label 當副標——讀者要能對回程式碼裡的名字
      const manual = manuals.get(c.entryId)
      const title = flowTitle(c, manual)
      md.push(`- [${title}](./${slugify(c.entryId)}.md)${title === c.label ? '' : `　<small>${c.label}</small>`}`)
    }
    pages.push({ file: 'flows/全域前置/index.md', content: md.join('\n') })
  }

  // API 反查：這是封包給不了的視角——一支端點被哪些流程用到
  const byApi = new Map<string, { effect: SideEffect; flows: FlowChain[] }>()
  for (const chain of [...result.crosscut, ...flows]) {
    for (const e of chain.effects) {
      if (e.kind !== 'HTTP_API') continue
      const hit = byApi.get(e.detail)
      if (hit) {
        if (!hit.flows.includes(chain)) hit.flows.push(chain)
      } else {
        byApi.set(e.detail, { effect: e, flows: [chain] })
      }
    }
  }
  const apiMd: string[] = [
    '# API 對照表',
    '',
    `共 ${byApi.size} 支端點。這是流程頁面給不了的視角：**一支 API 被哪些流程用到**——`,
    '改動某個端點前，這裡就是影響範圍。',
    ''
  ]
  for (const [detail, { effect, flows: users }] of [...byApi].sort((a, b) => b[1].flows.length - a[1].flows.length)) {
    apiMd.push(`## \`${detail}\`${effect.mutating ? ' **寫入**' : ''}`)
    apiMd.push('')
    if (effect.note) apiMd.push(`> ${effect.note}`, '')
    apiMd.push(`${users.length} 條流程使用：`, '')
    for (const c of users) {
      apiMd.push(
        `- [${flowTitle(c, manuals.get(c.entryId))}](/flows/${slugify(c.domain)}/${slugify(c.entryId)})　_${c.domain}_`
      )
    }
    apiMd.push('')
  }
  pages.push({ file: 'api.md', content: apiMd.join('\n') })

  // 首頁
  const writes = flows.filter(c => c.flowKind === 'write').length
  const withManual = flows.filter(c => manuals.has(c.entryId)).length
  const home: string[] = [
    '---',
    'layout: home',
    'hero:',
    `  name: ${JSON.stringify(opts.title)}`,
    '  tagline: 由程式碼靜態分析產生，每一步都能對回原始碼',
    '  actions:',
    '    - theme: brand',
    '      text: 瀏覽業務域',
    '      link: /domains',
    '    - theme: alt',
    '      text: API 對照表',
    '      link: /api',
    '    - theme: alt',
    '      text: 已知限制',
    '      link: /limitations',
    'features:',
    `  - title: ${flows.length} 條業務流程`,
    `    details: 寫入型 ${writes} 條、查詢型 ${flows.length - writes} 條，分布於 ${domains.length} 個業務域。`,
    `  - title: ${byApi.size} 支後端端點`,
    '    details: 可反查每支 API 被哪些流程使用，改動前先看影響範圍。',
    `  - title: ${withManual} 條已撰寫敘述`,
    `    details: 其餘 ${flows.length - withManual} 條僅有分析結果，敘述逐步補齊。`,
    '---',
    ''
  ]
  pages.push({ file: 'index.md', content: home.join('\n') })

  const domainsMd = ['# 業務域', '']
  for (const [domain, list] of domains) {
    const w = list.filter(c => c.flowKind === 'write').length
    domainsMd.push(`- [${domain}](/flows/${slugify(domain)}/)　寫入 ${w} · 查詢 ${list.length - w}`)
  }
  pages.push({ file: 'domains.md', content: domainsMd.join('\n') })

  if (limitations) pages.push({ file: 'limitations.md', content: limitations })

  pages.push({
    file: '.vitepress/config.mts',
    content: renderConfig(result, domains, manuals, manualPrimaries, opts)
  })

  // 站台自帶 package.json，與分析器的依賴完全分離。
  // 兩者放在一起會出事：vitepress 綁 vite 5、vitest 需要 vite 6+，裝在同一個
  // package 裡 pnpm 會提升出一個誰都不滿意的版本，實測直接讓測試跑不起來。
  // 建置站台本來就是獨立的一步（CI 上也會分開），依賴自然也該分開。
  pages.push({
    file: 'package.json',
    content: `${JSON.stringify(
      {
        name: 'flow-doc-site',
        private: true,
        type: 'module',
        scripts: {
          dev: 'vitepress dev .',
          build: 'vitepress build .',
          preview: 'vitepress preview .'
        },
        devDependencies: {
          mermaid: '^11.4.1',
          vitepress: '^1.6.4',
          'vitepress-plugin-mermaid': '^2.0.17'
        }
      },
      null,
      2
    )}\n`
  })
  pages.push({ file: '.gitignore', content: 'node_modules/\n.vitepress/cache/\n.vitepress/dist/\n' })
  pages.push({
    file: 'README.md',
    content: [
      '# 站台原始碼',
      '',
      '**這個目錄由 `flow-doc site` 產生，請勿手動編輯**——重跑會整個覆蓋 `flows/`。',
      '',
      '要修改流程敘述，請改 `--manuals` 指向的目錄，再重新產生。',
      '',
      '```bash',
      'pnpm install',
      'pnpm dev',
      '```',
      ''
    ].join('\n')
  })
  return pages
}

function renderConfig(
  result: TraceResult,
  domains: [string, FlowChain[]][],
  manuals: ReadonlyMap<string, string>,
  manualPrimaries: ReadonlySet<string>,
  opts: SiteOptions
): string {
  const sidebar = [
    {
      text: '總覽',
      items: [
        { text: '業務域', link: '/domains' },
        { text: 'API 對照表', link: '/api' },
        { text: '已知限制', link: '/limitations' }
      ]
    },
    ...(result.crosscut.length > 0
      ? [
          {
            text: '全域前置',
            collapsed: false,
            items: result.crosscut.map(c => ({
              text: flowTitle(c, manuals.get(c.entryId)),
              link: `/flows/${slugify(c.domain)}/${slugify(c.entryId)}`
            }))
          }
        ]
      : []),
    ...domains.map(([domain, list]) => {
      const collapsed = collapseByManual(list, manuals, manualPrimaries)
      return {
        text: `${domain}（${collapsed.length}）`,
        collapsed: true,
        items: collapsed.map(({ chain: c, triggerCount }) => ({
          text: flowTitle(c, manuals.get(c.entryId)) + (triggerCount > 1 ? `（${triggerCount}）` : ''),
          link: `/flows/${slugify(domain)}/${slugify(c.entryId)}`
        }))
      }
    })
  ]

  // withMermaid 而非 defineConfig：plan.md 要求每條流程附序列圖，
  // 而 VitePress 預設只會把 ```mermaid 當成一般程式碼區塊印出來
  return `// 由 flow-doc site 產生，請勿手動編輯
import { withMermaid } from 'vitepress-plugin-mermaid'

export default withMermaid({
  title: ${JSON.stringify(opts.title)},
  description: '由程式碼靜態分析產生的業務流程手冊',
  lang: 'zh-TW',
  cleanUrls: true,
  ignoreDeadLinks: true,
  themeConfig: {
    outline: [2, 3],
    search: { provider: 'local' },
    nav: [
      { text: '業務域', link: '/domains' },
      { text: 'API 對照表', link: '/api' },
      { text: '已知限制', link: '/limitations' }
    ],
    sidebar: ${JSON.stringify(sidebar, null, 4).replace(/\n/g, '\n    ')},
    docFooter: { prev: false, next: false }
  }
})
`
}
