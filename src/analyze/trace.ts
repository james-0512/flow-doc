import path from 'node:path'
import { Node, SyntaxKind } from 'ts-morph'
import type { CallExpression, SourceFile } from 'ts-morph'
import { classifyPath } from '../config.js'
import type { AnalyzerConfig } from '../config.js'
import { sourceSignature } from '../signature.js'
import { packageVersion, readTargetRevision, REPRESENTATION_VERSION } from '../version.js'
import type { Workspace } from '../workspace.js'
import type {
  AsyncLink,
  ChainNode,
  EntryCandidate,
  EntryScanResult,
  FlowChain,
  ListenerEdge,
  SideEffect,
  SourceLoc,
  TraceResult
} from '../types.js'
import { camelize } from '../load/registry.js'
import { callsWithin, detectSink, isGuarded, normalizeExpr, toFunctionLike, type SinkContext } from './boundary.js'
import { createAnalysisProgram, readSwaggerSource } from './program.js'
import { indexSwaggerApi } from './swagger.js'

export interface TraceOptions {
  maxDepth: number
  /** 單條鏈的節點預算，防止扇出爆炸 */
  maxNodes: number
  /** 一個呼叫解析出多個定義時，最多往下追幾個 */
  maxCandidates: number
  /** 一個 emit 最多接幾個 parent listener（共用元件可能有數十個父層） */
  maxListeners: number
}

export const defaultTraceOptions: TraceOptions = {
  maxDepth: 8,
  maxNodes: 250,
  maxCandidates: 2,
  maxListeners: 5
}

/**
 * 不值得付 Type Checker 成本去解析的呼叫。
 * 它們最終都會落在 node_modules（＝ STOP），先擋掉可省下大量語言服務查詢。
 */
const NOISE_CALLS = new Set([
  'ref', 'reactive', 'computed', 'watch', 'watchEffect', 'toRef', 'toRefs', 'unref', 'nextTick',
  'defineProps', 'defineEmits', 'defineExpose', 'withDefaults', 'onMounted', 'onUnmounted',
  't', '$t', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'Array', 'Object', 'Promise'
])
const NOISE_PREFIX = /^(console|JSON|Math|Object|Array|Number|String|Date|Promise|window|document|localStorage|sessionStorage)\./
/**
 * ref 上的陣列／字串內建方法。`.value.` 這個標記保證它是 ref 而非業務物件，
 * 所以按方法名擋掉是安全的——不會誤殺 repository.find() 這種業務呼叫。
 */
const REF_BUILTIN = /\.value\.(push|pop|shift|unshift|splice|slice|concat|indexOf|lastIndexOf|includes|find|findIndex|filter|map|forEach|some|every|reduce|sort|reverse|join|fill|flat|at|keys|values|entries)$/
/** Promise executor 的回呼參數，永遠解析不到定義。 */
const PROMISE_CALLBACK = /^(resolve|reject|next|done)$/
/** template 上直接寫 `@click="emit('close')"` 的純轉發 handler。 */
const INLINE_EMIT = /^\$?emit\(\s*['"]([^'"]+)['"]/

export function createTracer(ws: Workspace, scan: EntryScanResult) {
  const { repoRoot } = ws.config
  const program = createAnalysisProgram(ws)
  const swaggerSource = readSwaggerSource(repoRoot)
  const swagger = swaggerSource ? indexSwaggerApi(swaggerSource) : new Map()

  /** 節點位置 → 使用者看得到的檔案。虛擬 `.vue.ts` 還原成 `.vue`，行號因對齊而無需換算。 */
  const locOf = (node: Node): SourceLoc => {
    const abs = node.getSourceFile().getFilePath()
    let rel = path.relative(repoRoot, abs).split(path.sep).join('/')
    if (rel.endsWith('.vue.ts')) rel = rel.slice(0, -3)
    return { file: rel, line: node.getStartLineNumber() }
  }

  // 階段三的 join 索引：`子元件檔案|事件名` → 所有掛了這個 listener 的 parent。
  // 事件名一律 camelize，因為 template 慣用 kebab-case 而 emit 慣用 camelCase。
  const listenerIndex = new Map<string, ListenerEdge[]>()
  for (const edge of scan.listeners) {
    if (!edge.toComponent) continue
    const key = `${edge.toComponent}|${camelize(edge.event)}`
    const bucket = listenerIndex.get(key)
    if (bucket) bucket.push(edge)
    else listenerIndex.set(key, [edge])
  }
  // 同一個事件的多個 parent listener 要有固定順序：它決定封包裡的呈現順序，
  // 更決定超過 maxListeners 時**哪幾個**被展開。順序浮動 = 同一份程式碼跑兩次
  // 得到不同結果，閉環會把它誤判成程式變更。
  for (const bucket of listenerIndex.values()) {
    bucket.sort((a, b) => a.loc.file.localeCompare(b.loc.file) || a.loc.line - b.loc.line)
  }

  const ctx: SinkContext = { swagger, locOf }
  return { project: program.project, program, swagger, locOf, ctx, listenerIndex, config: ws.config }
}

type Tracer = ReturnType<typeof createTracer>

interface SharedCounters {
  unresolvedNames: Map<string, number>
  unresolvedHandlers: Map<string, number>
  asyncLinksJoined: number
  emitsUnjoined: number
  emitsModelBinding: number
  unjoinedEmits: Map<string, number>
  candidatesTruncated: number
  listenersTruncated: number
  duplicateNodes: number
}

/** `update:xxx` 是 v-model 的 writeback，另一端沒有 handler 可接。 */
const MODEL_WRITEBACK = /^update:/

interface DfsState {
  /** 目前遞迴路徑上的函式，用來擋環路（進入時加入、離開時移除） */
  visited: Set<string>
  /**
   * 本條鏈中已完整展開過的函式（不移除）。
   * 沒有這層記憶，同一個函式會在不同分支被整棵重展——實測最大的幾條鏈有
   * 70–76% 的節點是這樣來的，而那些正是最接近 context 預算的封包。
   */
  expanded: Set<string>
  nodeBudget: number
  unresolved: number
  maxDepthSeen: number
  shared: SharedCounters
}

function tally(counter: Map<string, number>, name: string): void {
  counter.set(name, (counter.get(name) ?? 0) + 1)
}

function topOf(counter: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...counter]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }))
}

function nameOf(fn: Node): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? '(匿名函式)'
  // 往上找可命名的宣告，並跨過 HOF 包裝：`const login = handleSubmit(async () => …)`
  // 的箭頭函式其實就叫 login，手冊需要這個名字。
  let n = fn.getParent()
  for (let i = 0; n && i < 4; n = n.getParent(), i++) {
    if (Node.isVariableDeclaration(n) || Node.isPropertyAssignment(n)) return n.getName()
  }
  return '(匿名函式)'
}

function keyOf(fn: Node): string {
  return `${fn.getSourceFile().getFilePath()}#${fn.getPos()}`
}

/** 用 Type Checker 解析呼叫指向的實際定義——這是 tree-sitter 做不到、也是本專案採用 ts-morph 的唯一理由。 */
function resolveCallTarget(call: CallExpression): Node[] {
  const expr = call.getExpression()
  const nameNode = Node.isIdentifier(expr)
    ? expr
    : Node.isPropertyAccessExpression(expr)
      ? expr.getNameNode()
      : undefined
  if (!nameNode || !Node.isIdentifier(nameNode)) return []
  try {
    return nameNode.getDefinitionNodes()
  } catch {
    return []
  }
}

function sourceFileFor(t: Tracer, rel: string): SourceFile | undefined {
  return t.project.getSourceFile(
    path.join(t.config.repoRoot, rel.endsWith('.vue') ? `${rel}.ts` : rel)
  )
}

/**
 * 以名稱在某個檔案的頂層作用域找 handler 函式。
 *
 * 第三條路（解構）是必要的：現代 Vue 大量使用 `const { login } = useLoginForm()`
 * 把邏輯抽到 composable。只查 function/variable 宣告的話，這類 handler 全部起不了鏈——
 * 實測目標專案把登入重構進 composable 之後，整個登入流程就從手冊裡消失了。
 */
function resolveNamedHandler(t: Tracer, rel: string, name: string | undefined): Node | null {
  if (!name || name.includes('.')) return null
  const sf = sourceFileFor(t, rel)
  if (!sf) return null

  // 注意不能在 decl 存在時就 return：`getVariableDeclaration` 連解構綁定也會匹配，
  // 而那種宣告的 initializer 是 composable 呼叫，toFunctionLike 取不到函式。
  // 早退的話永遠走不到下面的解構解析。
  const decl = sf.getFunction(name) ?? sf.getVariableDeclaration(name)
  const direct = decl ? toFunctionLike(decl) : null
  if (direct) return direct

  for (const element of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    if (element.getName() !== name) continue
    const fn = resolveFromComposable(element, name)
    if (fn) return fn
  }
  return null
}

/**
 * `const { login } = useLoginForm(…)` → 找出 composable 回傳物件裡的 `login`。
 *
 * 不用 `getDefinitionNodes()`：對解構綁定它只回到綁定本身，拿不到實作。
 * 改走確定性路徑——解析 composable 的呼叫目標，再從它 `return` 的物件字面量
 * 取同名屬性。
 */
function resolveFromComposable(element: Node, name: string): Node | null {
  const declaration = element.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
  const initializer = declaration?.getInitializer()
  if (!initializer || !Node.isCallExpression(initializer)) return null

  for (const def of resolveCallTarget(initializer)) {
    const composable = toFunctionLike(def)
    if (!composable) continue
    const body =
      Node.isFunctionDeclaration(composable) || Node.isArrowFunction(composable)
        ? composable.getBody()
        : undefined
    if (!body) continue
    for (const ret of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
      const expr = ret.getExpression()
      if (!expr || !Node.isObjectLiteralExpression(expr)) continue
      const prop = expr.getProperty(name)
      const fn = prop ? toFunctionLike(prop) : null
      if (fn) return fn
    }
  }
  return null
}

/**
 * 把 `emit('X')` 接到所有掛了 `@X` 的 parent handler。
 *
 * 一個共用元件可能被數十個父層使用，全部展開會爆炸——所以有 maxListeners 上限，
 * 且**不硬選一個**：超出上限的部分在 stats 裡看得見。
 */
function joinEmit(
  t: Tracer,
  emitFile: string,
  event: string,
  from: SourceLoc,
  depth: number,
  state: DfsState,
  opts: TraceOptions,
  guardedCtx: boolean
): AsyncLink[] {
  const edges = t.listenerIndex.get(`${emitFile}|${camelize(event)}`)
  if (!edges || edges.length === 0) {
    // 父層可能是用 `@update:x="handler"` 明確接（上面查得到），也可能是 `v-model`
    // （查不到）。只有後者才不是缺口。
    if (MODEL_WRITEBACK.test(event)) {
      state.shared.emitsModelBinding++
    } else {
      state.shared.emitsUnjoined++
      tally(state.shared.unjoinedEmits, `${emitFile} @${event}`)
    }
    return []
  }

  if (edges.length > opts.maxListeners) {
    state.shared.listenersTruncated += edges.length - opts.maxListeners
  }

  const links: AsyncLink[] = []
  for (const edge of edges.slice(0, opts.maxListeners)) {
    const fn = resolveNamedHandler(t, edge.from, edge.handlerName)
    let chain: ChainNode | null = null
    if (fn && depth < opts.maxDepth && state.nodeBudget > 0) {
      const key = keyOf(fn)
      if (!state.visited.has(key) && !state.expanded.has(key)) {
        state.visited.add(key)
        state.expanded.add(key)
        state.nodeBudget--
        chain = dfs(t, fn, depth + 1, state, opts, guardedCtx)
        state.visited.delete(key)
      }
    }
    links.push({
      kind: 'EMIT',
      event,
      from,
      to: edge.loc,
      handlerExpr: edge.handlerExpr,
      chain
    })
    state.shared.asyncLinksJoined++
  }
  return links
}

function dfs(
  t: Tracer,
  fn: Node,
  depth: number,
  state: DfsState,
  opts: TraceOptions,
  /** 呼叫進來的路徑上是否已被某個 try 包住 */
  guardedCtx: boolean
): ChainNode {
  const node: ChainNode = {
    name: nameOf(fn),
    loc: t.locOf(fn),
    endLine: fn.getEndLineNumber(),
    effects: [],
    children: []
  }
  state.maxDepthSeen = Math.max(state.maxDepthSeen, depth)

  if (depth >= opts.maxDepth) {
    node.stoppedBy = 'MAX_DEPTH'
    return node
  }
  if (state.nodeBudget <= 0) {
    node.stoppedBy = 'BUDGET'
    return node
  }

  for (const call of callsWithin(fn)) {
    const sink = detectSink(call, t.ctx)
    if (sink) {
      node.effects.push(guardedCtx ? { ...sink, guarded: true } : sink)
      if (sink.kind === 'EMIT' && !sink.detail.startsWith('(')) {
        const before = state.shared.listenersTruncated
        const links = joinEmit(t, sink.loc.file, sink.detail, sink.loc, depth, state, opts, guardedCtx)
        if (links.length > 0) (node.asyncLinks ??= []).push(...links)
        const omitted = state.shared.listenersTruncated - before
        if (omitted > 0) node.omittedListeners = (node.omittedListeners ?? 0) + omitted
      }
      continue
    }

    const exprText = normalizeExpr(call)
    if (
      NOISE_CALLS.has(exprText) ||
      NOISE_PREFIX.test(exprText) ||
      REF_BUILTIN.test(exprText) ||
      PROMISE_CALLBACK.test(exprText)
    ) {
      continue
    }

    const targets = resolveCallTarget(call)
    if (targets.length === 0) {
      state.unresolved++
      tally(state.shared.unresolvedNames, exprText)
      continue
    }

    // Type Checker 常對同一個函式回傳多個定義節點（型別宣告 + 實作，
    // Pinia action 尤其如此），必須依實際函式節點去重，否則整棵樹會成倍複製。
    const resolved: Node[] = []
    const seenTargets = new Set<string>()
    for (const def of targets) {
      const target = toFunctionLike(def)
      if (!target) continue
      const key = keyOf(target)
      if (seenTargets.has(key)) continue
      seenTargets.add(key)
      resolved.push(target)
    }
    if (resolved.length === 0) {
      state.unresolved++
      tally(state.shared.unresolvedNames, exprText)
      continue
    }

    const candidates = resolved.length > 1 ? resolved.map(r => t.locOf(r)) : undefined
    let followed = 0

    for (const target of resolved) {
      const rel = t.locOf(target).file
      const kind = classifyPath(t.config, rel)

      if (rel.startsWith('src/stores/')) {
        node.effects.push({
          kind: 'STORE',
          detail: `${rel.replace(/^src\/stores\//, '').replace(/\.ts$/, '')}.${nameOf(target)}`,
          mutating: false,
          loc: t.locOf(call),
          guarded: guardedCtx
        })
      }

      if (kind === 'STOP') continue
      if (kind === 'SINK') {
        node.effects.push({
          kind: 'OPAQUE',
          detail: `${nameOf(target)} (${rel})`,
          mutating: false,
          loc: t.locOf(call)
        })
        continue
      }

      if (followed >= opts.maxCandidates) {
        state.shared.candidatesTruncated++
        continue
      }
      const key = keyOf(target)
      if (state.visited.has(key)) {
        node.children.push({ name: nameOf(target), loc: t.locOf(target), effects: [], children: [], stoppedBy: 'CYCLE' })
        continue
      }
      if (state.expanded.has(key)) {
        state.shared.duplicateNodes++
        node.children.push({
          name: nameOf(target),
          loc: t.locOf(target),
          effects: [],
          children: [],
          stoppedBy: 'DUPLICATE'
        })
        followed++
        continue
      }

      state.visited.add(key)
      state.expanded.add(key)
      state.nodeBudget--
      const child = dfs(t, target, depth + 1, state, opts, guardedCtx || isGuarded(call))
      if (candidates) child.candidates = candidates
      node.children.push(child)
      state.visited.delete(key)
      followed++
    }
  }

  return node
}

/**
 * 解析 entry 的起始函式。
 * - LIFECYCLE：靠行號對齊直接在虛擬檔找到該行的 `onMounted(...)`，取其函式引數
 * - UI_EVENT：以 handler 名稱在該 SFC 的頂層作用域查找
 */
function resolveEntryFunction(t: Tracer, entry: EntryCandidate): Node | null {
  const sf = sourceFileFor(t, entry.file)
  if (!sf) return null

  if (entry.kind === 'LIFECYCLE') {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getStartLineNumber() !== entry.loc.line) continue
      if (call.getExpression().getText() !== entry.trigger) continue
      const arg = call.getArguments()[0]
      return arg ? toFunctionLike(arg) : null
    }
    return null
  }

  return resolveNamedHandler(t, entry.file, entry.handlerName)
}

function flatten(
  node: ChainNode,
  out: { effects: SideEffect[]; count: number },
  followLinks: boolean
): void {
  out.count++
  out.effects.push(...node.effects)
  for (const child of node.children) flatten(child, out, followLinks)
  if (!followLinks) return
  for (const link of node.asyncLinks ?? []) {
    if (link.chain) flatten(link.chain, out, followLinks)
  }
}

function newDfsState(opts: TraceOptions, shared: SharedCounters): DfsState {
  return {
    visited: new Set<string>(),
    expanded: new Set<string>(),
    nodeBudget: opts.maxNodes,
    unresolved: 0,
    maxDepthSeen: 0,
    shared
  }
}

/** 依「有沒有跨越 HTTP 邊界」分類，而非只看寫入——理由見 FlowChain.flowKind。 */
function classifyFlow(effects: SideEffect[]): FlowChain['flowKind'] {
  if (effects.some(e => e.mutating)) return 'write'
  if (effects.some(e => e.kind === 'HTTP_API')) return 'read'
  return 'none'
}

/**
 * 追橫切邏輯：axios 攔截器與路由守衛。
 *
 * 這些不是任何一條業務流程的一部分，而是**每一條**都會經過的東西。獨立成鏈，
 * 手冊寫成單獨一章，各流程連結引用即可。
 */
function traceCrosscut(t: Tracer, shared: SharedCounters, opts: TraceOptions): FlowChain[] {
  const out: FlowChain[] = []

  for (const spec of t.config.crosscut) {
    const roots: { fn: Node; label: string }[] = []

    if (spec.symbolPattern) {
      // 目錄模式：掃出所有符合的匯出工廠，各自成一章
      const re = new RegExp(spec.symbolPattern)
      const prefix = spec.file.endsWith('/') ? spec.file : `${spec.file}/`
      for (const rel of [...t.project.getSourceFiles()]
        .map(f => path.relative(t.config.repoRoot, f.getFilePath()).split(path.sep).join('/'))
        .filter(r => r.startsWith(prefix))
        .sort()) {
        const sf = sourceFileFor(t, rel)
        if (!sf) continue
        for (const decl of sf.getFunctions()) {
          const name = decl.getName()
          if (!name || !decl.isExported() || !re.test(name)) continue
          const fn = spec.unwrapReturn ? returnedFunctionOf(decl) : decl
          if (fn) roots.push({ fn, label: `${spec.label} — ${name.replace(/^create|Guard$/g, '')}` })
        }
      }
      for (const [i, { fn, label }] of roots.entries()) {
        out.push(buildCrosscutChain(t, shared, opts, spec.file, i, fn, label))
      }
      continue
    }

    const sf = sourceFileFor(t, spec.file)
    if (!sf) continue

    if (spec.symbol) {
      const fn = resolveNamedHandler(t, spec.file, spec.symbol)
      if (fn) roots.push({ fn, label: spec.label })
    } else {
      // 沒指定符號時，找 `xxx.interceptors.request.use(onFulfilled, onRejected)` 的回呼。
      // 標籤要分得出請求／回應與成功／錯誤，否則手冊只會看到四個「匿名函式」
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const phase = /\.interceptors\.(\w+)\.use$/.exec(normalizeExpr(call))
        if (!phase) continue
        const stage = phase[1] === 'request' ? '請求' : '回應'
        for (const [i, arg] of call.getArguments().entries()) {
          const fn = toFunctionLike(arg)
          if (fn) roots.push({ fn, label: `${spec.label} — ${stage}${i === 0 ? '成功' : '錯誤'}` })
        }
      }
    }

    for (const [i, { fn, label }] of roots.entries()) {
      out.push(buildCrosscutChain(t, shared, opts, spec.file, i, fn, label))
    }
  }

  return out
}

/** 工廠函式 `return` 出來的那個函式——真正會被框架呼叫的東西。 */
function returnedFunctionOf(decl: Node): Node | null {
  const body = Node.isFunctionDeclaration(decl) ? decl.getBody() : undefined
  if (!body) return null
  for (const stmt of body.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expr = stmt.getExpression()
    const fn = expr ? toFunctionLike(expr) : null
    if (fn) return fn
  }
  return null
}

function buildCrosscutChain(
  t: Tracer,
  shared: SharedCounters,
  opts: TraceOptions,
  file: string,
  index: number,
  fn: Node,
  label: string
): FlowChain {
  const state = newDfsState(opts, shared)
  state.visited.add(keyOf(fn))
  state.expanded.add(keyOf(fn))
  const root = dfs(t, fn, 0, state, opts, false)
  const agg = { effects: [] as SideEffect[], count: 0 }
  flatten(root, agg, true)
  const effects = dedupeEffects(agg.effects)
  return {
    // label 是守衛名／攔截器階段（例如「路由守衛 — AuthGate」），
    // 那才是它的語意身份；index 會隨檔案內的宣告順序漂移
    entryId: `crosscut:${file}#${label}`,
    legacyEntryId: `crosscut:${file}#${index}`,
    domain: '全域前置',
    label,
    trigger: label,
    entryKind: 'CROSSCUT',
    entryLoc: t.locOf(fn),
    root,
    effects,
    nodeCount: agg.count,
    maxDepth: state.maxDepthSeen,
    flowKind: classifyFlow(effects),
    isFlow: true,
    unresolvedCalls: state.unresolved,
    sourceHash: ''
  }
}

function dedupeEffects(effects: SideEffect[]): SideEffect[] {
  const seen = new Map<string, SideEffect>()
  for (const e of effects) {
    const key = `${e.kind}|${e.detail}`
    if (!seen.has(key)) seen.set(key, e)
  }
  return [...seen.values()]
}

export function traceEntries(
  ws: Workspace,
  scan: EntryScanResult,
  opts: TraceOptions = defaultTraceOptions
): TraceResult {
  const t = createTracer(ws, scan)
  const started = Date.now()
  const chains: FlowChain[] = []
  const shared: SharedCounters = {
    unresolvedNames: new Map(),
    unresolvedHandlers: new Map(),
    asyncLinksJoined: 0,
    emitsUnjoined: 0,
    emitsModelBinding: 0,
    unjoinedEmits: new Map(),
    candidatesTruncated: 0,
    listenersTruncated: 0,
    duplicateNodes: 0
  }
  let unresolvedHandler = 0
  let flowsGainedByJoin = 0

  // ROUTE 不獨立追鏈：進入頁面實際執行的是該元件的 lifecycle，
  // 那些已由 LIFECYCLE entry 覆蓋，重複追只會產生兩份相同的鏈。
  const traceable = scan.entries.filter(e => e.kind === 'UI_EVENT' || e.kind === 'LIFECYCLE')

  for (const entry of traceable) {
    let root: ChainNode | null = null
    const state = newDfsState(opts, shared)

    const fn = resolveEntryFunction(t, entry)
    if (fn) {
      state.visited.add(keyOf(fn))
      state.expanded.add(keyOf(fn))
      root = dfs(t, fn, 0, state, opts, false)
    } else {
      // template 上直接寫 `@click="emit('close')"` 的純轉發。它不是「解析失敗」，
      // 而是一個沒有本地邏輯、直接跨到 parent 的斷點——階段三正好接得起來。
      const inlineEmit = entry.handlerExpr ? INLINE_EMIT.exec(entry.handlerExpr) : null
      if (inlineEmit) {
        const event = inlineEmit[1]!
        root = {
          name: `emit('${event}')`,
          loc: entry.loc,
          effects: [{ kind: 'EMIT', detail: event, mutating: false, loc: entry.loc }],
          children: []
        }
        const links = joinEmit(t, entry.file, event, entry.loc, 0, state, opts, false)
        if (links.length > 0) root.asyncLinks = links
      } else {
        if (entry.handlerName) {
          unresolvedHandler++
          tally(shared.unresolvedHandlers, entry.handlerName)
        }
        continue
      }
    }

    const withLinks = { effects: [] as SideEffect[], count: 0 }
    flatten(root, withLinks, true)
    const localOnly = { effects: [] as SideEffect[], count: 0 }
    flatten(root, localOnly, false)

    const effects = dedupeEffects(withLinks.effects)
    const flowKind = classifyFlow(effects)
    if (flowKind !== 'none' && classifyFlow(localOnly.effects) === 'none') flowsGainedByJoin++

    chains.push({
      entryId: entry.id,
      legacyEntryId: entry.legacyId,
      domain: entry.domain,
      label: entry.label,
      trigger: entry.trigger,
      tag: entry.tag,
      entryKind: entry.kind,
      entryLoc: entry.loc,
      root,
      effects,
      nodeCount: withLinks.count,
      maxDepth: state.maxDepthSeen,
      flowKind,
      isFlow: flowKind !== 'none',
      unresolvedCalls: state.unresolved,
      sourceHash: ''
    })
  }

  const crosscut = traceCrosscut(t, shared, opts)

  // 原始碼簽章要在分析當下算——diff 只有兩份 JSON，拿不到 baseline 那個 commit 的原始碼
  for (const chain of [...chains, ...crosscut]) {
    chain.sourceHash = sourceSignature(ws.config.repoRoot, chain)
  }

  return {
    repoRoot: ws.config.repoRoot,
    generatedAt: new Date().toISOString(),
    analyzer: { representation: REPRESENTATION_VERSION, version: packageVersion(), platform: process.platform },
    target: readTargetRevision(ws.config.repoRoot),
    chains,
    crosscut,
    stats: {
      entriesTraced: traceable.length,
      entriesUnresolvedHandler: unresolvedHandler,
      flows: chains.filter(c => c.flowKind === 'write').length,
      readFlows: chains.filter(c => c.flowKind === 'read').length,
      candidatesTruncated: shared.candidatesTruncated,
      listenersTruncated: shared.listenersTruncated,
      duplicateNodes: shared.duplicateNodes,
      programMs: t.program.elapsedMs,
      traceMs: Date.now() - started,
      swaggerEndpoints: t.swagger.size,
      unresolvedTop: topOf(shared.unresolvedNames, 20),
      unresolvedHandlerTop: topOf(shared.unresolvedHandlers, 20),
      asyncLinksJoined: shared.asyncLinksJoined,
      emitsUnjoined: shared.emitsUnjoined,
      emitsModelBinding: shared.emitsModelBinding,
      unjoinedEmitTop: topOf(shared.unjoinedEmits, 20),
      flowsGainedByJoin
    }
  }
}

export type { AnalyzerConfig }
