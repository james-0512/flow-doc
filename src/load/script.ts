import { ts } from 'ts-morph'

/** 進入頁面時自動觸發的鉤子——這些是「不需要使用者點擊」的流程起點。 */
const LIFECYCLE_HOOKS = new Set(['onMounted', 'onBeforeMount', 'onActivated', 'onCreated'])

/** 推播訂閱的比對規則。由 `config.push` 編譯而來，正則只編一次。 */
export interface PushMatcher {
  receiver: RegExp
  methods: Set<string>
  label: string
}

export function compilePushMatchers(push: { receiverPattern: string; methods: string[]; label: string }[]): PushMatcher[] {
  return push.map(p => ({
    receiver: new RegExp(p.receiverPattern, 'i'),
    methods: new Set(p.methods),
    label: p.label
  }))
}

/** 一個推播訂閱點：`machineConnection.value.on('UpdateList', handler)`。 */
export interface PushSubscription {
  /** 事件名。只收字串常數——變數事件名沒有可信的來源，猜了就是假流程 */
  event: string
  /** callback 的原始表達式，供階段二取函式與人閱讀 */
  handlerExpr: string
  line: number
  label: string
}

export interface ScriptFacts {
  /** 本地 import 的元件：識別字 → import specifier */
  componentImports: Map<string, string>
  /** 頂層宣告的函式／常數名，用來判斷 template 的 handler 是否指向本檔符號 */
  declaredNames: Set<string>
  lifecycle: { hook: string; line: number }[]
  push: PushSubscription[]
  /** 命中規則但事件名是變數而略過的數量。上限要看得見，不能靜默 */
  pushDynamicEvents: number
}

/**
 * 只做語法解析、不建 Program——這一步跑在全 repo 上千個檔案上，
 * 不能付 Type Checker 的成本。真正的符號解析留到階段二。
 *
 * 傳入的 code 必須是行號對齊過的虛擬 TS，回傳的 line 才等於原始 `.vue` 行號。
 */
export function extractScriptFacts(fileName: string, code: string, push: PushMatcher[] = []): ScriptFacts {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const componentImports = new Map<string, string>()
  const declaredNames = new Set<string>()
  const lifecycle: { hook: string; line: number }[] = []
  const pushSubs: PushSubscription[] = []
  let pushDynamicEvents = 0

  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text
      const name = stmt.importClause?.name?.text
      if (name) componentImports.set(name, spec)
      continue
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) declaredNames.add(stmt.name.text)
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) declaredNames.add(decl.name.text)
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (LIFECYCLE_HOOKS.has(name)) lifecycle.push({ hook: name, line: lineOf(node) })
    }
    if (push.length > 0 && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      collectPush(sf, node, node.expression, push, pushSubs, () => pushDynamicEvents++, lineOf)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)

  return { componentImports, declaredNames, lifecycle, push: pushSubs, pushDynamicEvents }
}

function collectPush(
  sf: ts.SourceFile,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  matchers: PushMatcher[],
  out: PushSubscription[],
  onDynamic: () => void,
  lineOf: (node: ts.Node) => number
): void {
  const method = access.name.text
  // 空白收掉：prettier 會把長的鏈式呼叫拆行，不收的話正則永遠比不到
  const receiver = access.expression.getText(sf).replace(/\s+/g, '')
  const matcher = matchers.find(m => m.methods.has(method) && m.receiver.test(receiver))
  if (!matcher) return

  const [event, handler] = call.arguments
  if (!event || !handler) return
  if (!ts.isStringLiteral(event) && !ts.isNoSubstitutionTemplateLiteral(event)) {
    onDynamic()
    return
  }
  out.push({
    event: event.text,
    handlerExpr: handler.getText(sf).replace(/\s+/g, ' '),
    line: lineOf(call),
    label: matcher.label
  })
}
