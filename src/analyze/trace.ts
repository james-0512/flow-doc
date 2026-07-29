import path from 'node:path'
import { Node, SyntaxKind } from 'ts-morph'
import type { CallExpression } from 'ts-morph'
import { classifyPath } from '../config.js'
import type { AnalyzerConfig } from '../config.js'
import type { Workspace } from '../workspace.js'
import type {
  ChainNode,
  EntryCandidate,
  EntryScanResult,
  FlowChain,
  SideEffect,
  SourceLoc,
  TraceResult
} from '../types.js'
import { callsWithin, detectSink, isGuarded, toFunctionLike, type SinkContext } from './boundary.js'
import { createAnalysisProgram, readSwaggerSource } from './program.js'
import { indexSwaggerApi } from './swagger.js'

export interface TraceOptions {
  maxDepth: number
  /** 單條鏈的節點預算，防止扇出爆炸 */
  maxNodes: number
  /** 一個呼叫解析出多個定義時，最多往下追幾個 */
  maxCandidates: number
}

export const defaultTraceOptions: TraceOptions = { maxDepth: 8, maxNodes: 250, maxCandidates: 2 }

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

export function createTracer(ws: Workspace) {
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

  const relOf = (node: Node): string => locOf(node).file
  const ctx: SinkContext = { swagger, locOf }

  return { project: program.project, program, swagger, locOf, relOf, ctx, config: ws.config }
}

type Tracer = ReturnType<typeof createTracer>

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

interface DfsState {
  visited: Set<string>
  nodeBudget: number
  unresolved: number
  maxDepthSeen: number
  /** 跨鏈共用：解析不到的呼叫名稱統計 */
  unresolvedNames: Map<string, number>
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

function keyOf(fn: Node): string {
  return `${fn.getSourceFile().getFilePath()}#${fn.getPos()}`
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
  const node: ChainNode = { name: nameOf(fn), loc: t.locOf(fn), effects: [], children: [] }
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
      continue
    }

    const exprText = call.getExpression().getText()
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
      tally(state.unresolvedNames, exprText)
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
      tally(state.unresolvedNames, exprText)
      continue
    }

    const candidates = resolved.length > 1 ? resolved.map(r => t.locOf(r)) : undefined
    let followed = 0

    for (const target of resolved) {
      const rel = t.relOf(target)
      const kind = classifyPath(t.config, rel)

      if (rel.startsWith('src/stores/')) {
        node.effects.push({
          kind: 'STORE',
          detail: `${rel.replace(/^src\/stores\//, '').replace(/\.ts$/, '')}.${nameOf(target)}`,
          mutating: false,
          loc: t.locOf(call),
          guarded: false
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

      if (followed >= opts.maxCandidates) break
      const key = keyOf(target)
      if (state.visited.has(key)) {
        node.children.push({ name: nameOf(target), loc: t.locOf(target), effects: [], children: [], stoppedBy: 'CYCLE' })
        continue
      }

      state.visited.add(key)
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
  const sf = t.project.getSourceFile(
    path.join(t.config.repoRoot, entry.file.endsWith('.vue') ? `${entry.file}.ts` : entry.file)
  )
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

  const name = entry.handlerName
  if (!name || name.includes('.')) return null
  const decl = sf.getFunction(name) ?? sf.getVariableDeclaration(name)
  return decl ? toFunctionLike(decl) : null
}

function flatten(node: ChainNode, out: { effects: SideEffect[]; count: number }): void {
  out.count++
  out.effects.push(...node.effects)
  for (const child of node.children) flatten(child, out)
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
  const t = createTracer(ws)
  const started = Date.now()
  const chains: FlowChain[] = []
  const unresolvedNames = new Map<string, number>()
  const unresolvedHandlers = new Map<string, number>()
  let unresolvedHandler = 0

  // ROUTE 不獨立追鏈：進入頁面實際執行的是該元件的 lifecycle，
  // 那些已由 LIFECYCLE entry 覆蓋，重複追只會產生兩份相同的鏈。
  const traceable = scan.entries.filter(e => e.kind === 'UI_EVENT' || e.kind === 'LIFECYCLE')

  for (const entry of traceable) {
    const fn = resolveEntryFunction(t, entry)
    if (!fn) {
      // handler 是賦值式（`show = !show`）或成員存取（`store.load`）時無法起鏈，
      // 前者本來就不是流程，後者是已知缺口
      if (entry.handlerName) {
        unresolvedHandler++
        tally(unresolvedHandlers, entry.handlerName)
      }
      continue
    }

    const state: DfsState = {
      visited: new Set([keyOf(fn)]),
      nodeBudget: opts.maxNodes,
      unresolved: 0,
      maxDepthSeen: 0,
      unresolvedNames
    }
    const root = dfs(t, fn, 0, state, opts, false)
    const agg = { effects: [] as SideEffect[], count: 0 }
    flatten(root, agg)
    const effects = dedupeEffects(agg.effects)

    chains.push({
      entryId: entry.id,
      domain: entry.domain,
      label: entry.label,
      entryLoc: entry.loc,
      root,
      effects,
      nodeCount: agg.count,
      maxDepth: state.maxDepthSeen,
      isFlow: effects.some(e => e.mutating),
      unresolvedCalls: state.unresolved
    })
  }

  return {
    repoRoot: ws.config.repoRoot,
    generatedAt: new Date().toISOString(),
    chains,
    stats: {
      entriesTraced: traceable.length,
      entriesUnresolvedHandler: unresolvedHandler,
      flows: chains.filter(c => c.isFlow).length,
      programMs: t.program.elapsedMs,
      traceMs: Date.now() - started,
      swaggerEndpoints: t.swagger.size,
      unresolvedTop: topOf(unresolvedNames, 20),
      unresolvedHandlerTop: topOf(unresolvedHandlers, 20)
    }
  }
}

export type { AnalyzerConfig }
