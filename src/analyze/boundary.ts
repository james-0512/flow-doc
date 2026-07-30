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
/**
 * Pinia store 的取得：`useAuthStore()`。
 *
 * 這是**取得 handle**，不是業務步驟。追進去會執行整個 defineStore setup，
 * 把 store 初始化時連帶建立的東西（其他 store、composable、SignalR 連線）
 * 全掛在呼叫者頭上——實測讓「權限守衛」憑空多出代理登出 API 與導頁。
 *
 * store 的 action 該在被明確呼叫時計入（`authStore.loginHandler()` 會由
 * Type Checker 直接解析到 action 本身），與這裡無關。
 */
const PINIA_STORE_GETTER = /(?:^|\.)use[A-Z]\w*Store$/

/**
 * 呼叫運算式的正規化文字。
 *
 * 這個 repo 大量使用鏈式寫法，`swaggerApiService.api` 與方法名常被 prettier 拆到
 * 不同行：
 *
 * ```ts
 * await swaggerApiService.api
 *   .loginBindLineLogin(a, b)
 *   .then(…)
 * ```
 *
 * 不把空白收掉，所有跨行的 API 呼叫都會比對不到、然後解析進 generated code 被
 * STOP 靜默跳過——手冊會少掉真實存在的 API 互動。
 */
export function normalizeExpr(call: CallExpression): string {
  return call.getExpression().getText().replace(/\s+/g, '')
}

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
  const exprText = normalizeExpr(call)
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

  if (PINIA_STORE_GETTER.test(exprText)) {
    return { kind: 'STORE', detail: `取得 ${exprText.replace(/^use|Store$/g, '')} store`, mutating: false, loc, guarded }
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

/**
 * 這個函式是「被當成引數傳進去、因而會被呼叫」的回呼嗎？
 *
 * `.then(() => …)`、`onMounted(() => …)`、`defineStore('x', () => …)` 的回呼都會執行，
 * 所以裡面的呼叫屬於流程的一部分。反之 `const foo = () => …` 或巢狀的
 * `function bar() {…}` 只是**定義**，不執行。
 */
function isInvokedInPlace(fn: Node): boolean {
  const parent = fn.getParent()
  if (!parent) return false
  // NewExpression 一定要一起收：`new Promise((resolve, reject) => …)` 的 executor
  // 會被建構子立刻執行，而這是包裝非同步流程最常見的寫法。漏掉它會讓
  // `loginHandler` 裡的 API 呼叫整個消失。
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    // 當引數（回呼）或當被呼叫者（IIFE）都算會執行
    return parent.getArguments().some(a => a === fn) || parent.getExpression() === fn
  }
  // (() => {…})() 這種被括號包住的 IIFE
  if (Node.isParenthesizedExpression(parent)) return isInvokedInPlace(parent)
  return false
}

/**
 * 取函式主體內**實際會執行到**的呼叫。
 *
 * 關鍵在於不能無腦抓 descendants：Pinia store 的 setup 函式裡宣告了一堆 action，
 * 但 `useAuthStore()` 只是取得 store、不會執行它們。無腦抓的話，路由守衛的副作用
 * 會憑空多出 `POST /api/v1/login`、`POST /api/v1/logout`——照那份資料寫出來的手冊
 * 會宣稱「進入頁面時系統呼叫了登入 API」，是完全錯誤的結論。
 *
 * 巢狀函式只有在「當場被呼叫」時才往裡面看；若只是被定義，它的呼叫要等到有人
 * 真的呼叫它、由 resolveCallTarget 追進去時才計入。
 */
export function callsWithin(fn: Node): CallExpression[] {
  const body =
    Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) || Node.isFunctionExpression(fn)
      ? fn.getBody()
      : Node.isArrowFunction(fn)
        ? fn.getBody()
        : undefined
  if (!body) return []

  const out: CallExpression[] = []
  const visit = (node: Node): void => {
    if (isFunctionLike(node) && !isInvokedInPlace(node)) return
    if (Node.isCallExpression(node)) out.push(node)
    node.forEachChild(visit)
  }
  body.forEachChild(visit)
  return out
}
