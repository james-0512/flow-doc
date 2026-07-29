import { describe, expect, it } from 'vitest'
import { Node, Project, SyntaxKind } from 'ts-morph'
import type { CallExpression } from 'ts-morph'
import { detectSink, toFunctionLike, type SinkContext } from './boundary.js'
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

  it('一般函式呼叫不是 sink', () => {
    expect(sinkOf(`doSomething(a, b)`)).toBeNull()
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
