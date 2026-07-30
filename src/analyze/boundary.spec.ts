import { describe, expect, it } from 'vitest'
import { Node, Project, SyntaxKind } from 'ts-morph'
import type { CallExpression } from 'ts-morph'
import { callsWithin, detectSink, toFunctionLike, type SinkContext } from './boundary.js'
import type { SwaggerEndpoint } from './swagger.js'

const swagger = new Map<string, SwaggerEndpoint>([
  ['caseCreateCase', { method: 'POST', url: '/api/v1/case/create', summary: '建立個案', tag: 'Case' }]
])
const ctx: SinkContext = { swagger, locOf: node => ({ file: 't.ts', line: node.getStartLineNumber() }) }

function callsIn(code: string): CallExpression[] {
  const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('t.ts', code)
  return sf.getDescendantsOfKind(SyntaxKind.CallExpression)
}

function sinkOf(code: string) {
  for (const call of callsIn(code)) {
    const sink = detectSink(call, ctx)
    if (sink) return sink
  }
  return null
}

describe('detectSink', () => {
  it('apiService 的 method 與字串 URL 都要抽出來，並正確標記 mutating', () => {
    expect(sinkOf(`apiService.post('/api/v1/login', data)`)).toMatchObject({
      kind: 'HTTP_API',
      detail: 'POST /api/v1/login',
      mutating: true
    })
    expect(sinkOf(`apiService.get('/api/v1/list')`)).toMatchObject({ detail: 'GET /api/v1/list', mutating: false })
  })

  it('swagger 呼叫透過索引還原成 method + URL + 中文說明', () => {
    expect(sinkOf(`swaggerApiService.api.caseCreateCase({ a: 1 })`)).toMatchObject({
      kind: 'HTTP_API',
      detail: 'POST /api/v1/case/create',
      mutating: true,
      note: '建立個案'
    })
  })

  it('索引不到的 swagger 方法保守視為 mutating——寧可多收一條流程也不要漏', () => {
    expect(sinkOf(`swaggerApiService.api.somethingUnknown()`)).toMatchObject({ mutating: true })
  })

  it('router 導航抓得到 name 或 path', () => {
    expect(sinkOf(`router.push({ name: 'Login', query: q })`)).toMatchObject({ kind: 'ROUTER_NAV', detail: 'Login' })
    expect(sinkOf(`router.replace('/home')`)).toMatchObject({ kind: 'ROUTER_NAV', detail: '/home' })
    expect(sinkOf(`router.push(target)`)).toMatchObject({ detail: '(動態目標)' })
  })

  it('storage 讀寫要分開', () => {
    expect(sinkOf(`localStorage.setItem('token', t)`)).toMatchObject({ kind: 'STORAGE', mutating: true })
    expect(sinkOf(`localStorage.getItem('token')`)).toMatchObject({ kind: 'STORAGE', mutating: false })
  })

  it('emit 抓事件名，動態事件名明確標示', () => {
    expect(sinkOf(`emit('submit', payload)`)).toMatchObject({ kind: 'EMIT', detail: 'submit' })
    expect(sinkOf(`emit(eventName)`)).toMatchObject({ detail: '(動態事件名)' })
  })

  it('try 區塊內的呼叫標成 guarded——階段四要靠這個講異常與補償', () => {
    const guarded = sinkOf(`async function f() { try { await apiService.post('/x', d) } catch { } }`)
    expect(guarded?.guarded).toBe(true)
    const plain = sinkOf(`async function f() { await apiService.post('/x', d) }`)
    expect(plain?.guarded).toBe(false)
  })

  it('跨行的鏈式呼叫也要認得', () => {
    // prettier 會把 `swaggerApiService.api` 和方法名拆到不同行，這是此 repo 的
    // 主流寫法；不收掉空白的話所有跨行 API 呼叫都會從手冊裡消失
    const sink = sinkOf(`
await swaggerApiService.api
  .caseCreateCase({ a: 1 })
  .then(res => res)
`)
    expect(sink).toMatchObject({ kind: 'HTTP_API', detail: 'POST /api/v1/case/create' })
  })

  it('取得 Pinia store 是邊界，不往下追', () => {
    // useAuthStore() 只是取 handle。追進去會執行整個 defineStore setup，
    // 把 store 初始化連帶建立的東西全掛在呼叫者頭上——實測讓「權限守衛」
    // 憑空多出代理登出 API 與導頁
    expect(sinkOf(`const s = useAuthStore()`)).toMatchObject({ kind: 'STORE', detail: '取得 Auth store' })
    // 但 action 的呼叫不受影響，它會由 Type Checker 直接解析到 action 本身
    expect(sinkOf(`authStore.loginHandler(data)`)).toBeNull()
  })

  it('一般函式呼叫不是 sink', () => {
    expect(sinkOf(`doSomething(a, b)`)).toBeNull()
  })
})

describe('callsWithin', () => {
  function bodyOf(code: string, name: string) {
    const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('t.ts', code)
    const decl = sf.getVariableDeclaration(name) ?? sf.getFunction(name)!
    return toFunctionLike(decl)!
  }

  it('只被定義、沒被呼叫的巢狀函式不算執行到', () => {
    // Pinia store 的 setup 就是這個形狀：useAuthStore() 只是取得 store，
    // 不會執行 login()。無腦抓 descendants 會讓守衛的副作用憑空多出登入 API
    const fn = bodyOf(
      `const useStore = () => {
         function login() { apiService.post('/api/v1/login', d) }
         const logout = () => { apiService.post('/api/v1/logout') }
         init()
         return { login, logout }
       }`,
      'useStore'
    )
    expect(callsWithin(fn).map(c => c.getExpression().getText())).toEqual(['init'])
  })

  it('當場被呼叫的回呼要算進去', () => {
    const fn = bodyOf(
      `const run = async () => {
         await load().then(() => save())
       }`,
      'run'
    )
    const names = callsWithin(fn).map(c => c.getExpression().getText().replace(/\s+/g, ''))
    expect(names).toContain('save')
    expect(names).toContain('load')
  })

  it('new Promise 的 executor 算當場執行', () => {
    // 包裝非同步流程最常見的寫法。漏掉它會讓 Promise 內的 API 呼叫整個消失——
    // 實測讓登入流程的 POST /api/v1/login 從手冊裡不見
    const fn = bodyOf(
      `const handler = () => {
         return new Promise((resolve, reject) => {
           login(data).then(res => resolve(res)).catch(reject)
         })
       }`,
      'handler'
    )
    expect(callsWithin(fn).map(c => c.getExpression().getText().replace(/\s+/g, ''))).toContain('login')
  })

  it('IIFE 也算當場執行', () => {
    const fn = bodyOf(`const f = () => { (() => { boom() })() }`, 'f')
    expect(callsWithin(fn).map(c => c.getExpression().getText())).toContain('boom')
  })
})

describe('toFunctionLike', () => {
  function declOf(code: string, name: string) {
    const sf = new Project({ useInMemoryFileSystem: true }).createSourceFile('t.ts', code)
    return sf.getVariableDeclaration(name) ?? sf.getFunction(name)!
  }

  it('剝開 HOF 包裝，取到真正含業務邏輯的 callback', () => {
    // `const login = handleSubmit(async () => …)` 是此專案最常見的 handler 寫法，
    // 不剝這一層會讓所有表單提交流程都追不到
    const fn = toFunctionLike(declOf(`const login = handleSubmit(async () => { await save() })`, 'login'))
    expect(fn).toBeTruthy()
    expect(Node.isArrowFunction(fn!)).toBe(true)
  })

  it('一般箭頭函式與函式宣告都能取到', () => {
    expect(toFunctionLike(declOf(`const a = () => {}`, 'a'))).toBeTruthy()
    expect(toFunctionLike(declOf(`function b() {}`, 'b'))).toBeTruthy()
  })

  it('沒有函式可取時回 null，不亂猜', () => {
    expect(toFunctionLike(declOf(`const c = 1`, 'c'))).toBeNull()
    expect(toFunctionLike(declOf(`const d = useThing()`, 'd'))).toBeNull()
  })
})
