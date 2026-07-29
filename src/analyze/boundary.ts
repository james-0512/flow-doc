import { Node, SyntaxKind } from 'ts-morph'
import type { CallExpression } from 'ts-morph'
import type { SideEffect, SourceLoc } from '../types.js'
import type { SwaggerEndpoint } from './swagger.js'

export interface SinkContext {
  swagger: ReadonlyMap<string, SwaggerEndpoint>
  locOf: (node: Node) => SourceLoc
}

const SWAGGER_CALL = /swaggerApiService\.api\.(\w+)$/
const AXIOS_CALL = /(?:^|\.)apiService\.(get|post|put|patch|delete)$/
const ROUTER_NAV = /(?:^|\.)\$?router\.(push|replace)$/
const WEB_STORAGE = /^(?:window\.)?(local|session)Storage\.(setItem|getItem|removeItem|clear)$/
const EMIT_CALL = /^(?:\$?emit|emits)$/
/** SignalR 的 hub 呼叫。物件名在此專案穩定為 connection / conn / hub / signalR。 */
const SIGNALR_CALL = /(?:connection|conn|hub|signalR)[\w.]*\.(invoke|send|on|off)$/i
const BROADCAST_CALL = /\.postMessage$/

/** 第一個字串常數引數；拿不到（動態運算）回 null。 */
function firstStringArg(call: CallExpression): string | null {
  const arg = call.getArguments()[0]
  if (!arg) return null
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralText()
  return null
}

/** 呼叫是否位於 try 區塊內——階段四要據此描述「異常與補償」。 */
export function isGuarded(call: CallExpression): boolean {
  for (let n: Node | undefined = call.getParent(); n; n = n.getParent()) {
    if (Node.isTryStatement(n)) return true
    if (Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n)) return false
  }
  return false
}

/** `router.push({ name: 'X' })` / `router.push('/x')` 的目標描述。 */
function navTarget(call: CallExpression): string {
  const literal = firstStringArg(call)
  if (literal) return literal
  const arg = call.getArguments()[0]
  if (arg && Node.isObjectLiteralExpression(arg)) {
    const nameProp = arg.getProperty('name') ?? arg.getProperty('path')
    if (nameProp && Node.isPropertyAssignment(nameProp)) {
      const init = nameProp.getInitializer()
      if (init && Node.isStringLiteral(init)) return init.getLiteralText()
    }
  }
  return '(動態目標)'
}

/**
 * 以**呼叫形狀**辨識副作用邊界，優先於路徑分類。
 *
 * 用文字比對而非型別解析是刻意的：這些都是全域唯一、命名穩定的服務物件
 * （`apiService`、`swaggerApiService`、`localStorage`），型別解析付出的成本
 * 換不到準確度。Type Checker 留給真正需要它的地方——解析呼叫指向哪個定義。
 */
export function detectSink(call: CallExpression, ctx: SinkContext): SideEffect | null {
  const exprText = call.getExpression().getText()
  const loc = ctx.locOf(call)
  const guarded = isGuarded(call)

  const swaggerMatch = SWAGGER_CALL.exec(exprText)
  if (swaggerMatch) {
    const ep = ctx.swagger.get(swaggerMatch[1]!)
    return {
      kind: 'HTTP_API',
      detail: ep ? `${ep.method} ${ep.url}` : swaggerMatch[1]!,
      // 索引不到時保守視為 mutating，寧可多收一條流程也不要漏
      mutating: ep ? ep.method !== 'GET' : true,
      note: ep?.summary,
      loc,
      guarded
    }
  }

  const axiosMatch = AXIOS_CALL.exec(exprText)
  if (axiosMatch) {
    const method = axiosMatch[1]!.toUpperCase()
    return {
      kind: 'HTTP_API',
      detail: `${method} ${firstStringArg(call) ?? '(動態 URL)'}`,
      mutating: method !== 'GET',
      loc,
      guarded
    }
  }

  if (ROUTER_NAV.test(exprText)) {
    return { kind: 'ROUTER_NAV', detail: navTarget(call), mutating: false, loc, guarded }
  }

  const storageMatch = WEB_STORAGE.exec(exprText)
  if (storageMatch) {
    const op = storageMatch[2]!
    return {
      kind: 'STORAGE',
      detail: `${storageMatch[1]}Storage.${op}(${firstStringArg(call) ?? ''})`,
      mutating: op !== 'getItem',
      loc,
      guarded
    }
  }

  if (EMIT_CALL.test(exprText)) {
    return { kind: 'EMIT', detail: firstStringArg(call) ?? '(動態事件名)', mutating: false, loc, guarded }
  }

  if (SIGNALR_CALL.test(exprText)) {
    return { kind: 'SIGNALR', detail: `${exprText}(${firstStringArg(call) ?? '(動態)'})`, mutating: false, loc, guarded }
  }

  if (BROADCAST_CALL.test(exprText)) {
    return { kind: 'BROADCAST', detail: exprText, mutating: false, loc, guarded }
  }

  return null
}

export function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  )
}

/**
 * 把「定義節點」正規化成可以往下追的函式節點。
 * `getDefinitionNodes()` 回來的可能是 VariableDeclaration、PropertyAssignment、
 * ImportSpecifier 等等，都要再剝一層。
 */
export function toFunctionLike(node: Node, depth = 0): Node | null {
  if (depth > 3) return null
  if (isFunctionLike(node)) return node
  if (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) {
    const init = node.getInitializer()
    return init ? toFunctionLike(init, depth + 1) : null
  }
  // HOF 包裝：`const login = handleSubmit(async data => { … })`、`debounce(fn)`、`withLoading(fn)`。
  // 真正的業務邏輯在 callback 引數裡，包裝器本身沒有內容可追。
  if (Node.isCallExpression(node)) {
    for (const arg of node.getArguments()) {
      const fn = toFunctionLike(arg, depth + 1)
      if (fn) return fn
    }
    return null
  }
  if (Node.isImportSpecifier(node) || Node.isImportClause(node)) {
    const nameNode = Node.isImportSpecifier(node) ? node.getNameNode() : node.getDefaultImport()
    if (nameNode && Node.isIdentifier(nameNode)) {
      for (const def of nameNode.getDefinitionNodes()) {
        if (def === node) continue
        const fn = toFunctionLike(def, depth + 1)
        if (fn) return fn
      }
    }
    return null
  }
  if (Node.isShorthandPropertyAssignment(node)) {
    const value = node.getNameNode()
    for (const def of value.getDefinitionNodes()) {
      const fn = toFunctionLike(def, depth + 1)
      if (fn) return fn
    }
  }
  return null
}

/** 取函式主體內的所有呼叫，含巢狀箭頭函式（`.then(() => …)` 也是流程的一部分）。 */
export function callsWithin(fn: Node): CallExpression[] {
  const body = Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isFunctionExpression(fn)
    ? fn.getBody()
    : Node.isArrowFunction(fn)
      ? fn.getBody()
      : undefined
  if (!body) return []
  return body.getDescendantsOfKind(SyntaxKind.CallExpression)
}
